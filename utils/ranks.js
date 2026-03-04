/**
 * Rank thresholds and utilities for SpellStorm.
 */

const RANKS = [
  { name: 'Bronze',   min: 0,    max: 999,  color: '#cd7f32', icon: '🥉' },
  { name: 'Silver',   min: 1000, max: 1199, color: '#c0c0c0', icon: '🥈' },
  { name: 'Gold',     min: 1200, max: 1399, color: '#ffd700', icon: '🥇' },
  { name: 'Platinum', min: 1400, max: 1599, color: '#00e5ff', icon: '💎' },
  { name: 'Diamond',  min: 1600, max: 1799, color: '#b39ddb', icon: '💠' },
  { name: 'Master',   min: 1800, max: Infinity, color: '#ff4081', icon: '👑' },
];

/**
 * Get rank info for a given rating.
 * @param {number} rating
 * @returns {{ name, min, max, color, icon, progress }}
 */
function getRank(rating) {
  const rank = RANKS.find(r => rating >= r.min && rating <= r.max) || RANKS[0];

  // Progress within rank (0–1), capped at Master
  let progress = 0;
  if (rank.max !== Infinity) {
    progress = (rating - rank.min) / (rank.max - rank.min + 1);
  } else {
    progress = Math.min((rating - rank.min) / 200, 1);
  }

  return { ...rank, progress: Math.min(1, Math.max(0, progress)) };
}

/**
 * Get the next rank info, or null if already Master.
 * @param {number} rating
 */
function getNextRank(rating) {
  const currentIndex = RANKS.findIndex(r => rating >= r.min && rating <= r.max);
  return RANKS[currentIndex + 1] || null;
}

module.exports = { RANKS, getRank, getNextRank };
