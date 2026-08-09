# 🎮 自作ゲームUIテンプレートスキル（完全版）

> **用途**: AIエージェントがバイブコーディングで自作ゲームを作る際の、モード選択画面・ロビー画面・セットアップ画面・ゲーム画面の標準UIテンプレート。2〜N人対応・観戦・ホスト継承・再入室・ルール設定対応。

---

## 📁 ファイル構成（最小構成）

```
project/
├── index.html              # モード選択画面（1端末対戦 / オンライン対戦 / その他）
├── online.html             # オンライン対戦専用（ロビー + ゲーム画面）
├── css/
│   └── style.css           # デザインシステム（単一ファイルで完結）
├── js/
│   ├── ui.js               # モード選択 + ローカルセットアップ
│   ├── online-manager.js   # Socket.io通信管理（部屋・プレイヤー・状態同期）
│   └── online-lobby.js     # ロビー画面のUI制御
└── server.js               # Node.js + Socket.ioサーバー
```

> **設計思想**: 
> - `index.html` = ローカルモード専用（1端末で遊ぶ / AI対戦 / シミュレーション）
> - `online.html` = オンライン対戦専用（ロビー + ゲーム画面を同一ファイルで管理）
> - ゲーム固有のセットアップ画面・ルール設定は各ゲームで自由に拡張
> - インターネット対戦の基盤（部屋・ホスト・観戦・再入室）は共通化

---

## 🖥️ 画面1: モード選択画面（index.html）

### 構造テンプレート

```html
<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ゲームタイトル</title>
  <link rel="stylesheet" href="css/style.css">
</head>
<body>
  <div id="home-view" class="home-screen">
    <div class="home-container">
      <div class="logo-area">
        <h1><span>🎮</span>ゲームタイトル</h1>
        <p class="subtitle text-gradient">CATCH COPY / SUBTITLE</p>
      </div>

      <div class="home-actions">
        <!-- 必須: 1端末対戦 -->
        <button id="btn-show-setup" class="btn-main-action primary">
          <span class="btn-icon">🖥️</span>
          <div class="btn-text">
            <strong>1端末で遊ぶ</strong>
            <span>Local / AI Battle</span>
          </div>
        </button>

        <!-- 必須: オンライン対戦 -->
        <button onclick="location.href='online.html'" class="btn-main-action secondary">
          <span class="btn-icon">🌐</span>
          <div class="btn-text">
            <strong>インターネット対戦</strong>
            <span>Online Multiplayer</span>
          </div>
        </button>

        <!-- オプション: 追加モードはここに自由に増やす -->
        <button onclick="location.href='watch.html'" class="btn-main-action secondary">
          <span class="btn-icon">👀</span>
          <div class="btn-text">
            <strong>NPC対戦を観戦</strong>
            <span>Watch AI Battle</span>
          </div>
        </button>

        <button onclick="location.href='tutorial.html'" class="btn-main-action secondary">
          <span class="btn-icon">📖</span>
          <div class="btn-text">
            <strong>ルール・駒の動き</strong>
            <span>How to Play</span>
          </div>
        </button>
      </div>

      <div class="home-footer">
        <p>Server: <span id="server-status" class="status-indicator">checking...</span></p>
        <p class="version">v1.0.0</p>
      </div>
    </div>
  </div>

  <!-- ローカルセットアップ画面（オプション） -->
  <div id="setup-view" class="launcher-screen hidden">
    <!-- ...各ゲーム固有のセットアップ... -->
  </div>

  <script type="module" src="js/ui.js"></script>
</body>
</html>
```

---

## 🌐 画面2: オンライン対戦（online.html）

### 構造テンプレート（ロビー + ゲーム画面）

