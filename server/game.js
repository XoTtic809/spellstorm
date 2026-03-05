/**
 * SpellStorm — Core Game Session Logic (Hardened)
 *
 * Security model:
 *  - Server owns all timers; client timer is visual only
 *  - Every round has a unique roundId; submissions must include it
 *  - Duplicate submissions per round are rejected
 *  - Late submissions (> ROUND_TIMER_MS + grace) are rejected
 *  - Idle detection: player forfeits after IDLE_FORFEIT_ROUNDS consecutive missed rounds
 *  - Disconnect grace: 10s reconnect window before forfeit
 *  - All match events are logged via structured logger
 */

const { v4: uuidv4 }                    = require('uuid');
const { buildMatchWordList, isCorrect } = require('../utils/words');
const { calculateElo }                  = require('../utils/elo');
const { getRank }                       = require('../utils/ranks');
const { processTabSwitch, logWarning }  = require('./anticheat');
const { query, transaction }            = require('../database/db');
const logger                            = require('../utils/logger');

const ROUNDS_PER_MATCH    = parseInt(process.env.ROUNDS_PER_MATCH || '7');
const ROUND_TIMER_MS      = parseInt(process.env.ROUND_TIMER_MS   || '6000');
const COUNTDOWN_MS        = 3000;
const RECONNECT_GRACE_MS  = 10000; // ms before disconnect becomes a forfeit
const IDLE_WARN_ROUNDS    = 4;     // consecutive missed rounds → warning
const IDLE_FORFEIT_ROUNDS = 6;     // consecutive missed rounds → forfeit
const GRACE_WINDOW_MS     = 600;   // late-submission tolerance

// ── State ─────────────────────────────────────────────────────────────────────

const sessions         = new Map(); // roomId → GameSession
const pendingReconnects = new Map(); // userId → { roomId, playerKey, timer }

// ── Session Creation ──────────────────────────────────────────────────────────

