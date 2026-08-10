#!/usr/bin/env node
/**
 * tools/calibrate-ai.js — 正答率モデルをアンカー表に突き合わせる
 *
 * ============================================================
 * これは何か
 * ============================================================
 * js/ai-cognition.js の定数は、実測データではなく
 * 「紙とペンで手計算したとき、この人はこれくらい当てるはず」という
 * **設計者が決めた目標値（アンカー）** に合わせてある。
 *
 * 目標値そのものはこのファイルに書いてある。定数をいじったら必ずここを通す。
 *
 *   node tools/calibrate-ai.js            アンカーとのズレを表示
 *   node tools/calibrate-ai.js --curves   時間ごとの正答率カーブも表示
 *   node tools/calibrate-ai.js --check    ズレが許容範囲を超えたら exit 1
 *   node tools/calibrate-ai.js --fit      定数を当て直して、貼り替える値を出す
 *
 * ============================================================
 * --fit で「当てにいくもの」と「当てにいかないもの」
 * ============================================================
 * 当てるのは **構造側のグローバル定数だけ**。
 * 速度・ミス率・検算の発見率・暗記の範囲といった *人についての想定* は固定する。
 * これらまでフィッターに任せると、アンカーには合うが
 * 「競技者が 6^9 を30秒で筆算する」ような物理的にあり得ない値に張り付く。
 * 実際に一度そうなった。人の想定を変えたいときは AI_PROFILES を手で編集すること。
 *
 * 外部の根拠がある定数には狭い範囲しか許していない（下の FIT_KNOBS 参照）。
 *   MUL_TABLE      九九の想起 ≈ 1秒（Campbell & LeFevre 2001）→ そもそも当てない
 *   WRITE_PER_DIGIT 成人の書写は文章の書き写しで 40文字/分（1.5秒/文字）。
 *                   ただし筆算の数字列は語を読み解く必要がない分これより速いので、
 *                   50〜150文字/分（1.20〜0.40秒/文字）の範囲だけ許す
 *
 * ============================================================
 * アンカーの立て方
 * ============================================================
 * 「5分（300秒）与えて、紙とペンで検算までさせたときの正答率」を基準にする。
 * 手計算なので、時間さえあれば大抵は合う。差がつくのは主に
 * **短時間で間に合うか**のほうで、それは TIME_ANCHORS 側で見る。
 */

const path = require('path');
const ROOT = path.join(__dirname, '..');
const C = require(path.join(ROOT, 'js/ai-cognition.js'));
const { FormulaEvaluator: FE } = require(path.join(ROOT, 'js/engine.js'));

// ============================================================
// 目標値
// ============================================================

/**
 * 300秒（5分）与えたときの正答率。
 *
 * 高校生 / 大学生 / 競技者 の3列が設計上の主目標。
 * 中学生 と トップ競技者 はそこからの外挿なので、ズレても優先度は低い。
 *
 * 階乗の行（9! と (8+3)!）は、profile.factKnown を
 * 「大学生でも 5! までしか暗記していない」に下げたぶん一段下げてある。
 * 9! は 120 から ×6 ×7 ×8 ×9 と4回、11! は7回の乗算が要るので、
 * 「多桁×1桁を数回」とはいえ 6^9 と同程度に重い。
 * ここを下げずに定数で寄せにいくと、階乗と関係ない式まで巻き添えで甘くなる。
 */
const ANCHORS = {
  //  式              novice casual skilled expert master
  '9*8':            [0.99,  0.995, 0.995,  0.999, 0.999],
  '6^6':            [0.75,  0.90,  0.95,   0.98,  0.99],
  '9!':             [0.72,  0.86,  0.94,   0.98,  0.99],
  '6^9':            [0.40,  0.80,  0.92,   0.97,  0.98],
  '9^8':            [0.40,  0.75,  0.90,   0.97,  0.98],
  '(8+3)!':         [0.12,  0.60,  0.82,   0.93,  0.97],
  '(4+6)^9':        [0.95,  0.97,  0.98,   0.99,  0.995],
};

/**
 * 時間をかけたときの伸び方。[式, レベル, [[秒, 目標正答率], ...]]
 * 「30秒では無理／5分あれば解ける」という形になっているかを見る。
 * 手計算モデルではここが本体で、300秒の表だけ合っていても意味がない。
 */
