/**
 * builder.js - 共通ドラッグ&ドロップ数式ビルダー
 * ローカル / ソロ / オンライン 全モードで共用
 *
 * モデル: 順序付き配列 (sequence)
 *   { instanceId, card: Card | { type:'paren', value:'('|')' } }
 */

const BUILDER_MAX_CARDS = 5; // 括弧を除いた使用可能枚数

function prefersReducedMotion() {
  return typeof window !== 'undefined' &&
    window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * カードDOMを生成する（ローカル・ソロ・オンラインで共通）。
 * ここを共通化しておかないとモードごとに見た目が食い違う。
 */
function createStandardCardElement(card) {
  const esc = (typeof escapeHtml === 'function') ? escapeHtml : (s) => String(s);
  const el = document.createElement('div');
  el.className = 'card';
  if (card.id) el.dataset.cardId = card.id;

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
  } else if (card.type === 'operator') {
    el.classList.add('operator', `op-${card.color || 'green'}`);
    el.innerHTML = `
      <span class="card-face">${esc(card.display || card.value)}</span>
      <span class="card-label">${esc(card.label || '')}</span>`;
    el.setAttribute('aria-label', `演算子カード ${card.label || card.value}`);
  } else {
    el.classList.add('back-card');
    el.innerHTML = '<span class="card-face">?</span>';
    el.setAttribute('aria-label', '伏せられたカード');
  }

  return el;
}

class FormulaBuilder {
  /**
   * @param {Object} opts
   * @param {HTMLElement} opts.handArea 手札コンテナ
   * @param {HTMLElement} opts.builderArea 配置エリアコンテナ
   * @param {HTMLElement} opts.previewEl プレビュー要素
   * @param {Function} opts.getHand 手札カード配列を返す関数
   * @param {Function} opts.onSequenceChange (formulaString, usedCardIds) => void
   * @param {Function} opts.createCardEl カードDOM生成関数
   * @param {Function} opts.isLocked ロック中か（提出済み等）
   * @param {number}   opts.maxCards 使用可能枚数（既定 5）
   */
  constructor(opts) {
    this.handArea = opts.handArea;
    this.builderArea = opts.builderArea;
    this.previewEl = opts.previewEl;
    this.getHand = opts.getHand;
    this.onSequenceChange = opts.onSequenceChange || (() => {});
    this.createCardEl = opts.createCardEl;
    this.isLocked = opts.isLocked || (() => false);
    this.maxCards = opts.maxCards || BUILDER_MAX_CARDS;

    this.sequence = [];
    this.instanceCounter = 0;
    this.usedCardIds = new Set();
    this.insertIndex = null;      // ドラッグ中の挿入位置
    this.draggingInstanceId = null;

    this._initDom();
  }

  // ============================================================
  // DOM初期化
  // ============================================================

  _initDom() {
    // 既に初期化済みの配置エリアなら中身を作り直す（多重生成を防ぐ）
    if (this.builderArea._hnpBuilder) {
      this.builderArea._hnpBuilder._detach();
    }
    this.builderArea._hnpBuilder = this;

    // HTML 側に静的に置かれた .builder-empty を再利用する。無ければ作る。
    this.builderArea.innerHTML = '';
    this.emptyEl = document.createElement('div');
    this.emptyEl.className = 'builder-empty';
    this.emptyEl.textContent = 'ここにカードをドラッグ＆ドロップして数式を作る';

    this.sequenceEl = document.createElement('div');
    this.sequenceEl.className = 'builder-sequence';

    this.builderArea.appendChild(this.emptyEl);
    this.builderArea.appendChild(this.sequenceEl);

    this._onBuilderDragOver = (e) => {
      if (this.isLocked()) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      this.builderArea.classList.add('drag-over');
      this._showInsertIndicator(this._computeInsertIndex(e.clientX));
    };
    this._onBuilderDragLeave = (e) => {
      if (e.target !== this.builderArea) return;
      this.builderArea.classList.remove('drag-over');
      this._clearInsertIndicator();
    };
    this._onBuilderDrop = (e) => {
      e.preventDefault();
      this.builderArea.classList.remove('drag-over');
      if (this.isLocked()) return;
      this._handleDrop(e);
    };
    this._onHandDragOver = (e) => {
      if (this.isLocked()) return;
      e.preventDefault();
      this.handArea.classList.add('drag-over');
    };
    this._onHandDragLeave = () => this.handArea.classList.remove('drag-over');
    this._onHandDrop = (e) => {
      e.preventDefault();
      this.handArea.classList.remove('drag-over');
      if (this.isLocked()) return;
      this._handleReturnToHand(e);
    };

    this.builderArea.addEventListener('dragover', this._onBuilderDragOver);
    this.builderArea.addEventListener('dragleave', this._onBuilderDragLeave);
    this.builderArea.addEventListener('drop', this._onBuilderDrop);
    this.handArea.addEventListener('dragover', this._onHandDragOver);
    this.handArea.addEventListener('dragleave', this._onHandDragLeave);
    this.handArea.addEventListener('drop', this._onHandDrop);
  }

