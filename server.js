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
const crypto = require('crypto');
const fs = require('fs');
const { Game, PHASES, DEFAULT_CONFIG, buildDeck, shuffle, decksNeededFor } = require('./js/game.js');
const { HugeNumber, FormulaEvaluator } = require('./js/engine.js');
const { AIPlayer } = require('./js/ai.js');
const AICognition = require('./js/ai-cognition.js');
const AIPolicy = require('./js/ai-policy.js');

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

// テーブルの上限。デッキ数は人数に合わせて自動で増やすので、ここだけ見ればよい。
const MAX_ROOM_PLAYERS = 8;

/** 席の持ち主だけが再入室できるようにするための秘密の合言葉 */
function genSeatToken() {
  return crypto.randomBytes(16).toString('hex');
}

// ------------------------------------------------------------
// CPU（オンライン対戦に混ぜられる AI プレイヤー）
// ------------------------------------------------------------

const AI_LEVELS = ['novice', 'casual', 'skilled', 'expert', 'master'];

/**
 * 学習済み方策をディスクから読む。
 * ブラウザ側は fetch で models/policy_<level>.json を取りに行くが、
 * サーバーには相対URLの基準が無いので fs で読む。
 * 無ければヒューリスティック方策で動く（ブラウザと同じ挙動）。
 */
const _policyCache = new Map();
function loadPolicyForLevel(level) {
  if (_policyCache.has(level)) return _policyCache.get(level);

  let policy = null;
  for (const file of [`models/policy_${level}.json`, 'models/policy.json']) {
    try {
      const raw = fs.readFileSync(path.join(__dirname, file), 'utf8');
      const weights = JSON.parse(raw);
      if (!weights || !weights.trunk || !weights.heads) continue;
      if (weights.obs_dim !== AIPolicy.OBS_DIM) {
        console.log(`[AI] ${file} の観測次元が合いません (${weights.obs_dim} != ${AIPolicy.OBS_DIM})。学習し直しが必要です`);
        continue;
      }
      policy = new AIPolicy.NeuralPolicy(weights);
      console.log(`[AI] ${file} を読み込みました（${level}）`);
      break;
    } catch (e) { /* 次の候補へ */ }
  }

  _policyCache.set(level, policy);
  return policy;
}

/** CPU席をひとつ作る（socket を持たないプレイヤー） */
function makeCpuSeat(room, level) {
  const lv = AI_LEVELS.includes(level) ? level : 'casual';
  const profile = AICognition.getProfile(lv);
  const used = new Set(room.players.map(p => p.name));

  let name = `CPU ${profile.label}`;
  for (let n = 2; used.has(name); n++) name = `CPU ${profile.label}${n}`;

  return {
    id: `cpu-${crypto.randomBytes(4).toString('hex')}`,
    name,
    index: room.players.length,
    isHost: false,
    connected: true,
    role: 'player',
    isCPU: true,
    aiLevel: lv,
    token: null, // CPU は再入室しない
  };
}

/** 人間のプレイヤー（CPUを除く）だけを数える */
function humanPlayers(room) {
  return room.players.filter(p => !p.isCPU);
}

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
      role: 'player',
      token: genSeatToken(),
    }],
    spectators: [],
    started: false,
    settings: {},
    game: null,
    deleteTimer: null,
    phaseTimer: null,
    deadline: null,
    _timerKey: null,
    readyForNext: new Set(), // ショーダウンで「次へ」を押した socket.id
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
    maxPlayers: MAX_ROOM_PLAYERS,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      index: p.index,
      isHost: p.isHost,
      connected: p.connected,
      isCPU: !!p.isCPU,
      aiLevel: p.aiLevel || null,
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
  // CPU にホストを渡してはいけない（誰もゲームを開始できなくなる）
  const candidates = room.players.filter(p => !p.isCPU && p.connected && p.id !== room.hostId);
  if (candidates.length > 0) {
    const nextHost = candidates[Math.floor(Math.random() * candidates.length)];
    room.hostId = nextHost.id;
    room.players.forEach(p => p.isHost = (p.id === nextHost.id));
    return true;
  }

  // 観戦者をプレイヤーに繰り上げられるのは、ゲームが始まる前だけ。
  // 開始後は game.players の席数が固定なので、席の無いプレイヤーができてしまう。
  const specCandidates = room.spectators.filter(s => s.connected);
  if (specCandidates.length > 0 && !room.started && room.players.length < MAX_ROOM_PLAYERS) {
    const nextHost = specCandidates[0];
    room.spectators = room.spectators.filter(s => s.id !== nextHost.id);
    nextHost.role = 'player';
    nextHost.index = room.players.length;
    room.hostId = nextHost.id;
    room.players.push(nextHost);
    room.players.forEach(p => p.isHost = (p.id === nextHost.id));
    return true;
  }

  // 繰り上げられないときは、観戦者にホスト権だけ渡す（部屋の設定・開始はできる）
  if (specCandidates.length > 0) {
    room.hostId = specCandidates[0].id;
    room.players.forEach(p => { p.isHost = false; });
    return true;
  }
  return false;
}

