/**
 * engine.js - 巨大数計算エンジン
 *
 * ============================================================
 * 計算範囲の方針（どこまで厳密に計算するか）
 * ============================================================
 * 値を3つの層で保持し、層ごとに「何が保証されるか」を変える。
 *
 *   [E] 厳密層 (kind='exact')  : BigInt。10進 EXACT_MAX_DIGITS 桁以下。
 *                                値そのものが完全に正しい。比較も完全。
 *   [R] 実数層 (kind='real')   : double。絶対値 TOWER_MIN 未満。
 *                                主に対数値など非整数の中間値に使う。
 *   [T] タワー層 (kind='tower'): 値 = 10^(10^(…^top))（10 が height 個）。
 *                                top ∈ [1,10)。height 自体も HugeNumber な
 *                                ので、高さが巨大な場合（ペンテーション級）
 *                                にも再帰的に対応する。
 *
 * 比較は「高さ → 先頭指数」の辞書順で行うため、10^(10^100) と 10↑↑10 の
 * ような直接計算不能な値どうしでも常に順序を決められる。
 *
 * 精度の限界（意図的な仕様）:
 *   - タワー層の先頭指数 top は double なので有効数字は約15桁。
 *   - そのため高さ4以上の領域では、1段下の演算（+, ×, ! など）は値を変えない。
 *     例: 9↑↑9 と 9↑↑9+2 は同一の値として扱われ、ショーダウンでは同値＝山分け。
 *   - これは有限精度である以上避けられないため、「差が精度限界未満なら同値」を
 *     ゲームルールとして採用する（仕様の「同値なら山分け」と整合）。
 */

// ============================================================
// 計算範囲の定数
// ============================================================

const HUGE_LIMITS = {
  /** BigInt で厳密保持する最大桁数 */
  EXACT_MAX_DIGITS: 1000,
  /** これ以上の値はタワー表現に切り替える */
  TOWER_MIN: 1e15,
  /** 階乗を厳密ループで回す n の上限 */
  FACTORIAL_LOOP_MAX: 100000,
  /** 順列を厳密ループで回す r の上限 */
  PERMUTATION_LOOP_MAX: 200000,
  /** べき乗を厳密計算する指数の上限 */
  POWER_EXACT_MAX_EXP: 1000000,
  /** テトレーションを実際に反復する高さの上限（これを超えたら高さ加算で近似） */
  TETRATION_ITER_MAX: 16,
  /** 数式のASTノード数上限（暴走防止） */
  MAX_AST_NODES: 200,
};

const LOG10_E = Math.LOG10E; // 0.4342944819032518

// ============================================================
// BigInt ユーティリティ
// ============================================================

/** BigInt の10進桁数 */
function bigIntDigits(b) {
  if (b < 0n) b = -b;
  if (b === 0n) return 1;
  return b.toString().length;
}

/** BigInt の log10（b > 0 前提、double で返す） */
function bigIntLog10(b) {
  const s = b.toString();
  const head = s.slice(0, 18);
  return (s.length - head.length) + Math.log10(Number(head));
}

// ============================================================
// HugeNumber
// ============================================================

class HugeNumber {
  /**
   * 直接呼ばず、of() / fromNumber() / _mkTower() を使うこと。
   * @param {string} kind 'exact' | 'real' | 'tower' | 'inf'
   */
  constructor(kind, a, b) {
    this.kind = kind;
    if (kind === 'tower') {
      this.height = a; // number | HugeNumber （1以上の整数）
      this.top = b;    // number ∈ [1,10)
    } else {
      this.v = a;      // BigInt | number
    }
  }

  // ---------- ファクトリ ----------

  /** 整数（BigInt / number）から生成 */
  static of(n) {
    const b = typeof n === 'bigint' ? n : BigInt(Math.trunc(n));
    if (bigIntDigits(b) <= HUGE_LIMITS.EXACT_MAX_DIGITS) {
      return new HugeNumber('exact', b);
    }
    // 桁数超過 → 対数表現へ
    return HugeNumber.pow10(HugeNumber.fromNumber(bigIntLog10(b)));
  }

  /** double から生成 */
  static fromNumber(x) {
    if (typeof x === 'bigint') return HugeNumber.of(x);
    if (Number.isNaN(x)) return HugeNumber.INF();
    if (x === Infinity) return HugeNumber.INF();
    if (x === -Infinity) return new HugeNumber('real', -Infinity);
    if (Number.isInteger(x) && Math.abs(x) < 1e15) {
      return new HugeNumber('exact', BigInt(x));
    }
    if (Math.abs(x) < HUGE_LIMITS.TOWER_MIN) {
      return new HugeNumber('real', x);
    }
    return HugeNumber._mkTower(0, x);
  }

  static INF() {
    return new HugeNumber('inf', Infinity);
  }

  static get ZERO() { return new HugeNumber('exact', 0n); }
  static get ONE() { return new HugeNumber('exact', 1n); }

  /** 旧APIの互換 */
  static fromInt(n) { return HugeNumber.of(n); }
  static fromBigInt(b) { return HugeNumber.of(b); }

