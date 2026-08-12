/**
 * online-manager.js - Socket.io 通信管理クラス
 * 部屋管理・プレイヤー管理・状態同期・再入室・ホスト継承対応
 */

class OnlineManager {
  constructor() {
    this.socket = null;
    this.roomCode = null;
    this.playerIndex = null;
    this.playerName = 'Player';
    this.isHost = false;
    this.myRole = 'player';
    this.roomState = null;
    this.callbacks = {};
    // 席の所有証明。これを持っている人だけが進行中の部屋に戻れる。
    this.seatToken = null;
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

  /**
   * 部屋に参加。
   * seatToken を渡すと、その席の持ち主として再入室する（進行中の部屋はトークン必須）。
   */
  joinRoom(roomCode, playerName, asSpectator = false, seatToken = null) {
    this.connect();
    this.roomCode = roomCode.toUpperCase();
    this.isHost = false;
    this.playerName = playerName || 'Guest';
    this.myRole = asSpectator ? 'spectator' : 'player';
    this.socket.emit('join-room', {
      roomCode: this.roomCode,
      playerName: this.playerName,
      asSpectator,
      seatToken: seatToken || undefined,
    }, (res) => {
      if (!res?.ok) {
        if (this.callbacks.onJoinError) this.callbacks.onJoinError(res?.error || '参加に失敗しました');
        return;
      }
      this.playerIndex = res.playerIndex ?? -1;
      this.isHost = res.isHost ?? false;
      this.myRole = res.myRole || 'player';
      this.seatToken = res.seatToken || this.seatToken;
      if (res.roomState) this.roomState = res.roomState;
      if (this.callbacks.onRoomJoined) this.callbacks.onRoomJoined(res);
    });
  }

  /** CPUを席に追加（ホストのみ・開始前だけ） */
  addCpu(level, cb) {
    if (!this.socket || !this.roomCode) return;
    this.socket.emit('add-cpu', { level }, cb);
  }

  /** CPUを席から外す。id を省くと最後に足した1席を外す */
  removeCpu(id, cb) {
    if (!this.socket || !this.roomCode) return;
    this.socket.emit('remove-cpu', { id: id || null }, cb);
  }

  /** ゲーム開始（ホストのみ呼べる） */
  startGame(settings, cb) {
    if (!this.socket || !this.roomCode) return;
    this.socket.emit('start-game', { settings }, cb);
  }

  /** ゲームアクション送信 */
  sendAction(actionType, data, cb) {
    if (!this.socket || !this.roomCode) return;
    this.socket.emit('game-action', { type: actionType, playerIndex: this.playerIndex, data }, cb);
  }

  /** フルステート同期要求（再入室時など） */
  requestFullState() {
    if (!this.socket || !this.roomCode) return;
    this.socket.emit('request-sync');
  }

  _setupListeners() {
    // 部屋作成完了
    this.socket.on('room-created', ({ roomCode, playerIndex, isHost, seatToken, roomState }) => {
      this.roomCode = roomCode;
      this.playerIndex = playerIndex;
      this.isHost = isHost;
      this.myRole = 'player';
      this.seatToken = seatToken || null;
      this.roomState = roomState;
      if (this.callbacks.onRoomCreated) {
        this.callbacks.onRoomCreated({ roomCode, playerIndex, isHost, seatToken, roomState });
      }
    });

    // 部屋状態更新
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

    // フルステート同期（再入室用）
    this.socket.on('sync-full-state', ({ gameState }) => {
      if (this.callbacks.onSyncFullState) this.callbacks.onSyncFullState(gameState);
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
      if (this.callbacks.onDisconnected) this.callbacks.onDisconnected();
    });
  }

  /** 自分の番か判定 */
  isMyTurn(currentPlayerIdx) {
    return this.playerIndex === currentPlayerIdx;
  }
}

window.onlineManager = new OnlineManager();