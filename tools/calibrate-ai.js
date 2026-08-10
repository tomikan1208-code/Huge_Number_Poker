#!/usr/bin/env node
/**
 * tools/calibrate-ai.js — 正答率モデルを検査して、現在値を記録する
 *
 * ============================================================
 * このツールの役割が変わった経緯
 * ============================================================
 * 元はアンカー表（「大学生は 6^9 を5分で92%当てるはず」といった目標値）を置き、
 * `--fit` で定数を座標降下させて**アンカーに合わせにいく**道具だった。
 *
 * これをやめた。理由は単純で、**アンカー自体が根拠のない当て推量だから**。
 * 実測データではなく設計者の感覚で置いた数字に、モデルの定数を合わせにいくと
 * 次のことが起きる。
 *
 *   1. アンカーが間違っていても、定数がそれを吸収して見た目は合う
 *   2. 外部の根拠がある定数（九九1回 ≈ 1秒）まで押し出される
 *   3. どの定数が「根拠のある値」でどれが「辻褄合わせ」なのか区別がつかなくなる
 *
 * 実際に起きた: 筆算中の九九を 0.80秒 に統一したら 6^9 の所要時間が
 * 60秒 → 69.5秒 に伸びた。これは**そうあるべき変化**（手計算はもっと遅い、
 * という判断で伸ばした）なのに、フィッターは書字速度を下限に張り付けて
 * 元の正答率に戻そうとした。アンカーを守るために、根拠のある値を歪めていた。
 *
 * ============================================================
 * 今の役割
 * ============================================================
 * 2つに分けた。
 *
 *   REQUIREMENTS  守らないと**ゲームが壊れる**性質。定性的。破ったら exit 1
 *                 例: 難易度が上のプロファイルほど当てる／時間を足せば当たるようになる
 *                     (4+6)^9 は 6^9 よりはっきり速い（設計の看板）
 *                 数字の帯は「明らかにおかしい値を弾く」ためだけの広さにしてある。
 *                 狭めると結局アンカーと同じものになるので、狭めないこと。
 *
 *   SNAPSHOT      現在のモデルが出す値の**記録**。目標ではない。
 *                 定数をいじったとき「意図した以外のどこが動いたか」を見るためのもの。
 *                 差が出ても**それ自体は失敗ではない**。意図した変更なら
 *                 `--snapshot` で貼り替える。
 *
 * つまり「合わせにいく」から「変化に気づく」に変えた。
 *
 *   node tools/calibrate-ai.js             要件の検査 ＋ 現在値の一覧
 *   node tools/calibrate-ai.js --curves    時間ごとの正答率カーブも出す
 *   node tools/calibrate-ai.js --check     要件を破ったら exit 1（CI 用）
 *   node tools/calibrate-ai.js --snapshot  SNAPSHOT に貼る値を出力する
 *
 * ============================================================
 * 定数を変えたいとき
 * ============================================================
 * **手で変える。** 変えた理由をその定数のコメントに書く。
 * 根拠（文献・実測・設計上の意図）があるものと、無いものを混ぜない。
 * 根拠が無い定数は「無い」と書いておけば、次に誰かが疑える。
 */

const path = require('path');
const ROOT = path.join(__dirname, '..');
const C = require(path.join(ROOT, 'js/ai-cognition.js'));
const { FormulaEvaluator: FE } = require(path.join(ROOT, 'js/engine.js'));

const LEVELS = C.AI_LEVEL_ORDER;

function analyze(formula, level) {
  const ev = FE.evaluate(formula);
  if (!ev.ok) throw new Error(`${formula}: ${ev.error}`);
  const profile = C.getProfile(level);
  return {
    profile,
    analysis: C.analyzeFormula({ formula, ast: ev.ast, value: ev.value }, profile),
    value: ev.value,
  };
}

function accuracy(formula, level, seconds) {
  const { profile, analysis } = analyze(formula, level);
  return C.accuracyUnderTime(analysis, seconds, profile);
}

function required(formula, level) {
  return analyze(formula, level).analysis.requiredTime;
}

function acc(formula, level, seconds) {
  return accuracy(formula, level, seconds).pCorrect;
}

// ============================================================
// 1. 要件 — 破ったらゲームが壊れる性質
// ============================================================
//
// ここに書くのは「モデルがどんな値でも満たしていてほしい構造」だけ。
// **具体的な正答率を目標として書かないこと。** それをやると結局アンカーになる。

