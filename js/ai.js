/**
 * ai.js — 巨大数ポーカーのAI（CPU対戦相手）
 *
 * 役割は3つ。
 *   1. 手札から作れる数式を *全数列挙* し、(値, 人間にとっての難易度) の
 *      パレート境界を取り出す
 *   2. 選んだ数式に対して「正解の申告」または「難易度に応じてズレた申告」を作る
 *   3. ベット / 交換 / 式選択の方策（ヒューリスティック版）
 *      — 学習済みの方策があればそちらを使い、無ければこれで動く
 *
 * 正答率そのものは ai-cognition.js が持つ。ここはその上に乗る意思決定層。
 *
 * ============================================================
 * 探索空間が小さいことの証明（設計指示 8: 計算コスト）
 * ============================================================
 * 使えるカードは括弧を除いて5枚まで。数字 n 個をすべて二項演算で繋ぐには
 * n-1 個の演算子が要るので 2n-1 ≤ 5、つまり **数字は最大3枚**。
 *   n=1: 数字1 + 後置の ! を最大4個
 *   n=2: 数字2 + 二項1 + ! を最大2個（左/右/全体へ配置）
 *   n=3: 数字3 + 二項2（ちょうど5枚。! を置く余地は無い）
 * 実際の手札では重複を除くと候補は1000〜2000本程度に収まる。
 * 全数列挙してもミリ秒オーダーなので、枝刈りより先に *全部見る* ほうが速く確実。
 */

/* global HugeNumber, FormulaEvaluator, AICognition */
const _aiEngine = (typeof require !== 'undefined' && typeof module !== 'undefined')
  ? require('./engine.js') : null;
const _aiCog = (typeof require !== 'undefined' && typeof module !== 'undefined')
  ? require('./ai-cognition.js') : (typeof AICognition !== 'undefined' ? AICognition : null);

const HN = _aiEngine ? _aiEngine.HugeNumber : HugeNumber;
const FE = _aiEngine ? _aiEngine.FormulaEvaluator : FormulaEvaluator;
const COGN = _aiCog;

// ============================================================
// 乱数（学習の再現性のためシード可能にする）
// ============================================================

