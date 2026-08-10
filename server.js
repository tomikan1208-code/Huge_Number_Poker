/**
 * server.js - 巨大数ポーカー オンライン対戦サーバー
 * Socket.ioによる部屋管理・ゲーム状態同期・サーバー権威型ゲーム進行
 */

'use strict';

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

// ゲームロジックを読み込み
const { Game, PHASES, DEFAULT_CONFIG, buildDeck, shuffle } = require('./js/game.js');
const { HugeNumber, FormulaEvaluator } = require('./js/engine.js');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const PORT = process.env.PORT || 3000;

// ------------------------------------------------------------
// 静的ファイル配信
// インターネットに公開する前提なので、プロジェクト全体を配信しない。
// （server.js / package.json / node_modules / *.md まで見えてしまうため）
// 配信するのは、ブラウザが実際に必要とするものだけに限定する。
// ------------------------------------------------------------
const staticOpts = { dotfiles: 'deny', index: false, maxAge: '1h' };
app.use('/css', express.static(path.join(__dirname, 'css'), staticOpts));
app.use('/js', express.static(path.join(__dirname, 'js'), staticOpts));
// 学習済みAIの重み（models/policy_<level>.json）。公開して問題ない静的データ。
app.use('/models', express.static(path.join(__dirname, 'models'), staticOpts));

const sendPage = (file) => (req, res) => res.sendFile(path.join(__dirname, file));
app.get('/', sendPage('index.html'));
app.get('/index.html', sendPage('index.html'));
app.get('/online', sendPage('online.html'));
app.get('/online.html', sendPage('online.html'));
// AIテスト場（CPUの正答率モデルを確かめる開発用ページ。読むだけなので公開しても害はない）
app.get('/lab', sendPage('ai-lab.html'));
app.get('/ai-lab.html', sendPage('ai-lab.html'));

// 上記以外は 404（ディレクトリ一覧やソースの覗き見を防ぐ）
app.use((req, res) => res.status(404).type('text/plain').send('Not Found'));

// ============================================================
// データ構造
// ============================================================

const rooms = new Map(); // roomId -> Room

/*
Room構造:
{
  id: string,
  hostId: string,
  players: [Player],
  spectators: [Spectator],
  started: boolean,
  settings: object,
  game: Game|null,
  deleteTimer: Timeout|null,
}
*/

// ============================================================
// ユーティリティ
// ============================================================

function genRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
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
    game: null,
    deleteTimer: null,
    phaseTimer: null,
    deadline: null,
    _timerKey: null,
  };
  rooms.set(roomId, room);
  return room;
}

