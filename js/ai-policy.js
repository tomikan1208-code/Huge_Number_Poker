/**
 * ai-policy.js — 学習済み方策のランタイム＋観測（特徴量）の定義
 *
 * ここが **学習と実プレイの唯一の接点** になる。
 *   - 学習側 (train/env_server.js) はこのファイルの buildObservation で観測を作る
 *   - ブラウザ側 (js/ui.js → AIPlayer) も同じ関数で観測を作る
 * 片方だけ書き換えると「学習時と本番で入力が違う」という
 * 一番気づきにくい壊れ方をするので、必ずここ1箇所にまとめる。
 *
 * 行動空間は3つのヘッドに分かれている。
 *   bet      … フォールド / チェック・コール / レイズ3段階 / オールイン
 *   formula  … 候補（値と難易度のパレート境界）の何番目を出すか
 *   exchange … 何枚まで切るか（限界効用の低い順）
 * どのヘッドも「合法手マスク」を一緒に返す。マスクは学習側で logits に
 * -inf を足すために使う。
 */

/* global AI, AICognition */
const _polAI = (typeof require !== 'undefined' && typeof module !== 'undefined')
  ? require('./ai.js') : (typeof AI !== 'undefined' ? AI : null);
const _polCog = (typeof require !== 'undefined' && typeof module !== 'undefined')
  ? require('./ai-cognition.js') : (typeof AICognition !== 'undefined' ? AICognition : null);

// ============================================================
// 行動空間
// ============================================================

/** ベットの行動。amount の作り方は resolveBetAction を参照 */
const BET_ACTION_IDS = ['fold', 'checkcall', 'raise_half', 'raise_pot', 'raise_2pot', 'allin'];

/** 候補（式）の選択肢数。candidateSet の先頭からこの数だけ見る */
const FORMULA_SLOTS = 6;

/** 交換の選択肢: 限界効用の低い順に 0〜5 枚捨てる */
const EXCHANGE_SLOTS = 6;

const ACTION_SIZES = {
  bet: BET_ACTION_IDS.length,
  formula: FORMULA_SLOTS,
  exchange: EXCHANGE_SLOTS,
};

// ============================================================
// 観測ベクトル
// ============================================================

/** 状況を表す特徴量の個数 */
const CONTEXT_FEATURES = 16;
/**
 * 相手についての特徴量の個数。
 *
 * ============================================================
 * なぜ足したか
 * ============================================================
 * ここが無いあいだ、AIは **相手を一切見ていなかった**。
 * 観測に入っていたのは `toCall/pot` や `currentBet/bb` という合算値だけで、
 * 「誰がオールインしたか」「何人がレイズを返したか」は入力されていない。
 * そのため PPO を何世代回しても **相手の読みは学習しようがなかった**。
 *
 * 席ごとの値をそのまま並べると人数（2〜6）で長さが変わるので、
 * **割合に畳んで固定長**にしてある。誰がやったかは落ちるが、
 * 「何人が / どれくらいの大きさで」は残る。
 *
 * スタック関係も入れる。トーナメントでは
 * 「自分より短い相手が居るか」で降り引き際が変わる（ICMの効き方が変わる）ため。
 */
const OPPONENT_FEATURES = 12;
/** 候補1本あたりの特徴量の個数 */
const CAND_FEATURES = 9;
/** 観測ベクトルの長さ */
const OBS_DIM = CONTEXT_FEATURES + OPPONENT_FEATURES + FORMULA_SLOTS * CAND_FEATURES + 3;

function clip(x, lo, hi) {
  if (!isFinite(x)) return hi;
  return x < lo ? lo : x > hi ? hi : x;
}

/** 大きな値を 0..1 に潰す（対数スケール） */
function logScale(x, scale) {
  return clip(Math.log10(1 + Math.max(0, x)) / scale, 0, 1);
}

/**
 * 観測ベクトルと合法手マスクを作る。
 *
 * @param {Game} game
 * @param {number} idx 手番のプレイヤー
 * @param {object} profile AIプロファイル（認知能力によって候補の見え方が変わる）
 * @returns {{obs:number[], masks:{bet:number[],formula:number[],exchange:number[]},
 *            candidates:Array, calcTime:number}}
 */
