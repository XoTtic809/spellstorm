/**
 * SpellStorm — Lobby Manager
 *
 * Handles code-based private lobbies for Battle Royale mode.
 * Lobbies are in-memory only; no DB persistence needed.
 */

const logger = require('../utils/logger');

// Map<code, LobbyData>
const lobbies = new Map();

// Map<socketId, code>  — track which lobby a socket is in
const socketToLobby = new Map();

const MAX_PLAYERS   = 6;
const MIN_PLAYERS   = 2;
const LOBBY_TTL_MS  = 10 * 60 * 1000; // 10 minutes

/**
 * Generate a random lobby code like "STORM-4F"
 */
function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let prefix = '';
  let suffix = '';
  for (let i = 0; i < 5; i++) prefix += chars[Math.floor(Math.random() * chars.length)];
  for (let i = 0; i < 2; i++) suffix += chars[Math.floor(Math.random() * chars.length)];
  const code = `${prefix}-${suffix}`;
  // Ensure uniqueness
  return lobbies.has(code) ? generateCode() : code;
}

/**
 * Create a new lobby. Returns the lobby object.
 */
function createLobby(socket, subMode) {
  const code = generateCode();
  const lobby = {
    code,
    hostSocketId: socket.id,
    subMode,
    players: new Map(),
    status: 'waiting',
    createdAt: Date.now(),
    expiryTimer: null,
  };

  _addPlayer(lobby, socket);

  lobby.expiryTimer = setTimeout(() => {
    if (lobbies.has(code) && lobbies.get(code).status === 'waiting') {
      logger.info('lobby', 'expired', { code });
      cleanupLobby(code);
    }
  }, LOBBY_TTL_MS);

  lobbies.set(code, lobby);
  logger.info('lobby', 'created', { code, subMode, host: socket.user?.username });
  return lobby;
}

/**
 * Join an existing lobby by code. Returns { ok, error, lobby }.
 */
function joinLobby(code, socket) {
  const lobby = lobbies.get(code.toUpperCase());
  if (!lobby)            return { ok: false, error: 'Lobby not found. Check your code and try again.' };
  if (lobby.status !== 'waiting') return { ok: false, error: 'This game has already started.' };
  if (lobby.players.size >= MAX_PLAYERS) return { ok: false, error: 'Lobby is full (6/6).' };

  // Don't allow duplicate userId
  const userId = socket.user?.id;
  for (const p of lobby.players.values()) {
    if (p.userId === userId) return { ok: false, error: 'You are already in this lobby.' };
  }

  _addPlayer(lobby, socket);
  logger.info('lobby', 'player_joined', { code, user: socket.user?.username });
  return { ok: true, lobby };
}

/**
 * Remove a player from their lobby. Returns the lobby (or null if deleted).
 */
function leaveLobby(socketId) {
  const code = socketToLobby.get(socketId);
  if (!code) return null;

  const lobby = lobbies.get(code);
  if (!lobby) { socketToLobby.delete(socketId); return null; }

  lobby.players.delete(socketId);
  socketToLobby.delete(socketId);

  // If host left, promote next player
  if (lobby.hostSocketId === socketId && lobby.players.size > 0) {
    lobby.hostSocketId = lobby.players.keys().next().value;
    logger.info('lobby', 'host_transferred', { code, newHost: lobby.hostSocketId });
  }

  // If empty, clean up
  if (lobby.players.size === 0) {
    cleanupLobby(code);
    return null;
  }

  logger.info('lobby', 'player_left', { code, socketId });
  return lobby;
}

/**
 * Mark lobby as starting (prevents new joins). Returns lobby or null.
 */
function startLobby(code) {
  const lobby = lobbies.get(code);
  if (!lobby) return null;
  if (lobby.players.size < MIN_PLAYERS) return null;

  lobby.status = 'in-progress';
  if (lobby.expiryTimer) clearTimeout(lobby.expiryTimer);
  return lobby;
}

/**
 * Get lobby by code.
 */
function getLobby(code) {
  return lobbies.get(typeof code === 'string' ? code.toUpperCase() : '') || null;
}

/**
 * Get the lobby code a socket is currently in.
 */
function getLobbyCodeForSocket(socketId) {
  return socketToLobby.get(socketId) || null;
}

/**
 * Delete lobby and remove all socket mappings.
 */
function cleanupLobby(code) {
  const lobby = lobbies.get(code);
  if (!lobby) return;
  if (lobby.expiryTimer) clearTimeout(lobby.expiryTimer);
  for (const socketId of lobby.players.keys()) {
    socketToLobby.delete(socketId);
  }
  lobbies.delete(code);
  logger.info('lobby', 'cleaned_up', { code });
}

/**
 * Serialize lobby for sending to clients (no internal refs).
 */
function serializeLobby(lobby) {
  return {
    code:        lobby.code,
    subMode:     lobby.subMode,
    hostSocketId: lobby.hostSocketId,
    status:      lobby.status,
    playerCount: lobby.players.size,
    maxPlayers:  MAX_PLAYERS,
    minPlayers:  MIN_PLAYERS,
    players: Array.from(lobby.players.values()).map(p => ({
      socketId: p.socketId,
      username: p.username,
      rating:   p.rating,
      isHost:   p.socketId === lobby.hostSocketId,
    })),
  };
}

// ── Internal ──────────────────────────────────────────────────────────────────

function _addPlayer(lobby, socket) {
  lobby.players.set(socket.id, {
    socketId: socket.id,
    userId:   socket.user?.id,
    username: socket.user?.username,
    rating:   0, // fetched from DB by battle.js on start
  });
  socketToLobby.set(socket.id, lobby.code);
}

module.exports = {
  createLobby,
  joinLobby,
  leaveLobby,
  startLobby,
  getLobby,
  getLobbyCodeForSocket,
  cleanupLobby,
  serializeLobby,
  MIN_PLAYERS,
  MAX_PLAYERS,
};
