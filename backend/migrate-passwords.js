// ============================================================
// ISSE LEAVE PORTAL — ONE-OFF PLAIN-TEXT → BCRYPT MIGRATION
// ============================================================
// Run once after deploying the new auth.js + server.js + package.json.
// It is SAFE to run again: rows whose password already starts with
// `$2` (i.e. already hashed) are skipped by the WHERE clause.
//
// Prints ONLY counts — never a password, never a hash.
//
// Usage (from the backend/ folder on the VPS):
//     node migrate-passwords.js
//
// Requires DATABASE_URL in .env (same value the running server uses).
// ============================================================

require('dotenv').config();
const bcrypt = require('bcryptjs');
const { pool } = require('./database');

const BCRYPT_COST = 10;

// Only these two tables are hashed. Both names are hardcoded in
// migrateTable() and never come from user input, so string-interpolating
// them into the SQL is safe.
const TABLES = ['users', 'staff_profiles'];

async function migrateTable(tableName) {
  // Pre-count so we can log progress.
  const countRes = await pool.query(
    `SELECT COUNT(*)::int AS count
       FROM ${tableName}
      WHERE password IS NOT NULL
        AND password <> ''
        AND password NOT LIKE '$2%'`
  );
  const total = countRes.rows[0] ? countRes.rows[0].count : 0;

  if (total === 0) {
    console.log(`[${tableName}] no plain-text passwords — nothing to do.`);
    return { total: 0, migrated: 0, failed: 0 };
  }

  console.log(
    `[${tableName}] found ${total} plain-text password(s). Hashing with bcrypt (cost ${BCRYPT_COST})...`
  );

  const sel = await pool.query(
    `SELECT id, password
       FROM ${tableName}
      WHERE password IS NOT NULL
        AND password <> ''
        AND password NOT LIKE '$2%'`
  );

  let migrated = 0;
  let failed = 0;

  for (const row of sel.rows) {
    try {
      const hash = await bcrypt.hash(String(row.password), BCRYPT_COST);
      await pool.query(`UPDATE ${tableName} SET password = $1 WHERE id = $2`, [hash, row.id]);
      migrated++;

      if (migrated % 10 === 0) {
        console.log(`[${tableName}] ${migrated}/${total} hashed...`);
      }
    } catch (err) {
      failed++;
      console.error(`[${tableName}] row id ${row.id} failed: ${err.message}`);
    }
  }

  console.log(`[${tableName}] done. migrated=${migrated}, failed=${failed}, total=${total}`);
  return { total, migrated, failed };
}

async function main() {
  console.log('ISSE Leave Portal — password migration starting.');

  if (!process.env.DATABASE_URL) {
    console.error('ERROR: DATABASE_URL is not set. Check backend/.env.');
    process.exit(1);
  }

  try {
    const results = {};
    for (const tableName of TABLES) {
      results[tableName] = await migrateTable(tableName);
    }

    console.log('---');
    for (const tableName of TABLES) {
      const r = results[tableName];
      console.log(
        `${tableName.padEnd(16)} total=${r.total}  migrated=${r.migrated}  failed=${r.failed}`
      );
    }
    console.log('---');
    console.log('Password migration complete.');
  } catch (err) {
    console.error('Fatal error:', err.message);
    process.exitCode = 1;
  } finally {
    try {
      await pool.end();
    } catch (_) {
      // Ignore shutdown noise — the process is exiting anyway.
    }
  }
}

main();