```html
<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ゲームタイトル - オンライン対戦</title>
  <link rel="stylesheet" href="css/style.css">
  <script src="/socket.io/socket.io.js"></script>
</head>
<body>
  <div id="main-wrapper">
    <!-- ===== ロビー画面 ===== -->
    <div id="lobby-screen" class="screen active">
      <div class="lobby-container glass" id="online-lobby-container">
        <h1 class="logo">ゲームタイトル <span class="badge">ONLINE</span></h1>

        <!-- ロビー: 部屋作成・参加 -->
        <div id="lobby-main" class="lobby-section">
          <div class="lobby-actions">
            <div class="input-group">
              <input type="text" id="player-name-input" placeholder="プレイヤー名" maxlength="12" autocomplete="username">
            </div>
            <button id="btn-create-room" class="btn-premium primary">部屋を作る</button>
            <div class="divider"><span>または</span></div>
            <div class="input-group">
              <input type="text" id="room-code-input" placeholder="部屋コード (4文字)" maxlength="4">
            </div>
            <button id="btn-join-room" class="btn-premium secondary">部屋に入る</button>
          </div>
        </div>

        <!-- ロビー: 待機・セットアップ -->
        <div id="lobby-waiting" class="lobby-section hidden">
          <div class="room-info glass">
            <span class="label">部屋コード</span>
            <div id="room-code-display" class="code">----</div>
          </div>

          <!-- プレイヤーリスト -->
          <div class="player-list glass">
            <h3>参加者 <span id="player-count">0</span>人</h3>
            <ul id="lobby-player-list"></ul>
          </div>

          <!-- 観戦者リスト -->
          <div class="spectator-list glass">
            <h3>観戦者 <span id="spectator-count">0</span>人</h3>
            <ul id="lobby-spectator-list"></ul>
          </div>

          <!-- ホスト専用: ゲーム設定 -->
          <div id="host-settings" class="host-settings glass hidden">
            <h3>⚙️ ゲーム設定（ホストのみ）</h3>
            <!-- ゲーム固有の設定をここに挿入 -->
            <div class="settings-box">
              <label><input type="checkbox" id="setting-option-1"> 設定項目1</label>
            </div>
          </div>

          <!-- ホスト専用: 開始ボタン -->
          <button id="btn-start-game" class="btn-start-massive" disabled>
            ゲーム開始
            <span class="btn-sub">WAITING FOR PLAYERS</span>
          </button>

          <!-- 参加者用: 観戦ボタン -->
          <button id="btn-spectate" class="btn-premium secondary">👻 観戦で参加</button>

          <button id="btn-cancel-room" class="btn-link">キャンセル</button>
        </div>

        <div id="lobby-status" class="status-msg"></div>
      </div>
    </div>

    <!-- ===== ゲーム画面（初期非表示） ===== -->
    <div id="game-screen" class="screen hidden">
      <header class="game-header">
        <div class="header-left">
          <a href="index.html" class="back-link">← 戻る</a>
          <span class="header-title">🎮 ゲームタイトル - ONLINE</span>
          <div id="online-room-indicator" class="room-pill">部屋: <span id="room-id-text">---</span></div>
        </div>
        <div class="header-right">
          <div id="turn-info">—</div>
          <div id="phase-info">読み込み中...</div>
        </div>
      </header>

      <main class="game-main">
        <div class="canvas-area">
          <!-- ゲーム固有の描画エリア -->
          <div id="game-canvas"></div>
        </div>
        <aside class="side-panel">
          <!-- ゲーム固有のサイドパネル -->
        </aside>
      </main>
    </div>
  </div>

  <div id="center-notification" class="notification hidden"></div>

  <script type="module" src="js/online-lobby.js"></script>
  <script type="module" src="js/online-manager.js"></script>
</body>
</html>
```

---

## ⚡ JavaScript: 通信管理（online-manager.js）

