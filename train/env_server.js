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
 * エピソードの切り方
 * ============================================================
 * 1エピソード = 1ハンド、1席ぶん。報酬は
 *     (獲得ポット − そのハンドで自分が出した額) / ビッグブラインド
 * つまり **bb/hand** そのもの。指標とそのまま一致する。
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

  reset() {
    this.game = new Game(this.opts.config);
    const names = [];
    for (let i = 0; i < this.opts.players; i++) names.push(`S${i}`);
    this.game.startGame(this.opts.players, names);
    this.beginHand();
  }

  beginHand() {
    this.handSeq++;
    this.calcDecided = new Set();
    this.handStats = { submitted: 0, correct: 0, folds: 0, slogSum: 0, slogN: 0 };
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
          results.push(...this.collectRewards());
          this.game.settle();
          this.rebuy();
          this.beginHand();
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
   * バーストした席をバイインし直す。
   *
   * ここで Game を作り直してはいけない。勝者なしポットの持ち越し（carryOver）が
   * 消えてしまい、収支がゼロサムでなくなって bb/hand が恒常的にマイナスに偏る。
   * 卓は同じまま、チップだけ戻す。
   */
  rebuy() {
    const g = this.game;
    const buyIn = g.config.initialChips;
    let restored = false;
    for (const p of g.players) {
      if (p.isEliminated || p.chips <= 0) {
        p.chips = buyIn;
        p.isEliminated = false;
        p.isActive = true;
        p.isAllIn = false;
        restored = true;
      }
    }
    // settle() が「生存1人」で打ち切っていた場合は、ここから次ハンドを開始する
    if (g.gameOver) {
      g.gameOver = false;
      if (restored || g.livePlayers().length > 1) g._nextHand();
    }
  }

  /**
   * ショーダウン時点で、そのハンドの各席の収支を確定する。
   * settle() の副作用（次ハンドのアンティ徴収など）に依存しないよう、
   * ポットと totalBet から直接計算する。
   */
  collectRewards() {
    const g = this.game;
    const bb = Math.max(1, g.config.bigBlind);
    const winners = new Set(g.winners.map(w => w.player.id));
    const share = g.winners.length > 0 ? Math.floor(g.pot / g.winners.length) : 0;

    // 勝者なしは払い戻し（全員スコア0の同点）。収支は動かない。
    const noWinner = g.winners.length === 0;

    const out = [];
    for (let i = 0; i < g.players.length; i++) {
      const p = g.players[i];
      if (p.isEliminated) continue;
      const payout = noWinner ? p.totalBet : (winners.has(p.id) ? share : 0);
      out.push({
        tid: this.tid(i),
        seat: i,
        reward: (payout - p.totalBet) / bb,
        won: winners.has(p.id) ? 1 : 0,
      });
    }
    // 「決着したか」= 誰か1人でも勝者になったか。
    // 全員失格の流局が多いと学習データとして役に立たないので、必ず監視する。
    this.handStats.decided = noWinner ? 0 : 1;
    this.lastHandStats = this.handStats;
    return out;
  }
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
      slogSum: 0, slogN: 0, rewardSum: 0, rewardN: 0, timeouts: 0,
      seatReward: {}, seatN: {}, seatWins: {},
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
      this.stats.rewardN++;
      // 席ごとの成績。評価（学習中の方策 vs 過去最強 / ランダム）で使う。
      this.stats.seatReward[r.seat] = (this.stats.seatReward[r.seat] || 0) + r.reward;
      this.stats.seatN[r.seat] = (this.stats.seatN[r.seat] || 0) + 1;
      this.stats.seatWins[r.seat] = (this.stats.seatWins[r.seat] || 0) + r.won;
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
      seats[k] = {
        bb_per_hand: s.seatReward[k] / s.seatN[k],
        win_rate: (s.seatWins[k] || 0) / s.seatN[k],
        hands: s.seatN[k],
      };
    }
    const out = {
      hands: s.hands,
      finish_rate: s.hands ? s.decided / s.hands : 0,
      bb_per_hand: s.rewardN ? s.rewardSum / s.rewardN : 0,
      declare_accuracy: s.submissions ? s.correct / s.submissions : 0,
      submit_rate: s.slogN ? s.submissions / s.slogN : 0,
      fold_rate: s.hands ? s.folds / (s.hands * this.opts.players) : 0,
      avg_slog: s.slogN ? s.slogSum / s.slogN : 0,
      seats,
    };
    this.resetStats();
    return out;
  }
}

// ============================================================
// メインループ
// ============================================================

const DEFAULT_CONFIG = {
  initialChips: 1000, smallBlind: 10, bigBlind: 20, ante: 5,
  betTimeLimit: 10, dealerTimeLimit: 20, levelUpHands: 0,
  deckCount: 1, autoCalcMode: false, minCalcTime: 30, maxCalcTime: 600,
};

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
