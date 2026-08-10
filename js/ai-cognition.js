/**
 * ai-cognition.js — 「人間にとっての計算難易度」モデル
 *
 * ============================================================
 * なぜ値の大きさで難易度を測ってはいけないか
 * ============================================================
 * (4+6)^9 は 6^9 より大きいが、人間にとっては圧倒的に易しい。
 *   (4+6)^9 : 4+6=10 は既知事実の検索 → 10^9 は「1のあとに0を9個」
 *             という *パターン* であり、計算ではなく書き取りになる。
 *   6^9     : 36 → 216 → 1296 → … と中間結果を作業記憶に載せたまま
 *             多桁×多桁の乗算を繰り返す必要がある。
 *
 * つまり難易度を決めるのは「最終値の大きさ」ではなく
 *   (a) 実行しなければならない基本演算の量と種類
 *   (b) その間に作業記憶へ載せ続ける中間結果の量
 *   (c) 答えとして要求される *形式*（厳密値 / 桁数 / 規模）
 * である。本モジュールはこの3つを AST から算出する。
 *
 * ============================================================
 * 依拠した知見
 * ============================================================
 * 1. 作業記憶容量: Miller(1956) 7±2、Cowan(2001) は「チャンク約4」。
 *    → profile.wmCapacity を 2.5〜6.5 チャンクで段階化した。
 * 2. レジスタ割り当て（Ershov 数 / Strahler 数）:
 *    式木を評価するのに必要な最小レジスタ数は、
 *      reg(葉)=1、reg(節)= 重い部分木を先に評価したときの最大同時保持数
 *    で与えられる。これは「人間が同時に覚えていなければならない中間結果の数」
 *    と構造的に同型なので、WM 負荷の骨格として採用した。
 *    各レジスタの重みは値の桁数由来のチャンク数（3桁区切り, Miller 的チャンク化）。
 * 3. 桁上がり（carry）コスト: Fürst & Hitch (2000),
 *    Imbo, Vandierendonck & De Rammelaere (2007)。
 *    桁上がりの回数と値が中央実行系を圧迫し、誤答率を押し上げる。
 *    → 加算コストに carry 項を明示的に持たせた。
 * 4. problem-size effect: 大きなオペランドほど遅く誤りやすい。
 *    → 乗算コストを桁数の積（部分積の個数）に比例させ、
 *      誤りも「部分積1つあたりの取りこぼし確率」から積み上げる。
 * 5. チャンク化 / 事実検索 (Chase & Simon 1973, Logan 1988):
 *    九九・小さい階乗・2のべき・10のべきは *計算されず検索される*。
 *    → 検索できるものはコストも誤り率も一桁下がる。profile ごとに知識量が違う。
 * 6. 課題切替コスト (Monsell 2003): 演算子が切り替わるたびに再設定コスト。
 *    → 切替回数で時間と誤り率に係数を掛ける。
 * 7. 速度‐正確性トレードオフ: Wickelgren(1977) の
 *      Acc = λ(1 − e^{−γ(T−δ)})
 *    に代表される「時間に対して漸近的に上がる正答率」。
 *    本モデルでは (a) 所要時間が対数正規分布に従うとして「間に合う確率」、
 *    (b) 間に合わせるために検算を省く「焦り係数」の2つに分解した。
 *    焦りの効き方は profile.stressTolerance で変わる（Beilock & Carr 2005 の
 *    "choking under pressure" に相当）。
 *
 * ============================================================
 * 答えの形式によって難易度が変わる（このゲーム固有の重要点）
 * ============================================================
 * engine.js の judgeDeclaration は、システム値の規模に応じて
 * 要求する答えを自動的に変える:
 *   exact  … 値そのもの      → 全桁を厳密に出す必要がある
 *   digits … 桁数            → log10 を絶対誤差 0.5 未満で出せばよい
 *   scale  … 10↑↑x 規模      → タワーの高さと先頭指数まで一致させる必要がある
 * これは人間にとって *まったく別の課題* なので、モデルも2つの流儀を持つ:
 *   厳密流儀 (exact regime): 実際に多桁演算を回す
 *   対数流儀 (log regime)  : log10 だけを追いかける（誤差が伝播する）
 * 対数流儀では絶対誤差 σ が伝播し、最後に |σ| < 0.5 を満たせるかで
 * 桁数を当てられるかが決まる。a^b では σ が b 倍に増える、というのが効く。
 */

/* global HugeNumber, FormulaParser, FormulaEvaluator */
const _cogEngine = (typeof require !== 'undefined' && typeof module !== 'undefined')
  ? require('./engine.js')
  : null;
const _HN = _cogEngine ? _cogEngine.HugeNumber : (typeof HugeNumber !== 'undefined' ? HugeNumber : null);
const _FP = _cogEngine ? _cogEngine.FormulaParser : (typeof FormulaParser !== 'undefined' ? FormulaParser : null);
const _FE = _cogEngine ? _cogEngine.FormulaEvaluator : (typeof FormulaEvaluator !== 'undefined' ? FormulaEvaluator : null);

// ============================================================
// チューニング定数（すべてここに集約する）
// ============================================================

