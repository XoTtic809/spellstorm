/**
 * SpellStorm — Advanced Anti-Cheat Module
 *
 * Tab-switch rules:
 *   1st switch          → warning popup
 *   2nd switch          → auto-lose current round
 *   3rd switch          → auto-forfeit match
 *   2 switches < 3s     → treated as 2nd immediately (rapid exploit block)
 *
 * All events are logged with timestamps and persisted to the DB.
 */

const { query } = require('../database/db');
const logger    = require('../utils/logger');

const WARNING_THRESHOLDS = {
  WARN:       1,
  LOSE_ROUND: 2,
  FORFEIT:    3,
};

const RAPID_SWITCH_WINDOW_MS = 3000; // two switches within this → instant round loss

/**
 * Process a tab-switch event for a player.
 *
 * @param {object} gameSession
 * @param {string} socketId
 * @param {object} io
 * @returns {{ action: 'warn'|'lose_round'|'forfeit', warnings: number }}
 */
function processTabSwitch(gameSession, socketId, io) {
  const playerKey = gameSession.player1.socketId === socketId ? 'player1' : 'player2';
  const player    = gameSession[playerKey];
  const now       = Date.now();

  // Rapid-switch detection: two events within RAPID_SWITCH_WINDOW_MS
  const timeSinceLast = player.lastTabSwitch ? now - player.lastTabSwitch : Infinity;
  player.lastTabSwitch = now;

  if (timeSinceLast < RAPID_SWITCH_WINDOW_MS && player.warnings < WARNING_THRESHOLDS.FORFEIT) {
    // Force to at least the lose_round threshold immediately
    player.warnings = Math.max(player.warnings + 1, WARNING_THRESHOLDS.LOSE_ROUND);
    logger.ac('rapid_tab_switch', {
      user:    player.username,
      room:    gameSession.roomId,
      gapMs:   timeSinceLast,
      warnings: player.warnings,
    });
  } else {
    player.warnings = Math.min((player.warnings || 0) + 1, WARNING_THRESHOLDS.FORFEIT);
  }

  const warnings = player.warnings;

  logger.ac('tab_switch', {
    user:     player.username,
    room:     gameSession.roomId,
    warnings,
    rapid:    timeSinceLast < RAPID_SWITCH_WINDOW_MS,
  });

  let action;

  if (warnings >= WARNING_THRESHOLDS.FORFEIT) {
    action = 'forfeit';
    io.to(gameSession.roomId).emit('anticheat:forfeit', {
      username: player.username,
      reason:   'Tab switched 3 times — match forfeited',
    });
  } else if (warnings >= WARNING_THRESHOLDS.LOSE_ROUND) {
    action = 'lose_round';
    io.to(gameSession.roomId).emit('anticheat:lose_round', {
      username: player.username,
      warnings,
      maxWarnings: WARNING_THRESHOLDS.FORFEIT,
    });
  } else {
    action = 'warn';
    io.to(socketId).emit('anticheat:warning', {
      warnings,
      maxWarnings: WARNING_THRESHOLDS.FORFEIT,
      message: 'Warning 1/3: Do not switch tabs during a match! Next offense = round loss.',
    });
  }

  return { action, warnings };
}

/**
 * Persist a warning to the DB (fire-and-forget).
 */
async function logWarning(matchId, userId, reason) {
  try {
    await query(
      'INSERT INTO anticheat_warnings (match_id, user_id, reason) VALUES ($1, $2, $3)',
      [matchId, userId, reason]
    );
  } catch (err) {
    logger.error('anticheat', 'Failed to persist warning', { err: err.message });
  }
}

module.exports = { processTabSwitch, logWarning, WARNING_THRESHOLDS };
