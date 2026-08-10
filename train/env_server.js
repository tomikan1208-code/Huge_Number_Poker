/**
 * env_server.js — 学習用の並列環境サーバー（Node側）
 *
 * ============================================================
 * なぜ Node が環境を持つのか
 * ============================================================
 * 巨大数エンジン（engine.js）とゲーム進行（game.js）は既にあり、
 * タワー表現・比較・申告判定など微妙な仕様がここに凝縮されている。
 * これを Python に書き直すと、**学習環境と実際のゲームがズレる**という
 * 一番タチの悪いバグを抱え込む。だから環境はNodeのまま使い、
 * PythonにはPPOだけをやらせる。ルールの正は engine.js ただ1つ。
 *
 * ============================================================
 * 通信
 * ============================================================
 * stdin / stdout の NDJSON（1行1メッセージ）。
 *   Python → Node
 *     {"cmd":"init", "envs":64, "players":3, "level":"skilled", "seed":1, "config":{...}}
 *     {"cmd":"act",  "actions":[3,1,0,...]}       直前の requests と同じ順で対応
 *     {"cmd":"stats"}                              集計を取り出してリセット
 *     {"cmd":"close"}
 *   Node → Python
 *     {"requests":[{tid,env,seat,head,obs,mask}], "results":[{tid,reward}], "hands":12}
 *
 * 1回の act で、各環境がちょうど1つの意思決定を進める。
 * これで「観測のバッチ = 環境数」になり、Python側の実装が単純になる。
 *
 * ============================================================
 * エピソードの切り方と報酬
 * ============================================================
 * 卓は **トーナメント**として回す。チップ0で脱落、生存1人で決着、
 * ブラインドは5ハンドごとに倍。本編（js/game.js）とまったく同じ進行。
 *
 * 1エピソード = 1ハンド、1席ぶん。報酬は
 *     ICM(ハンド後) − ICM(ハンド前)
 * ICM は「そのチップ量が持つ順位の期待値」（下の icmEquity を参照）。
 *
 * bb/hand（チップの収支）は報酬ではなく **見るための指標** として別に集計する。
 */

const path = require('path');
const readline = require('readline');

const JS = path.join(__dirname, '..', 'js');
const { Game } = require(path.join(JS, 'game.js'));
const AI = require(path.join(JS, 'ai.js'));
const COG = require(path.join(JS, 'ai-cognition.js'));
const POL = require(path.join(JS, 'ai-policy.js'));

// ============================================================
// 1つの環境（= 1卓）
// ============================================================

class HandEnv {
  constructor(id, opts) {
    this.id = id;
    this.opts = opts;
    this.rng = AI.makeRng(opts.seed + id * 7919);
    this.profile = COG.getProfile(opts.level);
    this.handSeq = 0;
    this.reset();
  }

  /** 新しいトーナメントを始める */
  reset() {
    // config はハンドごとにブラインドが書き換わるので、必ず複製して渡す
    this.game = new Game({ ...this.opts.config });
    const names = [];
    for (let i = 0; i < this.opts.players; i++) names.push(`S${i}`);
    this.game.startGame(this.opts.players, names);

    this.payouts = placePayouts(this.opts.players);
    this.finished = [];          // 脱落した席（先に飛んだ順）
    this.tourneyHands = 0;
    this.tourneyResult = null;   // 直前に終わったトーナメントの結果
    this.beginHand();
  }

  beginHand() {
    this.handSeq++;
    this.calcDecided = new Set();
    this.handStats = { submitted: 0, correct: 0, folds: 0, slogSum: 0, slogN: 0 };
    this.equityBefore = this.equities();
  }

  /**
   * 各席の現在の ICM 期待値。
   *
   * 分母は「場にある全チップ」。持ち越し（carryOver）やポットの途中にある分を
   * 含めないと総量が変動して、価値の足し引きが合わなくなる。
   */
  equities() {
    const g = this.game;
    const n = g.players.length;
    const out = new Array(n).fill(0);

    // 既に飛んだ席は順位が確定しているので、その取り分で固定
    for (let k = 0; k < this.finished.length; k++) {
      const place = n - 1 - k;                // 先に飛んだ席ほど下位
      out[this.finished[k]] = this.payouts[place];
    }

    const liveSeats = [];
    for (let i = 0; i < n; i++) {
      if (!g.players[i].isEliminated) liveSeats.push(i);
    }
    if (liveSeats.length === 0) return out;

    const stacks = liveSeats.map((i) => Math.max(0, g.players[i].chips));
    const eq = icmEquity(stacks, this.payouts.slice(0, liveSeats.length));
    liveSeats.forEach((seat, k) => { out[seat] = eq[k]; });
    return out;
  }

