#!/usr/bin/env node
/**
 * tools/measure-card-values.js — 「その札を残す価値」を実測してテーブルにする
 *
 * ============================================================
 * 何のためのものか
 * ============================================================
 * 交換で「どの札を捨てるか」の順番は、長いあいだ手書きの表で決めていた。
 *
 *     STATIC_CARD_VALUE = { '^': 10, '!': 9, 'P': 5, '*': 4, '+': 3, '↑↑': 3 }
 *
 * 根拠は「べき乗は強そう」程度の感覚で、実測ではない。
 * 実際これのせいで `↑↑`（= `+` と同値）が数字の 4 や 5 より先に捨てられていた。
 *
 * ここでは同じ順番を **測って** 出す。定義はそのまま:
 *
 *     loss(c) = 今の最良効用 − E[ c を捨てて1枚引いた後の最良効用 ]
 *
 * 「捨てると効用がどれだけ落ちるか」なので、**大きいほど残すべき札**。
 * ランダムな手札を大量に配って平均を取る。
 *
 * ============================================================
 * なぜ実行時に毎回これを計算しないのか
 * ============================================================
 * できれば手札ごとに計算したい（`!` の価値は 9 を持っているかで変わる）。
 * だが1回の評価に候補列挙が要り、キャッシュを外すと 1.27ms かかる。
 * 交換1回あたり数十回まわすと 25〜500ms。学習は毎秒600回の交換判断を回すので、
 * **2〜3桁足りない**。
 *
 * なので **オフラインで測って表にし、実行時はただ引く**。
 * 手札の文脈が落ちるのは正直な弱点なので、下の「文脈」で
 * どのくらい効くのかも一緒に測って判断できるようにしてある。
 *
 *   node tools/measure-card-values.js            要約（順位が安定しているかを見る）
 *   node tools/measure-card-values.js --emit     js/ai.js に貼る表を出力
 *   node tools/measure-card-values.js --hands N  手札の枚数（既定 400）
 */

const path = require('path');
const ROOT = path.join(__dirname, '..');
const { buildDeck } = require(path.join(ROOT, 'js/game.js'));
const AI = require(path.join(ROOT, 'js/ai.js'));
const COG = require(path.join(ROOT, 'js/ai-cognition.js'));

const args = process.argv.slice(2);
const argOf = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : def;
};

const HANDS = argOf('--hands', 400);
const DRAWS = argOf('--draws', 6);     // 1枚引きを何回サンプルするか
const OPPONENTS = 2;
const MODEL = AI.OPPONENT_MODEL;

/** 札の種類キー。数字は値ごと、演算子は記号ごとに分ける */
function cardKey(c) {
  return c.type === 'number' ? `n${c.value}` : `o${c.value}`;
}

const ALL_KEYS = [];
for (let v = 2; v <= 9; v++) ALL_KEYS.push(`n${v}`);
for (const o of ['+', '*', '^', '!', 'P', '↑↑']) ALL_KEYS.push(`o${o}`);