```javascript
/**
 * online-manager.js - Socket.io 通信管理クラス
 * 部屋管理・プレイヤー管理・状態同期・再入室・ホスト継承対応
 */

class OnlineManager {
  constructor() {
    this.socket = null;
    this.roomCode = null;
    this.playerIndex = null;      // サーバーから割り当てられたインデックス
    this.playerName = 'Player';
    this.isHost = false;
    this.myRole = 'player';       // 'player' | 'spectator'
    this.roomState = null;
    this.callbacks = {};
    this.interactionIntervalMs = 50;
    this._lastInteractionAt = 0;
    this._lastInteractionSig = '';
    this._pendingInteraction = null;
    this._interactionTimer = null;
  }

  init(callbacks) {
    this.callbacks = callbacks;
  }

  connect() {
    if (this.socket) return;
    this.socket = io();
    this._setupListeners();
  }

  /** 部屋を作成（作成者がホスト） */
  createRoom(playerName) {
    this.connect();
    this.isHost = true;
    this.playerName = playerName || 'Player1';
    this.socket.emit('create-room', { playerName: this.playerName });
  }

  /** 部屋に参加（同じ名前で入れば再入室扱い） */
  joinRoom(roomCode, playerName, asSpectator = false) {
    this.connect();
    this.roomCode = roomCode.toUpperCase();
    this.isHost = false;
    this.playerName = playerName || 'Guest';
    this.myRole = asSpectator ? 'spectator' : 'player';
    this.socket.emit('join-room', {
      roomCode: this.roomCode,
      playerName: this.playerName,
      asSpectator
    }, (res) => {
      if (!res?.ok) {
        if (this.callbacks.onJoinError) this.callbacks.onJoinError(res?.error || '参加に失敗しました');
        return;
      }
      this.playerIndex = res.playerIndex ?? -1;
      this.isHost = res.isHost ?? false;
      this.myRole = res.myRole || 'player';
      if (res.roomState) this.roomState = res.roomState;
      if (this.callbacks.onRoomJoined) this.callbacks.onRoomJoined(res);
    });
  }

  /** ゲーム開始（ホストのみ呼べる） */
  startGame(settings, cb) {
    if (!this.socket || !this.roomCode) return;
    this.socket.emit('start-game', { settings }, cb);
  }

  /** ゲームアクション送信（Move/Play/Act等） */
  sendAction(actionType, data, cb) {
    if (!this.socket || !this.roomCode) return;
    this.socket.emit('game-action', { type: actionType, playerIndex: this.playerIndex, data }, cb);
  }

  /** 操作状態の同期（Hover/Select等、補助情報） */
  sendInteraction(data) {
    if (!this.socket || !this.roomCode) return;
    const payload = { playerIndex: this.playerIndex, ...data };
    const sig = JSON.stringify(payload);
    if (sig === this._lastInteractionSig) return;

    const now = Date.now();
    const elapsed = now - this._lastInteractionAt;

    const flush = (entry) => {
      if (!entry || !this.socket || !this.roomCode) return;
      this.socket.volatile.emit('sync-interaction', entry.payload);
      this._lastInteractionAt = Date.now();
      this._lastInteractionSig = entry.sig;
    };

    if (elapsed >= this.interactionIntervalMs) {
      flush({ payload, sig });
      return;
    }

    this._pendingInteraction = { payload, sig };
    if (this._interactionTimer) return;

    const waitMs = Math.max(0, this.interactionIntervalMs - elapsed);
    this._interactionTimer = setTimeout(() => {
      this._interactionTimer = null;
      const pending = this._pendingInteraction;
      this._pendingInteraction = null;
      flush(pending);
    }, waitMs);
  }

  /** フルステート同期要求（再入室時など） */
  requestFullState() {
    if (!this.socket || !this.roomCode) return;
    this.socket.emit('request-sync');
  }

  /** 自分の状態を特定の相手に送信 */
  sendFullState(requesterId, gameState) {
    if (!this.socket) return;
    this.socket.emit('send-full-state', { requesterId, gameState });
  }

  _setupListeners() {
    // 部屋作成完了
    this.socket.on('room-created', ({ roomCode, playerIndex, isHost, roomState }) => {
      this.roomCode = roomCode;
      this.playerIndex = playerIndex;
      this.isHost = isHost;
      this.roomState = roomState;
      if (this.callbacks.onRoomCreated) this.callbacks.onRoomCreated({ roomCode, playerIndex, isHost, roomState });
    });

    // 部屋状態更新（プレイヤー入退室・設定変更など）
    this.socket.on('room-state', (roomState) => {
      this.roomState = roomState;
      this.isHost = roomState?.hostId === this.socket.id;
      if (this.callbacks.onRoomState) this.callbacks.onRoomState(roomState);
    });

    // ゲーム開始
    this.socket.on('game-started', ({ gameState, roomState }) => {
      if (roomState) this.roomState = roomState;
      if (this.callbacks.onGameStarted) this.callbacks.onGameStarted({ gameState, roomState });
    });

    // ゲーム状態更新
    this.socket.on('game-update', ({ gameState, roomState }) => {
      if (roomState) this.roomState = roomState;
      if (this.callbacks.onGameUpdate) this.callbacks.onGameUpdate({ gameState, roomState });
    });

    // 相手アクション
    this.socket.on('opponent-action', (action) => {
      if (this.callbacks.onOpponentAction) this.callbacks.onOpponentAction(action);
    });

    // 相手インタラクション（補助同期）
    this.socket.on('opponent-interaction', (data) => {
      if (this.callbacks.onOpponentInteraction) this.callbacks.onOpponentInteraction(data);
    });

    // フルステート同期（再入室用）
    this.socket.on('sync-full-state', ({ gameState }) => {
      if (this.callbacks.onSyncFullState) this.callbacks.onSyncFullState(gameState);
    });

    // フルステート提供要求
    this.socket.on('request-full-state', ({ requesterId }) => {
      if (this.callbacks.onRequestFullState) this.callbacks.onRequestFullState(requesterId);
    });

    // 切断通知
    this.socket.on('opponent-disconnected', ({ playerName, reason }) => {
      if (this.callbacks.onOpponentDisconnected) this.callbacks.onOpponentDisconnected(playerName, reason);
    });

    // 参加エラー
    this.socket.on('join-error', (msg) => {
      if (this.callbacks.onJoinError) this.callbacks.onJoinError(msg);
    });

    // 自分の切断
    this.socket.on('disconnect', () => {
      if (this._interactionTimer) {
        clearTimeout(this._interactionTimer);
        this._interactionTimer = null;
      }
      this._pendingInteraction = null;
      this._lastInteractionSig = '';
      this._lastInteractionAt = 0;
      if (this.callbacks.onDisconnected) this.callbacks.onDisconnected();
    });
  }

  /** 自分の番か判定 */
  isMyTurn(currentPlayerIndex) {
    return this.playerIndex === currentPlayerIndex;
  }
}

window.onlineManager = new OnlineManager();
export default window.onlineManager;
```

---

## ⚡ JavaScript: ロビーUI制御（online-lobby.js）