  /**
   * トーナメントが終わったかを見て、終わっていれば順位を確定する。
   * @returns {boolean} 終わったなら true
   */
  finishTournamentIfOver() {
    const g = this.game;
    const n = g.players.length;
    const live = g.players.filter((p) => !p.isEliminated);

    // ブラインドは上がり続けるので普通は必ず終わるが、
    // 万一終わらないときのために上限を置く（そこまでのスタック順で決着）
    const tooLong = this.tourneyHands >= MAX_TOURNAMENT_HANDS;
    if (live.length > 1 && !tooLong) return false;

    // 残っている席をスタックの多い順に上位へ
    const remaining = [];
    for (let i = 0; i < n; i++) {
      if (!g.players[i].isEliminated) remaining.push(i);
    }
    remaining.sort((a, b) => g.players[a].chips - g.players[b].chips);
    const order = this.finished.concat(remaining);   // 下位から順に並ぶ

    const places = new Array(n).fill(n - 1);
    order.forEach((seat, k) => { places[seat] = n - 1 - k; });

    this.tourneyResult = {
      places,                              // 席 → 順位（0 が優勝）
      hands: this.tourneyHands,
      truncated: tooLong,
    };
    return true;
  }

  tid(seat) { return `${this.id}:${this.handSeq}:${seat}`; }

  /**
   * 意思決定が必要になるまでゲームを進める。
   * @returns {{request:object|null, results:Array}}
   */
  advance() {
    const results = [];
    let guard = 0;

    for (;;) {
      if (++guard > 500) { this.reset(); return { request: null, results }; }
      const g = this.game;

      if (g.gameOver) { this.reset(); continue; }

      switch (g.phase) {
        case 'DEALING':
          g.startBettingRound(1);
          continue;

        case 'BETTING_1':
        case 'BETTING_2': {
          const seat = g.currentPlayerIdx;
          const p = g.players[seat];
          if (!p || !p.isActive || p.isAllIn || p.isEliminated) {
            // 誰も行動できない状態。game 側の遷移に任せる
            g._advanceBetting();
            if (g.phase === 'BETTING_1' || g.phase === 'BETTING_2') {
              // それでも進まないなら壊れている。作り直す。
              this.reset();
            }
            continue;
          }
          return { request: this.makeRequest('bet', seat), results };
        }

        case 'EXCHANGE': {
          const seat = g.players.findIndex(p => !p.isEliminated && p.isActive && !p.isReady);
          if (seat < 0) { g.startBettingRound(2); continue; }
          return { request: this.makeRequest('exchange', seat), results };
        }

        case 'CALCULATION': {
          const seat = g.players.findIndex(
            (p, i) => !p.isEliminated && p.isActive && !p.hasSubmitted && !this.calcDecided.has(i));
          if (seat < 0) {
            // 全員が決め終わった（提出できなかった者は失格になる）
            g.finishCalculation();
            continue;
          }
          return { request: this.makeRequest('formula', seat), results };
        }

        case 'SHOWDOWN': {
          const chipDeltas = this.chipDeltas();
          this.game.settle();               // ここで脱落判定まで進む
          this.noteEliminations();
          this.tourneyHands++;

          // ハンド前後の ICM の差が、そのハンドの報酬になる
          const after = this.equities();
          results.push(...this.buildResults(chipDeltas, after));

          if (this.finishTournamentIfOver()) {
            this.lastTournament = this.tourneyResult;
            this.reset();                   // 次のトーナメントへ
          } else {
            this.beginHand();
          }
          continue;
        }

        default:
          // SETTING / SETTLEMENT など想定外
          this.reset();
          continue;
      }
    }
  }