// 注: 300秒の時点で見直し回数は上限（MAX_RECHECKS）に達するので、
//     600秒にしてもほとんど伸びない。「4回見直した後にさらに6回見直しても
//     新しい誤りは見つからない」という飽和で、これはモデルの意図した挙動。
//     初期の手書きアンカーは 600秒でまだ伸びる想定だったが、そちらを修正した。
const TIME_ANCHORS = [
  ['6^9', 'skilled', [[30, 0.03], [60, 0.35], [150, 0.85], [300, 0.92], [600, 0.93]]],
  ['6^9', 'casual', [[30, 0.01], [60, 0.05], [150, 0.58], [300, 0.78], [600, 0.80]]],
  ['9*8', 'casual', [[30, 0.95], [60, 0.98], [300, 0.995]]],
];

// アンカーは実測ではなく設計者の判断で置いた目標値なので、
// これより細かい一致を求めても意味がない（偽の精度になる）。
const TOLERANCE = 0.07;

// ============================================================

const LEVELS = C.AI_LEVEL_ORDER;
const ANCHOR_TIME = 300;

function analyze(formula, level) {
  const ev = FE.evaluate(formula);
  if (!ev.ok) throw new Error(`${formula}: ${ev.error}`);
  const profile = C.getProfile(level);
  const a = C.analyzeFormula({ formula, ast: ev.ast, value: ev.value }, profile);
  return { profile, analysis: a, value: ev.value };
}

function accuracy(formula, level, seconds) {
  const { profile, analysis } = analyze(formula, level);
  return C.accuracyUnderTime(analysis, seconds, profile);
}

function pad(s, n) { return String(s).padEnd(n); }
function padL(s, n) { return String(s).padStart(n); }
function fmt(x) { return (x * 100).toFixed(1); }

/** ズレに応じた印 */
function mark(diff) {
  const d = Math.abs(diff);
  if (d <= TOLERANCE / 2) return ' ';
  if (d <= TOLERANCE) return '.';
  return diff > 0 ? '+' : '-';       // + は甘すぎ（当てすぎ）、- は厳しすぎ
}

// ============================================================
// --fit : 構造側の定数だけを座標降下で当てる
// ============================================================

/** [定数名, 下限, 上限] — 人についての想定（AI_PROFILES）はここに入れないこと */
const FIT_KNOBS = [
  ['SYSTEMATIC_BASE', 0.03, 0.22],
  ['SYSTEMATIC_SLOPE', 0.05, 1.60],
  ['RECHECK_FACTOR', 0.25, 0.90],
  ['MUL_PER_PARTIAL', 0.90, 1.80],   // 筆算の実感から大きくは動かさない
  ['MUL_PER_DIGIT', 0.60, 1.40],
  ['WRITE_PER_DIGIT', 0.40, 1.20],   // 50〜150文字/分
  ['PLANNING_BASE', 2.0, 10.0],
  ['PLANNING_PER_CARD', 0.5, 3.0],
];

/** 承認済みの3列（高校生/大学生/競技者）を重く見る */
const FIT_WEIGHT = { novice: 1, casual: 3, skilled: 3, expert: 3, master: 1 };

function fitLoss() {
  C.clearAnalysisCache();
  let s = 0;
  for (const [formula, targets] of Object.entries(ANCHORS)) {
    LEVELS.forEach((lv, i) => {
      const d = accuracy(formula, lv, ANCHOR_TIME).pCorrect - targets[i];
      s += FIT_WEIGHT[lv] * d * d;
    });
  }
  for (const [formula, level, points] of TIME_ANCHORS) {
    for (const [sec, want] of points) {
      const d = accuracy(formula, level, sec).pCorrect - want;
      s += 4 * d * d;
    }
  }
  return s;
}

function runFit() {
  let best = fitLoss();
  console.log(`\n=== --fit: 構造側の定数を当て直す ===\n初期 loss ${best.toFixed(5)}`);

  for (let pass = 0; pass < 200; pass++) {
    let improved = false;
    for (const [key, lo, hi] of FIT_KNOBS) {
      const cur = C.COG[key];
      for (const mult of [0.96, 0.98, 1.02, 1.04]) {
        const v = Math.min(hi, Math.max(lo, cur * mult));
        if (v === cur) continue;
        C.COG[key] = v;
        const l = fitLoss();
        if (l < best - 1e-10) { best = l; improved = true; break; }
        C.COG[key] = cur;
      }
    }
    for (const v of [4, 5, 6, 8, 10, 12]) {          // MAX_RECHECKS は整数
      const cur = C.COG.MAX_RECHECKS;
      if (v === cur) continue;
      C.COG.MAX_RECHECKS = v;
      const l = fitLoss();
      if (l < best - 1e-10) { best = l; improved = true; } else { C.COG.MAX_RECHECKS = cur; }
    }
    if (!improved) { console.log(`収束 (pass ${pass})`); break; }
  }

  console.log(`最終 loss ${best.toFixed(5)}\n`);
  console.log('js/ai-cognition.js の COG に貼る値:');
  for (const [key] of FIT_KNOBS) console.log(`  ${key}: ${C.COG[key].toFixed(3)},`);
  console.log(`  MAX_RECHECKS: ${C.COG.MAX_RECHECKS},`);
  console.log('\n※ 下の表はこの当て直しを反映したもの。実際に貼るまでソースは変わらない。');
}

