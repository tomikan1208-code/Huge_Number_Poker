/**
 * ai-lab.js — AIテスト場（ai-lab.html）
 *
 * ============================================================
 * これは何か
 * ============================================================
 * CPU の正答率モデル（ai-cognition.js）を、ゲームを回さずに直接叩くための実験台。
 *
 *   カードを並べて式を作る → 計算時間（秒）と難易度を指定する
 *   → システムの正解値 / CPUの申告 / 正誤 / 正答率 が出る
 *
 * ゲーム本体のロジックはここには一切書かない。
 * すべて engine.js / ai-cognition.js / ai.js の公開APIを呼ぶだけにしてある。
 * そうしないと「ラボでは通るのに本編では違う」という最悪の事態になる。
 *
 * 正答率を2通りで出しているのは、モデルの実装を相互検証するため:
 *   理論値 … accuracyUnderTime(analysis, 秒, profile).pCorrect
 *   実測値 … produceSubmission() を N 回回して当たった割合
 * さらに申告文字列を judgeDeclaration() に通し直して、
 * produceSubmission が「正解」と言った申告が本当に判定を通るかも数えている。
 */

(function () {
  'use strict';

  const FE = window.FormulaEvaluator;
  const COGN = window.AICognition;
  const AILib = window.AI;
  const esc = window.escapeHtml;

  const LEVELS = COGN.AI_LEVEL_ORDER;
  const LEVEL_COLOR = {
    novice: '#9a9ab0',
    casual: '#4a8fd6',
    skilled: '#4ade80',
    expert: '#f5c842',
    master: '#e06a6a',
  };

  const MAX_CARDS = window.MAX_FORMULA_CARDS || 5;  // 括弧を除いた使用可能枚数
  const HAND_SIZE = window.HAND_SIZE || 7;
  const SWEEP_MIN = 10;
  const SWEEP_MAX = 600;

  const $ = (id) => document.getElementById(id);

  // ============================================================
  // 表示ユーティリティ
  // ============================================================

  const pct = (x) => `${(x * 100).toFixed(1)}%`;

  function rateClass(p) {
    return p >= 0.7 ? 'rate-high' : p >= 0.35 ? 'rate-mid' : 'rate-low';
  }

  function formatSeconds(s) {
    if (!isFinite(s)) return '∞';
    if (s < 60) return `${s.toFixed(1)}秒`;
    if (s < 3600) return `${Math.floor(s / 60)}分${Math.round(s % 60)}秒`;
    return `${(s / 3600).toFixed(1)}時間`;
  }

  /** 二項分布の95%信頼区間の半幅 */
  function ciHalfWidth(p, n) {
    if (!n) return 0;
    return 1.96 * Math.sqrt(Math.max(0, p * (1 - p)) / n);
  }

  /** 長すぎる申告文字列を丸める（サンプル表示用） */
  function shorten(s, max = 30) {
    const str = String(s);
    return str.length <= max ? str : `${str.slice(0, max)}…(${str.length}文字)`;
  }

  // ============================================================
  // カード
  // ============================================================
  //
  // builder.js の createStandardCardElement と同じ DOM を作る。
  // builder.js 自体を読み込まないのは、あれがD&Dの状態機械ごと付いてくるため。
  // 見た目は css/style.css の .card 系をそのまま使うので本編と一致する。

  const CARD_DEFS = window.CARD_DEFS;
  const SUITS = ['♠', '♥', '♦', '♣'];

  let cardSeq = 0;

  function numberCard(n) {
    return {
      id: `lab-n${cardSeq++}`, type: 'number', value: Number(n),
      display: String(n), suit: SUITS[Math.floor(Math.random() * SUITS.length)],
    };
  }

  function operatorCard(op) {
    const def = CARD_DEFS[op];
    return {
      id: `lab-o${cardSeq++}`, type: 'operator', value: op,
      display: def.display, color: def.color, label: def.label,
    };
  }

  function parenCard(ch) {
    return { id: `lab-p${cardSeq++}`, type: 'paren', value: ch };
  }

  function createCardEl(card) {
    const el = document.createElement('div');
    el.className = 'card';

    if (card.type === 'number') {
      el.classList.add('number-card');
      el.innerHTML = `
        <span class="card-suit">${esc(card.suit || '')}</span>
        <span class="card-face">${esc(String(card.display != null ? card.display : card.value))}</span>
        <span class="card-corner corner-tl"></span>
        <span class="card-corner corner-tr"></span>
        <span class="card-corner corner-bl"></span>
        <span class="card-corner corner-br"></span>`;
      el.setAttribute('aria-label', `数字カード ${card.value}`);
    } else if (card.type === 'paren') {
      el.classList.add('paren-card');
      el.innerHTML = `<span class="card-face">${esc(card.value)}</span>`;
      el.setAttribute('aria-label', card.value === '(' ? '開き括弧' : '閉じ括弧');
    } else {
      el.classList.add('operator', `op-${card.color || 'green'}`);
      el.innerHTML = `
        <span class="card-face">${esc(card.display || card.value)}</span>
        <span class="card-label">${esc(card.label || '')}</span>`;
      el.setAttribute('aria-label', `演算子カード ${card.label || card.value}`);
    }
    return el;
  }

  const NUMBER_VALUES = [2, 3, 4, 5, 6, 7, 8, 9];
  const OPERATOR_VALUES = ['+', '*', '^', '!', 'P', '↑↑'];

  /** パレット（クリックで追加）を描く */
  function renderPalette(container, cards, onPick) {
    container.innerHTML = '';
    for (const card of cards) {
      const el = createCardEl(card);
      el.addEventListener('click', () => onPick(card));
      container.appendChild(el);
    }
  }

  // ============================================================
  // 数式テキスト ⇄ カード列
  // ============================================================

  function seqToText(seq) {
    return seq.map((c) => c.value).join('');
  }

  /**
   * 数式文字列をカード列に変換する。
   * カードで表せない文字が混ざっていたら null（＝テキスト専用モード）。
   */
  function textToSeq(text) {
    const s = FE.normalize(text);
    const out = [];
    let i = 0;
    while (i < s.length) {
      const two = s.slice(i, i + 2);
      if (two === '↑↑') { out.push(operatorCard('↑↑')); i += 2; continue; }
      const ch = s[i];
      if (ch >= '2' && ch <= '9') out.push(numberCard(ch));
      else if (ch === '(' || ch === ')') out.push(parenCard(ch));
      else if (OPERATOR_VALUES.indexOf(ch) >= 0) out.push(operatorCard(ch));
      else return null;   // 0,1 や未知の文字 — カードには無い
      i += 1;
    }
    return out;
  }

  function countCards(seq) {
    return seq.filter((c) => c.type !== 'paren').length;
  }

  // ============================================================
  // 状態
  // ============================================================

  const state = {
    seq: [],        // カード列（null ならテキスト専用モード）
    hand: [],       // 手札タブの7枚
  };

  // ============================================================
  // 式タブ — 入力まわり
  // ============================================================

  function renderBuild() {
    const area = $('build-area');
    area.innerHTML = '';

    if (state.seq === null) {
      area.classList.add('is-empty');
      area.innerHTML = '<span>カードで表せない式（テキスト入力のまま判定する）</span>';
      $('card-count').textContent = '使用 – / 5 枚';
      $('card-count').classList.remove('over');
      return;
    }

    if (state.seq.length === 0) {
      area.classList.add('is-empty');
      area.innerHTML = '<span>ここにカードが並ぶ</span>';
    } else {
      area.classList.remove('is-empty');
      state.seq.forEach((card, idx) => {
        const el = createCardEl(card);
        el.title = 'クリックで削除';
        el.addEventListener('click', () => {
          state.seq.splice(idx, 1);
          syncFromSeq();
        });
        area.appendChild(el);
      });
    }

    const used = countCards(state.seq);
    const counter = $('card-count');
    counter.textContent = `使用 ${used} / ${MAX_CARDS} 枚`;
    counter.classList.toggle('over', used > MAX_CARDS);
    renderPaletteLimits(used);
  }

  /** 5枚使い切ったら数字・演算子パレットを灰色にする（括弧は無制限） */
  function renderPaletteLimits(used) {
    const full = state.seq !== null && used >= MAX_CARDS;
    ['palette-numbers', 'palette-operators'].forEach((id) => {
      $(id).querySelectorAll('.card').forEach((el) => {
        el.classList.toggle('card-limited', full);
      });
    });
  }

  function renderPreview() {
    const text = $('formula-text').value.trim();
    const preview = $('formula-preview');
    const errBox = $('formula-error');

    if (!text) {
      preview.innerHTML = '<span class="lab-muted" style="font-size:1rem;">式が空</span>';
      errBox.textContent = '';
      return;
    }

    preview.innerHTML = FE.toMathHTML(text) || esc(text);

    const messages = [];
    const ev = safeEvaluate(text);
    if (!ev.ok) messages.push(`<span class="lab-error">${esc(ev.error || '式として無効')}</span>`);
    if (state.seq !== null && countCards(state.seq) > MAX_CARDS) {
      messages.push(`<span class="lab-warn">本編では括弧を除き ${MAX_CARDS} 枚までしか使えない</span>`);
    }
    if (state.seq === null) {
      messages.push('<span class="lab-warn">カードに無い文字が入っている（2〜9 と演算子・括弧のみ）</span>');
    }
    errBox.innerHTML = messages.join(' / ');
  }

  function safeEvaluate(formula) {
    try {
      return FE.evaluate(formula);
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  function syncFromSeq() {
    $('formula-text').value = seqToText(state.seq);
    renderBuild();
    renderPreview();
    autoRun();
  }

  function syncFromText() {
    state.seq = textToSeq($('formula-text').value);
    renderBuild();
    renderPreview();
    autoRun();
  }

  function appendCard(card) {
    // テキスト専用モード（カードで表せない式）のときは、文字として足すだけにする
    if (state.seq === null) {
      $('formula-text').value += card.value;
      syncFromText();
      return;
    }
    if (card.type !== 'paren' && countCards(state.seq) >= MAX_CARDS) return;
    state.seq.push(card);
    syncFromSeq();
  }

  // ============================================================
  // 式タブ — 計算
  // ============================================================

  function readConditions() {
    return {
      level: $('level').value,
      seconds: Math.max(1, Number($('seconds').value) || 1),
      trials: Math.max(1, Math.min(20000, Math.floor(Number($('trials').value) || 1))),
      opponents: Math.max(1, Math.floor(Number($('opponents').value) || 1)),
      seed: Math.floor(Number($('seed').value) || 0),
      allLevels: $('mc-all-levels').checked,
    };
  }

  /**
   * 1レベルぶんの理論値＋実測値をまとめて出す。
   *
   * formulaKey は analyzeFormula のキャッシュキー（`式|レベル`）になる。
   * ast と value を渡しているので解析自体には使われないが、
   * 空文字を渡すと別の式どうしがキャッシュを共有してしまうので必ず実体を渡すこと。
   */
  function evaluateLevel(levelId, formulaKey, ev, cond, runMonteCarlo) {
    const profile = COGN.getProfile(levelId);
    const analysis = COGN.analyzeFormula(
      { formula: formulaKey, ast: ev.ast, value: ev.value }, profile);
    const acc = COGN.accuracyUnderTime(analysis, cond.seconds, profile);

    const row = { levelId, profile, analysis, acc, mc: null };
    if (!runMonteCarlo) return row;

    const cand = {
      formula: formulaKey,
      value: ev.value,
      analysis,
      slog: AILib.slogScore(ev.value),
    };
    row.mc = monteCarlo(cand, cond, profile, ev.value);
    return row;
  }

  /**
   * produceSubmission を N 回回す。
   * 申告文字列は judgeDeclaration に通し直して、モデルの自己整合性も確かめる。
   */
  function monteCarlo(cand, cond, profile, systemValue) {
    const rng = AILib.makeRng(cond.seed >>> 0);
    const model = AILib.OPPONENT_MODEL;
    let correct = 0, wrong = 0, timedOut = 0, mismatch = 0;
    const tiers = {};
    const samples = [];

    for (let i = 0; i < cond.trials; i++) {
      const sub = AILib.produceSubmission(cand, cond.seconds, profile, cond.opponents, rng, model);

      if (sub.timedOut) {
        timedOut++;
      } else if (sub.correct) {
        correct++;
      } else {
        wrong++;
        if (sub.errorTier) tiers[sub.errorTier] = (tiers[sub.errorTier] || 0) + 1;
      }

      // 申告の正誤を判定器で取り直す（produceSubmission の自己申告と食い違わないか）
      if (sub.declared !== null && sub.declared !== undefined) {
        let judged = null;
        try { judged = FE.judgeDeclaration(systemValue, sub.declared).ok; } catch (e) { judged = false; }
        if (judged !== !!sub.correct) mismatch++;
      }

      if (samples.length < 20) {
        samples.push({
          declared: sub.declared, correct: !!sub.correct,
          timedOut: !!sub.timedOut, tier: sub.errorTier || null,
        });
      }
    }

    const n = cond.trials;
    return {
      n, correct, wrong, timedOut, mismatch, tiers, samples,
      rate: correct / n,
      ci: ciHalfWidth(correct / n, n),
    };
  }

  function run() {
    const text = $('formula-text').value.trim();
    if (!text) { $('results').classList.add('hidden'); return; }

    const ev = safeEvaluate(text);
    if (!ev.ok || !ev.value) {
      $('results').classList.add('hidden');
      renderPreview();
      return;
    }

    const cond = readConditions();
    const formulaKey = ev.normalized || text;
    const t0 = performance.now();

    const rows = LEVELS.map((lv) =>
      evaluateLevel(lv, formulaKey, ev, cond, cond.allLevels || lv === cond.level));
    const current = rows.find((r) => r.levelId === cond.level) || rows[0];

    renderAnswer(ev, current);
    renderRates(current, cond);
    renderSamples(current);
    renderTrace(current);
    renderStats(current, cond);
    renderLevelTable(rows, cond);
    renderSweep(formulaKey, ev, cond);

    $('run-time').textContent = `計算 ${Math.round(performance.now() - t0)} ms`;
    $('results').classList.remove('hidden');
  }

  // ---------- 結果の描画 ----------

  const MODE_LABEL = {
    exact: '厳密値で答える（exact）',
    digits: '桁数で答える（digits）',
    scale: '規模で答える（scale）',
  };

  function renderAnswer(ev, row) {
    const value = ev.value;
    const mode = FE.declarationMode(value);

    const tag = $('answer-mode');
    tag.textContent = MODE_LABEL[mode] || mode;
    tag.className = `lab-tag mode-${mode}`;

    // 「本当に書かなければならない文字列」を出す。toFullString() は40字で切るので使わない。
    let full = null;
    try { full = AILib.correctDeclaration(value); } catch (e) { full = null; }
    if (full === null) full = value.toString();

    $('answer-value').textContent = full;

    let digitsInfo = '';
    try {
      const d = value.digitCountHuge();
      digitsInfo = d.isExactValue() ? `${d.v.toString()}桁` : `桁数も書けない規模（${value.tierLabel()}）`;
    } catch (e) { digitsInfo = value.tierLabel(); }
    $('answer-digits').textContent = `${digitsInfo} ／ 概算 ${value.toString()} ／ slog ${AILib.slogScore(value).toFixed(2)}`;

    $('answer-hint').textContent = FE.declarationHint(value);
  }

  function renderRates(row, cond) {
    const p = row.acc.pCorrect;
    const theory = $('rate-theory');
    theory.textContent = pct(p);
    theory.className = `lab-rate-value ${rateClass(p)}`;
    $('rate-theory-sub').textContent =
      `間に合う確率 ${row.acc.pFinish.toFixed(2)} ／ 見直し ${row.acc.rechecks}回 ` +
      `／ 誤り ${pct(row.acc.errFirst)} → ${pct(row.acc.errAfter)}`;

    $('rate-caption').textContent =
      `${row.profile.name}（${row.profile.label}） / ${cond.seconds}秒`;

    const measured = $('rate-measured');
    const breakdown = $('rate-breakdown');
    if (!row.mc) {
      measured.textContent = '–';
      measured.className = 'lab-rate-value';
      $('rate-measured-sub').textContent = '';
      breakdown.innerHTML = '';
      return;
    }

    const mc = row.mc;
    measured.textContent = pct(mc.rate);
    measured.className = `lab-rate-value ${rateClass(mc.rate)}`;
    $('rate-measured-sub').textContent =
      `${mc.n} 回中 ${mc.correct} 回正解（95%CI ±${(mc.ci * 100).toFixed(1)}pt）`;

    const tierRows = Object.keys(mc.tiers)
      .sort((a, b) => mc.tiers[b] - mc.tiers[a])
      .map((k) => `<div>　外し方 ${esc(k)}: ${mc.tiers[k]}</div>`)
      .join('');

    breakdown.innerHTML = `
      <div>✅ 正解: ${mc.correct}</div>
      <div>❌ 誤答: ${mc.wrong}</div>
      <div>⏱ 時間切れ: ${mc.timedOut}</div>
      ${tierRows}`;

    const check = $('selfcheck');
    if (mc.mismatch > 0) {
      check.innerHTML = `<span class="lab-error">⚠ 申告 ${mc.mismatch} 件で、AIの自己申告と judgeDeclaration の判定が食い違った（モデルの不整合）。</span>`;
    } else {
      check.innerHTML = `AIの申告 ${mc.n - mc.timedOut} 件すべてについて、engine.js の judgeDeclaration で判定し直しても同じ結果になった。`;
    }
  }

  function renderSamples(row) {
    const box = $('samples');
    box.innerHTML = '';
    if (!row.mc) {
      box.innerHTML = '<span class="lab-muted">このレベルの実測は回していない</span>';
      return;
    }
    for (const s of row.mc.samples) {
      const el = document.createElement('span');
      if (s.timedOut) {
        el.className = 'lab-sample to';
        el.innerHTML = '⏱ 時間切れ（提出できず）';
      } else {
        el.className = `lab-sample ${s.correct ? 'ok' : 'ng'}`;
        el.innerHTML = `${s.correct ? '✅' : '❌'} ${esc(shorten(s.declared))}` +
          (s.tier ? `<span class="tier">${esc(s.tier)}</span>` : '');
        el.title = String(s.declared);
      }
      box.appendChild(el);
    }
  }

  /** 手順の種類ごとの色。どこに時間を食われているか一目で分かるようにする */
  const TRACE_KIND = {
    mul: ['筆算（掛け算）', '#4a8fd6'],
    add: ['筆算（足し算）', '#3da97a'],
    recall: ['記憶から引く', '#f5c842'],
    write: ['書くだけ', '#9a9ab0'],
    setup: ['画面の操作', '#7a4fa3'],
    other: ['段取り', '#6a6a80'],
  };

  function renderTrace(row) {
    const body = $('trace-table');
    const trace = row.analysis.trace || [];

    if (trace.length === 0) {
      body.innerHTML = '<tr><td colspan="6" class="lab-muted">内訳を取れない式（対数流儀 / 解けない式）</td></tr>';
      $('trace-summary').textContent = '';
      return;
    }

    const total = trace.reduce((s, t) => s + t.time, 0);
    let cum = 0;
    body.innerHTML = trace.map((t, i) => {
      cum += t.time;
      const [kindLabel, color] = TRACE_KIND[t.kind] || TRACE_KIND.other;
      return `
        <tr>
          <td class="num">${i + 1}</td>
          <td class="lab-formula-cell">${esc(t.label)}
            <span class="lab-muted">／ ${esc(kindLabel)}</span></td>
          <td class="num">${t.time.toFixed(1)}</td>
          <td class="num">${cum.toFixed(1)}</td>
          <td class="num">${t.risk > 0 ? pct(t.risk) : '—'}</td>
          <td class="lab-bar-cell">
            <span class="lab-bar" style="width:${Math.max(2, (t.time / total) * 150)}px;background:${color};"></span>
          </td>
        </tr>`;
    }).join('');

    // 種類ごとの小計
    const byKind = {};
    for (const t of trace) byKind[t.kind] = (byKind[t.kind] || 0) + t.time;
    const parts = Object.keys(byKind)
      .sort((a, b) => byKind[b] - byKind[a])
      .map((k) => `${(TRACE_KIND[k] || TRACE_KIND.other)[0]} ${byKind[k].toFixed(1)}秒`)
      .join(' ／ ');

    $('trace-summary').innerHTML =
      `合計 ${total.toFixed(1)}秒 ＝ ${esc(parts)}<br>` +
      `内訳の秒数は、演算子の切替・計算の速さ・作業記憶の超過を反映済み` +
      `（合計が所要時間に一致する）。画面の操作と答えの入力は計算の速さで割っていない。`;
  }

  function renderStats(row, cond) {
    const a = row.analysis;
    const acc = row.acc;
    const items = [
      ['所要時間（初回）', formatSeconds(a.requiredTime)],
      ['うち計算', formatSeconds(a.calcTime || 0)],
      ['うち操作＋入力', formatSeconds((a.setupTime || 0) + (a.transcribe || 0))],
      ['与えた時間', formatSeconds(cond.seconds)],
      ['余裕比 ratio', acc.ratio.toFixed(2)],
      ['間に合う確率', acc.pFinish.toFixed(3)],
      ['焦り係数 alpha', acc.alpha.toFixed(2)],
      ['見直せる回数', `${acc.rechecks} 回`],
      ['初回の誤り率', pct(acc.errFirst)],
      ['見直し後の誤り率', pct(acc.errAfter)],
      ['うち検算で取れない', pct(acc.systematic)],
      ['検算の発見率', row.profile.checkRate.toFixed(2)],
      ['作業記憶 wmPeak', `${a.wmPeak.toFixed(1)} / 容量 ${row.profile.wmCapacity}`],
      ['WM超過', a.wmOverload.toFixed(2)],
      ['手順の正確さ pSteps', a.pSteps.toFixed(3)],
      ['WM由来 pWm', a.pWm.toFixed(3)],
      ['答え方由来 pMode', a.pMode.toFixed(3)],
      ['一発勝負の正答率 pBase', a.pBase.toFixed(3)],
      ['難易度スカラー', a.difficulty.toFixed(3)],
      ['演算子の切替', `${a.switches} 回`],
      ['log10の誤差 σ', isFinite(a.sigma) ? a.sigma.toPrecision(3) : '絞り込み不能'],
    ];

    $('stats').innerHTML = items
      .map(([k, v]) => `<div class="lab-stat"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`)
      .join('');

    const notes = (a.notes || []).slice();
    if (a.blocked) {
      notes.push('この式は「解けない」に分類されている（禁止テトレーション、または未修得の手法）。正答率0%は仕様。');
    } else if (a.pMode <= 0) {
      notes.push('厳密値以外の答え方（桁数・規模）は設計上いつでも正答率0%（COG.NON_EXACT_ACCURACY = 0）。バグではない。');
    }
    $('notes').innerHTML = notes.length
      ? notes.map((n) => `<li>${esc(n)}</li>`).join('')
      : '<li class="lab-muted">特記事項なし（素直に解ける式）</li>';
  }

  function renderLevelTable(rows, cond) {
    $('level-table').innerHTML = rows.map((r) => {
      const p = r.acc.pCorrect;
      const measured = r.mc ? pct(r.mc.rate) : '–';
      const color = LEVEL_COLOR[r.levelId];
      return `
        <tr class="${r.levelId === cond.level ? 'is-current' : ''}">
          <td>${esc(r.profile.name)}<span class="lab-muted">（${esc(r.profile.label)}）</span></td>
          <td class="num">${esc(formatSeconds(r.analysis.requiredTime))}</td>
          <td class="num">${r.acc.ratio.toFixed(2)}</td>
          <td class="num">${pct(p)}</td>
          <td class="num">${measured}</td>
          <td class="lab-bar-cell">
            <span class="lab-bar" style="width:${Math.max(2, p * 120)}px;background:${color};"></span>
          </td>
        </tr>`;
    }).join('');
  }

  // ---------- 時間スイープ ----------

  function sweepPoints() {
    const pts = [];
    const steps = 26;
    for (let i = 0; i < steps; i++) {
      const t = SWEEP_MIN * Math.pow(SWEEP_MAX / SWEEP_MIN, i / (steps - 1));
      pts.push(t);
    }
    return pts;
  }

  function renderSweep(formulaKey, ev, cond) {
    const W = 720, H = 272;
    const padL = 46, padR = 14, padT = 14, padB = 44;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;

    const lx0 = Math.log(SWEEP_MIN), lx1 = Math.log(SWEEP_MAX);
    const X = (t) => padL + (Math.log(t) - lx0) / (lx1 - lx0) * plotW;
    const Y = (p) => padT + (1 - p) * plotH;

    const times = sweepPoints();
    const series = LEVELS.map((lv) => {
      const profile = COGN.getProfile(lv);
      const analysis = COGN.analyzeFormula(
        { formula: formulaKey, ast: ev.ast, value: ev.value }, profile);
      const pts = times.map((t) => [X(t), Y(COGN.accuracyUnderTime(analysis, t, profile).pCorrect)]);
      return { lv, color: LEVEL_COLOR[lv], name: profile.name, pts };
    });

    let svg = `<svg class="lab-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="計算時間と正答率のグラフ">`;

    for (let p = 0; p <= 1.0001; p += 0.25) {
      const y = Y(p);
      svg += `<line class="grid" x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}"/>`;
      svg += `<text class="tick" x="${padL - 8}" y="${y + 4}" text-anchor="end">${Math.round(p * 100)}%</text>`;
    }

    for (const t of [10, 20, 30, 60, 120, 300, 600]) {
      const x = X(t);
      svg += `<line class="grid" x1="${x}" y1="${padT}" x2="${x}" y2="${H - padB}"/>`;
      svg += `<text class="tick" x="${x}" y="${H - padB + 16}" text-anchor="middle">${t}</text>`;
    }
    svg += `<text class="tick" x="${W - padR}" y="${H - 4}" text-anchor="end">計算時間（秒・対数）</text>`;
    svg += `<line class="axis" x1="${padL}" y1="${padT}" x2="${padL}" y2="${H - padB}"/>`;
    svg += `<line class="axis" x1="${padL}" y1="${H - padB}" x2="${W - padR}" y2="${H - padB}"/>`;

    if (cond.seconds >= SWEEP_MIN && cond.seconds <= SWEEP_MAX) {
      const x = X(cond.seconds);
      svg += `<line class="nowline" x1="${x}" y1="${padT}" x2="${x}" y2="${H - padB}"/>`;
      svg += `<text class="tick" x="${x + 5}" y="${padT + 12}" fill="#f5c842">いま ${cond.seconds}秒</text>`;
    }

    for (const s of series) {
      const d = s.pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
      svg += `<path class="series" d="${d}" stroke="${s.color}"/>`;
    }
    svg += '</svg>';

    $('sweep-chart').innerHTML = svg;
    $('sweep-legend').innerHTML = series.map((s) =>
      `<span><i class="lab-swatch" style="background:${s.color}"></i>${esc(s.name)}</span>`).join('');
  }

  // ============================================================
  // チューニングパネル
  // ============================================================
  //
  // COG は素のオブジェクトなので、書き換えれば即座にモデルの挙動が変わる。
  // ただし analyzeFormula は formula|profile.id でメモ化されているので、
  // 書き換えたらキャッシュを捨てないと反映されない。

  const TUNABLE = [
    ['RECHECK_FACTOR', '検算1回の時間比', 0.05],
    ['MAX_RECHECKS', '見直しの上限回数', 1],
    ['SYSTEMATIC_BASE', '検算で取れない誤りの下限', 0.02],
    ['SYSTEMATIC_SLOPE', '同・難易度の効き', 0.05],
    ['MUL_PER_PARTIAL', '部分積1つの秒数', 0.05],
    ['MUL_PER_DIGIT', '桁揃え+加算の秒数', 0.05],
    ['SETUP_TIME', '式制作＋回答入力（秒）', 1],
    ['WRITE_PER_DIGIT', '数字1文字を書く秒数', 0.05],
    ['TIME_SIGMA', '所要時間のばらつき σ', 0.05],
    ['RUSH_THRESHOLD', '焦り始める余裕比', 0.05],
    ['RUSH_STRENGTH', '焦りの強さ', 0.1],
    ['WM_TIME_PENALTY', 'WM超過→時間', 0.05],
    ['WM_ACC_PENALTY', 'WM超過→正答率', 0.05],
    ['P_MAX', '正答率の上限', 0.001],
  ];

  const TUNE_DEFAULTS = {};

  function initTunePanel() {
    const grid = $('tune-grid');
    grid.innerHTML = TUNABLE.map(([key, label, step]) => {
      TUNE_DEFAULTS[key] = COGN.COG[key];
      return `
        <div class="lab-field">
          <label for="tune-${key}">${esc(label)}<br>${esc(key)}</label>
          <input id="tune-${key}" type="number" step="${step}" value="${COGN.COG[key]}">
        </div>`;
    }).join('');

    TUNABLE.forEach(([key]) => {
      $(`tune-${key}`).addEventListener('change', () => {
        const v = Number($(`tune-${key}`).value);
        if (!isFinite(v)) return;
        COGN.COG[key] = v;
        clearModelCaches();
        run();
      });
    });

    $('btn-tune-reset').addEventListener('click', () => {
      TUNABLE.forEach(([key]) => {
        COGN.COG[key] = TUNE_DEFAULTS[key];
        $(`tune-${key}`).value = TUNE_DEFAULTS[key];
      });
      clearModelCaches();
      run();
    });
  }

  function clearModelCaches() {
    if (COGN.clearAnalysisCache) COGN.clearAnalysisCache();
    if (AILib.clearCaches) AILib.clearCaches();
  }

  // ============================================================
  // 手札タブ
  // ============================================================

  function renderHand() {
    const area = $('hand-area');
    area.innerHTML = '';
    if (state.hand.length === 0) {
      area.innerHTML = '<span class="lab-empty-msg">まだ1枚も無い</span>';
    } else {
      state.hand.forEach((card, idx) => {
        const el = createCardEl(card);
        el.title = 'クリックで削除';
        el.addEventListener('click', () => {
          state.hand.splice(idx, 1);
          renderHand();
        });
        area.appendChild(el);
      });
    }
    $('hand-count').textContent = `${state.hand.length} / ${HAND_SIZE} 枚`;
    $('hand-count').classList.toggle('over', state.hand.length > HAND_SIZE);

    const full = state.hand.length >= HAND_SIZE;
    ['hand-palette-numbers', 'hand-palette-operators'].forEach((id) => {
      $(id).querySelectorAll('.card').forEach((el) => el.classList.toggle('card-limited', full));
    });
  }

  function dealRandomHand(seed) {
    const rng = AILib.makeRng(seed >>> 0);
    const deck = window.buildDeck(1);
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    state.hand = deck.slice(0, HAND_SIZE);
    renderHand();
  }

  function readHandConditions() {
    return {
      level: $('hand-level').value,
      seconds: Math.max(1, Number($('hand-seconds').value) || 1),
      trials: Math.max(1, Math.min(20000, Math.floor(Number($('hand-trials').value) || 1))),
      opponents: Math.max(1, Math.floor(Number($('hand-opponents').value) || 1)),
      seed: Math.floor(Number($('hand-seed').value) || 0),
    };
  }

  function runHand() {
    const errBox = $('hand-error');
    errBox.textContent = '';

    if (state.hand.length === 0) {
      errBox.textContent = '手札が空。カードを追加するか「ランダムに配る」を押す。';
      $('hand-results').classList.add('hidden');
      return;
    }

    const cond = readHandConditions();
    const t0 = performance.now();
    const model = AILib.OPPONENT_MODEL;

    const profile = COGN.getProfile(cond.level);
    const cands = AILib.candidateSet(state.hand, profile);
    if (cands.length === 0) {
      errBox.textContent = 'この手札からは1つも式が作れない（数字が1枚も無い等）。';
      $('hand-results').classList.add('hidden');
      return;
    }

    const pick = AILib.chooseCandidate(cands, cond.seconds, profile, cond.opponents, model);
    const mc = monteCarlo(pick.cand, cond, profile, pick.cand.value);

    // ---- 選んだ式 ----
    $('hand-pick-formula').innerHTML = FE.toMathHTML(pick.cand.formula) || esc(pick.cand.formula);
    $('hand-pick-value').textContent =
      `${pick.cand.value.toString()} ／ ${MODE_LABEL[pick.cand.analysis.answerMode] || ''}`;

    const theory = $('hand-pick-theory');
    theory.textContent = pct(pick.pCorrect);
    theory.className = `lab-rate-value ${rateClass(pick.pCorrect)}`;
    $('hand-pick-theory-sub').textContent =
      `所要 ${formatSeconds(pick.cand.analysis.requiredTime)} ／ beat ${pick.beat.toFixed(3)} ／ 効用 ${pick.utility.toFixed(3)}`;

    const measured = $('hand-pick-measured');
    measured.textContent = pct(mc.rate);
    measured.className = `lab-rate-value ${rateClass(mc.rate)}`;
    $('hand-pick-measured-sub').textContent =
      `${mc.n} 回中 ${mc.correct} 回正解（±${(mc.ci * 100).toFixed(1)}pt）／ ⏱${mc.timedOut}`;

    // ---- 候補一覧 ----
    $('hand-cand-table').innerHTML = cands.map((c) => {
      const u = AILib.candidateUtility(c, cond.seconds, profile, cond.opponents, model);
      const isPicked = c.formula === pick.cand.formula;
      return `
        <tr class="${isPicked ? 'is-picked' : ''}">
          <td class="lab-formula-cell">${isPicked ? '■ ' : ''}${esc(c.formula)}</td>
          <td class="lab-value-cell">${esc(c.value.toString())}</td>
          <td>${esc(c.analysis.answerMode)}</td>
          <td class="num">${c.analysis.requiredTime.toFixed(1)}</td>
          <td class="num">${c.analysis.wmPeak.toFixed(1)}</td>
          <td class="num">${u.pCorrect.toFixed(3)}</td>
          <td class="num">${u.beat.toFixed(3)}</td>
          <td class="num">${u.utility.toFixed(3)}</td>
        </tr>`;
    }).join('');

    // ---- レベルごとの選択 ----
    $('hand-level-table').innerHTML = LEVELS.map((lv) => {
      const p = COGN.getProfile(lv);
      const cs = AILib.candidateSet(state.hand, p);
      if (cs.length === 0) {
        return `<tr><td>${esc(p.name)}</td><td colspan="6" class="lab-muted">式を作れない</td></tr>`;
      }
      const best = AILib.chooseCandidate(cs, cond.seconds, p, cond.opponents, model);
      const lvMc = monteCarlo(best.cand, cond, p, best.cand.value);
      return `
        <tr class="${lv === cond.level ? 'is-current' : ''}">
          <td>${esc(p.name)}<span class="lab-muted">（${esc(p.label)}）</span></td>
          <td class="lab-formula-cell">${esc(best.cand.formula)}</td>
          <td class="lab-value-cell">${esc(best.cand.value.toString())}</td>
          <td class="num">${best.cand.analysis.requiredTime.toFixed(1)}</td>
          <td class="num">${pct(best.pCorrect)}</td>
          <td class="num">${pct(lvMc.rate)}</td>
          <td class="lab-bar-cell">
            <span class="lab-bar" style="width:${Math.max(2, best.pCorrect * 120)}px;background:${LEVEL_COLOR[lv]};"></span>
          </td>
        </tr>`;
    }).join('');

    $('hand-run-time').textContent = `計算 ${Math.round(performance.now() - t0)} ms`;
    $('hand-results').classList.remove('hidden');
  }

  // ============================================================
  // 初期化
  // ============================================================

  let autoRunTimer = null;

  function autoRun() {
    if (!$('auto-run').checked) return;
    clearTimeout(autoRunTimer);
    autoRunTimer = setTimeout(run, 120);
  }

  function fillLevelSelect(select) {
    select.innerHTML = LEVELS.map((lv) => {
      const p = COGN.getProfile(lv);
      return `<option value="${lv}">${esc(p.name)}（${esc(p.label)}）</option>`;
    }).join('');
    select.value = 'skilled';
  }

  /** 数値入力とスライダーを双方向に結ぶ */
  function linkNumberAndRange(numId, rangeId, onChange) {
    const num = $(numId), range = $(rangeId);
    num.addEventListener('input', () => {
      const v = Number(num.value);
      if (isFinite(v)) range.value = Math.min(range.max, Math.max(range.min, v));
      onChange();
    });
    range.addEventListener('input', () => {
      num.value = range.value;
      onChange();
    });
  }

  function init() {
    // ---- 式タブ ----
    fillLevelSelect($('level'));

    renderPalette($('palette-numbers'), NUMBER_VALUES.map(numberCard),
      (c) => appendCard(Object.assign({}, c, { id: `lab-n${cardSeq++}` })));
    renderPalette($('palette-operators'), OPERATOR_VALUES.map(operatorCard),
      (c) => appendCard(Object.assign({}, c, { id: `lab-o${cardSeq++}` })));
    renderPalette($('palette-parens'), ['(', ')'].map(parenCard),
      (c) => appendCard(Object.assign({}, c, { id: `lab-p${cardSeq++}` })));

    $('formula-text').addEventListener('input', syncFromText);
    $('btn-undo').addEventListener('click', () => {
      if (state.seq === null || state.seq.length === 0) return;
      state.seq.pop();
      syncFromSeq();
    });
    $('btn-clear').addEventListener('click', () => {
      state.seq = [];
      syncFromSeq();
    });
    document.querySelectorAll('[data-example]').forEach((btn) => {
      btn.addEventListener('click', () => {
        $('formula-text').value = btn.dataset.example;
        syncFromText();
        run();
      });
    });

    $('btn-run').addEventListener('click', run);
    $('level').addEventListener('change', autoRun);
    $('trials').addEventListener('change', autoRun);
    $('opponents').addEventListener('change', autoRun);
    $('seed').addEventListener('change', autoRun);
    $('mc-all-levels').addEventListener('change', autoRun);
    linkNumberAndRange('seconds', 'seconds-range', autoRun);

    initTunePanel();

    // ---- 手札タブ ----
    fillLevelSelect($('hand-level'));
    renderPalette($('hand-palette-numbers'), NUMBER_VALUES.map(numberCard), (c) => {
      if (state.hand.length >= HAND_SIZE) return;
      state.hand.push(Object.assign({}, c, { id: `lab-hn${cardSeq++}` }));
      renderHand();
    });
    renderPalette($('hand-palette-operators'), OPERATOR_VALUES.map(operatorCard), (c) => {
      if (state.hand.length >= HAND_SIZE) return;
      state.hand.push(Object.assign({}, c, { id: `lab-ho${cardSeq++}` }));
      renderHand();
    });
    $('btn-hand-random').addEventListener('click', () => dealRandomHand(readHandConditions().seed));
    $('btn-hand-clear').addEventListener('click', () => { state.hand = []; renderHand(); });
    $('btn-hand-run').addEventListener('click', runHand);
    linkNumberAndRange('hand-seconds', 'hand-seconds-range', () => {});

    // ---- タブ切替 ----
    document.querySelectorAll('.lab-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.lab-tab').forEach((t) => t.classList.remove('active'));
        tab.classList.add('active');
        $('tab-formula').classList.toggle('hidden', tab.dataset.tab !== 'formula');
        $('tab-hand').classList.toggle('hidden', tab.dataset.tab !== 'hand');
      });
    });

    // ---- 初期表示 ----
    $('formula-text').value = '6^9';
    syncFromText();
    dealRandomHand(readHandConditions().seed);
    run();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