async function createSession(matchInfo, io) {
  const { player1, player2, roomId, mode } = matchInfo;

  const [u1Row, u2Row] = await Promise.all([
    query('SELECT id, username, rating, win_streak FROM users WHERE id=$1', [player1.userId]),
    query('SELECT id, username, rating, win_streak FROM users WHERE id=$1', [player2.userId]),
  ]);

  const u1    = u1Row.rows[0];
  const u2    = u2Row.rows[0];
  const words = buildMatchWordList(ROUNDS_PER_MATCH);

  const session = {
    roomId,
    mode,
    words,
    currentRound:       -1,
    roundId:            null,   // UUID per round; clients echo it back
    roundStartTime:     null,
    roundTimer:         null,
    submittedThisRound: new Set(),
    player1:            makePlayer(player1.socketId, u1),
    player2:            makePlayer(player2.socketId, u2),
    matchId:            null,
    isFinished:         false,
  };

  sessions.set(roomId, session);

  const matchRow = await query(
    `INSERT INTO matches (player1_id, player2_id, mode, rounds)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [u1.id, u2.id, mode, ROUNDS_PER_MATCH]
  );
  session.matchId = matchRow.rows[0].id;

  logger.match('session_created', { room: roomId, mode, p1: u1.username, p2: u2.username });

  io.to(session.player1.socketId).emit('match:found', buildMatchFoundPayload(session, 'player1'));
  io.to(session.player2.socketId).emit('match:found', buildMatchFoundPayload(session, 'player2'));

  setTimeout(() => startRound(session, io), COUNTDOWN_MS + 500);
}

function makePlayer(socketId, dbUser) {
  return {
    socketId,
    userId:        dbUser.id,
    username:      dbUser.username,
    rating:        dbUser.rating,
    win_streak:    dbUser.win_streak,
    score:         0,
    warnings:      0,
    lastTabSwitch: null,
    idleRounds:    0,
  };
}

function buildMatchFoundPayload(session, perspective) {
  const self  = session[perspective];
  const other = perspective === 'player1' ? session.player2 : session.player1;
  return {
    roomId:      session.roomId,
    mode:        session.mode,
    totalRounds: ROUNDS_PER_MATCH,
    self:     { username: self.username,  rating: self.rating,  score: 0 },
    opponent: { username: other.username, rating: other.rating, score: 0 },
  };
}

// ── Round Logic ───────────────────────────────────────────────────────────────

function startRound(session, io) {
  if (session.isFinished) return;

  session.currentRound++;

  if (session.currentRound >= ROUNDS_PER_MATCH) {
    return endMatch(session, io, null);
  }

  // Idle forfeit check (runs before the new round begins)
  for (const key of ['player1', 'player2']) {
    const p     = session[key];
    const opKey = key === 'player1' ? 'player2' : 'player1';

    if (p.idleRounds >= IDLE_FORFEIT_ROUNDS) {
      logger.ac('idle_forfeit', { user: p.username, room: session.roomId, idleRounds: p.idleRounds });
      io.to(session.roomId).emit('player:idle_forfeit', { username: p.username });
      return endMatch(session, io, session[opKey].socketId, true);
    }

    if (p.idleRounds >= IDLE_WARN_ROUNDS) {
      io.to(p.socketId).emit('idle:warning', {
        idleRounds: p.idleRounds,
        forfeitAt:  IDLE_FORFEIT_ROUNDS,
      });
    }
  }

  // Fresh round ID — must be echoed back in any submission
  session.roundId        = uuidv4();
  session.roundStartTime = Date.now();
  session.submittedThisRound.clear();

  // Increment idle counters (reset on submission)
  session.player1.idleRounds++;
  session.player2.idleRounds++;

  const wordEntry = session.words[session.currentRound];

  io.to(session.roomId).emit('round:start', {
    round:       session.currentRound + 1,
    totalRounds: ROUNDS_PER_MATCH,
    roundId:     session.roundId,
    word:        wordEntry.word,
    difficulty:  wordEntry.difficulty,
    timerMs:     ROUND_TIMER_MS,
    scores:      currentScores(session),
  });

  session.roundTimer = setTimeout(() => roundTimeout(session, io), ROUND_TIMER_MS);
}

// ── Answer Submission ─────────────────────────────────────────────────────────

function submitAnswer(socketId, roomId, answer, roundId, io) {
  const session = sessions.get(roomId);
  if (!session || session.isFinished) return;

  // Round ID must match — rejects submissions intended for a different round
  if (roundId !== session.roundId) {
    io.to(socketId).emit('answer:too_late');
    return;
  }

  const playerKey = session.player1.socketId === socketId ? 'player1' : 'player2';
  const player    = session[playerKey];

  // Duplicate submission guard
  if (session.submittedThisRound.has(socketId)) {
    io.to(socketId).emit('answer:duplicate');
    return;
  }

  // Server-side timer check
  const elapsed = Date.now() - session.roundStartTime;
  if (elapsed > ROUND_TIMER_MS + GRACE_WINDOW_MS) {
    io.to(socketId).emit('answer:too_late');
    return;
  }

  // Sanitize: trim, lowercase, max 60 chars, letters only
  const cleanAnswer = String(answer).trim().toLowerCase().replace(/[^a-z]/g, '').slice(0, 60);
  if (!cleanAnswer) return;

  session.submittedThisRound.add(socketId);

  // Any submission resets idle counter
  player.idleRounds = 0;

  const wordEntry = session.words[session.currentRound];
  const correct   = isCorrect(cleanAnswer, wordEntry.word);

  if (correct) {
    clearTimeout(session.roundTimer);
    player.score++;

    logger.match('round_correct', {
      room:      roomId,
      round:     session.currentRound + 1,
      winner:    player.username,
      word:      wordEntry.word,
      elapsedMs: elapsed,
    });

    io.to(session.roomId).emit('round:correct', {
      winner: player.username,
      word:   wordEntry.word,
      scores: currentScores(session),
    });

    setTimeout(() => startRound(session, io), 1800);
  } else {
    // Wrong answer reduces idle penalty (they are engaged)
    player.idleRounds = Math.max(0, player.idleRounds - 1);
    io.to(socketId).emit('answer:wrong', { answer: cleanAnswer });
  }
}

// ── Round Timeout ─────────────────────────────────────────────────────────────

function roundTimeout(session, io) {
  if (session.isFinished) return;

  logger.match('round_timeout', {
    room:  session.roomId,
    round: session.currentRound + 1,
    word:  session.words[session.currentRound].word,
  });

  io.to(session.roomId).emit('round:timeout', {
    word:   session.words[session.currentRound].word,
    scores: currentScores(session),
  });

  setTimeout(() => startRound(session, io), 1800);
}

// ── Anti-Cheat ────────────────────────────────────────────────────────────────

function handleTabSwitch(socketId, roomId, io) {
  const session = sessions.get(roomId);
  if (!session || session.isFinished) return;

  const { action, warnings } = processTabSwitch(session, socketId, io);
  const playerKey   = session.player1.socketId === socketId ? 'player1' : 'player2';
  const opponentKey = playerKey === 'player1' ? 'player2' : 'player1';
  const player      = session[playerKey];

  if (session.matchId) {
    logWarning(session.matchId, player.userId, `tab_switch_${warnings}`);
  }

  if (action === 'lose_round') {
    clearTimeout(session.roundTimer);
    session[opponentKey].score++;
    io.to(session.roomId).emit('round:correct', {
      winner: session[opponentKey].username,
      word:   session.words[session.currentRound]?.word,
      reason: 'opponent_tabswitch',
      scores: currentScores(session),
    });
    setTimeout(() => startRound(session, io), 1800);

  } else if (action === 'forfeit') {
    endMatch(session, io, session[opponentKey].socketId, true);
  }
}

// ── Disconnect & Reconnect ────────────────────────────────────────────────────

function handleDisconnect(socketId, io) {
  for (const [roomId, session] of sessions.entries()) {
    const playerKey = session.player1.socketId === socketId ? 'player1'
                    : session.player2.socketId === socketId ? 'player2'
                    : null;
    if (!playerKey) continue;
    if (session.isFinished) break;

    const player      = session[playerKey];
    const opponentKey = playerKey === 'player1' ? 'player2' : 'player1';
    const opponent    = session[opponentKey];

    logger.match('player_disconnected', { room: roomId, user: player.username });

    io.to(opponent.socketId).emit('opponent:disconnected', {
      username:        player.username,
      reconnectTimeMs: RECONNECT_GRACE_MS,
    });

    const timer = setTimeout(() => {
      pendingReconnects.delete(player.userId);
      if (!session.isFinished) {
        logger.match('reconnect_timeout_forfeit', { room: roomId, user: player.username });
        endMatch(session, io, opponent.socketId, true);
      }
    }, RECONNECT_GRACE_MS);

    pendingReconnects.set(player.userId, { roomId, playerKey, timer });
    break;
  }
}

/**
 * Try to resume a session for a reconnecting user.
 * @returns {boolean} true if resumed
 */
function handleReconnect(socket, io) {
  const userId  = socket.user.id;
  const pending = pendingReconnects.get(userId);
  if (!pending) return false;

  const session = sessions.get(pending.roomId);
  if (!session || session.isFinished) {
    pendingReconnects.delete(userId);
    return false;
  }

  clearTimeout(pending.timer);
  pendingReconnects.delete(userId);

  const playerKey   = pending.playerKey;
  const opponentKey = playerKey === 'player1' ? 'player2' : 'player1';

  session[playerKey].socketId = socket.id;
  socket.join(session.roomId);

  logger.match('player_reconnected', { room: session.roomId, user: session[playerKey].username });

  io.to(session[opponentKey].socketId).emit('opponent:reconnected', {
    username: session[playerKey].username,
  });

  const wordEntry = session.words[session.currentRound] ?? null;
  const elapsed   = Date.now() - (session.roundStartTime ?? Date.now());

  socket.emit('match:resume', {
    roomId:           session.roomId,
    mode:             session.mode,
    totalRounds:      ROUNDS_PER_MATCH,
    round:            session.currentRound + 1,
    roundId:          session.roundId,
    word:             wordEntry?.word ?? null,
    difficulty:       wordEntry?.difficulty ?? null,
    timerRemainingMs: Math.max(0, ROUND_TIMER_MS - elapsed),
    scores:           currentScores(session),
    self: {
      username: session[playerKey].username,
      rating:   session[playerKey].rating,
      score:    session[playerKey].score,
      warnings: session[playerKey].warnings,
    },
    opponent: {
      username: session[opponentKey].username,
      score:    session[opponentKey].score,
    },
  });

  return true;
}

// ── Match End ─────────────────────────────────────────────────────────────────

async function endMatch(session, io, winnerSocketId, forfeit = false) {
  if (session.isFinished) return;
  session.isFinished = true;
  clearTimeout(session.roundTimer);

  const p1 = session.player1;
  const p2 = session.player2;

  let winner, loser;
  if (winnerSocketId) {
    winner = p1.socketId === winnerSocketId ? p1 : p2;
    loser  = p1.socketId === winnerSocketId ? p2 : p1;
  } else if (p1.score > p2.score) {
    winner = p1; loser = p2;
  } else if (p2.score > p1.score) {
    winner = p2; loser = p1;
  } else {
    winner = null;
  }

  let winnerDelta = 0, loserDelta = 0;
  let newWinnerRating = winner?.rating ?? p1.rating;
  let newLoserRating  = loser?.rating  ?? p2.rating;

  if (session.mode === 'ranked' && winner) {
    const elo   = calculateElo(winner, loser);
    winnerDelta     = elo.winnerDelta;
    loserDelta      = elo.loserDelta;
    newWinnerRating = elo.newWinnerRating;
    newLoserRating  = elo.newLoserRating;
  }

  logger.match('match_ended', {
    room:        session.roomId,
    mode:        session.mode,
    winner:      winner?.username ?? 'tie',
    forfeit,
    score:       `${p1.score}-${p2.score}`,
    ratingDelta: winnerDelta,
  });

  try {
    await transaction(async (client) => {
      await client.query(
        `UPDATE matches
         SET winner_id=$1, score_p1=$2, score_p2=$3, rating_change=$4, forfeit=$5
         WHERE id=$6`,
        [winner?.userId ?? null, p1.score, p2.score, winnerDelta, forfeit, session.matchId]
      );

      if (session.mode === 'ranked' && winner) {
        const winnerRank = getRank(newWinnerRating);
        const loserRank  = getRank(newLoserRating);

        await client.query(
          `UPDATE users
           SET rating=$1, rank_name=$2, wins=wins+1,
               win_streak=win_streak+1,
               best_streak=GREATEST(best_streak, win_streak+1)
           WHERE id=$3`,
          [newWinnerRating, winnerRank.name, winner.userId]
        );
        await client.query(
          `UPDATE users
           SET rating=$1, rank_name=$2, losses=losses+1, win_streak=0
           WHERE id=$3`,
          [newLoserRating, loserRank.name, loser.userId]
        );
      } else if (session.mode === 'ranked' && !winner) {
        await client.query(
          'UPDATE users SET wins=wins+1 WHERE id=$1 OR id=$2',
          [p1.userId, p2.userId]
        );
      } else if (session.mode === 'casual') {
        if (winner) {
          await client.query('UPDATE users SET wins=wins+1   WHERE id=$1', [winner.userId]);
          await client.query('UPDATE users SET losses=losses+1 WHERE id=$1', [loser.userId]);
        }
      }
    });
  } catch (err) {
    logger.error('game', 'Failed to persist match results', { err: err.message, room: session.roomId });
  }

  const buildResult = (self, opponent, selfDelta) => ({
    winner:  winner?.username ?? null,
    forfeit,
    scores:  currentScores(session),
    self: {
      username:    self.username,
      score:       self.score,
      ratingDelta: selfDelta,
      newRating:   self === winner ? newWinnerRating : (self === loser ? newLoserRating : self.rating),
      rank:        getRank(self === winner ? newWinnerRating : (self === loser ? newLoserRating : self.rating)),
    },
    opponent: { username: opponent.username, score: opponent.score },
  });

  const p1Delta = p1 === winner ? winnerDelta : (p1 === loser ? loserDelta : 0);
  const p2Delta = p2 === winner ? winnerDelta : (p2 === loser ? loserDelta : 0);

  io.to(p1.socketId).emit('match:end', buildResult(p1, p2, p1Delta));
  io.to(p2.socketId).emit('match:end', buildResult(p2, p1, p2Delta));

  setTimeout(() => {
    sessions.delete(session.roomId);
    pendingReconnects.delete(p1.userId);
    pendingReconnects.delete(p2.userId);
  }, 15000);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function currentScores(session) {
  return {
    [session.player1.username]: session.player1.score,
    [session.player2.username]: session.player2.score,
  };
}

function getSession(roomId)        { return sessions.get(roomId) || null; }
function getActiveSessionCount()   { return sessions.size; }

function getRoomForSocket(socketId) {
  for (const [roomId, session] of sessions.entries()) {
    if (session.player1.socketId === socketId || session.player2.socketId === socketId) {
      return roomId;
    }
  }
  return null;
}

module.exports = {
  createSession,
  submitAnswer,
  handleTabSwitch,
  handleDisconnect,
  handleReconnect,
  getSession,
  getRoomForSocket,
  getActiveSessionCount,
};
