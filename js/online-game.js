/**
 * online-game.js - オンライン対戦のゲーム画面制御
 * サーバーから受信したゲーム状態をレンダリングし、アクションを送信する。
 *
 * 全体を IIFE で包んでいる。クラシックスクリプトのトップレベル const は
 * 他のスクリプトとグローバル字句スコープを共有するため、online-lobby.js と
 * 同じ名前を宣言するとファイル全体が SyntaxError で読み込まれなくなる。
 */
(function () {
  'use strict';

  const mgr = window.onlineManager;
  const $ = (id) => document.getElementById(id);

  let gameState = null;
  let myPlayerIndex = 0;
  let isSpectator = false;
  let exchangeSelected = new Set();
  let formulaText = '';
  let builder = null;
  let timerInterval = null;
  let lastPhase = null;
  let gameOverShown = false;

  const PHASE_NAMES = {
    SETTING: '設定', DEALING: '配札中', BETTING_1: 'ベットラウンド1',
    EXCHANGE: 'カード交換', BETTING_2: 'ベットラウンド2', CALCULATION: '数式構築',
    SHOWDOWN: 'ショーダウン', SETTLEMENT: '精算',
  };

  // ============================================================
  // 初期化
  // ============================================================

  function initOnlineGame({ playerIndex, myRole }) {
    myPlayerIndex = playerIndex;
    isSpectator = myRole === 'spectator';

    $('room-id-text').textContent = mgr.roomCode || '---';

    initBuilder();
    initEventListeners();
  }

  function initBuilder() {
    builder = new FormulaBuilder({
      handArea: $('online-hand-area'),
      builderArea: $('online-builder-area'),
      previewEl: $('online-formula-preview'),
      getHand: () => {
        const me = gameState && gameState.players[myPlayerIndex];
        return me ? me.hand : [];
      },
      createCardEl: createStandardCardElement,
      isLocked: () => {
        if (isSpectator) return true;
        const me = gameState && gameState.players[myPlayerIndex];
        return me ? me.hasSubmitted : false;
      },
      onSequenceChange: (formula) => {
        formulaText = formula;
        updateDeclarationHint();
      },
    });

    // 括弧カード（常設ツール）: ドラッグでもクリックでも置ける
    document.querySelectorAll('.paren-tools .paren-card').forEach(el => {
      if (el._hnpParenBound) return;
      el._hnpParenBound = true;

      const makeCard = () => ({ type: 'paren', value: el.dataset.paren });

      el.draggable = true;
      el.addEventListener('dragstart', (e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('application/json', JSON.stringify({
          type: 'hand',
          card: makeCard(),
        }));
      });
      el.addEventListener('dragend', () => {
        if (builder) builder.dragEndedAt = Date.now();
      });

      const add = () => {
        if (!builder || builder._recentlyDragged()) return;
        builder.appendCard(makeCard());
      };
      el.addEventListener('click', add);
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); add(); }
      });
    });
  }

  /** 数式構築まわり（プレビュー・配置エリア・括弧・結果入力）の表示切替 */
  function setWorkspaceVisible(visible) {
    $('online-main-workspace').classList.toggle('hidden', !visible);
    $('online-paren-tools').classList.toggle('hidden', !visible);
    $('online-submit-area').classList.toggle('hidden', !visible);
  }

  // ============================================================
  // 受信
  // ============================================================

  function handleOnlineGameUpdate(state) {
    if (!state) return;
    const phaseChanged = lastPhase !== state.phase;
    gameState = state;

    if (phaseChanged) {
      onPhaseChanged(lastPhase, state.phase);
      lastPhase = state.phase;
    }
    render();
  }

  function onPhaseChanged(from, to) {
    if (to === 'CALCULATION') {
      formulaText = '';
      $('online-result-input').value = '';
      if (builder) builder.clear();
      notify(`数式を構築してください（制限時間 ${gameState.calculationTimeLimit}秒）`);
    }
    if (to === 'EXCHANGE') {
      exchangeSelected = new Set();
      notify('カード交換フェーズ。交換したいカードを選んでください');
    }
    if (to !== 'SHOWDOWN') {
      $('online-showdown-overlay').classList.add('hidden');
    }
  }

  // ============================================================
  // レンダリング
  // ============================================================

  function render() {
    if (!gameState) return;

    $('online-level').textContent = gameState.level;
    $('online-blind').textContent = `SB: ${gameState.config.smallBlind} / BB: ${gameState.config.bigBlind}`;
    $('online-hand').textContent = `ハンド #${gameState.handNumber}`;
    $('online-pot').textContent = gameState.pot;
    $('online-center-pot').textContent = gameState.pot;
    $('online-phase').textContent = PHASE_NAMES[gameState.phase] || gameState.phase;

    renderOpponents();
    renderMyArea();
    renderLog();
    syncTimer();

    if (gameState.gameOver) showGameOver();
    else if (gameState.phase === 'SHOWDOWN') showShowdown();
  }

  /** その席が今つながっているか（room-state 側の情報） */
  function isConnected(idx) {
    const rs = mgr.roomState;
    if (!rs || !rs.players || !rs.players[idx]) return true;
    return rs.players[idx].connected !== false;
  }

  function renderOpponents() {
    const container = $('online-opponents');
    container.innerHTML = '';

    gameState.players.forEach((p, idx) => {
      if (idx === myPlayerIndex) return;
      if (p.isEliminated) return;

      const seat = document.createElement('div');
      seat.className = 'player-seat';
      if (!p.isActive) seat.classList.add('folded');
      if ((gameState.phase === 'BETTING_1' || gameState.phase === 'BETTING_2') &&
          idx === gameState.currentPlayerIdx) {
        seat.classList.add('active-turn');
      }
      if ((gameState.winners || []).includes(p.id)) seat.classList.add('winner');

      const name = document.createElement('div');
      name.className = 'seat-name';
      name.textContent = p.name; // 相手が付けた名前なので必ず textContent で入れる
      if (p.isDealer) {
        const badge = document.createElement('span');
        badge.className = 'dealer-badge';
        badge.textContent = 'D';
        name.appendChild(badge);
      }

      const chips = document.createElement('div');
      chips.className = 'seat-chips';
      chips.textContent = `💰 ${p.chips}`;

      const bet = document.createElement('div');
      bet.className = 'seat-bet';
      bet.textContent = `ベット: ${p.currentBet}`;

      seat.append(name, chips, bet);

      // 切断中の相手は、卓の上でも分かるようにする
      // （毎回フォールドしてくるのが放置なのか回線なのか区別できない）
      if (!isConnected(idx)) {
        seat.classList.add('disconnected');
        const d = document.createElement('div');
        d.className = 'seat-disconnected';
        d.textContent = '⚠ 切断中';
        name.appendChild(d);
      }

      let status = '', cls = '';
      if (!p.isActive) { status = 'フォールド'; cls = 'folded-text'; }
      else if (p.isAllIn) { status = 'オールイン'; cls = 'allin-text'; }
      else if (p.hasSubmitted) { status = '提出済み'; }
      else if (p.isReady) { status = '準備完了'; }
      if (status) {
        const st = document.createElement('div');
        st.className = `seat-status ${cls}`.trim();
        st.textContent = status;
        seat.appendChild(st);
      }

      const cards = document.createElement('div');
      cards.className = 'seat-cards';
      p.hand.forEach(() => {
        const mc = document.createElement('div');
        mc.className = 'mini-card back';
        mc.textContent = '?';
        cards.appendChild(mc);
      });
      seat.appendChild(cards);

      container.appendChild(seat);
    });
  }

  function renderMyArea() {
    const me = gameState.players[myPlayerIndex];
    if (!me) return;

    $('online-my-name').textContent = me.name;
    $('online-my-chips').textContent = `💰 ${me.chips}`;

    const isBetting = gameState.phase === 'BETTING_1' || gameState.phase === 'BETTING_2';
    const isExchange = gameState.phase === 'EXCHANGE';
    const isCalculation = gameState.phase === 'CALCULATION';

    $('online-betting-actions').classList.toggle('hidden', !isBetting || isSpectator);
    $('online-exchange-area').classList.toggle('hidden', !isExchange || isSpectator);
    setWorkspaceVisible(isCalculation && !isSpectator);

    if (isCalculation && !isSpectator) {
      renderFormulaArea();
    } else {
      renderStaticHand(isExchange && !isSpectator);
      if (isBetting) renderBettingActions();
      if (isExchange) renderExchangeArea();
    }
  }

  function renderStaticHand(selectable) {
    const me = gameState.players[myPlayerIndex];
    const container = $('online-hand-area');
    container.innerHTML = '';

    me.hand.forEach(card => {
      const el = createStandardCardElement(card);
      if (exchangeSelected.has(card.id)) el.classList.add('selected');
      el.draggable = false;

      if (selectable && !me.isReady) {
        el.tabIndex = 0;
        const toggle = () => {
          gameAudio.resume(); gameAudio.playClick();
          if (exchangeSelected.has(card.id)) {
            exchangeSelected.delete(card.id);
            el.classList.remove('selected');
          } else {
            exchangeSelected.add(card.id);
            el.classList.add('selected');
          }
          renderExchangeArea();
        };
        el.addEventListener('click', toggle);
        el.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
        });
      }

      container.appendChild(el);
    });
  }

  // ============================================================
  // ベット
  // ============================================================

  function renderBettingActions() {
    const me = gameState.players[myPlayerIndex];
    const isMyTurn = !isSpectator && gameState.currentPlayerIdx === myPlayerIndex &&
      me.isActive && !me.isAllIn;
    const toCall = gameState.currentBet - me.currentBet;

    $('online-btn-fold').disabled = !isMyTurn;
    $('online-btn-check').disabled = !isMyTurn || toCall > 0;
    $('online-btn-call').disabled = !isMyTurn || toCall <= 0;
    $('online-btn-raise').disabled = !isMyTurn || me.chips <= 0;
    $('online-btn-allin').disabled = !isMyTurn || me.chips <= 0;

    $('online-btn-call').textContent = toCall > 0 ? `コール ${toCall}` : 'コール';

    const minRaise = gameState.currentBet + gameState.minRaise;
    $('online-raise-amount').min = String(minRaise);
    $('online-raise-amount').placeholder = `最小 ${minRaise}`;
  }

  function sendAction(action, amount = 0) {
    gameAudio.resume();
    mgr.sendAction('bet', { action, amount }, (res) => {
      if (!res || !res.ok) {
        notify((res && res.error) || 'アクションに失敗しました', true);
        gameAudio.playError();
      } else {
        gameAudio.playChip();
      }
    });
  }

  // ============================================================
  // 交換
  // ============================================================

  function renderExchangeArea() {
    const me = gameState.players[myPlayerIndex];
    const btn = $('online-btn-exchange');
    btn.textContent = me.isReady ? '交換済み' : `交換する（${exchangeSelected.size}枚選択）`;
    btn.disabled = me.isReady || isSpectator;
  }

  function sendExchange() {
    gameAudio.resume();
    mgr.sendAction('exchange', { cardIds: [...exchangeSelected] }, (res) => {
      if (!res || !res.ok) {
        notify((res && res.error) || '交換に失敗しました', true);
        gameAudio.playError();
      }
    });
    exchangeSelected = new Set();
    gameAudio.playDeal();
  }

  // ============================================================
  // 数式構築
  // ============================================================

  function renderFormulaArea() {
    const me = gameState.players[myPlayerIndex];
    const submitted = me.hasSubmitted;
    const auto = !!gameState.autoCalcMode;

    $('online-result-input').classList.toggle('hidden', auto);
    $('online-declaration-hint').classList.toggle('hidden', auto);
    $('online-result-input').disabled = submitted;
    $('online-btn-submit').disabled = submitted;
    $('online-btn-submit').textContent = submitted ? '提出済み' : '提出';

    if (builder) builder.render();
    updateDeclarationHint();
  }

  /** 現在の数式の規模から、要求される答えの形式を表示する */
  function updateDeclarationHint() {
    const el = $('online-declaration-hint');
    if (!el) return;

    if (gameState && gameState.autoCalcMode) {
      el.textContent = 'システムが自動計算します（計算ミス判定なし）';
      el.className = 'declaration-hint auto';
      return;
    }

    const formula = builder ? builder.getFormulaString() : formulaText;
    if (!formula) {
      el.textContent = 'カードを並べると、答えの入力形式がここに表示されます';
      el.className = 'declaration-hint';
      return;
    }

    const res = FormulaEvaluator.evaluate(formula);
    if (!res.ok) {
      el.textContent = `未完成 / 構文エラー: ${res.error}`;
      el.className = 'declaration-hint error';
      return;
    }
    const mode = FormulaEvaluator.declarationMode(res.value);
    el.textContent = `${res.value.tierLabel()} — ${FormulaEvaluator.declarationHint(res.value)}`;
    el.className = `declaration-hint mode-${mode}`;
  }

  function submitFormula() {
    gameAudio.resume();

    const formula = builder ? builder.getFormulaString() : formulaText.trim();
    const auto = !!gameState.autoCalcMode;
    const declared = auto ? '' : $('online-result-input').value.trim();

    if (!formula) { notify('数式を組み立ててください', true); gameAudio.playError(); return; }
    if (!auto && !declared) { notify('計算結果を入力してください', true); gameAudio.playError(); return; }

    const dialog = $('online-confirm-dialog');
    $('online-confirm-formula').innerHTML = FormulaEvaluator.toMathHTML(formula);
    dialog.classList.remove('hidden');

    $('online-btn-confirm-yes').onclick = () => {
      dialog.classList.add('hidden');
      mgr.sendAction('submit-formula', { formula, result: declared }, (res) => {
        if (!res || !res.ok) {
          notify((res && res.error) || '提出に失敗しました', true);
          gameAudio.playError();
          return;
        }
        gameAudio.playCorrect();
        notify('数式を提出しました');
      });
    };
    $('online-btn-confirm-no').onclick = () => dialog.classList.add('hidden');
  }

  // ============================================================
  // ショーダウン
  // ============================================================

  function showShowdown() {
    $('online-showdown-title').textContent = '🏆 ショーダウン';
    const list = $('online-showdown-list');
    list.innerHTML = '';

    (gameState.showdownResults || []).forEach((result, idx) => {
      const isWinner = (gameState.winners || []).includes(result.player.id);
      list.appendChild(buildShowdownItem(result, idx, isWinner));
    });

    const winnerDiv = $('online-showdown-winner');
    winnerDiv.innerHTML = '';

    if ((gameState.winners || []).length > 0) {
      const names = gameState.players
        .filter(p => gameState.winners.includes(p.id))
        .map(p => p.name).join('、');
      const n = document.createElement('div');
      n.className = 'winner-name';
      n.textContent = `🏆 ${names}`;
      winnerDiv.append(n);
      winnerDiv.append(...buildPotBreakdown(gameState.settlement,
        (i) => gameState.players[i] ? gameState.players[i].name : `P${i + 1}`));
      gameAudio.playWin();
    } else {
      const n = document.createElement('div');
      n.className = 'winner-name';
      n.textContent = '勝者なし（全員スコア0の同点）';
      const a = document.createElement('div');
      a.className = 'winner-amount';
      a.textContent = '全員失格。ベットしたチップは全員に払い戻されます';
      winnerDiv.append(n, a);
      gameAudio.playLose();
    }

    renderNextHandButton();
    $('online-showdown-overlay').classList.remove('hidden');
  }

  /** ゲーム終了。最終順位を出して、ここで打ち止めにする */
  function showGameOver() {
    const standings = gameState.standings || [];
    $('online-showdown-title').textContent = '🎉 ゲーム終了';

    const list = $('online-showdown-list');
    list.innerHTML = '';
    buildStandingsList(standings).forEach(el => list.appendChild(el));

    const winnerDiv = $('online-showdown-winner');
    winnerDiv.innerHTML = '';
    const n = document.createElement('div');
    n.className = 'winner-name';
    n.textContent = standings[0] ? `🏆 優勝: ${standings[0].name}` : '🏆 優勝者なし';
    const a = document.createElement('div');
    a.className = 'winner-amount';
    a.textContent = standings[0] ? `最終チップ ${standings[0].chips}` : '';
    winnerDiv.append(n, a);

    const btn = $('online-btn-next-hand');
    btn.textContent = 'ホームに戻る';
    btn.disabled = false;
    btn.onclick = () => {
      if (window.forgetSeat) window.forgetSeat(); // 終わった部屋に自動復帰しない
      location.href = 'index.html';
    };

    if (!gameOverShown) {
      gameOverShown = true;
      gameAudio.playWin();
    }
    $('online-showdown-overlay').classList.remove('hidden');
  }

  /** 「次のハンドへ」に、あと何人待っているかを出す */
  function renderNextHandButton() {
    const btn = $('online-btn-next-hand');
    if (!btn) return;

    const info = gameState.nextHand || { ready: [], needed: 0 };
    const iAmReady = info.ready.includes(myPlayerIndex);
    btn.onclick = null; // ゲーム終了画面で付けた「ホームに戻る」を外す

    if (isSpectator) {
      btn.textContent = '観戦中';
      btn.disabled = true;
      return;
    }
    btn.disabled = iAmReady;
    btn.textContent = iAmReady
      ? `他のプレイヤーを待っています（${info.ready.length}/${info.needed}）`
      : (info.needed > 1 ? `次のハンドへ（${info.ready.length}/${info.needed}）` : '次のハンドへ');
  }

  function buildShowdownItem(result, idx, isWinner) {
    const item = document.createElement('div');
    item.className = 'showdown-item';
    if (isWinner) item.classList.add('winner-item');
    item.style.animationDelay = `${Math.min(idx * 0.25, 2)}s`;

    const name = document.createElement('div');
    name.className = 'sd-player';
    name.textContent = result.player.name;

    const formulaEl = document.createElement('div');
    formulaEl.className = 'sd-formula';

    const resultEl = document.createElement('div');
    resultEl.className = 'sd-result';

    let mark = '';

    if (result.status === 'fold') {
      formulaEl.innerHTML = '<span class="sd-muted">フォールド</span>';
      resultEl.textContent = '—';
    } else if (result.status === 'uncontested') {
      formulaEl.innerHTML = '<span class="sd-muted">不戦勝（他全員フォールド）</span>';
      resultEl.textContent = '数式の提出なしで勝利';
      mark = 'correct';
    } else if (result.status === 'nosubmit') {
      formulaEl.innerHTML = '<span class="sd-muted">未提出</span>';
      resultEl.textContent = '時間切れ';
      mark = 'incorrect';
    } else if (result.status === 'invalid') {
      formulaEl.textContent = result.formula ? result.formula.formulaString : '構文エラー';
      formulaEl.classList.add('sd-error');
      resultEl.textContent = '構文エラー';
      mark = 'incorrect';
    } else {
      const f = result.formula;
      formulaEl.innerHTML = FormulaEvaluator.toMathHTML(f.formulaString);
      if (f.autoCalculated) {
        resultEl.textContent = `評価: ${f.systemEvaluatedResult}`;
      } else if (result.status === 'correct') {
        resultEl.textContent = `入力: ${f.playerDeclaredResult} / 評価: ${f.systemEvaluatedResult}`;
      } else {
        resultEl.textContent = `入力: ${f.playerDeclaredResult} / 正解: ${f.systemEvaluatedResult}`;
      }
      mark = result.status === 'correct' ? 'correct' : 'incorrect';
    }

    item.append(name, formulaEl, resultEl);
    if (mark) {
      const m = document.createElement('span');
      m.className = `sd-mark ${mark}`;
      m.textContent = mark === 'correct' ? '○' : '×';
      item.appendChild(m);
    }
    return item;
  }

  // ============================================================
  // タイマー（サーバーの締切時刻に同期）
  // ============================================================

  /**
   * サーバーは「あと何ミリ秒か」を送ってくる。それを受け取った瞬間に
   * こちらの時計で締切へ直す。絶対時刻(epoch)で受け取ると、端末の時計が
   * ずれているぶんだけタイマーがずれてしまう。
   */
  function syncTimer() {
    const display = $('online-timer');
    const remainingMs = gameState.remainingMs;

    if (remainingMs == null) {
      display.classList.add('hidden');
      if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
      return;
    }

    const localDeadline = Date.now() + remainingMs;
    display.classList.remove('hidden');
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((localDeadline - Date.now()) / 1000));
      display.textContent = `⏱ ${remaining}`;
      display.classList.toggle('urgent', remaining <= 5);
      if (remaining <= 0 && timerInterval) { clearInterval(timerInterval); timerInterval = null; }
    };
    if (timerInterval) clearInterval(timerInterval);
    tick();
    timerInterval = setInterval(tick, 250);
  }

  // ============================================================
  // ログ・通知
  // ============================================================

  function renderLog() {
    const panel = $('online-log-panel');
    panel.innerHTML = '';
    (gameState.log || []).slice(-20).forEach(entry => {
      const div = document.createElement('div');
      div.className = 'log-entry';
      const time = document.createElement('span');
      time.className = 'log-time';
      time.textContent = entry.time;
      div.appendChild(time);
      div.appendChild(document.createTextNode(entry.msg));
      panel.appendChild(div);
    });
    panel.scrollTop = panel.scrollHeight;
  }

  let notifyTimer = null;
  function notify(msg, isError = false) {
    const el = $('online-notification');
    el.textContent = msg;
    el.classList.toggle('error', !!isError);
    el.classList.remove('hidden');
    if (notifyTimer) clearTimeout(notifyTimer);
    notifyTimer = setTimeout(() => el.classList.add('hidden'), 3000);
  }

  // ============================================================
  // イベント
  // ============================================================

  function initEventListeners() {
    $('online-btn-fold').addEventListener('click', () => sendAction('fold'));
    $('online-btn-check').addEventListener('click', () => sendAction('check'));
    $('online-btn-call').addEventListener('click', () => sendAction('call'));
    $('online-btn-raise').addEventListener('click', () => {
      sendAction('raise', parseInt($('online-raise-amount').value, 10) || 0);
    });
    $('online-btn-allin').addEventListener('click', () => sendAction('allin'));
    $('online-btn-exchange').addEventListener('click', sendExchange);
    $('online-btn-submit').addEventListener('click', submitFormula);

    $('online-result-input').addEventListener('input', () => {
      const el = $('online-declaration-preview');
      if (!el) return;
      const parsed = FormulaEvaluator.parseDeclaration($('online-result-input').value);
      if (!parsed) { el.textContent = ''; return; }
      el.textContent = parsed.kind === 'digits'
        ? `→ ${parsed.digits.toString()} 桁 として解釈`
        : `→ ${parsed.value.toString()} として解釈`;
    });

    // 全員が押すか制限時間切れで進むので、押しても画面は閉じない
    $('online-btn-next-hand').addEventListener('click', () => {
      const btn = $('online-btn-next-hand');
      btn.disabled = true;
      mgr.sendAction('next-hand', {});
    });

    document.addEventListener('keydown', (e) => {
      const dialog = $('online-confirm-dialog');
      if (dialog.classList.contains('hidden')) return;
      if (e.key === 'Enter') $('online-btn-confirm-yes').click();
      if (e.key === 'Escape') $('online-btn-confirm-no').click();
    });
  }

  // ============================================================
  // エクスポート
  // ============================================================

  window.initOnlineGame = initOnlineGame;
  window.handleOnlineGameUpdate = handleOnlineGameUpdate;
  // 切断・再入室は room-state だけで飛んでくる（ゲーム状態は変わらない）ので、
  // ここでも卓を描き直さないと「切断中」表示が次のアクションまで出ない。
  window.handleOnlineRoomState = () => { if (gameState) render(); };
  window.handleOnlineFullStateSync = handleOnlineGameUpdate;
})();