```javascript
/**
 * online-lobby.js - ロビー画面のUI制御
 * 部屋作成・参加・プレイヤーリスト表示・ホスト判定・観戦・開始
 */

import onlineManager from './online-manager.js';

// DOM要素
const lobbyScreen    = document.getElementById('lobby-screen');
const gameScreen     = document.getElementById('game-screen');
const lobbyMain      = document.getElementById('lobby-main');
const lobbyWaiting   = document.getElementById('lobby-waiting');

const btnCreate      = document.getElementById('btn-create-room');
const btnJoin        = document.getElementById('btn-join-room');
const btnCancel      = document.getElementById('btn-cancel-room');
const btnStart       = document.getElementById('btn-start-game');
const btnSpectate    = document.getElementById('btn-spectate');

const nameInput      = document.getElementById('player-name-input');
const codeInput      = document.getElementById('room-code-input');
const codeDisplay    = document.getElementById('room-code-display');
const statusMsg      = document.getElementById('lobby-status');

const playerList     = document.getElementById('lobby-player-list');
const spectatorList  = document.getElementById('lobby-spectator-list');
const playerCount    = document.getElementById('player-count');
const spectatorCount = document.getElementById('spectator-count');
const hostSettings   = document.getElementById('host-settings');

let gameInitialized = false;

const showStatus = (msg, isError = false) => {
  statusMsg.textContent = msg;
  statusMsg.style.color = isError ? '#e85555' : '#f5c842';
};

// ===== ロビー表示更新 =====
function renderLobby(roomState) {
  if (!roomState) return;

  // プレイヤーリスト
  if (playerList) {
    playerList.innerHTML = '';
    (roomState.players || []).forEach(p => {
      const li = document.createElement('li');
      li.className = 'player-item';
      const hostBadge = p.isHost ? ' 👑' : '';
      const meBadge = p.id === onlineManager.socket?.id ? ' (あなた)' : '';
      li.textContent = `${p.name}${hostBadge}${meBadge}`;
      playerList.appendChild(li);
    });
  }
  if (playerCount) playerCount.textContent = (roomState.players || []).length;

  // 観戦者リスト
  if (spectatorList) {
    spectatorList.innerHTML = '';
    (roomState.spectators || []).forEach(s => {
      const li = document.createElement('li');
      li.className = 'spectator-item';
      const meBadge = s.id === onlineManager.socket?.id ? ' (あなた)' : '';
      li.textContent = `👻 ${s.name}${meBadge}`;
      spectatorList.appendChild(li);
    });
  }
  if (spectatorCount) spectatorCount.textContent = (roomState.spectators || []).length;

  // ホスト専用UIの表示/非表示
  const isHost = roomState.hostId === onlineManager.socket?.id;
  if (hostSettings) hostSettings.classList.toggle('hidden', !isHost);
  if (btnStart) {
    btnStart.disabled = !isHost || !roomState.canStart;
    const sub = btnStart.querySelector('.btn-sub');
    if (sub) {
      if (!isHost) sub.textContent = 'HOST ONLY';
      else if (!roomState.canStart) sub.textContent = 'NOT ENOUGH PLAYERS';
      else sub.textContent = 'PRESS TO START';
    }
  }
}

// ===== 画面遷移 =====
function switchToLobby(roomCode) {
  lobbyMain?.classList.add('hidden');
  lobbyWaiting?.classList.remove('hidden');
  if (codeDisplay) codeDisplay.textContent = roomCode;
}

function switchToGame() {
  lobbyScreen?.classList.remove('active');
  lobbyScreen?.classList.add('hidden');
  gameScreen?.classList.remove('hidden');
  gameScreen?.classList.add('active');

  // ゲーム初期化（ゲーム固有のinit関数を呼ぶ）
  if (!gameInitialized && window.initOnlineGame) {
    gameInitialized = true;
    window.initOnlineGame({
      playerIndex: onlineManager.playerIndex,
      isHost: onlineManager.isHost,
      myRole: onlineManager.myRole,
      roomState: onlineManager.roomState,
    });
  }

  // リサイズイベント発火（3Dレンダラー対策）
  setTimeout(() => window.dispatchEvent(new Event('resize')), 100);
}

// ===== Socket.ioコールバック =====
onlineManager.init({
  onRoomCreated: ({ roomCode, roomState }) => {
    switchToLobby(roomCode);
    renderLobby(roomState);
    showStatus('部屋を作成しました。参加者を待っています...');
  },

  onRoomJoined: ({ roomCode, roomState }) => {
    switchToLobby(roomCode);
    renderLobby(roomState);
    showStatus('部屋に参加しました。');
  },

  onRoomState: (roomState) => {
    renderLobby(roomState);
  },

  onGameStarted: ({ gameState, roomState }) => {
    showStatus('ゲームを開始します！');
    switchToGame();
  },

  onGameUpdate: ({ gameState }) => {
    if (window.handleGameUpdate) window.handleGameUpdate(gameState);
  },

  onOpponentAction: (action) => {
    if (window.handleOpponentAction) window.handleOpponentAction(action);
  },

  onOpponentInteraction: (data) => {
    if (window.handleOpponentInteraction) window.handleOpponentInteraction(data);
  },

  onOpponentDisconnected: (playerName, reason) => {
    showCenterNotification(`「${playerName}」が${reason === 'rejoin' ? '再入室しました' : '切断しました'}`);
  },

  onSyncFullState: (gameState) => {
    if (window.handleFullStateSync) window.handleFullStateSync(gameState);
  },

  onRequestFullState: (requesterId) => {
    if (window.getFullState && onlineManager.isHost) {
      const state = window.getFullState();
      onlineManager.sendFullState(requesterId, state);
    }
  },

  onJoinError: (msg) => {
    const jpMsg = {
      'Room is full': '部屋が満員です',
      'Room not found': '部屋が見つかりません',
      'Game already started': 'ゲームが既に開始されています',
    }[msg] || msg;
    showStatus(jpMsg, true);
  },

  onDisconnected: () => {
    showStatus('サーバーから切断されました', true);
  },
});

// ===== イベントリスナー =====
btnCreate?.addEventListener('click', () => {
  const name = nameInput?.value?.trim() || '';
  showStatus('接続中...');
  onlineManager.createRoom(name);
});

btnJoin?.addEventListener('click', () => {
  const code = codeInput?.value?.trim().toUpperCase();
  const name = nameInput?.value?.trim() || '';
  if (!code || code.length !== 4) {
    showStatus('4文字の部屋コードを入力してください', true);
    return;
  }
  showStatus('参加中...');
  onlineManager.joinRoom(code, name, false);
});

btnSpectate?.addEventListener('click', () => {
  const code = codeInput?.value?.trim().toUpperCase();
  const name = nameInput?.value?.trim() || '';
  if (!code || code.length !== 4) {
    showStatus('4文字の部屋コードを入力してください', true);
    return;
  }
  showStatus('観戦で参加中...');
  onlineManager.joinRoom(code, name, true);
});

btnCancel?.addEventListener('click', () => {
  location.reload();
});

btnStart?.addEventListener('click', () => {
  if (!onlineManager.isHost) return;
  // ゲーム固有の設定を収集
  const settings = {};
  // 例: settings.option1 = document.getElementById('setting-option-1')?.checked;
  onlineManager.startGame(settings, (res) => {
    if (!res?.ok) showStatus(res?.error || '開始に失敗しました', true);
  });
});

// Enterキー対応
codeInput?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') btnJoin?.click();
});
nameInput?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    if ((codeInput?.value || '').trim().length === 4) btnJoin?.click();
    else btnCreate?.click();
  }
});

// 中央通知
window.showCenterNotification = (msg, duration = 3000) => {
  const notify = document.getElementById('center-notification');
  if (!notify) return;
  notify.textContent = msg;
  notify.classList.remove('hidden');
  setTimeout(() => notify.classList.add('hidden'), duration);
};
```