  /** 古いインスタンスのリスナーを外す */
  _detach() {
    this.builderArea.removeEventListener('dragover', this._onBuilderDragOver);
    this.builderArea.removeEventListener('dragleave', this._onBuilderDragLeave);
    this.builderArea.removeEventListener('drop', this._onBuilderDrop);
    this.handArea.removeEventListener('dragover', this._onHandDragOver);
    this.handArea.removeEventListener('dragleave', this._onHandDragLeave);
    this.handArea.removeEventListener('drop', this._onHandDrop);
  }

  // ============================================================
  // 描画
  // ============================================================

  render() {
    this.renderHand();
    this._renderSequence();
    this._updatePreview();
  }

  renderHand() {
    this.handArea.innerHTML = '';
    const hand = this.getHand() || [];
    const locked = this.isLocked();

    hand.forEach(card => {
      const el = this.createCardEl(card);
      const isUsed = this.usedCardIds.has(card.id);
      if (isUsed) el.classList.add('used');

      el.draggable = !isUsed && !locked;
      el.setAttribute('aria-disabled', String(isUsed || locked));

      el.addEventListener('dragstart', (e) => {
        if (locked || isUsed) { e.preventDefault(); return; }
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('application/json', JSON.stringify({ type: 'hand', card }));
        el.classList.add('dragging');
      });
      el.addEventListener('dragend', () => {
        el.classList.remove('dragging');
        this._clearInsertIndicator();
        this.builderArea.classList.remove('drag-over');
      });

      this.handArea.appendChild(el);
    });
  }

  _renderSequence() {
    // FLIP: 再構築前の位置を記録
    const prevRects = new Map();
    this.sequenceEl.querySelectorAll('.placed-card').forEach(el => {
      prevRects.set(el.dataset.instanceId, el.getBoundingClientRect());
    });

    this.sequenceEl.innerHTML = '';
    this.emptyEl.style.display = this.sequence.length === 0 ? '' : 'none';

    this.sequence.forEach((item) => {
      const el = this.createCardEl(item.card);
      el.classList.add('placed-card');
      el.dataset.instanceId = item.instanceId;
      el.draggable = !this.isLocked();

      el.addEventListener('dragstart', (e) => {
        if (this.isLocked()) { e.preventDefault(); return; }
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('application/json', JSON.stringify({
          type: 'placed',
          instanceId: item.instanceId,
          card: item.card,
        }));
        this.draggingInstanceId = item.instanceId;
        // 描画後にクラスを付けないとドラッグ画像が半透明になる
        setTimeout(() => el.classList.add('dragging'), 0);
      });
      el.addEventListener('dragend', () => {
        el.classList.remove('dragging');
        this.draggingInstanceId = null;
        this._clearInsertIndicator();
        this.builderArea.classList.remove('drag-over');
      });

      this.sequenceEl.appendChild(el);
    });

    this._playFlip(prevRects);
  }

  /** 移動前後の差分を transform で補間する */
  _playFlip(prevRects) {
    if (prevRects.size === 0 || prefersReducedMotion()) return;
    this.sequenceEl.querySelectorAll('.placed-card').forEach(el => {
      const before = prevRects.get(el.dataset.instanceId);
      if (!before) return;
      const after = el.getBoundingClientRect();
      const dx = before.left - after.left;
      const dy = before.top - after.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      el.style.transition = 'none';
      el.style.transform = `translate(${dx}px, ${dy}px)`;
      requestAnimationFrame(() => {
        el.style.transition = '';
        el.style.transform = '';
      });
    });
  }

  // ============================================================
  // 挿入位置の判定とライブプレビュー
  // ============================================================

  /**
   * マウスX座標から挿入位置を求める。
   * 列から離れた場所でも、直近の妥当な位置にスナップする。
   */
  _computeInsertIndex(clientX) {
    const cards = [...this.sequenceEl.querySelectorAll('.placed-card')];
    if (cards.length === 0) return 0;

    for (let i = 0; i < cards.length; i++) {
      const r = cards[i].getBoundingClientRect();
      if (clientX < r.left + r.width / 2) return i;
    }
    return cards.length;
  }

