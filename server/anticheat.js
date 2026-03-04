/**
 * Anti-cheat module for SpellStorm.
 *
 * Tracks tab-switch warnings per active match session.
 * Rules:
 *   1st switch → warning popup sent to player
 *   2nd switch → auto-lose current round
 *   3rd switch → auto-forfeit entire match
 */

const { query } = require('../database/db');

const WARNING_THRESHOLDS = {
  WARN:    1,
  LOSE_ROUND: 2,
  FORFEIT: 3,
};

/**
 * Process a tab-switch event for a player in a game session.
 *
 * @param {object} gameSession - Active game session object (mutated)
 * @param {string} socketId    - Socket ID of the offending player
 * @param {object} io          - Socket.io server instance
 * @returns {{ action: 'warn' | 'lose_round' | 'forfeit', warnings: number }}
 */
function processTabSwitch(gameSession, socketId, io) {
  const playerKey = gameSession.player1.socketId === socketId ? 'player1' : 'player2';
  const player    = gameSession[playerKey];

  player.warnings = (player.warnings || 0) + 1;
  const warnings  = player.warnings;

  let action;

  if (warnings >= WARNING_THRESHOLDS.FORFEIT) {
    action = 'forfeit';
    io.to(gameSession.roomId).emit('anticheat:forfeit', {
      username: player.username,
      reason:   'Tab switched 3 times — auto forfeit',
    });
  } else if (warnings >= WARNING_THRESHOLDS.LOSE_ROUND) {
    action = 'lose_round';
    io.to(gameSession.roomId).emit('anticheat:lose_round', {
      username: player.username,
      warnings,
    });
  } else {
    action = 'warn';
    // Only the offending player sees the popup
    io.to(socketId).emit('anticheat:warning', {
      warnings,
      maxWarnings: WARNING_THRESHOLDS.FORFEIT,
      message: 'Warning: switching tabs is not allowed! Next time you will lose the round.',
    });
  }

  return { action, warnings };
}

/**
 * Persist a warning to the database (called after match is created/found).
 * Fire-and-forget; errors are logged but not thrown.
 *
 * @param {number} matchId
 * @param {number} userId
 * @param {string} reason
 */
async function logWarning(matchId, userId, reason) {
  try {
    await query(
      'INSERT INTO anticheat_warnings (match_id, user_id, reason) VALUES ($1, $2, $3)',
      [matchId, userId, reason]
    );
  } catch (err) {
    console.error('[AntiCheat] Failed to log warning:', err.message);
  }
}

module.exports = { processTabSwitch, logWarning, WARNING_THRESHOLDS };