---

## 🖥️ サーバー（server.js）

```javascript
// server.js - Node.js + Socket.io ゲームサーバー
// 部屋管理・ホスト継承・再入室・観戦・ゲーム状態管理

'use strict';

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const PORT = process.env.PORT || 3000;

// 静的ファイル配信
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname)); // フォールバック
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ============================================================
// データ構造
// ============================================================

const rooms = new Map(); // roomId -> Room

/*
Room構造:
{
  id: string,              // 4文字の部屋コード
  hostId: string,          // 現在のホストのsocket.id
  players: [Player],       // 参加者（最大N人、ゲームによる）
  spectators: [Player],    // 観戦者
  started: boolean,        // ゲーム開始済みか
  settings: object,        // ホストが設定したゲーム設定
  gameState: object,       // 現在のゲーム状態（サーバー権威）
  history: [],             // 履歴
  deleteTimer: Timeout|null, // 全員退出後の削除タイマー
}

Player構造:
{
  id: string,        // socket.id
  name: string,      // プレイヤー名（再入室のキー）
  index: number,     // プレイヤーインデックス（0,1,2...）
  isHost: boolean,   // ホストかどうか
  connected: boolean,// 接続状態（一時切断対策）
  role: string,      // 'player' | 'spectator'
}
*/

// ============================================================
// ユーティリティ
// ============================================================

function genRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 0,1,I,O除外
  let res = '';
  for (let i = 0; i < 4; i++) res += chars.charAt(Math.floor(Math.random() * chars.length));
  if (rooms.has(res)) return genRoomId();
  return res;
}

function createRoom(roomId, hostSocket, hostName) {
  const room = {
    id: roomId,
    hostId: hostSocket.id,
    players: [{
      id: hostSocket.id,
      name: hostName || 'Player1',
      index: 0,
      isHost: true,
      connected: true,
      role: 'player'
    }],
    spectators: [],
    started: false,
    settings: {},
    gameState: null,
    history: [],
    deleteTimer: null,
  };
  rooms.set(roomId, room);
  return room;
}

/** 部屋状態をクライアント用に整形 */
function makeRoomState(room) {
  return {
    roomCode: room.id,
    hostId: room.hostId,
    started: room.started,
    canStart: room.players.length >= 2 && !room.started, // 最小人数はゲームによる
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      index: p.index,
      isHost: p.isHost,
      connected: p.connected,
    })),
    spectators: room.spectators.map(s => ({
      id: s.id,
      name: s.name,
      connected: s.connected,
    })),
    settings: room.settings,
  };
}

/** ホストを継承（現在のホストが抜けた時） */
function inheritHost(room) {
  // 接続中のプレイヤーから次のホストを選ぶ（ランダム or 最初に見つかった人）
  const candidates = room.players.filter(p => p.connected && p.id !== room.hostId);
  if (candidates.length > 0) {
    // ランダム選択
    const nextHost = candidates[Math.floor(Math.random() * candidates.length)];
    room.hostId = nextHost.id;
    room.players.forEach(p => p.isHost = (p.id === nextHost.id));
    console.log(`[ホスト継承] ${room.id}: ${nextHost.name} が新ホスト`);
    return true;
  }
  // プレイヤーが全員切断なら観戦者から
  const specCandidates = room.spectators.filter(s => s.connected);
  if (specCandidates.length > 0) {
    const nextHost = specCandidates[0];
    // 観戦者をプレイヤーに昇格
    room.spectators = room.spectators.filter(s => s.id !== nextHost.id);
    nextHost.role = 'player';
    nextHost.index = room.players.length;
    nextHost.isHost = true;
    room.hostId = nextHost.id;
    room.players.push(nextHost);
    console.log(`[ホスト継承] ${room.id}: 観戦者 ${nextHost.name} がプレイヤー兼ホストに昇格`);
    return true;
  }
  return false;
}

/** 名前で既存プレイヤーを検索（再入室判定） */
function findPlayerByName(room, name) {
  const p = room.players.find(p => p.name === name && !p.connected);
  if (p) return { entry: p, list: 'players' };
  const s = room.spectators.find(s => s.name === name && !s.connected);
  if (s) return { entry: s, list: 'spectators' };
  return null;
}

/** プレイヤーインデックスを振り直す */
function reindexPlayers(room) {
  room.players.forEach((p, i) => { p.index = i; });
}

// ============================================================
// Socket.io イベントハンドラ
// ============================================================

io.on('connection', (socket) => {
  console.log(`[接続] ${socket.id}`);

  // ===== 部屋作成 =====
  socket.on('create-room', ({ playerName }) => {
    const roomId = genRoomId();
    const room = createRoom(roomId, socket, playerName);
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.playerName = playerName || 'Player1';

    console.log(`[部屋作成] ${roomId} by ${socket.id} (${playerName})`);
    socket.emit('room-created', {
      roomCode: roomId,
      playerIndex: 0,
      isHost: true,
      roomState: makeRoomState(room),
    });
  });

  // ===== 部屋参加 / 再入室 =====
  socket.on('join-room', ({ roomCode, playerName, asSpectator }, callback) => {
    const roomId = roomCode ? roomCode.toUpperCase() : '';
    const room = rooms.get(roomId);
    const name = (playerName || '').trim() || `Guest-${socket.id.slice(0, 4)}`;

    if (!room) {
      callback?.({ ok: false, error: 'Room not found' });
      return;
    }

    // 削除タイマーが動いていたらキャンセル
    if (room.deleteTimer) {
      clearTimeout(room.deleteTimer);
      room.deleteTimer = null;
    }

    // 再入室判定：同じ名前で切断中のプレイヤー/観戦者がいれば復帰
    const rejoin = findPlayerByName(room, name);
    if (rejoin) {
      const entry = rejoin.entry;
      entry.id = socket.id;
      entry.connected = true;
      socket.join(roomId);
      socket.data.roomId = roomId;
      socket.data.playerName = name;
      socket.data.rejoined = true;

      console.log(`[再入室] ${roomId}: ${name} が復帰 (${rejoin.list})`);

      // ホストならhostIdも更新
      if (entry.isHost) room.hostId = socket.id;

      callback?.({
        ok: true,
        roomCode: roomId,
        playerIndex: entry.index,
        isHost: entry.isHost,
        myRole: entry.role,
        roomState: makeRoomState(room),
        isRejoin: true,
      });

      // 他の参加者に通知
      socket.to(roomId).emit('opponent-disconnected', {
        playerName: name,
        reason: 'rejoin'
      });

      // ゲーム中ならフルステート同期要求
      if (room.started) {
        socket.to(roomId).emit('request-full-state', { requesterId: socket.id });
      }

      emitRoomState(room);
      return;
    }

    // 新規参加
    if (room.started && !asSpectator) {
      callback?.({ ok: false, error: 'Game already started' });
      return;
    }

    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.playerName = name;

    if (asSpectator) {
      room.spectators.push({
        id: socket.id,
        name,
        connected: true,
        role: 'spectator'
      });
      console.log(`[観戦参加] ${roomId}: ${name}`);
      callback?.({
        ok: true,
        roomCode: roomId,
        playerIndex: -1,
        isHost: false,
        myRole: 'spectator',
        roomState: makeRoomState(room),
      });
    } else {
      const index = room.players.length;
      room.players.push({
        id: socket.id,
        name,
        index,
        isHost: false,
        connected: true,
        role: 'player'
      });
      console.log(`[参加] ${roomId}: ${name} (index:${index})`);
      callback?.({
        ok: true,
        roomCode: roomId,
        playerIndex: index,
        isHost: false,
        myRole: 'player',
        roomState: makeRoomState(room),
      });
    }

    emitRoomState(room);
  });

  // ===== ゲーム開始（ホストのみ） =====
  socket.on('start-game', ({ settings }, callback) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room) return;
    if (room.hostId !== socket.id) {
      callback?.({ ok: false, error: 'Only host can start' });
      return;
    }
    if (room.started) {
      callback?.({ ok: false, error: 'Already started' });
      return;
    }
    if (room.players.length < 2) {
      callback?.({ ok: false, error: 'Not enough players' });
      return;
    }

    room.started = true;
    room.settings = settings || {};

    // ゲーム固有の初期化をここで行う
    // room.gameState = initializeGame(room.players.length, settings);

    console.log(`[ゲーム開始] ${roomId}: ${room.players.length}人`);
    io.to(roomId).emit('game-started', {
      gameState: room.gameState,
      roomState: makeRoomState(room),
    });
    callback?.({ ok: true });
  });

  // ===== ゲームアクション =====
  socket.on('game-action', (actionData) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room || !room.started) return;

    // サーバー権威：アクションを検証・適用
    // const result = applyAction(room.gameState, actionData);
    // if (result.ok) {
    //   room.gameState = result.newState;
    //   room.history.push(actionData);
    //   io.to(roomId).emit('game-update', { gameState: room.gameState, roomState: makeRoomState(room) });
    // }

    // 簡易実装：中継のみ（クライアント権威の場合）
    socket.to(roomId).emit('opponent-action', actionData);
  });

  // ===== インタラクション同期（補助情報） =====
  socket.on('sync-interaction', (data) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    socket.to(roomId).volatile.emit('opponent-interaction', data);
  });

  // ===== フルステート同期（再入室用） =====
  socket.on('request-sync', () => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room) return;
    socket.emit('sync-full-state', { gameState: room.gameState });
  });

  socket.on('send-full-state', ({ requesterId, gameState }) => {
    io.to(requesterId).emit('sync-full-state', { gameState });
  });

  // ===== チャット =====
  socket.on('chat', ({ message }) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    const all = [...room.players, ...room.spectators];
    const sender = all.find(p => p.id === socket.id);
    io.to(roomId).emit('chat', { from: sender?.name || '未知', message });
  });

  // ===== 切断 =====
  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;

    const name = socket.data.playerName || 'Player';
    const wasHost = room.hostId === socket.id;

    // プレイヤー/観戦者を切断状態に（再入室を許可するため削除しない）
    const player = room.players.find(p => p.id === socket.id);
    if (player) player.connected = false;
    const spectator = room.spectators.find(s => s.id === socket.id);
    if (spectator) spectator.connected = false;

    console.log(`[切断] ${socket.id} (${name}) from ${roomId}`);
    socket.to(roomId).emit('opponent-disconnected', { playerName: name, reason: 'disconnect' });

    // ホストが抜けたら継承
    if (wasHost) {
      inheritHost(room);
    }

    // 全員切断ならタイマーで部屋削除
    const hasConnected = room.players.some(p => p.connected) ||
                         room.spectators.some(s => s.connected);
    if (!hasConnected) {
      if (room.deleteTimer) clearTimeout(room.deleteTimer);
      room.deleteTimer = setTimeout(() => {
        console.log(`[部屋削除] ${roomId} (全員切断)`);
        rooms.delete(roomId);
      }, 30 * 60 * 1000); // 30分後削除
      return;
    }

    emitRoomState(room);
  });
});

function emitRoomState(room) {
  io.to(room.id).emit('room-state', makeRoomState(room));
}

// ============================================================
// サーバー起動
// ============================================================
server.listen(PORT, () => {
  console.log(`\n╔════════════════════════════════╗`);
  console.log(`║  ゲームサーバー起動              ║`);
  console.log(`║  http://localhost:${PORT}           ║`);
  console.log(`╚════════════════════════════════╝\n`);
});
```

---

## 🎨 CSSデザインシステム（追加・更新）

```css
/* ===== ロビー画面 ===== */
.lobby-container {
  max-width: 600px;
  margin: 0 auto;
  padding: 2rem;
  text-align: center;
}

