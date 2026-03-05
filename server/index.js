/**
 * SpellStorm — Main Server (Hardened)
 *
 * Security additions:
 *  - One active socket per user (duplicate connections are disconnected)
 *  - All socket event payloads are type-validated before processing
 *  - roundId required on answer submissions
 *  - Reconnect detection on new connections
 *  - Structured logging throughout
 */
require('dotenv').config();

const express    = require('express');
const http       = require('http');
const path       = require('path');
const cors       = require('cors');
const { Server } = require('socket.io');
const rateLimit  = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');

const { authenticateSocket }                            = require('./auth');
const { enqueue, dequeue, findMatches, getQueueSizes }  = require('./matchmaking');
const {
  createSession,
  submitAnswer,
  handleTabSwitch,
  handleDisconnect,
  handleReconnect,
  getActiveSessionCount,
} = require('./game');
const {
  createBattleSession,
  submitBattleAnswer,
  handleBattleDisconnect,
  handleBattleReconnect,
  getActiveBattleCount,
} = require('./battle');
const {
  createLobby,
  joinLobby,
  leaveLobby,
  startLobby,
  getLobbyCodeForSocket,
  cleanupLobby,
  serializeLobby,
  MIN_PLAYERS,
  MAX_PLAYERS,
} = require('./lobbies');
const logger = require('../utils/logger');

const authRoutes        = require('./routes/auth');
const leaderboardRoutes = require('./routes/leaderboard');
const profileRoutes     = require('./routes/profile');

// ── Express ───────────────────────────────────────────────────────────────────

const app    = express();
const server = http.createServer(app);

app.set('trust proxy', 1);

app.use(cors({ origin: '*', methods: ['GET', 'POST'] }));
app.use(express.json({ limit: '10kb' }));

// Global API rate limit
app.use('/api', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Try again later.' },
}));

app.use('/api/auth',        authRoutes);
app.use('/api/leaderboard', leaderboardRoutes);
app.use('/api/profile',     profileRoutes);

// Health check — also exposes live session count for monitoring
app.get('/health', (_req, res) => res.json({
  status:   'ok',
  uptime:   process.uptime(),
  sessions: getActiveSessionCount(),
  battles:  getActiveBattleCount(),
}));

const clientDir = path.join(__dirname, '..', 'client');
app.use(express.static(clientDir));
app.get('*', (_req, res) => res.sendFile(path.join(clientDir, 'index.html')));

// ── Socket.io ─────────────────────────────────────────────────────────────────

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout:  20000,
  pingInterval: 10000,
});

// JWT auth middleware
io.use((socket, next) => {
  try {
    socket.user = authenticateSocket(socket);
    next();
  } catch (err) {
    next(new Error('Authentication failed'));
  }
});

// Track active sockets per user to prevent duplicate connections
// Map<userId, socketId>
const connectedUsers = new Map();

// Battle auto-matchmaking queues
// Map<socketId, { socketId, userId, username, rating, subMode, joinedAt }>
const battleQueues = { party: new Map(), elimination: new Map() };

const BATTLE_AUTO_MATCH_MIN     = 4;   // ideal match size
const BATTLE_AUTO_MATCH_WAIT_MS = 30000; // after 30s, match with ≥2