const REQUIREMENTS = [
  // ---- 単調性 ----------------------------------------------------------
  {
    name: '強いプロファイルほど当てる（同じ式・同じ時間）',
    run() {
      const bad = [];
      for (const f of ['6^6', '6^9', '9!', '(8+3)!', '9^8']) {
        for (let i = 1; i < LEVELS.length; i++) {
          const lo = acc(f, LEVELS[i - 1], 300);
          const hi = acc(f, LEVELS[i], 300);
          if (hi < lo - 1e-9) bad.push(`${f}: ${LEVELS[i - 1]} ${(lo * 100).toFixed(1)}% > ${LEVELS[i]} ${(hi * 100).toFixed(1)}%`);
        }
      }
      return bad;
    },
  },
  {
    name: '時間を足せば正答率は下がらない',
    run() {
      const bad = [];
      const times = [10, 30, 60, 120, 300, 600];
      for (const f of ['6^9', '9!', '(4+6)^9', '(8+3)!']) {
        for (const lv of LEVELS) {
          for (let i = 1; i < times.length; i++) {
            const lo = acc(f, lv, times[i - 1]);
            const hi = acc(f, lv, times[i]);
            if (hi < lo - 1e-9) bad.push(`${f}/${lv}: ${times[i - 1]}秒 ${(lo * 100).toFixed(1)}% > ${times[i]}秒 ${(hi * 100).toFixed(1)}%`);
          }
        }
      }
      return bad;
    },
  },
  {
    name: '強いプロファイルほど速い（所要時間）',
    run() {
      const bad = [];
      for (const f of ['6^9', '9!', '(8+3)!', '(5*6)^7']) {
        for (let i = 1; i < LEVELS.length; i++) {
          const slow = required(f, LEVELS[i - 1]);
          const fast = required(f, LEVELS[i]);
          if (fast > slow + 1e-9) bad.push(`${f}: ${LEVELS[i]} ${fast.toFixed(0)}秒 > ${LEVELS[i - 1]} ${slow.toFixed(0)}秒`);
        }
      }
      return bad;
    },
  },

  // ---- 設計の看板 ------------------------------------------------------
  //
  // 「値の大きさ」ではなく「計算過程」で難易度が決まる、というのがこのゲームの核。
  // ここが崩れるとゲームそのものが別物になる。
  {
    name: '(4+6)^9 は 6^9 よりはっきり速い（値は大きいのに易しい）',
    run() {
      const bad = [];
      for (const lv of LEVELS) {
        const easy = required('(4+6)^9', lv);
        const hard = required('6^9', lv);
        if (hard < easy * 1.5) bad.push(`${lv}: (4+6)^9 ${easy.toFixed(0)}秒 に対し 6^9 が ${hard.toFixed(0)}秒 しかない`);
      }
      return bad;
    },
  },
  {
    name: '末尾0は計算を消さない: 30^7 は 10^7 より高い',
    // 回帰テスト。かつて底の末尾が0なら「1のあとに0を並べるだけ」と誤認していて、
    // (5*6)^7 = 30^7 が 10^7 と同じ値段になっていた。ゲーム内で作れる手なのでズルだった。
    //
    // 同じ指数どうしで比べる。10^7 は本当に「1のあとに0を7個」なので純粋な筆記だが、
    // 30^7 はそこに 3^7 = 2187 が要る。誰にとっても 30^7 のほうが高いはず。
    //
    // ただし **差の大きさはプロファイルによって当然違う**。競技者は 3^7 を暗記している
    // ので想起1回で済み、差は小さくなる。それは正しい挙動なので、暗記していない
    // プロファイルにだけ大きな差を要求する。
    run() {
      const bad = [];
      for (const lv of LEVELS) {
        const ten = required('(4+6)^7', lv);
        const thirty = required('(5*6)^7', lv);
        if (thirty <= ten) {
          bad.push(`${lv}: 30^7 ${thirty.toFixed(0)}秒 ≦ 10^7 ${ten.toFixed(0)}秒`);
          continue;
        }
        const knows3to7 = (C.getProfile(lv).powerTable || {})[3] >= 7;
        if (!knows3to7 && thirty < ten * 1.5) {
          bad.push(`${lv}: 3^7 を暗記していないのに 30^7 ${thirty.toFixed(0)}秒 / 10^7 ${ten.toFixed(0)}秒 と差が小さい`);
        }
      }
      return bad;
    },
  },
  {
    name: '短い式どうしが同じ秒数に潰れない（9*8 / 7! / 8! / 9!）',
    // 階乗を暗記扱いにしていた頃、大学生だと全部10秒前後に並んで式の中身が見えなかった。
    run() {
      const bad = [];
      for (const lv of LEVELS) {
        const t = ['9*8', '7!', '8!', '9!'].map((f) => required(f, lv));
        for (let i = 1; i < t.length; i++) {
          if (t[i] < t[i - 1] * 1.1) bad.push(`${lv}: ${t.map((x) => x.toFixed(0)).join(' / ')} 秒`);
        }
      }
      return bad;
    },
  },

  // ---- 外部の根拠がある値 ----------------------------------------------
  {
    name: '九九1回は 0.80秒（Campbell & LeFevre 2001 の約1秒）',
    run() {
      return Math.abs(C.COG.MUL_TABLE - 0.80) < 1e-9
        ? [] : [`MUL_TABLE = ${C.COG.MUL_TABLE}`];
    },
  },
  {
    name: '書字は 50〜150文字/分の帯に収まる',
    // 成人の文章書き写しが約40文字/分。筆算の数字列は語を読み解かないぶん速いので上に取る。
    run() {
      const perMin = 60 / C.COG.WRITE_PER_DIGIT;
      return (perMin >= 50 && perMin <= 150)
        ? [] : [`WRITE_PER_DIGIT = ${C.COG.WRITE_PER_DIGIT} (${perMin.toFixed(0)}文字/分)`];
    },
  },
  {
    name: '4桁×4桁の筆算は 20〜45秒',
    // 部分積4行×5桁＋合計8桁＝28文字を書く。書字だけで下限が決まり、
    // 九九16回ぶんが上に乗る。この帯より外なら何かがおかしい。
    // ※ 帯を狭めないこと。狭めるとアンカーと同じものになる。
    run() {
      const p = C.getProfile('skilled');
      const t = 4 * (4 * C.COG.MUL_TABLE + 5 * C.COG.WRITE_PER_DIGIT)
        + 8 * 3 * C.COG.ADD_PER_COLUMN + 8 * C.COG.WRITE_PER_DIGIT;
      void p;
      return (t >= 20 && t <= 45) ? [] : [`${t.toFixed(1)}秒`];
    },
  },

  // ---- 時間とベットの連動が意味を持つか --------------------------------
  //
  // ポットを積むと計算時間が伸びる、という設計指示7が効いているかどうか。
  // 「短時間では無理、時間があれば解ける」の幅が無いとベットが意味を失う。
  {
    name: '重い式は短時間では解けない（6^9 / 大学生 / 30秒 < 15%）',
    run() {
      const a = acc('6^9', 'skilled', 30);
      return a < 0.15 ? [] : [`${(a * 100).toFixed(1)}%`];
    },
  },
  {
    name: '重い式も十分な時間があれば解ける（6^9 / 大学生 / 600秒 > 70%）',
    run() {
      const a = acc('6^9', 'skilled', 600);
      return a > 0.70 ? [] : [`${(a * 100).toFixed(1)}%`];
    },
  },
  {
    name: '時間を積む価値がある（6^9 / 大学生 は 30秒→600秒 で 50pt 以上伸びる）',
    run() {
      const d = acc('6^9', 'skilled', 600) - acc('6^9', 'skilled', 30);
      return d > 0.50 ? [] : [`${(d * 100).toFixed(1)}pt しか伸びない`];
    },
  },
  {
    name: '軽い式は短時間でも解ける（(4+6)^9 / 大学生 / 60秒 > 80%）',
    run() {
      const a = acc('(4+6)^9', 'skilled', 60);
      return a > 0.80 ? [] : [`${(a * 100).toFixed(1)}%`];
    },
  },
];