  makeRequest(head, seat) {
    const view = POL.buildObservation(this.game, seat, this.profile);
    this.pending = { head, seat, view };
    return {
      tid: this.tid(seat),
      env: this.id,
      seat,
      head,
      obs: sanitize(view.obs),
      mask: view.masks[head],
    };
  }

  /** Python から返ってきた行動IDを適用する */
  apply(actionId) {
    const pend = this.pending;
    if (!pend) return;
    this.pending = null;
    const g = this.game;
    const { head, seat } = pend;

    if (head === 'bet') {
      const a = POL.resolveBetAction(g, seat, actionId);
      let res = g.playerAction(seat, a.action, a.amount);
      if (!res.ok) {
        // マスクを抜けた不正な額は、通る行動に落とす（学習を止めないため）
        const toCall = g.currentBet - g.players[seat].currentBet;
        res = g.playerAction(seat, toCall > 0 ? 'call' : 'check');
        if (!res.ok) g.playerAction(seat, 'fold');
      }
      if (a.action === 'fold') this.handStats.folds++;
      return;
    }

    if (head === 'exchange') {
      const ids = POL.resolveExchangeAction(g, seat, actionId, this.profile);
      g.selectExchangeCards(seat, ids);
      g.readyExchange(seat);
      return;
    }

    if (head === 'formula') {
      this.calcDecided.add(seat);
      const cands = pend.view.candidates;
      const cand = cands[actionId] || cands[0];
      if (!cand) return;

      const time = g.calculationTimeLimit || AI.calcTimeForPot(g.pot, g.config);
      const opponents = Math.max(1, g.activePlayers().length - 1);
      // ここで「正答するか / どれだけ外すか」のサイコロを振る = 環境側の物理
      const sub = AI.produceSubmission(cand, time, this.profile, opponents, this.rng);

      // slog はテトレーション域で数万〜数十万まで飛ぶのでグラフ用に頭を打つ
      this.handStats.slogSum += Math.min(cand.slog, 8);
      this.handStats.slogN++;

      if (sub.timedOut || sub.declared == null) return;   // 時間内に出せず失格
      const r = g.submitFormula(seat, sub.formula, sub.declared);
      if (r.ok) {
        this.handStats.submitted++;
        if (r.submission.isCorrect) this.handStats.correct++;
      }
    }
  }

  /**
   * ショーダウン時点で、そのハンドの各席のチップ収支（bb単位）を出す。
   * settle() の副作用（次ハンドのアンティ徴収など）に依存しないよう、
   * ポットと totalBet から直接計算する。**settle() の前に呼ぶこと。**
   *
   * これは報酬ではなく、見るための指標（bb/hand）。
   * 学習が最大化するのは ICM のほう。
   */
  chipDeltas() {
    const g = this.game;
    const bb = Math.max(1, g.config.bigBlind);
    const winners = new Set(g.winners.map(w => w.player.id));
    const share = g.winners.length > 0 ? Math.floor(g.pot / g.winners.length) : 0;

    // 勝者なしは払い戻し（全員スコア0の同点）。収支は動かない。
    const noWinner = g.winners.length === 0;

    const out = [];
    for (let i = 0; i < g.players.length; i++) {
      const p = g.players[i];
      if (p.isEliminated) { out.push(null); continue; }
      const payout = noWinner ? p.totalBet : (winners.has(p.id) ? share : 0);
      out.push({
        bb: (payout - p.totalBet) / bb,
        won: winners.has(p.id) ? 1 : 0,
      });
    }

    // 「決着したか」= 誰か1人でも勝者になったか。
    // 全員失格の流局が多いと学習データとして役に立たないので、必ず監視する。
    this.handStats.decided = noWinner ? 0 : 1;
    this.lastHandStats = this.handStats;
    return out;
  }

  /** settle() で新たに飛んだ席を、飛んだ順に記録する */
  noteEliminations() {
    const g = this.game;
    for (let i = 0; i < g.players.length; i++) {
      if (g.players[i].isEliminated && this.finished.indexOf(i) < 0) {
        this.finished.push(i);
      }
    }
  }