const COG = {
  /** 人は数字を3桁ごとに束ねて覚える */
  CHUNK_DIGITS: 3,

  /** 単純加算: 基本コスト / 桁あたり / 桁上がり1回あたり（秒） */
  ADD_BASE: 0.40, ADD_PER_DIGIT: 0.30, ADD_PER_CARRY: 0.35,
  /** 桁上がりの発生率（一様乱数どうしの加算でおよそ 0.45） */
  CARRY_RATE: 0.45,

  /** 乗算: 部分積1つあたり / 桁揃えと最終加算（秒） */
  MUL_PER_PARTIAL: 0.75, MUL_PER_DIGIT: 0.50,
  /** 九九（1桁×1桁）は検索 */
  MUL_TABLE: 0.80,
  /** 有効数字1桁（10のべき等）を掛けるのは桁ずらしだけ */
  MUL_ROUND_BASE: 1.00, MUL_ROUND_PER_DIGIT: 0.25,

  /** 事実検索1回のコスト */
  RECALL: 0.80,
  /** 括弧・演算子の切替1回あたりの再設定コスト（Monsell 2003） */
  SWITCH_TIME: 1.20,
  /** 切替が誤り率へ与える増幅（設計指示の「×1.5」に相当する指数） */
  SWITCH_RISK_EXP: 0.25,

  /** 対数流儀の各操作コスト */
  LOG_ADD: 2.0, LOG_MUL: 2.5, LOG_POW_BASE: 1.5, LOG_STIRLING: 6.0,

  /** 桁数モードで許される log10 の絶対誤差（floor を当てるため） */
  DIGIT_TOLERANCE: 0.5,

  /** 演算子ごとの作業記憶スロット（設計指示の表をそのまま採用） */
  OP_WM: { '+': 2, '*': 2, '^': 3, '!': 2, 'P': 4, '↑↑': 4 },

  /** WM が容量を超えたときの時間・正答率へのペナルティ */
  WM_TIME_PENALTY: 0.45, WM_ACC_PENALTY: 0.40,

  /** 所要時間のばらつき（対数正規の σ）。人の作業時間はおおむね対数正規 */
  TIME_SIGMA: 0.35,
  /** 焦りが誤り率を増幅し始める余裕比 */
  RUSH_THRESHOLD: 1.40,
  RUSH_STRENGTH: 1.60,

  /** 数式を決めて計算に取りかかるまでの段取り時間（秒） */
  PLANNING_TIME: 6.0,

  /** 正答率の上下限。1（=100%正解）には決してしない */
  P_MAX: 0.98, P_MIN: 0.005,

  /**
   * 厳密(exact)以外のモードの正答率。
   *
   * digits（桁数申告）は log10 を絶対誤差 0.5 未満で出す必要があり、
   * scale（規模申告）に至ってはタワーの先頭指数まで double 一致が要る。
   * どちらも人間には当てられないので **0 に固定する**（設計者の指示）。
   *
   * 0 にすると、AIは「桁数モードに落ちる式」を最初から選ばなくなる。
   * つまり AI は *自分が全桁書き切れる範囲で最大の数* を狙う打ち方になる。
   * 1000桁までを厳密扱いする engine.js の境界（EXACT_MAX_DIGITS）は
   * 人間の限界よりはるかに上なので、実際の上限を決めるのは
   * 「全桁を書き出すコスト」のほうになる（powerExactStep 参照）。
   */
  NON_EXACT_ACCURACY: 0,

  /** 時間・コストの発散を防ぐクランプ */
  MAX_TIME: 1e7,
};

// ============================================================
// AIレベル（プロファイル）
// ============================================================
//
//  wmCapacity     : 同時に保持できるチャンク数（Cowan の 4 が標準的な大人）
//  speed          : 基準人を 1.0 とした処理速度
//  logDecimals    : log10 をどれだけの小数桁で覚えているか
//  factKnown      : n! を暗記している上限の n
//  chainExponent  : a^9=(a^3)^3 のような効率的なべき乗手順を使えるか
//  knowsStirling  : 巨大な階乗の桁数を見積もれるか
//  knowsPowerTable: 2^n, 3^n などのべき表を持っているか
//  slipRate       : 基本操作1回あたりのうっかりミス率
//  stressTolerance: 時間切迫下でも手順を崩さない度合い（0..1）
//  baseAccuracy   : 上限正答率（写し間違い等の下限ノイズ）
//  aggression     : ベットの強気さ
//  bluffRate      : 弱いハンドでも仕掛ける頻度
//  riskAppetite   : 「大きいが当てにくい式」をどれだけ選びたがるか

const AI_PROFILES = {
  novice: {
    id: 'novice', name: '見習い', label: '初級',
    wmCapacity: 2.5, speed: 0.70, logDecimals: 1, factKnown: 5,
    chainExponent: false, knowsStirling: false, knowsPowerTable: false,
    exactDigitCap: 6, slipRate: 0.030, stressTolerance: 0.30,
    baseAccuracy: 0.90, aggression: 0.55, bluffRate: 0.05, riskAppetite: 0.25,
  },
  casual: {
    id: 'casual', name: '常連', label: '中級',
    wmCapacity: 3.2, speed: 0.90, logDecimals: 2, factKnown: 6,
    chainExponent: false, knowsStirling: false, knowsPowerTable: true,
    exactDigitCap: 8, slipRate: 0.022, stressTolerance: 0.50,
    baseAccuracy: 0.94, aggression: 0.80, bluffRate: 0.10, riskAppetite: 0.40,
  },
  skilled: {
    id: 'skilled', name: '計算屋', label: '上級',
    wmCapacity: 4.0, speed: 1.15, logDecimals: 3, factKnown: 8,
    chainExponent: true, knowsStirling: true, knowsPowerTable: true,
    exactDigitCap: 12, slipRate: 0.015, stressTolerance: 0.70,
    baseAccuracy: 0.96, aggression: 1.00, bluffRate: 0.15, riskAppetite: 0.55,
  },
  expert: {
    id: 'expert', name: '暗算名人', label: '達人',
    wmCapacity: 5.0, speed: 1.50, logDecimals: 4, factKnown: 10,
    chainExponent: true, knowsStirling: true, knowsPowerTable: true,
    exactDigitCap: 16, slipRate: 0.010, stressTolerance: 0.85,
    baseAccuracy: 0.975, aggression: 1.15, bluffRate: 0.20, riskAppetite: 0.70,
  },
  master: {
    id: 'master', name: 'グランドマスター', label: '超人',
    wmCapacity: 6.5, speed: 2.00, logDecimals: 5, factKnown: 12,
    chainExponent: true, knowsStirling: true, knowsPowerTable: true,
    exactDigitCap: 20, slipRate: 0.006, stressTolerance: 0.95,
    baseAccuracy: 0.985, aggression: 1.30, bluffRate: 0.22, riskAppetite: 0.85,
  },
};

