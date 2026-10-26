// ============================================================
// ISSE LEAVE PORTAL — AUTHORIZATION HELPERS
// ============================================================

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { query } = require('./database');

const WORKFLOW_LEVELS = { none: 0, unit: 1, final: 2, full: 3 };
const SESSION_DURATION_DAYS = 7;
const STAFF_SESSION_DURATION_HOURS = 12;
const BCRYPT_COST = 10;

// ------------------------------------------------------------
// PASSWORD HASHING (bcrypt)
// ------------------------------------------------------------
// bcrypt hashes always start with `$2a$`, `$2b$`, or `$2y$`.
// Anything else is treated as a LEGACY plain-text password and
// verified with a timing-safe comparison so nobody is locked out
// before backend/migrate-passwords.js is run on the server.

async function hashPassword(plain) {
  if (plain === null || plain === undefined || typeof plain !== 'string' || plain.length === 0) {
    throw new Error('hashPassword: plain password must be a non-empty string.');
  }
  return bcrypt.hash(plain, BCRYPT_COST);
}

async function verifyPassword(plain, stored) {
  // Never leak timing about which side is missing.
  if (plain === null || plain === undefined || typeof plain !== 'string') {
    return { ok: false, needsRehash: false };
  }
  if (stored === null || stored === undefined || typeof stored !== 'string' || stored.length === 0) {
    return { ok: false, needsRehash: false };
  }

  const looksHashed =
    stored.startsWith('$2a$') ||
    stored.startsWith('$2b$') ||
    stored.startsWith('$2y$');

  if (looksHashed) {
    try {
      const ok = await bcrypt.compare(plain, stored);
      return { ok: !!ok, needsRehash: false };
    } catch (_) {
      return { ok: false, needsRehash: false };
    }
  }

  // Legacy plain-text fallback.
  const a = Buffer.from(String(plain), 'utf8');
  const b = Buffer.from(String(stored), 'utf8');
  if (a.length !== b.length) {
    return { ok: false, needsRehash: false };
  }
  try {
    const ok = crypto.timingSafeEqual(a, b);
    // If the plain-text password matched, the next login should
    // transparently replace it with a bcrypt hash.
    return { ok, needsRehash: ok };
  } catch (_) {
    return { ok: false, needsRehash: false };
  }
}

// ------------------------------------------------------------
// ADMIN AUTH CONTEXT (unchanged from original)
// ------------------------------------------------------------

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

// ------------------------------------------------------------
// TOKEN GENERATION
// ------------------------------------------------------------

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// ------------------------------------------------------------
// ADMIN SESSIONS (unchanged)
// ------------------------------------------------------------

async function issueSession(userId) {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + SESSION_DURATION_DAYS * 24 * 60 * 60 * 1000);

  // Only write session state here. `is_active` is the account-enabled
  // flag and must never be flipped by a login — a Super Admin who has
  // deactivated an account expects it to stay deactivated even if that
  // account somehow obtains credentials.
  await query(
    `UPDATE users
     SET session_token = $1,
         session_expires_at = $2,
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

  if (user.is_active === 0 || user.is_active === false) return null;

  if (user.session_expires_at && new Date(user.session_expires_at) < new Date()) {
    await query(`UPDATE users SET session_token = NULL, session_expires_at = NULL WHERE id = $1`, [user.id]);
    return null;
  }

  return user;
}

async function revokeSession(userId) {
  // Logging out clears session state only. `is_active` is the
  // account-enabled flag and must stay untouched — otherwise
  // every logout would permanently disable the account and, with
  // the login guard, lock the user out of their own account.
  await query(
    `UPDATE users SET session_token = NULL, session_expires_at = NULL, last_seen = NOW() WHERE id = $1`,
    [userId]
  );
}

// ------------------------------------------------------------
// STAFF SESSIONS (new — part 1 of 8)
// ------------------------------------------------------------
// Staff sessions live in staff_profiles.session_token / session_expires_at
// (the columns are created by the SQL in §4 of the plan). Duration is
// deliberately shorter than an admin session (12h vs 7 days) because
// staff use the portal far less often.
//
// The returned staff object NEVER contains `password`, `session_token`
// or `session_expires_at` — those are stripped before every response.

async function issueStaffSession(staffId) {
  if (!staffId) throw new Error('issueStaffSession: staffId is required.');

  const token = generateToken();
  const expiresAt = new Date(Date.now() + STAFF_SESSION_DURATION_HOURS * 60 * 60 * 1000);

  await query(
    `UPDATE staff_profiles
     SET session_token = $1,
         session_expires_at = $2
     WHERE id = $3`,
    [token, expiresAt, staffId]
  );

  return { token, expiresAt };
}

async function getStaffByToken(token) {
  if (!token || typeof token !== 'string' || token.length < 32) return null;

  const rows = await query(
    `SELECT id, isse_file_no, full_name, department, designation,
            grade_level, official_email, gender,
            last_promotion_date, next_promotion_date,
            session_expires_at
     FROM staff_profiles
     WHERE session_token = $1`,
    [token]
  );

  if (!rows.length) return null;
  const staff = rows[0];

  if (staff.session_expires_at && new Date(staff.session_expires_at) < new Date()) {
    await query(
      `UPDATE staff_profiles SET session_token = NULL, session_expires_at = NULL WHERE id = $1`,
      [staff.id]
    );
    return null;
  }

  // Strip the session metadata before returning — callers only
  // need identity fields.
  const { session_expires_at, ...safe } = staff;
  return safe;
}

async function revokeStaffSession(staffId) {
  if (!staffId) return;
  await query(
    `UPDATE staff_profiles SET session_token = NULL, session_expires_at = NULL WHERE id = $1`,
    [staffId]
  );
}

module.exports = {
  // Admin (existing)
  getUserAuthContext,
  hasPermission,
  hasWorkflowAuthority,
  getUserScope,
  generateToken,
  issueSession,
  getUserByToken,
  revokeSession,
  // Password (new — Part 1 of 8)
  hashPassword,
  verifyPassword,
  // Staff sessions (new — Part 1 of 8)
  issueStaffSession,
  getStaffByToken,
  revokeStaffSession,
  // Constants
  WORKFLOW_LEVELS,
  SESSION_DURATION_DAYS,
  STAFF_SESSION_DURATION_HOURS
};