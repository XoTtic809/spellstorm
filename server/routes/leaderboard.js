/**
 * Leaderboard routes: /api/leaderboard
 */
const express   = require('express');
const { query } = require('../../database/db');
const { getRank } = require('../../utils/ranks');

const router = express.Router();

/**
 * GET /api/leaderboard?limit=100&offset=0
 */
router.get('/', async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit  || '100'), 100);
    const offset = parseInt(req.query.offset || '0');

    const result = await query(
      `SELECT id, username, rating, rank_name, wins, losses, win_streak, best_streak
       FROM users
       ORDER BY rating DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    const players = result.rows.map((u, i) => ({
      position:   offset + i + 1,
      id:         u.id,
      username:   u.username,
      rating:     u.rating,
      rank:       getRank(u.rating),
      wins:       u.wins,
      losses:     u.losses,
      winRatio:   u.wins + u.losses > 0
                    ? ((u.wins / (u.wins + u.losses)) * 100).toFixed(1)
                    : '0.0',
      winStreak:  u.win_streak,
      bestStreak: u.best_streak,
    }));

    const totalResult = await query('SELECT COUNT(*) FROM users');
    const total = parseInt(totalResult.rows[0].count);

    res.json({ players, total, limit, offset });
  } catch (err) {
    console.error('[Leaderboard] Error:', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

module.exports = router;