const AI_LEVEL_ORDER = ['novice', 'casual', 'skilled', 'expert', 'master'];

function getProfile(level) {
  return AI_PROFILES[level] || AI_PROFILES.casual;
}

// ============================================================
// テトレーションの許可パターン（設計指示 6）
// ============================================================
//
//   b↑↑2        （右辺が2なら左辺は何でも可 = b^b）
//   2↑↑3, 3↑↑3  （右辺が3のときは左辺が 2 または 3）
//   2↑↑4        （右辺が4のときは左辺が 2）
// これ以外は 100% 誤答扱いにする。ゲーム内の最大桁数を
// 人間の計算可能域に収めるための制限。

function isAllowedTetration(baseValue, heightValue) {
  const b = exactSmallInt(baseValue);
  const h = exactSmallInt(heightValue);
  if (h === null) return false;
  if (h <= 1) return true;                 // b↑↑1 = b（実質テトレーションではない）
  if (h === 2) return true;                // 右辺が2なら左辺は自由
  if (b === null) return false;
  if (h === 3) return b === 2 || b === 3;
  if (h === 4) return b === 2;
  return false;
}

/** HugeNumber が小さな厳密整数ならその値、そうでなければ null */
function exactSmallInt(v) {
  if (!v || v.kind !== 'exact') return null;
  if (v.v < 0n || v.v > 1000000000n) return null;
  return Number(v.v);
}

// ============================================================
// 値の性質
// ============================================================

/** 10進桁数（厳密に確定しなければ Infinity） */
function digitsOfValue(v) {
  if (!v) return Infinity;
  try {
    const d = v.digitCountHuge();
    if (d.kind === 'exact') {
      const n = Number(d.v);
      return Number.isFinite(n) ? n : Infinity;
    }
    const x = d.toNumber();
    return Number.isFinite(x) ? x : Infinity;
  } catch (e) { return Infinity; }
}

/** 有効数字の桁数（末尾の0を除いた長さ）。厳密でなければ大きい値 */
function significantDigits(v) {
  if (!v || v.kind !== 'exact') return 99;
  const s = (v.v < 0n ? -v.v : v.v).toString();
  const stripped = s.replace(/0+$/, '');
  return Math.max(1, stripped.length);
}

/** 10のべき（1のあとに0が並ぶ形）か */
function isPowerOfTen(v) {
  if (!v || v.kind !== 'exact' || v.v <= 0n) return false;
  const s = v.v.toString();
  return s[0] === '1' && /^1 *0*$/.test(s.replace(/0/g, '0'));
}

/**
 * 「キリの良い数」= 10^k, 2000, 300 のように *末尾に0が並ぶ* 数。
 *
 * 有効数字1桁というだけでは足りない。`6` も有効数字1桁だが、
 * 6^9 は 36→216→1296… と中間結果の連鎖が要る「難しい計算」であり、
 * 10^9 の「1のあとに0を9個」とは別物。
 * 桁ずらしの近道が効くのは **2桁以上で末尾が0** のときだけ。
 */
function isRoundValue(v) {
  return significantDigits(v) <= 1 && digitsOfValue(v) >= 2;
}

/** 桁ずらしの近道が使えるオペランドか */
function shiftable(digits, sig) {
  return sig <= 1 && digits >= 2;
}

/**
 * 値を作業記憶に載せたときのチャンク数。
 * 3桁区切りのチャンク化を基本に、キリの良い数は1チャンクへ潰す。
 */
function chunksOfValue(v) {
  if (!v) return 2;
  if (v.kind !== 'exact') return 2;        // 対数域では「仮数と指数」の2つ
  const sig = significantDigits(v);
  if (sig <= 1) return 1;                  // キリの良い数はチャンク化で潰れる
  let c = Math.ceil(sig / COG.CHUNK_DIGITS);
  if (sig >= 7) c += 1;                    // 長い数は順序の保持にも枠を食う
  return c;
}

/** 既知のべき乗（検索で済む）か */
function isKnownPower(base, exp, profile) {
  if (!profile.knowsPowerTable) return exp <= 2 && base <= 9;
  if (base === 10) return true;
  if (base === 2) return exp <= 16;
  if (base === 3) return exp <= 7;
  if (base <= 9) return exp <= 3;
  return exp <= 2 && base <= 30;
}

// ============================================================
// 基本演算のコストと誤り率
// ============================================================