  /** そのハンドの学習用サンプルを組み立てる */
  buildResults(chipDeltas, equityAfter) {
    const before = this.equityBefore || [];
    const out = [];
    for (let i = 0; i < chipDeltas.length; i++) {
      const d = chipDeltas[i];
      if (!d) continue;                     // そのハンドの開始時点で既に脱落
      out.push({
        tid: this.tid(i),
        seat: i,
        // 学習が最大化するのはこれ（ICM の増減）
        reward: (equityAfter[i] || 0) - (before[i] || 0),
        // 以下は見るための指標
        bb: d.bb,
        won: d.won,
      });
    }
    return out;
  }
}

// ============================================================
// トーナメントの価値関数（ICM）
// ============================================================
//
// 本編は「チップ0で脱落・生存1人で終了」のトーナメント。
// なのに報酬を bb/hand（そのハンドの収支）にすると、
// **飛ぶことのコストがゼロ**になってしまう。わずかにプラス期待値なら
// 常にオールインが正解、という打ち方に収束する。
//
// かといって「優勝したら +1、それ以外 0」だけにすると報酬がまばらすぎて
// 学習が進まない（1トーナメント数十ハンド × 全意思決定に1つの数字しか入らない）。
//
// そこでポーカーの標準的な考え方 ICM を使う。
// チップそのものではなく **そのチップ量が持つ「順位の期待値」** を価値とし、
//
//     そのハンドの報酬 = ICM(ハンド後) − ICM(ハンド前)
//
// とする。これを1トーナメントぶん足すと
//
//     ICM(最終) − ICM(開始) = 実際に取った順位の価値 − 開始時の期待値
//
// に畳まれる。つまり **毎ハンド密に報酬が入りながら、合計は本物の順位報酬と一致する**。
// これは potential-based reward shaping（Ng, Harada & Russell 1999）そのもので、
// 最適な打ち方を変えないことが保証されている形。
//
// 賞金配分を「1位総取り」にすると ICM はチップ比率そのもの（＝線形）になり、
// 結局チップEVと同じになってしまう。順位に応じて配分を分けることで
// 価値がスタックに対して **凹** になり、
//   ・短いスタックは価値が急に落ちる → 飛ぶのを避けるようになる
//   ・大きいスタックは限界価値が下がる → 無駄なリスクを取らなくなる
// というトーナメント特有の判断が出てくる。

/** 順位ごとの取り分。1位 +1 〜 最下位 −1 を等間隔に割る（合計0）*/
function placePayouts(n) {
  if (n <= 1) return [0];
  const out = new Array(n);
  for (let k = 0; k < n; k++) out[k] = 1 - (2 * k) / (n - 1);
  return out;
}

/**
 * ICM（Independent Chip Model）。
 *
 * 「次に1位で抜けるのはチップ量に比例する」という仮定のもとで順位分布を出し、
 * 賞金の期待値を返す。席数は最大6なので順列を全部たどってよい（最大720通り）。
 *
 * @param {number[]} stacks  生存者のチップ
 * @param {number[]} payouts 生存者が争う順位の取り分（stacks と同じ長さ）
 * @returns {number[]} 各席の期待値
 */
function icmEquity(stacks, payouts) {
  const n = stacks.length;
  const eq = new Array(n).fill(0);
  if (n === 0) return eq;
  if (n === 1) { eq[0] = payouts[0]; return eq; }

  const total = stacks.reduce((a, b) => a + b, 0);
  if (total <= 0) return eq;

  const used = new Array(n).fill(false);

  const walk = (place, remain, prob) => {
    if (prob < 1e-12) return;
    // 残り1人は自動的に最下位が確定する
    if (place === n - 1) {
      const last = used.indexOf(false);
      if (last >= 0) eq[last] += prob * payouts[place];
      return;
    }
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      const p = remain > 0 ? stacks[i] / remain : 0;
      if (p <= 0) continue;
      eq[i] += prob * p * payouts[place];
      used[i] = true;
      walk(place + 1, remain - stacks[i], prob * p);
      used[i] = false;
    }
  };
  walk(0, total, 1);
  return eq;
}

/** JSON化できない値（NaN/Infinity）を潰す。ここを怠ると学習側が静かに壊れる。 */
function sanitize(arr) {
  const out = new Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    out[i] = (typeof v === 'number' && isFinite(v)) ? v : 0;
  }
  return out;
}

