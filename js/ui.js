/**
 * ui.js - 巨大数ポーカー UI制御（ローカル / ソロ）
 * 画面遷移・レンダリング・インタラクション管理
 */

// ============================================================
// 状態
// ============================================================

let game = null;
let currentPlayerIdx = 0;          // 自分（ホットシートの現在操作プレイヤー）
let exchangeSelected = new Set();  // 交換選択中のカードID
let formulaText = '';              // 現在の数式
let betTimerInterval = null;
let calcTimerInterval = null;
let isSoloMode = false;
let soloStartTime = 0;
let soloHand = [];
let builder = null;
let aiPlayers = {};                // playerIdx -> AIPlayer
let aiTimers = [];                 // CPUの行動予約

const $ = (id) => document.getElementById(id);

const views = {
  home: $('home-view'),
  setup: $('setup-view'),
  solo: $('solo-view'),
  rules: $('rules-view'),
  game: $('game-view'),
};

// ============================================================
// LocalStorage
// ============================================================

const STORAGE_KEY = 'huge-number-poker-settings';
const SOLO_STORAGE_KEY = 'huge-number-poker-solo-scores';

function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || null;
  } catch (e) { return null; }
}

function saveSettings(settings) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch (e) {}
}

function loadSoloScores() {
  try { return JSON.parse(localStorage.getItem(SOLO_STORAGE_KEY)) || []; } catch (e) { return []; }
}

function saveSoloScore(score) {
  const scores = loadSoloScores();
  scores.push(score);
  scores.sort((a, b) => (b.scoreLog10 || 0) - (a.scoreLog10 || 0));
  try {
    localStorage.setItem(SOLO_STORAGE_KEY, JSON.stringify(scores.slice(0, 20)));
  } catch (e) {}
}

// ============================================================
// 画面遷移
// ============================================================

function showView(name) {
  Object.values(views).forEach(v => v && v.classList.add('hidden'));
  if (views[name]) views[name].classList.remove('hidden');
}

// ============================================================
// セットアップ画面
// ============================================================

function initSetupScreen() {
  const s = loadSettings();
  if (s) {
    $('player-count').value = s.playerCount || 4;
    $('initial-chips').value = s.initialChips || 1000;
    $('small-blind').value = s.smallBlind || 10;
    $('big-blind').value = s.bigBlind || 20;
    $('ante').value = s.ante || 5;
    $('bet-time-limit').value = s.betTimeLimit || 10;
    $('dealer-time-limit').value = s.dealerTimeLimit || 20;
    $('level-up-hands').value = s.levelUpHands || 5;
    $('deck-count').value = s.deckCount || 1;
    $('auto-calc-mode').checked = !!s.autoCalcMode;
    if ($('cpu-mode')) {
      $('cpu-mode').checked = s.cpuMode !== undefined ? !!s.cpuMode : true;
      if (s.cpuLevel) $('cpu-level').value = s.cpuLevel;
    }
    window._blindManualOverride = true; // 保存値を尊重する
  }
  updatePlayerNameInputs();
}

function updatePlayerNameInputs() {
  const count = parseInt($('player-count').value, 10) || 4;
  const container = $('player-name-inputs');
  const previous = [...container.querySelectorAll('input')].map(i => i.value);
  container.innerHTML = '';

  const cpuOn = $('cpu-mode') ? $('cpu-mode').checked : false;
  const level = ($('cpu-level') && $('cpu-level').value) || 'casual';
  const label = (window.AI_PROFILES && AI_PROFILES[level]) ? AI_PROFILES[level].label : 'CPU';

  for (let i = 0; i < count; i++) {
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 12;
    input.dataset.playerIdx = String(i);

    if (cpuOn && i > 0) {
      // CPU席は名前を編集させない（誰がCPUかを画面上ではっきりさせる）
      input.value = `CPU ${label}`;
      input.disabled = true;
      input.classList.add('cpu-seat');
    } else {
      input.placeholder = cpuOn ? 'あなたの名前' : `プレイヤー${i + 1}の名前`;
      input.value = (previous[i] && !previous[i].startsWith('CPU ')) ? previous[i] : `P${i + 1}`;
    }
    container.appendChild(input);
  }
}

/** 初期チップ変更時にブラインド比率を自動追従 */
function updateBlindRatios() {
  if (window._blindManualOverride) return;
  const initialChips = parseInt($('initial-chips').value, 10) || 1000;
  const ratio = initialChips / 1000;
  $('small-blind').value = Math.max(1, Math.round(10 * ratio));
  $('big-blind').value = Math.max(2, Math.round(20 * ratio));
  $('ante').value = Math.max(0, Math.round(5 * ratio));
}

// ============================================================
// ゲーム開始
// ============================================================