  /**
   * タワーを構築して正規化する。値 = E^height(top)、E(x)=10^x
   * @param {number|HugeNumber} h 高さ
   * @param {number} t 先頭の値
   */
  static _mkTower(h, t) {
    if (!isFinite(t)) return t > 0 ? HugeNumber.INF() : HugeNumber.ZERO;

    const hn = HugeNumber._heightAsNumber(h);
    if (hn === null) {
      // 高さが巨大（ペンテーション級）。top の正規化のみ行う。
      while (t >= 10) t = Math.log10(t);
      while (t < 1) t = Math.pow(10, t);
      return new HugeNumber('tower', h, t);
    }

    let height = hn;
    while (t >= 10) { t = Math.log10(t); height++; }
    while (t < 1 && height > 0) { t = Math.pow(10, t); height--; }

    // 小さい値はタワーを使わず降格する（tower は常に TOWER_MIN 以上、という不変条件）
    if (height <= 0) return HugeNumber.fromNumber(t);
    if (height === 1) return HugeNumber.fromNumber(Math.pow(10, t));
    if (height === 2 && Math.pow(10, t) < Math.log10(HUGE_LIMITS.TOWER_MIN)) {
      return HugeNumber.fromNumber(Math.pow(10, Math.pow(10, t)));
    }
    return new HugeNumber('tower', height, t);
  }

  /** 高さを number として取得（巨大すぎる場合は null） */
  static _heightAsNumber(h) {
    if (typeof h === 'number') return h;
    if (h instanceof HugeNumber) {
      if (h.kind === 'exact' && h.v >= 0n && h.v <= 1000000000n) return Number(h.v);
      if (h.kind === 'real' && h.v >= 0 && h.v < 1e9) return h.v;
    }
    return null;
  }

  /** 高さに小整数を加算 */
  static _heightAdd(h, k) {
    if (typeof h === 'number') return h + k;
    if (h instanceof HugeNumber && h.kind === 'exact') {
      const nv = h.v + BigInt(k);
      return HugeNumber.of(nv < 0n ? 0n : nv);
    }
    // 巨大な高さに ±小整数は無視できる
    return h;
  }

  /** 高さどうしの比較 */
  static _compareHeights(a, b) {
    const an = HugeNumber._heightAsNumber(a);
    const bn = HugeNumber._heightAsNumber(b);
    if (an !== null && bn !== null) return an > bn ? 1 : an < bn ? -1 : 0;
    if (an !== null) return -1; // b が巨大
    if (bn !== null) return 1;  // a が巨大
    return a.compare(b);
  }

  // ---------- 基本情報 ----------

  isExactValue() { return this.kind === 'exact'; }
  isInfinite() { return this.kind === 'inf'; }

  /** 符号 (-1 / 0 / 1) */
  sign() {
    if (this.kind === 'inf') return 1;
    if (this.kind === 'tower') return 1;
    if (this.kind === 'exact') return this.v > 0n ? 1 : this.v < 0n ? -1 : 0;
    return this.v > 0 ? 1 : this.v < 0 ? -1 : 0;
  }

  isZero() { return this.sign() === 0; }

  /** double 化（表現できなければ ±Infinity） */
  toNumber() {
    if (this.kind === 'inf') return Infinity;
    if (this.kind === 'tower') return Infinity;
    if (this.kind === 'exact') return Number(this.v);
    return this.v;
  }

  /**
   * タワー分解。値 = E^h(t) となる (h, t) を返す。
   * 正の値に対してのみ有効。
   */
  _towerParts() {
    if (this.kind === 'tower') return { h: this.height, t: this.top };
    if (this.kind === 'inf') return { h: Infinity, t: 1 };
    if (this.kind === 'exact') {
      const x = Number(this.v);
      if (isFinite(x) && Math.abs(x) < 1e15) return HugeNumber._partsOfDouble(x);
      // 巨大な BigInt: 値 = 10^(log10値) なので高さを1段増やす
      const p = HugeNumber._partsOfDouble(bigIntLog10(this.v));
      return { h: p.h + 1, t: p.t };
    }
    return HugeNumber._partsOfDouble(this.v);
  }

  static _partsOfDouble(x) {
    let h = 0, t = x;
    while (t >= 10) { t = Math.log10(t); h++; }
    return { h, t };
  }

  // ---------- 対数 / 指数 ----------

  /** log10(this) を HugeNumber で返す（this > 0 前提） */
  log10Huge() {
    if (this.kind === 'inf') return HugeNumber.INF();
    if (this.kind === 'exact') {
      if (this.v <= 0n) return new HugeNumber('real', -Infinity);
      return HugeNumber.fromNumber(bigIntLog10(this.v));
    }
    if (this.kind === 'real') return HugeNumber.fromNumber(Math.log10(this.v));
    return HugeNumber._mkTower(HugeNumber._heightAdd(this.height, -1), this.top);
  }

  /** 10^L（L は HugeNumber） */
  static pow10(L) {
    if (L.kind === 'inf') return HugeNumber.INF();
    if (L.sign() <= 0) {
      const x = L.toNumber();
      return HugeNumber.fromNumber(isFinite(x) ? Math.pow(10, x) : 0);
    }
    const { h, t } = L._towerParts();
    return HugeNumber._mkTower(HugeNumber._heightAdd(h, 1), t);
  }

  /** 旧API互換: log10 を double で返す */
  getLog10() {
    const L = this.log10Huge();
    return L.toNumber();
  }

  // ---------- 比較 ----------

  /** 1: this > other / 0: 等しい / -1: this < other */
  compare(other) {
    if (this.kind === 'inf' || other.kind === 'inf') {
      if (this.kind === 'inf' && other.kind === 'inf') return 0;
      return this.kind === 'inf' ? 1 : -1;
    }
    if (this.kind === 'exact' && other.kind === 'exact') {
      return this.v > other.v ? 1 : this.v < other.v ? -1 : 0;
    }

    const sa = this.sign(), sb = other.sign();
    if (sa !== sb) return sa > sb ? 1 : -1;
    if (sa === 0) return 0;

    const A = this._towerParts();
    const B = other._towerParts();
    const hc = HugeNumber._compareHeights(A.h, B.h);
    if (hc !== 0) return sa > 0 ? hc : -hc;
    if (A.t > B.t) return sa > 0 ? 1 : -1;
    if (A.t < B.t) return sa > 0 ? -1 : 1;
    return 0;
  }

