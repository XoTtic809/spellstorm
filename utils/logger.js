/**
 * SpellStorm — Structured Logger
 *
 * JSON-formatted logs with levels and context.
 * Never logs passwords, tokens, or raw DB connection strings.
 */

const LEVELS     = { debug: 0, info: 1, warn: 2, error: 3 };
const LOG_LEVEL  = LEVELS[process.env.LOG_LEVEL] ?? (process.env.NODE_ENV === 'production' ? LEVELS.info : LEVELS.debug);

// Fields that must never appear in logs
const SENSITIVE = new Set(['password', 'token', 'jwt', 'secret', 'DATABASE_URL', 'connectionString']);

function scrub(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const safe = {};
  for (const [k, v] of Object.entries(obj)) {
    safe[k] = SENSITIVE.has(k) ? '[REDACTED]' : v;
  }
  return safe;
}

function log(level, ctx, message, meta = {}) {
  if (LEVELS[level] < LOG_LEVEL) return;

  const entry = {
    ts:    new Date().toISOString(),
    level,
    ctx,
    msg:   message,
    ...scrub(meta),
  };

  const line = JSON.stringify(entry);
  if (level === 'error') process.stderr.write(line + '\n');
  else                   process.stdout.write(line + '\n');
}

const logger = {
  debug: (ctx, msg, meta) => log('debug', ctx, msg, meta),
  info:  (ctx, msg, msg2) => log('info',  ctx, msg, msg2),
  warn:  (ctx, msg, meta) => log('warn',  ctx, msg, meta),
  error: (ctx, msg, meta) => log('error', ctx, msg, meta),

  // Convenience: log match events with consistent shape
  match: (event, data) => log('info', 'match', event, data),
  ac:    (event, data) => log('warn', 'anticheat', event, data),
};

module.exports = logger;