.lobby-container .logo {
  font-size: 2rem;
  margin-bottom: 2rem;
}

.lobby-container .badge {
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
  padding: 0.2rem 0.6rem;
  border-radius: 8px;
  font-size: 0.8rem;
  vertical-align: middle;
  margin-left: 0.5rem;
}

.lobby-actions {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  margin-bottom: 2rem;
}

.input-group input {
  width: 100%;
  padding: 0.8rem;
  border-radius: 10px;
  border: 1px solid var(--border-glass);
  background: rgba(0,0,0,0.3);
  color: var(--text-primary);
  font-size: 1rem;
  text-align: center;
}

.divider {
  display: flex;
  align-items: center;
  gap: 1rem;
  color: var(--text-secondary);
  margin: 0.5rem 0;
}

.divider::before, .divider::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--border-glass);
}

/* 部屋情報 */
.room-info {
  margin-bottom: 1.5rem;
  padding: 1rem;
}

.room-info .label {
  color: var(--text-secondary);
  font-size: 0.9rem;
}

.room-info .code {
  font-size: 2.5rem;
  font-weight: bold;
  letter-spacing: 0.3em;
  color: var(--accent-primary);
  font-family: monospace;
}

/* プレイヤーリスト */
.player-list, .spectator-list {
  margin-bottom: 1rem;
  padding: 1rem;
  text-align: left;
}

