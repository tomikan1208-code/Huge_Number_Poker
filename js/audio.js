/**
 * audio.js - サウンドエフェクト
 * Web Audio APIを使用したシンプルな効果音
 */

class GameAudio {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this._init();
  }

  _init() {
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    } catch (e) {
      this.ctx = null;
      this.enabled = false;
    }
  }

  /** ユーザー操作後に呼ぶ（オーディオコンテキスト再開） */
  resume() {
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  /** トーン再生 */
  _tone(freq, duration = 0.1, type = 'sine', volume = 0.3, delay = 0) {
    if (!this.enabled || !this.ctx) return;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    const startTime = this.ctx.currentTime + delay;

    osc.type = type;
    osc.frequency.setValueAtTime(freq, startTime);
    gain.gain.setValueAtTime(0, startTime);
    gain.gain.linearRampToValueAtTime(volume, startTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);

    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start(startTime);
    osc.stop(startTime + duration + 0.05);
  }

  /** カード配布音 */
  playDeal() {
    this._tone(600, 0.08, 'triangle', 0.2);
    this._tone(800, 0.08, 'triangle', 0.2, 0.05);
  }

  /** チップ音 */
  playChip() {
    this._tone(1200, 0.05, 'square', 0.15);
    this._tone(1600, 0.05, 'square', 0.1, 0.03);
  }

  /** 勝利音 */
  playWin() {
    this._tone(523, 0.15, 'sine', 0.3);
    this._tone(659, 0.15, 'sine', 0.3, 0.1);
    this._tone(784, 0.2, 'sine', 0.3, 0.2);
    this._tone(1047, 0.3, 'sine', 0.3, 0.3);
  }

  /** 敗北音 */
  playLose() {
    this._tone(400, 0.2, 'sawtooth', 0.2);
    this._tone(300, 0.3, 'sawtooth', 0.2, 0.15);
  }

  /** クリック音 */
  playClick() {
    this._tone(800, 0.03, 'square', 0.1);
  }

  /** エラー音 */
  playError() {
    this._tone(200, 0.2, 'sawtooth', 0.2);
    this._tone(150, 0.3, 'sawtooth', 0.2, 0.1);
  }

  /** 正解音 */
  playCorrect() {
    this._tone(880, 0.1, 'sine', 0.25);
    this._tone(1320, 0.15, 'sine', 0.25, 0.08);
  }

  /** 不正解音 */
  playIncorrect() {
    this._tone(300, 0.15, 'sawtooth', 0.2);
    this._tone(200, 0.2, 'sawtooth', 0.2, 0.1);
  }
}

window.gameAudio = new GameAudio();