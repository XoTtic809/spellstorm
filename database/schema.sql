-- SpellStorm Database Schema
-- Run this to initialize the database

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id          SERIAL PRIMARY KEY,
  username    VARCHAR(32) UNIQUE NOT NULL,
  password    TEXT NOT NULL,
  rating      INTEGER NOT NULL DEFAULT 1000,
  rank_name   VARCHAR(20) NOT NULL DEFAULT 'Bronze',
  wins        INTEGER NOT NULL DEFAULT 0,
  losses      INTEGER NOT NULL DEFAULT 0,
  win_streak  INTEGER NOT NULL DEFAULT 0,
  best_streak INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Match history table
CREATE TABLE IF NOT EXISTS matches (
  id            SERIAL PRIMARY KEY,
  player1_id    INTEGER REFERENCES users(id),
  player2_id    INTEGER REFERENCES users(id),
  winner_id     INTEGER REFERENCES users(id),
  mode          VARCHAR(16) NOT NULL DEFAULT 'ranked',
  score_p1      INTEGER NOT NULL DEFAULT 0,
  score_p2      INTEGER NOT NULL DEFAULT 0,
  rating_change INTEGER NOT NULL DEFAULT 0,
  rounds        INTEGER NOT NULL DEFAULT 7,
  forfeit       BOOLEAN NOT NULL DEFAULT FALSE,
  played_at     TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Anti-cheat warnings per match (persisted for audit)
CREATE TABLE IF NOT EXISTS anticheat_warnings (
  id         SERIAL PRIMARY KEY,
  match_id   INTEGER REFERENCES matches(id),
  user_id    INTEGER REFERENCES users(id),
  reason     VARCHAR(64) NOT NULL,
  logged_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_users_rating ON users(rating DESC);
CREATE INDEX IF NOT EXISTS idx_matches_player1 ON matches(player1_id);
CREATE INDEX IF NOT EXISTS idx_matches_player2 ON matches(player2_id);
CREATE INDEX IF NOT EXISTS idx_matches_played_at ON matches(played_at DESC);