  /** this - other を double で返す（表現不能なら Infinity） */
  static _diffAsNumber(a, b) {
    if (a.compare(b) === 0) return 0;
    if (a.kind === 'exact' && b.kind === 'exact') {
      const d = a.v - b.v;
      return d > 1000n ? Infinity : Number(d);
    }
    if (a.kind !== 'tower' && b.kind !== 'tower' && a.kind !== 'inf' && b.kind !== 'inf') {
      const x = a.toNumber(), y = b.toNumber();
      if (isFinite(x) && isFinite(y)) return x - y;
    }
    return Infinity;
  }

  /** 小さい double を加算（巨大数域では無視される） */
  addNumber(c) {
    if (c === 0) return this;
    if (this.kind === 'tower' || this.kind === 'inf') return this;
    const x = this.toNumber();
    if (!isFinite(x)) return this;
    return HugeNumber.fromNumber(x + c);
  }

  // ---------- 四則 ----------

  /** 加算 */
  add(other) {
    if (this.kind === 'inf' || other.kind === 'inf') return HugeNumber.INF();
    if (this.isZero()) return other;
    if (other.isZero()) return this;

    if (this.kind === 'exact' && other.kind === 'exact') {
      return HugeNumber.of(this.v + other.v);
    }
    if (this.kind !== 'tower' && other.kind !== 'tower') {
      const x = this.toNumber() + other.toNumber();
      if (isFinite(x)) return HugeNumber.fromNumber(x);
    }

    // 対数域での加算: log10(a+b) = log10(a) + log10(1 + 10^-(La-Lb))
    const c = this.compare(other);
    const hi = c >= 0 ? this : other;
    const lo = c >= 0 ? other : this;
    const Lhi = hi.log10Huge();
    const Llo = lo.log10Huge();
    const d = HugeNumber._diffAsNumber(Lhi, Llo);
    if (!(d < 17)) return hi; // 差が大きすぎる → 小さい方は吸収される
    const corr = Math.log10(1 + Math.pow(10, -d));
    return HugeNumber.pow10(Lhi.addNumber(corr));
  }

  /** 乗算 */
  multiply(other) {
    if (this.kind === 'inf' || other.kind === 'inf') return HugeNumber.INF();
    if (this.isZero() || other.isZero()) return HugeNumber.ZERO;

    if (this.kind === 'exact' && other.kind === 'exact') {
      const da = bigIntDigits(this.v), db = bigIntDigits(other.v);
      if (da + db <= HUGE_LIMITS.EXACT_MAX_DIGITS + 1) {
        return HugeNumber.of(this.v * other.v);
      }
    }
    return HugeNumber.pow10(this.log10Huge().add(other.log10Huge()));
  }

  /** べき乗 this^other */
  power(other) {
    if (this.kind === 'inf' || other.kind === 'inf') return HugeNumber.INF();
    if (other.isZero()) return HugeNumber.ONE;
    if (other.kind === 'exact' && other.v === 1n) return this;
    if (this.isZero()) return HugeNumber.ZERO;
    if (this.kind === 'exact' && this.v === 1n) return HugeNumber.ONE;

    // 厳密計算できるか判定
    if (this.kind === 'exact' && other.kind === 'exact' &&
        other.v > 0n && other.v <= BigInt(HUGE_LIMITS.POWER_EXACT_MAX_EXP)) {
      const exp = Number(other.v);
      const estDigits = exp * bigIntLog10(this.v);
      if (estDigits <= HUGE_LIMITS.EXACT_MAX_DIGITS) {
        let result = 1n;
        let base = this.v;
        let e = BigInt(exp);
        while (e > 0n) {
          if (e & 1n) result *= base;
          e >>= 1n;
          if (e > 0n) base *= base;
        }
        return HugeNumber.of(result);
      }
    }

    // 対数域: log10(a^b) = b * log10(a)
    return HugeNumber.pow10(other.multiply(this.log10Huge()));
  }

  /** 階乗 this! */
  factorial() {
    if (this.kind === 'inf') return HugeNumber.INF();
    if (this.sign() < 0) throw new Error('負の数の階乗は定義されていません');
    if (this.kind === 'exact' && this.v <= 1n) return HugeNumber.ONE;

    if (this.kind === 'exact' && this.v <= BigInt(HUGE_LIMITS.FACTORIAL_LOOP_MAX)) {
      const n = Number(this.v);
      let logSum = 0;
      let exceeded = false;
      for (let i = 2; i <= n; i++) {
        logSum += Math.log10(i);
        if (logSum > HUGE_LIMITS.EXACT_MAX_DIGITS) { exceeded = true; break; }
      }
      if (!exceeded) {
        let result = 1n;
        for (let i = 2n; i <= this.v; i++) result *= i;
        return HugeNumber.of(result);
      }
      // スターリング近似（n が double で扱える場合）
      const log10Fact = n * (Math.log10(n) - LOG10_E)
        + 0.5 * Math.log10(2 * Math.PI * n)
        + 1 / (12 * n * Math.LN10);
      return HugeNumber.pow10(HugeNumber.fromNumber(log10Fact));
    }

    // 巨大な n: log10(n!) ≈ n * (log10(n) - log10(e))
    const logN = this.log10Huge();
    const inner = logN.addNumber(-LOG10_E);
    if (inner.sign() <= 0) return HugeNumber.ONE;
    return HugeNumber.pow10(this.multiply(inner));
  }