function costAdd(d1, d2, profile) {
  const carries = COG.CARRY_RATE * Math.min(d1, d2);
  return COG.ADD_BASE + COG.ADD_PER_DIGIT * Math.max(d1, d2) + COG.ADD_PER_CARRY * carries;
}

function riskAdd(d1, d2, profile) {
  // 桁ごとに取りこぼす確率。桁上がりのある桁は2倍risky（Fürst & Hitch 2000）
  const plain = Math.max(d1, d2);
  const carries = COG.CARRY_RATE * Math.min(d1, d2);
  const events = plain + carries;
  return 1 - Math.pow(1 - profile.slipRate * 0.5, events);
}

function costMul(d1, d2, sig1, sig2, profile) {
  // どちらかが「末尾0の数」なら桁ずらしで済む
  if (shiftable(d1, sig1) || shiftable(d2, sig2)) {
    return COG.MUL_ROUND_BASE + COG.MUL_ROUND_PER_DIGIT * (d1 + d2);
  }
  if (d1 === 1 && d2 === 1) return COG.MUL_TABLE;              // 九九は検索
  return COG.MUL_PER_PARTIAL * d1 * d2 + COG.MUL_PER_DIGIT * (d1 + d2);
}

function riskMul(d1, d2, sig1, sig2, profile) {
  if (shiftable(d1, sig1) || shiftable(d2, sig2)) return profile.slipRate * 0.3; // 0の数え違い
  if (d1 === 1 && d2 === 1) return profile.slipRate * 0.5;     // 九九の検索ミス
  // 部分積 d1*d2 個 + それらの加算（problem-size effect）
  return 1 - Math.pow(1 - profile.slipRate, d1 * d2 + Math.max(d1, d2));
}

/**
 * a^exp を厳密に求める手順を組み立て、乗算の系列を返す。
 * chainExponent を持つプロファイルは a^9=(a^3)^3 のような
 * 加算連鎖（square & multiply）を使えるので手数が激減する。
 */
function powerExactSteps(log10Base, exp, profile) {
  const steps = [];
  const dg = (k) => Math.max(1, Math.floor(k * log10Base) + 1);

  if (profile.chainExponent) {
    const bits = exp.toString(2);
    let cur = 1;
    for (let i = 1; i < bits.length; i++) {
      steps.push([dg(cur), dg(cur)]);
      cur *= 2;
      if (bits[i] === '1') { steps.push([dg(cur), dg(1)]); cur += 1; }
      if (steps.length > 64) break;
    }
  } else {
    const n = Math.min(exp - 1, 64);
    for (let k = 1; k <= n; k++) steps.push([dg(k), dg(1)]);
  }
  return steps;
}

// ============================================================
// 正規分布（桁数モードの正答率に使う）
// ============================================================

function erf(x) {
  const s = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t
    - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
  return s * y;
}

function normCdf(z) { return 0.5 * (1 + erf(z / Math.SQRT2)); }

function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }
function clamp01(x) { return clamp(x, 0, 1); }
/** 0..∞ を 0..1 に潰す */
function saturate(x) { return x <= 0 ? 0 : x / (1 + x); }

// ============================================================
// AST の解析
// ============================================================

/**
 * ノード1つを解析する。子から親へ、以下を積み上げる。
 *   time   … その部分木を求めるまでの累積秒（基準人）
 *   ok     … その部分木を間違えない確率
 *   sigma  … log10 の絶対誤差（対数流儀のときのみ意味を持つ）
 *   wm     … Ershov 数（重み付き）= 必要な同時保持チャンク数のピーク
 *   blocked… 原理的に不可能（禁止テトレーション、Stirling 未修得など）
 */
function analyzeNode(node, profile, ctx, parentOp) {
  const opOverhead = (op) => ((COG.OP_WM[op] || 2) - 2) * 0.5;
  const isSwitch = (op) => (parentOp && op && parentOp !== op ? 1 : 0);

  switch (node.type) {
    case 'number': {
      const value = _HN.of(node.value);
      return {
        value, time: 0, ok: 1, sigma: 0, wm: 1, blocked: false,
        chunks: 1, regime: 'exact', switches: 0,
      };
    }

    case 'group':
      return analyzeNode(node.inner, profile, ctx, parentOp);

    case 'unary': {
      const child = analyzeNode(node.operand, profile, ctx, '!');
      return applyFactorial(child, profile, ctx, isSwitch('!'));
    }

    case 'binary': {
      const op = node.op;
      const l = analyzeNode(node.left, profile, ctx, op);
      const r = analyzeNode(node.right, profile, ctx, op);
      return applyBinary(op, l, r, profile, ctx, isSwitch(op) + l.switches + r.switches);
    }
  }
  throw new Error('未知のノード');
}

/** 二項演算のコスト・誤り・記憶負荷を合成する */
function applyBinary(op, l, r, profile, ctx, switches) {
  const value = evalBinary(op, l.value, r.value);
  const out = {
    value, blocked: l.blocked || r.blocked, switches,
    time: l.time + r.time, ok: l.ok * r.ok, sigma: 0,
    chunks: chunksOfValue(value), regime: 'exact',
  };

  // Ershov 数: 重い部分木を先に評価したときの同時保持チャンク数
  const wmA = Math.max(l.wm, l.chunks + r.wm);
  const wmB = Math.max(r.wm, r.chunks + l.wm);
  out.wm = Math.min(wmA, wmB) + ((COG.OP_WM[op] || 2) - 2) * 0.5;

  // ---- 禁止テトレーションはここで打ち切り ----
  if (op === '↑↑' && !isAllowedTetration(l.value, r.value)) {
    out.blocked = true;
    out.time += 30;
    out.ok = 0;
    return out;
  }

  const useLog = shouldUseLog(value, profile, ctx);
  out.regime = useLog ? 'log' : 'exact';

  const step = useLog
    ? binaryLogStep(op, l, r, profile)
    : binaryExactStep(op, l, r, profile, value);

  out.time += step.time;
  out.ok *= (1 - step.risk);
  out.sigma = step.sigma;
  // 1つの演算の *内部* で中間結果を鎖のようにつないでいく分の負荷。
  // 木構造だけを見る Ershov 数では拾えないが、6^9 のような
  // 「36→216→1296→…」の連鎖はまさにここで効く。
  out.wm += step.wmExtra || 0;
  if (step.blocked) out.blocked = true;
  return out;
}