/**
 * 再入室する席を探す。
 *
 * ゲーム開始後は「席のトークンを持っている人」だけが戻れる。
 * 名前の一致だけで通していた頃は、部屋コードと切断中の人の名前さえ知っていれば
 * その席を乗っ取って手札を見られた。
 * 開始前のロビーは見られて困る情報が無いので、名前一致でも入れるままにしてある。
 */
function findSeat(room, { token, name }) {
  const all = [...room.players, ...room.spectators];

  if (token) {
    const byToken = all.find(e => e.token === token && !e.connected);
    if (byToken) return { entry: byToken, matchedBy: 'token' };
    // トークンはあるが席が無い（部屋が作り直された等）→ 新規参加として扱う
    return null;
  }

  if (room.started) return null; // 進行中はトークン必須
  const byName = all.find(e => e.name === name && !e.connected);
  return byName ? { entry: byName, matchedBy: 'name' } : null;
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
    // showdownResults の player はゲーム内部のオブジェクトそのもので hand を持つ。
    // そのまま流すと全員の手札（フォールドした人の分まで）が漏れるので、
    // 表示に必要な id と名前だけに落とす。
    showdownResults: (game.showdownResults || []).map(r => ({
      player: { id: r.player.id, name: r.player.name },
      status: r.status,
      formula: r.formula,
      valueString: r.valueString,
    })),
    settlement: game.settlement,
    nextHand: nextHandReadyInfo(room),
    log: game.log,
    calculationTimeLimit: game.calculationTimeLimit,
    autoCalcMode: !!game.config.autoCalcMode,
    gameOver: game.isGameOver(),
    standings: game.isGameOver() ? game.finalStandings() : null,
    // 締切は「あと何ミリ秒か」で送る。絶対時刻(epoch)を送ると、
    // 端末の時計がずれているぶんだけタイマーがそのままずれる。
    remainingMs: room.deadline ? Math.max(0, room.deadline - Date.now()) : null,
  };
}

/** ショーダウンで「次へ」を押した人と、待っている人数 */
function nextHandReadyInfo(room) {
  const game = room.game;
  if (!game) return { ready: [], needed: 0 };

  const ready = [];
  room.players.forEach((rp, i) => {
    if (room.readyForNext.has(rp.id)) ready.push(i);
  });
  // CPU はボタンを押さないので待たない
  const needed = room.players.filter((rp, i) =>
    !rp.isCPU && rp.connected && game.players[i] && !game.players[i].isEliminated).length;

  return { ready, needed };
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
    showdownTimeLimit: num(settings.showdownTimeLimit, 20, 5, 120),
    levelUpHands: num(settings.levelUpHands, 5, 1, 20),
    deckCount: num(settings.deckCount, 1, 1, 3),
    autoCalcMode: !!settings.autoCalcMode,
  };

  const cpuLevels = room.players.map(p => (p.isCPU ? p.aiLevel : null));

  const game = new Game(config);
  game.startGame(room.players.length, room.players.map(p => p.name), { cpuLevels });

  // CPU席の思考エンジンを用意する（席ごとに独立した乱数列を持たせる）
  room.ai = {};
  room.players.forEach((p, i) => {
    if (!p.isCPU) return;
    room.ai[i] = new AIPlayer(p.aiLevel, {
      seed: (Math.random() * 1e9) | 0,
      policy: loadPolicyForLevel(p.aiLevel),
    });
  });

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
  } else if (game.phase === PHASES.SHOWDOWN) {
    // これが無いと、誰も「次のハンドへ」を押さなかった部屋が永久に止まる
    seconds = game.config.showdownTimeLimit || 20;
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
  } else if (game.phase === PHASES.SHOWDOWN) {
    // 時間切れ。まだ押していない人がいても次のハンドへ進める。
    advanceToNextHand(room);
    return;
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

  emitPerClient(room, 'game-update');

  // 状態を配ったあとで CPU の次の手を予約する（配る前だと自分の手を見逃す）
  scheduleRoomAI(room);
}