function makeRoomState(room) {
  return {
    roomCode: room.id,
    hostId: room.hostId,
    started: room.started,
    canStart: room.players.length >= 2 && !room.started,
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

function inheritHost(room) {
  const candidates = room.players.filter(p => p.connected && p.id !== room.hostId);
  if (candidates.length > 0) {
    const nextHost = candidates[Math.floor(Math.random() * candidates.length)];
    room.hostId = nextHost.id;
    room.players.forEach(p => p.isHost = (p.id === nextHost.id));
    return true;
  }
  const specCandidates = room.spectators.filter(s => s.connected);
  if (specCandidates.length > 0) {
    const nextHost = specCandidates[0];
    room.spectators = room.spectators.filter(s => s.id !== nextHost.id);
    nextHost.role = 'player';
    nextHost.index = room.players.length;
    nextHost.isHost = true;
    room.hostId = nextHost.id;
    room.players.push(nextHost);
    return true;
  }
  return false;
}

function findPlayerByName(room, name) {
  const p = room.players.find(p => p.name === name && !p.connected);
  if (p) return { entry: p, list: 'players' };
  const s = room.spectators.find(s => s.name === name && !s.connected);
  if (s) return { entry: s, list: 'spectators' };
  return null;
}

function reindexPlayers(room) {
  room.players.forEach((p, i) => { p.index = i; });
}

function emitRoomState(room) {
  io.to(room.id).emit('room-state', makeRoomState(room));
}

// ============================================================
// ゲーム状態の同期（クライアント用に整形）
// ============================================================

/**
 * クライアントに送信するゲーム状態を整形
 * 各プレイヤーには自分の手札のみを送信し、他プレイヤーの手札は非表示
 */
function makeGameStateForClient(room, clientSocketId) {
  const game = room.game;
  if (!game) return null;

  // game.players は脱落してもインデックスが変わらないので room.players と対応が保たれる
  const players = game.players.map((p, idx) => {
    const isMe = room.players[idx] && room.players[idx].id === clientSocketId;
    const revealed = game.phase === 'SHOWDOWN' && p.isActive && p.formula;
    return {
      id: p.id,
      name: p.name,
      chips: p.chips,
      // 自分の手札だけを送る。ショーダウンでは使用したカードのみ公開する。
      hand: isMe ? p.hand : p.hand.map(() => ({ id: 'hidden', type: 'hidden', value: '?', display: '?' })),
      revealedCards: revealed ? p.formula.usedCards : null,
      isDealer: p.isDealer,
      isActive: p.isActive,
      isEliminated: p.isEliminated,
      currentBet: p.currentBet,
      totalBet: p.totalBet,
      isAllIn: p.isAllIn,
      hasSubmitted: p.hasSubmitted,
      isReady: p.isReady,
      formula: game.phase === 'SHOWDOWN' ? p.formula : null,
      playerIndex: idx,
    };
  });

  return {
    phase: game.phase,
    config: game.config,
    pot: game.pot,
    currentBet: game.currentBet,
    minRaise: game.minRaise,
    currentPlayerIdx: game.currentPlayerIdx,
    dealerIdx: game.dealerIdx,
    handNumber: game.handNumber,
    level: game.level,
    betRound: game.betRound,
    players,
    winners: game.winners.map(w => w.player.id),
    showdownResults: game.showdownResults,
    log: game.log,
    calculationTimeLimit: game.calculationTimeLimit,
    autoCalcMode: !!game.config.autoCalcMode,
    gameOver: game.isGameOver(),
    deadline: room.deadline || null,
  };
}

/** 表示名を安全な範囲に切り詰める（HTML注入・極端に長い名前の防止） */
function sanitizeName(raw, fallback) {
  const s = String(raw == null ? '' : raw)
    .replace(/[<>&"'`\\]/g, '')     // タグや引用符になりうる文字は落とす
    .replace(/[\x00-\x1f\x7f]/g, '') // 制御文字
    .trim()
    .slice(0, 12);
  return s || fallback;
}

// ============================================================
// ゲーム進行（サーバー権威）
// ============================================================

/** ゲーム開始 */
function startGame(room, settings) {
  const num = (v, def, min, max) => {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n)) return def;
    return Math.max(min, Math.min(max, n));
  };

  const config = {
    initialChips: num(settings.initialChips, 1000, 100, 100000),
    smallBlind: num(settings.smallBlind, 10, 1, 10000),
    bigBlind: num(settings.bigBlind, 20, 2, 20000),
    ante: num(settings.ante, 5, 0, 5000),
    betTimeLimit: num(settings.betTimeLimit, 10, 5, 60),
    dealerTimeLimit: num(settings.dealerTimeLimit, 20, 10, 120),
    levelUpHands: num(settings.levelUpHands, 5, 1, 20),
    deckCount: num(settings.deckCount, 1, 1, 3),
    autoCalcMode: !!settings.autoCalcMode,
  };

  const game = new Game(config);
  game.startGame(room.players.length, room.players.map(p => p.name));

  room.game = game;
  room.settings = config;

  // 配札後、ベットラウンド1へ
  setTimeout(() => {
    if (!room.game) return;
    room.game.startBettingRound(1);
    broadcastGameState(room);
  }, 1000);
}

// ------------------------------------------------------------
// フェーズタイマー（サーバー権威）
// これが無いと、誰かが放置・切断した時点で部屋が永久に止まる。
// ------------------------------------------------------------

function clearRoomTimer(room) {
  if (room.phaseTimer) clearTimeout(room.phaseTimer);
  room.phaseTimer = null;
  room.deadline = null;
}

function armPhaseTimer(room) {
  clearRoomTimer(room);
  const game = room.game;
  if (!game || game.isGameOver()) return;

  let seconds = 0;
  if (game.phase === PHASES.BETTING_1 || game.phase === PHASES.BETTING_2) {
    seconds = game.getCurrentTimeLimit();
  } else if (game.phase === PHASES.CALCULATION) {
    seconds = game.calculationTimeLimit;
  } else if (game.phase === PHASES.EXCHANGE) {
    seconds = Math.max(20, game.config.betTimeLimit * 3);
  }
  if (seconds <= 0) return;

  const ms = seconds * 1000 + 500; // わずかに余裕を持たせる
  room.deadline = Date.now() + ms;
  room.phaseTimer = setTimeout(() => onPhaseTimeout(room), ms);
}

function onPhaseTimeout(room) {
  const game = room.game;
  if (!game) return;

  if (game.phase === PHASES.BETTING_1 || game.phase === PHASES.BETTING_2) {
    const idx = game.currentPlayerIdx;
    const p = game.players[idx];
    if (p) {
      const needsCall = (game.currentBet - p.currentBet) > 0;
      game.playerAction(idx, needsCall ? 'fold' : 'check');
    }
  } else if (game.phase === PHASES.EXCHANGE) {
    game.players.forEach((p, i) => {
      if (p.isActive && !p.isEliminated && !p.isReady) {
        game.selectExchangeCards(i, []);
        game.readyExchange(i);
      }
    });
  } else if (game.phase === PHASES.CALCULATION) {
    game.finishCalculation();
  }

  broadcastGameState(room);
}

/** ゲーム状態を全クライアントにブロードキャスト */
function broadcastGameState(room) {
  if (!room.game) return;

  // フェーズ or 手番が変わったらタイマーを張り直す（deadline を含めて配信するため先に行う）
  const key = `${room.game.phase}:${room.game.currentPlayerIdx}:${room.game.handNumber}`;
  if (room._timerKey !== key) {
    room._timerKey = key;
    armPhaseTimer(room);
  }

  const roomState = makeRoomState(room);
  for (const p of room.players) {
    io.to(p.id).emit('game-update', { gameState: makeGameStateForClient(room, p.id), roomState });
  }
  for (const s of room.spectators) {
    io.to(s.id).emit('game-update', { gameState: makeGameStateForClient(room, s.id), roomState });
  }
}

/** プレイヤーアクション処理 */
function handlePlayerAction(room, playerIndex, action, amount) {
  const game = room.game;
  if (!game) return { ok: false, error: 'ゲームが開始されていません' };

  const result = game.playerAction(playerIndex, action, amount);
  if (!result.ok) return result;

  // フェーズ遷移チェック
  checkPhaseTransition(room);
  broadcastGameState(room);
  return { ok: true };
}

/** 交換アクション */
function handleExchange(room, playerIndex, cardIds) {
  const game = room.game;
  if (!game) return { ok: false, error: 'ゲームが開始されていません' };

  game.selectExchangeCards(playerIndex, cardIds);
  game.readyExchange(playerIndex);

  checkPhaseTransition(room);
  broadcastGameState(room);
  return { ok: true };
}

/** 数式提出 */
function handleSubmitFormula(room, playerIndex, formulaString, playerDeclaredResult) {
  const game = room.game;
  if (!game) return { ok: false, error: 'ゲームが開始されていません' };

  const result = game.submitFormula(playerIndex, formulaString, playerDeclaredResult);
  if (!result.ok) return result;

  checkPhaseTransition(room);
  broadcastGameState(room);
  return { ok: true };
}

/** フェーズ遷移を検出して処理 */
function checkPhaseTransition(room) {
  const game = room.game;
  if (!game) return;

  // ショーダウン時は全員に公開情報を送信
  if (game.phase === PHASES.SHOWDOWN) {
    // ショーダウン結果は全員に公開
    broadcastGameState(room);
  }
}

/** 次ハンドへ */
function handleNextHand(room) {
  const game = room.game;
  if (!game) return;
  if (game.phase !== PHASES.SHOWDOWN) return; // 二重実行を防ぐ

  game.settle();

  if (game.isGameOver()) {
    clearRoomTimer(room);
    broadcastGameState(room);
    return;
  }

  setTimeout(() => {
    if (!room.game) return;
    room.game.startBettingRound(1);
    broadcastGameState(room);
  }, 500);
}

// ============================================================
// Socket.io イベントハンドラ
// ============================================================

io.on('connection', (socket) => {
  console.log(`[接続] ${socket.id}`);

  // ===== 部屋作成 =====
  socket.on('create-room', ({ playerName }) => {
    const roomId = genRoomId();
    const safeName = sanitizeName(playerName, 'Player1');
    const room = createRoom(roomId, socket, safeName);
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.playerName = safeName;

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
    const name = sanitizeName(playerName, `Guest-${socket.id.slice(0, 4)}`);

    if (!room) {
      callback?.({ ok: false, error: 'Room not found' });
      return;
    }

    if (room.deleteTimer) {
      clearTimeout(room.deleteTimer);
      room.deleteTimer = null;
    }

    // 再入室判定
    const rejoin = findPlayerByName(room, name);
    if (rejoin) {
      const entry = rejoin.entry;
      entry.id = socket.id;
      entry.connected = true;
      socket.join(roomId);
      socket.data.roomId = roomId;
      socket.data.playerName = name;

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

      socket.to(roomId).emit('opponent-disconnected', {
        playerName: name,
        reason: 'rejoin'
      });

      // ゲーム中ならフルステート同期（止まっていたタイマーもここで再開する）
      if (room.started && room.game) {
        broadcastGameState(room);
        socket.emit('sync-full-state', { gameState: makeGameStateForClient(room, socket.id) });
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
    startGame(room, settings || {});

    console.log(`[ゲーム開始] ${roomId}: ${room.players.length}人`);
    io.to(roomId).emit('game-started', {
      gameState: makeGameStateForClient(room, socket.id),
      roomState: makeRoomState(room),
    });
    callback?.({ ok: true });
  });

  // ===== ゲームアクション =====
  socket.on('game-action', (actionData, callback) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room || !room.started || !room.game) {
      callback?.({ ok: false, error: 'ゲームが開始されていません' });
      return;
    }

    // プレイヤーインデックスを特定
    const player = room.players.find(p => p.id === socket.id);
    if (!player) {
      callback?.({ ok: false, error: 'プレイヤーではありません' });
      return;
    }

    const { type, data } = actionData;
    let result;

    switch (type) {
      case 'bet':
        result = handlePlayerAction(room, player.index, data.action, data.amount || 0);
        break;
      case 'exchange':
        result = handleExchange(room, player.index, data.cardIds || []);
        break;
      case 'submit-formula':
        result = handleSubmitFormula(room, player.index, data.formula || '', data.result || '');
        break;
      case 'next-hand':
        handleNextHand(room);
        result = { ok: true };
        break;
      default:
        result = { ok: false, error: '不明なアクション' };
    }

    callback?.(result);
  });

  // ===== フルステート同期（再入室用） =====
  socket.on('request-sync', () => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room || !room.game) return;
    const state = makeGameStateForClient(room, socket.id);
    socket.emit('sync-full-state', { gameState: state });
  });

  // ===== チャット =====
  socket.on('chat', ({ message }) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
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

    const player = room.players.find(p => p.id === socket.id);
    if (player) player.connected = false;
    const spectator = room.spectators.find(s => s.id === socket.id);
    if (spectator) spectator.connected = false;

    console.log(`[切断] ${socket.id} (${name}) from ${roomId}`);
    socket.to(roomId).emit('opponent-disconnected', { playerName: name, reason: 'disconnect' });

    if (wasHost) {
      inheritHost(room);
    }

    const hasConnected = room.players.some(p => p.connected) ||
                         room.spectators.some(s => s.connected);
    if (!hasConnected) {
      if (room.deleteTimer) clearTimeout(room.deleteTimer);
      // 全員切断中はフェーズタイマーも止める。再入室時に張り直せるようキーも消す。
      clearRoomTimer(room);
      room._timerKey = null;
      room.deleteTimer = setTimeout(() => {
        console.log(`[部屋削除] ${roomId} (全員切断)`);
        clearRoomTimer(room);
        rooms.delete(roomId);
      }, 30 * 60 * 1000);
      return;
    }

    emitRoomState(room);
  });
});

// ============================================================
// サーバー起動
// ============================================================

/** LAN 内の他端末からアクセスできる IPv4 アドレスを列挙する */
function lanAddresses() {
  const os = require('os');
  const list = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) list.push({ name, address: a.address });
    }
  }
  return list;
}

// 0.0.0.0 を明示して待ち受ける（LAN 内の他端末から接続できるようにする）
server.listen(PORT, '0.0.0.0', () => {
  const lan = lanAddresses();
  console.log('');
  console.log('============================================================');
  console.log('  巨大数ポーカー サーバー起動');
  console.log('============================================================');
  console.log(`  この PC から      : http://localhost:${PORT}`);
  if (lan.length === 0) {
    console.log('  同じLANの端末から: (LAN アドレスが見つかりません)');
  } else {
    for (const { name, address } of lan) {
      console.log(`  同じLANの端末から: http://${address}:${PORT}   [${name}]`);
    }
  }
  console.log('');
  console.log('  ※ 他の端末から開けない場合は、Windows ファイアウォールで');
  console.log(`     TCP ${PORT} の受信を許可してください（allow-firewall.ps1）`);
  console.log('============================================================');
  console.log('');
});