function evalBinary(op, a, b) {
  switch (op) {
    case '+': return a.add(b);
    case '*': return a.multiply(b);
    case '^': return a.power(b);
    case 'P': return a.permutation(b);
    case '↑↑': return a.tetration(b);
  }
  throw new Error(`未知の演算子 ${op}`);
}

/**
 * このノードを対数流儀で扱うべきか。
 * 「厳密値を要求されていない」かつ「厳密に持てる桁数を超えた」ときだけ。
 */
function shouldUseLog(value, profile, ctx) {
  if (ctx.answerMode === 'exact') return false;
  return digitsOfValue(value) > profile.exactDigitCap;
}

// ---------- 厳密流儀 ----------

function binaryExactStep(op, l, r, profile, value) {
  const d1 = Math.min(digitsOfValue(l.value), 4000);
  const d2 = Math.min(digitsOfValue(r.value), 4000);
  const s1 = significantDigits(l.value);
  const s2 = significantDigits(r.value);

  switch (op) {
    case '+':
      return { time: costAdd(d1, d2, profile), risk: riskAdd(d1, d2, profile), sigma: 0 };

    case '*':
      return { time: costMul(d1, d2, s1, s2, profile), risk: riskMul(d1, d2, s1, s2, profile), sigma: 0 };

    case '^':
      return powerExactStep(l, r, profile, d1, s1);

    case 'P':
      return permutationExactStep(l, r, profile);

    case '↑↑':
      return tetrationExactStep(l, r, profile);
  }
  return { time: 5, risk: 0.1, sigma: 0 };
}

function powerExactStep(l, r, profile, baseDigits, baseSig) {
  const base = exactSmallInt(l.value);
  const exp = exactSmallInt(r.value);

  // 底が末尾0の数（10, 20, 100…）→ 結果は「1のあとに0をN個」。
  // これが (4+6)^9 が 6^9 より圧倒的に易しい理由。計算ではなく書き取りになる。
  if (shiftable(baseDigits, baseSig) && exp !== null) {
    const resultDigits = Math.min(digitsOfValue(l.value.power(r.value)), 100000);
    return {
      time: COG.RECALL + 0.15 * Math.min(resultDigits, 200),
      // 0の数を数え違えるリスクだけが残る
      risk: clamp01(profile.slipRate * 0.4 + 0.0015 * Math.min(resultDigits, 400)),
      sigma: 0,
    };
  }

  if (exp === null || exp > 4096) {
    // 指数が巨大 → 厳密には不可能。時間を発散させて自然に選ばれなくする。
    return { time: COG.MAX_TIME, risk: 0.99, sigma: 0 };
  }
  if (exp === 0) return { time: COG.RECALL, risk: profile.slipRate * 0.2, sigma: 0 };
  if (exp === 1) return { time: 0.2, risk: 0, sigma: 0 };

  if (base !== null && isKnownPower(base, exp, profile)) {
    return { time: COG.RECALL * 1.5, risk: profile.slipRate * 0.6, sigma: 0 };
  }

  const log10Base = l.value.getLog10();
  const steps = powerExactSteps(log10Base, exp, profile);
  let time = 1.0, ok = 1;
  for (const [a, b] of steps) {
    const da = Math.min(a, 4000), db = Math.min(b, 4000);
    time += costMul(da, db, 9, 9, profile);
    ok *= (1 - riskMul(da, db, 9, 9, profile));
    if (time > COG.MAX_TIME) break;
  }
  return {
    time: Math.min(time, COG.MAX_TIME), risk: 1 - ok, sigma: 0,
    wmExtra: Math.min(2.0, 0.35 * steps.length),
  };
}

function permutationExactStep(l, r, profile) {
  const n = exactSmallInt(l.value);
  const rr = exactSmallInt(r.value);
  if (n === null || rr === null || rr > 64) {
    return { time: COG.MAX_TIME, risk: 0.99, sigma: 0 };
  }
  // nPr = n(n-1)...(n-r+1)。r-1 回の乗算 + 「どこまで掛けたか」の管理
  let time = 2.0, ok = 1;
  let curDigits = String(n).length;
  const termDigits = String(Math.max(1, n)).length;
  for (let i = 1; i < rr; i++) {
    time += costMul(curDigits, termDigits, 9, 9, profile);
    ok *= (1 - riskMul(curDigits, termDigits, 9, 9, profile));
    curDigits += termDigits;
    if (time > COG.MAX_TIME) break;
  }
  // 「何回目か」を数え続ける負荷（設計指示で P のスロット数が4なのはこのため）
  ok *= (1 - profile.slipRate * rr * 0.4);
  return {
    time: Math.min(time, COG.MAX_TIME), risk: 1 - clamp01(ok), sigma: 0,
    wmExtra: Math.min(2.0, 0.3 * rr),
  };
}