io.on('connection', (socket) => {
  const userId   = socket.user.id;
  const username = socket.user.username;

  // ── Duplicate connection guard ────────────────────────────────────────────
  const existingSocketId = connectedUsers.get(userId);
  if (existingSocketId && existingSocketId !== socket.id) {
    const existingSocket = io.sockets.sockets.get(existingSocketId);
    if (existingSocket) {
      logger.warn('io', 'Duplicate connection — disconnecting old socket', { user: username });
      existingSocket.emit('error', { message: 'You connected from another window.' });
      existingSocket.disconnect(true);
    }
  }
  connectedUsers.set(userId, socket.id);

  logger.info('io', 'connected', { user: username, socketId: socket.id });

  // ── Reconnect check ───────────────────────────────────────────────────────
  // Check 1v1 reconnect first, then battle reconnect
  const resumed = handleReconnect(socket, io);
  if (resumed) {
    logger.info('io', 'match resumed on reconnect', { user: username });
  } else {
    const battleResumed = handleBattleReconnect(socket, io);
    if (battleResumed) {
      logger.info('io', 'battle resumed on reconnect', { user: username });
    }
  }

  // ── 1v1 Matchmaking ───────────────────────────────────────────────────────

  socket.on('queue:join', async (payload) => {
    const mode = payload?.mode;
    if (!['ranked', 'casual'].includes(mode)) return;
    if (resumed) return;

    dequeue(socket.id);

    const { query } = require('../database/db');
    try {
      const result = await query(
        'SELECT id, username, rating FROM users WHERE id=$1',
        [userId]
      );
      if (result.rows.length === 0) {
        socket.emit('error', { message: 'User not found.' });
        return;
      }
      const user = result.rows[0];
      enqueue(socket.id, user, mode);

      socket.emit('queue:joined', { mode, sizes: getQueueSizes() });
      logger.info('io', 'queue_join', { user: username, mode });
    } catch (err) {
      logger.error('io', 'queue:join failed', { err: err.message });
      socket.emit('error', { message: 'Failed to join queue.' });
    }
  });

  socket.on('queue:leave', () => {
    dequeue(socket.id);
    socket.emit('queue:left');
  });

  // ── 1v1 Game Events ───────────────────────────────────────────────────────

  socket.on('game:submit', (payload) => {
    const { roomId, answer, roundId } = payload ?? {};
    if (typeof roomId   !== 'string' || roomId.length   > 64) return;
    if (typeof roundId  !== 'string' || roundId.length  > 64) return;
    if (typeof answer   !== 'string' || answer.length   > 100) return;

    submitAnswer(socket.id, roomId, answer, roundId, io);
  });

  socket.on('game:tab_switch', (payload) => {
    const { roomId } = payload ?? {};
    if (typeof roomId !== 'string' || roomId.length > 64) return;
    handleTabSwitch(socket.id, roomId, io);
  });

  // ── Battle Lobby (code-based) ─────────────────────────────────────────────

  socket.on('battle:create', (payload) => {
    const subMode = payload?.subMode;
    if (!['party', 'elimination'].includes(subMode)) {
      socket.emit('battle:error', { message: 'Invalid sub-mode.' });
      return;
    }

    // Leave any existing lobby first
    _leaveBattleQueue(socket, battleQueues);
    const existingCode = getLobbyCodeForSocket(socket.id);
    if (existingCode) leaveLobby(socket.id);

    const lobby = createLobby(socket, subMode);
    socket.join(`lobby:${lobby.code}`);
    socket.emit('battle:lobby:created', { code: lobby.code, lobby: serializeLobby(lobby) });
    logger.info('io', 'battle:create', { user: username, code: lobby.code, subMode });
  });

  socket.on('battle:join', (payload) => {
    const code = typeof payload?.code === 'string' ? payload.code.trim().toUpperCase() : '';
    if (!code) {
      socket.emit('battle:error', { message: 'Please enter a lobby code.' });
      return;
    }

    // Leave existing lobby/queue
    _leaveBattleQueue(socket, battleQueues);
    const existingCode = getLobbyCodeForSocket(socket.id);
    if (existingCode) {
      const oldLobby = leaveLobby(socket.id);
      if (oldLobby) {
        socket.leave(`lobby:${existingCode}`);
        io.to(`lobby:${existingCode}`).emit('battle:lobby:update', { lobby: serializeLobby(oldLobby) });
      }
    }

    const result = joinLobby(code, socket);
    if (!result.ok) {
      socket.emit('battle:error', { message: result.error });
      return;
    }

    socket.join(`lobby:${code}`);
    io.to(`lobby:${code}`).emit('battle:lobby:update', { lobby: serializeLobby(result.lobby) });
    socket.emit('battle:lobby:joined', { code, lobby: serializeLobby(result.lobby) });
    logger.info('io', 'battle:join', { user: username, code });
  });

  socket.on('battle:leave', () => {
    const code = getLobbyCodeForSocket(socket.id);
    if (!code) return;

    const updatedLobby = leaveLobby(socket.id);
    socket.leave(`lobby:${code}`);
    socket.emit('battle:lobby:left');

    if (updatedLobby) {
      io.to(`lobby:${code}`).emit('battle:lobby:update', { lobby: serializeLobby(updatedLobby) });
    }
  });

  socket.on('battle:start', async () => {
    const code = getLobbyCodeForSocket(socket.id);
    if (!code) {
      socket.emit('battle:error', { message: 'You are not in a lobby.' });
      return;
    }

    const { getLobby } = require('./lobbies');
    const lobby = getLobby(code);
    if (!lobby) {
      socket.emit('battle:error', { message: 'Lobby not found.' });
      return;
    }
    if (lobby.hostSocketId !== socket.id) {
      socket.emit('battle:error', { message: 'Only the host can start the game.' });
      return;
    }
    if (lobby.players.size < MIN_PLAYERS) {
      socket.emit('battle:error', { message: `Need at least ${MIN_PLAYERS} players to start.` });
      return;
    }

    const started = startLobby(code);
    if (!started) {
      socket.emit('battle:error', { message: 'Could not start lobby.' });
      return;
    }

    // Build player list for battle session
    const players = Array.from(lobby.players.values());
    const roomId  = uuidv4();

    // Join all lobby sockets to the battle room
    for (const p of players) {
      const s = io.sockets.sockets.get(p.socketId);
      if (s) s.join(roomId);
    }

    const match = { roomId, subMode: lobby.subMode, players };

    try {
      await createBattleSession(match, io);
      cleanupLobby(code);
      logger.info('io', 'battle:start', { user: username, code, roomId, subMode: lobby.subMode });
    } catch (err) {
      logger.error('io', 'battle:start failed', { err: err.message });
      io.to(roomId).emit('battle:error', { message: 'Failed to start battle. Please try again.' });
    }
  });

  // ── Battle Auto-Matchmaking ───────────────────────────────────────────────

  socket.on('battle:queue', async (payload) => {
    const subMode = payload?.subMode;
    if (!['party', 'elimination'].includes(subMode)) {
      socket.emit('battle:error', { message: 'Invalid sub-mode.' });
      return;
    }

    // Leave any existing lobby
    const existingCode = getLobbyCodeForSocket(socket.id);
    if (existingCode) {
      const oldLobby = leaveLobby(socket.id);
      socket.leave(`lobby:${existingCode}`);
      if (oldLobby) io.to(`lobby:${existingCode}`).emit('battle:lobby:update', { lobby: serializeLobby(oldLobby) });
    }

    // Remove from 1v1 queues
    dequeue(socket.id);
    // Remove from other battle queues
    _leaveBattleQueue(socket, battleQueues);

    const { query } = require('../database/db');
    try {
      const result = await query('SELECT id, username, rating FROM users WHERE id=$1', [userId]);
      if (result.rows.length === 0) { socket.emit('battle:error', { message: 'User not found.' }); return; }
      const user = result.rows[0];

      battleQueues[subMode].set(socket.id, {
        socketId: socket.id,
        userId:   user.id,
        username: user.username,
        rating:   user.rating,
        subMode,
        joinedAt: Date.now(),
      });

      socket.emit('battle:queue:joined', {
        subMode,
        queueSize: battleQueues[subMode].size,
      });
      logger.info('io', 'battle:queue_join', { user: username, subMode });
    } catch (err) {
      logger.error('io', 'battle:queue failed', { err: err.message });
      socket.emit('battle:error', { message: 'Failed to join battle queue.' });
    }
  });

  socket.on('battle:queue:leave', () => {
    _leaveBattleQueue(socket, battleQueues);
    socket.emit('battle:queue:left');
  });

  // ── Battle In-Game Events ─────────────────────────────────────────────────

  socket.on('battle:submit', (payload) => {
    const { roomId, answer, roundId } = payload ?? {};
    if (typeof roomId  !== 'string' || roomId.length  > 64) return;
    if (typeof roundId !== 'string' || roundId.length > 64) return;
    if (typeof answer  !== 'string' || answer.length  > 100) return;

    submitBattleAnswer(socket.id, roomId, answer, roundId, io);
  });

  // ── Disconnect ────────────────────────────────────────────────────────────

  socket.on('disconnecting', () => {
    dequeue(socket.id);
    _leaveBattleQueue(socket, battleQueues);

    // Leave any lobby
    const code = getLobbyCodeForSocket(socket.id);
    if (code) {
      const updatedLobby = leaveLobby(socket.id);
      if (updatedLobby) {
        io.to(`lobby:${code}`).emit('battle:lobby:update', { lobby: serializeLobby(updatedLobby) });
      }
    }
  });

  socket.on('disconnect', () => {
    if (connectedUsers.get(userId) === socket.id) {
      connectedUsers.delete(userId);
    }
    logger.info('io', 'disconnected', { user: username, socketId: socket.id });
    handleDisconnect(socket.id, io);
    handleBattleDisconnect(socket.id, io);
  });
});