  _showInsertIndicator(index) {
    if (this.insertIndex === index && this.sequenceEl.querySelector('.insert-indicator')) return;
    this.insertIndex = index;

    const old = this.sequenceEl.querySelector('.insert-indicator');
    if (old) old.remove();

    const indicator = document.createElement('div');
    indicator.className = 'insert-indicator';
    const cards = [...this.sequenceEl.querySelectorAll('.placed-card')];
    this.sequenceEl.insertBefore(indicator, cards[index] || null);
  }

  _clearInsertIndicator() {
    this.insertIndex = null;
    const indicator = this.sequenceEl.querySelector('.insert-indicator');
    if (indicator) indicator.remove();
  }

  // ============================================================
  // ドロップ処理
  // ============================================================

  _readDragData(e) {
    try {
      return JSON.parse(e.dataTransfer.getData('application/json'));
    } catch (err) {
      return null;
    }
  }

  _handleDrop(e) {
    const data = this._readDragData(e);
    // 挿入位置はドロップ時の座標から確定させる（ドラッグ中の状態には依存しない）
    const index = this._computeInsertIndex(e.clientX);
    this._clearInsertIndicator();
    if (!data) return;

    if (data.type === 'hand') this._insertCard(data.card, index);
    else if (data.type === 'placed') this._movePlaced(data.instanceId, index);
  }

  _insertCard(card, index) {
    if (this.isLocked()) return;
    if (card.type !== 'paren' && this.usedCardIds.has(card.id)) return;

    if (card.type !== 'paren' && this._cardCount() >= this.maxCards) {
      this._notify(`使用できるカードは${this.maxCards}枚までです`);
      return;
    }

    const item = { instanceId: `inst-${this.instanceCounter++}`, card };
    const at = Math.max(0, Math.min(index, this.sequence.length));
    this.sequence.splice(at, 0, item);
    if (card.type !== 'paren') this.usedCardIds.add(card.id);
    this._commit();
  }

  _movePlaced(instanceId, newIndex) {
    const from = this.sequence.findIndex(i => i.instanceId === instanceId);
    if (from === -1) return;

    const [item] = this.sequence.splice(from, 1);
    let target = newIndex;
    if (from < newIndex) target = newIndex - 1;
    this.sequence.splice(Math.max(0, Math.min(target, this.sequence.length)), 0, item);
    this._commit();
  }

  _handleReturnToHand(e) {
    const data = this._readDragData(e);
    if (!data || data.type !== 'placed') return;

    const idx = this.sequence.findIndex(i => i.instanceId === data.instanceId);
    if (idx === -1) return;

    const [item] = this.sequence.splice(idx, 1);
    if (item.card.type !== 'paren') this.usedCardIds.delete(item.card.id);
    this._commit();
  }

  /** 括弧を除いた使用枚数 */
  _cardCount() {
    return this.sequence.filter(i => i.card.type !== 'paren').length;
  }

  // ============================================================
  // コミット・同期
  // ============================================================

  _commit() {
    this._renderSequence();
    this.renderHand();
    this._updatePreview();
    this.onSequenceChange(this.getFormulaString(), [...this.usedCardIds]);
  }

  /** シーケンスを数式文字列に変換 */
  getFormulaString() {
    return this.sequence.map(item => {
      const c = item.card;
      if (c.type === 'paren') return c.value;
      if (c.type === 'number') return String(c.value);
      return c.value || '';
    }).join('');
  }

  /** 現在の使用枚数（括弧を除く） */
  getCardCount() { return this._cardCount(); }

  // ============================================================
  // プレビュー
  // ============================================================

  _updatePreview() {
    if (!this.previewEl) return;
    const text = this.getFormulaString();

    if (!text) {
      this.previewEl.innerHTML = '<span class="preview-empty">数式を組み立てるとここに表示されます</span>';
      this.previewEl.removeAttribute('aria-label');
      return;
    }

    this.previewEl.innerHTML = FormulaEvaluator.toMathHTML(text);
    this.previewEl.setAttribute('aria-label', FormulaEvaluator.toSpeechText(text));

    if (!prefersReducedMotion()) {
      this.previewEl.classList.remove('glow');
      void this.previewEl.offsetWidth;
      this.previewEl.classList.add('glow');
    }
  }

  // ============================================================
  // リセット
  // ============================================================

  clear() {
    this.sequence = [];
    this.usedCardIds = new Set();
    this.insertIndex = null;
    this._commit();
  }

  reset() {
    this.clear();
    this.instanceCounter = 0;
  }

  _notify(msg) {
    if (typeof window !== 'undefined' && window.showNotification) {
      window.showNotification(msg, true);
    }
  }
}

if (typeof window !== 'undefined') {
  window.FormulaBuilder = FormulaBuilder;
  window.prefersReducedMotion = prefersReducedMotion;
  window.createStandardCardElement = createStandardCardElement;
}