function main() {
  const args = process.argv.slice(2);
  const showCurves = args.includes('--curves');
  const checkMode = args.includes('--check');

  if (args.includes('--fit')) runFit();

  let worst = 0, worstLabel = '', failures = 0;

  console.log(`\n=== ${ANCHOR_TIME}秒（5分）与えたときの正答率 ===`);
  console.log('各セル: 実際 / 目標   印 + は当てすぎ、- は当てなさすぎ\n');
  console.log(pad('式', 11) + LEVELS.map((lv) =>
    padL(C.getProfile(lv).name, 16)).join(''));

  for (const [formula, targets] of Object.entries(ANCHORS)) {
    let line = pad(formula, 11);
    LEVELS.forEach((lv, i) => {
      const got = accuracy(formula, lv, ANCHOR_TIME).pCorrect;
      const want = targets[i];
      const diff = got - want;
      if (Math.abs(diff) > worst) { worst = Math.abs(diff); worstLabel = `${formula} / ${lv}`; }
      if (Math.abs(diff) > TOLERANCE) failures++;
      line += padL(`${fmt(got)}/${fmt(want)}${mark(diff)}`, 16);
    });
    console.log(line);
  }

  console.log('\n=== 時間をかけたときの伸び方 ===\n');
  for (const [formula, level, points] of TIME_ANCHORS) {
    console.log(`${formula}  ${C.getProfile(level).name}`);
    for (const [sec, want] of points) {
      const acc = accuracy(formula, level, sec);
      const diff = acc.pCorrect - want;
      if (Math.abs(diff) > worst) { worst = Math.abs(diff); worstLabel = `${formula} / ${level} / ${sec}秒`; }
      if (Math.abs(diff) > TOLERANCE) failures++;
      console.log(`  ${padL(sec, 4)}秒  ${padL(fmt(acc.pCorrect), 6)}% / 目標 ${padL(fmt(want), 6)}% ${mark(diff)}` +
        `   見直し ${acc.rechecks}回  間に合う ${acc.pFinish.toFixed(2)}  初回誤り ${fmt(acc.errFirst)}% → ${fmt(acc.errAfter)}%`);
    }
    console.log('');
  }

  console.log('=== 所要時間（秒）— 筆算として妥当か ===\n');
  console.log(pad('式', 11) + LEVELS.map((lv) => padL(C.getProfile(lv).name, 16)).join(''));
  for (const formula of Object.keys(ANCHORS)) {
    let line = pad(formula, 11);
    for (const lv of LEVELS) {
      line += padL(analyze(formula, lv).analysis.requiredTime.toFixed(0), 16);
    }
    console.log(line);
  }

  console.log('\n=== 筆算1回の初回誤り率（検算前）===\n');
  console.log(pad('', 7) + LEVELS.map((lv) => padL(C.getProfile(lv).name, 16)).join(''));
  for (const n of [2, 3, 4, 5, 7]) {
    let line = pad(`${n}桁×${n}桁`, 7);
    for (const lv of LEVELS) {
      const p = C.getProfile(lv);
      line += padL(`${fmt(1 - Math.pow(1 - p.slipRate, n * n + n))}%`, 16);
    }
    console.log(line);
  }

  if (showCurves) {
    console.log('\n=== 正答率カーブ ===\n');
    for (const formula of Object.keys(ANCHORS)) {
      console.log(formula);
      for (const lv of LEVELS) {
        const row = [10, 30, 60, 120, 300, 600]
          .map((s) => padL(`${fmt(accuracy(formula, lv, s).pCorrect)}%`, 8)).join('');
        console.log(`  ${pad(C.getProfile(lv).name, 14)}${row}`);
      }
      console.log(`  ${pad('', 14)}${[10, 30, 60, 120, 300, 600].map((s) => padL(`${s}s`, 8)).join('')}\n`);
    }
  }

  console.log(`\n最大ズレ ${fmt(worst)}pt（${worstLabel}） / 許容超え ${failures} 箇所\n`);

  if (checkMode && failures > 0) {
    console.error(`アンカーから ${TOLERANCE * 100}pt 以上ずれている箇所が ${failures} 個ある`);
    process.exit(1);
  }
}

main();