function tetrationExactStep(l, r, profile) {
  const b = exactSmallInt(l.value);
  const h = exactSmallInt(r.value);
  // ここに来るのは許可パターンのみ
  if (h === null || h <= 1) return { time: 0.5, risk: 0, sigma: 0 };

  const conceptCost = 3.0;   // 「↑↑ とは何か」を思い出して展開するコスト
  if (h === 2) {
    // b↑↑2 = b^b
    const st = powerExactStep(l, { value: _HN.of(b) }, profile,
      digitsOfValue(l.value), significantDigits(l.value));
    return { time: st.time + conceptCost, risk: st.risk, sigma: 0, wmExtra: st.wmExtra };
  }
  if (b === 2 && h === 3) return { time: conceptCost + 1.0, risk: profile.slipRate, sigma: 0 };   // 16
  if (b === 2 && h === 4) return { time: conceptCost + 2.0, risk: profile.slipRate, sigma: 0 };   // 65536
  if (b === 3 && h === 3) {
    // 3^27 = 7625597484987 —（3^3)^9 か 3^27 の直接計算
    const st = powerExactStep({ value: _HN.of(3) }, { value: _HN.of(27) }, profile, 1, 1);
    return { time: st.time + conceptCost, risk: st.risk, sigma: 0, wmExtra: st.wmExtra };
  }
  return { time: COG.MAX_TIME, risk: 0.99, sigma: 0 };
}

function applyFactorial(child, profile, ctx, isSwitch) {
  const value = child.value.factorial();
  const out = {
    value, blocked: child.blocked, switches: child.switches + isSwitch,
    time: child.time, ok: child.ok, sigma: 0,
    chunks: chunksOfValue(value), regime: 'exact',
    wm: Math.max(child.wm, child.chunks + 0.5),
  };

  const useLog = shouldUseLog(value, profile, ctx);
  out.regime = useLog ? 'log' : 'exact';

  const n = exactSmallInt(child.value);

  if (!useLog) {
    if (n === null || n > 40) {
      out.time += COG.MAX_TIME; out.ok = 0; return out;
    }
    if (n <= profile.factKnown) {
      out.time += COG.RECALL; out.ok *= (1 - profile.slipRate * 0.5); return out;
    }
    // factKnown からの続き: (factKnown+1) 〜 n を順に掛ける
    let t = 1.0, ok = 1;
    let curDigits = String(factorialApprox(profile.factKnown)).length;
    for (let i = profile.factKnown + 1; i <= n; i++) {
      const td = String(i).length;
      t += costMul(curDigits, td, 9, 9, profile);
      ok *= (1 - riskMul(curDigits, td, 9, 9, profile));
      curDigits += td;
      if (t > COG.MAX_TIME) break;
    }
    out.time += Math.min(t, COG.MAX_TIME);
    out.ok *= ok;
    // 「いま何を掛けているか」を数えながら積を伸ばしていく分の記憶負荷
    out.wm += Math.min(2.0, 0.3 * Math.max(0, n - profile.factKnown));
    return out;
  }

  // ---- 対数流儀: Stirling の近似で log10(n!) を出す ----
  if (!profile.knowsStirling) { out.blocked = true; out.ok = 0; out.time += 10; return out; }

  const nApprox = child.value.toNumber();
  if (!isFinite(nApprox) || nApprox <= 1) {
    out.time += COG.LOG_STIRLING; out.sigma = child.sigma; return out;
  }
  const log10n = Math.log10(nApprox);
  // log10(n!) ≈ n(log10 n − log10 e)。n の log を k 桁までしか知らなければ
  // 誤差はそのまま n 倍される。ここが「巨大な階乗の桁数は当てられない」理由。
  const unitSigma = 0.5 * Math.pow(10, -profile.logDecimals);
  const sigmaFromLog = nApprox * (childLogSigma(child, profile) + unitSigma);
  out.time += COG.LOG_STIRLING + costMul(Math.min(String(Math.round(nApprox)).length, 12),
    profile.logDecimals + 1, 9, 9, profile);
  out.ok *= (1 - profile.slipRate * 2);
  out.sigma = isFinite(sigmaFromLog) ? sigmaFromLog : Infinity;
  return out;
}

function factorialApprox(n) {
  let r = 1;
  for (let i = 2; i <= n; i++) r *= i;
  return r;
}

/** 子ノードの log10 を人がどれだけ正確に言えるか */
function childLogSigma(child, profile) {
  if (child.sigma > 0) return child.sigma;
  if (!child.value || child.value.kind !== 'exact') return 0;
  if (isRoundValue(child.value)) return 0;                 // 10^k は誤差ゼロ
  const unit = Math.pow(10, -profile.logDecimals);
  const d = digitsOfValue(child.value);
  if (d <= 1) return 0.5 * unit;                           // log10(2..9) は表で覚えている
  return 1.5 * unit;                                       // 仮数から推定するぶん粗い
}

// ---------- 対数流儀 ----------

