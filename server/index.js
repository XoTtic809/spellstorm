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
  // Must run before queue logic so returning players resume their match
  const resumed = handleReconnect(socket, io);
  if (resumed) {
    logger.info('io', 'match resumed on reconnect', { user: username });
  }

  // ── Matchmaking ───────────────────────────────────────────────────────────

  socket.on('queue:join', async (payload) => {
    const mode = payload?.mode;
    if (!['ranked', 'casual'].includes(mode)) return;
    if (resumed) return; // don't queue if currently in a match

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

  // ── Game Events ───────────────────────────────────────────────────────────

  socket.on('game:submit', (payload) => {
    // Validate payload strictly
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

  // ── Disconnect ────────────────────────────────────────────────────────────

  socket.on('disconnecting', () => {
    dequeue(socket.id);
  });

  socket.on('disconnect', () => {
    // Only remove from map if this is still the registered socket
    if (connectedUsers.get(userId) === socket.id) {
      connectedUsers.delete(userId);
    }
    logger.info('io', 'disconnected', { user: username, socketId: socket.id });
    handleDisconnect(socket.id, io);
  });
});

// ── Matchmaking Ticker ────────────────────────────────────────────────────────

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

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || '3000');

server.listen(PORT, () => {
  logger.info('server', 'SpellStorm started', { port: PORT, env: process.env.NODE_ENV || 'development' });
  console.log(`\n🌩️  SpellStorm server running on port ${PORT}`);
  console.log(`   Mode: ${process.env.NODE_ENV || 'development'}\n`);
});
