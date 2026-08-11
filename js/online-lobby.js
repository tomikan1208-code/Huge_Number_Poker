/**
 * online-lobby.js - ロビー画面のUI制御
 * 部屋作成・参加・プレイヤーリスト表示・ホスト判定・観戦・開始
 */

const om = window.onlineManager;

// DOM要素
const lobbyScreen    = document.getElementById('lobby-screen');
const gameScreen     = document.getElementById('game-screen');
const lobbyMain      = document.getElementById('lobby-main');
const lobbyWaiting   = document.getElementById('lobby-waiting');

const btnCreate      = document.getElementById('btn-create-room');
const btnJoin        = document.getElementById('btn-join-room');
const btnSpectate    = document.getElementById('btn-spectate');
const btnCancel      = document.getElementById('btn-cancel-room');
const btnStart       = document.getElementById('btn-start-game');

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

const MAX_ROOM_PLAYERS = 8; // server.js と揃えること

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
      const meBadge = p.id === om.socket?.id ? ' (あなた)' : '';
      const disconnected = p.connected ? '' : ' (切断)';
      li.textContent = `${p.name}${hostBadge}${meBadge}${disconnected}`;
      if (!p.connected) li.style.opacity = '0.5';
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
      const meBadge = s.id === om.socket?.id ? ' (あなた)' : '';
      li.textContent = `👻 ${s.name}${meBadge}`;
      spectatorList.appendChild(li);
    });
  }
  if (spectatorCount) spectatorCount.textContent = (roomState.spectators || []).length;

  // ホスト専用UIの表示/非表示
  const isHost = roomState.hostId === om.socket?.id;
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

  // ゲーム初期化
  if (!gameInitialized && window.initOnlineGame) {
    gameInitialized = true;
    window.initOnlineGame({
      playerIndex: om.playerIndex,
      isHost: om.isHost,
      myRole: om.myRole,
      roomState: om.roomState,
    });
  }

  setTimeout(() => window.dispatchEvent(new Event('resize')), 100);
}

// ===== 再入室の記憶 =====
// リロードやタブの復帰でゲームから弾き出されないよう、席の情報を覚えておく。
// seatToken は「その席の持ち主である証明」なので、他人に渡らない localStorage に置く
// （sessionStorage だとタブを開き直しただけで席に戻れなくなる）。
const REJOIN_KEY = 'hnp-rejoin';

function rememberSeat() {
  try {
    localStorage.setItem(REJOIN_KEY, JSON.stringify({
      roomCode: om.roomCode,
      playerName: om.playerName,
      asSpectator: om.myRole === 'spectator',
      seatToken: om.seatToken,
    }));
  } catch (e) { /* プライベートモードなどでは諦める */ }
}

function forgetSeat() {
  try { localStorage.removeItem(REJOIN_KEY); } catch (e) { /* noop */ }
}

function savedSeat() {
  try { return JSON.parse(localStorage.getItem(REJOIN_KEY) || 'null'); } catch (e) { return null; }
}

// ===== Socket.ioコールバック =====
om.init({
  onRoomCreated: ({ roomCode, roomState }) => {
    rememberSeat();
    switchToLobby(roomCode);
    renderLobby(roomState);
    showStatus('部屋を作成しました。参加者を待っています...');
  },

  onRoomJoined: ({ roomCode, roomState, isRejoin }) => {
    rememberSeat();
    switchToLobby(roomCode);
    renderLobby(roomState);

    // 進行中の部屋に入った（＝再入室・途中観戦）なら、ロビーではなく卓に戻す。
    // ここを通さないと、サーバーが状態を送っていてもロビーで固まる。
    if (roomState?.started) {
      switchToGame();
      om.requestFullState();
      showStatus(isRejoin ? 'ゲームに復帰しました。' : '観戦を開始しました。');
      return;
    }
    showStatus('部屋に参加しました。');
  },

  onRoomState: (roomState) => {
    renderLobby(roomState);
    if (window.handleOnlineRoomState) window.handleOnlineRoomState();
  },

  onGameStarted: ({ gameState, roomState }) => {
    showStatus('ゲームを開始します！');
    switchToGame();
    // 初期ゲーム状態をレンダリング
    if (gameState && window.handleOnlineGameUpdate) {
      window.handleOnlineGameUpdate(gameState);
    }
  },

  onGameUpdate: ({ gameState }) => {
    if (window.handleOnlineGameUpdate) window.handleOnlineGameUpdate(gameState);
  },

  onOpponentDisconnected: (playerName, reason) => {
    showCenterNotification(`「${playerName}」が${reason === 'rejoin' ? '再入室しました' : '切断しました'}`);
  },

  onSyncFullState: (gameState) => {
    if (window.handleOnlineFullStateSync) window.handleOnlineFullStateSync(gameState);
  },

  onJoinError: (msg) => {
    forgetSeat();
    lobbyWaiting?.classList.add('hidden');
    lobbyMain?.classList.remove('hidden');
    const jpMsg = {
      'Room is full': `部屋が満員です（最大${MAX_ROOM_PLAYERS}人）`,
      'Room not found': '部屋が見つかりません',
      'Game already started': '進行中の部屋です。観戦でなら入れます',
    }[msg] || msg;
    showStatus(jpMsg, true);
  },

  onDisconnected: () => {
    showStatus('サーバーから切断されました', true);
  },

  onChat: (data) => {
    if (window.handleOnlineChat) window.handleOnlineChat(data);
  },
});

