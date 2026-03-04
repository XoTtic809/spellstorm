/**
 * Database migration script.
 * Run with: node database/migrate.js
 */
require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { query } = require('./db');

async function migrate() {
  console.log('[Migrate] Running schema migration...');
  const schemaPath = path.join(__dirname, 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');

  // Split on semicolons and execute each statement
  const statements = sql
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0);

  for (const stmt of statements) {
    await query(stmt);
    console.log('[Migrate] OK:', stmt.slice(0, 60).replace(/\n/g, ' '));
  }

  console.log('[Migrate] Migration complete.');
  process.exit(0);
}

migrate().catch(err => {
  console.error('[Migrate] FAILED:', err.message);
  process.exit(1);
});
