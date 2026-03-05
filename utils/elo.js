/**
 * SpellStorm — ELO Rating System (Upgraded)
 *
 * Formula: standard ELO with dynamic K-factor based on rating bracket.
 * Higher-rated players have lower K (more stable ratings).
 * Win-streak bonus rewards consistency.
 * Forfeit penalty reduces winnerDelta to discourage farming via disconnects.
 */

const STREAK_BONUS_PER_WIN = 5;
const MAX_STREAK_BONUS     = 25;

/**
 * Dynamic K-factor: new/lower-rated players gain/lose more per match.
 * @param {number} rating
 */
function kFactor(rating) {
  if (rating < 1000) return 40;
  if (rating < 1400) return 32;
  if (rating < 1800) return 24;
  return 20;
}

/**
 * Expected win probability for player A vs player B.
 */
function expectedScore(ratingA, ratingB) {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}

/**
 * Calculate ELO deltas after a match.
 *
 * @param {object} winner       - { rating, win_streak }
 * @param {object} loser        - { rating, win_streak }
 * @param {boolean} [forfeit]   - true if loser forfeited/disconnected
 * @returns {{ winnerDelta, loserDelta, newWinnerRating, newLoserRating, streakBonus }}
 */
function calculateElo(winner, loser, forfeit = false) {
  const expected = expectedScore(winner.rating, loser.rating);
  const K_winner = kFactor(winner.rating);
  const K_loser  = kFactor(loser.rating);

  // Streak bonus (winner only)
  const streakBonus = Math.min((winner.win_streak || 0) * STREAK_BONUS_PER_WIN, MAX_STREAK_BONUS);

  // Base rating change
  let winnerDelta = Math.round(K_winner * (1 - expected) + streakBonus);
  let loserDelta  = Math.round(K_loser  * (0 - (1 - expected)));

  // Forfeit dampening: winner earns less when opponent disconnected
  // (reduces incentive to grief opponents into disconnecting)
  if (forfeit) {
    winnerDelta = Math.round(winnerDelta * 0.5);
  }

  // Ratings floor at 0
  const newWinnerRating = Math.max(0, winner.rating + winnerDelta);
  const newLoserRating  = Math.max(0, loser.rating  + loserDelta);

  return { winnerDelta, loserDelta, newWinnerRating, newLoserRating, streakBonus };
}

module.exports = { calculateElo, expectedScore, kFactor };