function buildObservation(game, idx, profile) {
  const me = game.players[idx];
  const bb = Math.max(1, game.config.bigBlind);
  const opponents = Math.max(1, game.activePlayers().length - 1);
  const toCall = Math.max(0, game.currentBet - me.currentBet);

  const candidates = _polAI.candidateSet(me.hand, profile);
  const calcTimeNow = _polAI.expectedCalcTime(game, Math.min(toCall, me.chips));
  // ポットを大きくしたら計算時間がどれだけ伸びるか（設計指示7の学習材料）
  const calcTimeBig = _polAI.expectedCalcTime(game, Math.min(toCall + game.pot * 2, me.chips));

  const liveChips = game.livePlayers().map(p => p.chips);
  const avgChips = liveChips.reduce((a, b) => a + b, 0) / Math.max(1, liveChips.length);

  const phase = game.phase;
  const obs = [
    phase === 'BETTING_1' ? 1 : 0,
    phase === 'BETTING_2' ? 1 : 0,
    phase === 'EXCHANGE' ? 1 : 0,
    phase === 'CALCULATION' ? 1 : 0,
    logScale(game.pot / bb, 3),
    clip(toCall / (game.pot + 1), 0, 2) / 2,
    clip(toCall / (me.chips + 1), 0, 1),
    logScale(me.chips / bb, 3),
    clip(me.chips / (avgChips + 1), 0, 3) / 3,
    opponents / 5,
    me.isDealer ? 1 : 0,
    clip(game.currentBet / bb, 0, 20) / 20,
    clip(game.minRaise / bb, 0, 10) / 10,
    clip(calcTimeNow / 600, 0, 1),
    clip(calcTimeBig / 600, 0, 1),
    clip(game.level / 10, 0, 1),
  ];

  // ---- 相手の行動とスタック ----
  const others = game.players.filter((p, i) => i !== idx && !p.isEliminated);
  const inHand = others.filter(p => p.isActive);
  const n = Math.max(1, others.length);

  const count = (fn) => others.filter(fn).length / n;
  const last = game.lastAggressorIdx >= 0 ? game.players[game.lastAggressorIdx] : null;
  const lastIsMe = game.lastAggressorIdx === idx;

  const oppChips = inHand.map(p => p.chips);
  const maxOpp = oppChips.length ? Math.max(...oppChips) : 0;
  const minOpp = oppChips.length ? Math.min(...oppChips) : 0;
  const totalChips = game.livePlayers().reduce((a, p) => a + p.chips, 0) + game.pot;

  // HNP_ABLATE_OPPONENT=1 で相手特徴を全部 0 にする（対照実験用）。
  // 「足した特徴が本当に効いたのか」は、潰した対照と比べないと言えない。
  // 次元は変えないので、潰した方策と潰していない方策を同じ卓で戦わせられる。
  // ブラウザには process が無いので、実プレイでは決して有効にならない。
  const ABLATE = (typeof process !== 'undefined' && process.env
    && process.env.HNP_ABLATE_OPPONENT === '1');
  const z = (v) => (ABLATE ? 0 : v);
  obs.push(
    z(count(p => p.lastAction === 'raise')),
    z(count(p => p.lastAction === 'allin' || p.isAllIn)),
    z(count(p => p.lastAction === 'fold' || !p.isActive)),
    z((last && !lastIsMe && last.lastAction === 'raise') ? 1 : 0),
    z((last && !lastIsMe && last.lastAction === 'allin') ? 1 : 0),
    // 直前の仕掛けの大きさ。ポット比なのでブラインドの上がり方に依存しない
    z(last && !lastIsMe ? clip(last.lastActionRatio, 0, 3) / 3 : 0),
    z(clip(maxOpp / (me.chips + 1), 0, 3) / 3),
    z(clip(minOpp / (me.chips + 1), 0, 3) / 3),
    // 自分より短い相手の割合。トーナメントでは「先に飛ぶ人が居る」ことに価値がある
    z(count(p => p.chips < me.chips)),
    // ポジション: 自分の後ろにまだ行動していない相手が何割いるか
    z(count(p => p.isActive && !p.hasActed && !p.isAllIn)),
    z(clip(me.chips / (totalChips + 1), 0, 1)),
    z(inHand.length / n)
  );

  // ---- 候補ごとの特徴量 ----
  for (let i = 0; i < FORMULA_SLOTS; i++) {
    const c = candidates[i];
    if (!c) { for (let k = 0; k < CAND_FEATURES; k++) obs.push(0); continue; }
    const uNow = _polAI.candidateUtility(c, calcTimeNow, profile, opponents);
    const uBig = _polAI.candidateUtility(c, calcTimeBig, profile, opponents);
    obs.push(
      1,                                        // この候補は存在する
      clip(c.slog / 6, 0, 1),
      uNow.pCorrect,
      uBig.pCorrect,                            // 時間が増えたときの伸びしろ
      uNow.utility,
      logScale(c.analysis.requiredTime, 4),
      clip(c.analysis.wmPeak / 8, 0, 1),
      clip(_polAI.cardsUsed(c) / 5, 0, 1),
      c.analysis.answerMode === 'exact' ? 1 : 0
    );
  }

  const best = candidates[0]
    ? _polAI.candidateUtility(candidates[0], calcTimeNow, profile, opponents) : null;
  let bestUtil = 0;
  for (const c of candidates) {
    const u = _polAI.candidateUtility(c, calcTimeNow, profile, opponents);
    if (u.utility > bestUtil) bestUtil = u.utility;
  }
  obs.push(
    bestUtil,
    best ? clip(candidates[0].slog / 6, 0, 1) : 0,
    clip(candidates.length / FORMULA_SLOTS, 0, 1)
  );

  return {
    obs,
    masks: buildMasks(game, idx, candidates),
    candidates,
    calcTime: calcTimeNow,
  };
}