// ============================================================
// 環境の束
// ============================================================

class EnvPool {
  constructor(opts) {
    this.opts = opts;
    this.envs = [];
    for (let i = 0; i < opts.envs; i++) this.envs.push(new HandEnv(i, opts));
    this.resetStats();
  }

  resetStats() {
    this.stats = {
      hands: 0, decided: 0, submissions: 0, correct: 0, folds: 0,
      slogSum: 0, slogN: 0, rewardSum: 0, rewardN: 0, bbSum: 0, timeouts: 0,
      seatReward: {}, seatBb: {}, seatN: {}, seatWins: {},
      // トーナメント（勝ち残り）の成績
      tournaments: 0, tourneyHandSum: 0, truncated: 0,
      seatChamp: {}, seatPlaceSum: {}, seatTourneys: {},
    };
  }

  /** 全環境を「次の意思決定待ち」まで進める */
  poll() {
    const requests = [];
    const results = [];
    for (const env of this.envs) {
      const r = env.advance();
      if (r.results.length) {
        results.push(...r.results);
        this.absorb(env, r.results);
      }
      if (r.request) requests.push(r.request);
    }
    this.lastRequests = requests;
    return { requests, results };
  }

  absorb(env, results) {
    const s = env.lastHandStats;
    this.stats.hands++;
    if (s) {
      this.stats.decided += s.decided || 0;
      this.stats.submissions += s.submitted;
      this.stats.correct += s.correct;
      this.stats.folds += s.folds;
      this.stats.slogSum += s.slogSum;
      this.stats.slogN += s.slogN;
      this.stats.timeouts += Math.max(0, s.slogN - s.submitted);
    }
    for (const r of results) {
      this.stats.rewardSum += r.reward;
      this.stats.bbSum += r.bb || 0;
      this.stats.rewardN++;
      // 席ごとの成績。評価（学習中の方策 vs 過去最強 / ランダム）で使う。
      this.stats.seatReward[r.seat] = (this.stats.seatReward[r.seat] || 0) + r.reward;
      this.stats.seatBb[r.seat] = (this.stats.seatBb[r.seat] || 0) + (r.bb || 0);
      this.stats.seatN[r.seat] = (this.stats.seatN[r.seat] || 0) + 1;
      this.stats.seatWins[r.seat] = (this.stats.seatWins[r.seat] || 0) + r.won;
    }

    // トーナメントが1つ終わっていれば順位を取り込む
    const t = env.lastTournament;
    if (t) {
      env.lastTournament = null;
      this.stats.tournaments++;
      this.stats.tourneyHandSum += t.hands;
      if (t.truncated) this.stats.truncated++;
      t.places.forEach((place, seat) => {
        this.stats.seatTourneys[seat] = (this.stats.seatTourneys[seat] || 0) + 1;
        this.stats.seatPlaceSum[seat] = (this.stats.seatPlaceSum[seat] || 0) + place;
        if (place === 0) this.stats.seatChamp[seat] = (this.stats.seatChamp[seat] || 0) + 1;
      });
    }
  }

  /** requests と同じ順で行動を適用する */
  act(actions) {
    const reqs = this.lastRequests || [];
    for (let i = 0; i < reqs.length; i++) {
      const env = this.envs[reqs[i].env];
      env.apply(actions[i]);
    }
    return this.poll();
  }

  takeStats() {
    const s = this.stats;
    const seats = {};
    for (const k of Object.keys(s.seatN)) {
      const nt = s.seatTourneys[k] || 0;
      seats[k] = {
        // チップの稼ぎ（見るための指標）
        bb_per_hand: s.seatBb[k] / s.seatN[k],
        win_rate: (s.seatWins[k] || 0) / s.seatN[k],
        hands: s.seatN[k],
        // 勝ち残り（学習が本当に狙っているもの）
        icm_per_hand: s.seatReward[k] / s.seatN[k],
        champion_rate: nt ? (s.seatChamp[k] || 0) / nt : 0,
        avg_place: nt ? (s.seatPlaceSum[k] || 0) / nt + 1 : 0,   // 1位を1とする
        tournaments: nt,
      };
    }
    const out = {
      hands: s.hands,
      finish_rate: s.hands ? s.decided / s.hands : 0,
      bb_per_hand: s.rewardN ? s.bbSum / s.rewardN : 0,
      icm_per_hand: s.rewardN ? s.rewardSum / s.rewardN : 0,
      declare_accuracy: s.submissions ? s.correct / s.submissions : 0,
      submit_rate: s.slogN ? s.submissions / s.slogN : 0,
      fold_rate: s.hands ? s.folds / (s.hands * this.opts.players) : 0,
      avg_slog: s.slogN ? s.slogSum / s.slogN : 0,
      // トーナメント
      tournaments: s.tournaments,
      hands_per_tournament: s.tournaments ? s.tourneyHandSum / s.tournaments : 0,
      truncated_rate: s.tournaments ? s.truncated / s.tournaments : 0,
      seats,
    };
    this.resetStats();
    return out;
  }
}