  /** 順列 this P other = n!/(n-r)! */
  permutation(other) {
    if (this.kind === 'inf' || other.kind === 'inf') return HugeNumber.INF();
    const cmp = other.compare(this);
    if (cmp > 0) return HugeNumber.ZERO;          // r > n
    if (other.sign() <= 0) return HugeNumber.ONE; // r <= 0
    if (cmp === 0) return this.factorial();       // r == n → n!

    // r が扱える大きさなら Σ log10(n-i) で厳密／準厳密に求める
    if (other.kind === 'exact' && other.v <= BigInt(HUGE_LIMITS.PERMUTATION_LOOP_MAX)) {
      const r = Number(other.v);

      if (this.kind === 'exact') {
        // 桁数を先に見積もって厳密計算の可否を判断
        const nNum = this.v;
        let logSum = 0;
        let exceeded = false;
        for (let i = 0; i < r; i++) {
          logSum += bigIntLog10(nNum - BigInt(i));
          if (logSum > HUGE_LIMITS.EXACT_MAX_DIGITS) { exceeded = true; break; }
        }
        if (!exceeded) {
          let result = 1n;
          for (let i = 0n; i < other.v; i++) result *= (nNum - i);
          return HugeNumber.of(result);
        }
        return HugeNumber.pow10(HugeNumber.fromNumber(logSum));
      }

      // n が巨大 → n-i ≈ n なので log10(nPr) ≈ r * log10(n)
      return HugeNumber.pow10(other.multiply(this.log10Huge()));
    }

    // r も n も巨大: スターリングの差で近似（double で扱える範囲のみ）
    const n = this.toNumber();
    const r = other.toNumber();
    if (isFinite(n) && isFinite(r) && n > r && n > 1) {
      const st = (x) => x * (Math.log10(x) - LOG10_E) + 0.5 * Math.log10(2 * Math.PI * x);
      const L = st(n) - st(n - r);
      if (isFinite(L)) return HugeNumber.pow10(HugeNumber.fromNumber(L));
    }
    // 最終手段: n! で近似（r ≈ n の場合に相当）
    return this.factorial();
  }

  /** テトレーション this ↑↑ other */
  tetration(other) {
    if (this.kind === 'inf' || other.kind === 'inf') return HugeNumber.INF();
    if (other.sign() <= 0) return HugeNumber.ONE;
    if (other.kind === 'exact' && other.v === 1n) return this;
    if (this.isZero()) return HugeNumber.ZERO;
    if (this.kind === 'exact' && this.v === 1n) return HugeNumber.ONE;

    const heightNum = (other.kind === 'exact' && other.v <= 1000000n) ? Number(other.v) : null;

    // 高さが小さい: そのまま反復（厳密計算が効く範囲は厳密になる）
    if (heightNum !== null && heightNum <= HUGE_LIMITS.TETRATION_ITER_MAX) {
      let x = this;
      for (let i = 1; i < heightNum; i++) x = this.power(x);
      return x;
    }

    // 高さが大きい: 数回だけ反復して形を決め、残りは「高さ」に足し込む。
    // 巨大な x に対して a^x = 10^(x·log10 a) ≈ 10^x なので、
    // 1回の指数化はタワーの高さを 1 増やすことに等しい。
    const SEED = 4;
    let x = this;
    for (let i = 1; i < SEED; i++) x = this.power(x);
    const { h, t } = x._towerParts();
    const rest = other.subtractSmallInt(SEED);
    return HugeNumber._mkTower(HugeNumber._addHeightHuge(h, rest), t);
  }

  /** this - k（k は小さい正整数）。巨大数では this をそのまま返す */
  subtractSmallInt(k) {
    if (this.kind === 'exact') {
      const nv = this.v - BigInt(k);
      return nv <= 0n ? HugeNumber.ZERO : HugeNumber.of(nv);
    }
    if (this.kind === 'real') return HugeNumber.fromNumber(this.v - k);
    return this;
  }

  /** 高さ(number) と HugeNumber を足して高さを作る */
  static _addHeightHuge(hNum, extra) {
    const en = HugeNumber._heightAsNumber(extra);
    if (en !== null) return hNum + en;
    if (extra.kind === 'exact') return HugeNumber.of(extra.v + BigInt(Math.round(hNum)));
    return extra; // 巨大な高さに小整数を足しても変わらない
  }

  // ---------- 桁数 ----------

  /** 桁数を HugeNumber で返す */
  digitCountHuge() {
    if (this.kind === 'inf') return HugeNumber.INF();
    if (this.kind === 'exact') return HugeNumber.of(BigInt(bigIntDigits(this.v)));
    if (this.sign() <= 0) return HugeNumber.ONE;
    const L = this.log10Huge();
    if (L.kind === 'tower') return L; // 桁数自体が巨大 → +1 は無視できる
    const x = L.toNumber();
    if (!isFinite(x)) return HugeNumber.INF();
    return HugeNumber.fromNumber(Math.floor(x) + 1);
  }

  /** 旧API互換 */
  digitCount() {
    const d = this.digitCountHuge();
    return d.kind === 'exact' ? Number(d.v) : d.toNumber();
  }

  // ---------- 表示 ----------

  /** どの層で計算されたかのラベル */
  tierLabel() {
    if (this.kind === 'inf') return '計算不能';
    if (this.kind === 'exact') return '厳密';
    const d = this.digitCountHuge();
    return d.isExactValue() ? '桁数まで確定' : 'タワー規模';
  }