function buildMasks(game, idx, candidates) {
  const me = game.players[idx];
  const toCall = Math.max(0, game.currentBet - me.currentBet);
  const minRaiseTotal = game.currentBet + game.minRaise;
  const maxTotal = me.currentBet + me.chips;

  // ベット: レイズは最低額に届き、かつオールインにならない範囲でのみ合法
  const canRaise = me.chips > 0 && maxTotal > minRaiseTotal;
  const raiseTargets = raiseTargetAmounts(game, idx);
  const bet = [
    1,                                   // fold は常に可能
    me.chips > 0 || toCall === 0 ? 1 : 0, // check / call
    canRaise && raiseTargets.half < maxTotal && raiseTargets.half >= minRaiseTotal ? 1 : 0,
    canRaise && raiseTargets.pot < maxTotal && raiseTargets.pot >= minRaiseTotal ? 1 : 0,
    canRaise && raiseTargets.pot2 < maxTotal && raiseTargets.pot2 >= minRaiseTotal ? 1 : 0,
    me.chips > 0 ? 1 : 0,                // allin
  ];
  // フォールドしか無い、という状況を作らない
  if (!bet.slice(1).some(Boolean)) bet[1] = 1;

  const formula = [];
  for (let i = 0; i < FORMULA_SLOTS; i++) formula.push(candidates[i] ? 1 : 0);
  if (!formula.some(Boolean)) formula[0] = 1;

  const maxDiscard = Math.min(EXCHANGE_SLOTS - 1, me.hand.length);
  const exchange = [];
  for (let i = 0; i < EXCHANGE_SLOTS; i++) exchange.push(i <= maxDiscard ? 1 : 0);

  return { bet, formula, exchange };
}

function raiseTargetAmounts(game, idx) {
  const me = game.players[idx];
  const toCall = Math.max(0, game.currentBet - me.currentBet);
  const pot = game.pot;
  return {
    half: me.currentBet + Math.min(me.chips, toCall + Math.round(pot * 0.5)),
    pot: me.currentBet + Math.min(me.chips, toCall + pot),
    pot2: me.currentBet + Math.min(me.chips, toCall + pot * 2),
  };
}

/** 行動ID → Game.playerAction に渡す {action, amount} */
function resolveBetAction(game, idx, actionId) {
  const me = game.players[idx];
  const toCall = Math.max(0, game.currentBet - me.currentBet);
  const t = raiseTargetAmounts(game, idx);
  switch (BET_ACTION_IDS[actionId]) {
    case 'fold': return { action: 'fold', amount: 0 };
    case 'checkcall':
      return toCall > 0 ? { action: 'call', amount: 0 } : { action: 'check', amount: 0 };
    case 'raise_half': return { action: 'raise', amount: t.half };
    case 'raise_pot': return { action: 'raise', amount: t.pot };
    case 'raise_2pot': return { action: 'raise', amount: t.pot2 };
    case 'allin': return { action: 'allin', amount: me.chips };
    default: return { action: 'check', amount: 0 };
  }
}

/**
 * 交換の行動ID → 捨てるカードID。
 * 「限界効用の低い順に k 枚」という1本の軸にしてあるので、
 * ネットワークは「どれだけ引き直したいか」だけを学べばよい。
 */
function resolveExchangeAction(game, idx, k, profile) {
  const me = game.players[idx];
  if (k <= 0) return [];

  const cands = _polAI.candidateSet(me.hand, profile);
  const best = cands[0];
  const used = new Set();
  if (best) {
    const need = {};
    for (const v of best.numbers) need[`n${v}`] = (need[`n${v}`] || 0) + 1;
    for (const v of best.ops) need[`o${v}`] = (need[`o${v}`] || 0) + 1;
    for (const c of me.hand) {
      const key = (c.type === 'number' ? 'n' : 'o') + c.value;
      if (need[key] > 0) { need[key]--; used.add(c.id); }
    }
  }
  // 捨てる順はヒューリスティックと同じ関数を使う（実測の表 + 使用札の下駄）。
  // ここだけ別の順序にしていたせいで、学習済みかどうかで交換の質が変わっていた。
  const t = _polAI.plannedCalcTime(game, idx, profile);
  return _polAI.pickDiscards(me.hand, used, t, k);
}