function makeRng(seed) {
  let a = (seed >>> 0) || 0x9e3779b9;
  return function rng() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ============================================================
// 値の「規模」を1次元にする（超対数）
// ============================================================

/**
 * slog: 10 を何回 log10 すれば1桁になるかの連続版。
 * compare() と順序が一致し、10^9 も 10↑↑5 も同じ尺度に乗る。
 * 学習の特徴量・相手モデル・報酬設計すべてでこれを使う。
 */
function slogScore(v) {
  if (!v) return 0;
  if (v.kind === 'inf') return 99;
  if (v.sign() <= 0) return 0;
  let parts;
  try { parts = v._towerParts(); } catch (e) { return 0; }
  const h = HN._heightAsNumber(parts.h);
  if (h === null) return 90;
  const t = Math.min(9.999, Math.max(1, parts.t));
  return h + (t - 1) / 9;
}

// ============================================================
// 数式の全数列挙
// ============================================================

const MAX_CARDS = 5;

/**
 * 手札から作れる数式をすべて列挙する。
 * @param {Array} hand カードの配列
 * @returns {Array<{formula:string, numbers:number[], ops:string[]}>}
 */
function enumerateFormulas(hand) {
  const numCount = {}, opCount = {};
  for (const c of hand || []) {
    if (c.type === 'number') numCount[c.value] = (numCount[c.value] || 0) + 1;
    else if (c.type === 'operator') opCount[c.value] = (opCount[c.value] || 0) + 1;
  }
  const nums = Object.keys(numCount).map(Number).sort((a, b) => b - a);
  const binOps = Object.keys(opCount).filter(o => o !== '!');
  const bangs = opCount['!'] || 0;

  const out = [];
  const seen = new Set();
  const push = (formula, numbers, ops) => {
    if (seen.has(formula)) return;
    seen.add(formula);
    out.push({ formula, numbers, ops });
  };

  const canUseNums = (list) => {
    const need = {};
    for (const v of list) { need[v] = (need[v] || 0) + 1; if (need[v] > numCount[v]) return false; }
    return true;
  };
  const canUseOps = (list) => {
    const need = {};
    for (const v of list) { need[v] = (need[v] || 0) + 1; if (need[v] > (opCount[v] || 0)) return false; }
    return true;
  };

  // ---- 数字1枚 + 後置の ! ----
  for (const a of nums) {
    for (let k = 0; k <= Math.min(bangs, MAX_CARDS - 1); k++) {
      push(`${a}${'!'.repeat(k)}`, [a], Array(k).fill('!'));
    }
  }

  // ---- 数字2枚 + 二項1個 + ! を最大2個 ----
  for (const a of nums) {
    for (const b of nums) {
      if (!canUseNums([a, b])) continue;
      for (const op of binOps) {
        const maxBang = Math.min(bangs, MAX_CARDS - 3);
        for (let k = 0; k <= maxBang; k++) {
          for (let ka = 0; ka <= k; ka++) {
            for (let kb = 0; kb <= k - ka; kb++) {
              const kw = k - ka - kb;
              const A = `${a}${'!'.repeat(ka)}`;
              const B = `${b}${'!'.repeat(kb)}`;
              const core = `${A}${op}${B}`;
              const f = kw > 0 ? `(${core})${'!'.repeat(kw)}` : core;
              push(f, [a, b], [op, ...Array(k).fill('!')]);
            }
          }
        }
      }
    }
  }

  // ---- 数字3枚 + 二項2個（ちょうど5枚）----
  for (const a of nums) {
    for (const b of nums) {
      for (const c of nums) {
        if (!canUseNums([a, b, c])) continue;
        for (const op1 of binOps) {
          for (const op2 of binOps) {
            if (!canUseOps([op1, op2])) continue;
            push(`(${a}${op1}${b})${op2}${c}`, [a, b, c], [op1, op2]);
            push(`${a}${op1}(${b}${op2}${c})`, [a, b, c], [op1, op2]);
          }
        }
      }
    }
  }

  return out;
}

// ============================================================
// 候補の評価とパレート境界
// ============================================================

const _evalCache = new Map();

function cachedEvaluate(formula) {
  let r = _evalCache.get(formula);
  if (r === undefined) {
    try { r = FE.evaluate(formula); } catch (e) { r = { ok: false, error: e.message }; }
    if (_evalCache.size > 40000) _evalCache.clear();
    _evalCache.set(formula, r);
  }
  return r;
}

const _handCache = new Map();

function handKey(hand, profileId) {
  const nums = [], ops = [];
  for (const c of hand || []) (c.type === 'number' ? nums : ops).push(c.value);
  nums.sort(); ops.sort();
  return `${nums.join(',')}|${ops.join(',')}|${profileId}`;
}

/**
 * 手札から「値と難易度のパレート境界」を作る。
 *
 * 値の降順に見て、それより大きい値を出す候補すべてより易しいものだけ残す。
 * こうすると「もっと大きくてもっと簡単な式がある」候補が消え、
 * 残るのは *リスクとリターンのトレードオフになっている候補だけ* になる。
 *
 * @returns {Array} 値の降順。各要素に analysis（ai-cognition の解析結果）が付く
 */
function candidateSet(hand, profile, limit = 14) {
  const key = handKey(hand, profile.id);
  const hit = _handCache.get(key);
  if (hit) return hit;

  const raw = enumerateFormulas(hand);
  const scored = [];

  for (const cand of raw) {
    const ev = cachedEvaluate(cand.formula);
    if (!ev.ok || !ev.value) continue;
    if (ev.value.sign() <= 0) continue;
    const analysis = COGN.analyzeFormula(
      { formula: cand.formula, ast: ev.ast, value: ev.value }, profile);
    if (!analysis.ok) continue;
    scored.push({
      formula: cand.formula,
      numbers: cand.numbers,
      ops: cand.ops,
      value: ev.value,
      slog: slogScore(ev.value),
      analysis,
    });
  }

  scored.sort((a, b) => (b.slog - a.slog) || (a.analysis.requiredTime - b.analysis.requiredTime));

  // パレート境界: 上位に「より大きくてより当てやすい」候補が無いものだけ残す
  const frontier = [];
  let bestP = -1;
  for (const c of scored) {
    if (c.analysis.pBase > bestP + 1e-6) {
      frontier.push(c);
      bestP = c.analysis.pBase;
      if (bestP >= COGN.COG.P_MAX - 1e-6) break;
    }
  }

  const result = frontier.slice(0, limit);
  if (_handCache.size > 4000) _handCache.clear();
  _handCache.set(key, result);
  return result;
}

/** 数式が使うカード（Game.submitFormula の検証と同じ数え方）*/
function cardsUsed(cand) {
  return cand.numbers.length + cand.ops.length;
}

// ============================================================
// 相手モデル
// ============================================================
//
// 「自分の値が相手の値を上回る確率」を出すための、提出値の規模(slog)の経験分布。
// tools/calibrate-ai.js が自己対戦から生成し、ここに貼り替える。

const OPPONENT_MODEL = {
  /** 相手が申告を当ててくる確率（外せば失格なので勝負から降りる） */
  pCorrect: 0.52,
  /** [slog, その値以下に収まる確率] の累積分布 */
  cdf: [
    [0.0, 0.02], [1.0, 0.10], [1.5, 0.24], [1.8, 0.42], [1.95, 0.58],
    [2.1, 0.70], [2.3, 0.80], [2.6, 0.88], [3.0, 0.94], [4.0, 0.98], [9.0, 1.0],
  ],
};

/** 相手1人の提出値が myScore 未満に収まる確率 */
function beatsOneOpponent(myScore, model = OPPONENT_MODEL) {
  const cdf = model.cdf;
  let p = 1;
  if (myScore <= cdf[0][0]) p = cdf[0][1];
  else {
    p = 1;
    for (let i = 1; i < cdf.length; i++) {
      if (myScore <= cdf[i][0]) {
        const [x0, y0] = cdf[i - 1], [x1, y1] = cdf[i];
        p = y0 + (y1 - y0) * ((myScore - x0) / (x1 - x0 || 1));
        break;
      }
    }
  }
  // 相手が失格なら値に関係なく勝てる
  return (1 - model.pCorrect) + model.pCorrect * COGN.clamp01(p);
}

// ============================================================
// 計算時間とポットの連動（設計指示 7）
// ============================================================

/** ポット額 → 計算フェーズの制限時間（Game._goToCalculation と同じ式） */
function calcTimeForPot(pot, config) {
  const min = (config && config.minCalcTime) || 30;
  const max = (config && config.maxCalcTime) || 600;
  return Math.max(min, Math.min(max, pot));
}

/**
 * 期待計算時間。
 * ベットラウンド中はポットが確定していないので、
 * 「自分がこれだけ出したら、他の生存者がどれだけ乗ってくるか」を見込んで推定する。
 */
function expectedCalcTime(game, myExtra, callProbability = 0.55) {
  const live = game.activePlayers().length;
  const others = Math.max(0, live - 1);
  const expectedPot = game.pot + myExtra + others * myExtra * callProbability;
  return calcTimeForPot(expectedPot, game.config);
}

// ============================================================
// 候補の効用
// ============================================================

/**
 * 制限時間を与えたときの候補の効用（＝そのハンドを取れる確率）。
 * pCorrect × 「その値で相手全員を上回る確率」。
 */
function candidateUtility(cand, timeAvailable, profile, opponents, model) {
  const acc = COGN.accuracyUnderTime(cand.analysis, timeAvailable, profile);
  const beat = Math.pow(beatsOneOpponent(cand.slog, model), Math.max(1, opponents));
  return {
    pCorrect: acc.pCorrect,
    beat,
    utility: acc.pCorrect * beat,
    acc,
  };
}

/** 制限時間のもとで最良の候補を選ぶ（riskAppetite で「大きさ寄り」に傾ける） */
function chooseCandidate(cands, timeAvailable, profile, opponents, model) {
  let best = null;
  for (const c of cands) {
    const u = candidateUtility(c, timeAvailable, profile, opponents, model);
    // riskAppetite が高いほど「値の大きさ」自体にも価値を認める
    const score = u.utility * (1 + profile.riskAppetite * 0.15 * Math.min(c.slog, 6));
    if (!best || score > best.score) best = { cand: c, score, ...u };
  }
  return best;
}

// ============================================================
// 申告文字列の生成
// ============================================================

/**
 * 正解の申告文字列を作る。
 * judgeDeclaration が要求する形式（厳密値 / 桁数 / 規模）に合わせる。
 * 規模モードは先頭指数まで double 一致が要るので、実際に判定を通して確認する。
 */
function correctDeclaration(value) {
  const mode = FE.declarationMode(value);
  if (mode === 'exact') return value.v.toString();

  if (mode === 'digits') {
    const d = value.digitCountHuge();
    if (d.kind === 'exact') return `${d.v.toString()}桁`;
    return null;
  }

  // scale: 10^10^…^t の形を精度を変えながら試し、判定を通ったものを採用する
  let parts;
  try { parts = value._towerParts(); } catch (e) { return null; }
  const h = HN._heightAsNumber(parts.h);
  if (h === null || h < 1 || h > 12) return null;
  for (let prec = 17; prec >= 8; prec--) {
    const s = '10^'.repeat(h) + parts.t.toPrecision(prec);
    try {
      if (FE.judgeDeclaration(value, s).ok) return s;
    } catch (e) { /* 次の精度を試す */ }
  }
  return null;
}

/**
 * 誤答の申告を作る（設計指示 5）。
 * 難易度が高いほど、外し方が盛大になる。
 */
function wrongDeclaration(value, difficulty, rng) {
  const tier = COGN.pickErrorTier(difficulty, rng);
  const mode = FE.declarationMode(value);
  const sign = rng() < 0.5 ? -1 : 1;

  let text = null;
  if (mode === 'exact') text = perturbExact(value, tier, sign, rng);
  else if (mode === 'digits') text = perturbDigits(value, tier, sign, rng);
  else text = perturbScale(value, tier, sign, rng);

  if (!text) text = '0';

  // 誤答のつもりが偶然当たってしまったら、ずらし直す
  try {
    if (FE.judgeDeclaration(value, text).ok) {
      text = mode === 'exact' ? bumpDigitString(text) : `${text}0`;
    }
  } catch (e) { /* 解釈できない文字列ならそれで良い（不正解になる） */ }
  return { text, tier };
}

function perturbExact(value, tier, sign, rng) {
  const s = value.v.toString();

  if (tier === 'slip') {
    // 1桁だけ書き間違える / 隣を入れ替える — 易しい問題で最も多いミス
    const arr = s.split('');
    if (arr.length >= 2 && rng() < 0.4) {
      const i = Math.floor(rng() * (arr.length - 1));
      [arr[i], arr[i + 1]] = [arr[i + 1], arr[i]];
    } else {
      const i = Math.floor(rng() * arr.length);
      const d = (parseInt(arr[i], 10) + (rng() < 0.5 ? 1 : 9)) % 10;
      arr[i] = String(i === 0 && d === 0 ? 1 : d);
    }
    return arr.join('');
  }

  const factors = { small: [1.01, 1.15], medium: [1.5, 4], large: [10, 1000], huge: [1e4, 1e8] };
  const [lo, hi] = factors[tier] || factors.small;
  const f = lo + rng() * (hi - lo);
  let out;
  try {
    const scaled = sign > 0
      ? (value.v * BigInt(Math.round(f * 1e6))) / 1000000n
      : (value.v * 1000000n) / BigInt(Math.round(f * 1e6));
    out = (scaled <= 0n ? 1n : scaled).toString();
  } catch (e) { out = s; }
  return out;
}

function perturbDigits(value, tier, sign, rng) {
  const d = value.digitCountHuge();
  if (d.kind !== 'exact') return null;
  const n = d.v;
  let delta;
  switch (tier) {
    case 'slip': delta = 1n; break;
    case 'small': delta = BigInt(2 + Math.floor(rng() * 4)); break;
    case 'medium': delta = bigMax(1n, n / 10n); break;
    case 'large': delta = bigMax(1n, n / 2n); break;
    default: delta = bigMax(1n, n * BigInt(3 + Math.floor(rng() * 9))); break;
  }
  let out = sign > 0 ? n + delta : n - delta;
  if (out <= 0n) out = 1n;
  return `${out.toString()}桁`;
}

function perturbScale(value, tier, sign, rng) {
  let parts;
  try { parts = value._towerParts(); } catch (e) { return null; }
  const h = HN._heightAsNumber(parts.h);
  if (h === null) return '10↑↑99';
  if (tier === 'huge' || tier === 'large') {
    const nh = Math.max(1, h + sign * (1 + Math.floor(rng() * 2)));
    return '10^'.repeat(Math.min(nh, 12)) + '2';
  }
  const jitter = { slip: 0.001, small: 0.02, medium: 0.2 }[tier] || 0.05;
  const t = Math.min(9.9, Math.max(1, parts.t * (1 + sign * jitter)));
  return '10^'.repeat(Math.min(h, 12)) + t.toPrecision(6);
}

function bigMax(a, b) { return a > b ? a : b; }

function bumpDigitString(s) {
  const m = s.match(/^(\d+)(.*)$/);
  if (!m) return `${s}1`;
  return `${(BigInt(m[1]) + 1n).toString()}${m[2]}`;
}

/**
 * 数式を1本決めて、実際に申告する内容を作る。
 * pCorrect の判定はここで1回だけ振る。
 */
function produceSubmission(cand, timeAvailable, profile, opponents, rng, model) {
  const u = candidateUtility(cand, timeAvailable, profile, opponents, model);

  // 間に合わなかった → そもそも提出しない（時間切れ失格）
  if (rng() > u.acc.pFinish) {
    return { formula: cand.formula, declared: null, timedOut: true, pCorrect: u.pCorrect };
  }

  const correct = rng() < (u.pCorrect / Math.max(u.acc.pFinish, 1e-6));
  if (correct) {
    const text = correctDeclaration(cand.value);
    if (text !== null) {
      return { formula: cand.formula, declared: text, correct: true, pCorrect: u.pCorrect };
    }
    // 正解の書き方が作れない規模（scale モード）→ 結局は誤答になる
  }

  const w = wrongDeclaration(cand.value, cand.analysis.difficulty, rng);
  return {
    formula: cand.formula, declared: w.text, correct: false,
    errorTier: w.tier, pCorrect: u.pCorrect,
  };
}

// ============================================================
// ヒューリスティック方策
// ============================================================
//
// 学習済みの方策が無いときに使う。PPO の対戦相手（ベースライン）としても使う。

const BET_ACTIONS = ['fold', 'checkcall', 'raise_half', 'raise_pot', 'raise_2pot', 'allin'];

/** 現在のハンドの強さ（自分の最良候補の効用）を、期待ポットのもとで測る */
function handStrength(game, playerIdx, profile, myExtra = 0, model = OPPONENT_MODEL) {
  const player = game.players[playerIdx];
  const cands = candidateSet(player.hand, profile);
  if (cands.length === 0) return { equity: 0, best: null, cands };
  const t = expectedCalcTime(game, myExtra);
  const opponents = Math.max(1, game.activePlayers().length - 1);
  const best = chooseCandidate(cands, t, profile, opponents, model);
  return { equity: best ? best.utility : 0, best, cands, calcTime: t };
}

/**
 * ベット額の決定。
 *
 * 設計指示 7 の要:「ベットするとポットが増え、結果として計算時間が伸びて
 * 自分の正答率が上がる」。つまり *難しい式を持っているほどレイズしたい*。
 * 候補ごとに「その額を出したときの期待計算時間」で正答率を引き直し、
 * 期待値が最大になる額を選ぶ。
 */
function decideBet(game, playerIdx, profile, rng, model = OPPONENT_MODEL) {
  const player = game.players[playerIdx];
  const toCall = Math.max(0, game.currentBet - player.currentBet);
  const pot = game.pot;
  const opponents = Math.max(1, game.activePlayers().length - 1);

  const sizes = [
    { action: 'checkcall', extra: Math.min(toCall, player.chips) },
    { action: 'raise_half', extra: Math.min(toCall + Math.round(pot * 0.5), player.chips) },
    { action: 'raise_pot', extra: Math.min(toCall + pot, player.chips) },
    { action: 'raise_2pot', extra: Math.min(toCall + pot * 2, player.chips) },
    { action: 'allin', extra: player.chips },
  ];

  let best = null;
  for (const s of sizes) {
    const t = expectedCalcTime(game, s.extra);
    const cands = candidateSet(player.hand, profile);
    const pick = chooseCandidate(cands, t, profile, opponents, model);
    if (!pick) continue;
    const finalPot = pot + s.extra * (1 + (opponents) * 0.55);
    // 勝てば finalPot を取り、負ければ自分の追加分を失う
    const ev = pick.utility * finalPot - (1 - pick.utility) * s.extra;
    const aggr = s.action === 'checkcall' ? 1 : profile.aggression;
    const score = ev * aggr;
    if (!best || score > best.score) best = { ...s, score, ev, equity: pick.utility, calcTime: t };
  }

  if (!best) return { action: 'fold', amount: 0 };

  const equity = best.equity;

  // ---- 降りるかどうか: ポットオッズと比べる ----
  if (toCall > 0) {
    const potOdds = toCall / (pot + toCall);
    const bluff = rng() < profile.bluffRate;
    if (equity < potOdds * 0.85 && !bluff) return { action: 'fold', amount: 0 };
    if (toCall >= player.chips) return { action: 'allin', amount: player.chips };
  }

  // ---- レイズするか ----
  const wantRaise = best.action !== 'checkcall'
    && (equity > 0.45 || rng() < profile.bluffRate);

  if (!wantRaise) {
    return toCall > 0 ? { action: 'call', amount: 0 } : { action: 'check', amount: 0 };
  }

  const target = player.currentBet + best.extra;
  const minTotal = game.currentBet + game.minRaise;
  if (target >= player.currentBet + player.chips) {
    return { action: 'allin', amount: player.chips };
  }
  return { action: 'raise', amount: Math.max(minTotal, Math.round(target)) };
}

/**
 * 交換の決定。
 * 最良候補が使っていないカードを捨てる。手が弱いときは使用中のカードも切る。
 */
function decideExchange(game, playerIdx, profile, rng, model = OPPONENT_MODEL) {
  const player = game.players[playerIdx];
  const st = handStrength(game, playerIdx, profile, 0, model);
  if (!st.best) return player.hand.slice(0, 3).map(c => c.id);

  const used = new Set();
  const need = {};
  for (const v of st.best.cand.numbers) need[`n${v}`] = (need[`n${v}`] || 0) + 1;
  for (const v of st.best.cand.ops) need[`o${v}`] = (need[`o${v}`] || 0) + 1;

  for (const c of player.hand) {
    const key = (c.type === 'number' ? 'n' : 'o') + c.value;
    if (need[key] > 0) { need[key]--; used.add(c.id); }
  }

  const spare = player.hand.filter(c => !used.has(c.id));

  // 手が十分強ければ余りだけ替える。弱ければ踏み込んで替える。
  const satisfied = st.equity > 0.5 + profile.riskAppetite * 0.2;
  let discard = spare;
  if (!satisfied) {
    const ranked = player.hand
      .filter(c => used.has(c.id))
      .sort((a, b) => cardStaticValue(a) - cardStaticValue(b));
    discard = spare.concat(ranked.slice(0, Math.max(0, 4 - spare.length)));
  }
  // たまには温存する（読まれないため）
  if (rng() < 0.15 && discard.length > 1) discard = discard.slice(0, discard.length - 1);
  return discard.slice(0, 5).map(c => c.id);
}

const STATIC_CARD_VALUE = {
  '^': 10, '!': 9, 'P': 5, '*': 4, '+': 3, '↑↑': 3,
};

function cardStaticValue(card) {
  if (card.type === 'operator') return STATIC_CARD_VALUE[card.value] || 3;
  return Number(card.value) * 0.8;
}

// ============================================================
// AIプレイヤー
// ============================================================

class AIPlayer {
  /**
   * @param {string} level AI_PROFILES のキー
   * @param {object} opts { seed, policy }  policy は学習済み方策（無ければヒューリスティック）
   */
  constructor(level = 'casual', opts = {}) {
    this.profile = COGN.getProfile(level);
    this.level = this.profile.id;
    this.rng = opts.rng || makeRng(opts.seed || (Math.random() * 1e9) | 0);
    this.policy = opts.policy || null;
    this.model = opts.opponentModel || OPPONENT_MODEL;
  }

  /** ベットラウンドの行動 */
  act(game, playerIdx) {
    if (this.policy && this.policy.decideBet) {
      const a = this.policy.decideBet(game, playerIdx, this);
      if (a) return a;
    }
    return decideBet(game, playerIdx, this.profile, this.rng, this.model);
  }

  /** 交換するカードID */
  exchange(game, playerIdx) {
    if (this.policy && this.policy.decideExchange) {
      const a = this.policy.decideExchange(game, playerIdx, this);
      if (a) return a;
    }
    return decideExchange(game, playerIdx, this.profile, this.rng, this.model);
  }

  /**
   * 数式と申告を決める。
   * @returns {{formula, declared, thinkSeconds, correct, pCorrect, timedOut}}
   */
  submit(game, playerIdx) {
    const player = game.players[playerIdx];
    const cands = candidateSet(player.hand, this.profile);
    if (cands.length === 0) {
      return { formula: null, declared: null, timedOut: true, thinkSeconds: 0 };
    }
    const time = game.calculationTimeLimit || calcTimeForPot(game.pot, game.config);
    const opponents = Math.max(1, game.activePlayers().length - 1);

    let pick;
    if (this.policy && this.policy.chooseCandidate) {
      pick = this.policy.chooseCandidate(cands, time, this, game, playerIdx);
    }
    if (!pick) pick = chooseCandidate(cands, time, this.profile, opponents, this.model);
    if (!pick) return { formula: null, declared: null, timedOut: true, thinkSeconds: 0 };

    const sub = produceSubmission(pick.cand, time, this.profile, opponents, this.rng, this.model);

    // 実際に何秒かけるか（対数正規のばらつき）。UIの提出タイミングに使う。
    const req = pick.cand.analysis.requiredTime;
    const noise = Math.exp((this.rng() * 2 - 1) * COGN.COG.TIME_SIGMA);
    sub.thinkSeconds = Math.min(time * 0.97, Math.max(1, req * noise));
    sub.analysis = pick.cand.analysis;
    sub.slog = pick.cand.slog;
    return sub;
  }

  /** デバッグ・可視化用: いま何を考えているか */
  explain(game, playerIdx) {
    const player = game.players[playerIdx];
    const cands = candidateSet(player.hand, this.profile);
    const time = game.calculationTimeLimit || calcTimeForPot(game.pot, game.config);
    const opponents = Math.max(1, game.activePlayers().length - 1);
    return cands.map(c => {
      const u = candidateUtility(c, time, this.profile, opponents, this.model);
      return {
        formula: c.formula,
        value: c.value.toString(),
        mode: c.analysis.answerMode,
        requiredTime: Math.round(c.analysis.requiredTime),
        wmPeak: Number(c.analysis.wmPeak.toFixed(1)),
        pCorrect: Number(u.pCorrect.toFixed(3)),
        utility: Number(u.utility.toFixed(3)),
        notes: c.analysis.notes,
      };
    });
  }
}

// ============================================================
// エクスポート
// ============================================================

/**
 * 評価キャッシュと候補キャッシュを捨てる。
 * candidateSet の結果には ai-cognition の解析結果が埋まっているので、
 * COG の定数を実行中に書き換えたら、こちらも捨てないと古い難易度が残る。
 */
function clearCaches() {
  _evalCache.clear();
  _handCache.clear();
}

const AI = {
  AIPlayer, makeRng, slogScore, clearCaches,
  enumerateFormulas, candidateSet, candidateUtility, chooseCandidate,
  correctDeclaration, wrongDeclaration, produceSubmission,
  decideBet, decideExchange, handStrength,
  calcTimeForPot, expectedCalcTime, beatsOneOpponent,
  OPPONENT_MODEL, BET_ACTIONS, cardsUsed, cardStaticValue,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = AI;
}
if (typeof window !== 'undefined') {
  window.AI = AI;
  window.AIPlayer = AIPlayer;
}
