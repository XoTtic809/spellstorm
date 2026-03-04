/**
 * Matchmaking queue for SpellStorm.
 *
 * Matches players within a rating range that expands over time.
 * Supports 'ranked' and 'casual' queues separately.
 */

const { v4: uuidv4 } = require('uuid');

// Queue: Map<socketId, QueueEntry>
const queues = {
  ranked: new Map(),
  casual: new Map(),
};

const BASE_RANGE      = parseInt(process.env.MATCHMAKING_RANGE_BASE     || '150');
const EXPAND_PER_TICK = parseInt(process.env.MATCHMAKING_RANGE_EXPAND   || '50');
const EXPAND_INTERVAL = parseInt(process.env.MATCHMAKING_EXPAND_INTERVAL_MS || '10000');

/**
 * Add a player to the matchmaking queue.
 *
 * @param {string} socketId
 * @param {object} user   - { id, username, rating }
 * @param {string} mode   - 'ranked' | 'casual'
 */
function enqueue(socketId, user, mode) {
  const queue = queues[mode];
  if (!queue) return;

  queue.set(socketId, {
    socketId,
    userId:    user.id,
    username:  user.username,
    rating:    user.rating,
    mode,
    joinedAt:  Date.now(),
  });

  console.log(`[MM] ${user.username} (${user.rating}) queued for ${mode}. Queue size: ${queue.size}`);
}

/**
 * Remove a player from all queues (on disconnect or cancel).
 * @param {string} socketId
 */
function dequeue(socketId) {
  for (const queue of Object.values(queues)) {
    queue.delete(socketId);
  }
}

/**
 * Attempt to find a match for every queued player.
 * Called on a periodic tick.
 *
 * @returns {Array<{ player1: QueueEntry, player2: QueueEntry, roomId: string, mode: string }>}
 */
function findMatches() {
  const matches = [];

  for (const [mode, queue] of Object.entries(queues)) {
    const players = Array.from(queue.values());

    // Sort by wait time so longest-waiting players get priority
    players.sort((a, b) => a.joinedAt - b.joinedAt);

    const matched = new Set();

    for (let i = 0; i < players.length; i++) {
      if (matched.has(players[i].socketId)) continue;

      const p1 = players[i];
      const waitSecs = (Date.now() - p1.joinedAt) / 1000;
      const range    = BASE_RANGE + Math.floor(waitSecs / (EXPAND_INTERVAL / 1000)) * EXPAND_PER_TICK;

      // For casual mode, allow any rating
      const effectiveRange = mode === 'casual' ? Infinity : range;

      for (let j = i + 1; j < players.length; j++) {
        if (matched.has(players[j].socketId)) continue;

        const p2 = players[j];
        const ratingDiff = Math.abs(p1.rating - p2.rating);

        if (ratingDiff <= effectiveRange) {
          matched.add(p1.socketId);
          matched.add(p2.socketId);

          queue.delete(p1.socketId);
          queue.delete(p2.socketId);

          matches.push({
            player1: p1,
            player2: p2,
            roomId:  uuidv4(),
            mode,
          });

          console.log(
            `[MM] Match found: ${p1.username}(${p1.rating}) vs ${p2.username}(${p2.rating}) | ${mode} | diff:${ratingDiff}`
          );
          break;
        }
      }
    }
  }

  return matches;
}

/**
 * Get queue position for a socket.
 * @param {string} socketId
 * @param {string} mode
 * @returns {number} 1-based position, or -1 if not in queue
 */
function getQueuePosition(socketId, mode) {
  const queue = queues[mode];
  if (!queue) return -1;

  const players = Array.from(queue.values()).sort((a, b) => a.joinedAt - b.joinedAt);
  const idx = players.findIndex(p => p.socketId === socketId);
  return idx === -1 ? -1 : idx + 1;
}

/**
 * Get total queue sizes.
 * @returns {{ ranked: number, casual: number }}
 */
function getQueueSizes() {
  return {
    ranked: queues.ranked.size,
    casual: queues.casual.size,
  };
}

module.exports = { enqueue, dequeue, findMatches, getQueuePosition, getQueueSizes };