// ============================================================
// 小さなMLPの順伝播（ブラウザで学習済み方策を動かす用）
// ============================================================

function matVec(w, b, x) {
  const out = new Array(w.length);
  for (let i = 0; i < w.length; i++) {
    const row = w[i];
    let s = b[i];
    for (let j = 0; j < row.length; j++) s += row[j] * x[j];
    out[i] = s;
  }
  return out;
}

function tanhAll(v) { return v.map(Math.tanh); }

function maskedArgmax(logits, mask) {
  let bestI = -1, bestV = -Infinity;
  for (let i = 0; i < logits.length; i++) {
    if (mask && !mask[i]) continue;
    if (logits[i] > bestV) { bestV = logits[i]; bestI = i; }
  }
  return bestI < 0 ? 0 : bestI;
}

/**
 * 学習済みの重みで動く方策。
 * weights の形は train/train.py の export_policy() が書き出すもの。
 */
class NeuralPolicy {
  constructor(weights) {
    this.w = weights;
    this.obsDim = weights.obs_dim;
  }

  forward(obs) {
    if (obs.length !== this.obsDim) {
      throw new Error(`観測の次元が違う: ${obs.length} != ${this.obsDim}（学習時と特徴量がズレている）`);
    }
    let h = obs;
    for (const layer of this.w.trunk) h = tanhAll(matVec(layer.w, layer.b, h));
    const out = {};
    for (const key of Object.keys(this.w.heads)) {
      const l = this.w.heads[key];
      out[key] = matVec(l.w, l.b, h);
    }
    return out;
  }

  // ---- AIPlayer が呼ぶインターフェース ----

  decideBet(game, idx, ai) {
    const { obs, masks } = buildObservation(game, idx, ai.profile);
    const logits = this.forward(obs);
    return resolveBetAction(game, idx, maskedArgmax(logits.bet, masks.bet));
  }

  decideExchange(game, idx, ai) {
    const { obs, masks } = buildObservation(game, idx, ai.profile);
    const logits = this.forward(obs);
    const k = maskedArgmax(logits.exchange, masks.exchange);
    return resolveExchangeAction(game, idx, k, ai.profile);
  }

  chooseCandidate(cands, timeAvailable, ai, game, idx) {
    const { obs, masks, candidates } = buildObservation(game, idx, ai.profile);
    const logits = this.forward(obs);
    const pick = maskedArgmax(logits.formula, masks.formula);
    const cand = candidates[pick] || cands[0];
    if (!cand) return null;
    const opponents = Math.max(1, game.activePlayers().length - 1);
    const u = _polAI.candidateUtility(cand, timeAvailable, ai.profile, opponents);
    return { cand, score: u.utility, ...u };
  }
}

/**
 * 学習済みの重みを読み込む。
 *
 * train/train.py はレベルごとに models/policy_<level>.json を書き出す
 * （どのレベルの認知能力を前提に学習したかで最適な打ち方が変わるため）。
 * ファイルが無ければ null を返し、AIはヒューリスティック方策で動く。
 * ブラウザ専用。
 */
const _policyCache = new Map();

async function loadPolicy(level = 'casual') {
  if (typeof fetch === 'undefined') return null;
  if (_policyCache.has(level)) return _policyCache.get(level);

  const promise = (async () => {
    for (const url of [`models/policy_${level}.json`, 'models/policy.json']) {
      try {
        const res = await fetch(url, { cache: 'no-cache' });
        if (!res.ok) continue;
        const weights = await res.json();
        if (!weights || !weights.trunk || !weights.heads) continue;
        if (weights.obs_dim !== OBS_DIM) {
          console.warn(`[AI] ${url} の観測次元が現在の特徴量と一致しません`
            + `(${weights.obs_dim} != ${OBS_DIM})。学習し直しが必要です。`);
          continue;
        }
        return new NeuralPolicy(weights);
      } catch (e) { /* 次の候補へ */ }
    }
    return null;
  })();

  _policyCache.set(level, promise);
  return promise;
}

// ============================================================
// エクスポート
// ============================================================

const AIPolicy = {
  BET_ACTION_IDS, FORMULA_SLOTS, EXCHANGE_SLOTS, ACTION_SIZES,
  OBS_DIM, CONTEXT_FEATURES, OPPONENT_FEATURES, CAND_FEATURES,
  buildObservation, buildMasks, resolveBetAction, resolveExchangeAction,
  NeuralPolicy, loadPolicy, maskedArgmax,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = AIPolicy;
}
if (typeof window !== 'undefined') {
  window.AIPolicy = AIPolicy;
}