function startGame() {
  const playerCount = parseInt($('player-count').value, 10) || 4;
  const playerNames = [];
  document.querySelectorAll('#player-name-inputs input').forEach(input => {
    playerNames.push((input.value || '').trim().slice(0, 12) || input.placeholder);
  });

  // ---- CPU設定 ----
  // 席0は常に人間。cpu-mode が ON なら残りの席をすべてCPUにする。
  const cpuEnabled = $('cpu-mode') ? $('cpu-mode').checked : false;
  const cpuLevel = ($('cpu-level') && $('cpu-level').value) || 'casual';
  const cpuLevels = [];
  for (let i = 0; i < playerCount; i++) {
    const lv = (cpuEnabled && i > 0) ? cpuLevel : null;
    cpuLevels.push(lv);
    if (lv && window.AI_PROFILES) {
      playerNames[i] = `CPU ${AI_PROFILES[lv].label}`;
    }
  }

  const config = {
    initialChips: parseInt($('initial-chips').value, 10) || 1000,
    smallBlind: parseInt($('small-blind').value, 10) || 10,
    bigBlind: parseInt($('big-blind').value, 10) || 20,
    ante: parseInt($('ante').value, 10) || 5,
    betTimeLimit: parseInt($('bet-time-limit').value, 10) || 10,
    dealerTimeLimit: parseInt($('dealer-time-limit').value, 10) || 20,
    levelUpHands: parseInt($('level-up-hands').value, 10) || 5,
    deckCount: parseInt($('deck-count').value, 10) || 1,
    autoCalcMode: $('auto-calc-mode').checked,
  };

  saveSettings({ playerCount, ...config, cpuMode: cpuEnabled, cpuLevel });

  game = new Game(config);
  game.startGame(playerCount, playerNames, { cpuLevels });

  // AIの実体を作る（席ごとに独立した乱数列を持たせる）
  aiPlayers = {};
  cpuLevels.forEach((lv, i) => {
    if (!lv) return;
    aiPlayers[i] = new AIPlayer(lv, { seed: (Math.random() * 1e9) | 0 });
  });
  // 学習済み方策があれば差し込む（読み込みが間に合わなければヒューリスティックのまま）
  attachTrainedPolicy(cpuLevel);

  currentPlayerIdx = 0;
  exchangeSelected = new Set();
  formulaText = '';
  isSoloMode = false;

  initBuilder();
  showView('game');
  renderGame();

  setTimeout(() => {
    if (!game) return;
    game.startBettingRound(1);
    afterStateChange();
  }, 800);
}

// ============================================================
// レンダリング
// ============================================================

const PHASE_NAMES = {
  SETTING: '設定', DEALING: '配札中', BETTING_1: 'ベットラウンド1',
  EXCHANGE: 'カード交換', BETTING_2: 'ベットラウンド2', CALCULATION: '数式構築',
  SHOWDOWN: 'ショーダウン', SETTLEMENT: '精算',
};

function renderGame() {
  if (!game) return;

  $('level-display').textContent = game.level;
  $('blind-display').textContent = `SB: ${game.config.smallBlind} / BB: ${game.config.bigBlind}`;
  $('hand-display').textContent = `ハンド #${game.handNumber}`;
  $('pot-display').textContent = game.pot;
  $('center-pot-amount').textContent = game.pot;
  $('phase-display').textContent = PHASE_NAMES[game.phase] || game.phase;

  renderOpponents();
  renderMyArea();
  renderLog();
}

