/**
 * ai-cognition.js — 「人間にとっての計算難易度」モデル
 *
 * ============================================================
 * 前提: 暗算ではなく「紙とペンでの手計算」
 * ============================================================
 * 人間のプレイヤーは紙に筆算を書いて答えを出す。CPU もそれに揃える。
 * この前提が効くところが4つある。
 *
 * 1. **見直せる**（最重要）
 *    暗算は一度間違えたら気づけないが、筆算は手が残るので検算できる。
 *    したがって *時間を積めば正答率は上がり続ける*。
 *    6^9 のような「手数は多いが原理的には難しくない」式は、
 *    5分あればほぼ確実に合い、30秒ならまず間に合わない。
 *    → accuracyUnderTime() の「見直し回数」を参照。
 *    ただし上がり方には限度がある。検算で見つかるのは *うっかりミス* で、
 *    手順の思い違いは何度なぞっても同じ答えになる（systematic）。
 *
 * 2. **遅い**
 *    暗算より圧倒的に時間がかかる。1296×1296 の筆算は部分積を4行書いて
 *    足すので、速い人でも30秒前後。コスト定数は筆算の実感に合わせてある。
 *
 * 3. **間違えにくい**
 *    中間結果が紙に残るので、1操作あたりのミス率は暗算より一桁低い。
 *    profile.slipRate は「筆算1操作（部分積1個 / 1桁の加算）あたり」の値。
 *
 * 4. **作業記憶の超過は主に時間を食う**
 *    中間結果は紙に外部化されるので、容量を超えても答えを失うのではなく、
 *    書いて読み直す往復が増える。よって WM 超過は
 *    WM_TIME_PENALTY（大）と WM_ACC_PENALTY（小）に非対称に効かせる。
 *
 * 定数は tools/calibrate-ai.js のアンカー表に対して合わせてある。
 * 定数をいじったら必ず `node tools/calibrate-ai.js` を通すこと。
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
 *    → profile.wmCapacity を 3.5〜8.0 チャンクで段階化した。
 *      素の暗算容量より上に取ってあるのは、紙が外部記憶として働くため。
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

  /** 筆算の加算: 基本コスト / 桁あたり / 桁上がり1回あたり（秒） */
  ADD_BASE: 0.60, ADD_PER_DIGIT: 0.45, ADD_PER_CARRY: 0.30,
  /** 桁上がりの発生率（一様乱数どうしの加算でおよそ 0.45） */
  CARRY_RATE: 0.45,

  /**
   * 筆算の乗算: 部分積1つあたり / 桁揃えと最終加算（秒）。
   * 暗算ではなく「書く」時間なので大きい。
   * 4桁×4桁 = 1.138×16 + 0.847×8 ≈ 25秒 が基準人（大学生）の目安。
   * 部分積4行×5桁＋合計8桁＝28文字を書くので、書字速度から見た下限とほぼ一致する。
   */
  MUL_PER_PARTIAL: 1.138, MUL_PER_DIGIT: 0.847,
  /**
   * 九九（1桁×1桁）は計算ではなく記憶からの検索。
   * 成人が「7×8」に答えるまで約1秒（Campbell & LeFevre 2001）。ここは実測値に近い。
   */
  MUL_TABLE: 0.80,

  /**
   * 数字を1文字書く時間（秒）。
   * 末尾の0を並べる、答えを清書する、といった「考えずに書くだけ」の作業に使う。
   * 文章の書き写しは 40文字/分 程度だが、筆算の数字列は語を読み解く必要がないぶん速い。
   */
  WRITE_PER_DIGIT: 0.415,

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

  /**
   * WM が容量を超えたときのペナルティ。
   * 紙があるので「答えを失う」のではなく「書いて読み直す往復が増える」。
   * よって時間には強く、正答率には弱く効かせる（暗算モデルとの最大の違いの1つ）。
   */
  WM_TIME_PENALTY: 0.55, WM_ACC_PENALTY: 0.10,

  /** 所要時間のばらつき（対数正規の σ）。人の作業時間はおおむね対数正規 */
  TIME_SIGMA: 0.35,
  /** 焦りが誤り率を増幅し始める余裕比 */
  RUSH_THRESHOLD: 1.40,
  RUSH_STRENGTH: 1.60,

  /**
   * 数式を決めて紙に書き始めるまでの段取り時間（秒）。
   * 一律にすると「短い式が全部同じ秒数」になって式の中身が見えなくなるので、
   * 使うカード枚数に比例する分を持たせる。
   */
  PLANNING_BASE: 3.76, PLANNING_PER_CARD: 1.44,

  // ---- 検算（手計算モデルの中核）----

  /** 見直し1回にかかる時間は、初回計算の何倍か（同じ手順をなぞるので速い） */
  RECHECK_FACTOR: 0.488,
  /** これ以上見直しても集中力が持たない */
  MAX_RECHECKS: 4,
  /**
   * 初回の誤りのうち「検算しても再現してしまう」割合。
   *
   * 検算で見つかるのは *うっかりミス*（桁を1つ書き落とした等）だけ。
   * 手順そのものを取り違えていたら、何度なぞっても同じ答えになる。
   * 難しい問題ほど後者の比率が上がるので、難易度スカラーの1次式で与える。
   */
  SYSTEMATIC_BASE: 0.22, SYSTEMATIC_SLOPE: 0.47,

  /**
   * 正答率の上下限。1（=100%正解）には決してしない。
   * 手計算では「9×8 を5分かけて検算する」が 0.999 に達しうるので、
   * 暗算前提の 0.98 では上が詰まる。
   */
  P_MAX: 0.999, P_MIN: 0.005,

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
//  wmCapacity     : 同時に保持できるチャンク数。紙に書けるぶん暗算より大きい
//  speed          : 基準人（大学生）を 1.0 とした筆算の速度。
//                   手を動かす速さなので、暗算ほど個人差が開かない
//  logDecimals    : log10 をどれだけの小数桁で覚えているか
//  factKnown      : n! を暗記している上限の n
//  chainExponent  : a^9=((a^2)^2)^2·a のような効率的なべき乗手順を使えるか
//  knowsStirling  : 巨大な階乗の桁数を見積もれるか
//  powerTable     : 暗記しているべき乗の範囲 { 2:2^nまで, 3:3^nまで, other:1桁の底は^nまで }
//  slipRate       : 筆算1操作（部分積1個 / 1桁の加算）あたりのミス率
//  checkRate      : 検算1回でうっかりミスに気づく確率  ← 手計算モデルの要
//  stressTolerance: 時間切迫下でも手順を崩さない度合い（0..1）
//  baseAccuracy   : 上限正答率（清書時の写し間違い等、検算でも取れない下限ノイズ）
//  aggression     : ベットの強気さ
//  bluffRate      : 弱いハンドでも仕掛ける頻度
//  riskAppetite   : 「大きいが当てにくい式」をどれだけ選びたがるか
//
// slipRate は「4桁×4桁の筆算1回を初回で間違える確率」から逆算してある。
// 部分積+最終加算で 20 操作なので slipRate = 1 − (1 − p4x4)^(1/20)。
//   中学生 30% / 高校生 18% / 大学生 10% / 競技者 6% / トップ 3.5%
//
// factKnown は「暗記している階乗」。ここを超える階乗は順に掛け算して求める。
// 大学生でも 5! = 120 までとしているのは、7! を
//   7×6=42, 5×4=20, 3×2=6 → 840 → ×6 = 5040
// のように *その場で作る* のが実態だから（記憶から引くなら一瞬で終わってしまう）。

