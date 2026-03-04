/**
 * Core game session logic for SpellStorm.
 *
 * Manages active game sessions, round progression, answer validation,
 * anti-cheat enforcement, and ELO updates.
 */

const { buildMatchWordList, isCorrect } = require('../utils/words');
const { calculateElo }                  = require('../utils/elo');
const { getRank }                       = require('../utils/ranks');
const { processTabSwitch, logWarning }  = require('./anticheat');
const { query, transaction }            = require('../database/db');

const ROUNDS_PER_MATCH = parseInt(process.env.ROUNDS_PER_MATCH  || '7');
const ROUND_TIMER_MS   = parseInt(process.env.ROUND_TIMER_MS    || '6000');
const COUNTDOWN_MS     = 3000; // pre-round countdown

// Active game sessions: Map<roomId, GameSession>
const sessions = new Map();

/**
 * Create and start a new game session.
 *
 * @param {object} matchInfo - { player1, player2, roomId, mode }
 * @param {object} io        - Socket.io instance
 */
async function createSession(matchInfo, io) {
  const { player1, player2, roomId, mode } = matchInfo;

  // Fetch fresh user data from DB (rating/streak may have changed)
  const [u1Row, u2Row] = await Promise.all([
    query('SELECT id, username, rating, win_streak FROM users WHERE id=$1', [player1.userId]),
    query('SELECT id, username, rating, win_streak FROM users WHERE id=$1', [player2.userId]),
  ]);

  const u1 = u1Row.rows[0];
  const u2 = u2Row.rows[0];

  const words = buildMatchWordList(ROUNDS_PER_MATCH);

  const session = {
    roomId,
    mode,
    words,
    currentRound: -1,        // incremented before first use
    roundStartTime: null,
    roundTimer: null,
    submittedThisRound: new Set(),
    player1: {
      socketId: player1.socketId,
      userId:   u1.id,
      username: u1.username,
      rating:   u1.rating,
      winStreak: u1.win_streak,
      score:    0,
      warnings: 0,
    },
    player2: {
      socketId: player2.socketId,
      userId:   u2.id,
      username: u2.username,
      rating:   u2.rating,
      winStreak: u2.win_streak,
      score:    0,
      warnings: 0,
    },
    matchId:    null, // set after DB insert
    isFinished: false,
  };

  sessions.set(roomId, session);

  // Insert match record early so warnings can reference it
  const matchRow = await query(
    `INSERT INTO matches (player1_id, player2_id, mode, rounds)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [u1.id, u2.id, mode, ROUNDS_PER_MATCH]
  );
  session.matchId = matchRow.rows[0].id;

  console.log(`[Game] Session created: ${roomId} | ${u1.username} vs ${u2.username} | ${mode}`);

  // Notify both players — match found!
  io.to(session.player1.socketId).emit('match:found', buildMatchFoundPayload(session, 'player1'));
  io.to(session.player2.socketId).emit('match:found', buildMatchFoundPayload(session, 'player2'));

  // Start countdown then first round
  setTimeout(() => startRound(session, io), COUNTDOWN_MS + 500);
}

/**
 * Build the match:found payload for a specific player perspective.
 */
function buildMatchFoundPayload(session, perspective) {
  const self  = session[perspective];
  const other = perspective === 'player1' ? session.player2 : session.player1;
  return {
    roomId:      session.roomId,
    mode:        session.mode,
    totalRounds: ROUNDS_PER_MATCH,
    self:  { username: self.username,  rating: self.rating,  score: 0, warnings: 0 },
    opponent: { username: other.username, rating: other.rating, score: 0, warnings: 0 },
  };
}

/**
 * Advance to the next round.
 */
function startRound(session, io) {
  if (session.isFinished) return;

  session.currentRound++;

  if (session.currentRound >= ROUNDS_PER_MATCH) {
    return endMatch(session, io, null); // normal end
  }

  const wordEntry = session.words[session.currentRound];
  session.roundStartTime = Date.now();
  session.submittedThisRound.clear();

  // Emit round start to both players
  io.to(session.roomId).emit('round:start', {
    round:       session.currentRound + 1,
    totalRounds: ROUNDS_PER_MATCH,
    word:        wordEntry.word,
    difficulty:  wordEntry.difficulty,
    timerMs:     ROUND_TIMER_MS,
    scores: {
      [session.player1.username]: session.player1.score,
      [session.player2.username]: session.player2.score,
    },
  });

  // Auto-end round when timer expires
  session.roundTimer = setTimeout(() => {
    roundTimeout(session, io);
  }, ROUND_TIMER_MS);
}

/**
 * Handle a player submitting an answer.
 *
 * @param {string} socketId
 * @param {string} roomId
 * @param {string} answer
 * @param {object} io
 */
function submitAnswer(socketId, roomId, answer, io) {
  const session = sessions.get(roomId);
  if (!session || session.isFinished) return;

  // Determine which player submitted
  const playerKey = session.player1.socketId === socketId ? 'player1' : 'player2';
  const player    = session[playerKey];

  // Prevent duplicate submission
  if (session.submittedThisRound.has(socketId)) {
    io.to(socketId).emit('answer:duplicate');
    return;
  }

  // Server-side timer validation: reject if submitted after deadline
  const elapsed = Date.now() - session.roundStartTime;
  if (elapsed > ROUND_TIMER_MS + 500) { // 500ms grace window
    io.to(socketId).emit('answer:too_late');
    return;
  }

  session.submittedThisRound.add(socketId);

  const wordEntry = session.words[session.currentRound];
  const correct   = isCorrect(answer, wordEntry.word);

  if (correct) {
    // Cancel the round timer — someone got it right
    clearTimeout(session.roundTimer);
    player.score++;

    io.to(session.roomId).emit('round:correct', {
      winner:     player.username,
      word:       wordEntry.word,
      scores: {
        [session.player1.username]: session.player1.score,
        [session.player2.username]: session.player2.score,
      },
    });

    // Brief pause before next round
    setTimeout(() => startRound(session, io), 1800);
  } else {
    io.to(socketId).emit('answer:wrong', { answer });
  }
}

/**
 * Called when the round timer expires with no correct answer.
 */
function roundTimeout(session, io) {
  if (session.isFinished) return;

  io.to(session.roomId).emit('round:timeout', {
    word: session.words[session.currentRound].word,
    scores: {
      [session.player1.username]: session.player1.score,
      [session.player2.username]: session.player2.score,
    },
  });

  setTimeout(() => startRound(session, io), 1800);
}

/**
 * Handle anti-cheat tab switch for a player.
 *
 * @param {string} socketId
 * @param {string} roomId
 * @param {object} io
 */
function handleTabSwitch(socketId, roomId, io) {
  const session = sessions.get(roomId);
  if (!session || session.isFinished) return;

  const { action, warnings } = processTabSwitch(session, socketId, io);

  const playerKey = session.player1.socketId === socketId ? 'player1' : 'player2';
  const player    = session[playerKey];

  // Log warning to DB (fire and forget)
  if (session.matchId) {
    logWarning(session.matchId, player.userId, `tab_switch_${warnings}`);
  }

  if (action === 'lose_round') {
    clearTimeout(session.roundTimer);
    const opponentKey = playerKey === 'player1' ? 'player2' : 'player1';
    session[opponentKey].score++;

    io.to(session.roomId).emit('round:correct', {
      winner:   session[opponentKey].username,
      word:     session.words[session.currentRound]?.word,
      reason:   'opponent_tabswitch',
      scores: {
        [session.player1.username]: session.player1.score,
        [session.player2.username]: session.player2.score,
      },
    });

    setTimeout(() => startRound(session, io), 1800);

  } else if (action === 'forfeit') {
    const opponentKey = playerKey === 'player1' ? 'player2' : 'player1';
    endMatch(session, io, session[opponentKey].socketId, true);
  }
}

/**
 * Handle a player disconnecting mid-match.
 */
function handleDisconnect(socketId, io) {
  for (const [roomId, session] of sessions.entries()) {
    if (session.player1.socketId === socketId || session.player2.socketId === socketId) {
      if (!session.isFinished) {
        const opponentKey = session.player1.socketId === socketId ? 'player2' : 'player1';
        endMatch(session, io, session[opponentKey].socketId, true);
      }
      break;
    }
  }
}

/**
 * End a match, update ratings, and clean up session.
 *
 * @param {object} session
 * @param {object} io
 * @param {string|null} winnerSocketId - null means score-based winner
 * @param {boolean} forfeit
 */
async function endMatch(session, io, winnerSocketId, forfeit = false) {
  if (session.isFinished) return;
  session.isFinished = true;
  clearTimeout(session.roundTimer);

  const p1 = session.player1;
  const p2 = session.player2;

  // Determine winner by socket or by score
  let winner, loser;
  if (winnerSocketId) {
    winner = p1.socketId === winnerSocketId ? p1 : p2;
    loser  = p1.socketId === winnerSocketId ? p2 : p1;
  } else if (p1.score > p2.score) {
    winner = p1; loser = p2;
  } else if (p2.score > p1.score) {
    winner = p2; loser = p1;
  } else {
    // Tie — no rating change in casual, slight positive for both in ranked
    winner = null;
  }

  let winnerDelta = 0, loserDelta = 0;
  let newWinnerRating = winner?.rating ?? p1.rating;
  let newLoserRating  = loser?.rating  ?? p2.rating;

  if (session.mode === 'ranked' && winner) {
    const elo = calculateElo(winner, loser);
    winnerDelta = elo.winnerDelta;
    loserDelta  = elo.loserDelta;
    newWinnerRating = elo.newWinnerRating;
    newLoserRating  = elo.newLoserRating;
  }

  // Persist results
  try {
    await transaction(async (client) => {
      // Update match record
      await client.query(
        `UPDATE matches
         SET winner_id=$1, score_p1=$2, score_p2=$3, rating_change=$4, forfeit=$5
         WHERE id=$6`,
        [winner?.userId ?? null, p1.score, p2.score, winnerDelta, forfeit, session.matchId]
      );

      if (session.mode === 'ranked' && winner) {
        const winnerRank = getRank(newWinnerRating);
        const loserRank  = getRank(newLoserRating);

        // Update winner
        await client.query(
          `UPDATE users
           SET rating=$1, rank_name=$2, wins=wins+1,
               win_streak=win_streak+1,
               best_streak=GREATEST(best_streak, win_streak+1)
           WHERE id=$3`,
          [newWinnerRating, winnerRank.name, winner.userId]
        );

        // Update loser
        await client.query(
          `UPDATE users
           SET rating=$1, rank_name=$2, losses=losses+1, win_streak=0
           WHERE id=$3`,
          [newLoserRating, loserRank.name, loser.userId]
        );
      } else if (session.mode === 'ranked' && !winner) {
        // Tie: increment wins for both, no rating change
        await client.query(
          'UPDATE users SET wins=wins+1 WHERE id=$1 OR id=$2',
          [p1.userId, p2.userId]
        );
      } else if (session.mode === 'casual' && winner) {
        await client.query('UPDATE users SET wins=wins+1 WHERE id=$1', [winner.userId]);
        await client.query('UPDATE users SET losses=losses+1 WHERE id=$1', [loser.userId]);
      }
    });
  } catch (err) {
    console.error('[Game] Failed to persist match results:', err.message);
  }

  // Build result payloads per perspective
  const buildResult = (self, opponent, selfDelta) => ({
    winner:   winner?.username ?? null,
    forfeit,
    scores:   { [p1.username]: p1.score, [p2.username]: p2.score },
    self: {
      username:    self.username,
      score:       self.score,
      ratingDelta: selfDelta,
      newRating:   self === winner ? newWinnerRating : (self === loser ? newLoserRating : self.rating),
      rank:        getRank(self === winner ? newWinnerRating : (self === loser ? newLoserRating : self.rating)),
    },
    opponent: {
      username: opponent.username,
      score:    opponent.score,
    },
  });

  const p1Delta = p1 === winner ? winnerDelta : (p1 === loser ? loserDelta : 0);
  const p2Delta = p2 === winner ? winnerDelta : (p2 === loser ? loserDelta : 0);

  io.to(p1.socketId).emit('match:end', buildResult(p1, p2, p1Delta));
  io.to(p2.socketId).emit('match:end', buildResult(p2, p1, p2Delta));

  console.log(`[Game] Match ended: ${session.roomId} | ${winner?.username ?? 'tie'} wins`);

  // Cleanup after brief delay
  setTimeout(() => sessions.delete(session.roomId), 10000);
}

/**
 * Get a session by room ID.
 * @param {string} roomId
 */
function getSession(roomId) {
  return sessions.get(roomId) || null;
}

/**
 * Get the room ID a socket is currently playing in.
 * @param {string} socketId
 * @returns {string|null}
 */
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
  getSession,
  getRoomForSocket,
};
