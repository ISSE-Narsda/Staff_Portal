// ============================================================
// ISSE LEAVE PORTAL — AUTHORIZATION HELPERS
// ============================================================

const crypto = require('crypto');
const { query } = require('./database');

const WORKFLOW_LEVELS = { none: 0, unit: 1, final: 2, full: 3 };
const SESSION_DURATION_DAYS = 7;

async function getUserAuthContext(userId) {
  if (!userId) return null;

  const rows = await query(
    `SELECT
       u.id            AS user_id,
       u.username,
       u.email,
       u.department,
       u.is_active,
       u.role_id,
       r.title         AS role_title,
       r.workflow_authority,
       r.scope,
       r.is_protected,
       COALESCE(
         ARRAY_AGG(rp.permission_key)
           FILTER (WHERE rp.permission_key IS NOT NULL),
         '{}'
       ) AS permissions
     FROM users u
     LEFT JOIN roles r ON r.id = u.role_id
     LEFT JOIN role_permissions rp ON rp.role_id = r.id
     WHERE u.id = $1
     GROUP BY u.id, r.id`,
    [userId]
  );

  if (!rows.length) return null;
  const row = rows[0];
  if (!row.role_id) return null;

  return {
    user: {
      id: row.user_id,
      username: row.username,
      email: row.email,
      department: row.department,
      is_active: row.is_active
    },
    role: {
      id: row.role_id,
      title: row.role_title,
      authority: row.workflow_authority,
      scope: row.scope,
      is_protected: row.is_protected
    },
    permissions: new Set(row.permissions || []),
    authority: row.workflow_authority,
    scope: row.scope
  };
}

async function hasPermission(userId, permissionKey) {
  const ctx = await getUserAuthContext(userId);
  if (!ctx) return false;
  if (ctx.authority === 'full') return true;
  return ctx.permissions.has(permissionKey);
}

async function hasWorkflowAuthority(userId, requiredLevel) {
  const ctx = await getUserAuthContext(userId);
  if (!ctx) return false;
  const userLevel = WORKFLOW_LEVELS[ctx.authority] ?? -1;
  const required = WORKFLOW_LEVELS[requiredLevel] ?? 999;
  return userLevel >= required;
}

async function getUserScope(userId) {
  const ctx = await getUserAuthContext(userId);
  if (!ctx) return null;
  return { scope: ctx.scope, department: ctx.user.department || null };
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

async function issueSession(userId) {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + SESSION_DURATION_DAYS * 24 * 60 * 60 * 1000);

  await query(
    `UPDATE users
     SET session_token = $1,
         session_expires_at = $2,
         is_active = 1,
         last_seen = NOW()
     WHERE id = $3`,
    [token, expiresAt, userId]
  );

  return { token, expiresAt };
}

async function getUserByToken(token) {
  if (!token || typeof token !== 'string' || token.length < 32) return null;

  const rows = await query(
    `SELECT id, username, email, role_id, department, is_active,
            session_expires_at
     FROM users
     WHERE session_token = $1`,
    [token]
  );

  if (!rows.length) return null;
  const user = rows[0];

  if (user.is_active === 0) return null;

  if (user.session_expires_at && new Date(user.session_expires_at) < new Date()) {
    await query(`UPDATE users SET session_token = NULL, session_expires_at = NULL WHERE id = $1`, [user.id]);
    return null;
  }

  return user;
}

async function revokeSession(userId) {
  await query(
    `UPDATE users SET session_token = NULL, session_expires_at = NULL, is_active = 0, last_seen = NOW() WHERE id = $1`,
    [userId]
  );
}

module.exports = {
  getUserAuthContext,
  hasPermission,
  hasWorkflowAuthority,
  getUserScope,
  generateToken,
  issueSession,
  getUserByToken,
  revokeSession,
  WORKFLOW_LEVELS,
  SESSION_DURATION_DAYS
};