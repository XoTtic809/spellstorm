/**
 * ELO rating system for SpellStorm ranked matches.
 *
 * Base K-factor: 32
 * Win-streak bonus: +5 per consecutive win, capped at +25
 */

const K_FACTOR = 32;
const STREAK_BONUS_PER_WIN = 5;
const MAX_STREAK_BONUS = 25;

/**
 * Calculate expected win probability.
 * @param {number} ratingA - Player A rating
 * @param {number} ratingB - Player B rating
 * @returns {number} expected score for A (0–1)
 */
function expectedScore(ratingA, ratingB) {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}

/**
 * Calculate new ratings after a match.
 *
 * @param {object} winner - { rating, win_streak }
 * @param {object} loser  - { rating, win_streak }
 * @returns {{ winnerDelta: number, loserDelta: number, newWinnerRating: number, newLoserRating: number }}
 */
function calculateElo(winner, loser) {
  const expected = expectedScore(winner.rating, loser.rating);

  // Streak bonus for winner only
  const streakBonus = Math.min(winner.win_streak * STREAK_BONUS_PER_WIN, MAX_STREAK_BONUS);

  const winnerDelta = Math.round(K_FACTOR * (1 - expected) + streakBonus);
  const loserDelta  = Math.round(K_FACTOR * (0 - (1 - expected)));

  const newWinnerRating = Math.max(0, winner.rating + winnerDelta);
  const newLoserRating  = Math.max(0, loser.rating + loserDelta);

  return {
    winnerDelta,
    loserDelta,       // negative value
    newWinnerRating,
    newLoserRating,
    streakBonus,
  };
}

module.exports = { calculateElo, expectedScore };