const AI_PROFILES = {
  novice: {
    id: 'novice', name: '中学生', label: '初級',
    wmCapacity: 3.5, speed: 0.72, logDecimals: 1, factKnown: 3,
    chainExponent: false, knowsStirling: false, powerTable: { 2: 5, 3: 3, other: 2 },
    exactDigitCap: 12, slipRate: 0.01768, checkRate: 0.35, stressTolerance: 0.30,
    baseAccuracy: 0.988, aggression: 0.55, bluffRate: 0.05, riskAppetite: 0.25,
  },
  casual: {
    id: 'casual', name: '高校生', label: '中級',
    wmCapacity: 4.5, speed: 0.88, logDecimals: 2, factKnown: 4,
    chainExponent: false, knowsStirling: false, powerTable: { 2: 10, 3: 4, other: 2 },
    exactDigitCap: 18, slipRate: 0.00987, checkRate: 0.48, stressTolerance: 0.45,
    baseAccuracy: 0.994, aggression: 0.80, bluffRate: 0.10, riskAppetite: 0.40,
  },
  skilled: {
    id: 'skilled', name: '大学生（理系）', label: '上級',
    wmCapacity: 5.5, speed: 1.00, logDecimals: 3, factKnown: 5,
    chainExponent: true, knowsStirling: true, powerTable: { 2: 12, 3: 5, other: 3 },
    exactDigitCap: 26, slipRate: 0.00525, checkRate: 0.62, stressTolerance: 0.60,
    baseAccuracy: 0.9965, aggression: 1.00, bluffRate: 0.15, riskAppetite: 0.55,
  },
  expert: {
    id: 'expert', name: '競技者', label: '達人',
    wmCapacity: 6.5, speed: 1.30, logDecimals: 4, factKnown: 6,
    chainExponent: true, knowsStirling: true, powerTable: { 2: 16, 3: 7, other: 3 },
    exactDigitCap: 34, slipRate: 0.00309, checkRate: 0.74, stressTolerance: 0.78,
    baseAccuracy: 0.9985, aggression: 1.15, bluffRate: 0.20, riskAppetite: 0.70,
  },
  master: {
    id: 'master', name: 'トップ競技者', label: '超人',
    wmCapacity: 8.0, speed: 1.60, logDecimals: 5, factKnown: 8,
    chainExponent: true, knowsStirling: true, powerTable: { 2: 20, 3: 9, other: 4 },
    exactDigitCap: 44, slipRate: 0.00178, checkRate: 0.82, stressTolerance: 0.90,
    baseAccuracy: 0.9993, aggression: 1.30, bluffRate: 0.22, riskAppetite: 0.85,
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

/**
 * 末尾に並ぶ0の個数。
 *
 * 手計算では **末尾の0は計算せず、あとから書き足すだけ** で済む。
 *   1296 × 2000 → 1296 × 2 を筆算して 0 を3個足す
 *   30^7        → 3^7 = 2187 を求めて 0 を7個足す
 *   10^9        → 有効数字が 1 なので計算そのものが消え、0 を9個書くだけ
 * 最後のケースだけが「計算ではなく書き取り」になる。ここを取り違えると
 * 30^7 のような式が 10^7 と同じ値段になり、ゲームとして破綻する。
 */
function trailingZeros(digits, sig) {
  const s = Math.min(Math.max(1, sig), digits);
  return Math.max(0, digits - s);
}

/** 有効数字だけを取り出したときの桁数 */
function coreDigits(digits, sig) {
  return Math.min(Math.max(1, sig), digits);
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

/**
 * 既知のべき乗（計算せず検索で済む）か。
 * 覚えている範囲はレベルごとに違う。3^7 = 2187 まで即答できるのは競技者以上で、
 * 大学生なら 3^5 = 243 あたりで止まる、という切り分け。
 */
const DEFAULT_POWER_TABLE = { 2: 4, 3: 2, other: 2 };

function isKnownPower(base, exp, profile) {
  if (base === 1) return true;
  if (base === 10) return true;                 // 10^n は「1のあとに0」
  const t = profile.powerTable || DEFAULT_POWER_TABLE;
  if (base === 2) return exp <= t[2];
  if (base === 3) return exp <= t[3];
  if (base <= 9) return exp <= (t.other || 2);
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
  // 末尾の0は書き足すだけ。有効数字の部分だけを実際に筆算する。
  const m1 = coreDigits(d1, sig1), m2 = coreDigits(d2, sig2);
  const zeros = trailingZeros(d1, sig1) + trailingZeros(d2, sig2);
  const write = COG.WRITE_PER_DIGIT * zeros;

  if (m1 === 1 && m2 === 1) return COG.MUL_TABLE + write;      // 九九は検索
  return COG.MUL_PER_PARTIAL * m1 * m2 + COG.MUL_PER_DIGIT * (m1 + m2) + write;
}

function riskMul(d1, d2, sig1, sig2, profile) {
  const m1 = coreDigits(d1, sig1), m2 = coreDigits(d2, sig2);
  const zeros = trailingZeros(d1, sig1) + trailingZeros(d2, sig2);
  // 0の個数を数え違えるリスクは、本体の計算とは別に乗る
  const zeroRisk = zeros > 0 ? profile.slipRate * 0.3 : 0;

  const core = (m1 === 1 && m2 === 1)
    ? profile.slipRate * 0.5                                   // 九九の検索ミス
    // 部分積 m1*m2 個 + それらの加算（problem-size effect）
    : 1 - Math.pow(1 - profile.slipRate, m1 * m2 + Math.max(m1, m2));

  return 1 - (1 - clamp01(core)) * (1 - zeroRisk);
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

  if (exp === null || exp > 4096) {
    // 指数が巨大 → 厳密には不可能。時間を発散させて自然に選ばれなくする。
    return { time: COG.MAX_TIME, risk: 0.99, sigma: 0 };
  }
  if (exp === 0) return { time: COG.RECALL, risk: profile.slipRate * 0.2, sigma: 0 };
  if (exp === 1) return { time: 0.2, risk: 0, sigma: 0 };

  // ---- 底を「有効数字の部分 × 10^k」に分解する ----
  //
  //   a = m × 10^k  のとき  a^b = m^b × 10^(k·b)
  //
  // 末尾の 0 は k·b 個を書き足すだけで済む。実際に計算するのは m^b のほう。
  //   10^9 → m=1 なので計算が消え、0 を9個書くだけ  ← (4+6)^9 が易しい理由
  //   30^7 → m=3 なので 3^7 = 2187 を求めたうえで 0 を7個   ← ここを飛ばしてはいけない
  const trail = trailingZeros(baseDigits, baseSig);
  const zeroCount = Math.min(trail * exp, 100000);
  const zeroWrite = COG.WRITE_PER_DIGIT * Math.min(zeroCount, 400);
  const zeroRisk = trail > 0
    ? clamp01(profile.slipRate * 0.4 + 0.0015 * Math.min(zeroCount, 400))
    : 0;
  const withZeros = (t, risk) => ({
    time: Math.min(t + zeroWrite, COG.MAX_TIME),
    risk: 1 - (1 - clamp01(risk)) * (1 - zeroRisk),
    sigma: 0,
  });

  // m（有効数字の部分）。底が大きすぎて整数化できないときは log から扱う。
  const log10Core = l.value.getLog10() - trail;
  const core = (base !== null && trail > 0)
    ? Math.round(base / Math.pow(10, trail))
    : base;

  // m = 1 → 10 の冪。計算は無く、0 を並べる書き取りだけになる
  if (core === 1) return withZeros(COG.RECALL, 0);

  if (core !== null && isKnownPower(core, exp, profile)) {
    return withZeros(COG.RECALL * 1.5, profile.slipRate * 0.6);
  }

  const steps = powerExactSteps(log10Core, exp, profile);
  let time = 1.0, ok = 1;
  for (const [a, b] of steps) {
    const da = Math.min(a, 4000), db = Math.min(b, 4000);
    time += costMul(da, db, 9, 9, profile);
    ok *= (1 - riskMul(da, db, 9, 9, profile));
    if (time > COG.MAX_TIME) break;
  }
  const out = withZeros(time, 1 - ok);
  out.wmExtra = Math.min(2.0, 0.35 * steps.length);
  return out;
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

  // ---- 段取り時間 ----
  // 使うカードが多いほど「どう組むか」を決めるのに時間がかかる。
  // 一律にすると 9*8 も 7! も 8! も同じ秒数になって式の中身が見えなくなる。
  let cardCount = 2;
  try {
    cardCount = _FE.collectNumbers(ast).length + _FE.collectOperators(ast).length;
  } catch (e) { /* 数えられなければ既定値のまま */ }
  const planning = COG.PLANNING_BASE + COG.PLANNING_PER_CARD * cardCount;

  // ---- 答えの清書 ----
  // 求まった値を答案として書き出す時間。厳密モードでは全桁書く必要があるので、
  // 「どこまで大きい数を狙えるか」の実効的な上限は最終的にここで決まる。
  const answerDigits = answerMode === 'exact'
    ? Math.min(digitsOfValue(value), 4000) : 0;
  const transcribe = COG.WRITE_PER_DIGIT * (isFinite(answerDigits) ? answerDigits : 0);

  // ---- 演算子切替コスト（Monsell 2003）----
  const switches = root.switches;
  let time = root.time * (1 + 0.12 * switches) + planning + transcribe;
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

  // pBase は「一発勝負（見直しなし・時間制限なし）の正答率」。
  // 手計算モデルでは *天井ではない* — 検算で上がる余地があるので、
  // 最終的な正答率は accuracyUnderTime() が pBase より上に出ることがある。
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
 * 時間の効き方を3つに分解している。3つ目が手計算モデルの中核。
 *
 *   1. 間に合う確率  — 所要時間は対数正規に散らばる。P(T < 制限時間)。
 *   2. 焦り係数      — 間に合わせるために手順を省くぶん、
 *                      初回の誤り率が指数的に増幅される。
 *                      増幅の強さは stressTolerance で緩和される。
 *   3. **見直し**    — 余った時間で検算できる。紙に手が残っているから可能で、
 *                      暗算モデルには無かった経路。これがあるので
 *                      「時間さえあれば解ける式」がちゃんと解けるようになる。
 *
 * 見直しで消えるのは *うっかりミス* だけ。手順の思い違い（systematic）は
 * 何度なぞっても同じ答えに着地するので残る。難しい式ほどその比率が高い。
 *
 *   初回誤り     err1 = 1 − pSteps^α
 *   系統誤り     syst = err1 × (SYSTEMATIC_BASE + SYSTEMATIC_SLOPE × 難易度)
 *   見直し後     errN = syst + (err1 − syst) × (1 − checkRate)^見直し回数
 *
 * @param {object} analysis analyzeFormula の戻り
 * @param {number} timeAvailable 秒
 * @param {object} profile
 */
function accuracyUnderTime(analysis, timeAvailable, profile) {
  if (!analysis.ok) {
    return {
      pCorrect: 0, pFinish: 0, rush: 1, ratio: 0, alpha: 1,
      rechecks: 0, errFirst: 1, errAfter: 1, systematic: 1,
    };
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

  // 3) 見直し回数 — 初回を書き終えた残り時間を、検算1回ぶんの時間で割る
  const checkCost = req * COG.RECHECK_FACTOR;
  const rechecks = clamp(
    Math.floor((avail - req) / Math.max(checkCost, 1e-6)), 0, COG.MAX_RECHECKS);

  const errFirst = clamp01(1 - Math.pow(clamp01(analysis.pSteps), alpha));
  const systShare = clamp01(
    COG.SYSTEMATIC_BASE + COG.SYSTEMATIC_SLOPE * clamp01(analysis.difficulty));
  const systematic = errFirst * systShare;
  const errAfter = clamp01(
    systematic + (errFirst - systematic) * Math.pow(1 - profile.checkRate, rechecks));

  // pMode が 0（厳密モード以外 / 解けない式）なら、時間をいくら積んでも当たらない。
  // ただし pFinish は「答えを書き上げること自体はできる」ので別に返す
  // （提出はするが不正解、という挙動を作るため）。
  const pCorrect = (analysis.pMode <= 0 || analysis.blocked) ? 0 : clamp(
    profile.baseAccuracy * pFinish * (1 - errAfter) * analysis.pWm * analysis.pMode,
    COG.P_MIN, COG.P_MAX
  );

  return { pCorrect, pFinish, rush, ratio, alpha, rechecks, errFirst, errAfter, systematic };
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