.player-list h3, .spectator-list h3 {
  margin: 0 0 0.5rem;
  font-size: 1rem;
  color: var(--text-secondary);
}

.player-list ul, .spectator-list ul {
  list-style: none;
  padding: 0;
  margin: 0;
}

.player-item, .spectator-item {
  padding: 0.5rem;
  border-radius: 8px;
  margin-bottom: 0.3rem;
  background: rgba(255,255,255,0.03);
}

.player-item::before {
  content: '● ';
  color: var(--success);
}

.spectator-item {
  opacity: 0.7;
}

/* ホスト設定 */
.host-settings {
  margin-bottom: 1.5rem;
  padding: 1rem;
  text-align: left;
}

.host-settings h3 {
  margin: 0 0 1rem;
  color: var(--warning);
}

.settings-box {
  margin: 0.5rem 0;
}

.settings-box label {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  color: var(--text-secondary);
  cursor: pointer;
}

/* ボタン類 */
.btn-premium {
  padding: 1rem;
  border: none;
  border-radius: 12px;
  font-size: 1rem;
  font-weight: bold;
  cursor: pointer;
  transition: all 0.3s;
}

.btn-premium.primary {
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
}

.btn-premium.secondary {
  background: rgba(255,255,255,0.08);
  color: var(--text-primary);
  border: 1px solid var(--border-glass);
}

