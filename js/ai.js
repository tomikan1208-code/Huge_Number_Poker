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
// トーナメントの価値（ICM）
// ============================================================
//
// このゲームは1人残るまで戦うトーナメントで、リバイが無い。
// チップの価値は線形ではない。
//   ・持っているほど追加1点の価値が下がる（限界効用が逓減する）
//   ・0 になったら終わり。取り返す機会そのものが消える
//
// この2つを入れないと「期待値がわずかにプラスならコール」が常に正しくなり、
// AIは毎ハンド全部突っ込む。実際そうなっていた（大学生で78%がオールイン）。
//
// 学習側（train/env_server.js）の報酬もこの関数を使う。実装を2つ持つと
// 「学習した打ち方とゲーム内の打ち方が違う」という気づきにくいズレになるので、
// ブラウザからも読めるここに1つだけ置く。

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

/**
 * 自分のスタックが delta だけ動いたときの、自分の ICM 期待値。
 *
 * 増減は他の生存者と按分する（チップは湧かないし消えない）。
 * 自分が 0 になったらその場で最下位が確定するので、最下位の取り分を返す。
 *
 * @param {number[]} stacks 生存者全員のチップ
 * @param {number} idx      自分の位置
 * @param {number} delta    自分のチップの増減
 */
function icmAfterDelta(stacks, idx, delta) {
  const n = stacks.length;
  const payouts = placePayouts(n);
  if (n <= 1) return payouts[0];

  const mine = stacks[idx] + delta;
  if (mine <= 1e-9) return payouts[n - 1];        // 飛んだ

  const othersTotal = stacks.reduce((a, b, i) => a + (i === idx ? 0 : b), 0);
  const next = stacks.slice();
  next[idx] = mine;

  // 自分が得た（失った）分を、他の席から持ち分に応じて引く（足す）
  if (othersTotal > 0) {
    for (let i = 0; i < n; i++) {
      if (i === idx) continue;
      next[i] = Math.max(0, stacks[i] - delta * (stacks[i] / othersTotal));
    }
  }
  return icmEquity(next, payouts)[idx];
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

// ============================================================
// 相手が降りる確率（フォールドエクイティ）
// ============================================================
//
// **根拠のある数字ではない。** 相手の手札は見えないし、このゲームの
// 「降り方」の実測も無い。形だけ理屈で決めて、値は判断で置いている。
//
// 形の理屈:
//   ・相手はポットオッズで考える。コール額がポットに対して大きいほど降りる
//   ・ただしこのゲームでは **ポットが増えると計算時間が全員分伸びる**。
//     時間が伸びれば相手も当てやすくなるので、そのぶんコール側に引き戻される。
//     普通のポーカーには無い項で、大きなブラフに固有のコストになっている

const BET_MODEL = {
  /** 追加ベットが 0 のときのコール率 */
  CALL_AT_ZERO: 0.85,
  /** コール率が半分になる追加ベット（ポットの何倍か） */
  HALF_AT: 1.2,
  /** 計算時間が伸びたぶん、どれだけコール側へ引き戻すか */
  TIME_PULL: 0.30,
  /** コール率の下限・上限（0や1に振り切らせない） */
  CALL_MIN: 0.05, CALL_MAX: 0.95,
  /** ブラフ気分のとき「相手は降りる」をどれだけ強気に見るか */
  BLUFF_OPTIMISM: 1.6,
  /** aggression（1.0が標準）が賭け側の評価に効く強さ */
  AGGRESSION_WEIGHT: 0.5,
};

/**
 * 相手1人がコールしてくる確率。
 *
 * @param {number} raiseOver コールを超えて積む額
 * @param {number} pot       現在のポット
 * @param {number} toCall    自分がコールに要する額（相手から見た「既に入っている圧」）
 */
function callProbability(raiseOver, pot, toCall, config) {
  if (raiseOver <= 0) return BET_MODEL.CALL_AT_ZERO;

  const ratio = raiseOver / Math.max(pot + toCall, 1);
  let p = BET_MODEL.CALL_AT_ZERO / (1 + ratio / BET_MODEL.HALF_AT);

  // ポットが伸びたぶん計算時間が伸びる → 相手も当てやすくなる → コール寄りに戻る
  const before = calcTimeForPot(pot + toCall, config);
  const after = calcTimeForPot(pot + toCall + raiseOver, config);
  const max = (config && config.maxCalcTime) || 600;
  const gain = Math.max(0, Math.min(1, (after - before) / max));
  p += BET_MODEL.TIME_PULL * gain * (1 - p);

  return Math.max(BET_MODEL.CALL_MIN, Math.min(BET_MODEL.CALL_MAX, p));
}

/**
 * 「結局この式を何秒で解くことになるのか」の見積もり。
 *
 * ============================================================
 * なぜ「今のポット」ではいけないか
 * ============================================================
 * 計算時間はポットのチップ数で決まる（設計指示7）。だがポットは
 * **計算フェーズに入るまで増え続ける**。今のポットで見積もると時間を短く見て、
 * 易しくて小さい式のほうを高く評価してしまう。
 *
 * 実際これで、交換とベットが **別々の式を見ている** 状態になっていた。
 *
 *     交換  : expectedCalcTime(game, 0) = 今のポット   → 1分0秒  で (8^9)+6 を守る
 *     ベット: 賭けた後のポット                          → 10分0秒 で (9+6)^8 を狙う
 *
 * 交換は「(8^9)+6 に要る札」を残すのに、ベットは「(9+6)^8 を作る前提」で
 * 額を決める。守る札と狙う式が食い違う。AIテスト場の手札タブで見つかった。
 *
 * ============================================================
 * 直し方: 新しい定数を置かず、AI自身のベット計画から取る
 * ============================================================
 * 「計算フェーズのポットはいくらか」を当てにいくと、また根拠のない判断値が増える。
 * そうではなく **AIが今まさに選ぼうとしているベット額** から逆算する。
 * evaluateBetSizes() は額ごとに「その額を出したときのポットと計算時間」を
 * 既に出しているので、その最良手の calcTime をそのまま使う。
 *
 * これでベットと交換が **定義上同じ数字**を見ることになり、食い違いようがなくなる。
 * 増える定数はゼロ。
 *
 * 残る過小評価: どちらも「このベットラウンドが終わった時点のポット」までしか見ない。
 * 交換の後にもう1ラウンドあるぶんは、まだ数えていない。
 * そこを埋めるには「次のラウンドでいくら入るか」の仮定が要り、
 * それは根拠の無い定数になるので入れていない。
 */
function plannedCalcTime(game, playerIdx, profile, model = OPPONENT_MODEL) {
  // 計算フェーズに入っていれば制限時間は確定している
  if (game.calculationTimeLimit > 0
      && (game.phase === 'CALCULATION' || game.phase === 'SHOWDOWN')) {
    return game.calculationTimeLimit;
  }
  const ev = evaluateBetSizes(game, playerIdx, profile, model, false);
  return ev.best ? ev.best.calcTime : expectedCalcTime(game, 0);
}

/**
 * 現在のハンドの強さ（自分の最良候補の効用）。
 * @param {number|null} myExtra 自分が追加で出す額。null なら plannedCalcTime を使う
 */
function handStrength(game, playerIdx, profile, myExtra = 0, model = OPPONENT_MODEL) {
  const player = game.players[playerIdx];
  const cands = candidateSet(player.hand, profile);
  if (cands.length === 0) return { equity: 0, best: null, cands, calcTime: 0 };
  const t = myExtra === null
    ? plannedCalcTime(game, playerIdx, profile, model)
    : expectedCalcTime(game, myExtra);
  const opponents = Math.max(1, game.activePlayers().length - 1);
  const best = chooseCandidate(cands, t, profile, opponents, model);
  return { equity: best ? best.utility : 0, best, cands, calcTime: t };
}

/**
 * ベット額の決定。
 *
 * ============================================================
 * 3つの力の釣り合いで決める
 * ============================================================
 * 1. **計算時間**（設計指示 7）
 *    ベットするとポットが増え、計算フェーズの制限時間が伸びて自分の正答率が上がる。
 *    つまり *難しい式を持っているほど賭けたい*。
 *    ただしこのゲームの制限時間は**卓で共通**なので、伸びるのは相手の時間も同じ。
 *    大きく賭けると、受けた相手も当てやすくなる。
 *
 * 2. **フォールドエクイティ**
 *    大きく賭けるほど相手は降りやすい。全員降りれば**ショーダウン抜きで**ポットを取れる。
 *    弱い手で大きく賭ける、つまり **ブラフが成立するのはここだけ**。
 *
 * 3. **トーナメントの価値（ICM）**
 *    チップの損得ではなく**順位の期待値**で測る。
 *    全部突っ込んで負ければトーナメントが終わるので、その損は同じ枚数の得より大きい。
 *
 * ============================================================
 * 以前の作り（毎ハンド全部突っ込んでいた）
 * ============================================================
 *     finalPot = pot + extra * (1 + opponents * 0.55)
 *     ev       = utility * finalPot - (1 - utility) * extra
 *
 * extra についての傾きが `utility × (1+opponents×0.55) − (1−utility)` なので、
 * 3人卓では **utility が 0.323 を超えた瞬間に「賭けるほど得」**になり、
 * 常にオールインが最大になった。実測で大学生の 78%、競技者の 85% がオールイン。
 * レイズ3段階は 0.2% しか使われず、行動空間が {fold, call, allin} に潰れていた。
 *
 * 原因は「相手は必ずベットの55%ずつ付いてくる」という仮定で、
 * **ベットを増やすことの不利益がモデルに存在しなかった**こと。
 * 上の 2（降りられたらショーダウン価値が消える）と 3（飛ぶ）が両方とも
 * 大きくするほど効くので、今は内側に最大値ができる。
 */
/**
 * 各ベット額を評価する。decideBet の中身であり、テスト場が内訳を見るための入口でもある。
 *
 * 判断の理由が外から見えないと「なぜ降りたのか」が分からないので、
 * 選ばれなかった額も含めて全部返す。
 *
 * @param {boolean} [bluffing] ブラフ気分か。省略時は profile.bluffRate で振らない（false）
 * @returns {{sizes:Array, best:object|null, eqFoldNow:number, folds:boolean,
 *            toCall:number, pot:number, opponents:number, cands:Array}}
 */
function evaluateBetSizes(game, playerIdx, profile, model = OPPONENT_MODEL, bluffing = false) {
  const player = game.players[playerIdx];
  const toCall = Math.max(0, game.currentBet - player.currentBet);
  const pot = game.pot;
  const opponents = Math.max(1, game.activePlayers().length - 1);
  const cands = candidateSet(player.hand, profile);

  // ---- ICM の土台 ----
  const live = game.livePlayers();
  const myLiveIdx = live.indexOf(player);
  const stacks = live.map((p) => Math.max(0, p.chips));
  const icm = (delta) => (myLiveIdx < 0 || live.length <= 1)
    ? delta                                   // 単独 or 見つからない → チップそのもの
    : icmAfterDelta(stacks, myLiveIdx, delta);

  // 今降りた場合。既に出した分は戻らないので増減 0
  const eqFoldNow = icm(0);

  const wanted = [
    { action: 'checkcall', extra: Math.min(toCall, player.chips) },
    { action: 'raise_half', extra: Math.min(toCall + Math.round(pot * 0.5), player.chips) },
    { action: 'raise_pot', extra: Math.min(toCall + pot, player.chips) },
    { action: 'raise_2pot', extra: Math.min(toCall + pot * 2, player.chips) },
    { action: 'allin', extra: player.chips },
  ];

  const sizes = [];
  let best = null;
  const seen = new Set();

  for (const s of wanted) {
    if (s.extra > player.chips) continue;
    if (seen.has(s.extra) && s.action !== 'checkcall') continue;   // 同額の重複を潰す
    seen.add(s.extra);

    const raiseOver = Math.max(0, s.extra - toCall);      // コールを超えて積む分
    const pCall = callProbability(raiseOver, pot, toCall, game.config);
    const pAllFold = Math.min(1, (raiseOver > 0 || toCall > 0)
      ? Math.pow(1 - pCall, opponents) * (bluffing ? BET_MODEL.BLUFF_OPTIMISM : 1)
      : 0);                                               // チェックで回すなら降りようがない

    // 期待計算時間は「実際に付いてくる人数」で見積もる
    const callers = opponents * pCall;
    const calcTime = calcTimeForPot(pot + s.extra + callers * raiseOver, game.config);
    const pick = chooseCandidate(cands, calcTime, profile, opponents, model);
    if (!pick) continue;

    // ---- 3つの結末を ICM で評価する ----
    const finalPot = pot + s.extra + callers * raiseOver;
    const eqSteal = icm(pot);                  // 全員降りた（ショーダウン無しでポットを取る）
    const eqWin = icm(finalPot - s.extra);     // 受けられて勝った
    const eqLose = icm(-s.extra);              // 受けられて負けた

    const u = pick.utility;
    const showdown = u * eqWin + (1 - u) * eqLose;
    let score = pAllFold * eqSteal + (1 - pAllFold) * showdown;

    // 性格。積極的なプロファイルほど、賭ける側の選択肢を高く評価する
    if (s.action !== 'checkcall') {
      score += (score - eqFoldNow) * (profile.aggression - 1) * BET_MODEL.AGGRESSION_WEIGHT;
    }

    const row = {
      action: s.action, extra: s.extra, raiseOver,
      score, equity: u, pCorrect: pick.pCorrect, beat: pick.beat,
      calcTime, pCall, pAllFold, finalPot,
      eqSteal, eqWin, eqLose, pick,
    };
    sizes.push(row);
    if (!best || score > best.score) best = row;
  }

  // 「一番良い賭け方をしても、いま降りるより悪い」なら降りる。
  // ポットオッズの比較を ICM に置き換えたもので、飛ぶリスクがここに入っている。
  const folds = !best || (toCall > 0 && best.score < eqFoldNow);

  return { sizes, best, eqFoldNow, folds, toCall, pot, opponents, cands };
}

/** evaluateBetSizes の結果を Game が受け取れる形に落とす */
function resolveBetChoice(game, playerIdx, ev) {
  const player = game.players[playerIdx];
  if (ev.folds || !ev.best) return { action: 'fold', amount: 0 };

  if (ev.best.action === 'checkcall') {
    return ev.toCall > 0 ? { action: 'call', amount: 0 } : { action: 'check', amount: 0 };
  }
  const target = player.currentBet + ev.best.extra;
  if (ev.best.action === 'allin' || target >= player.currentBet + player.chips) {
    return { action: 'allin', amount: player.chips };
  }
  const minTotal = game.currentBet + game.minRaise;
  return { action: 'raise', amount: Math.max(minTotal, Math.round(target)) };
}

function decideBet(game, playerIdx, profile, rng, model = OPPONENT_MODEL) {
  // ブラフ気分かどうかはここで1回だけ振る。
  // 「相手は降りる」と強気に見積もる方向に効かせるので、弱い手ほど大きく賭ける
  // ＝ ブラフになる。以前のように fold 判定をランダムに無効化するのではない。
  const bluffing = rng() < profile.bluffRate;
  const ev = evaluateBetSizes(game, playerIdx, profile, model, bluffing);
  return resolveBetChoice(game, playerIdx, ev);
}

/**
 * 交換の決定。
 * 最良候補が使っていないカードを捨てる。手が弱いときは使用中のカードも切る。
 */
function decideExchange(game, playerIdx, profile, rng, model = OPPONENT_MODEL) {
  const player = game.players[playerIdx];
  // ベットと同じ計算時間で見る。ここを expectedCalcTime(game, 0) にすると
  // 「守る札」と「狙う式」が食い違う（plannedCalcTime の説明を参照）。
  const st = handStrength(game, playerIdx, profile, null, model);
  if (!st.best) return player.hand.slice(0, 3).map(c => c.id);

  const used = new Set();
  const need = {};
  for (const v of st.best.cand.numbers) need[`n${v}`] = (need[`n${v}`] || 0) + 1;
  for (const v of st.best.cand.ops) need[`o${v}`] = (need[`o${v}`] || 0) + 1;
  for (const c of player.hand) {
    const key = (c.type === 'number' ? 'n' : 'o') + c.value;
    if (need[key] > 0) { need[key]--; used.add(c.id); }
  }

  // 何枚替えるか。手が十分強ければ余りの枚数だけ、弱ければ踏み込む。
  // *どの* 札を捨てるかは discardOrder（実測の表）が決める。
  const spare = player.hand.length - used.size;
  const satisfied = st.equity > 0.5 + profile.riskAppetite * 0.2;
  let k = satisfied ? spare : Math.max(spare, 4);

  // たまには温存する（読まれないため）
  if (rng() < 0.15 && k > 1) k -= 1;

  return pickDiscards(player.hand, used, st.calcTime, k);
}


// ============================================================
// どの札を残すか
// ============================================================
//
// 以前は手書きの表だった。
//     { '^': 10, '!': 9, 'P': 5, '*': 4, '+': 3, '↑↑': 3 } / 数字は 値×0.8
// 根拠は「べき乗は強そう」程度の感覚で、実測ではない。
// 実際これのせいで ↑↑（= + と同値）が数字の 4 や 5 より先に捨てられていた。
//
// tools/measure-card-values.js で測り直した。定義は
//     loss(札) = 今の最良効用 − E[ その札を捨てて1枚引いた後の最良効用 ]
// で、**大きいほど残すべき**。手札500通り × 5レベル × 1枚引き6サンプル。
//
// 測って分かったこと:
//
//   再現する（独立2回の順位相関 0.91〜0.95）:
//     ・時間が長いとき  ^ と ! が突出（0.05 前後）。次いで ↑↑ と *
//     ・時間が短いとき  ^ の価値は **負**。重い式を作っても間に合わないので、
//                       持っていると却って悪い方へ引っ張られる
//     ・手札に7以上の数字があると演算子の価値が跳ね上がる（^ は 0.025 → 0.051）
//       「相方が居るから演算子が活きる」が数字に出た形
//
//   再現しない:
//     ・数字どうしの順位。全部 ±0.02 に収まり、測るたびに入れ替わる。
//       32/54 枚が数字なので、特定の数字を抱える価値がほとんど無い。
//       手書きの表がやっていた「9 > 8 > 7 > …」は**根拠が無かった**ので捨てた
//     ・レベルによる違い。時間と文脈の効果に埋もれるので平均した
//
// 実行時に手札ごとに計算しないのは速度の問題。1回の評価に候補列挙が要り、
// キャッシュを外すと 1.27ms。交換1回で数十回まわすと 25〜500ms かかり、
// 毎秒600回の交換判断を回す学習には2〜3桁足りない。
// **オフラインで測って表にし、実行時はただ引く**。

const CARD_KEEP_VALUE_RAW = {
  short: {
    big: { 'n2': 0.0212, 'n3': -0.0013, 'n4': -0.0024, 'n5': 0.0130, 'n6': -0.0143, 'n7': -0.0149, 'n8': -0.0125, 'n9': -0.0169, 'o+': 0.0276, 'o*': 0.0206, 'o^': -0.0123, 'o!': 0.0087, 'oP': -0.0177, 'o↑↑': 0.0215 },
    small: { 'n2': 0.0096, 'n3': -0.0086, 'n4': 0.0008, 'n5': 0.0024, 'n6': 0.0016, 'n7': -0.0149, 'n8': -0.0125, 'n9': -0.0169, 'o+': -0.0003, 'o*': -0.0007, 'o^': 0.0031, 'o!': -0.0029, 'oP': -0.0105, 'o↑↑': 0.0121 },
  },
  long: {
    big: { 'n2': 0.0097, 'n3': -0.0131, 'n4': -0.0089, 'n5': -0.0062, 'n6': -0.0207, 'n7': -0.0136, 'n8': -0.0100, 'n9': -0.0095, 'o+': 0.0093, 'o*': 0.0154, 'o^': 0.0509, 'o!': 0.0456, 'oP': -0.0003, 'o↑↑': 0.0136 },
    small: { 'n2': 0.0011, 'n3': -0.0120, 'n4': 0.0071, 'n5': -0.0000, 'n6': 0.0149, 'n7': -0.0136, 'n8': -0.0100, 'n9': -0.0095, 'o+': -0.0312, 'o*': -0.0222, 'o^': 0.0248, 'o!': 0.0267, 'oP': -0.0246, 'o↑↑': 0.0061 },
  },
};

/** 時間の区切り。これより短ければ「重い式は作れない」側の表を使う */
const KEEP_VALUE_SHORT_SEC = 150;
/** この値以上の数字を持っていれば「相方が居る」文脈 */
const KEEP_VALUE_BIG_DIGIT = 7;

function cardKeepKey(card) {
  return (card.type === 'number' ? 'n' : 'o') + card.value;
}

/**
 * その札を残す価値。大きいほど残すべき（＝捨てるのは小さい順）。
 *
 * @param {Array} [hand] 手札。渡すと文脈（7以上の数字を持っているか）を見る
 * @param {number} [seconds] 計算時間。渡すと短時間用の表に切り替える
 */
function cardStaticValue(card, hand, seconds) {
  const tb = (seconds != null && seconds < KEEP_VALUE_SHORT_SEC) ? 'short' : 'long';
  const big = hand
    ? hand.some(c => c.type === 'number' && Number(c.value) >= KEEP_VALUE_BIG_DIGIT)
    : true;
  const row = CARD_KEEP_VALUE_RAW[tb][big ? 'big' : 'small'];
  const v = row[cardKeepKey(card)];
  return v == null ? 0 : v;
}

/**
 * 今すぐ使う札に乗せる下駄（測定値と同じ単位）。
 *
 * **これだけは判断値。** 上の表は測ったものだが、これは測っていない。
 * 「今組んでいる式を壊すのは、余り札を1枚失うより痛い」という重みで、
 * 測定値の幅（±0.05）の中ほどに置いてある。
 *
 * 0 にすると今の式を平気で壊す。大きくしすぎると
 * 「使っていないが強い札（! など）」が絶対に残らなくなり、
 * 手を組み替える動きが消える。
 */
const USED_CARD_BONUS = 0.03;

/**
 * 捨てる順（先に捨てたい札から）。
 *
 * 以前は「使わない札を全部先に捨てる」という2段構えだった。
 * これだと **使っていないが強い札が必ず捨てられる**。
 * 実際 `!` や `↑↑` が余っていると無条件に切られていた。
 * 1つのスコアに畳んで、強い余り札が弱い使用札より残れるようにする。
 */
function discardOrder(hand, usedIds, seconds) {
  const score = (c) => cardStaticValue(c, hand, seconds)
    + (usedIds && usedIds.has(c.id) ? USED_CARD_BONUS : 0);
  return hand.slice().sort((a, b) => score(a) - score(b));
}

/**
 * 実際に捨てる札を決める。順序は discardOrder、枚数は呼び出し側が決める。
 *
 * **数字を最低1枚は残す。** 測定上どの数字も「替えが利く」ので、
 * 素直に順序どおり切ると演算子だけが手元に残ることがある（実際に起きた）。
 * 引き直しで数字が来る確率は高い（山札の 32/54 が数字）が、
 * 外すと式が1つも作れず自動的に失格になる。確率の問題ではなく
 * **ゲームのルール上の制約**なので、順序より優先して守る。
 */
function pickDiscards(hand, usedIds, seconds, k) {
  const order = discardOrder(hand, usedIds, seconds);
  const take = Math.max(0, Math.min(k, hand.length, 5));
  const discard = order.slice(0, take);

  const keptNumbers = hand.length - discard.length > 0
    ? hand.filter(c => c.type === 'number' && !discard.includes(c)).length
    : 0;
  if (keptNumbers === 0) {
    // 捨てる予定の中で一番「残す価値」が高い数字を呼び戻す
    const back = discard.filter(c => c.type === 'number').pop();
    if (back) discard.splice(discard.indexOf(back), 1);
  }
  return discard.map(c => c.id);
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
  decideBet, decideExchange, handStrength, evaluateBetSizes, resolveBetChoice,
  calcTimeForPot, expectedCalcTime, plannedCalcTime, beatsOneOpponent, callProbability,
  placePayouts, icmEquity, icmAfterDelta,
  OPPONENT_MODEL, BET_MODEL, BET_ACTIONS, cardsUsed, cardStaticValue, discardOrder, pickDiscards,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = AI;
}
if (typeof window !== 'undefined') {
  window.AI = AI;
  window.AIPlayer = AIPlayer;
}
