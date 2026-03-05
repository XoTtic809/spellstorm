/**
 * SpellStorm — Battle Royale Session Manager
 *
 * Handles N-player (2–6) battle sessions.
 * Party mode:     all 10 rounds, highest cumulative score wins.
 * Elimination mode: lowest scorer per round knocked out; last standing wins.
 *
 * This file is completely separate from game.js (1v1 sessions).
 */

const { v4: uuidv4 } = require('uuid');
const { query }       = require('../database/db');
const { buildMatchWordList, isCorrect } = require('../utils/words');
const logger          = require('../utils/logger');

// Map<roomId, BattleSession>
const battleSessions = new Map();

// Map<userId, { roomId, socketId, timer }>  — reconnect grace periods
const pendingReconnects = new Map();

const ROUND_TIMER_MS    = 15000;
const GRACE_MS          = 800;     // late-submission window
const RECONNECT_GRACE_MS = 10000;
const NEXT_ROUND_DELAY_MS = 3500;
const TOTAL_ROUNDS      = 10;

// Speed scoring: position (0-indexed) → points
const SPEED_POINTS = [10, 8, 6, 5, 4, 3];

/**
 * Create a new battle session from a match object.
 * match shape: { roomId, subMode, players: [{ socketId, userId, username, rating }], io }
 */
async function createBattleSession(match, io) {
  const { roomId, subMode, players } = match;

  // Fetch fresh ratings from DB
  const ids = players.map(p => p.userId);
  const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
  const dbResult = await query(
    `SELECT id, username, rating FROM users WHERE id IN (${placeholders})`,
    ids
  );
  const ratingMap = {};
  for (const row of dbResult.rows) ratingMap[row.id] = row.rating;

  const playerMap = new Map();
  for (const p of players) {
    playerMap.set(p.socketId, {
      socketId:   p.socketId,
      userId:     p.userId,
      username:   p.username,
      rating:     ratingMap[p.userId] ?? 1000,
      score:      0,       // cumulative score
      roundScore: 0,       // score this round (reset each round)
      roundCorrect: false, // did they answer correctly this round
      eliminated: false,
      idleRounds: 0,
    });
  }

  const session = {
    roomId,
    subMode,       // 'party' | 'elimination'
    players:       playerMap,
    words:         buildMatchWordList(TOTAL_ROUNDS),
    currentRound:  -1,
    roundId:       null,
    roundTimer:    null,
    roundStartTime: null,
    submittedThisRound: new Set(),
    answerOrder:   [],   // socketIds in order they got correct answer
    isFinished:    false,
  };

  battleSessions.set(roomId, session);
  logger.match('battle_created', { roomId, subMode, players: players.map(p => p.username) });

  // Send match found to all players
  io.to(roomId).emit('battle:found', {
    roomId,
    subMode,
    players: _serializePlayers(session),
    totalRounds: TOTAL_ROUNDS,
  });

  // Start first round after brief delay
  setTimeout(() => startBattleRound(roomId, io), 4000);
}

/**
 * Start the next battle round.
 */
function startBattleRound(roomId, io) {
  const session = battleSessions.get(roomId);
  if (!session || session.isFinished) return;

  session.currentRound++;

  // Check if game should end (party: all rounds done; elimination: 1 player left)
  const surviving = _survivingPlayers(session);

  if (session.subMode === 'elimination' && surviving.length <= 1) {
    return endBattleMatch(roomId, io);
  }
  if (session.currentRound >= TOTAL_ROUNDS) {
    return endBattleMatch(roomId, io);
  }

  // Increment idle for non-eliminated players (reset on submission)
  for (const p of session.players.values()) {
    if (!p.eliminated) p.idleRounds++;
  }

  // Reset per-round state
  session.roundId = uuidv4();
  session.submittedThisRound.clear();
  session.answerOrder = [];
  for (const p of session.players.values()) {
    p.roundScore   = 0;
    p.roundCorrect = false;
  }

  const wordEntry = session.words[session.currentRound];
  session.roundStartTime = Date.now();

  // Set server-side round timer
  if (session.roundTimer) clearTimeout(session.roundTimer);
  session.roundTimer = setTimeout(() => roundTimeout(roomId, io), ROUND_TIMER_MS + GRACE_MS);

  logger.match('battle_round_start', {
    roomId,
    round: session.currentRound + 1,
    word: wordEntry.word,
    roundId: session.roundId,
  });

  io.to(roomId).emit('battle:round:start', {
    roundId:     session.roundId,
    round:       session.currentRound + 1,
    totalRounds: TOTAL_ROUNDS,
    word:        wordEntry.word,
    difficulty:  wordEntry.difficulty,
    timerMs:     ROUND_TIMER_MS,
    scores:      _serializePlayers(session),
  });
}

/**
 * Handle a player's answer submission.
 */