.btn-premium:hover {
  transform: translateY(-2px);
  box-shadow: 0 8px 30px rgba(102, 126, 234, 0.3);
}

.btn-premium:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  transform: none;
}

.btn-link {
  background: transparent;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 0.5rem;
}

.btn-link:hover {
  color: var(--text-primary);
}

/* ローディング */
.spinner {
  width: 40px;
  height: 40px;
  border: 3px solid rgba(255,255,255,0.1);
  border-top-color: var(--accent-primary);
  border-radius: 50%;
  animation: spin 1s linear infinite;
  margin: 1rem auto;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* ステータスメッセージ */
.status-msg {
  margin-top: 1rem;
  font-size: 0.9rem;
  min-height: 1.5rem;
}

/* ゲーム画面 */
.game-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.8rem 1.2rem;
  background: rgba(0,0,0,0.3);
  border-bottom: 1px solid var(--border-glass);
}

.header-left, .header-right {
  display: flex;
  align-items: center;
  gap: 1rem;
}

.back-link {
  color: var(--text-secondary);
  text-decoration: none;
}

.room-pill {
  background: rgba(102, 126, 234, 0.2);
  padding: 0.3rem 0.8rem;
  border-radius: 20px;
  font-size: 0.8rem;
  color: var(--accent-primary);
}

.game-main {
  display: flex;
  height: calc(100vh - 60px);
}

.canvas-area {
  flex: 1;
  position: relative;
}

.side-panel {
  width: 280px;
  background: rgba(0,0,0,0.2);
  border-left: 1px solid var(--border-glass);
  padding: 1rem;
  overflow-y: auto;
}

/* 通知 */
.notification {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  background: rgba(0,0,0,0.9);
  color: white;
  padding: 1rem 2rem;
  border-radius: 12px;
  z-index: 9999;
  font-size: 1.1rem;
}

/* 画面切り替え */
.screen {
  min-height: 100vh;
}

.screen.hidden {
  display: none !important;
}

.screen.active {
  display: block;
}
```

---

## 🛠️ カスタマイズガイド

### 1. ゲーム固有のセットアップ画面（index.html）
各ゲームのルールに合わせて自由に設計。スキルはデザインシステム（CSS変数・コンポーネントクラス）のみを提供。

```html
<!-- 例: 人狼の役職設定 -->
<div class="option-row">
  <label>人狼: <input type="number" id="werewolf-count" min="1" max="3" value="1"></label>
  <label>占い師: <input type="number" id="seer-count" min="0" max="2" value="1"></label>
</div>

<!-- 例: オセロのAI設定 -->
<div class="option-row">
  <div class="range-group">
    <div class="range-info">🧠 先読み深さ: <span id="depth-val">4</span></div>
    <input type="range" id="depth-slider" min="0" max="10" value="4">
  </div>
</div>
```

### 2. 最小参加人数の変更
`server.js` の `canStart` と `start-game` イベント内の人数チェックを変更：
```javascript
// 3人必要なゲームの場合
if (room.players.length < 3) { ... }
```

### 3. ホスト継承方式の変更
`inheritHost()` 内の選択ロジックを変更：
```javascript
// ランダム（デフォルト）
const nextHost = candidates[Math.floor(Math.random() * candidates.length)];

// 2番目に入った人（index順）
const nextHost = candidates.sort((a,b) => a.index - b.index)[0];
```

### 4. 観戦者の権限
不完全情報ゲームなら `sync-full-state` で全情報送信。完全情報ゲームなら同じく全情報。観戦者の干渉防止は `game-action` で `spectator` ロールを拒否するだけ。

### 5. 部屋コードの長さ変更
`genRoomId()` と `input` の `maxlength` を合わせて変更。

---

## 📋 使用時のチェックリスト

- [ ] `index.html` のタイトル・絵文字・サブタイトルを変更
- [ ] `online.html` のタイトル・バッジを変更
- [ ] CSSの `--accent-gradient` をゲームテーマカラーに変更
- [ ] `server.js` の最小開始人数をゲームに合わせて変更
- [ ] `server.js` のゲームアクション検証ロジックを実装（サーバー権威型の場合）
- [ ] `online-lobby.js` のゲーム固有設定収集部分を実装
- [ ] `online-manager.js` の `sendAction` / `sendInteraction` をゲームに合わせて使用
- [ ] 再入室の名前一致判定を必要に応じて緩和（大文字小文字無視など）

---

## 💡 バイブコーディング時の使い方

1. **このスキルファイルの内容をプロンプトに含める**
2. **「上記のUIテンプレートを使って、{ゲーム名}の画面を作って」** と指示
3. **「プレイヤーは3人必要。役職設定として人狼・占い師・狩人の人数を選べるように」** などゲーム固有の設定を指示
4. **「サーバーはサーバー権威型で、盤面状態を管理して」** と通信方式を指示

> **ポイント**: このスキルは「見た目・ロビー・通信基盤」を固定し、ゲーム固有のルール・盤面・駒の動きは各ゲームで自由に実装できるように分離している。