function shuffled(rng) {
  const d = buildDeck(1);
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

function bestUtility(hand, t, profile) {
  const cs = AI.candidateSet(hand, profile);
  const b = AI.chooseCandidate(cs, t, profile, OPPONENTS, MODEL);
  return b ? b.utility : 0;
}

/**
 * 1つのレベル・1つの計算時間について loss を測る。
 * @returns {{sum:object, n:object, ctxSum:object, ctxN:object}}
 */
function measure(level, seconds, seed) {
  const profile = COG.getProfile(level);
  const rng = AI.makeRng(seed);
  const sum = {}, n = {};
  const ctxSum = {}, ctxN = {};       // 文脈: 手札に7以上の数字があるか

  for (let h = 0; h < HANDS; h++) {
    const deck = shuffled(rng);
    const hand = deck.slice(0, 7);
    const pool = deck.slice(7);        // 自分から見て「まだ見ていない札」
    const base = bestUtility(hand, seconds, profile);
    const bigDigit = hand.some(c => c.type === 'number' && Number(c.value) >= 7);

    const seen = new Set();
    for (let i = 0; i < hand.length; i++) {
      const key = cardKey(hand[i]);
      if (seen.has(key)) continue;     // 同じ種類は1回でよい
      seen.add(key);

      const kept = hand.slice();
      kept.splice(i, 1);
      let after = 0;
      for (let d = 0; d < DRAWS; d++) {
        const draw = pool[Math.floor(rng() * pool.length)];
        after += bestUtility(kept.concat([draw]), seconds, profile);
      }
      after /= DRAWS;

      const loss = base - after;
      sum[key] = (sum[key] || 0) + loss;
      n[key] = (n[key] || 0) + 1;
      const ck = `${key}|${bigDigit ? 'big' : 'small'}`;
      ctxSum[ck] = (ctxSum[ck] || 0) + loss;
      ctxN[ck] = (ctxN[ck] || 0) + 1;
    }
  }
  return { sum, n, ctxSum, ctxN };
}

function table(r) {
  const out = {};
  for (const k of ALL_KEYS) out[k] = r.n[k] ? r.sum[k] / r.n[k] : 0;
  return out;
}

function rankOf(t) {
  return Object.keys(t).sort((a, b) => t[b] - t[a]);
}

/** 2つの順位の一致度（スピアマン）*/
function spearman(a, b) {
  const ra = {}, rb = {};
  a.forEach((k, i) => { ra[k] = i; });
  b.forEach((k, i) => { rb[k] = i; });
  const nkeys = a.length;
  let d2 = 0;
  for (const k of a) d2 += (ra[k] - rb[k]) ** 2;
  return 1 - (6 * d2) / (nkeys * (nkeys * nkeys - 1));
}

const LEVELS = COG.AI_LEVEL_ORDER;
const TIMES = [60, 180, 600];

function main() {
  if (args.includes('--emit')) return emit();

  console.log(`=== 「その札を残す価値」を実測する ===`);
  console.log(`手札 ${HANDS} 通り × 1枚引き ${DRAWS} サンプル\n`);
  console.log('値 = 「その札を捨てて引き直したときに効用がどれだけ落ちるか」。大きいほど残すべき。\n');

  const results = {};
  for (const lv of LEVELS) {
    for (const t of TIMES) {
      results[`${lv}@${t}`] = table(measure(lv, t, 12345));
    }
  }

  const ref = results[`skilled@180`];
  const refRank = rankOf(ref);

  console.log('大学生・180秒 での順位（左ほど残すべき）:');
  console.log('  ' + refRank.map(k => `${k.slice(1)}(${ref[k].toFixed(3)})`).join('  '));

  console.log('\n--- 条件を変えても順位は同じか（スピアマン順位相関）---');
  for (const lv of LEVELS) {
    const row = TIMES.map((t) => {
      const s = spearman(refRank, rankOf(results[`${lv}@${t}`]));
      return `${t}秒 ${s.toFixed(2)}`;
    }).join('  ');
    console.log(`  ${COG.getProfile(lv).name.padEnd(14)} ${row}`);
  }

  console.log('\n--- 文脈（手札に7以上の数字があるか）で変わるか ---');
  const r = measure('skilled', 180, 999);
  const rows = [];
  for (const k of ALL_KEYS) {
    const big = r.ctxN[`${k}|big`] ? r.ctxSum[`${k}|big`] / r.ctxN[`${k}|big`] : 0;
    const small = r.ctxN[`${k}|small`] ? r.ctxSum[`${k}|small`] / r.ctxN[`${k}|small`] : 0;
    rows.push([k, big, small, big - small]);
  }
  rows.sort((a, b) => Math.abs(b[3]) - Math.abs(a[3]));
  console.log('  札      7以上あり  なし     差');
  for (const [k, big, small, d] of rows.slice(0, 6)) {
    console.log(`  ${k.slice(1).padEnd(6)} ${big.toFixed(3).padStart(8)} ${small.toFixed(3).padStart(8)} ${(d >= 0 ? '+' : '') + d.toFixed(3)}`);
  }

  console.log('\n--- 再現するか（独立な2回の測定で順位が一致するか）---');
  // ここが低ければ、測っているのはノイズであって「札の価値」ではない。
  // 手書きの表と比べる前に、まずこれを見ること。
  for (const t of TIMES) {
    const a1 = rankOf(table(measure('skilled', t, 111)));
    const a2 = rankOf(table(measure('skilled', t, 222)));
    const top4 = (r) => r.slice(0, 4).map(k => k.slice(1)).join(' ');
    console.log(`  大学生 ${String(t).padStart(3)}秒  順位相関 ${spearman(a1, a2).toFixed(2)}`
      + `   上位4  [${top4(a1)}] vs [${top4(a2)}]`);
  }

  console.log('\n--- 今の手書きの表との比較 ---');
  const hand1 = { 'o^': 10, 'o!': 9, 'oP': 5, 'o*': 4, 'o+': 3, 'o↑↑': 3 };
  for (let v = 2; v <= 9; v++) hand1[`n${v}`] = v * 0.8;
  const oldRank = rankOf(hand1);
  console.log('  手書き: ' + oldRank.map(k => k.slice(1)).join(' '));
  console.log('  実測  : ' + refRank.map(k => k.slice(1)).join(' '));
  console.log(`  順位相関 ${spearman(oldRank, refRank).toFixed(2)}`);
}

/**
 * 出荷する表の形。
 *
 * 400手の測定で「再現するもの」と「しないもの」がはっきり分かれた。
 *
 *   再現する（独立2回の順位相関 0.84〜0.91）:
 *     ・演算子 ≫ 数字。^ > ! > ↑↑ > * > + ≈ P
 *     ・手札に7以上の数字があると演算子の価値が跳ね上がる（^ は 0.008 → 0.075）
 *     ・計算時間が短いと演算子の優位が消える（重い式を作れないので）
 *
 *   再現しない（数字どうしの順位は測るたびに入れ替わる）:
 *     ・どの数字を残すか。値は全部 ±0.015 の中に収まり、9 が 4 に負けたりする
 *     ・レベルによる違い。時間と文脈の効果に埋もれる
 *
 * なので **時間 × 文脈** の2軸だけで表を作り、レベルは平均する。
 * 数字を細かく区別しても意味が無いことは測定が示しているので、
 * 手書きの表がやっていた「9 > 8 > 7 > …」は**捨てる**。
 */
const TIME_BUCKETS = [['short', 60], ['long', 300]];
const CTX_BUCKETS = ['big', 'small'];

/** 出荷用: [時間バケツ][文脈バケツ][札] の平均 loss。レベルは平均する */
function emitTable(seed) {
  const acc = {};
  for (const [tb, secs] of TIME_BUCKETS) {
    acc[tb] = {};
    for (const cb of CTX_BUCKETS) acc[tb][cb] = { sum: {}, n: {} };
    for (const lv of LEVELS) {
      const r = measure(lv, secs, seed);
      for (const cb of CTX_BUCKETS) {
        for (const k of ALL_KEYS) {
          const ck = `${k}|${cb}`;
          if (!r.ctxN[ck]) continue;
          acc[tb][cb].sum[k] = (acc[tb][cb].sum[k] || 0) + r.ctxSum[ck];
          acc[tb][cb].n[k] = (acc[tb][cb].n[k] || 0) + r.ctxN[ck];
        }
      }
    }
  }
  const out = {};
  for (const [tb] of TIME_BUCKETS) {
    out[tb] = {};

    // 文脈を無視した平均。下の「穴」を埋めるのに使う
    const flatSum = {}, flatN = {};
    for (const cb of CTX_BUCKETS) {
      for (const k of ALL_KEYS) {
        flatSum[k] = (flatSum[k] || 0) + (acc[tb][cb].sum[k] || 0);
        flatN[k] = (flatN[k] || 0) + (acc[tb][cb].n[k] || 0);
      }
    }

    for (const cb of CTX_BUCKETS) {
      out[tb][cb] = {};
      for (const k of ALL_KEYS) {
        const a2 = acc[tb][cb];
        // 構造的に存在しないセルがある。「7以上の数字なし」の手札に 7 は入らないので
        // n7/n8/n9 × small はサンプルが 0 件。ここを 0 で埋めてはいけない
        // （0 は「価値が無い」と読めてしまう。実際には「測っていない」）。
        // 文脈を無視した平均で埋め、下の MISSING に記録して分かるようにする。
        if (a2.n[k]) {
          out[tb][cb][k] = a2.sum[k] / a2.n[k];
        } else {
          out[tb][cb][k] = flatN[k] ? flatSum[k] / flatN[k] : 0;
          (out.missing = out.missing || []).push(`${tb}/${cb}/${k}`);
        }
      }
    }
  }
  return out;
}

function emit() {
  const t1 = emitTable(12345);
  const t2 = emitTable(54321);        // 再現性の確認用（独立なシード）

  console.error('--- 出荷する表の再現性（独立2回の順位相関）---');
  for (const [tb] of TIME_BUCKETS) {
    for (const cb of CTX_BUCKETS) {
      const s1 = spearman(rankOf(t1[tb][cb]), rankOf(t2[tb][cb]));
      console.error(`  ${tb}/${cb}  ${s1.toFixed(2)}   ` +
        rankOf(t1[tb][cb]).slice(0, 5).map(k => k.slice(1)).join(' '));
    }
  }

  // 2回の平均を出荷する。片方だけだとシードのくせが残る
  if (t1.missing && t1.missing.length) {
    console.error('\n--- サンプルが無かったセル（文脈を無視した平均で埋めた）---');
    console.error('  ' + t1.missing.join(' '));
    console.error('  ※「7以上の数字なし」の手札に 7/8/9 は入らないので、構造的に空になる');
  }

  console.log('// tools/measure-card-values.js --emit が出力。手で書き換えないこと。');
  console.log('const CARD_KEEP_VALUE = {');
  for (const [tb] of TIME_BUCKETS) {
    console.log(`  ${tb}: {`);
    for (const cb of CTX_BUCKETS) {
      const body = ALL_KEYS
        .map(k => `'${k}': ${((t1[tb][cb][k] + t2[tb][cb][k]) / 2).toFixed(4)}`)
        .join(', ');
      console.log(`    ${cb}: { ${body} },`);
    }
    console.log('  },');
  }
  console.log('};');
}

main();