  /**
   * 表示用文字列。
   *  - 厳密: そのままの整数（長い場合は先頭＋桁数）
   *  - 桁数が確定する規模: 約1.2×10^N（N+1桁）
   *  - それ以上: 10↑↑h 形式
   */
  toString() {
    if (this.kind === 'inf') return '計算不能（範囲外）';

    if (this.kind === 'exact') {
      const s = this.v.toString();
      if (s.length <= 24) return s;
      return `${s.slice(0, 12)}…（${s.length}桁）`;
    }

    if (this.kind === 'real') {
      if (Number.isInteger(this.v) && Math.abs(this.v) < 1e15) return String(this.v);
      if (Math.abs(this.v) < 1e15) return String(Number(this.v.toPrecision(12)));
      return `約${this.v.toExponential(4)}`;
    }

    // tower
    const L = this.log10Huge(); // log10(値)
    if (L.kind !== 'tower' && isFinite(L.toNumber())) {
      const lv = L.toNumber();
      const mantissa = Math.pow(10, lv - Math.floor(lv));
      const digits = Math.floor(lv) + 1;
      return `約${mantissa.toFixed(3)}×10^${formatBigCount(Math.floor(lv))}（${formatBigCount(digits)}桁）`;
    }
    // 桁数すら書けない規模
    const hn = HugeNumber._heightAsNumber(this.height);
    if (hn === null) return `10↑↑${this.scaleLabel()} 規模`;
    return `10↑↑${Math.round(hn)} 規模（${this._towerSketch()}）`;
  }

  /**
   * 「10↑↑X」の X を短く表したラベル。
   * 高さ自体が巨大な場合は再帰的に 10↑↑ 表記に畳む。
   */
  scaleLabel() {
    if (this.kind !== 'tower') return this.toString();
    const hn = HugeNumber._heightAsNumber(this.height);
    if (hn !== null) return String(Math.round(hn));
    if (this.height.kind === 'tower') return `(10↑↑${this.height.scaleLabel()})`;
    return `(${this.height.toString()})`;
  }

  /** ショーダウン等での詳細表示 */
  toFullString() {
    if (this.kind === 'exact') {
      const s = this.v.toString();
      if (s.length <= 40) return s;
      return `${s.slice(0, 20)}…（${s.length}桁）`;
    }
    return this.toString();
  }

  _towerHeightLabel() {
    const hn = HugeNumber._heightAsNumber(this.height);
    if (hn !== null) return String(Math.round(hn));
    return `(${this.height.toString()})`;
  }

  /** 10^10^…^top を最大3段まで書き下す */
  _towerSketch() {
    const hn = HugeNumber._heightAsNumber(this.height);
    const top = this.top.toFixed(3);
    if (hn === null) return `10^10^…^${top}`;
    const h = Math.round(hn);
    if (h <= 4) return '10^'.repeat(h) + top;
    return `10^10^10^…（10 が${h}個）…^${top}`;
  }
}

/** 大きな整数カウントを読みやすく */
function formatBigCount(n) {
  if (!isFinite(n)) return '∞';
  if (Math.abs(n) < 1e15) return Math.round(n).toLocaleString('en-US');
  return n.toExponential(4);
}

// ============================================================
// 数式パーサー
// ============================================================

/**
 * 文法（優先順位: ^ ↑↑ > * > + P）
 *   expr   := term (('+' | 'P') term)*        左結合
 *   term   := power ('*' power)*              左結合
 *   power  := factor (('^' | '↑↑') power)?    右結合
 *   factor := digit | '(' expr ')' , 後置 '!' を許す
 */
class FormulaParser {
  constructor(input) {
    this.input = input;
    this.pos = 0;
    this.nodeCount = 0;
  }

  parse() {
    if (this.input.length === 0) throw new Error('数式が空です');
    const node = this.parseExpr();
    this.skipWhitespace();
    if (this.pos < this.input.length) {
      throw new Error(`予期しない文字: '${this.input[this.pos]}'`);
    }
    return node;
  }

  _node(n) {
    if (++this.nodeCount > HUGE_LIMITS.MAX_AST_NODES) {
      throw new Error('数式が複雑すぎます');
    }
    return n;
  }

  skipWhitespace() {
    while (this.pos < this.input.length && /\s/.test(this.input[this.pos])) this.pos++;
  }

  peek() {
    this.skipWhitespace();
    return this.pos >= this.input.length ? null : this.input[this.pos];
  }

  parseExpr() {
    let left = this.parseTerm();
    for (;;) {
      const ch = this.peek();
      if (ch === '+') {
        this.pos++;
        left = this._node({ type: 'binary', op: '+', left, right: this.parseTerm() });
      } else if (ch === 'P' || ch === 'p') {
        this.pos++;
        left = this._node({ type: 'binary', op: 'P', left, right: this.parseTerm() });
      } else break;
    }
    return left;
  }

  parseTerm() {
    let left = this.parsePower();
    for (;;) {
      if (this.peek() === '*') {
        this.pos++;
        left = this._node({ type: 'binary', op: '*', left, right: this.parsePower() });
      } else break;
    }
    return left;
  }

  parsePower() {
    const left = this.parseFactor();
    const ch = this.peek();
    if (ch === '^') {
      this.pos++;
      return this._node({ type: 'binary', op: '^', left, right: this.parsePower() });
    }
    if (ch === '↑') {
      this.pos++;
      if (this.peek() !== '↑') throw new Error('↑ は単独では使えません（↑↑ を使用）');
      this.pos++;
      return this._node({ type: 'binary', op: '↑↑', left, right: this.parsePower() });
    }
    return left;
  }

