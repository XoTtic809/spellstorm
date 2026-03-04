const { Pool } = require('pg');

// Railway injects DATABASE_URL automatically
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on('error', (err) => {
  console.error('[DB] Unexpected pool error:', err.message);
});

/**
 * Execute a parameterized query.
 * @param {string} text - SQL query
 * @param {Array}  params - Query parameters
 */
async function query(text, params) {
  const start = Date.now();
  try {
    const result = await pool.query(text, params);
    const duration = Date.now() - start;
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[DB] query (${duration}ms): ${text.slice(0, 80)}`);
    }
    return result;
  } catch (err) {
    console.error('[DB] Query error:', err.message, '\nQuery:', text);
    throw err;
  }
}

/**
 * Get a client from the pool for transactions.
 */
async function getClient() {
  return pool.connect();
}

/**
 * Run a function inside a transaction; rolls back on error.
 * @param {Function} fn - async fn(client) => result
 */
async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { query, getClient, transaction };