function renderOpponents() {
  const container = $('opponents-area');
  container.innerHTML = '';

  game.players.forEach((p, idx) => {
    if (idx === currentPlayerIdx) return;

    const seat = document.createElement('div');
    seat.className = 'player-seat';
    if (!p.isActive) seat.classList.add('folded');
    if ((game.phase === 'BETTING_1' || game.phase === 'BETTING_2') && idx === game.currentPlayerIdx) {
      seat.classList.add('active-turn');
    }
    if (game.winners.some(w => w.player.id === p.id)) seat.classList.add('winner');

    // プレイヤー名は textContent で入れる（HTML注入を防ぐ）
    const nameEl = document.createElement('div');
    nameEl.className = 'seat-name';
    nameEl.textContent = p.name;
    if (p.isCPU) {
      const cpu = document.createElement('span');
      cpu.className = 'cpu-badge';
      cpu.textContent = 'CPU';
      nameEl.appendChild(cpu);
    }
    if (p.isDealer) {
      const badge = document.createElement('span');
      badge.className = 'dealer-badge';
      badge.textContent = 'D';
      nameEl.appendChild(badge);
    }

    const chips = document.createElement('div');
    chips.className = 'seat-chips';
    chips.textContent = `💰 ${p.chips}`;

    const bet = document.createElement('div');
    bet.className = 'seat-bet';
    bet.textContent = `ベット: ${p.currentBet}`;

    seat.append(nameEl, chips, bet);

    let status = '';
    let statusClass = '';
    if (!p.isActive) { status = 'フォールド'; statusClass = 'folded-text'; }
    else if (p.isAllIn) { status = 'オールイン'; statusClass = 'allin-text'; }
    else if (p.hasSubmitted) { status = '提出済み'; }
    else if (p.isReady) { status = '準備完了'; }
    if (status) {
      const st = document.createElement('div');
      st.className = `seat-status ${statusClass}`.trim();
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
  const me = game.players[currentPlayerIdx];
  if (!me) return;

  $('my-name').textContent = me.name;
  $('my-chips').textContent = `💰 ${me.chips}`;

  const isBetting = game.phase === 'BETTING_1' || game.phase === 'BETTING_2';
  const isExchange = game.phase === 'EXCHANGE';
  const isCalculation = game.phase === 'CALCULATION';

  $('betting-actions').classList.toggle('hidden', !isBetting);
  $('exchange-area').classList.toggle('hidden', !isExchange);
  setWorkspaceVisible(isCalculation);

  if (isCalculation) {
    renderFormulaArea();
  } else {
    // 計算フェーズ以外は手札を読み取り専用で表示する
    renderStaticHand(isExchange);
    if (isBetting) renderBettingActions();
    if (isExchange) renderExchangeArea();
  }
}

/**
 * 数式構築まわり（プレビュー・配置エリア・括弧カード・結果入力）の表示を切り替える。
 * 手札は常に同じ場所にあるので、ここでは触らない。
 */
function setWorkspaceVisible(visible) {
  $('main-workspace').classList.toggle('hidden', !visible);
  $('paren-tools').classList.toggle('hidden', !visible);
  $('submit-area').classList.toggle('hidden', !visible);
}

/** 計算フェーズ以外の手札表示 */
function renderStaticHand(selectable) {
  const me = game.players[currentPlayerIdx];
  const container = $('hand-area');
  container.innerHTML = '';

  me.hand.forEach(card => {
    const el = createCardElement(card);
    if (exchangeSelected.has(card.id)) el.classList.add('selected');
    el.draggable = false;

    if (selectable && !me.isReady) {
      el.tabIndex = 0;
      const toggle = () => {
        gameAudio.resume();
        gameAudio.playClick();
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

/** カードDOM生成は builder.js の共通実装に委譲する（モード間で見た目を揃えるため） */
function createCardElement(card) {
  return createStandardCardElement(card);
}

// ============================================================
// ベットアクション
// ============================================================

function renderBettingActions() {
  const me = game.players[currentPlayerIdx];
  const isMyTurn = game.currentPlayerIdx === currentPlayerIdx && me.isActive && !me.isAllIn;
  const toCall = game.currentBet - me.currentBet;

  $('btn-fold').disabled = !isMyTurn;
  $('btn-check').disabled = !isMyTurn || toCall > 0;
  $('btn-call').disabled = !isMyTurn || toCall <= 0;
  $('btn-raise').disabled = !isMyTurn || me.chips <= 0;
  $('btn-allin').disabled = !isMyTurn || me.chips <= 0;

  $('btn-call').textContent = toCall > 0 ? `コール ${toCall}` : 'コール';

  const minRaise = game.currentBet + game.minRaise;
  $('raise-amount').min = String(minRaise);
  $('raise-amount').placeholder = `最小 ${minRaise}`;
}

function doAction(action) {
  if (!game) return;
  gameAudio.resume();

  const amount = action === 'raise' ? (parseInt($('raise-amount').value, 10) || 0) : 0;
  const result = game.playerAction(currentPlayerIdx, action, amount);
  if (!result.ok) {
    showNotification(result.error, true);
    gameAudio.playError();
    return;
  }

  gameAudio.playChip();
  afterStateChange();
}

/** 状態変化後の共通処理 */
function afterStateChange() {
  renderGame();
  handlePhaseTransition();
  scheduleAI();
}

// ============================================================
// CPU（AI）の進行
// ============================================================
//
// 「いつ動くか」だけをここで管理し、「何をするか」は js/ai.js に任せる。
// ベットは手番が来たら1回、交換はフェーズ開始時に全員分、
// 計算フェーズは各CPUの見積もり所要時間に合わせて提出を予約する。

function clearAITimers() {
  aiTimers.forEach(clearTimeout);
  aiTimers = [];
}

/**
 * 学習済み方策（train/train.py が書き出す models/policy_<level>.json）を
 * CPUに差し込む。設定画面を開いた時点で先読みしておくので、
 * ゲーム開始時にはたいてい読み込みが終わっている。
 * 間に合わなくても、ヒューリスティック方策で問題なく打てる。
 */
function attachTrainedPolicy(level) {
  if (!window.AIPolicy || !AIPolicy.loadPolicy) return;
  AIPolicy.loadPolicy(level).then(policy => {
    if (!policy) return;
    Object.values(aiPlayers).forEach(ai => { if (ai.level === level) ai.policy = policy; });
  });
}

function pushAITimer(id) { aiTimers.push(id); }

function isCPUSeat(i) {
  const p = game && game.players[i];
  return !!(p && p.isCPU && aiPlayers[i]);
}

function scheduleAI() {
  clearAITimers();
  if (!game || isSoloMode || game.gameOver) return;

  if (game.phase === 'BETTING_1' || game.phase === 'BETTING_2') {
    const idx = game.currentPlayerIdx;
    const p = game.players[idx];
    if (isCPUSeat(idx) && p.isActive && !p.isAllIn && !p.isEliminated) {
      pushAITimer(setTimeout(() => runAIBet(idx), 700 + Math.random() * 900));
    }
    return;
  }

  if (game.phase === 'EXCHANGE') {
    game.players.forEach((p, i) => {
      if (isCPUSeat(i) && p.isActive && !p.isReady) {
        pushAITimer(setTimeout(() => runAIExchange(i), 600 + Math.random() * 1400));
      }
    });
    return;
  }

  if (game.phase === 'CALCULATION') scheduleAICalculation();
}

function runAIBet(idx) {
  if (!game || (game.phase !== 'BETTING_1' && game.phase !== 'BETTING_2')) return;
  if (game.currentPlayerIdx !== idx || !isCPUSeat(idx)) return;

  let decision;
  try {
    decision = aiPlayers[idx].act(game, idx);
  } catch (e) {
    decision = { action: 'fold', amount: 0 };
  }

  let res = game.playerAction(idx, decision.action, decision.amount || 0);
  if (!res.ok) {
    // 保険: 想定外の額などで弾かれたら、通せる行動に落とす
    const p = game.players[idx];
    const toCall = game.currentBet - p.currentBet;
    res = game.playerAction(idx, toCall > 0 ? 'call' : 'check');
    if (!res.ok) game.playerAction(idx, 'fold');
  }
  gameAudio.playChip();
  afterStateChange();
}

function runAIExchange(idx) {
  if (!game || game.phase !== 'EXCHANGE' || !isCPUSeat(idx)) return;
  const p = game.players[idx];
  if (!p.isActive || p.isReady) return;

  let ids = [];
  try { ids = aiPlayers[idx].exchange(game, idx) || []; } catch (e) { ids = []; }
  game.selectExchangeCards(idx, ids);
  game.readyExchange(idx);
  gameAudio.playDeal();
  afterStateChange();
}

/**
 * 計算フェーズ。
 * 各CPUの「どの式を出すか / 当たるか外すか / 何秒かかるか」は
 * フェーズ開始時に1回だけ決め、以後は締切（絶対時刻）だけを見る。
 * こうしないと、人間が操作するたびに再抽選されてしまう。
 */
function scheduleAICalculation() {
  if (!game._aiCalcPlan) {
    game._aiCalcPlan = {};
    const now = Date.now();
    game.players.forEach((p, i) => {
      if (!isCPUSeat(i) || !p.isActive || p.hasSubmitted) return;
      let plan;
      try { plan = aiPlayers[i].submit(game, i); } catch (e) { plan = { timedOut: true }; }
      plan.dueAt = now + Math.max(1200, (plan.thinkSeconds || 5) * 1000);
      game._aiCalcPlan[i] = plan;
    });
  }

  const now = Date.now();
  Object.keys(game._aiCalcPlan).forEach(k => {
    const i = Number(k);
    const plan = game._aiCalcPlan[i];
    const p = game.players[i];
    if (!p || p.hasSubmitted || !p.isActive) return;
    if (plan.timedOut || !plan.formula || plan.declared == null) return;  // 間に合わず未提出
    pushAITimer(setTimeout(() => runAISubmit(i), Math.max(0, plan.dueAt - now)));
  });
}

function runAISubmit(idx, silent) {
  if (!game || game.phase !== 'CALCULATION') return;
  const p = game.players[idx];
  const plan = game._aiCalcPlan && game._aiCalcPlan[idx];
  if (!p || !p.isActive || p.hasSubmitted || !plan) return;
  if (plan.timedOut || !plan.formula || plan.declared == null) return;

  const res = game.submitFormula(idx, plan.formula, plan.declared);
  if (!res.ok) return;
  if (!silent) afterStateChange();
}

/**
 * 人間が全員提出し終えたら、残りのCPUの提出を前倒しで消化する。
 * 正答率は「制限時間」から決まっていて実時間には依存しないので、
 * 早送りしても結果は変わらない。待ち時間だけが消える。
 */
function maybeFastForwardCalc() {
  if (!game || game.phase !== 'CALCULATION') return;
  const humansPending = game.activePlayers().some(p => !p.isCPU && !p.hasSubmitted);
  if (humansPending) return;

  clearAITimers();
  Object.keys(game._aiCalcPlan || {}).forEach(k => runAISubmit(Number(k), true));
  if (game.phase === 'CALCULATION') game.finishCalculation();
}

function handlePhaseTransition() {
  if (!game) return;

  if (game.phase === 'SHOWDOWN') {
    stopBetTimer();
    stopCalcTimer();
    showShowdown();
    return;
  }

  if (game.phase === 'EXCHANGE') {
    stopBetTimer();
    stopCalcTimer();
    if (!game._uiExchangeAnnounced) {
      game._uiExchangeAnnounced = true;
      exchangeSelected = new Set();
      showNotification('カード交換フェーズ。交換したいカードを選んでください');
    }
    return;
  }

  if (game.phase === 'CALCULATION') {
    stopBetTimer();
    if (!game._uiCalcStarted) {
      game._uiCalcStarted = true;
      formulaText = '';
      $('result-input').value = '';
      if (builder) builder.clear();
      updateDeclarationHint();
      startCalcTimer();
      showNotification(`数式を構築してください（制限時間 ${game.calculationTimeLimit}秒）`);
    }
    return;
  }

  if (game.phase === 'BETTING_1' || game.phase === 'BETTING_2') {
    startBetTimer();
  }
}

// ============================================================
// 交換フェーズ
// ============================================================

function renderExchangeArea() {
  const me = game.players[currentPlayerIdx];
  const btn = $('btn-exchange');
  btn.textContent = me.isReady ? '交換済み' : `交換する（${exchangeSelected.size}枚選択）`;
  btn.disabled = me.isReady;
}

function doExchange() {
  if (!game) return;
  gameAudio.resume();

  game.selectExchangeCards(currentPlayerIdx, [...exchangeSelected]);
  game.readyExchange(currentPlayerIdx);

  exchangeSelected = new Set();
  gameAudio.playDeal();
  afterStateChange();
}

// ============================================================
// FormulaBuilder
// ============================================================

function initBuilder() {
  builder = new FormulaBuilder({
    handArea: $('hand-area'),
    builderArea: $('builder-area'),
    previewEl: $('formula-preview'),
    getHand: () => {
      if (isSoloMode) return soloHand;
      const me = game && game.players[currentPlayerIdx];
      return me ? me.hand : [];
    },
    createCardEl: createCardElement,
    isLocked: () => {
      if (isSoloMode) return false;
      const me = game && game.players[currentPlayerIdx];
      return me ? me.hasSubmitted : false;
    },
    onSequenceChange: (formula) => {
      formulaText = formula;
      updateDeclarationHint();
    },
  });

  initParenTools();
}

/** 括弧カード（常設ツール）: ドラッグでもクリックでも置ける */
function initParenTools() {
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

function renderFormulaArea() {
  const me = game.players[currentPlayerIdx];
  const submitted = me.hasSubmitted;
  const auto = !!game.config.autoCalcMode;

  $('result-input-row').classList.toggle('auto-calc', auto);
  $('result-input').classList.toggle('hidden', auto);
  $('declaration-hint').classList.toggle('hidden', auto);
  $('result-input').disabled = submitted;
  $('btn-submit-formula').disabled = submitted;
  $('btn-submit-formula').textContent = submitted ? '提出済み' : '提出';

  if (builder) builder.render();
  updateDeclarationHint();
}

/**
 * 現在の数式を評価し、「どういう形式で答えるべきか」を表示する。
 * 巨大数の扱いをプレイヤーに見せるための案内。
 */
function updateDeclarationHint() {
  const hintEl = $('declaration-hint');
  if (!hintEl) return;

  if (game && game.config.autoCalcMode) {
    hintEl.textContent = 'システムが自動計算します（計算ミス判定なし）';
    hintEl.className = 'declaration-hint auto';
    return;
  }

  const formula = builder ? builder.getFormulaString() : formulaText;
  if (!formula) {
    hintEl.textContent = 'カードを並べると、答えの入力形式がここに表示されます';
    hintEl.className = 'declaration-hint';
    return;
  }

  const res = FormulaEvaluator.evaluate(formula);
  if (!res.ok) {
    hintEl.textContent = `未完成 / 構文エラー: ${res.error}`;
    hintEl.className = 'declaration-hint error';
    return;
  }

  const mode = FormulaEvaluator.declarationMode(res.value);
  hintEl.textContent = `${res.value.tierLabel()} — ${FormulaEvaluator.declarationHint(res.value)}`;
  hintEl.className = `declaration-hint mode-${mode}`;
}

// ============================================================
// 数式提出
// ============================================================

function submitFormula() {
  if (!game) return;
  gameAudio.resume();

  const formula = builder ? builder.getFormulaString() : formulaText.trim();
  const auto = !!game.config.autoCalcMode;
  const declared = auto ? '' : $('result-input').value.trim();

  if (!formula) {
    showNotification('数式を組み立ててください', true);
    gameAudio.playError();
    return;
  }
  if (!auto && !declared) {
    showNotification('計算結果を入力してください', true);
    gameAudio.playError();
    return;
  }

  const dialog = $('confirm-dialog');
  $('confirm-formula').innerHTML = FormulaEvaluator.toMathHTML(formula);
  dialog.classList.remove('hidden');

  $('btn-confirm-yes').onclick = () => {
    dialog.classList.add('hidden');
    const res = game.submitFormula(currentPlayerIdx, formula, declared);
    if (!res.ok) {
      showNotification(res.error, true);
      gameAudio.playError();
      return;
    }
    gameAudio.playCorrect();
    showNotification('数式を提出しました');
    maybeFastForwardCalc();
    afterStateChange();
  };
  $('btn-confirm-no').onclick = () => dialog.classList.add('hidden');
}

// ============================================================
// ショーダウン
// ============================================================

function showShowdown() {
  if (!game) return;
  const list = $('showdown-list');
  list.innerHTML = '';

  game.showdownResults.forEach((result, idx) => {
    list.appendChild(buildShowdownItem(result, idx, game.winners.some(w => w.player.id === result.player.id)));
  });

  const winnerDiv = $('showdown-winner');
  winnerDiv.innerHTML = '';
  if (game.winners.length > 0) {
    const names = game.winners.map(w => w.player.name).join('、');
    const share = Math.floor(game.pot / game.winners.length);
    const n = document.createElement('div');
    n.className = 'winner-name';
    n.textContent = `🏆 ${names}`;
    const a = document.createElement('div');
    a.className = 'winner-amount';
    a.textContent = `${share} チップ獲得！`;
    winnerDiv.append(n, a);
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

  $('btn-next-hand').textContent = '次のハンドへ';
  $('showdown-overlay').classList.remove('hidden');
}

/** ショーダウン1行を組み立てる（名前は textContent で安全に） */
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
    resultEl.textContent = result.formula && result.formula.error ? result.formula.error : '構文エラー';
    mark = 'incorrect';
  } else {
    formulaEl.innerHTML = FormulaEvaluator.toMathHTML(result.formula.formulaString);
    const f = result.formula;
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

function nextHand() {
  $('showdown-overlay').classList.add('hidden');
  game.settle();

  if (game.isGameOver()) {
    const winner = game.players[0];
    showNotification(`ゲーム終了！ ${winner ? winner.name : '—'} の勝利！`);
    renderGame();
    return;
  }

  renderGame();
  setTimeout(() => {
    if (!game) return;
    game.startBettingRound(1);
    afterStateChange();
  }, 500);
}

// ============================================================
// タイマー
// ============================================================

function startBetTimer() {
  stopBetTimer();
  if (!game) return;
  if (game.phase !== 'BETTING_1' && game.phase !== 'BETTING_2') {
    $('timer-display').classList.add('hidden');
    return;
  }
  // CPUの手番はカウントダウンしない（AI側が自分のタイミングで動く）
  if (isCPUSeat(game.currentPlayerIdx)) {
    $('timer-display').classList.add('hidden');
    return;
  }

  let remaining = game.getCurrentTimeLimit();
  const display = $('timer-display');
  display.classList.remove('hidden');
  display.textContent = `⏱ ${remaining}`;

  betTimerInterval = setInterval(() => {
    remaining--;
    display.textContent = `⏱ ${remaining}`;
    display.classList.toggle('urgent', remaining <= 3);
    if (remaining > 0) return;

    stopBetTimer();
    const actingIdx = game.currentPlayerIdx;
    // 時間切れ: コール不要ならチェック、必要ならフォールド
    const p = game.players[actingIdx];
    const needsCall = p && (game.currentBet - p.currentBet) > 0;
    game.playerAction(actingIdx, needsCall ? 'fold' : 'check');
    if (actingIdx === currentPlayerIdx) {
      showNotification(needsCall ? '時間切れ：自動フォールド' : '時間切れ：自動チェック', true);
    }
    afterStateChange();
  }, 1000);
}

function stopBetTimer() {
  if (betTimerInterval) { clearInterval(betTimerInterval); betTimerInterval = null; }
  const d = $('timer-display');
  if (d) d.classList.remove('urgent');
}

/** 計算フェーズのタイマー（制限時間 = ポット額の秒数） */
function startCalcTimer() {
  stopCalcTimer();
  if (!game || game.phase !== 'CALCULATION') return;

  let remaining = game.calculationTimeLimit;
  const display = $('timer-display');
  display.classList.remove('hidden');
  display.textContent = `⏱ ${remaining}`;

  calcTimerInterval = setInterval(() => {
    remaining--;
    display.textContent = `⏱ ${remaining}`;
    display.classList.toggle('urgent', remaining <= 10);
    if (remaining > 0) return;

    stopCalcTimer();
    showNotification('時間切れ！未提出のプレイヤーは失格です', true);
    game.finishCalculation();
    afterStateChange();
  }, 1000);
}

function stopCalcTimer() {
  if (calcTimerInterval) { clearInterval(calcTimerInterval); calcTimerInterval = null; }
  const d = $('timer-display');
  if (d) { d.classList.add('hidden'); d.classList.remove('urgent'); }
}

// ============================================================
// ログ・通知
// ============================================================

function renderLog() {
  const panel = $('log-panel');
  panel.innerHTML = '';
  game.log.slice(-20).forEach(entry => {
    const div = document.createElement('div');
    div.className = 'log-entry';
    const time = document.createElement('span');
    time.className = 'log-time';
    time.textContent = entry.time;
    div.appendChild(time);
    div.appendChild(document.createTextNode(entry.msg)); // メッセージは常にテキスト
    panel.appendChild(div);
  });
  panel.scrollTop = panel.scrollHeight;
}

let notificationTimer = null;

function showNotification(msg, isError = false) {
  const el = $('notification');
  el.textContent = msg;
  el.classList.toggle('error', !!isError);
  el.classList.remove('hidden');
  if (notificationTimer) clearTimeout(notificationTimer);
  notificationTimer = setTimeout(() => el.classList.add('hidden'), 3000);
}

// ============================================================
// ソロモード
// ============================================================

function startSoloMode() {
  const deckCount = parseInt($('solo-deck-count').value, 10) || 1;
  soloHand = buildDeck(deckCount).slice(0, 7);
  soloStartTime = Date.now();
  isSoloMode = true;
  game = null;
  formulaText = '';

  initBuilder();
  showView('game');
  renderSoloMode();
}

function renderSoloMode() {
  $('level-display').textContent = 'SOLO';
  $('blind-display').textContent = 'スコアアタック';
  $('hand-display').textContent = 'ソロモード';
  $('pot-display').textContent = '—';
  $('center-pot-amount').textContent = '—';
  $('phase-display').textContent = '数式構築';
  $('timer-display').classList.add('hidden');

  $('opponents-area').innerHTML = '';
  $('my-name').textContent = 'あなた';
  $('my-chips').textContent = '⏱ 無制限';

  $('betting-actions').classList.add('hidden');
  $('exchange-area').classList.add('hidden');
  setWorkspaceVisible(true);
  $('result-input-row').classList.remove('auto-calc');
  $('result-input').classList.remove('hidden');
  $('declaration-hint').classList.remove('hidden');
  $('result-input').disabled = false;
  $('result-input').value = '';
  $('btn-submit-formula').disabled = false;
  $('btn-submit-formula').textContent = '提出';

  if (builder) { builder.clear(); builder.render(); }
  updateDeclarationHint();

  const panel = $('log-panel');
  panel.innerHTML = '';
  const div = document.createElement('div');
  div.className = 'log-entry';
  div.textContent = 'ソロモード開始！7枚から5枚以下で最大の数式を作ろう';
  panel.appendChild(div);
}

function submitSoloFormula() {
  const formula = builder ? builder.getFormulaString() : formulaText.trim();
  const declared = $('result-input').value.trim();

  if (!formula) { showNotification('数式を組み立ててください', true); return; }
  if (!declared) { showNotification('計算結果を入力してください', true); return; }

  const dialog = $('confirm-dialog');
  $('confirm-formula').innerHTML = FormulaEvaluator.toMathHTML(formula);
  dialog.classList.remove('hidden');

  $('btn-confirm-yes').onclick = () => {
    dialog.classList.add('hidden');
    doSubmitSoloFormula(formula, declared);
  };
  $('btn-confirm-no').onclick = () => dialog.classList.add('hidden');
}

function doSubmitSoloFormula(formula, declared) {
  const validation = FormulaEvaluator.validateFormula(formula, soloHand, 5);
  if (!validation.valid) {
    showNotification(validation.error, true);
    gameAudio.playError();
    return;
  }

  const evalResult = FormulaEvaluator.evaluate(formula);
  const systemValue = evalResult.value;
  const judged = FormulaEvaluator.judgeDeclaration(systemValue, declared);
  const elapsed = Math.round((Date.now() - soloStartTime) / 1000);

  const score = {
    formula,
    declared,
    systemResult: systemValue.toFullString(),
    tier: systemValue.tierLabel(),
    mode: judged.mode,
    isCorrect: judged.ok,
    reason: judged.reason,
    scoreLog10: systemValue.getLog10(),
    elapsed,
    usedCards: validation.usedCards.length,
    timestamp: new Date().toISOString(),
  };
  saveSoloScore(score);
  showSoloResult(score, systemValue);
}

function showSoloResult(score, systemValue) {
  const list = $('showdown-list');
  list.innerHTML = '';

  const item = document.createElement('div');
  item.className = 'showdown-item';
  if (score.isCorrect) item.classList.add('winner-item');

  const who = document.createElement('div');
  who.className = 'sd-player';
  who.textContent = 'あなた';

  const f = document.createElement('div');
  f.className = 'sd-formula';
  f.innerHTML = FormulaEvaluator.toMathHTML(score.formula);

  const r = document.createElement('div');
  r.className = 'sd-result';
  r.textContent = `入力: ${score.declared} / 評価: ${score.systemResult}（${score.tier}）`;

  const mark = document.createElement('span');
  mark.className = `sd-mark ${score.isCorrect ? 'correct' : 'incorrect'}`;
  mark.textContent = score.isCorrect ? '○' : '×';

  item.append(who, f, r, mark);
  list.appendChild(item);

  const winnerDiv = $('showdown-winner');
  winnerDiv.innerHTML = '';
  const title = document.createElement('div');
  title.className = 'winner-name';
  const detail = document.createElement('div');
  detail.className = 'winner-amount';

  if (score.isCorrect) {
    title.textContent = '🎯 正解！';
    detail.textContent = `評価値: ${score.systemResult} / 使用 ${score.usedCards}枚 / ${score.elapsed}秒`;
    gameAudio.playWin();
  } else {
    title.textContent = '計算ミス';
    detail.textContent = `${score.reason || '不一致'} — 正解は ${score.systemResult}`;
    gameAudio.playLose();
  }
  winnerDiv.append(title, detail);

  const best = loadSoloScores()[0];
  if (best) {
    const bestLine = document.createElement('div');
    bestLine.className = 'winner-sub';
    bestLine.textContent = `自己ベスト: ${best.systemResult}`;
    winnerDiv.appendChild(bestLine);
  }

  const btn = $('btn-next-hand');
  btn.textContent = 'もう一度プレイ';
  $('showdown-overlay').classList.remove('hidden');
}

// ============================================================
// イベントリスナー
// ============================================================

function initEventListeners() {
  $('btn-show-setup').addEventListener('click', () => {
    gameAudio.resume(); gameAudio.playClick();
    showView('setup'); initSetupScreen();
    // CPUの学習済み方策を先読みしておく（対戦開始までに間に合わせる）
    if (window.AIPolicy && $('cpu-level')) AIPolicy.loadPolicy($('cpu-level').value);
  });
  $('btn-show-solo').addEventListener('click', () => {
    gameAudio.resume(); gameAudio.playClick(); showView('solo');
  });
  $('btn-show-rules').addEventListener('click', () => {
    gameAudio.resume(); gameAudio.playClick(); showView('rules');
  });

  $('btn-back-home').addEventListener('click', () => { gameAudio.playClick(); showView('home'); });
  $('btn-back-home-solo').addEventListener('click', () => { gameAudio.playClick(); showView('home'); });
  $('btn-back-home-rules').addEventListener('click', () => { gameAudio.playClick(); showView('home'); });

  $('btn-start-game').addEventListener('click', () => {
    gameAudio.resume(); gameAudio.playClick(); startGame();
  });
  $('btn-start-solo').addEventListener('click', () => {
    gameAudio.resume(); gameAudio.playClick(); startSoloMode();
  });

  $('player-count').addEventListener('change', updatePlayerNameInputs);
  $('initial-chips').addEventListener('change', () => {
    window._blindManualOverride = false;
    updateBlindRatios();
  });
  ['small-blind', 'big-blind', 'ante'].forEach(id => {
    $(id).addEventListener('change', () => { window._blindManualOverride = true; });
  });

  $('btn-quit-game').addEventListener('click', () => {
    if (!confirm('ゲームを終了しますか？')) return;
    stopBetTimer(); stopCalcTimer(); clearAITimers();
    game = null; isSoloMode = false; aiPlayers = {};
    showView('home');
  });

  if ($('cpu-mode')) {
    $('cpu-mode').addEventListener('change', updatePlayerNameInputs);
    $('cpu-level').addEventListener('change', () => {
      updatePlayerNameInputs();
      // 選ばれたレベルの学習済み方策を先読みしておく
      if (window.AIPolicy) AIPolicy.loadPolicy($('cpu-level').value);
    });
  }

  $('btn-fold').addEventListener('click', () => doAction('fold'));
  $('btn-check').addEventListener('click', () => doAction('check'));
  $('btn-call').addEventListener('click', () => doAction('call'));
  $('btn-raise').addEventListener('click', () => doAction('raise'));
  $('btn-allin').addEventListener('click', () => doAction('allin'));
  $('btn-exchange').addEventListener('click', doExchange);

  $('btn-submit-formula').addEventListener('click', () => {
    if (isSoloMode) submitSoloFormula(); else submitFormula();
  });
  $('result-input').addEventListener('input', () => {
    const el = $('declaration-preview');
    if (!el) return;
    const parsed = FormulaEvaluator.parseDeclaration($('result-input').value);
    if (!parsed) { el.textContent = ''; return; }
    el.textContent = parsed.kind === 'digits'
      ? `→ ${parsed.digits.toString()} 桁 として解釈`
      : `→ ${parsed.value.toString()} として解釈`;
  });

  $('btn-next-hand').addEventListener('click', () => {
    if (isSoloMode) {
      $('showdown-overlay').classList.add('hidden');
      showView('solo');
      return;
    }
    nextHand();
  });

  document.addEventListener('keydown', (e) => {
    const dialogOpen = !$('confirm-dialog').classList.contains('hidden');
    if (!dialogOpen) return;
    if (e.key === 'Enter') $('btn-confirm-yes').click();
    if (e.key === 'Escape') $('btn-confirm-no').click();
  });
}

document.addEventListener('DOMContentLoaded', () => {
  initEventListeners();
  showView('home');

});