function submitBattleAnswer(socketId, roomId, answer, roundId, io) {
  const session = battleSessions.get(roomId);
  if (!session || session.isFinished) return;

  const player = session.players.get(socketId);
  if (!player || player.eliminated) return;

  // Validate roundId
  if (roundId !== session.roundId) {
    return; // stale submission
  }

  // Prevent duplicate
  if (session.submittedThisRound.has(socketId)) {
    io.to(socketId).emit('answer:duplicate');
    return;
  }

  // Time check
  const elapsed = Date.now() - session.roundStartTime;
  if (elapsed > ROUND_TIMER_MS + GRACE_MS) {
    io.to(socketId).emit('answer:too_late');
    return;
  }

  // Sanitize
  const clean = String(answer).trim().toLowerCase().replace(/[^a-z]/g, '').slice(0, 60);
  const wordEntry = session.words[session.currentRound];

  session.submittedThisRound.add(socketId);
  player.idleRounds = 0; // any submission resets idle

  if (isCorrect(clean, wordEntry.word)) {
    const rank = session.answerOrder.length; // 0-indexed position
    const pts  = SPEED_POINTS[rank] ?? SPEED_POINTS[SPEED_POINTS.length - 1];

    session.answerOrder.push(socketId);
    player.roundScore   = pts;
    player.roundCorrect = true;
    player.score       += pts;

    logger.match('battle_correct', {
      roomId,
      user: player.username,
      pts,
      rank: rank + 1,
    });

    // Broadcast result to room
    io.to(roomId).emit('battle:answer:result', {
      socketId,
      username:    player.username,
      correct:     true,
      pointsEarned: pts,
      rank:        rank + 1,
      scores:      _serializePlayers(session),
    });

    // If all surviving players have submitted, end round early
    const survCount = _survivingPlayers(session).length;
    if (session.answerOrder.length >= survCount) {
      _endRoundEarly(roomId, io);
    }
  } else {
    io.to(socketId).emit('answer:wrong');
  }
}

/**
 * End the round early (all surviving players answered correctly).
 */
function _endRoundEarly(roomId, io) {
  const session = battleSessions.get(roomId);
  if (!session || session.isFinished) return;
  if (session.roundTimer) { clearTimeout(session.roundTimer); session.roundTimer = null; }
  _resolveRound(roomId, io);
}

/**
 * Round timed out — process results for anyone who didn't answer.
 */
function roundTimeout(roomId, io) {
  const session = battleSessions.get(roomId);
  if (!session || session.isFinished) return;
  _resolveRound(roomId, io);
}

/**
 * Shared round resolution logic.
 */
function _resolveRound(roomId, io) {
  const session = battleSessions.get(roomId);
  if (!session || session.isFinished) return;

  const wordEntry = session.words[session.currentRound];
  const surviving = _survivingPlayers(session);

  let eliminatedThisRound = [];

  if (session.subMode === 'elimination' && surviving.length > 1) {
    // Find lowest round score among surviving players
    const minScore = Math.min(...surviving.map(p => p.roundScore));
    const losers   = surviving.filter(p => p.roundScore === minScore);

    // Only eliminate if exactly 1 player is at the bottom (ties = no elimination)
    if (losers.length === 1) {
      losers[0].eliminated = true;
      eliminatedThisRound  = [losers[0].socketId];
      logger.match('battle_eliminated', { roomId, user: losers[0].username });
    }
  }

  logger.match('battle_round_end', {
    roomId,
    round: session.currentRound + 1,
    eliminated: eliminatedThisRound,
  });

  io.to(roomId).emit('battle:round:end', {
    word:            wordEntry.word,
    round:           session.currentRound + 1,
    scores:          _serializePlayers(session),
    eliminatedIds:   eliminatedThisRound,
    nextRoundInMs:   NEXT_ROUND_DELAY_MS,
  });

  // Check win condition after elimination
  const stillAlive = _survivingPlayers(session);
  if (session.subMode === 'elimination' && stillAlive.length <= 1) {
    setTimeout(() => endBattleMatch(roomId, io), NEXT_ROUND_DELAY_MS);
  } else if (session.currentRound + 1 >= TOTAL_ROUNDS) {
    setTimeout(() => endBattleMatch(roomId, io), NEXT_ROUND_DELAY_MS);
  } else {
    setTimeout(() => startBattleRound(roomId, io), NEXT_ROUND_DELAY_MS);
  }
}

/**
 * End the battle match, determine winner, emit results.
 */
function endBattleMatch(roomId, io, forfeitSocketId = null) {
  const session = battleSessions.get(roomId);
  if (!session || session.isFinished) return;

  session.isFinished = true;
  if (session.roundTimer) clearTimeout(session.roundTimer);

  // Build final rankings
  const allPlayers = Array.from(session.players.values());
  allPlayers.sort((a, b) => b.score - a.score);

  // Winner = highest score (or last surviving in elimination)
  const surviving = _survivingPlayers(session);
  let winner = null;
  if (surviving.length === 1) {
    winner = surviving[0];
  } else {
    winner = allPlayers[0]; // highest score
  }

  const rankings = allPlayers.map((p, i) => ({
    rank:       i + 1,
    socketId:   p.socketId,
    username:   p.username,
    score:      p.score,
    eliminated: p.eliminated,
    isWinner:   p.socketId === winner?.socketId,
  }));

  logger.match('battle_end', { roomId, winner: winner?.username, subMode: session.subMode });

  io.to(roomId).emit('battle:end', {
    rankings,
    subMode: session.subMode,
    totalRounds: session.currentRound + 1,
  });

  // Cleanup after delay
  setTimeout(() => {
    battleSessions.delete(roomId);
    for (const [uid, rec] of pendingReconnects.entries()) {
      if (rec.roomId === roomId) pendingReconnects.delete(uid);
    }
  }, 15000);
}