  parseFactor() {
    this.skipWhitespace();
    if (this.pos >= this.input.length) throw new Error('式が途中で終わっています');
    const ch = this.input[this.pos];

    if (ch === '(') {
      this.pos++;
      const node = this.parseExpr();
      this.skipWhitespace();
      if (this.input[this.pos] !== ')') throw new Error('括弧が閉じられていません');
      this.pos++;
      return this.parsePostfix(this._node({ type: 'group', inner: node }));
    }

    if (ch >= '0' && ch <= '9') {
      this.pos++;
      return this.parsePostfix(this._node({ type: 'number', value: parseInt(ch, 10) }));
    }

    if (ch === ')') throw new Error('対応する開き括弧がありません');
    throw new Error(`予期しない文字: '${ch}'`);
  }

  parsePostfix(node) {
    this.skipWhitespace();
    if (this.input[this.pos] === '!') {
      this.pos++;
      return this.parsePostfix(this._node({ type: 'unary', op: '!', operand: node }));
    }
    return node;
  }
}

// ============================================================
// 数式評価器
// ============================================================

/** 表示用の優先順位 */
const DISPLAY_PREC = { '+': 1, 'P': 1, '*': 2, '^': 3, '↑↑': 3, '!': 4, atom: 5 };

class FormulaEvaluator {
  /**
   * 数式を評価する
   * @returns {{ok, value, error, usedNumbers, usedOperators, normalized, ast}}
   */
  static evaluate(formula) {
    const normalized = FormulaEvaluator.normalize(formula);
    try {
      const ast = new FormulaParser(normalized).parse();
      const value = FormulaEvaluator.evalNode(ast);
      return {
        ok: true,
        value,
        error: null,
        usedNumbers: FormulaEvaluator.collectNumbers(ast),
        usedOperators: FormulaEvaluator.collectOperators(ast),
        normalized,
        ast,
      };
    } catch (e) {
      return {
        ok: false, value: null, error: e.message,
        usedNumbers: [], usedOperators: [], normalized, ast: null,
      };
    }
  }

  /** 全角記号を半角に正規化 */
  static normalize(input) {
    let result = String(input || '')
      .replace(/[＋]/g, '+')
      .replace(/[×＊✕✖Ｘｘ]/g, '*')
      .replace(/[＾]/g, '^')
      .replace(/[！]/g, '!')
      .replace(/[Ｐｐ]/g, 'P')
      .replace(/[（]/g, '(')
      .replace(/[）]/g, ')')
      .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
      .replace(/\s+/g, '');

    // 単独の ↑ は ↑↑ とみなす
    result = result.replace(/↑↑/g, ' ');
    result = result.replace(/↑/g, ' ');
    result = result.replace(/ /g, '↑↑');
    return result;
  }

  static collectNumbers(node) {
    if (!node) return [];
    if (node.type === 'number') return [node.value];
    if (node.type === 'group') return FormulaEvaluator.collectNumbers(node.inner);
    if (node.type === 'binary') {
      return [...FormulaEvaluator.collectNumbers(node.left), ...FormulaEvaluator.collectNumbers(node.right)];
    }
    if (node.type === 'unary') return FormulaEvaluator.collectNumbers(node.operand);
    return [];
  }

  static collectOperators(node) {
    if (!node) return [];
    if (node.type === 'group') return FormulaEvaluator.collectOperators(node.inner);
    if (node.type === 'binary') {
      return [node.op,
        ...FormulaEvaluator.collectOperators(node.left),
        ...FormulaEvaluator.collectOperators(node.right)];
    }
    if (node.type === 'unary') {
      return [node.op, ...FormulaEvaluator.collectOperators(node.operand)];
    }
    return [];
  }

  static evalNode(node) {
    switch (node.type) {
      case 'number': return HugeNumber.of(node.value);
      case 'group': return FormulaEvaluator.evalNode(node.inner);
      case 'binary': {
        const left = FormulaEvaluator.evalNode(node.left);
        const right = FormulaEvaluator.evalNode(node.right);
        switch (node.op) {
          case '+': return left.add(right);
          case '*': return left.multiply(right);
          case '^': return left.power(right);
          case 'P': return left.permutation(right);
          case '↑↑': return left.tetration(right);
          default: throw new Error(`不明な演算子: ${node.op}`);
        }
      }
      case 'unary': {
        const operand = FormulaEvaluator.evalNode(node.operand);
        if (node.op === '!') return operand.factorial();
        throw new Error(`不明な演算子: ${node.op}`);
      }
      default: throw new Error('不明なノードタイプ');
    }
  }

  // ----------------------------------------------------------
  // カード使用ルールの検証
  // ----------------------------------------------------------

  /**
   * 数式が手札で作れるか＆枚数制限を満たすかを検証
   * @param {string} formula
   * @param {Array} hand 手札
   * @param {number} maxCards 使用可能枚数（括弧を除く）
   */
  static validateFormula(formula, hand, maxCards = 5) {
    const result = FormulaEvaluator.evaluate(formula);
    if (!result.ok) return { valid: false, error: result.error, usedCards: [] };

    const usedNumbers = result.usedNumbers;
    const usedOperators = result.usedOperators;

    if (usedNumbers.length === 0) {
      return { valid: false, error: '数字カードが使用されていません', usedCards: [] };
    }

    // 括弧はカウント対象外。数字＋演算子の合計で判定する。
    const total = usedNumbers.length + usedOperators.length;
    if (total > maxCards) {
      return {
        valid: false,
        error: `使用できるカードは${maxCards}枚までです（現在${total}枚）`,
        usedCards: [],
      };
    }

    const usedCards = [];
    const remainingNumbers = (hand || []).filter(c => c.type === 'number');
    for (const num of usedNumbers) {
      const idx = remainingNumbers.findIndex(c => Number(c.value) === num);
      if (idx === -1) {
        return { valid: false, error: `数字 ${num} のカードが手札にありません`, usedCards: [] };
      }
      usedCards.push(remainingNumbers[idx]);
      remainingNumbers.splice(idx, 1);
    }

    const remainingOps = (hand || []).filter(c => c.type === 'operator');
    for (const op of usedOperators) {
      const idx = remainingOps.findIndex(c => c.value === op);
      if (idx === -1) {
        return { valid: false, error: `演算子「${op === '*' ? '×' : op}」のカードが手札にありません`, usedCards: [] };
      }
      usedCards.push(remainingOps[idx]);
      remainingOps.splice(idx, 1);
    }

    return { valid: true, error: null, usedCards };
  }