// ============================================================
// 2. スナップショット — 現在値の記録。目標ではない
// ============================================================
//
// 差が出たら「意図した変更か」を自分に聞く。意図どおりなら --snapshot で貼り替える。
// **ここの数字に合わせて定数をいじらないこと。** それをやると元の木阿弥になる。

const SNAPSHOT_FORMULAS = ['9*8', '6^6', '9!', '6^9', '9^8', '(8+3)!', '(4+6)^9', '(5*6)^7'];
const SNAPSHOT_TIME = 300;

/** 300秒での正答率（%）。--snapshot で再生成する */
const SNAPSHOT_ACC = {
  '9*8': [98.6, 99.3, 99.6, 99.8, 99.9],
  '6^6': [71.8, 89.8, 96.7, 98.2, 99.0],
  '9!': [78.6, 89.0, 95.7, 97.8, 99.2],
  '6^9': [34.7, 73.2, 91.4, 95.3, 97.4],
  '9^8': [43.9, 77.3, 94.6, 97.0, 98.4],
  '(8+3)!': [34.3, 69.1, 88.7, 94.8, 97.2],
  '(4+6)^9': [97.5, 98.5, 98.9, 99.2, 99.4],
  '(5*6)^7': [66.4, 88.6, 96.0, 99.3, 99.4],
};

/** 所要時間（秒）。--snapshot で再生成する */
const SNAPSHOT_TIME_S = {
  '9*8': [12, 12, 12, 11, 11],
  '6^6': [72, 46, 37, 31, 28],
  '9!': [62, 53, 47, 36, 25],
  '6^9': [157, 89, 69, 56, 48],
  '9^8': [139, 79, 56, 46, 40],
  '(8+3)!': [155, 105, 85, 63, 49],
  '(4+6)^9': [28, 26, 25, 23, 22],
  '(5*6)^7': [96, 59, 46, 24, 22],
};

