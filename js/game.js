/**
 * game.js - 巨大数ポーカー ゲームロジック
 * デッキ・プレイヤー・状態機械・ベット・交換・ショーダウン・精算
 *
 * 注意: このオブジェクトの状態は socket.io で JSON 化して配信されるため、
 *       BigInt / HugeNumber をプレイヤー状態に直接持たせないこと。
 *       巨大数は必要なときに formulaString から再評価する。
 */

/* global HugeNumber, FormulaEvaluator */
const _engine = (typeof require !== 'undefined' && typeof module !== 'undefined')
  ? require('./engine.js')
  : null;
const Eval = _engine ? _engine.FormulaEvaluator : (typeof FormulaEvaluator !== 'undefined' ? FormulaEvaluator : null);

// ============================================================
// カード定義
// ============================================================

const CARD_DEFS = {
  '+':  { type: 'operator', value: '+',  display: '+',  color: 'green',  label: '加算' },
  '*':  { type: 'operator', value: '*',  display: '×',  color: 'blue',   label: '乗算' },
  '^':  { type: 'operator', value: '^',  display: '^',  color: 'red',    label: 'べき乗' },
  '!':  { type: 'operator', value: '!',  display: '!',  color: 'purple', label: '階乗' },
  'P':  { type: 'operator', value: 'P',  display: 'P',  color: 'orange', label: '順列' },
  '↑↑': { type: 'operator', value: '↑↑', display: '↑↑', color: 'joker',  label: 'テトレーション' },
};

const HAND_SIZE = 7;
const MAX_FORMULA_CARDS = 5;