  /** 数式内の演算子使用数をカウント（互換用） */
  static countOperators(formula) {
    const r = FormulaEvaluator.evaluate(formula);
    const counts = {};
    for (const op of r.usedOperators) counts[op] = (counts[op] || 0) + 1;
    return counts;
  }

  // ----------------------------------------------------------
  // 組版表示（AST から生成するのでパーサの解釈と必ず一致する）
  // ----------------------------------------------------------

  static toMathHTML(formula) {
    const normalized = FormulaEvaluator.normalize(formula);
    if (!normalized) return '';
    try {
      const ast = new FormulaParser(normalized).parse();
      return FormulaEvaluator.renderAst(ast, 0);
    } catch (e) {
      // 入力途中など、パースできない場合は素直にトークン表示
      return escapeHtml(normalized.replace(/\*/g, ' × '));
    }
  }

  /**
   * AST を HTML に組版する
   * @param {object} node
   * @param {number} minPrec これ未満の優先順位なら括弧で囲む
   */
  static renderAst(node, minPrec) {
    const wrap = (html, prec) => (prec < minPrec ? `(${html})` : html);

    switch (node.type) {
      case 'number':
        return `<span class="mn">${node.value}</span>`;

      case 'group':
        // 明示的な括弧はユーザーの意図なので保持する
        return `(${FormulaEvaluator.renderAst(node.inner, 0)})`;

      case 'unary': {
        const inner = FormulaEvaluator.renderAst(node.operand, DISPLAY_PREC['!']);
        return wrap(`${inner}<span class="mo">!</span>`, DISPLAY_PREC['!']);
      }

      case 'binary': {
        const p = DISPLAY_PREC[node.op];
        if (node.op === '+') {
          const l = FormulaEvaluator.renderAst(node.left, p);
          const r = FormulaEvaluator.renderAst(node.right, p);
          return wrap(`${l}<span class="mo"> + </span>${r}`, p);
        }
        if (node.op === '*') {
          const l = FormulaEvaluator.renderAst(node.left, p);
          const r = FormulaEvaluator.renderAst(node.right, p);
          return wrap(`${l}<span class="mo"> × </span>${r}`, p);
        }
        if (node.op === 'P') {
          // 上下に配置されるので中身に括弧は不要
          const l = FormulaEvaluator.renderAst(node.left, 0);
          const r = FormulaEvaluator.renderAst(node.right, 0);
          return wrap(`<span class="mperm"><sub>${l}</sub><span class="mo">P</span><sup>${r}</sup></span>`, p);
        }
        if (node.op === '^') {
          // 底は優先順位が必要、指数は上付きなので括弧不要
          const l = FormulaEvaluator.renderAst(node.left, p);
          const r = FormulaEvaluator.renderAst(node.right, 0);
          return wrap(`${l}<sup class="mexp">${r}</sup>`, p);
        }
        if (node.op === '↑↑') {
          const l = FormulaEvaluator.renderAst(node.left, p);
          const r = FormulaEvaluator.renderAst(node.right, p);
          return wrap(`${l}<span class="mo mtet">↑↑</span>${r}`, p);
        }
        break;
      }
    }
    return '';
  }

  /** 読み上げテキスト（aria-label 用） */
  static toSpeechText(formula) {
    const normalized = FormulaEvaluator.normalize(formula);
    try {
      const ast = new FormulaParser(normalized).parse();
      return FormulaEvaluator.speakAst(ast);
    } catch (e) {
      return normalized;
    }
  }

  static speakAst(node) {
    switch (node.type) {
      case 'number': return String(node.value);
      case 'group': return `かっこ ${FormulaEvaluator.speakAst(node.inner)} かっことじ`;
      case 'unary': return `${FormulaEvaluator.speakAst(node.operand)} の階乗`;
      case 'binary': {
        const l = FormulaEvaluator.speakAst(node.left);
        const r = FormulaEvaluator.speakAst(node.right);
        switch (node.op) {
          case '+': return `${l} たす ${r}`;
          case '*': return `${l} かける ${r}`;
          case '^': return `${l} の ${r} 乗`;
          case 'P': return `${l} ピー ${r}`;
          case '↑↑': return `${l} テトレーション ${r}`;
        }
      }
    }
    return '';
  }

  // ----------------------------------------------------------
  // 申告値の解釈と正誤判定
  // ----------------------------------------------------------

