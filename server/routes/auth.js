/**
 * Authentication routes: /api/auth/*
 */
const express     = require('express');
const rateLimit   = require('express-rate-limit');
const { query }   = require('../../database/db');
const { hashPassword, verifyPassword, signToken, requireAuth } = require('../auth');
const { getRank } = require('../../utils/ranks');
const logger      = require('../../utils/logger');

const router = express.Router();

// Sanitize string input: strip HTML, trim, limit length
function sanitize(str, maxLen = 100) {
  if (typeof str !== 'string') return '';
  return str.replace(/[<>"'`]/g, '').trim().slice(0, maxLen);
}

// Rate-limit login attempts: max 10 per 15 minutes per IP
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again in 15 minutes.' },
});

// Rate-limit register: max 5 per hour per IP
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many accounts created. Try again in an hour.' },
});

// Validate username: 3–20 alphanumeric/underscore chars
function isValidUsername(username) {
  return /^[a-zA-Z0-9_]{3,20}$/.test(username);
}

// Validate password: min 8 chars
function isValidPassword(password) {
  return typeof password === 'string' && password.length >= 8;
}

/**
 * POST /api/auth/register
 */
router.post('/register', registerLimiter, async (req, res) => {
  try {
    const username = sanitize(req.body?.username, 20);
    const password = typeof req.body?.password === 'string' ? req.body.password : '';

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required.' });
    }
    if (!isValidUsername(username)) {
      return res.status(400).json({ error: 'Username must be 3–20 alphanumeric characters or underscores.' });
    }
    if (!isValidPassword(password)) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }

    // Check if username already taken
    const existing = await query('SELECT id FROM users WHERE username=$1', [username]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Username already taken.' });
    }

    const hashed = await hashPassword(password);
    const result = await query(
      `INSERT INTO users (username, password, rating, rank_name)
       VALUES ($1, $2, 1000, 'Silver') RETURNING id, username, rating, rank_name, wins, losses`,
      [username, hashed]
    );

    const user  = result.rows[0];
    const token = signToken({ id: user.id, username: user.username });

    res.status(201).json({
      token,
      user: {
        id:       user.id,
        username: user.username,
        rating:   user.rating,
        rank:     getRank(user.rating),
        wins:     user.wins,
        losses:   user.losses,
      },
    });
  } catch (err) {
    console.error('[Auth] Register error:', err.message);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

/**
 * POST /api/auth/login
 */
router.post('/login', loginLimiter, async (req, res) => {
  try {
    const username = sanitize(req.body?.username, 20);
    const password = typeof req.body?.password === 'string' ? req.body.password : '';

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required.' });
    }

    const result = await query(
      'SELECT id, username, password, rating, rank_name, wins, losses, win_streak, best_streak FROM users WHERE username=$1',
      [username]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    const user = result.rows[0];
    const valid = await verifyPassword(password, user.password);

    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    const token = signToken({ id: user.id, username: user.username });

    res.json({
      token,
      user: {
        id:         user.id,
        username:   user.username,
        rating:     user.rating,
        rank:       getRank(user.rating),
        wins:       user.wins,
        losses:     user.losses,
        winStreak:  user.win_streak,
        bestStreak: user.best_streak,
      },
    });
  } catch (err) {
    console.error('[Auth] Login error:', err.message);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

/**
 * GET /api/auth/me — return current user profile
 */
router.get('/me', requireAuth, async (req, res) => {
  try {
    const result = await query(
      'SELECT id, username, rating, rank_name, wins, losses, win_streak, best_streak, created_at FROM users WHERE id=$1',
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }

    const user = result.rows[0];
    res.json({
      id:         user.id,
      username:   user.username,
      rating:     user.rating,
      rank:       getRank(user.rating),
      wins:       user.wins,
      losses:     user.losses,
      winStreak:  user.win_streak,
      bestStreak: user.best_streak,
      createdAt:  user.created_at,
    });
  } catch (err) {
    console.error('[Auth] Me error:', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

module.exports = router;
