/**
 * Profile routes: /api/profile/*
 */
const express     = require('express');
const { query }   = require('../../database/db');
const { getRank } = require('../../utils/ranks');
const { requireAuth } = require('../auth');

const router = express.Router();

/**
 * GET /api/profile/:username — public profile
 */
router.get('/:username', async (req, res) => {
  try {
    const { username } = req.params;

    const userResult = await query(
      `SELECT id, username, rating, rank_name, wins, losses, win_streak, best_streak, created_at
       FROM users WHERE username=$1`,
      [username]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }

    const user = userResult.rows[0];

    // Fetch last 10 ranked matches
    const matchResult = await query(
      `SELECT m.id, m.mode, m.score_p1, m.score_p2, m.rating_change, m.forfeit,
              m.played_at, m.winner_id, m.player1_id, m.player2_id,
              u1.username AS player1, u2.username AS player2
       FROM matches m
       JOIN users u1 ON u1.id = m.player1_id
       JOIN users u2 ON u2.id = m.player2_id
       WHERE m.player1_id=$1 OR m.player2_id=$1
       ORDER BY m.played_at DESC
       LIMIT 10`,
      [user.id]
    );

    const recentMatches = matchResult.rows.map(m => {
      const isP1    = m.player1_id === user.id;
      const myScore = isP1 ? m.score_p1 : m.score_p2;
      const opScore = isP1 ? m.score_p2 : m.score_p1;
      const won     = m.winner_id === user.id;
      return {
        id:            m.id,
        mode:          m.mode,
        opponent:      isP1 ? m.player2 : m.player1,
        myScore,
        opponentScore: opScore,
        won,
        ratingChange:  won ? m.rating_change : -m.rating_change,
        forfeit:       m.forfeit,
        playedAt:      m.played_at,
      };
    });

    res.json({
      id:           user.id,
      username:     user.username,
      rating:       user.rating,
      rank:         getRank(user.rating),
      wins:         user.wins,
      losses:       user.losses,
      winRatio:     user.wins + user.losses > 0
                      ? ((user.wins / (user.wins + user.losses)) * 100).toFixed(1)
                      : '0.0',
      winStreak:    user.win_streak,
      bestStreak:   user.best_streak,
      createdAt:    user.created_at,
      recentMatches,
    });
  } catch (err) {
    console.error('[Profile] Error:', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

module.exports = router;
