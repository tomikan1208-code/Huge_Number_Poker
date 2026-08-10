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
 * 9! と (8+3)! は「多桁×1桁の乗算を数回」で届くため、
 * 6^9（8回の連鎖乗算）よりはっきり易しい。手順の実態に合わせてある。
 */
const ANCHORS = {
  //  式              novice casual skilled expert master
  '9*8':            [0.99,  0.995, 0.995,  0.999, 0.999],
  '6^6':            [0.75,  0.90,  0.95,   0.98,  0.99],
  '9!':             [0.78,  0.92,  0.96,   0.985, 0.99],
  '6^9':            [0.40,  0.80,  0.92,   0.97,  0.98],
  '9^8':            [0.35,  0.75,  0.90,   0.97,  0.98],
  '(8+3)!':         [0.25,  0.65,  0.85,   0.95,  0.97],
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

function main() {
  const args = process.argv.slice(2);
  const showCurves = args.includes('--curves');
  const checkMode = args.includes('--check');

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