/**
 * 部屋の全員に、それぞれ専用に整形したゲーム状態を送る。
 * io.to(roomId).emit で1人分の状態を配ると、その1人の手札が全員に漏れる。
 */
function emitPerClient(room, event) {
  const roomState = makeRoomState(room);
  for (const c of [...room.players, ...room.spectators]) {
    if (c.isCPU) continue; // 送り先の socket が無い
    io.to(c.id).emit(event, { gameState: makeGameStateForClient(room, c.id), roomState });
  }
}

// ============================================================
// CPU の手番を進める
//
// ローカル対戦（ui.js の scheduleAI）と同じ組み立て。
// 「いま誰の番か」を見て、少し間を置いてから AI に指させる。
// ============================================================

function clearAiTimers(room) {
  (room.aiTimers || []).forEach(t => clearTimeout(t));
  room.aiTimers = [];
}

function pushAiTimer(room, id) {
  if (!room.aiTimers) room.aiTimers = [];
  room.aiTimers.push(id);
}

function isCpuSeat(room, i) {
  const rp = room.players[i];
  return !!(rp && rp.isCPU && room.ai && room.ai[i]);
}

/** フェーズに応じて CPU の行動を予約する */
function scheduleRoomAI(room) {
  clearAiTimers(room);
  const game = room.game;
  if (!game || game.isGameOver()) return;

  if (game.phase === PHASES.BETTING_1 || game.phase === PHASES.BETTING_2) {
    const idx = game.currentPlayerIdx;
    const p = game.players[idx];
    if (isCpuSeat(room, idx) && p && p.isActive && !p.isAllIn && !p.isEliminated) {
      pushAiTimer(room, setTimeout(() => runCpuBet(room, idx), 700 + Math.random() * 900));
    }
    return;
  }

  if (game.phase === PHASES.EXCHANGE) {
    game.players.forEach((p, i) => {
      if (isCpuSeat(room, i) && p.isActive && !p.isReady) {
        pushAiTimer(room, setTimeout(() => runCpuExchange(room, i), 600 + Math.random() * 1400));
      }
    });
    return;
  }

  if (game.phase === PHASES.CALCULATION) scheduleCpuCalculation(room);
}