/**
 * Handle a player disconnecting from a battle session.
 */
function handleBattleDisconnect(socketId, io) {
  let foundSession = null;
  let disconnectedPlayer = null;

  for (const session of battleSessions.values()) {
    const p = session.players.get(socketId);
    if (p) { foundSession = session; disconnectedPlayer = p; break; }
  }

  if (!foundSession || !disconnectedPlayer) return;

  const { roomId } = foundSession;

  // Notify others
  io.to(roomId).emit('battle:opponent:disconnected', {
    socketId,
    username: disconnectedPlayer.username,
  });

  // Set reconnect grace timer
  const userId = disconnectedPlayer.userId;
  const timer = setTimeout(() => {
    // Grace expired — eliminate them
    const session = battleSessions.get(roomId);
    if (session && !session.isFinished) {
      const p = session.players.get(socketId);
      if (p) p.eliminated = true;
      io.to(roomId).emit('battle:opponent:reconnected', {
        socketId,
        username: disconnectedPlayer.username,
        timedOut: true,
      });

      // If only 1 surviving, end match
      if (_survivingPlayers(session).length <= 1) {
        endBattleMatch(roomId, io);
      }
    }
    pendingReconnects.delete(userId);
  }, RECONNECT_GRACE_MS);

  pendingReconnects.set(userId, { roomId, socketId, timer });
  logger.match('battle_disconnect', { roomId, user: disconnectedPlayer.username });
}

/**
 * Attempt to reconnect a player to an active battle session.
 * Returns true if reconnect succeeded.
 */
function handleBattleReconnect(socket, io) {
  const userId = socket.user?.id;
  const pending = pendingReconnects.get(userId);
  if (!pending) return false;

  const session = battleSessions.get(pending.roomId);
  if (!session || session.isFinished) {
    clearTimeout(pending.timer);
    pendingReconnects.delete(userId);
    return false;
  }

  // Find the player slot by old socketId
  const oldPlayer = session.players.get(pending.socketId);
  if (!oldPlayer) {
    pendingReconnects.delete(userId);
    return false;
  }

  // Cancel grace timer
  clearTimeout(pending.timer);
  pendingReconnects.delete(userId);

  // Update socket references
  session.players.delete(pending.socketId);
  oldPlayer.socketId = socket.id;
  session.players.set(socket.id, oldPlayer);

  // Update submittedThisRound ref if needed
  if (session.submittedThisRound.has(pending.socketId)) {
    session.submittedThisRound.delete(pending.socketId);
    session.submittedThisRound.add(socket.id);
  }

  // Also update answerOrder
  const idx = session.answerOrder.indexOf(pending.socketId);
  if (idx !== -1) session.answerOrder[idx] = socket.id;

  // Join room
  socket.join(pending.roomId);

  // Send resume state
  const elapsed = Date.now() - (session.roundStartTime || Date.now());
  socket.emit('battle:resume', {
    roomId:          pending.roomId,
    subMode:         session.subMode,
    roundId:         session.roundId,
    round:           session.currentRound + 1,
    totalRounds:     TOTAL_ROUNDS,
    word:            session.words[session.currentRound]?.word,
    difficulty:      session.words[session.currentRound]?.difficulty,
    timerRemainingMs: Math.max(0, ROUND_TIMER_MS - elapsed),
    scores:          _serializePlayers(session),
  });

  // Notify others
  io.to(pending.roomId).emit('battle:opponent:reconnected', {
    socketId: socket.id,
    username: oldPlayer.username,
    timedOut: false,
  });

  logger.match('battle_reconnect', { roomId: pending.roomId, user: oldPlayer.username });
  return true;
}

function getActiveBattleCount() {
  return battleSessions.size;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _survivingPlayers(session) {
  return Array.from(session.players.values()).filter(p => !p.eliminated);
}

function _serializePlayers(session) {
  return Array.from(session.players.values())
    .sort((a, b) => b.score - a.score)
    .map(p => ({
      socketId:    p.socketId,
      username:    p.username,
      score:       p.score,
      roundScore:  p.roundScore,
      roundCorrect: p.roundCorrect,
      eliminated:  p.eliminated,
    }));
}

module.exports = {
  createBattleSession,
  submitBattleAnswer,
  handleBattleDisconnect,
  handleBattleReconnect,
  endBattleMatch,
  getActiveBattleCount,
};