function binaryLogStep(op, l, r, profile) {
  const sl = childLogSigma(l, profile);
  const sr = childLogSigma(r, profile);
  const unit = 0.5 * Math.pow(10, -profile.logDecimals);

  switch (op) {
    case '+':
      // 大きい方に吸収される。「吸収されること」に気づけるかがリスク
      return { time: COG.LOG_ADD, risk: profile.slipRate * 2, sigma: Math.max(sl, sr) };

    case '*':
      return { time: COG.LOG_MUL, risk: profile.slipRate, sigma: sl + sr + unit };

    case '^': {
      // log10(a^b) = b·log10(a)。誤差は b 倍される。
      const b = r.value && r.value.kind === 'exact' ? Number(r.value.v) : r.value.toNumber();
      if (!isFinite(b)) return { time: COG.LOG_MUL, risk: 0.5, sigma: Infinity };
      const digitsB = Math.min(String(Math.round(Math.abs(b))).length, 15);
      return {
        time: COG.LOG_POW_BASE + costMul(profile.logDecimals + 1, digitsB, 9, 9, profile),
        risk: profile.slipRate * 1.5,
        sigma: Math.abs(b) * (sl + unit) + sr,
      };
    }

    case 'P': {
      if (!profile.knowsStirling) return { time: 10, risk: 1, sigma: Infinity, blocked: true };
      const rr = r.value.toNumber();
      const la = l.value.getLog10();
      if (!isFinite(rr) || !isFinite(la)) return { time: 15, risk: 0.6, sigma: Infinity };
      return {
        time: COG.LOG_STIRLING + COG.LOG_MUL,
        risk: profile.slipRate * 3,
        sigma: Math.abs(rr) * (sl + unit) + sr * Math.abs(la),
      };
    }

    case '↑↑':
      // 許可パターンのみ到達。b↑↑2 の対数 = b·log10(b)
      return {
        time: COG.LOG_POW_BASE + COG.LOG_MUL + 3.0,
        risk: profile.slipRate * 2,
        sigma: Math.abs(l.value.toNumber() || 1) * (sl + unit),
      };
  }
  return { time: 5, risk: 0.2, sigma: Infinity };
}

// ============================================================
// 公開API: 数式1本の解析
// ============================================================

const _analysisCache = new Map();
const ANALYSIS_CACHE_MAX = 20000;

/**
 * 数式の「時間に依存しない」難易度を解析する。
 *
 * @param {string|object} formulaOrAst 数式文字列 または {ast, value}
 * @param {object} profile AI_PROFILES の1つ
 * @returns {{
 *   ok:boolean, value:HugeNumber, answerMode:'exact'|'digits'|'scale',
 *   requiredTime:number, wmPeak:number, wmOverload:number,
 *   pBase:number, difficulty:number, blocked:boolean, sigma:number, notes:string[]
 * }}
 */
function analyzeFormula(formula, profile) {
  const key = `${typeof formula === 'string' ? formula : formula.formula}|${profile.id}`;
  const cached = _analysisCache.get(key);
  if (cached) return cached;

  const result = _analyzeFormulaUncached(formula, profile);
  if (_analysisCache.size > ANALYSIS_CACHE_MAX) _analysisCache.clear();
  _analysisCache.set(key, result);
  return result;
}

function _analyzeFormulaUncached(formula, profile) {
  const src = typeof formula === 'string' ? formula : formula.formula;
  let ast, value;

  try {
    if (typeof formula === 'object' && formula.ast && formula.value) {
      ast = formula.ast; value = formula.value;
    } else {
      const ev = _FE.evaluate(src);
      if (!ev.ok) return failed(src, ev.error);
      ast = ev.ast; value = ev.value;
    }
  } catch (e) { return failed(src, e.message); }

  const answerMode = _FE.declarationMode(value);
  const ctx = { answerMode };

  let root;
  try {
    root = analyzeNode(ast, profile, ctx, null);
  } catch (e) { return failed(src, e.message); }

  const notes = [];

  // ---- 演算子切替コスト（Monsell 2003）----
  const switches = root.switches;
  let time = root.time * (1 + 0.12 * switches) + COG.PLANNING_TIME;
  time = time / profile.speed;
  time = Math.min(time, COG.MAX_TIME);
  if (switches > 0) notes.push(`演算子の切替 ${switches} 回`);

  // ---- 作業記憶の超過 ----
  const wmPeak = root.wm;
  const wmOverload = Math.max(0, wmPeak - profile.wmCapacity);
  if (wmOverload > 0) {
    time *= (1 + COG.WM_TIME_PENALTY * wmOverload);
    notes.push(`作業記憶が ${wmOverload.toFixed(1)} チャンク超過`);
  }
  const pWm = Math.exp(-COG.WM_ACC_PENALTY * wmOverload);

  // ---- 手続き上のうっかりミス ----
  let pSteps = clamp01(root.ok);
  // 切替は誤り率も押し上げる（設計指示の「×1.5」に相当）
  if (switches > 0) pSteps = Math.pow(pSteps, 1 + COG.SWITCH_RISK_EXP * switches);

  // ---- 答えの形式に由来する正答率 ----
  //
  // 厳密モード以外は 0%（COG.NON_EXACT_ACCURACY）。
  // log10 の誤差 σ は診断用に残しておく（notes に出す）。
  let pMode = 1;
  if (root.blocked) {
    pMode = 0;
    notes.push('原理的に解けない（禁止テトレーション / 未修得の手法）');
  } else if (answerMode !== 'exact') {
    pMode = COG.NON_EXACT_ACCURACY;
    const sigma = root.sigma;
    const sigmaNote = !(sigma > 0) ? '誤差なし'
      : !isFinite(sigma) ? '絞り込み不能'
        : `±${sigma.toPrecision(3)}`;
    notes.push(answerMode === 'digits'
      ? `桁数申告が必要（log10 の誤差 ${sigmaNote}）— 正答率 ${(pMode * 100).toFixed(0)}%`
      : `規模(10↑↑x)申告が必要 — 正答率 ${(pMode * 100).toFixed(0)}%`);
  }

  const pBase = clamp(profile.baseAccuracy * pSteps * pWm * pMode, 0, COG.P_MAX);

  // ---- 難易度スカラー（誤答時の誤差分布に使う）----
  const difficulty = clamp01(
    0.45 * (1 - pBase) +
    0.35 * saturate(time / 60) +
    0.20 * saturate(wmOverload / 3)
  );

  const out = {
    ok: true, formula: src, value, answerMode,
    requiredTime: time, wmPeak, wmOverload,
    pSteps, pWm, pMode, pBase, difficulty,
    blocked: root.blocked, sigma: root.sigma, switches, notes,
  };
  return out;
}