function buildDeck(deckCount = 1) {
  const deck = [];
  let id = 0;

  for (let d = 0; d < deckCount; d++) {
    for (let num = 2; num <= 9; num++) {
      for (let i = 0; i < 4; i++) {
        deck.push({
          id: `n${id++}`, type: 'number', value: num,
          display: String(num), suit: ['♠', '♥', '♦', '♣'][i],
        });
      }
    }
    const ops = [
      { value: '+', count: 4 }, { value: '*', count: 4 }, { value: '^', count: 4 },
      { value: '!', count: 4 }, { value: 'P', count: 4 }, { value: '↑↑', count: 2 },
    ];
    for (const op of ops) {
      for (let i = 0; i < op.count; i++) {
        const def = CARD_DEFS[op.value];
        deck.push({
          id: `o${id++}`, type: 'operator', value: op.value,
          display: def.display, color: def.color, label: def.label,
        });
      }
    }
  }
  return shuffle(deck);
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ============================================================
// ゲーム状態
// ============================================================

const PHASES = {
  SETTING: 'SETTING', DEALING: 'DEALING', BETTING_1: 'BETTING_1',
  EXCHANGE: 'EXCHANGE', BETTING_2: 'BETTING_2', CALCULATION: 'CALCULATION',
  SHOWDOWN: 'SHOWDOWN', SETTLEMENT: 'SETTLEMENT',
};

const DEFAULT_CONFIG = {
  initialChips: 1000,
  smallBlind: 10,
  bigBlind: 20,
  ante: 5,
  betTimeLimit: 10,
  dealerTimeLimit: 20,
  levelUpHands: 5,
  deckCount: 1,
  autoCalcMode: false,
  minCalcTime: 30,
  maxCalcTime: 600,
};

class Game {
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.phase = PHASES.SETTING;
    this.players = [];
    this.deck = [];
    this.discardPile = [];
    this.pot = 0;
    this.carryOver = 0;      // 次ハンドへ持ち越すチップ
    this.currentBet = 0;
    this.minRaise = 0;
    this.currentPlayerIdx = 0;
    this.dealerIdx = 0;
    this.handNumber = 0;
    this.level = 1;
    this.betRound = 1;
    this.winners = [];
    this.showdownResults = [];
    this.log = [];
    this.calculationTimeLimit = 0;
    this.gameOver = false;
  }

  // ============================================================
  // セットアップ
  // ============================================================

  /**
   * @param {number} playerCount
   * @param {string[]} playerNames
   * @param {object} options { cpuLevels: (string|null)[] } — 各席のAIレベル。
   *        null なら人間。AIの実体は js/ai.js が持ち、ここではフラグだけ保持する。
   */
  startGame(playerCount, playerNames = [], options = {}) {
    const cpuLevels = options.cpuLevels || [];
    this.players = [];
    for (let i = 0; i < playerCount; i++) {
      this.players.push({
        id: `p${i}`,
        name: playerNames[i] || `P${i + 1}`,
        chips: this.config.initialChips,
        hand: [],
        isCPU: !!cpuLevels[i],
        aiLevel: cpuLevels[i] || null,
        isDealer: i === 0,
        isActive: true,
        isEliminated: false,
        currentBet: 0,
        totalBet: 0,
        anteBet: 0,
        formula: null,
        hasSubmitted: false,
        hasActed: false,
        isAllIn: false,
        isReady: false,
      });
    }
    this.dealerIdx = 0;
    this.handNumber = 0;
    this.level = 1;
    this.pot = 0;
    this.carryOver = 0;
    this.gameOver = false;
    this.log = [];
    this._startNewHand();
  }

  /** 脱落していないプレイヤー */
  livePlayers() { return this.players.filter(p => !p.isEliminated); }

  /** このハンドにまだ参加しているプレイヤー */
  activePlayers() { return this.players.filter(p => !p.isEliminated && p.isActive); }

  isGameOver() { return this.gameOver || this.livePlayers().length <= 1; }

  // ============================================================
  // ハンド進行
  // ============================================================

  _startNewHand() {
    this.handNumber++;
    this._checkLevelUp();

    this.deck = buildDeck(this.config.deckCount);
    this.discardPile = [];

    this.players.forEach((p, i) => {
      p.hand = [];
      p.isActive = !p.isEliminated;
      p.currentBet = 0;
      p.totalBet = 0;
      p.anteBet = 0;
      p.formula = null;
      p.hasSubmitted = false;
      p.hasActed = false;
      p.isAllIn = false;
      p.isReady = false;
      p.isDealer = (i === this.dealerIdx);
    });

    // 前ハンドからの持ち越しを引き継ぐ（勝者なし・山分けの端数）
    this.pot = this.carryOver;
    if (this.carryOver > 0) {
      this._log(`前ハンドからの持ち越し ${this.carryOver} をポットに加算`);
      this.carryOver = 0;
    }

    this.currentBet = 0;
    this.minRaise = this.config.bigBlind;
    this.betRound = 1;
    this.winners = [];
    this.showdownResults = [];
    this._uiCalcStarted = false;
    this._uiExchangeAnnounced = false;
    this._aiCalcPlan = null;      // CPUの提出予定（ui.js が使う）

    this._collectAnte();
    this._postBlinds();
    this._dealCards();

    this.phase = PHASES.DEALING;
    this._log(`ハンド #${this.handNumber} 開始`);
  }

  _checkLevelUp() {
    const n = this.config.levelUpHands;
    if (n > 0 && this.handNumber > 1 && (this.handNumber - 1) % n === 0) {
      this.level++;
      this.config.smallBlind *= 2;
      this.config.bigBlind *= 2;
      this.config.ante *= 2;
      this._log(`レベルアップ！ レベル${this.level} ブラインド ${this.config.smallBlind}/${this.config.bigBlind}`);
    }
  }

  /**
   * アンティ徴収。
   * アンティは「場に出したベット」ではなくポットへの強制拠出なので、
   * currentBet には加算しない（加算するとコール額の計算が狂う）。
   */
  _collectAnte() {
    if (this.config.ante <= 0) return;
    for (const p of this.livePlayers()) {
      const ante = Math.min(this.config.ante, p.chips);
      p.chips -= ante;
      p.anteBet = ante;
      p.totalBet += ante;
      this.pot += ante;
      if (p.chips === 0) p.isAllIn = true;
    }
  }

  _postBlinds() {
    const live = this.livePlayers();
    if (live.length < 2) return;

    const sb = this._playerAtOffset(this.dealerIdx, 1);
    const bb = this._playerAtOffset(this.dealerIdx, 2);
    if (!sb || !bb) return;

    const sbAmount = Math.min(this.config.smallBlind, sb.chips);
    sb.chips -= sbAmount;
    sb.currentBet += sbAmount;
    sb.totalBet += sbAmount;
    this.pot += sbAmount;
    if (sb.chips === 0) sb.isAllIn = true;

    const bbAmount = Math.min(this.config.bigBlind, bb.chips);
    bb.chips -= bbAmount;
    bb.currentBet += bbAmount;
    bb.totalBet += bbAmount;
    this.pot += bbAmount;
    if (bb.chips === 0) bb.isAllIn = true;

    this.currentBet = Math.max(sb.currentBet, bb.currentBet);
    this._log(`${sb.name} が小ブラインド ${sbAmount}`);
    this._log(`${bb.name} が大ブラインド ${bbAmount}`);
  }

  /** dealerIdx から数えて offset 番目の「脱落していない」プレイヤー */
  _playerAtOffset(fromIdx, offset) {
    const n = this.players.length;
    let count = 0;
    for (let i = 1; i <= n; i++) {
      const idx = (fromIdx + i) % n;
      if (this.players[idx].isEliminated) continue;
      count++;
      if (count === offset) return this.players[idx];
    }
    return null;
  }

  _playerIndexAtOffset(fromIdx, offset) {
    const p = this._playerAtOffset(fromIdx, offset);
    return p ? this.players.indexOf(p) : -1;
  }

  /** 山札から1枚引く（尽きたら捨て札をシャッフルして戻す） */
  _draw() {
    if (this.deck.length === 0) {
      if (this.discardPile.length === 0) return null;
      this.deck = shuffle(this.discardPile);
      this.discardPile = [];
      this._log('山札が尽きたため捨て札をシャッフルして再利用');
    }
    return this.deck.pop();
  }

  _dealCards() {
    for (let i = 0; i < HAND_SIZE; i++) {
      for (const p of this.livePlayers()) {
        const card = this._draw();
        if (card) p.hand.push(card);
      }
    }
  }

  // ============================================================
  // ベットラウンド
  // ============================================================

  startBettingRound(round) {
    this.betRound = round;
    this.phase = round === 1 ? PHASES.BETTING_1 : PHASES.BETTING_2;

    this.players.forEach(p => {
      p.isReady = false;
      p.hasActed = false;
    });

    if (round === 1) {
      // ブラインドは既に場に出ている。currentBet をリセットしてはいけない。
      this.currentBet = Math.max(0, ...this.players.map(p => p.currentBet));
      this.minRaise = this.config.bigBlind;
      // 最初のアクションは大ブラインドの次のプレイヤー
      this.currentPlayerIdx = this._nextActivePlayer(this._playerIndexAtOffset(this.dealerIdx, 2));
    } else {
      this.players.forEach(p => { p.currentBet = 0; });
      this.currentBet = 0;
      this.minRaise = this.config.bigBlind;
      this.currentPlayerIdx = this._nextActivePlayer(this.dealerIdx);
    }

    this._log(`ベットラウンド${round}開始`);

    // アクションできるプレイヤーがいない場合は即終了
    if (this.currentPlayerIdx === -1) this._endBettingRound();
  }

  _nextActivePlayer(fromIdx) {
    const n = this.players.length;
    if (fromIdx < 0) fromIdx = 0;
    for (let i = 1; i <= n; i++) {
      const idx = (fromIdx + i) % n;
      const p = this.players[idx];
      if (!p.isEliminated && p.isActive && !p.isAllIn) return idx;
    }
    return -1;
  }

  playerAction(playerIdx, action, amount = 0) {
    if (this.phase !== PHASES.BETTING_1 && this.phase !== PHASES.BETTING_2) {
      return { ok: false, error: 'ベットフェーズではありません' };
    }
    if (playerIdx !== this.currentPlayerIdx) {
      return { ok: false, error: 'あなたの番ではありません' };
    }

    const player = this.players[playerIdx];
    if (!player || !player.isActive || player.isEliminated) {
      return { ok: false, error: 'アクションできません' };
    }

    const toCall = this.currentBet - player.currentBet;

    switch (action) {
      case 'fold':
        player.isActive = false;
        this._log(`${player.name} がフォールド`);
        break;

      case 'check':
        if (toCall > 0) return { ok: false, error: 'チェックできません（コールが必要です）' };
        this._log(`${player.name} がチェック`);
        break;

      case 'call': {
        if (toCall <= 0) return { ok: false, error: 'コールする額がありません' };
        const amt = Math.min(toCall, player.chips);
        this._commitChips(player, amt);
        this._log(player.isAllIn
          ? `${player.name} がオールイン（コール ${amt}）`
          : `${player.name} がコール ${amt}`);
        break;
      }

      case 'raise': {
        const minTotal = this.currentBet + this.minRaise;
        const maxTotal = player.currentBet + player.chips;
        if (amount >= maxTotal) return this.playerAction(playerIdx, 'allin');
        if (amount < minTotal) {
          return { ok: false, error: `レイズ額は最低 ${minTotal} 以上です` };
        }
        const delta = amount - player.currentBet;
        this._commitChips(player, delta);
        const increment = player.currentBet - this.currentBet;
        this.currentBet = player.currentBet;
        this.minRaise = Math.max(this.minRaise, increment);
        this._resetActedAfterRaise(playerIdx);
        this._log(`${player.name} がレイズ ${amount}`);
        break;
      }

      case 'allin': {
        const amt = player.chips;
        if (amt <= 0) return { ok: false, error: 'チップがありません' };
        this._commitChips(player, amt);
        if (player.currentBet > this.currentBet) {
          const increment = player.currentBet - this.currentBet;
          this.currentBet = player.currentBet;
          this.minRaise = Math.max(this.minRaise, increment);
          this._resetActedAfterRaise(playerIdx);
        }
        this._log(`${player.name} がオールイン ${amt}`);
        break;
      }

      default:
        return { ok: false, error: '不明なアクション' };
    }

    player.hasActed = true;
    this._advanceBetting();
    return { ok: true };
  }

  _commitChips(player, amount) {
    const amt = Math.max(0, Math.min(amount, player.chips));
    player.chips -= amt;
    player.currentBet += amt;
    player.totalBet += amt;
    this.pot += amt;
    if (player.chips === 0) player.isAllIn = true;
  }

  /** レイズが入ったら、他のプレイヤーは再度アクションが必要になる */
  _resetActedAfterRaise(raiserIdx) {
    this.players.forEach((p, i) => {
      if (i !== raiserIdx && p.isActive && !p.isEliminated && !p.isAllIn) p.hasActed = false;
    });
  }

  _advanceBetting() {
    if (this.activePlayers().length <= 1) { this._endBettingRound(); return; }

    // 全員がアクション済みかつベット額が揃っていればラウンド終了
    const pending = this.players.filter(p =>
      !p.isEliminated && p.isActive && !p.isAllIn &&
      (!p.hasActed || p.currentBet !== this.currentBet));

    if (pending.length === 0) { this._endBettingRound(); return; }

    const next = this._nextActivePlayer(this.currentPlayerIdx);
    if (next === -1) { this._endBettingRound(); return; }
    this.currentPlayerIdx = next;
  }

  _endBettingRound() {
    if (this.activePlayers().length <= 1) { this._goToShowdown(); return; }
    if (this.betRound === 1) this.startExchange();
    else this._goToCalculation();
  }

  // ============================================================
  // 交換フェーズ
  // ============================================================

  startExchange() {
    this.phase = PHASES.EXCHANGE;
    this.players.forEach(p => { p.isReady = false; p.exchangeCards = []; });
    this._log('交換フェーズ開始');
  }

  selectExchangeCards(playerIdx, cardIds) {
    const player = this.players[playerIdx];
    if (!player || !player.isActive) return;
    player.exchangeCards = cardIds || [];
  }

  readyExchange(playerIdx) {
    const player = this.players[playerIdx];
    if (!player || !player.isActive || player.isReady) return;
    player.isReady = true;

    const ids = player.exchangeCards || [];
    const discard = player.hand.filter(c => ids.includes(c.id));
    player.hand = player.hand.filter(c => !ids.includes(c.id));

    for (let i = 0; i < discard.length; i++) {
      const card = this._draw();
      if (card) player.hand.push(card);
    }
    this.discardPile.push(...discard);

    this._log(`${player.name} が ${discard.length} 枚交換`);

    if (this.activePlayers().every(p => p.isReady)) {
      this.startBettingRound(2);
    }
  }

  // ============================================================
  // 計算フェーズ
  // ============================================================

  _goToCalculation() {
    this.phase = PHASES.CALCULATION;
    // 入力時間 = ポットの合計チップ数（秒）。極端な値は上下限で丸める。
    this.calculationTimeLimit = Math.max(
      this.config.minCalcTime,
      Math.min(this.config.maxCalcTime, this.pot)
    );
    this.players.forEach(p => {
      p.isReady = false;
      p.formula = null;
      p.hasSubmitted = false;
    });
    this._log(`計算フェーズ開始（制限時間 ${this.calculationTimeLimit}秒）`);
  }

  /**
   * 数式を提出する。
   * @param {number} playerIdx
   * @param {string} formulaString
   * @param {string} declaredResult プレイヤーの申告（autoCalcMode 時は無視）
   */
  submitFormula(playerIdx, formulaString, declaredResult) {
    const player = this.players[playerIdx];
    if (!player || !player.isActive) return { ok: false, error: 'フォールド済みです' };
    if (player.hasSubmitted) return { ok: false, error: '既に提出済みです' };
    if (this.phase !== PHASES.CALCULATION) return { ok: false, error: '計算フェーズではありません' };

    const validation = Eval.validateFormula(formulaString, player.hand, MAX_FORMULA_CARDS);
    if (!validation.valid) return { ok: false, error: validation.error };

    const evalResult = Eval.evaluate(formulaString);
    if (!evalResult.ok) return { ok: false, error: evalResult.error };

    const systemValue = evalResult.value;
    const auto = !!this.config.autoCalcMode;

    let isCorrect = true;
    let mode = 'auto';
    let reason = null;

    if (!auto) {
      const judged = Eval.judgeDeclaration(systemValue, declaredResult);
      isCorrect = judged.ok;
      mode = judged.mode;
      reason = judged.reason;
    }

    // JSON 化されるので文字列だけを保持する（BigInt は入れない）
    player.formula = {
      usedCards: validation.usedCards,
      formulaString: evalResult.normalized,
      playerDeclaredResult: auto ? null : String(declaredResult || ''),
      systemEvaluatedResult: systemValue.toFullString(),
      tier: systemValue.tierLabel(),
      judgeMode: mode,
      reason,
      isCorrect,
      isValid: true,
      autoCalculated: auto,
    };
    player.hasSubmitted = true;
    player.isReady = true;
    this._log(`${player.name} が数式を提出`);

    if (this.activePlayers().every(p => p.hasSubmitted)) this._goToShowdown();
    return { ok: true, submission: player.formula };
  }

  /** 制限時間切れ: 未提出者を失格にしてショーダウンへ */
  finishCalculation() {
    if (this.phase !== PHASES.CALCULATION) return;
    for (const p of this.activePlayers()) {
      if (!p.hasSubmitted) {
        p.formula = null;
        this._log(`${p.name} は時間内に提出できず失格`);
      }
    }
    this._goToShowdown();
  }

  // ============================================================
  // ショーダウン
  // ============================================================

  _goToShowdown() {
    this.phase = PHASES.SHOWDOWN;
    this._calculateShowdown();
    this._log('ショーダウン');
  }

  _calculateShowdown() {
    const results = [];

    // 他が全員フォールドしたら、残った1人が数式を出すまでもなく勝ち。
    // これが無いと「未提出＝失格」に落ちて、ポットが誰にも渡らず
    // 永久に持ち越されてしまう（ポーカーの基本ルール）。
    const standing = this.players.filter(p => !p.isEliminated && p.isActive);
    if (standing.length === 1 && this.livePlayers().length > 1) {
      const winner = standing[0];
      this.winners = [{ player: winner }];
      this.showdownResults = this.players
        .filter(p => !p.isEliminated)
        .map(p => ({
          player: p,
          status: p === winner ? 'uncontested' : 'fold',
          formula: p === winner ? p.formula : null,
          valueString: null,
        }));
      this._log(`${winner.name} が不戦勝（他全員フォールド）`);
      return;
    }

    for (const p of this.players) {
      if (p.isEliminated) continue;

      if (!p.isActive) {
        results.push({ player: p, status: 'fold', formula: null, valueString: null, _value: null });
        continue;
      }
      if (!p.formula) {
        results.push({ player: p, status: 'nosubmit', formula: null, valueString: null, _value: null });
        continue;
      }
      if (!p.formula.isValid) {
        results.push({ player: p, status: 'invalid', formula: p.formula, valueString: null, _value: null });
        continue;
      }
      if (!p.formula.isCorrect) {
        results.push({ player: p, status: 'incorrect', formula: p.formula, valueString: p.formula.systemEvaluatedResult, _value: null });
        continue;
      }

      // 有効な提出のみ、比較用に値を再評価する
      const ev = Eval.evaluate(p.formula.formulaString);
      results.push({
        player: p,
        status: ev.ok ? 'correct' : 'invalid',
        formula: p.formula,
        valueString: ev.ok ? ev.value.toFullString() : null,
        _value: ev.ok ? ev.value : null,
      });
    }

    // 勝者判定: 有効かつ正解のプレイヤーの中で評価値が最大
    const contenders = results.filter(r => r.status === 'correct' && r._value);
    contenders.sort((a, b) => b._value.compare(a._value));

    this.winners = [];
    if (contenders.length > 0) {
      const top = contenders[0]._value;
      this.winners = contenders
        .filter(r => r._value.compare(top) === 0)
        .map(r => ({ player: r.player }));
    }

    // 表示順: 評価値の降順 → 失格 → 未提出 → フォールド
    const rank = { correct: 0, incorrect: 1, invalid: 2, nosubmit: 3, fold: 4 };
    const display = results.slice().sort((a, b) => {
      if (rank[a.status] !== rank[b.status]) return rank[a.status] - rank[b.status];
      if (a._value && b._value) return b._value.compare(a._value);
      return 0;
    });

    // HugeNumber は JSON 化できないので配信用の状態からは外す
    this.showdownResults = display.map(r => ({
      player: r.player,
      status: r.status,
      formula: r.formula,
      valueString: r.valueString,
    }));
  }

  // ============================================================
  // 精算
  // ============================================================

  settle() {
    if (this.phase === PHASES.SETTLEMENT) return;
    this.phase = PHASES.SETTLEMENT;

    if (this.winners.length === 0) {
      // 勝者なし（全員が失格）→ 持ち越さず、出した分をそのまま返す。
      // 全員スコア0の同点扱いなので、チップの移動は起きない。
      let refunded = 0;
      for (const p of this.players) {
        if (p.isEliminated || p.totalBet <= 0) continue;
        p.chips += p.totalBet;
        refunded += p.totalBet;
        if (p.chips > 0) p.isAllIn = false;
      }
      // 前ハンドの端数など、誰の拠出でもない分だけが残る
      this.carryOver = Math.max(0, this.pot - refunded);
      this.pot = 0;
      this._log(`勝者なし（全員スコア0の同点）。ポット ${refunded} は払い戻し`);
    } else {
      const share = Math.floor(this.pot / this.winners.length);
      const remainder = this.pot % this.winners.length;
      for (const w of this.winners) {
        w.player.chips += share;
        this._log(`${w.player.name} が ${share} チップ獲得`);
      }
      this.carryOver = remainder;
      this.pot = 0;
      if (remainder > 0) this._log(`端数 ${remainder} は次ハンドへ持ち越し`);
    }

    // 脱落判定（配列から削除せずフラグで管理する。
    // 削除するとオンライン側の room.players とインデックスがずれるため）
    for (const p of this.players) {
      if (!p.isEliminated && p.chips <= 0) {
        p.isEliminated = true;
        p.isActive = false;
        this._log(`${p.name} が脱落`);
      }
    }

    if (this.livePlayers().length <= 1) {
      this.gameOver = true;
      const winner = this.livePlayers()[0];
      this._log(`ゲーム終了！ ${winner ? winner.name : '引き分け'} の勝利！`);
      return;
    }

    this._nextHand();
  }

  _nextHand() {
    // ディーラーボタンは脱落者を飛ばして移動
    const next = this._playerIndexAtOffset(this.dealerIdx, 1);
    if (next >= 0) this.dealerIdx = next;
    this._startNewHand();
  }

  // ============================================================
  // タイマー・ユーティリティ
  // ============================================================

  getCurrentTimeLimit() {
    if (this.phase === PHASES.CALCULATION) return this.calculationTimeLimit;
    const player = this.players[this.currentPlayerIdx];
    if (player && player.isDealer) return this.config.dealerTimeLimit;
    return this.config.betTimeLimit;
  }

  _log(msg) {
    this.log.push({ time: new Date().toLocaleTimeString('ja-JP'), msg });
    if (this.log.length > 200) this.log.shift();
  }
}

// エクスポート
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { Game, PHASES, DEFAULT_CONFIG, buildDeck, shuffle, CARD_DEFS, MAX_FORMULA_CARDS, HAND_SIZE };
}
if (typeof window !== 'undefined') {
  window.Game = Game;
  window.PHASES = PHASES;
  window.buildDeck = buildDeck;
  window.CARD_DEFS = CARD_DEFS;
  window.MAX_FORMULA_CARDS = MAX_FORMULA_CARDS;
  window.HAND_SIZE = HAND_SIZE;
}