/** ここを超える差だけ表示する。合わせにいくための閾値ではなく、目立たせるための閾値 */
const DRIFT_NOTICE = 3.0;      // pt / 秒

// ============================================================
// 表示
// ============================================================

const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);
const pct = (x) => (x * 100).toFixed(1);

function runRequirements() {
  console.log('=== 要件 ===\n');
  let failed = 0;
  for (const r of REQUIREMENTS) {
    const bad = r.run();
    if (bad.length === 0) {
      console.log(`  OK   ${r.name}`);
    } else {
      failed++;
      console.log(`  NG   ${r.name}`);
      for (const b of bad.slice(0, 6)) console.log(`         ${b}`);
      if (bad.length > 6) console.log(`         ...他 ${bad.length - 6} 件`);
    }
  }
  console.log(`\n  ${REQUIREMENTS.length - failed} / ${REQUIREMENTS.length} 通過\n`);
  return failed;
}

function driftTable(title, unit, snapshot, get) {
  console.log(`=== ${title} ===`);
  console.log(`（括弧内は記録との差。${DRIFT_NOTICE}${unit} 未満は表示しない）\n`);
  console.log(pad('式', 11) + LEVELS.map((lv) => padL(C.getProfile(lv).name, 18)).join(''));

  let moved = 0;
  for (const f of SNAPSHOT_FORMULAS) {
    let line = pad(f, 11);
    LEVELS.forEach((lv, i) => {
      const got = get(f, lv);
      const was = snapshot[f] ? snapshot[f][i] : null;
      let cell = got.toFixed(1);
      if (was !== null && Math.abs(got - was) >= DRIFT_NOTICE) {
        const d = got - was;
        cell += ` (${d > 0 ? '+' : ''}${d.toFixed(0)})`;
        moved++;
      }
      line += padL(cell, 18);
    });
    console.log(line);
  }
  console.log('');
  return moved;
}

function runSnapshot() {
  console.log('\n=== --snapshot: 貼り替える値 ===\n');
  const dump = (name, get, digits) => {
    console.log(`const ${name} = {`);
    for (const f of SNAPSHOT_FORMULAS) {
      const row = LEVELS.map((lv) => get(f, lv).toFixed(digits)).join(', ');
      console.log(`  '${f}': [${row}],`);
    }
    console.log('};\n');
  };
  dump('SNAPSHOT_ACC', (f, lv) => acc(f, lv, SNAPSHOT_TIME) * 100, 1);
  dump('SNAPSHOT_TIME_S', (f, lv) => required(f, lv), 0);
  console.log('※ 意図した変更のときだけ貼り替えること。\n');
}

function main() {
  const args = process.argv.slice(2);

  if (args.includes('--snapshot')) { runSnapshot(); return; }

  const failed = runRequirements();

  const m1 = driftTable(`${SNAPSHOT_TIME}秒での正答率（%）`, 'pt',
    SNAPSHOT_ACC, (f, lv) => acc(f, lv, SNAPSHOT_TIME) * 100);
  const m2 = driftTable('所要時間（秒）', '秒',
    SNAPSHOT_TIME_S, (f, lv) => required(f, lv));

  console.log('=== 筆算1回の初回誤り率（検算前）===\n');
  console.log(pad('', 8) + LEVELS.map((lv) => padL(C.getProfile(lv).name, 18)).join(''));
  for (const n of [2, 3, 4, 5, 7]) {
    let line = pad(`${n}桁×${n}桁`, 8);
    for (const lv of LEVELS) {
      const p = C.getProfile(lv);
      line += padL(`${pct(1 - Math.pow(1 - p.slipRate, n * n + n))}%`, 18);
    }
    console.log(line);
  }
  console.log('');

  if (args.includes('--curves')) {
    console.log('=== 正答率カーブ ===\n');
    const times = [10, 30, 60, 120, 300, 600];
    for (const f of SNAPSHOT_FORMULAS) {
      console.log(f);
      for (const lv of LEVELS) {
        console.log(`  ${pad(C.getProfile(lv).name, 14)}` +
          times.map((s) => padL(`${pct(acc(f, lv, s))}%`, 9)).join(''));
      }
      console.log(`  ${pad('', 14)}${times.map((s) => padL(`${s}s`, 9)).join('')}\n`);
    }
  }

  if (m1 + m2 > 0) {
    console.log(`記録と ${DRIFT_NOTICE} 以上ちがうセルが ${m1 + m2} 個ある。`);
    console.log('意図した変更なら --snapshot で貼り替える。');
    console.log('意図していないなら、直近でいじった定数を疑う。\n');
  }

  if (failed > 0) {
    console.error(`要件を ${failed} 件破っている`);
    process.exit(1);
  }
}

main();
