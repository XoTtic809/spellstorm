# ⚡ SpellStorm

Competitive multiplayer spelling bee platform with ELO rankings, real-time 1v1 matches, anti-cheat protection, and a polished dark-theme UI.

---

## Features

- **Ranked Matchmaking** — ELO rating system with Bronze → Master ranks
- **Casual Mode** — Practice without affecting rating
- **Real-time 1v1 Matches** — Socket.io powered, 6-second round timer
- **Anti-Cheat** — Tab-switch detection with 3-strike forfeiture
- **Leaderboard** — Top 100 players by rating
- **Profiles** — Match history, win streaks, rank progress
- **JWT Auth** — Secure login with bcrypt password hashing
- **Rate Limiting** — Protects login/API endpoints

---

## Tech Stack

| Layer    | Technology |
|----------|-----------|
| Runtime  | Node.js 18+ |
| HTTP     | Express |
| WebSocket | Socket.io |
| Database | PostgreSQL |
| Auth     | JWT + bcrypt |
| Frontend | Vanilla HTML/CSS/JS |

---

## Project Structure

```
SpellStorm/
├── server/
│   ├── index.js          # Main server entry point
│   ├── auth.js           # JWT + bcrypt helpers & middleware
│   ├── matchmaking.js    # Queue & matching logic
│   ├── game.js           # Game session management
│   ├── anticheat.js      # Tab-switch detection & enforcement
│   └── routes/
│       ├── auth.js       # /api/auth/*
│       ├── leaderboard.js # /api/leaderboard
│       └── profile.js    # /api/profile/:username
├── client/
│   ├── index.html        # Single-page app shell
│   ├── css/style.css     # Dark glassmorphism theme
│   └── js/
│       ├── auth.js       # Auth state & API calls
│       ├── anticheat.js  # Tab-switch frontend detection
│       ├── game.js       # Socket.io game client
│       └── main.js       # UI controller & routing
├── database/
│   ├── schema.sql        # PostgreSQL schema
│   ├── db.js             # Connection pool
│   └── migrate.js        # Migration runner
├── utils/
│   ├── elo.js            # ELO calculation
│   ├── ranks.js          # Rank thresholds
│   └── words.js          # Word pool system
├── .env.example
├── package.json
└── README.md
```

---

## Local Development

### Prerequisites
- Node.js 18+
- PostgreSQL database

### Setup

```bash
# 1. Clone and install
git clone <repo>
cd spellstorm
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env with your database URL and JWT secret

# 3. Run database migration
npm run migrate

# 4. Start development server
npm run dev
```

Open `http://localhost:3000` in your browser.

---

## Railway Deployment

### One-Click Deploy

1. Push this repo to GitHub
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
3. Add a **PostgreSQL** plugin to your project
4. Set environment variables:

| Variable | Value |
|----------|-------|
| `JWT_SECRET` | A long random secret string |
| `NODE_ENV` | `production` |
| `DATABASE_URL` | Auto-set by Railway PostgreSQL plugin |

5. Railway auto-detects `npm start` from `package.json`
6. After deploy, run the migration:

```bash
# In Railway dashboard → your service → Shell
node database/migrate.js
```

### Environment Variables Reference

```env
PORT=3000                          # Auto-set by Railway
NODE_ENV=production
DATABASE_URL=postgresql://...      # Auto-set by Railway PostgreSQL plugin
JWT_SECRET=change-this-secret
ROUNDS_PER_MATCH=7                 # Rounds per match (default: 7)
ROUND_TIMER_MS=6000                # Round timer in ms (default: 6000)
MATCHMAKING_RANGE_BASE=150         # Initial rating range for matching
MATCHMAKING_RANGE_EXPAND=50        # Rating range expansion per 10s wait
```

---

## Game Rules

### Ranked Mode
- ELO-based rating system
- Win → gain rating (bonus for win streaks)
- Lose → lose rating
- Streaks give bonus rating up to +25/win

### Ranks

| Rank     | Rating Range |
|----------|-------------|
| Bronze   | 0 – 999     |
| Silver   | 1000 – 1199 |
| Gold     | 1200 – 1399 |
| Platinum | 1400 – 1599 |
| Diamond  | 1600 – 1799 |
| Master   | 1800+       |

### Anti-Cheat
1. **1st tab switch** → Warning popup
2. **2nd tab switch** → Lose current round automatically
3. **3rd tab switch** → Forfeit entire match

---

## API Reference

### Auth
- `POST /api/auth/register` — `{ username, password }`
- `POST /api/auth/login` — `{ username, password }`
- `GET  /api/auth/me` — Returns current user (requires JWT)

### Leaderboard
- `GET /api/leaderboard?limit=100&offset=0`

### Profile
- `GET /api/profile/:username`

### WebSocket Events

| Event (Client → Server) | Payload |
|------------------------|---------|
| `queue:join`           | `{ mode }` |
| `queue:leave`          | — |
| `game:submit`          | `{ roomId, answer }` |
| `game:tab_switch`      | `{ roomId }` |

| Event (Server → Client) | Payload |
|------------------------|---------|
| `match:found`          | Match info + player data |
| `round:start`          | Word, timer, scores |
| `round:correct`        | Winner, word, scores |
| `round:timeout`        | Word, scores |
| `match:end`            | Results + rating changes |
| `anticheat:warning`    | Warning count + message |
| `anticheat:lose_round` | Username |
| `anticheat:forfeit`    | Username + reason |
