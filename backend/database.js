// ============================================================
// ISSE LEAVE PORTAL — POSTGRES (SUPABASE) DATABASE LAYER
// ============================================================
// This replaces the SQLite version. It exposes the same
// db.run / db.get / db.all callback interface that server.js
// expects, but translated on top of the `pg` driver.
//
// Placeholders: server.js uses SQLite's "?" style. We auto-
// translate those to Postgres's "$1, $2, ..." style at query
// time, so no call site in server.js needs to change.
//
// Tables and seed data already exist in Supabase — this file
// does not create or seed anything.
// ============================================================

require('dotenv').config();
const { Pool, types } = require('pg');

// Postgres returns COUNT(*) and other BIGINT columns as strings by
// default, to avoid JS number precision loss on very large values.
// Our ID and count columns are small enough that this is not a
// concern, and SQLite returned them as numbers — so we force the
// same behaviour here to keep the frontend unchanged.
types.setTypeParser(types.builtins.INT8, (val) => parseInt(val, 10));

if (!process.env.DATABASE_URL) {
  console.error('❌ DATABASE_URL is not set. Check your .env file.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

pool.on('connect', () => {
  console.log('✅ Connected to Supabase Postgres');
});

pool.on('error', (err) => {
  console.error('❌ Unexpected Postgres pool error:', err.message);
});

// Translate SQLite-style "?" placeholders to Postgres "$1, $2, ..."
function toPgPlaceholders(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

// db.run — for INSERT / UPDATE / DELETE. Callback receives
// (err, { lastID, changes }) to mimic SQLite's "this" object.
// db.run — for INSERT / UPDATE / DELETE.
function run(sql, params, callback) {
  if (typeof params === 'function') {
    callback = params;
    params = [];
  }
  params = params || [];

  const pgSql = toPgPlaceholders(sql);
  const useReturning = /^\s*insert/i.test(sql) && !/returning/i.test(sql);
  const finalSql = useReturning ? `${pgSql} RETURNING id` : pgSql;

  pool.query(finalSql, params)
    .then(result => {
      const lastID = useReturning && result.rows[0] ? result.rows[0].id : null;
      const changes = result.rowCount || 0;
      if (typeof callback === 'function') callback.call({ lastID, changes }, null);
    })
    .catch(err => {
      console.error('DB run error:', err.message, '\nSQL:', pgSql);
      if (typeof callback === 'function') callback(err);
    });
}

// db.get — SELECT one row.
function get(sql, params, callback) {
  if (typeof params === 'function') {
    callback = params;
    params = [];
  }
  params = params || [];

  const pgSql = toPgPlaceholders(sql);
  pool.query(pgSql, params)
    .then(result => {
      if (typeof callback === 'function') callback(null, result.rows[0] || null);
    })
    .catch(err => {
      console.error('DB get error:', err.message, '\nSQL:', pgSql);
      if (typeof callback === 'function') callback(err);
    });
}

// db.all — SELECT multiple rows.
function all(sql, params, callback) {
  if (typeof params === 'function') {
    callback = params;
    params = [];
  }
  params = params || [];

  const pgSql = toPgPlaceholders(sql);
  pool.query(pgSql, params)
    .then(result => {
      if (typeof callback === 'function') callback(null, result.rows);
    })
    .catch(err => {
      console.error('DB all error:', err.message, '\nSQL:', pgSql);
      if (typeof callback === 'function') callback(err);
    });
}

// Direct pool access — available if any future code wants to
// use async/await directly instead of callbacks.
async function query(sql, params = []) {
  const pgSql = toPgPlaceholders(sql);
  const result = await pool.query(pgSql, params);
  return result.rows;
}

module.exports = { run, get, all, query, pool };