function failed(src, error) {
  return {
    ok: false, formula: src, value: null, answerMode: 'exact', error,
    requiredTime: COG.MAX_TIME, wmPeak: 99, wmOverload: 99,
    pSteps: 0, pWm: 0, pMode: 0, pBase: 0, difficulty: 1,
    blocked: true, sigma: Infinity, switches: 0, notes: ['数式として無効'],
  };
}

// ============================================================
// 公開API: 時間プレッシャーを織り込んだ正答率
// ============================================================

/**
 * 制限時間を与えて最終的な正答率を出す。
 *
 * 時間の効き方を2つに分解している:
 *   1. 間に合う確率  — 所要時間は対数正規に散らばる。P(T < 制限時間)。
 *   2. 焦り係数      — 間に合わせるために検算を飛ばすぶん、
 *                      手続きの誤り率が指数的に増幅される。
 *                      増幅の強さは stressTolerance で緩和される。
 *
 * @param {object} analysis analyzeFormula の戻り
 * @param {number} timeAvailable 秒
 * @param {object} profile
 */
function accuracyUnderTime(analysis, timeAvailable, profile) {
  if (!analysis.ok) {
    return { pCorrect: 0, pFinish: 0, rush: 1, ratio: 0, alpha: 1 };
  }

  const req = Math.max(0.5, analysis.requiredTime);
  const avail = Math.max(1, timeAvailable);
  const ratio = avail / req;

  // 1) 間に合う確率（所要時間が対数正規）
  const pFinish = ratio >= 20 ? 1
    : clamp01(normCdf(Math.log(ratio) / COG.TIME_SIGMA));

  // 2) 焦りによる誤り率の増幅
  const rush = clamp01(1 - ratio / COG.RUSH_THRESHOLD);
  const alpha = 1 + COG.RUSH_STRENGTH * rush * (2 - profile.stressTolerance);

  const pSteps = Math.pow(clamp01(analysis.pSteps), alpha);

  // pMode が 0（厳密モード以外 / 解けない式）なら、時間をいくら積んでも当たらない。
  // ただし pFinish は「答えを書き上げること自体はできる」ので別に返す
  // （提出はするが不正解、という挙動を作るため）。
  const pCorrect = (analysis.pMode <= 0 || analysis.blocked) ? 0 : clamp(
    profile.baseAccuracy * pFinish * pSteps * analysis.pWm * analysis.pMode,
    COG.P_MIN, COG.P_MAX
  );

  return { pCorrect, pFinish, rush, ratio, alpha };
}

/**
 * 難易度と時間から「誤答したときの誤差の大きさ」を選ぶ。
 *
 * 設計指示 5 のとおり、難しい問題ほど盛大に外す。
 * 段階は5つで、重みは難易度 d の多項式で与える:
 *   slip   : 1桁だけ書き間違える / 桁数±1     （易しい問題の典型的なミス）
 *   small  : 数%〜十数%のずれ / 桁数±2〜5
 *   medium : 2〜10倍のずれ / 桁数±10%
 *   large  : 10^1〜10^3 のずれ
 *   huge   : 桁が丸ごと違う（±100000% 以上）
 */
function errorTierWeights(difficulty) {
  const d = clamp01(difficulty);
  return [
    ['slip', Math.pow(1 - d, 2) * 1.2 + 0.05],
    ['small', 2 * d * (1 - d) * 0.9 + 0.05],
    ['medium', d * 0.60],
    ['large', d * d * 0.55],
    ['huge', Math.pow(d, 3) * 0.45],
  ];
}

function pickErrorTier(difficulty, rng) {
  const tiers = errorTierWeights(difficulty);
  const total = tiers.reduce((s, t) => s + t[1], 0);
  let x = rng() * total;
  for (const [name, w] of tiers) { if ((x -= w) <= 0) return name; }
  return 'slip';
}

// ============================================================
// エクスポート
// ============================================================

/**
 * 解析キャッシュを捨てる。
 * COG の定数を実行中に書き換えたときは、これを呼ばないと変更が反映されない
 * （キャッシュキーが `式|レベル` で、定数の値を含んでいないため）。
 * ai-lab.html のチューニングパネルが使う。
 */
function clearAnalysisCache() {
  _analysisCache.clear();
}

const AICognition = {
  COG, AI_PROFILES, AI_LEVEL_ORDER, getProfile,
  analyzeFormula, accuracyUnderTime, clearAnalysisCache,
  errorTierWeights, pickErrorTier,
  isAllowedTetration, digitsOfValue, significantDigits, isRoundValue,
  chunksOfValue, exactSmallInt, normCdf, clamp, clamp01,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = AICognition;
}
if (typeof window !== 'undefined') {
  window.AICognition = AICognition;
  window.AI_PROFILES = AI_PROFILES;
}
