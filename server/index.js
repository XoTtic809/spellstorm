/**
 * SpellStorm — Main Server
 *
 * Express + Socket.io server.
 * Serves static client files and handles all game logic via WebSockets.
 */
require('dotenv').config();

const express    = require('express');
const http       = require('http');
const path       = require('path');
const cors       = require('cors');
const { Server } = require('socket.io');
const rateLimit  = require('express-rate-limit');

const { authenticateSocket } = require('./auth');
const { enqueue, dequeue, findMatches, getQueuePosition, getQueueSizes } = require('./matchmaking');
const {
  createSession,
  submitAnswer,
  handleTabSwitch,
  handleDisconnect,
  getRoomForSocket,
} = require('./game');

// Routes
const authRoutes        = require('./routes/auth');
const leaderboardRoutes = require('./routes/leaderboard');
const profileRoutes     = require('./routes/profile');

// ─── Express Setup ───────────────────────────────────────────────────────────

const app    = express();
const server = http.createServer(app);

app.set('trust proxy', 1); // Required for Railway / reverse proxies

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST'],
}));

app.use(express.json({ limit: '10kb' }));

// Global API rate limit: 200 requests per 15 minutes per IP
app.use('/api', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
}));

// API Routes
app.use('/api/auth',        authRoutes);
app.use('/api/leaderboard', leaderboardRoutes);
app.use('/api/profile',     profileRoutes);

// Health check for Railway
app.get('/health', (_req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// Serve static client files
const clientDir = path.join(__dirname, '..', 'client');
app.use(express.static(clientDir));

// SPA fallback — return index.html for unknown routes
app.get('*', (_req, res) => {
  res.sendFile(path.join(clientDir, 'index.html'));
});

// ─── Socket.io Setup ─────────────────────────────────────────────────────────

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 20000,
  pingInterval: 10000,
});

// Socket.io authentication middleware
io.use((socket, next) => {
  try {
    const user = authenticateSocket(socket);
    socket.user = user;
    next();
  } catch (err) {
    next(new Error('Authentication failed: ' + err.message));
  }
});

io.on('connection', (socket) => {
  console.log(`[IO] Connected: ${socket.user.username} (${socket.id})`);

  // ── Matchmaking ──────────────────────────────────────────────────────────

  socket.on('queue:join', async ({ mode }) => {
    if (!['ranked', 'casual'].includes(mode)) return;

    // Prevent duplicate queuing
    dequeue(socket.id);

    // Fetch fresh rating from DB
    const { query } = require('../database/db');
    const { getRank } = require('../utils/ranks');

    try {
      const result = await query(
        'SELECT id, username, rating FROM users WHERE id=$1',
        [socket.user.id]
      );

      if (result.rows.length === 0) {
        socket.emit('error', { message: 'User not found.' });
        return;
      }

      const user = result.rows[0];
      enqueue(socket.id, user, mode);

      socket.emit('queue:joined', {
        mode,
        position: getQueuePosition(socket.id, mode),
        sizes:    getQueueSizes(),
      });
    } catch (err) {
      console.error('[IO] queue:join error:', err.message);
      socket.emit('error', { message: 'Failed to join queue.' });
    }
  });

  socket.on('queue:leave', () => {
    dequeue(socket.id);
    socket.emit('queue:left');
  });

  // ── Game Events ──────────────────────────────────────────────────────────

  socket.on('game:submit', ({ roomId, answer }) => {
    if (typeof answer !== 'string' || answer.length > 100) return;
    submitAnswer(socket.id, roomId, answer, io);
  });

  socket.on('game:tab_switch', ({ roomId }) => {
    if (!roomId) return;
    handleTabSwitch(socket.id, roomId, io);
  });

  // ── Disconnect ───────────────────────────────────────────────────────────

  socket.on('disconnecting', () => {
    dequeue(socket.id);
  });

  socket.on('disconnect', () => {
    console.log(`[IO] Disconnected: ${socket.user.username} (${socket.id})`);
    handleDisconnect(socket.id, io);
  });
});

// ─── Matchmaking Ticker ───────────────────────────────────────────────────────

const MATCHMAKING_TICK_MS = 2000;

setInterval(async () => {
  const matches = findMatches();

  for (const match of matches) {
    // Put both sockets into the shared room
    const s1 = io.sockets.sockets.get(match.player1.socketId);
    const s2 = io.sockets.sockets.get(match.player2.socketId);

    if (!s1 || !s2) {
      // One player disconnected before match was made — re-queue the other
      if (s1) enqueue(s1.id, match.player1, match.mode);
      if (s2) enqueue(s2.id, match.player2, match.mode);
      continue;
    }

    s1.join(match.roomId);
    s2.join(match.roomId);

    try {
      await createSession(match, io);
    } catch (err) {
      console.error('[IO] createSession error:', err.message);
      s1.emit('error', { message: 'Failed to start match. Please try again.' });
      s2.emit('error', { message: 'Failed to start match. Please try again.' });
    }
  }

  // Broadcast queue sizes every tick
  if (matches.length > 0 || true) {
    io.emit('queue:sizes', getQueueSizes());
  }
}, MATCHMAKING_TICK_MS);

// ─── Start Server ─────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || '3000');

server.listen(PORT, () => {
  console.log(`\n🌩️  SpellStorm server running on port ${PORT}`);
  console.log(`   Mode: ${process.env.NODE_ENV || 'development'}`);
  console.log(`   Client: http://localhost:${PORT}\n`);
});