// ============================================================
// メインループ
// ============================================================

// 本編（js/game.js の DEFAULT_CONFIG）と揃える。
// とくに levelUpHands は 0 にしてはいけない。ブラインドが上がらないと
// スタックが削られず、トーナメントがいつまでも終わらない。
const DEFAULT_CONFIG = {
  initialChips: 1000, smallBlind: 10, bigBlind: 20, ante: 5,
  betTimeLimit: 10, dealerTimeLimit: 20, levelUpHands: 5,
  deckCount: 1, autoCalcMode: false, minCalcTime: 30, maxCalcTime: 600,
};

/** 1トーナメントの上限ハンド数。これを超えたらスタック順で打ち切る */
const MAX_TOURNAMENT_HANDS = 300;

let pool = null;

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function handle(msg) {
  switch (msg.cmd) {
    case 'init': {
      pool = new EnvPool({
        envs: msg.envs || 32,
        players: Math.max(2, Math.min(6, msg.players || 3)),
        level: msg.level || 'skilled',
        seed: msg.seed || 1,
        config: { ...DEFAULT_CONFIG, ...(msg.config || {}) },
      });
      const first = pool.poll();
      send({
        ok: true,
        obs_dim: POL.OBS_DIM,
        action_sizes: POL.ACTION_SIZES,
        requests: first.requests,
        results: first.results,
      });
      return;
    }

    case 'act': {
      if (!pool) { send({ error: 'not initialized' }); return; }
      const r = pool.act(msg.actions || []);
      send({ requests: r.requests, results: r.results });
      return;
    }

    case 'stats':
      send({ stats: pool ? pool.takeStats() : {} });
      return;

    case 'close':
      send({ ok: true });
      process.exit(0);
      return;

    default:
      send({ error: `unknown cmd: ${msg.cmd}` });
  }
}

// ---- 自己診断モード: node env_server.js --selfplay 200 ----
if (process.argv.includes('--selfplay')) {
  const n = parseInt(process.argv[process.argv.indexOf('--selfplay') + 1], 10) || 200;
  const level = process.argv.includes('--level')
    ? process.argv[process.argv.indexOf('--level') + 1] : 'skilled';

  pool = new EnvPool({
    envs: 8, players: 3, level, seed: 42, config: DEFAULT_CONFIG,
  });
  const t0 = Date.now();
  let r = pool.poll();
  let decisions = 0;
  while (pool.stats.hands < n) {
    // ランダム方策で回して、環境が壊れないことと速度を確かめる
    const actions = r.requests.map(req => {
      const legal = [];
      req.mask.forEach((m, i) => { if (m) legal.push(i); });
      return legal[Math.floor(Math.random() * legal.length)];
    });
    decisions += actions.length;
    r = pool.act(actions);
  }
  const dt = (Date.now() - t0) / 1000;
  const st = pool.takeStats();
  console.log(JSON.stringify({
    level,
    hands: st.hands,
    decisions,
    seconds: Number(dt.toFixed(2)),
    hands_per_sec: Number((st.hands / dt).toFixed(1)),
    sec_per_hand: Number((dt / st.hands).toFixed(4)),
    ...st,
  }, null, 2));
  process.exit(0);
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  try {
    handle(JSON.parse(line));
  } catch (e) {
    send({ error: e.message, stack: e.stack });
  }
});
rl.on('close', () => process.exit(0));