// ===== イベントリスナー =====
btnCreate?.addEventListener('click', () => {
  const name = nameInput?.value?.trim() || '';
  showStatus('接続中...');
  om.createRoom(name);
});

btnJoin?.addEventListener('click', () => {
  const code = codeInput?.value?.trim().toUpperCase();
  const name = nameInput?.value?.trim() || '';
  if (!code || code.length !== 4) {
    showStatus('4文字の部屋コードを入力してください', true);
    return;
  }
  showStatus('参加中...');
  om.joinRoom(code, name, false);
});

btnSpectate?.addEventListener('click', () => {
  const code = codeInput?.value?.trim().toUpperCase();
  const name = nameInput?.value?.trim() || '';
  if (!code || code.length !== 4) {
    showStatus('4文字の部屋コードを入力してください', true);
    return;
  }
  showStatus('観戦で参加中...');
  om.joinRoom(code, name, true);
});

btnCancel?.addEventListener('click', () => {
  forgetSeat();
  location.reload();
});

btnStart?.addEventListener('click', () => {
  if (!om.isHost) return;
  // ゲーム設定を収集
  const settings = {
    initialChips: parseInt(document.getElementById('online-initial-chips')?.value) || 1000,
    smallBlind: parseInt(document.getElementById('online-small-blind')?.value) || 10,
    bigBlind: parseInt(document.getElementById('online-big-blind')?.value) || 20,
    ante: parseInt(document.getElementById('online-ante')?.value) || 5,
    betTimeLimit: parseInt(document.getElementById('online-bet-time')?.value) || 10,
    dealerTimeLimit: parseInt(document.getElementById('online-dealer-time')?.value) || 20,
    showdownTimeLimit: parseInt(document.getElementById('online-showdown-time')?.value) || 20,
    levelUpHands: parseInt(document.getElementById('online-level-up')?.value) || 5,
    deckCount: parseInt(document.getElementById('online-deck-count')?.value) || 1,
    autoCalcMode: document.getElementById('online-auto-calc')?.checked || false,
  };
  om.startGame(settings, (res) => {
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

// ===== リロード後の自動復帰 =====
// 通信が切れた・アプリを切り替えた・うっかり再読み込みした、で
// 席に戻れなくなるのを防ぐ。失敗しても普通のロビーが出るだけ。
(function autoRejoin() {
  const seat = savedSeat();
  if (!seat || !seat.roomCode || !seat.playerName) return;

  if (nameInput) nameInput.value = seat.playerName;
  if (codeInput) codeInput.value = seat.roomCode;
  showStatus(`部屋 ${seat.roomCode} に復帰しています...`);
  om.joinRoom(seat.roomCode, seat.playerName, !!seat.asSpectator, seat.seatToken);
})();

// 中央通知
window.showCenterNotification = (msg, duration = 3000) => {
  const notify = document.getElementById('online-notification');
  if (!notify) return;
  notify.textContent = msg;
  notify.classList.remove('hidden');
  setTimeout(() => notify.classList.add('hidden'), duration);
};