  /**
   * プレイヤーが入力した「答え」を解釈する。
   * 受け付ける書式:
   *   125            厳密な整数
   *   1234桁 / 1234けた / 1234 digits   桁数の申告
   *   1.2e30 / 1.2×10^30 / 3*10^8       概数
   *   10^100 / 10^10^100                べき乗（右結合）
   *   10↑↑5                             テトレーション
   * @returns {{kind:'value'|'digits', value?:HugeNumber, digits?:HugeNumber}|null}
   */
  static parseDeclaration(text) {
    let s = String(text == null ? '' : text).trim();
    if (!s) return null;

    s = s
      .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
      .replace(/[×＊✕✖]/g, '*')
      .replace(/[＾]/g, '^')
      .replace(/[＋]/g, '+')
      .replace(/[，,\s_]/g, '')
      .replace(/↑/g, '↑');

    // 桁数申告
    const digitMatch = s.match(/^(.+?)(桁|ケタ|けた|digits?|d)$/i);
    if (digitMatch) {
      const inner = FormulaEvaluator._evalDeclExpr(digitMatch[1]);
      if (!inner) return null;
      return { kind: 'digits', digits: inner };
    }

    const value = FormulaEvaluator._evalDeclExpr(s);
    if (!value) return null;
    return { kind: 'value', value };
  }

  /** 申告用のミニ数式評価（多桁の数値リテラルを許す） */
  static _evalDeclExpr(src) {
    let pos = 0;
    const peek = () => (pos < src.length ? src[pos] : null);

    function parseExpr() {
      let left = parseUnit();
      while (peek() === '*') { pos++; left = left.multiply(parseUnit()); }
      return left;
    }

    function parseUnit() {
      let base = parseAtom();
      const ch = peek();
      if (ch === '^') { pos++; return base.power(parseUnit()); }
      if (ch === '↑') {
        pos++;
        if (peek() === '↑') pos++;
        return base.tetration(parseUnit());
      }
      if (ch === 'e' || ch === 'E') {
        pos++;
        const exp = parseUnit();
        return base.multiply(HugeNumber.of(10).power(exp));
      }
      return base;
    }

    function parseAtom() {
      if (peek() === '(') {
        pos++;
        const v = parseExpr();
        if (peek() !== ')') throw new Error('括弧が閉じていません');
        pos++;
        return v;
      }
      const start = pos;
      while (pos < src.length && /[0-9.]/.test(src[pos])) pos++;
      if (pos === start) throw new Error('数値が読み取れません');
      const lit = src.slice(start, pos);
      if (/^\d+$/.test(lit)) return HugeNumber.of(BigInt(lit));
      const f = parseFloat(lit);
      if (!isFinite(f)) throw new Error('数値が不正です');
      return HugeNumber.fromNumber(f);
    }

    try {
      const v = parseExpr();
      if (pos !== src.length) return null;
      return v;
    } catch (e) {
      return null;
    }
  }

  /**
   * システム計算値とプレイヤー申告を突き合わせる。
   *
   * 判定モード（システム値がどこまで確定できるかで自動的に変わる）:
   *   'exact'  厳密値が出せる → 値の完全一致のみ ○
   *   'digits' 桁数が確定できる → 桁数の一致で ○（値で書いても桁数に換算）
   *   'scale'  桁数も書けない規模 → タワーの規模が一致すれば ○
   *
   * @returns {{ok, mode, reason, expected, declared}}
   */
  static judgeDeclaration(systemValue, declaredText) {
    const mode = FormulaEvaluator.declarationMode(systemValue);
    const parsed = FormulaEvaluator.parseDeclaration(declaredText);

    if (!parsed) {
      return { ok: false, mode, reason: '答えを解釈できませんでした', expected: null, declared: null };
    }

    if (mode === 'exact') {
      if (parsed.kind !== 'value' || !parsed.value.isExactValue()) {
        return { ok: false, mode, reason: '厳密な値で答えてください', expected: systemValue, declared: parsed.value || null };
      }
      const ok = parsed.value.compare(systemValue) === 0;
      return { ok, mode, reason: ok ? null : '値が一致しません', expected: systemValue, declared: parsed.value };
    }

    if (mode === 'digits') {
      const expected = systemValue.digitCountHuge();
      const declared = parsed.kind === 'digits' ? parsed.digits : parsed.value.digitCountHuge();
      const ok = expected.compare(declared) === 0;
      return { ok, mode, reason: ok ? null : '桁数が一致しません', expected, declared };
    }

    // scale
    if (parsed.kind === 'digits') {
      const expected = systemValue.digitCountHuge();
      const ok = expected.compare(parsed.digits) === 0;
      return { ok, mode, reason: ok ? null : '規模が一致しません', expected, declared: parsed.digits };
    }
    const ok = systemValue.compare(parsed.value) === 0;
    return { ok, mode, reason: ok ? null : '規模が一致しません', expected: systemValue, declared: parsed.value };
  }

  /** システム値に対して要求される申告の種類 */
  static declarationMode(systemValue) {
    if (!systemValue || systemValue.isInfinite()) return 'scale';
    if (systemValue.isExactValue()) return 'exact';
    return systemValue.digitCountHuge().isExactValue() ? 'digits' : 'scale';
  }

  /** 入力欄に出すヒント文 */
  static declarationHint(systemValue) {
    switch (FormulaEvaluator.declarationMode(systemValue)) {
      case 'exact':
        return '厳密な値を入力してください（例: 125）';
      case 'digits':
        return '大きすぎるので「桁数」で答えてください（例: 1234桁 / 10^30 のような概数も可）';
      default:
        return '桁数も書けない規模です。10^10^30 や 10↑↑5 のような形で規模を申告してください';
    }
  }
}

/** HTML エスケープ */
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ============================================================
// エクスポート
// ============================================================

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { HugeNumber, FormulaParser, FormulaEvaluator, HUGE_LIMITS, escapeHtml };
}
if (typeof window !== 'undefined') {
  window.HugeNumber = HugeNumber;
  window.FormulaParser = FormulaParser;
  window.FormulaEvaluator = FormulaEvaluator;
  window.HUGE_LIMITS = HUGE_LIMITS;
  window.escapeHtml = escapeHtml;
}