// ── 1v1 Matchmaking Ticker ────────────────────────────────────────────────────

const MATCHMAKING_TICK_MS = 2000;

setInterval(async () => {
  const matches = findMatches();

  for (const match of matches) {
    const s1 = io.sockets.sockets.get(match.player1.socketId);
    const s2 = io.sockets.sockets.get(match.player2.socketId);

    if (!s1 || !s2) {
      if (s1) enqueue(s1.id, match.player1, match.mode);
      if (s2) enqueue(s2.id, match.player2, match.mode);
      continue;
    }

    s1.join(match.roomId);
    s2.join(match.roomId);

    try {
      await createSession(match, io);
    } catch (err) {
      logger.error('io', 'createSession failed', { err: err.message });
      s1.emit('error', { message: 'Failed to start match. Please try again.' });
      s2.emit('error', { message: 'Failed to start match. Please try again.' });
    }
  }

  // Broadcast queue sizes periodically
  io.emit('queue:sizes', getQueueSizes());
}, MATCHMAKING_TICK_MS);

// ── Battle Auto-Matchmaking Ticker ────────────────────────────────────────────

setInterval(async () => {
  for (const subMode of ['party', 'elimination']) {
    const queue = battleQueues[subMode];
    if (queue.size < 2) continue;

    const entries = Array.from(queue.values()).sort((a, b) => a.joinedAt - b.joinedAt);
    const now     = Date.now();
    const oldest  = entries[0];
    const waited  = now - oldest.joinedAt;

    // Fire when: ≥4 players queued, OR ≥2 players waited >30s
    const shouldMatch = queue.size >= BATTLE_AUTO_MATCH_MIN || waited >= BATTLE_AUTO_MATCH_WAIT_MS;
    if (!shouldMatch) continue;

    // Take up to 6 players
    const group = entries.slice(0, MAX_PLAYERS);

    // Verify all sockets still alive
    const alive = group.filter(e => io.sockets.sockets.has(e.socketId));
    if (alive.length < 2) {
      // Remove dead entries
      for (const e of group) {
        if (!io.sockets.sockets.has(e.socketId)) queue.delete(e.socketId);
      }
      continue;
    }

    // Remove matched players from queue
    for (const e of alive) queue.delete(e.socketId);

    const roomId = uuidv4();
    for (const e of alive) {
      const s = io.sockets.sockets.get(e.socketId);
      if (s) s.join(roomId);
    }

    const match = { roomId, subMode, players: alive };

    try {
      await createBattleSession(match, io);
      logger.info('io', 'battle_auto_match', {
        subMode,
        players: alive.map(e => e.username),
        roomId,
      });
    } catch (err) {
      logger.error('io', 'createBattleSession failed', { err: err.message });
      for (const e of alive) {
        const s = io.sockets.sockets.get(e.socketId);
        if (s) s.emit('battle:error', { message: 'Failed to start battle. Please try again.' });
      }
    }
  }

  // Broadcast battle queue sizes
  io.emit('battle:queue:sizes', {
    party:       battleQueues.party.size,
    elimination: battleQueues.elimination.size,
  });
}, MATCHMAKING_TICK_MS);

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || '3000');

server.listen(PORT, () => {
  logger.info('server', 'SpellStorm started', { port: PORT, env: process.env.NODE_ENV || 'development' });
  console.log(`\n🌩️  SpellStorm server running on port ${PORT}`);
  console.log(`   Mode: ${process.env.NODE_ENV || 'development'}\n`);
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function _leaveBattleQueue(socket, battleQueues) {
  for (const q of Object.values(battleQueues)) {
    q.delete(socket.id);
  }
}