function runCpuBet(room, idx) {
  const game = room.game;
  if (!game || (game.phase !== PHASES.BETTING_1 && game.phase !== PHASES.BETTING_2)) return;
  if (game.currentPlayerIdx !== idx || !isCpuSeat(room, idx)) return;

  let decision;
  try {
    decision = room.ai[idx].act(game, idx);
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
  broadcastGameState(room);
}

function runCpuExchange(room, idx) {
  const game = room.game;
  if (!game || game.phase !== PHASES.EXCHANGE || !isCpuSeat(room, idx)) return;
  const p = game.players[idx];
  if (!p.isActive || p.isReady) return;

  let ids = [];
  try { ids = room.ai[idx].exchange(game, idx) || []; } catch (e) { ids = []; }
  game.selectExchangeCards(idx, ids);
  game.readyExchange(idx);
  broadcastGameState(room);
}

/**
 * 計算フェーズ。
 * 「どの式を出すか / 当たるか外すか / 何秒かかるか」はフェーズ開始時に1回だけ決める。
 * 人間が操作するたびに再抽選されると、CPUの強さが操作回数で変わってしまう。
 */
function scheduleCpuCalculation(room) {
  const game = room.game;
  if (!game._aiCalcPlan) {
    game._aiCalcPlan = {};
    const now = Date.now();
    game.players.forEach((p, i) => {
      if (!isCpuSeat(room, i) || !p.isActive || p.hasSubmitted) return;
      let plan;
      try { plan = room.ai[i].submit(game, i); } catch (e) { plan = { timedOut: true }; }
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
    if (plan.timedOut || !plan.formula || plan.declared == null) return; // 間に合わず未提出
    pushAiTimer(room, setTimeout(() => runCpuSubmit(room, i), Math.max(0, plan.dueAt - now)));
  });
}

function runCpuSubmit(room, idx) {
  const game = room.game;
  if (!game || game.phase !== PHASES.CALCULATION) return;
  const p = game.players[idx];
  const plan = game._aiCalcPlan && game._aiCalcPlan[idx];
  if (!p || !p.isActive || p.hasSubmitted || !plan) return;
  if (plan.timedOut || !plan.formula || plan.declared == null) return;

  const res = game.submitFormula(idx, plan.formula, plan.declared);
  if (!res.ok) return;
  broadcastGameState(room);
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

/**
 * 「次のハンドへ」の意思表示。
 * 1人が押しただけで全員を先に進めてしまうと、結果を読んでいる途中で画面が飛ぶ。
 * 接続中の全員が押すか、ショーダウンの制限時間が切れたときだけ進める。
 */
function handleNextHand(room, socketId) {
  const game = room.game;
  if (!game || game.phase !== PHASES.SHOWDOWN) return { ok: true };

  room.readyForNext.add(socketId);

  const info = nextHandReadyInfo(room);
  if (info.ready.length >= info.needed) {
    advanceToNextHand(room);
  } else {
    broadcastGameState(room); // 「2/3人が待機中」を全員に見せる
  }
  return { ok: true };
}

/** 実際に精算して次のハンドを始める */
function advanceToNextHand(room) {
  const game = room.game;
  if (!game) return;
  if (game.phase !== PHASES.SHOWDOWN) return; // 二重実行を防ぐ

  clearRoomTimer(room);
  room.readyForNext.clear();
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
      myRole: 'player',
      seatToken: room.players[0].token,
      roomState: makeRoomState(room),
    });
  });

  // ===== 部屋参加 / 再入室 =====
  socket.on('join-room', ({ roomCode, playerName, asSpectator, seatToken }, callback) => {
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
    const rejoin = findSeat(room, { token: seatToken, name });
    if (rejoin) {
      const entry = rejoin.entry;
      entry.id = socket.id;
      entry.connected = true;
      if (!entry.token) entry.token = genSeatToken();
      socket.join(roomId);
      socket.data.roomId = roomId;
      socket.data.playerName = entry.name;

      if (entry.isHost) room.hostId = socket.id;

      callback?.({
        ok: true,
        roomCode: roomId,
        playerIndex: entry.index,
        isHost: entry.isHost,
        myRole: entry.role,
        seatToken: entry.token,
        roomState: makeRoomState(room),
        isRejoin: true,
      });

      socket.to(roomId).emit('opponent-disconnected', {
        playerName: entry.name,
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
    if (!asSpectator && room.players.length >= MAX_ROOM_PLAYERS) {
      callback?.({ ok: false, error: 'Room is full' });
      return;
    }

    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.playerName = name;

    const token = genSeatToken();

    if (asSpectator) {
      room.spectators.push({
        id: socket.id,
        name,
        connected: true,
        role: 'spectator',
        token,
      });
      callback?.({
        ok: true,
        roomCode: roomId,
        playerIndex: -1,
        isHost: false,
        myRole: 'spectator',
        seatToken: token,
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
        role: 'player',
        token,
      });
      callback?.({
        ok: true,
        roomCode: roomId,
        playerIndex: index,
        isHost: false,
        myRole: 'player',
        seatToken: token,
        roomState: makeRoomState(room),
      });
    }

    // 進行中の部屋に途中から入った人（観戦者）にも、いまの状態を渡す。
    // これが無いと、次に誰かが動くまで空の卓を見せることになる。
    // 全員抜けて止まっていた部屋なら、ここでタイマーとCPUも動き出す。
    if (room.started && room.game) {
      broadcastGameState(room);
      socket.emit('sync-full-state', { gameState: makeGameStateForClient(room, socket.id) });
    }

    emitRoomState(room);
  });

  // ===== CPU を席に追加 / 外す（ホストのみ・開始前だけ） =====
  socket.on('add-cpu', ({ level }, callback) => {
    const room = rooms.get(socket.data.roomId);
    if (!room) return;
    if (room.hostId !== socket.id) { callback?.({ ok: false, error: 'Only host can add CPU' }); return; }
    if (room.started) { callback?.({ ok: false, error: 'Already started' }); return; }
    if (room.players.length >= MAX_ROOM_PLAYERS) { callback?.({ ok: false, error: 'Room is full' }); return; }

    const seat = makeCpuSeat(room, level);
    room.players.push(seat);
    console.log(`[CPU追加] ${room.id}: ${seat.name} (${seat.aiLevel})`);

    emitRoomState(room);
    callback?.({ ok: true, id: seat.id, name: seat.name });
  });

  socket.on('remove-cpu', ({ id }, callback) => {
    const room = rooms.get(socket.data.roomId);
    if (!room) return;
    if (room.hostId !== socket.id) { callback?.({ ok: false, error: 'Only host can remove CPU' }); return; }
    if (room.started) { callback?.({ ok: false, error: 'Already started' }); return; }

    // id 指定ならその1席、無指定なら最後に足した1席だけ外す
    const target = id
      ? room.players.findIndex(p => p.isCPU && p.id === id)
      : room.players.map(p => !!p.isCPU).lastIndexOf(true);
    if (target < 0) { callback?.({ ok: false, error: 'CPU not found' }); return; }

    room.players.splice(target, 1);
    reindexPlayers(room);
    emitRoomState(room);
    callback?.({ ok: true });
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

    // 人数に対してデッキが足りなければ、勝手に増やす。
    // 足りないまま始めると _draw() が null を返し、黙って手札が6枚・5枚になる。
    const asked = Math.max(1, Math.min(3, parseInt(settings?.deckCount, 10) || 1));
    const needed = decksNeededFor(room.players.length);
    const deckCount = Math.max(asked, needed);
    const adjusted = deckCount !== asked;

    room.started = true;
    room.readyForNext.clear();
    startGame(room, { ...(settings || {}), deckCount });

    if (adjusted) {
      room.game._log(`${room.players.length}人には ${asked}デッキでは足りないため、${deckCount}デッキに増やしました`);
      console.log(`[デッキ自動調整] ${roomId}: ${asked} -> ${deckCount} (${room.players.length}人)`);
    }

    console.log(`[ゲーム開始] ${roomId}: ${room.players.length}人`);
    // 1人分の状態を部屋全体に配ると、その人の手札が全員に見えてしまう。
    // 必ず1人ずつ、その人向けに整形した状態を送る。
    emitPerClient(room, 'game-started');
    callback?.({ ok: true, deckCount, deckAdjusted: adjusted });
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
        result = handleNextHand(room, socket.id);
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
    room.readyForNext.delete(socket.id);

    console.log(`[切断] ${socket.id} (${name}) from ${roomId}`);
    socket.to(roomId).emit('opponent-disconnected', { playerName: name, reason: 'disconnect' });

    if (wasHost) {
      inheritHost(room);
    }

    // CPU は常に connected なので、人間だけで数える
    const hasConnected = humanPlayers(room).some(p => p.connected) ||
                         room.spectators.some(s => s.connected);
    if (!hasConnected) {
      if (room.deleteTimer) clearTimeout(room.deleteTimer);
      // 全員切断中はフェーズタイマーも CPU の思考も止める。
      // 再入室時に張り直せるようキーも消す。
      clearRoomTimer(room);
      clearAiTimers(room);
      room._timerKey = null;
      room.deleteTimer = setTimeout(() => {
        console.log(`[部屋削除] ${roomId} (全員切断)`);
        clearRoomTimer(room);
        clearAiTimers(room);
        rooms.delete(roomId);
      }, 30 * 60 * 1000);
      return;
    }

    // ショーダウンで待っている相手が抜けたなら、残り全員が押している時点で進める
    if (room.game && room.game.phase === PHASES.SHOWDOWN) {
      const info = nextHandReadyInfo(room);
      if (info.needed > 0 && info.ready.length >= info.needed) {
        advanceToNextHand(room);
        emitRoomState(room);
        return;
      }
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