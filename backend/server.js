const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./database');
const auth = require('./auth');
const multer = require('multer');
const bcrypt = require('bcryptjs');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 } // 5 MB
});
const {
  issueSession,
  getUserByToken,
  revokeSession,
  getUserAuthContext,
  hashPassword,
  verifyPassword,
  issueStaffSession,
  getStaffByToken,
  revokeStaffSession
} = auth;

const app = express();
app.use(cors());
app.use(express.json());

// ============================================================
// STATIC-FILE HARDENING (Bug B5)
// ============================================================
// Block accidental exposure of backend source, database files,
// .env files, dependency folders and version control metadata.
// Runs BEFORE express.static so nothing sensitive can be served.
const BLOCKED_PATH_RE = /(^|\/)(backend|node_modules|\.git)(\/|$)/i;
const BLOCKED_EXT_RE = /\.(db|sqlite|sqlite3|sqlite-backup|env|log|sql|md)$/i;
const BLOCKED_EXACT = new Set([
  '/package.json',
  '/package-lock.json'
]);

app.use((req, res, next) => {
  let raw = req.path || '';
  let decoded;
  try {
    decoded = decodeURIComponent(raw);
  } catch (_) {
    return res.status(404).send('Not found');
  }
  const lower = decoded.toLowerCase();

  if (BLOCKED_EXACT.has(lower)) return res.status(404).send('Not found');
  if (BLOCKED_PATH_RE.test(decoded)) return res.status(404).send('Not found');
  if (BLOCKED_EXT_RE.test(decoded)) return res.status(404).send('Not found');

  // Reject any path segment that begins with a dot (dotfiles).
  const segments = decoded.split('/');
  for (let i = 0; i < segments.length; i++) {
    if (segments[i] && segments[i].charAt(0) === '.') {
      return res.status(404).send('Not found');
    }
  }

  next();
});

app.use(express.static(path.join(__dirname, '..'), {
  dotfiles: 'deny',
  index: ['index.html']
}));

// ============================================================
// WORKING-DAY CONFIGURATION
// ============================================================

const LEAVE_DAYS_MAP = {
  'Annual Leave (30 Working Days)': 30,
  'Casual Leave (5-7 Days)': 7,
  'Sick Leave (Up to 42 Days)': 42,
  'Maternity Leave (16 Weeks)': 112,
  'Paternity Leave (14 Working Days)': 14,
  'Study Leave': 30,
  'Pre-retirement Leave (3 Months)': 90,
  'Sabbatical Leave (1 Year)': 365
};

// Canonical list of leave types shown in the staff-portal dropdown.
// These are the exact `data-leave-type` values from index.html.
// The Super Admin can hide any of these via System Settings.
const ALL_LEAVE_TYPES = [
  { key: 'Annual Leave',                    label: 'Annual Leave' },
  { key: 'Maternity Leave (112 Working Days)', label: 'Maternity Leave' },
  { key: 'Paternity Leave (14 Working Days)',  label: 'Paternity Leave' },
  { key: 'Sick Leave (Up to 42 Days)',      label: 'Sick Leave' },
  { key: 'Casual Leave (5-7 Days)',         label: 'Casual Leave' },
  { key: 'Study Leave',                     label: 'Study Leave' },
  { key: 'Pre-retirement Leave (3 Months)', label: 'Pre-retirement Leave' },
  { key: 'Sabbatical Leave (1 Year)',       label: 'Sabbatical Leave' },
  { key: 'Custom Leave',                    label: 'Custom Leave' },
  { key: 'Demo Leave (Minutes)',            label: 'Demo Leave (Testing)' }
];

function parseWorkingDaysFromType(leaveType) {
  if (!leaveType) return 1;
  if (LEAVE_DAYS_MAP[leaveType]) return LEAVE_DAYS_MAP[leaveType];

  const workingMatch = String(leaveType).match(/\((\d+)\s+Working\s+Days?\)/i);
  if (workingMatch) return parseInt(workingMatch[1], 10);

  const daysMatch = String(leaveType).match(/\(.*?(\d+)\s+Days?/i);
  if (daysMatch) return parseInt(daysMatch[1], 10);

  return 1;
}

function generateStaffPassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const pick = () => chars[Math.floor(Math.random() * chars.length)];
  const block = () => Array.from({ length: 4 }, pick).join('');
  return `Isse-${block()}-${block()}`;
}

const PUBLIC_HOLIDAYS = new Set([
  '2024-01-01','2024-03-29','2024-04-01','2024-04-10','2024-04-11',
  '2024-05-01','2024-06-12','2024-06-16','2024-06-17','2024-09-16',
  '2024-10-01','2024-12-25','2024-12-26',
  '2025-01-01','2025-03-30','2025-03-31','2025-04-18','2025-04-21',
  '2025-05-01','2025-06-06','2025-06-07','2025-06-12','2025-09-05',
  '2025-10-01','2025-12-25','2025-12-26',
  '2026-01-01','2026-03-20','2026-03-21','2026-04-03','2026-04-06',
  '2026-05-01','2026-05-27','2026-05-28','2026-06-12','2026-08-26',
  '2026-10-01','2026-12-25','2026-12-26',
  '2027-01-01','2027-03-10','2027-03-11','2027-03-26','2027-03-29',
  '2027-05-01','2027-05-16','2027-05-17','2027-06-12','2027-08-15',
  '2027-10-01','2027-12-25','2027-12-26'
]);

function toDateString(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseLocalDate(dateStr) {
  if (!dateStr) return null;
  const parts = String(dateStr).split('-');
  if (parts.length !== 3) return new Date(dateStr);
  return new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
}

function isWeekend(d) {
  const day = d.getDay();
  return day === 0 || day === 6;
}

function isPublicHoliday(d) {
  return PUBLIC_HOLIDAYS.has(toDateString(d));
}

function isWorkingDay(d) {
  return !isWeekend(d) && !isPublicHoliday(d);
}

function nextWorkingDay(d) {
  const result = new Date(d);
  result.setHours(0, 0, 0, 0);
  while (!isWorkingDay(result)) result.setDate(result.getDate() + 1);
  return result;
}

function addWorkingDays(startDate, workingDays) {
  const result = nextWorkingDay(startDate);
  let remaining = workingDays - 1;
  while (remaining > 0) {
    result.setDate(result.getDate() + 1);
    if (isWorkingDay(result)) remaining--;
  }
  return result;
}

function countWorkingDays(startDate, endDate) {
  let count = 0;
  const cursor = new Date(startDate);
  const end = new Date(endDate);
  cursor.setHours(0, 0, 0, 0);
  end.setHours(0, 0, 0, 0);
  while (cursor <= end) {
    if (isWorkingDay(cursor)) count++;
    cursor.setDate(cursor.getDate() + 1);
  }
  return count;
}

// ============================================================
// AUDIT LOG / NOTIFICATION HELPERS
// ============================================================

function logAudit(actor, actorRole, action, targetId, details) {
  const sql = `INSERT INTO audit_logs (actor, actor_role, action, target_id, details) VALUES (?, ?, ?, ?, ?)`;
  db.run(sql, [actor || 'System', actorRole || 'N/A', action, targetId || null, details || ''], (err) => {
    if (err) console.error('Audit Log Error:', err.message);
  });
}

function createNotification(recipientType, recipientId, title, message, linkSection = '', relatedRequestId = null) {
  const sql = `INSERT INTO notifications (recipient_type, recipient_id, title, message, link_section, related_request_id) VALUES (?, ?, ?, ?, ?, ?)`;
  db.run(sql, [recipientType, recipientId || 'all', title, message, linkSection, relatedRequestId], (err) => {
    if (err) console.error('Notification Error:', err.message);
  });
}

function markNotificationsReadForRequest(requestId, recipientType = null) {
  if (!requestId) return;
  let sql = `UPDATE notifications SET is_read = 1 WHERE related_request_id = ? AND is_read = 0`;
  const params = [requestId];
  if (recipientType) {
    sql += ` AND recipient_type = ?`;
    params.push(recipientType);
  }
  db.run(sql, params, (err) => {
    if (err) console.error('Notification mark-read error:', err.message);
  });
}

// ============================================================
// AUTHORIZATION MIDDLEWARE
// ============================================================

const WORKFLOW_LEVELS = { none: 0, unit: 1, final: 2, full: 3 };

// ============================================================
// LOGIN RATE LIMITER (Section 6 C3)
// ============================================================
// In-memory only. Resets on process restart. 10 failed attempts
// per IP + identifier (file number or email) within 15 minutes
// triggers a 429. A successful login clears the counter.
const LOGIN_WINDOW_MS  = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;
const loginAttempts = new Map(); // key → { count, firstAt }

function loginRateKey(req, identifier) {
  const ip = req.ip || (req.connection && req.connection.remoteAddress) || 'unknown';
  return `${ip}::${String(identifier || '').trim().toLowerCase()}`;
}

function loginRateLimited(key) {
  const entry = loginAttempts.get(key);
  if (!entry) return false;
  if (Date.now() - entry.firstAt > LOGIN_WINDOW_MS) {
    loginAttempts.delete(key);
    return false;
  }
  return entry.count >= LOGIN_MAX_ATTEMPTS;
}

function loginRateRegisterFailure(key) {
  const now = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry || now - entry.firstAt > LOGIN_WINDOW_MS) {
    loginAttempts.set(key, { count: 1, firstAt: now });
    return;
  }
  entry.count += 1;
}

function loginRateClear(key) {
  loginAttempts.delete(key);
}

async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;

  if (!token) return res.status(401).json({ error: 'Authentication required.' });

  try {
    const user = await getUserByToken(token);
    if (!user) return res.status(401).json({ error: 'Session expired or invalid.' });

    const ctx = await getUserAuthContext(user.id);
    if (!ctx) return res.status(401).json({ error: 'User has no role assigned.' });

        req.authUser = user;
    req.authContext = ctx;
    next();
  } catch (err) {
    console.error('Auth middleware error:', err.message);
    res.status(500).json({ error: 'Authentication check failed.' });
  }
}

// ============================================================
// STAFF AUTH MIDDLEWARE (Bug B3 foundation)
// ============================================================
// Staff use the same Bearer-token scheme as admins, but the
// token lives in staff_profiles.session_token. On any failure we
// include `code: 'SESSION_INVALID'` so the staff portal can
// distinguish "your session expired" from "wrong password".
async function requireStaff(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;

  if (!token) {
    return res.status(401).json({
      error: 'Authentication required.',
      code: 'SESSION_INVALID'
    });
  }

  try {
    const staff = await getStaffByToken(token);
    if (!staff) {
      return res.status(401).json({
        error: 'Session expired or invalid.',
        code: 'SESSION_INVALID'
      });
    }
    req.staff = staff;
    next();
  } catch (err) {
    console.error('Staff auth middleware error:', err.message);
    res.status(500).json({ error: 'Authentication check failed.' });
  }
}

// ============================================================
// STAFF-OWNER CHECK (Bug B3 foundation)
// ============================================================
// Returns true when the file number from the URL / row equals
// the authenticated staff member's file number (case-insensitive,
// trimmed). Otherwise sends 403 and returns false. Never throws.
function requireSameStaff(fileNo, req, res) {
  const a = String(fileNo == null ? '' : fileNo).trim().toLowerCase();
  const b = String(req.staff && req.staff.isse_file_no ? req.staff.isse_file_no : '')
    .trim()
    .toLowerCase();
  if (a && b && a === b) return true;
  res.status(403).json({ error: 'You can only access your own records.' });
  return false;
}

function requireWorkflow(level) {
  return function (req, res, next) {
    const ctx = req.authContext;
    if (!ctx) return res.status(401).json({ error: 'Not authenticated.' });

    const userLevel = WORKFLOW_LEVELS[ctx.authority] ?? -1;
    const requiredLevel = WORKFLOW_LEVELS[level] ?? 999;

    if (userLevel < requiredLevel) {
      return res.status(403).json({
        error: `You do not have the required authority to perform this action (needs '${level}').`
      });
    }
    next();
  };
}
function requirePermission(key) {
  return function (req, res, next) {
    const ctx = req.authContext;
    if (!ctx) return res.status(401).json({ error: 'Not authenticated.' });
    if (ctx.authority === 'full') return next();
    if (ctx.permissions.has(key)) return next();
    return res.status(403).json({ error: `You do not have the required permission: ${key}` });
  };
}

// Accepts an array of permission keys. Passes if the user holds
// ANY of them (or is a Super Admin). Used on read-only GET routes
// that should be accessible to both `.view` and `.manage` holders.
function requireAnyPermission(keys) {
  return function (req, res, next) {
    const ctx = req.authContext;
    if (!ctx) return res.status(401).json({ error: 'Not authenticated.' });
    if (ctx.authority === 'full') return next();
    if (keys.some(k => ctx.permissions.has(k))) return next();
    return res.status(403).json({ error: `You do not have the required permission.` });
  };
}

function departmentFilterFor(req) {
  const ctx = req.authContext;
  if (!ctx) return null;
  if (ctx.scope === 'global') return null;
  return ctx.user.department || null;
}

function viewRoleFor(ctx) {
  if (!ctx) return 'anonymous';
  if (ctx.authority === 'full') return 'super_admin';
  if (ctx.authority === 'final') return 'head_of_admin';
  if (ctx.authority === 'unit') return 'hou';
  return 'anonymous';
}

// ==========================================
// ROLES CRUD
// ==========================================

app.get('/api/admin/roles', requireAuth, requireAnyPermission(['roles.view', 'settings.manage']), (req, res) => {
  db.all(
    `SELECT r.id, r.title, r.description, r.workflow_authority, r.scope,
            r.is_protected, r.created_at,
            (SELECT COUNT(*) FROM users u WHERE u.role_id = r.id) AS user_count,
            (SELECT COUNT(*) FROM role_permissions rp WHERE rp.role_id = r.id) AS permission_count
     FROM roles r
     ORDER BY r.is_protected DESC, r.title ASC`,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

app.get('/api/admin/permissions', requireAuth, requireAnyPermission(['roles.view', 'settings.manage']), (req, res) => {
    const PERMISSION_CATALOG = [
    { key: 'leave.view',                 label: 'View Leave Requests',          group: 'Leave' },
    { key: 'leave.endorse',              label: 'Endorse Leave (HOU)',          group: 'Leave', workflow: 'unit' },
    { key: 'leave.approve_final',        label: 'Approve Leave Final (HOA)',    group: 'Leave', workflow: 'final' },
    { key: 'resumption.view',            label: 'View Resumptions',             group: 'Resumption' },
    { key: 'resumption.validate',        label: 'Validate Resumptions (HOU)',   group: 'Resumption', workflow: 'unit' },
    { key: 'resumption.clear_final',     label: 'Clear Resumptions (HOA)',      group: 'Resumption', workflow: 'final' },
    { key: 'attendance.view',            label: 'View Attendance Records',      group: 'Attendance' },
    { key: 'attendance.manage',          label: 'Import/Manage Attendance',     group: 'Attendance' },
    { key: 'staff.view',                 label: 'View Staff Directory',         group: 'Staff' },
    { key: 'staff.add',                  label: 'Add Staff',                    group: 'Staff' },
    { key: 'staff.edit',                 label: 'Edit Staff',                   group: 'Staff' },
    { key: 'staff.delete',               label: 'Delete Staff',                 group: 'Staff' },
    { key: 'departments.view',           label: 'View Departments',             group: 'Administration' },
    { key: 'departments.manage',         label: 'Manage Departments',           group: 'Administration' },
    { key: 'officers.view',              label: 'View Approval Officers',       group: 'Administration' },
    { key: 'officers.manage',            label: 'Manage Approval Officers',     group: 'Administration' },
    { key: 'reports.view',               label: 'View Reports',                 group: 'Reports' },
    { key: 'reports.export',             label: 'Export Reports',               group: 'Reports' },
    { key: 'documents.view',             label: 'View HR Documents',            group: 'Documents' },
    { key: 'documents.download',         label: 'Download HR Documents',        group: 'Documents' },
    { key: 'notifications.view',         label: 'View Notifications',           group: 'System' },
    { key: 'approval_history.view',      label: 'View Approval History',        group: 'System' },
    { key: 'audit.view',                 label: 'View Audit Log',               group: 'System' },
    { key: 'settings.view',              label: 'View System Settings',         group: 'System' },
    { key: 'settings.manage',            label: 'Manage System Settings',       group: 'System' },
    { key: 'roles.view',                 label: 'View Roles',                   group: 'System' },
    { key: 'users.view',                 label: 'View Admin Accounts',          group: 'System' },
    { key: 'staff_enquiries.view',       label: 'View Staff Enquiries',         group: 'Communication' },
    { key: 'staff_enquiries.manage',     label: 'Manage Staff Enquiries',       group: 'Communication' }
  ];
  res.json(PERMISSION_CATALOG);
});

app.get('/api/admin/roles/:id/permissions', requireAuth, requireAnyPermission(['roles.view', 'settings.manage']), (req, res) => {
  db.all(
    `SELECT permission_key FROM role_permissions WHERE role_id = ?`,
    [req.params.id],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows.map(r => r.permission_key));
    }
  );
});

app.post('/api/admin/roles', requireAuth, requirePermission('settings.manage'), (req, res) => {
  const { title, description, workflow_authority, scope, permissions } = req.body;

  if (!title || !workflow_authority || !scope) {
    return res.status(400).json({ error: 'Title, workflow authority, and scope are required.' });
  }
  if (!['full', 'final', 'unit', 'none'].includes(workflow_authority)) {
    return res.status(400).json({ error: 'Invalid workflow authority.' });
  }
  if (!['global', 'department'].includes(scope)) {
    return res.status(400).json({ error: 'Invalid scope.' });
  }

  db.run(
    `INSERT INTO roles (title, description, workflow_authority, scope, is_protected)
     VALUES (?, ?, ?, ?, FALSE)`,
    [title.trim(), description || null, workflow_authority, scope],
    function (err) {
      if (err) return res.status(400).json({ error: 'Role title already exists.' });
      const roleId = this.lastID;

      const perms = Array.isArray(permissions) ? permissions : [];
      if (!perms.length) {
        logAudit(req.authUser.username, req.authContext.role.title, 'ROLE_CREATED', roleId, `Created role ${title}`);
        return res.json({ message: 'Role created.', id: roleId });
      }

      const placeholders = perms.map(() => '(?, ?)').join(', ');
      const params = [];
      perms.forEach(p => { params.push(roleId, p); });

      db.run(
        `INSERT INTO role_permissions (role_id, permission_key) VALUES ${placeholders}`,
        params,
        (permErr) => {
          if (permErr) console.error('Role permission insert error:', permErr.message);
          logAudit(req.authUser.username, req.authContext.role.title, 'ROLE_CREATED', roleId, `Created role ${title} with ${perms.length} permissions`);
          res.json({ message: 'Role created.', id: roleId });
        }
      );
    }
  );
});

app.put('/api/admin/roles/:id', requireAuth, requirePermission('settings.manage'), (req, res) => {
  const { id } = req.params;
  const { title, description, workflow_authority, scope, permissions } = req.body;

  if (!title || !workflow_authority || !scope) {
    return res.status(400).json({ error: 'Title, workflow authority, and scope are required.' });
  }

  db.get(`SELECT is_protected, title FROM roles WHERE id = ?`, [id], (err, role) => {
    if (err || !role) return res.status(404).json({ error: 'Role not found.' });

    if (role.is_protected) {
      db.run(
        `UPDATE roles SET description = ?, updated_at = NOW() WHERE id = ?`,
        [description || null, id],
        (upErr) => {
          if (upErr) return res.status(500).json({ error: upErr.message });
          replaceRolePermissions(id, permissions, () => {
            logAudit(req.authUser.username, req.authContext.role.title, 'ROLE_UPDATED', id, `Updated protected role ${role.title}`);
            res.json({ message: 'Role updated.' });
          });
        }
      );
      return;
    }

    db.run(
      `UPDATE roles SET title = ?, description = ?, workflow_authority = ?, scope = ?, updated_at = NOW() WHERE id = ?`,
      [title.trim(), description || null, workflow_authority, scope, id],
      function (updErr) {
        if (updErr) return res.status(400).json({ error: 'Role title already in use.' });
        replaceRolePermissions(id, permissions, () => {
          logAudit(req.authUser.username, req.authContext.role.title, 'ROLE_UPDATED', id, `Updated role ${title}`);
          res.json({ message: 'Role updated.' });
        });
      }
    );
  });
});

function replaceRolePermissions(roleId, permissions, callback) {
  db.run(`DELETE FROM role_permissions WHERE role_id = ?`, [roleId], (delErr) => {
    if (delErr) {
      console.error('Role permission delete error:', delErr.message);
      return callback();
    }
    const perms = Array.isArray(permissions) ? permissions : [];
    if (!perms.length) return callback();

    const placeholders = perms.map(() => '(?, ?)').join(', ');
    const params = [];
    perms.forEach(p => { params.push(roleId, p); });

    db.run(
      `INSERT INTO role_permissions (role_id, permission_key) VALUES ${placeholders}`,
      params,
      (insErr) => {
        if (insErr) console.error('Role permission insert error:', insErr.message);
        callback();
      }
    );
  });
}

app.delete('/api/admin/roles/:id', requireAuth, requirePermission('settings.manage'), (req, res) => {
  const { id } = req.params;

  db.get(`SELECT is_protected, title FROM roles WHERE id = ?`, [id], (err, role) => {
    if (err || !role) return res.status(404).json({ error: 'Role not found.' });
    if (role.is_protected) return res.status(400).json({ error: 'Protected roles cannot be deleted.' });

    db.get(`SELECT COUNT(*) AS count FROM users WHERE role_id = ?`, [id], (countErr, row) => {
      if (countErr) return res.status(500).json({ error: countErr.message });
      if (row.count > 0) {
        return res.status(400).json({
          error: `Cannot delete role "${role.title}". It still has ${row.count} user(s) assigned.`
        });
      }

      db.run(`DELETE FROM roles WHERE id = ?`, [id], function (delErr) {
        if (delErr) return res.status(500).json({ error: delErr.message });
        logAudit(req.authUser.username, req.authContext.role.title, 'ROLE_DELETED', id, `Deleted role ${role.title}`);
        res.json({ message: `Role "${role.title}" deleted.` });
      });
    });
  });
});

// ==========================================
// 1. AUTHENTICATION & SESSION ENDPOINTS
// ==========================================

// Heartbeat only updates last_seen. It must never touch is_active —
// that flag is the account-enabled bit and only the Super Admin
// changes it (via user management).
app.post('/api/admin/heartbeat', requireAuth, (req, res) => {
  // The bearer token identifies the caller. Body `userId` is ignored
  // so no one can poke another user's last_seen.
  db.run(`UPDATE users SET last_seen = NOW() WHERE id = ?`, [req.authUser.id], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

app.post('/api/auth/staff-login', (req, res) => {
  const { isseFileNo, password } = req.body || {};
  if (!isseFileNo || !password) {
    return res.status(400).json({ error: 'ISSE File Number and Password are required.' });
  }

  const identifier = String(isseFileNo).trim();
  const rateKey = loginRateKey(req, identifier);

  if (loginRateLimited(rateKey)) {
    return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  }

  const query = `SELECT * FROM staff_profiles WHERE LOWER(isse_file_no) = LOWER(?)`;
  db.get(query, [identifier], async (err, staff) => {
    if (err) {
      console.error('Login DB Error:', err.message);
      return res.status(500).json({ error: 'Internal server error.' });
    }
    if (!staff) {
      loginRateRegisterFailure(rateKey);
      return res.status(404).json({ error: 'ISSE File Number not found in database.' });
    }

    if (!staff.password || String(staff.password).trim() === '') {
      return res.status(403).json({
        error: 'Your account does not have a password yet. Please contact the Super Admin to set one up.'
      });
    }

    let verifyResult;
    try {
      verifyResult = await verifyPassword(String(password), String(staff.password));
    } catch (vErr) {
      console.error('verifyPassword failed:', vErr.message);
      return res.status(500).json({ error: 'Internal server error.' });
    }

    if (!verifyResult.ok) {
      loginRateRegisterFailure(rateKey);
      return res.status(401).json({ error: 'Incorrect password. Please try again.' });
    }

    // Transparent upgrade: if the stored password was plain text
    // (or a lower-cost hash), silently replace it with a bcrypt
    // hash of the just-supplied plain password.
    if (verifyResult.needsRehash) {
      try {
        const newHash = await hashPassword(String(password));
        db.run(
          `UPDATE staff_profiles SET password = ? WHERE id = ?`,
          [newHash, staff.id],
          (uErr) => {
            if (uErr) console.error('Staff rehash save error:', uErr.message);
          }
        );
      } catch (hErr) {
        console.error('Staff rehash failed:', hErr.message);
      }
    }

    let session;
    try {
      session = await issueStaffSession(staff.id);
    } catch (sErr) {
      console.error('Staff session issue failed:', sErr.message);
      return res.status(500).json({ error: 'Login succeeded but session could not be created.' });
    }

    loginRateClear(rateKey);

    const {
      password: _ignored,
      session_token: _st,
      session_expires_at: _se,
      ...safeStaff
    } = staff;

    res.json({
      message: 'Login successful',
      staff: safeStaff,
      token: session.token,
      expiresAt: session.expiresAt
    });
  });
});

// ============================================================
// STAFF LOGOUT (Bug B3)
// ============================================================
app.post('/api/auth/staff-logout', requireStaff, async (req, res) => {
  try {
    await revokeStaffSession(req.staff.id);
    return res.json({ message: 'Logged out successfully.' });
  } catch (err) {
    console.error('Staff logout error:', err.message);
    return res.status(500).json({ error: 'Logout failed.' });
  }
});

// ============================================================
// STAFF CHANGE PASSWORD (Bug B3, B4, C4)
// ============================================================
// Identity comes from the Bearer token, not the body. A wrong
// current password returns 400 (NOT 401) so the staff portal's
// token-interceptor does not mistake it for an expired session.
app.post('/api/auth/staff-change-password', requireStaff, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Current password and new password are required.' });
  }
  if (String(newPassword).length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  }

  const fileNo = req.staff.isse_file_no;

  db.get(
    `SELECT id, password FROM staff_profiles WHERE id = ?`,
    [req.staff.id],
    async (err, staff) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!staff) return res.status(404).json({ error: 'Staff record not found.' });
      if (!staff.password) {
        return res.status(403).json({ error: 'No password is set for this account. Contact the Super Admin.' });
      }

      let verifyResult;
      try {
        verifyResult = await verifyPassword(String(currentPassword), String(staff.password));
      } catch (vErr) {
        console.error('verifyPassword failed:', vErr.message);
        return res.status(500).json({ error: 'Internal server error.' });
      }
      if (!verifyResult.ok) {
        return res.status(400).json({ error: 'Current password is incorrect.' });
      }

      let newHash;
      try {
        newHash = await hashPassword(String(newPassword));
      } catch (hErr) {
        console.error('hashPassword failed:', hErr.message);
        return res.status(500).json({ error: 'Internal server error.' });
      }

      db.run(
        `UPDATE staff_profiles SET password = ? WHERE id = ?`,
        [newHash, staff.id],
        function (uErr) {
          if (uErr) return res.status(500).json({ error: uErr.message });
          logAudit(fileNo, 'Staff', 'STAFF_PASSWORD_CHANGED', staff.id, 'Staff changed their own password');
          res.json({ message: 'Password updated successfully.' });
        }
      );
    }
  );
});

app.post('/api/auth/admin-login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });

  const emailClean = String(email).trim();
  const rateKey = loginRateKey(req, emailClean);

  if (loginRateLimited(rateKey)) {
    return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  }

  const query = `SELECT id, username, email, role_id, department, is_active, password FROM users WHERE LOWER(email) = LOWER(?)`;
  db.get(query, [emailClean], async (err, user) => {
    if (err) {
      console.error('Admin Login DB Error:', err.message);
      return res.status(500).json({ error: 'Internal server error.' });
    }
    if (!user) {
      loginRateRegisterFailure(rateKey);
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    let verifyResult;
    try {
      verifyResult = await verifyPassword(String(password), String(user.password || ''));
    } catch (vErr) {
      console.error('verifyPassword failed:', vErr.message);
      return res.status(500).json({ error: 'Internal server error.' });
    }
    if (!verifyResult.ok) {
      loginRateRegisterFailure(rateKey);
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    // Transparent upgrade from legacy plain-text password.
    if (verifyResult.needsRehash) {
      try {
        const newHash = await hashPassword(String(password));
        db.run(
          `UPDATE users SET password = ? WHERE id = ?`,
          [newHash, user.id],
          (uErr) => {
            if (uErr) console.error('Admin rehash save error:', uErr.message);
          }
        );
      } catch (hErr) {
        console.error('Admin rehash failed:', hErr.message);
      }
    }

    // Block login if the account has been deactivated by a Super Admin.
    if (user.is_active === 0 || user.is_active === false) {
      return res.status(403).json({ error: 'Your account has been deactivated. Please contact the Super Admin.' });
    }

    let ctx;
    try {
      ctx = await getUserAuthContext(user.id);
    } catch (ctxErr) {
      console.error('Context load failed:', ctxErr.message);
      return res.status(500).json({ error: 'Could not load user permissions.' });
    }
    if (!ctx) {
      return res.status(403).json({ error: 'Your account has no role assigned. Please contact the Super Admin.' });
    }

    if (ctx.role.title === 'Head of Unit') {
      const dept = (user.department || '').trim();
      if (!dept || dept === 'All Units' || dept === 'Unassigned') {
        return res.status(403).json({
          error: 'Your HOU account is not yet assigned to a department. Please contact the Super Admin.'
        });
      }
    }

    let session;
    try {
      session = await issueSession(user.id);
    } catch (sessionErr) {
      console.error('Session issue failed:', sessionErr.message);
      return res.status(500).json({ error: 'Login succeeded but session could not be created.' });
    }

    loginRateClear(rateKey);

    res.json({
      message: 'Login successful',
      token: session.token,
      expiresAt: session.expiresAt,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: ctx.role.title,
        authority: ctx.authority,
        scope: ctx.scope,
        role_id: ctx.role.id,
        department: user.department
      }
    });
  });
});

app.get('/api/auth/session', async (req, res) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;

  if (!token) return res.status(401).json({ error: 'No session token provided.' });

  try {
    const user = await getUserByToken(token);
    if (!user) return res.status(401).json({ error: 'Session expired or invalid.' });

    const ctx = await getUserAuthContext(user.id);
    if (!ctx) return res.status(401).json({ error: 'User has no role assigned.' });

    res.json({
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: ctx.role.title,
        authority: ctx.authority,
        scope: ctx.scope,
        role_id: ctx.role.id,
        department: user.department
      }
    });
  } catch (sessionErr) {
    console.error('Session verify error:', sessionErr.message);
    res.status(500).json({ error: 'Session verification failed.' });
  }
});

app.get('/api/auth/permissions', async (req, res) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
  if (!token) return res.status(401).json({ error: 'No session token provided.' });

  try {
    const user = await getUserByToken(token);
    if (!user) return res.status(401).json({ error: 'Session expired or invalid.' });

    const ctx = await getUserAuthContext(user.id);
    if (!ctx) return res.status(401).json({ error: 'User has no role assigned.' });

    res.json({
      authority: ctx.authority,
      scope: ctx.scope,
      permissions: Array.from(ctx.permissions)
    });
  } catch (err) {
    console.error('Permissions fetch error:', err.message);
    res.status(500).json({ error: 'Failed to load permissions.' });
  }
});

app.post('/api/auth/admin-logout', async (req, res) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;

  if (!token) {
    return res.status(401).json({ error: 'Authentication required.' });
  }

  try {
    const user = await getUserByToken(token);
    if (user) {
      await revokeSession(user.id);
    }
    return res.json({ message: 'Logged out successfully.' });
  } catch (logoutErr) {
    console.error('Logout error:', logoutErr.message);
    res.status(500).json({ error: 'Logout failed.' });
  }
});

app.post('/api/admin/reset-password', requireAuth, requireWorkflow('full'), (req, res) => {
  const { email, newPassword } = req.body || {};

  if (!email || typeof email !== 'string' || email.trim() === '') {
    return res.status(400).json({ error: 'Email is required.' });
  }
  if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  }

  const emailClean = email.trim();

  db.get(`SELECT id, username, email FROM users WHERE LOWER(email) = LOWER(?)`, [emailClean], async (err, user) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!user) return res.status(404).json({ error: 'No account found with this email address.' });

    let newHash;
    try {
      newHash = await hashPassword(String(newPassword));
    } catch (hErr) {
      console.error('hashPassword failed:', hErr.message);
      return res.status(500).json({ error: 'Internal server error.' });
    }

    db.run(`UPDATE users SET password = ? WHERE id = ?`, [newHash, user.id], function (updErr) {
      if (updErr) return res.status(500).json({ error: updErr.message });

      logAudit(
        req.authUser.username,
        req.authContext.role.title,
        'ADMIN_PASSWORD_RESET',
        user.id,
        `Reset password for ${user.email}`
      );
      res.json({ message: `Password reset successfully for ${emailClean}.` });
    });
  });
});

// ==========================================
// 2. USER MANAGEMENT
// ==========================================

// Sessions list — "online" is derived from last_seen, not is_active.
// (is_active is the account-enabled flag, not a presence indicator.)
app.get('/api/admin/sessions', requireAuth, requireAnyPermission(['users.view', 'settings.manage']), (req, res) => {
  db.all(
    `SELECT u.id, u.username, u.email, u.is_active, u.last_seen, u.created_at,
            r.title AS role_title
     FROM users u
     LEFT JOIN roles r ON r.id = u.role_id
     ORDER BY u.last_seen DESC NULLS LAST, u.username ASC`,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

app.get('/api/admin/users', requireAuth, requireAnyPermission(['users.view', 'settings.manage']), (req, res) => {
  db.all(
    `SELECT u.id, u.username, u.email, u.department, u.is_active, u.last_seen, u.created_at,
            u.role_id, r.title AS role_title, r.workflow_authority, r.scope
     FROM users u
     LEFT JOIN roles r ON r.id = u.role_id
     ORDER BY u.created_at DESC`,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

app.post('/api/admin/users', requireAuth, requirePermission('settings.manage'), (req, res) => {
  const { username, email, password, role_id, department, is_active } = req.body;
  if (!username || !email || !password || !role_id) {
    return res.status(400).json({ error: 'Username, email, password, and role are required.' });
  }

  db.get(`SELECT title, scope FROM roles WHERE id = ?`, [role_id], async (roleErr, role) => {
    if (roleErr || !role) return res.status(400).json({ error: 'Invalid role.' });

    if (role.scope === 'department' && !department) {
      return res.status(400).json({ error: 'Department is required for department-scoped roles.' });
    }

    const dept = role.scope === 'department' ? department : (department || 'All Units');
    const active = is_active === false ? 0 : 1;

    let passwordHash;
    try {
      passwordHash = await hashPassword(String(password));
    } catch (hErr) {
      console.error('hashPassword failed:', hErr.message);
      return res.status(500).json({ error: 'Internal server error.' });
    }

    db.run(
      `INSERT INTO users (username, email, password, role_id, department, is_active) VALUES (?, ?, ?, ?, ?, ?)`,
      [username.trim(), email.trim(), passwordHash, role_id, dept, active],
      function (err) {
        if (err) {
          if (err.message.includes('UNIQUE') || err.message.includes('duplicate')) {
            return res.status(400).json({ error: 'Username or email already exists.' });
          }
          return res.status(500).json({ error: err.message });
        }
        if (role.scope === 'department' && dept && dept !== 'All Units') {
          db.run(`UPDATE departments SET assigned_hou = ? WHERE LOWER(name) = LOWER(?)`, [username.trim(), dept]);
        }

        logAudit(req.authUser.username, req.authContext.role.title, 'USER_CREATED', this.lastID, `Created user ${username} (role: ${role.title})`);
        res.json({ message: 'User created.', id: this.lastID });
      }
    );
  });
});

app.put('/api/admin/users/:id', requireAuth, requirePermission('settings.manage'), (req, res) => {
  const id = req.params.id;
  const { username, email, role_id, department, is_active, password } = req.body;

  if (!username || !email || !role_id) {
    return res.status(400).json({ error: 'Username, email, and role are required.' });
  }

  db.get(`SELECT title, scope FROM roles WHERE id = ?`, [role_id], async (roleErr, role) => {
    if (roleErr || !role) return res.status(400).json({ error: 'Invalid role.' });

    if (role.scope === 'department' && !department) {
      return res.status(400).json({ error: 'Department is required for department-scoped roles.' });
    }

    const dept = role.scope === 'department' ? department : (department || 'All Units');
    const active = is_active === false ? 0 : 1;

    let sql = `UPDATE users SET username = ?, email = ?, role_id = ?, department = ?, is_active = ?`;
    const params = [username.trim(), email.trim(), role_id, dept, active];

    if (password && String(password).trim() !== '') {
      let passwordHash;
      try {
        passwordHash = await hashPassword(String(password));
      } catch (hErr) {
        console.error('hashPassword failed:', hErr.message);
        return res.status(500).json({ error: 'Internal server error.' });
      }
      sql += `, password = ?`;
      params.push(passwordHash);
    }

    sql += ` WHERE id = ?`;
    params.push(id);

    db.run(sql, params, function (err) {
      if (err) {
        if (err.message.includes('UNIQUE') || err.message.includes('duplicate')) {
          return res.status(400).json({ error: 'Username or email already in use.' });
        }
        return res.status(500).json({ error: err.message });
      }
      if (role.scope === 'department' && dept && dept !== 'All Units') {
        db.run(`UPDATE departments SET assigned_hou = ? WHERE LOWER(name) = LOWER(?)`, [username.trim(), dept]);
      }

      logAudit(req.authUser.username, req.authContext.role.title, 'USER_UPDATED', id, `Updated user ${username} (role: ${role.title})`);
      res.json({ message: 'User updated.' });
    });
  });
});

app.delete('/api/admin/users/:id', requireAuth, requirePermission('settings.manage'), (req, res) => {
  const id = req.params.id;
  if (String(id) === String(req.authUser.id)) {
    return res.status(400).json({ error: 'You cannot delete your own account.' });
  }
  db.get(`SELECT username FROM users WHERE id = ?`, [id], (lookupErr, target) => {
    if (lookupErr || !target) return res.status(404).json({ error: 'User not found.' });
    db.run(`DELETE FROM users WHERE id = ?`, [id], function (err) {
      if (err) return res.status(500).json({ error: err.message });
      logAudit(req.authUser.username, req.authContext.role.title, 'USER_DELETED', id, `Deleted user ${target.username}`);
      res.json({ message: 'User deleted successfully.' });
    });
  });
});

app.put('/api/admin/profile/:id', requireAuth, (req, res) => {
  const { id } = req.params;
  const { username, email, currentPassword, newPassword } = req.body || {};

  if (String(id) !== String(req.authUser.id)) {
    return res.status(403).json({ error: 'You can only update your own profile.' });
  }

  if (!username || !email || !currentPassword) {
    return res.status(400).json({ error: 'Username, email, and current password are required.' });
  }

  db.get(`SELECT id, password FROM users WHERE id = ?`, [id], async (err, user) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!user) return res.status(404).json({ error: 'User not found.' });

    let verifyResult;
    try {
      verifyResult = await verifyPassword(String(currentPassword), String(user.password || ''));
    } catch (vErr) {
      console.error('verifyPassword failed:', vErr.message);
      return res.status(500).json({ error: 'Internal server error.' });
    }

    // Return 400 (NOT 401) on a wrong current password so the admin-script.js
    // fetch wrapper does not mistake it for an expired session and log the
    // user out. See Section 3 B3 item 5 for the same reasoning on the staff side.
    if (!verifyResult.ok) {
      return res.status(400).json({ error: 'Current password is incorrect.' });
    }

    let query = `UPDATE users SET username = ?, email = ?`;
    const params = [String(username).trim(), String(email).trim()];

    if (newPassword && String(newPassword).trim() !== '') {
      if (String(newPassword).length < 8) {
        return res.status(400).json({ error: 'New password must be at least 8 characters.' });
      }
      let newHash;
      try {
        newHash = await hashPassword(String(newPassword));
      } catch (hErr) {
        console.error('hashPassword failed:', hErr.message);
        return res.status(500).json({ error: 'Internal server error.' });
      }
      query += `, password = ?`;
      params.push(newHash);
    }

    query += ` WHERE id = ?`;
    params.push(id);

    db.run(query, params, function (updateErr) {
      if (updateErr) {
        if (updateErr.message.includes('UNIQUE')) return res.status(400).json({ error: 'Username or Email already in use.' });
        return res.status(500).json({ error: updateErr.message });
      }
      logAudit(
        req.authUser.username,
        req.authContext.role.title,
        'PROFILE_UPDATED',
        id,
        'Updated own profile'
      );
      res.json({ message: 'Profile updated successfully.' });
    });
  });
});

// ==========================================
// 3. STAFF PROFILES
// ==========================================

app.post('/api/admin/staff', requireAuth, requireWorkflow('unit'), async (req, res) => {
  const { isseFileNo, fullName, department, designation, gradeLevel, officialEmail, gender,
          lastPromotionDate, nextPromotionDate, password } = req.body;

  const deptFilter = departmentFilterFor(req);
  if (deptFilter && department && department.toLowerCase() !== deptFilter.toLowerCase()) {
    return res.status(403).json({ error: 'You can only register staff in your own department.' });
  }

  let finalPassword = null;
  if (password && String(password).trim() !== '') {
    try {
      finalPassword = await hashPassword(String(password));
    } catch (hErr) {
      console.error('hashPassword failed:', hErr.message);
      return res.status(500).json({ error: 'Internal server error.' });
    }
  }

  db.run(
    `INSERT INTO staff_profiles (isse_file_no, full_name, department, designation, grade_level, official_email, gender, last_promotion_date, next_promotion_date, password)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [isseFileNo, fullName, department, designation, gradeLevel, officialEmail || null, gender || 'Male',
     lastPromotionDate || null, nextPromotionDate || null, finalPassword],
    function (err) {
      if (err) return res.status(400).json({ error: 'Staff File Number or Email already exists.' });
      logAudit(req.authUser.username, req.authContext.role.title, 'STAFF_PROFILE_CREATED', this.lastID, `Created staff profile for ${fullName}`);
      res.json({ message: 'Staff profile created successfully', id: this.lastID });
    }
  );
});

app.get('/api/admin/staff', requireAuth, requireAnyPermission(['staff.view', 'staff.add', 'staff.edit', 'staff.delete']), (req, res) => {
  const deptFilter = departmentFilterFor(req);
  // Explicit column list — never return password, session_token or
  // session_expires_at. Every column returned here is consumed by
  // admin-script.js (staff table, edit modal, CSV export, attendance
  // import preview, department staff list). `has_password` is a
  // computed boolean used for the "no password yet" indicator.
  let sql = `SELECT id, isse_file_no, full_name, department, designation, grade_level,
                    official_email, gender, last_promotion_date, next_promotion_date,
                    created_at,
                    (password IS NOT NULL AND password != '') AS has_password
               FROM staff_profiles`;
  const params = [];
  if (deptFilter) {
    sql += ` WHERE LOWER(department) = LOWER(?)`;
    params.push(deptFilter);
  }
  sql += ` ORDER BY created_at DESC`;

  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.put('/api/admin/staff/:id', requireAuth, requireWorkflow('unit'), (req, res) => {
  const { fullName, department, designation, gradeLevel, officialEmail, gender,
          lastPromotionDate, nextPromotionDate } = req.body;

  const deptFilter = departmentFilterFor(req);
  if (deptFilter) {
    db.get(`SELECT department FROM staff_profiles WHERE id = ?`, [req.params.id], (chkErr, row) => {
      if (chkErr || !row) return res.status(404).json({ error: 'Staff not found.' });
      if (row.department.toLowerCase() !== deptFilter.toLowerCase()) {
        return res.status(403).json({ error: 'You can only edit staff in your own department.' });
      }
      applyUpdate();
    });
  } else {
    applyUpdate();
  }

  function applyUpdate() {
    db.run(
      `UPDATE staff_profiles SET full_name=?, department=?, designation=?, grade_level=?, official_email=?, gender=?, last_promotion_date=?, next_promotion_date=? WHERE id=?`,
      [fullName, department, designation, gradeLevel, officialEmail || null, gender || 'Male',
       lastPromotionDate || null, nextPromotionDate || null, req.params.id],
      function (err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: 'Staff profile updated successfully.' });
      }
    );
  }
});

app.delete('/api/admin/staff/:id', requireAuth, requireWorkflow('unit'), (req, res) => {
  const deptFilter = departmentFilterFor(req);

  if (deptFilter) {
    db.get(`SELECT department FROM staff_profiles WHERE id = ?`, [req.params.id], (chkErr, row) => {
      if (chkErr || !row) return res.status(404).json({ error: 'Staff not found.' });
      if (row.department.toLowerCase() !== deptFilter.toLowerCase()) {
        return res.status(403).json({ error: 'You can only delete staff in your own department.' });
      }
      doDelete();
    });
  } else {
    doDelete();
  }

  function doDelete() {
    db.run(`DELETE FROM staff_profiles WHERE id = ?`, [req.params.id], function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ message: 'Staff profile deleted successfully.' });
    });
  }
});

// ==========================================
// 3b. BULK STAFF IMPORT
// ==========================================

app.post('/api/admin/staff/bulk', requireAuth, requireWorkflow('unit'), (req, res) => {
  const { staffList } = req.body;
  if (!Array.isArray(staffList) || staffList.length === 0) {
    return res.status(400).json({ error: 'No staff data provided.' });
  }

  const deptFilter = departmentFilterFor(req);

  for (const s of staffList) {
    if (!s.isseFileNo || !s.fullName || !s.department || !s.designation || !s.gradeLevel) {
      return res.status(400).json({ error: 'Missing required fields in bulk data.' });
    }
    if (deptFilter && s.department.toLowerCase() !== deptFilter.toLowerCase()) {
      return res.status(403).json({ error: `You can only add staff to your own department (${deptFilter}).` });
    }
  }

  let successCount = 0;
  let failCount = 0;
  let lastError = '';

  const insertNext = async (index) => {
    if (index >= staffList.length) {
      logAudit(req.authUser.username, req.authContext.role.title, 'BULK_STAFF_IMPORTED', null, `Imported ${successCount} staff members`);
      return res.json({
        message: `Bulk import complete. ${successCount} added, ${failCount} failed.`,
        successCount,
        failCount,
        lastError
      });
    }

    const s = staffList[index];

    let rowPassword = null;
    if (s.password && String(s.password).trim() !== '') {
      try {
        rowPassword = await hashPassword(String(s.password));
      } catch (hErr) {
        console.error('Bulk hashPassword failed on row', index, ':', hErr.message);
        failCount++;
        lastError = `Row ${index + 1} (${s.isseFileNo}): password hashing failed`;
        return insertNext(index + 1);
      }
    }

    db.run(
      `INSERT INTO staff_profiles (isse_file_no, full_name, department, designation, grade_level, official_email, gender, password)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [s.isseFileNo, s.fullName, s.department, s.designation, s.gradeLevel, s.officialEmail || null, s.gender || 'Male', rowPassword],
      function (err) {
        if (err) {
          console.error('Bulk insert error on row', index, ':', err.message);
          failCount++;
          lastError = `Row ${index + 1} (${s.isseFileNo}): ${err.message}`;
        } else {
          successCount++;
        }
        insertNext(index + 1);
      }
    );
  };

  insertNext(0).catch((err) => {
    console.error('Bulk staff import unexpected error:', err && err.message ? err.message : err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Bulk import failed unexpectedly.' });
    }
  });
});

// ==========================================
// 3b-2. STAFF PASSWORD MANAGEMENT (Super Admin only)
// ==========================================

app.patch('/api/admin/staff/:id/password',
  requireAuth, requireWorkflow('full'),
  (req, res) => {
    const { adminPassword, newPassword } = req.body || {};

    const proceed = async () => {
      let finalPlain;
      let mode;
      if (newPassword && String(newPassword).trim() !== '') {
        if (String(newPassword).length < 8) {
          return res.status(400).json({ error: 'New password must be at least 8 characters.' });
        }
        finalPlain = String(newPassword);
        mode = 'set';
      } else {
        finalPlain = generateStaffPassword();
        mode = 'regenerate';
      }

      let finalHash;
      try {
        finalHash = await hashPassword(finalPlain);
      } catch (hErr) {
        console.error('hashPassword failed:', hErr.message);
        return res.status(500).json({ error: 'Internal server error.' });
      }

      db.run(
        `UPDATE staff_profiles SET password = ? WHERE id = ?`,
        [finalHash, req.params.id],
        function (uErr) {
          if (uErr) return res.status(500).json({ error: uErr.message });
          if (!this.changes) return res.status(404).json({ error: 'Staff record not found.' });

          logAudit(req.authUser.username, req.authContext.role.title,
            mode === 'set' ? 'STAFF_PASSWORD_SET' : 'STAFF_PASSWORD_REGENERATED',
            req.params.id,
            mode === 'set' ? 'Super Admin set a staff password' : 'Super Admin regenerated a staff password');

          // The plain text is returned ONCE in this response so the Super
          // Admin can copy it and hand it to the staff member. After this
          // response the hash cannot be reversed — there is no "Reveal"
          // button anymore because a bcrypt hash is one-way.
          res.json({ message: 'Password updated.', password: finalPlain });
        }
      );
    };

    if (!adminPassword) {
      proceed().catch((e) => {
        console.error('Password update unexpected error:', e && e.message ? e.message : e);
        if (!res.headersSent) res.status(500).json({ error: 'Internal error.' });
      });
      return;
    }

    db.get(`SELECT password FROM users WHERE id = ?`, [req.authUser.id], async (err, admin) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!admin) return res.status(404).json({ error: 'Admin user not found.' });

      let verifyResult;
      try {
        verifyResult = await verifyPassword(String(adminPassword), String(admin.password || ''));
      } catch (vErr) {
        console.error('verifyPassword failed:', vErr.message);
        return res.status(500).json({ error: 'Internal server error.' });
      }
      if (!verifyResult.ok) {
        return res.status(401).json({ error: 'Incorrect admin password.' });
      }

      proceed().catch((e) => {
        console.error('Password update unexpected error:', e && e.message ? e.message : e);
        if (!res.headersSent) res.status(500).json({ error: 'Internal error.' });
      });
    });
  }
);

// ==========================================
// 3c. DELETE ALL STAFF (Super Admin only)
// ==========================================

app.post('/api/admin/staff/delete-all', requireAuth, requireWorkflow('full'), (req, res) => {
  db.run(`DELETE FROM staff_profiles`, [], function (err) {
    if (err) return res.status(500).json({ error: err.message });

    const deleted = this.changes || 0;
    logAudit(
      req.authUser.username,
      req.authContext.role.title,
      'ALL_STAFF_DELETED',
      null,
      `Permanently deleted ALL ${deleted} staff profiles from the directory`
    );

    res.json({ message: `All staff profiles deleted successfully (${deleted} records removed).` });
  });
});

// ==========================================
// 4. DEPARTMENTS & OFFICERS
// ==========================================

app.get('/api/admin/departments', requireAuth, requireAnyPermission(['departments.view', 'departments.manage']), (req, res) => {
  db.all(
    `SELECT d.*, (SELECT COUNT(*) FROM staff_profiles s WHERE LOWER(s.department) = LOWER(d.name)) AS staff_count FROM departments d ORDER BY name ASC`,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

app.post('/api/admin/departments', requireAuth, requireWorkflow('full'), (req, res) => {
  const { name, code, assignedHou } = req.body;
  if (!name || !code) return res.status(400).json({ error: 'Name and Code are required.' });

  db.run(
    `INSERT INTO departments (name, code, assigned_hou, status) VALUES (?, ?, ?, 'Active')`,
    [name.trim(), code.trim(), assignedHou || 'Unassigned'],
    function (err) {
      if (err) return res.status(400).json({ error: 'Department name or code already exists.' });
      logAudit(req.authUser.username, req.authContext.role.title, 'DEPARTMENT_CREATED', this.lastID, `Created department ${name}`);
      res.json({ message: 'Department created successfully.', id: this.lastID });
    }
  );
});

app.put('/api/admin/departments/:id', requireAuth, requireWorkflow('full'), (req, res) => {
  const { name, code, assignedHou, status } = req.body;
  db.run(
    `UPDATE departments SET name=?, code=?, assigned_hou=?, status=? WHERE id=?`,
    [name.trim(), code.trim(), assignedHou || 'Unassigned', status || 'Active', req.params.id],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ message: 'Department updated successfully.' });
    }
  );
});

app.delete('/api/admin/departments/:id', requireAuth, requireWorkflow('full'), (req, res) => {
  const { id } = req.params;

  db.get(`SELECT name FROM departments WHERE id = ?`, [id], (err, dept) => {
    if (err || !dept) return res.status(404).json({ error: 'Department not found.' });

    db.get(
      `SELECT COUNT(*) AS count FROM staff_profiles WHERE LOWER(department) = LOWER(?)`,
      [dept.name],
      (err2, row) => {
        if (err2) return res.status(500).json({ error: err2.message });
        if (row.count > 0) {
          return res.status(400).json({
            error: `Cannot delete department "${dept.name}". It still has ${row.count} staff member(s) assigned.`
          });
        }
        db.run(`DELETE FROM departments WHERE id = ?`, [id], function (err3) {
          if (err3) return res.status(500).json({ error: err3.message });
          logAudit(req.authUser.username, req.authContext.role.title, 'DEPARTMENT_DELETED', id, `Deleted department ${dept.name}`);
          res.json({ message: `Department "${dept.name}" deleted successfully.` });
        });
      }
    );
  });
});

app.get('/api/admin/officers', requireAuth, requireAnyPermission(['officers.view', 'officers.manage', 'settings.manage']), (req, res) => {
  db.all(
    `SELECT u.id, u.username, u.email, u.department, u.is_active, u.created_at,
            r.title AS role_title, r.id AS role_id
     FROM users u
     LEFT JOIN roles r ON r.id = u.role_id
     WHERE r.title IN ('Head of Unit', 'Head of Administration')
     ORDER BY r.title DESC, u.username ASC`,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

// New HOU accounts are created ACTIVE by default. The account-enabled
// flag can be flipped later via User Management. (Previously this
// endpoint inserted is_active = 0, which — combined with the new
// login guard — would have permanently locked the new HOU out.)
app.post('/api/admin/officers/hou', requireAuth, requirePermission('settings.manage'), (req, res) => {
  const { username, email, password, department } = req.body;
  if (!username || !email || !password || !department) {
    return res.status(400).json({ error: 'Username, Email, Password, and Department are required.' });
  }

  db.get(`SELECT id FROM roles WHERE title = 'Head of Unit'`, [], (roleErr, roleRow) => {
    if (roleErr || !roleRow) return res.status(500).json({ error: 'Head of Unit role not found in roles table.' });

    db.run(
      `INSERT INTO users (username, email, password, role_id, department, is_active) VALUES (?, ?, ?, ?, ?, 1)`,
      [username.trim(), email.trim(), password, roleRow.id, department],
      function (err) {
        if (err) return res.status(400).json({ error: 'Username or Email already exists.' });
        db.run(`UPDATE departments SET assigned_hou = ? WHERE LOWER(name) = LOWER(?)`, [username.trim(), department.trim()]);
        logAudit(req.authUser.username, req.authContext.role.title, 'HOU_ASSIGNED', this.lastID, `Assigned ${username} as HOU for ${department}`);
        res.json({ message: `HOU ${username} assigned to ${department} successfully.`, id: this.lastID });
      }
    );
  });
});

app.post('/api/admin/officers/hoa', requireAuth, requirePermission('settings.manage'), (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) {
    return res.status(400).json({ error: 'Username, Email, and Password are required.' });
  }

  db.get(`SELECT id FROM roles WHERE title = 'Head of Administration'`, [], (roleErr, roleRow) => {
    if (roleErr || !roleRow) return res.status(500).json({ error: 'Head of Administration role not found.' });

    db.get(`SELECT id FROM roles WHERE title = 'Head of Unit'`, [], (houRoleErr, houRoleRow) => {
      if (houRoleErr || !houRoleRow) return res.status(500).json({ error: 'Head of Unit role not found.' });

      db.run(`UPDATE users SET role_id = ? WHERE role_id = ?`, [houRoleRow.id, roleRow.id], () => {
        db.run(
          `INSERT INTO users (username, email, password, role_id, department, is_active) VALUES (?, ?, ?, ?, 'All Units', 1)`,
          [username.trim(), email.trim(), password, roleRow.id],
          function (err) {
            if (err) return res.status(400).json({ error: 'Username or Email already exists.' });
            logAudit(req.authUser.username, req.authContext.role.title, 'HOA_ASSIGNED', this.lastID, `Set ${username} as HOA`);
            res.json({ message: `Head of Administration set to ${username} successfully.`, id: this.lastID });
          }
        );
      });
    });
  });
});

// ==========================================
// 4c. ANNUAL LEAVE ENTITLEMENT STATUS
// ==========================================

app.get('/api/leave/annual-status/:fileNo', requireStaff, (req, res) => {
  if (!requireSameStaff(req.params.fileNo, req, res)) return;
  const fileNo = req.params.fileNo;

  db.get(
    `SELECT grade_level FROM staff_profiles WHERE LOWER(isse_file_no) = LOWER(?)`,
    [fileNo],
    (err, staff) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!staff) return res.status(404).json({ error: 'Staff record not found.' });

      const gl = parseInt(String(staff.grade_level || '').replace(/[^0-9]/g, ''), 10);
      let totalDays = 30, firstHalfDays = 15, secondHalfDays = 15;
      if (!isNaN(gl)) {
        if (gl >= 7) { totalDays = 30; firstHalfDays = 15; secondHalfDays = 15; }
        else if (gl >= 4) { totalDays = 21; firstHalfDays = 11; secondHalfDays = 10; }
        else { totalDays = 14; firstHalfDays = 7; secondHalfDays = 7; }
      }

      const year = new Date().getFullYear();

      db.all(
        `SELECT total_days FROM leave_requests
          WHERE LOWER(isse_file_no) = LOWER(?)
            AND leave_type LIKE '%Annual%'
            AND SUBSTR(start_date, 1, 4) = ?
            AND overall_status NOT LIKE '%REJECTED%'
            AND overall_status NOT LIKE '%CANCELLED%'`,
        [fileNo, String(year)],
        (sumErr, rows) => {
          if (sumErr) return res.status(500).json({ error: sumErr.message });

          let usedDays = 0;
          (rows || []).forEach(r => {
            const n = parseInt(String(r.total_days || '').replace(/[^0-9]/g, ''), 10);
            if (!isNaN(n)) usedDays += n;
          });

          const remainingDays = Math.max(0, totalDays - usedDays);
          let mode = 'fresh';
          if (remainingDays === 0) mode = 'exhausted';
          else if (usedDays > 0) mode = 'half-remaining';

          res.json({
            year,
            gradeLevel: isNaN(gl) ? null : gl,
            totalDays,
            firstHalfDays,
            secondHalfDays,
            usedDays,
            remainingDays,
            mode
          });
        }
      );
    }
  );
});

// ==========================================
// 5. LEAVE SUBMISSION & QUEUES
// ==========================================

app.post('/api/leave/apply', requireStaff, (req, res) => {
  const { startDate, endDate, totalDays, remarks, attachmentId } = req.body;
  const relievingOfficerName = req.body.relievingOfficerName ? String(req.body.relievingOfficerName).trim() : null;
  const relievingOfficerFileNo = req.body.relievingOfficerFileNo ? String(req.body.relievingOfficerFileNo).trim() : null;
  const relievingOfficerDepartment = req.body.relievingOfficerDepartment ? String(req.body.relievingOfficerDepartment).trim() : null;
  let leaveType = req.body.leaveType;

  // Identity comes from the bearer token, not the request body,
  // so a staff member cannot file leave on behalf of another officer.
  const isseFileNo  = req.staff.isse_file_no;
  const fullName    = req.staff.full_name;
  const department  = req.staff.department;
  const designation = req.staff.designation;

  if (!startDate || !endDate || !leaveType) {
    return res.status(400).json({ error: 'Please provide all required application fields.' });
  }

  db.get(
    `SELECT setting_value FROM system_settings WHERE setting_key = 'hidden_leave_types'`,
    [],
    (hiddenErr, hiddenRow) => {
      let hiddenList = [];
      if (!hiddenErr && hiddenRow && hiddenRow.setting_value) {
        try { hiddenList = JSON.parse(hiddenRow.setting_value); } catch (_) { hiddenList = []; }
      }
      if (!Array.isArray(hiddenList)) hiddenList = [];

      const isDemo = leaveType.includes('Demo Leave');
      if (!isDemo && hiddenList.includes(leaveType)) {
        return res.status(400).json({ error: 'This leave type is not currently offered. Please pick another.' });
      }

      handleLeaveApply();
    }
  );

  function handleLeaveApply() {
    if (leaveType.includes('Demo Leave')) {
      const todayStr = toDateString(new Date());
      db.run(
        `INSERT INTO leave_requests (isse_file_no, full_name, department, designation, leave_type, start_date, end_date, total_days, staff_remarks, relieving_officer_name, relieving_officer_file_no, relieving_officer_department)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [isseFileNo, fullName, department, designation, leaveType, todayStr, todayStr, String(totalDays || '0 Minutes'), remarks || null,
         relievingOfficerName, relievingOfficerFileNo, relievingOfficerDepartment],
        function (err) {
          if (err) return res.status(500).json({ error: err.message });
          const newId = this.lastID;
          const finish = () => {
            logAudit(fullName, 'Staff', 'LEAVE_APPLICATION_SUBMITTED', newId, `Filed ${leaveType}`);
            createNotification('hou', department, 'New Leave Application', `Staff member ${fullName} (${department}) filed a new ${leaveType} request.`, 'houQueueSection', newId);
            if (relievingOfficerFileNo && String(relievingOfficerFileNo).toLowerCase() !== String(isseFileNo).toLowerCase()) {
              createNotification(
                'staff',
                relievingOfficerFileNo,
                'Relieving Officer Assignment',
                `You have been assigned as relieving officer for ${fullName} (${department}) for their ${leaveType}.`,
                'statusSection',
                newId
              );
            }
            res.json({ message: 'Demo Leave application submitted successfully', id: newId });
          };

          if (attachmentId) {
            db.run(`UPDATE leave_attachments SET leave_request_id = ? WHERE id = ?`,
              [newId, attachmentId],
              () => db.run(`UPDATE leave_requests SET attachment_id = ? WHERE id = ?`,
                [attachmentId, newId],
                () => finish()));
          } else {
            finish();
          }
        }
      );
      return;
    }

    const originalStart = parseLocalDate(startDate);
    if (!originalStart || isNaN(originalStart.getTime())) {
      return res.status(400).json({ error: 'Invalid start date supplied.' });
    }

    const adjustedStart = nextWorkingDay(originalStart);
    const adjustedStartStr = toDateString(adjustedStart);

    const insertLeave = (finalLeaveType, finalAdjustedEndStr, finalTotalWorkingDays) => {
      db.run(
        `INSERT INTO leave_requests (isse_file_no, full_name, department, designation, leave_type, start_date, end_date, total_days, staff_remarks, relieving_officer_name, relieving_officer_file_no, relieving_officer_department)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [isseFileNo, fullName, department, designation, finalLeaveType, adjustedStartStr, finalAdjustedEndStr, String(finalTotalWorkingDays), remarks || null,
         relievingOfficerName, relievingOfficerFileNo, relievingOfficerDepartment],
        function (err) {
          if (err) return res.status(500).json({ error: err.message });
          const newId = this.lastID;
          const finish = () => {
            logAudit(fullName, 'Staff', 'LEAVE_APPLICATION_SUBMITTED', newId,
              `Filed ${finalLeaveType} (${finalTotalWorkingDays} working days) from ${adjustedStartStr} to ${finalAdjustedEndStr}`);
            createNotification('hou', department, 'New Leave Application',
              `Staff member ${fullName} (${department}) filed a new ${finalLeaveType} request.`, 'houQueueSection', newId);
            if (relievingOfficerFileNo && String(relievingOfficerFileNo).toLowerCase() !== String(isseFileNo).toLowerCase()) {
              createNotification(
                'staff',
                relievingOfficerFileNo,
                'Relieving Officer Assignment',
                `You have been assigned as relieving officer for ${fullName} (${department}) for their ${finalLeaveType}.`,
                'statusSection',
                newId
              );
            }
            res.json({ message: 'Leave application submitted successfully', id: newId });
          };

          if (attachmentId) {
            db.run(`UPDATE leave_attachments SET leave_request_id = ? WHERE id = ?`,
              [newId, attachmentId],
              () => db.run(`UPDATE leave_requests SET attachment_id = ? WHERE id = ?`,
                [attachmentId, newId],
                () => finish()));
          } else {
            finish();
          }
        }
      );
    };

    const activeLeaveSql = `
      SELECT id, leave_type FROM leave_requests
      WHERE LOWER(isse_file_no) = LOWER(?)
        AND overall_status NOT LIKE '%REJECTED%'
        AND overall_status NOT LIKE '%CANCELLED%'
        AND (
          overall_status LIKE '%PENDING%'
          OR (end_date >= TO_CHAR(CURRENT_DATE, 'YYYY-MM-DD') AND (resumption_status IS NULL OR resumption_status != 'RESUMPTION APPROVED'))
        )
    `;

    db.get(activeLeaveSql, [isseFileNo.trim()], (activeErr, activeRecord) => {
      if (activeErr) return res.status(500).json({ error: 'Database check failed.' });
      if (activeRecord) {
        return res.status(400).json({
          error: `Public Service Regulation:\nYou currently have an active leave application or ongoing authorized leave in progress (${activeRecord.leave_type}). Please wait until your current leave is concluded before applying again.`
        });
      }

      db.get(`SELECT gender, grade_level FROM staff_profiles WHERE LOWER(isse_file_no) = LOWER(?)`, [isseFileNo.trim()], (genderErr, staff) => {
        const staffGender = staff && staff.gender ? staff.gender : 'Male';
        let typeLower = leaveType.toLowerCase();

        if (leaveType === 'Custom Leave') {
          const userEnd = parseLocalDate(endDate);
          if (!userEnd || isNaN(userEnd.getTime())) {
            return res.status(400).json({ error: 'Invalid custom end date supplied.' });
          }
          if (userEnd < adjustedStart) {
            return res.status(400).json({ error: 'Custom leave end date must be on or after the start date.' });
          }

          const totalWD = countWorkingDays(adjustedStart, userEnd);
          if (totalWD <= 0) {
            return res.status(400).json({ error: 'Custom leave must span at least one working day.' });
          }

          insertLeave('Custom Leave', toDateString(userEnd), totalWD);
          return;
        }

        let requiredWorkingDays;

        if (typeLower.includes('annual') && staff && staff.grade_level) {
          const gl = parseInt(String(staff.grade_level).replace(/[^0-9]/g, ''), 10);
          let fullDays = 30;
          if (!isNaN(gl)) {
            if (gl >= 7) fullDays = 30;
            else if (gl >= 4) fullDays = 21;
            else fullDays = 14;
          }

          const frontendProvidedDays = /\(\d+\s+Working\s+Days?\)/i.test(leaveType);
          const parsedFrontendDays = parseWorkingDaysFromType(leaveType);

          if (frontendProvidedDays && parsedFrontendDays > 0 && parsedFrontendDays <= fullDays) {
            requiredWorkingDays = parsedFrontendDays;
          } else {
            leaveType = `Annual Leave (${fullDays} Working Days)`;
            LEAVE_DAYS_MAP[leaveType] = fullDays;
            typeLower = leaveType.toLowerCase();
            requiredWorkingDays = fullDays;
          }
        } else {
          requiredWorkingDays = parseWorkingDaysFromType(leaveType);
        }
        const adjustedEnd = addWorkingDays(adjustedStart, requiredWorkingDays);
        const totalWorkingDays = countWorkingDays(adjustedStart, adjustedEnd);
        const adjustedEndStr = toDateString(adjustedEnd);

        if (typeLower.includes('paternity') && staffGender.toLowerCase() !== 'male') {
          return res.status(400).json({ error: 'Paternity Leave can strictly be granted to Male officers only.' });
        }
        if (typeLower.includes('maternity') && staffGender.toLowerCase() !== 'female') {
          return res.status(400).json({ error: 'Maternity Leave can strictly be granted to Female officers only.' });
        }

        if (typeLower.includes('annual')) {
          const today = new Date();
          today.setHours(0, 0, 0, 0);

          const diffDays = Math.ceil((adjustedStart.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
          if (diffDays < 14) {
            return res.status(400).json({ error: 'Annual Leave requires submission at least 14 days prior to the commencement date.' });
          }

          const gl = parseInt(String((staff && staff.grade_level) || '').replace(/[^0-9]/g, ''), 10);
          let totalEntitlement = 30;
          if (!isNaN(gl)) {
            if (gl >= 7) totalEntitlement = 30;
            else if (gl >= 4) totalEntitlement = 21;
            else totalEntitlement = 14;
          }

          const requestedDays = parseWorkingDaysFromType(leaveType);
          const startYear = adjustedStartStr.substring(0, 4);

          db.all(
            `SELECT total_days FROM leave_requests
              WHERE LOWER(isse_file_no) = LOWER(?)
                AND leave_type LIKE '%Annual%'
                AND SUBSTR(start_date, 1, 4) = ?
                AND overall_status NOT LIKE '%REJECTED%'
                AND overall_status NOT LIKE '%CANCELLED%'`,
            [isseFileNo.trim(), startYear],
            (sumErr, rows) => {
              if (sumErr) return res.status(500).json({ error: 'Database check failed.' });

              let usedDays = 0;
              (rows || []).forEach(r => {
                const n = parseInt(String(r.total_days || '').replace(/[^0-9]/g, ''), 10);
                if (!isNaN(n)) usedDays += n;
              });

              const remaining = totalEntitlement - usedDays;

              if (remaining <= 0) {
                return res.status(400).json({
                  error: `You have already used your full annual leave entitlement (${totalEntitlement} working days) for ${startYear}.`
                });
              }
              if (requestedDays > remaining) {
                return res.status(400).json({
                  error: `This request would exceed your remaining annual leave entitlement. You have ${remaining} working day(s) left for ${startYear}, but you requested ${requestedDays}.`
                });
              }

              insertLeave(leaveType, adjustedEndStr, totalWorkingDays);
            }
          );
          return;
        }

        insertLeave(leaveType, adjustedEndStr, totalWorkingDays);
      });
    });
  }
});

// ==========================================
// STAFF DIRECTORY SEARCH (public, staff-portal autocomplete)
// ==========================================
app.get('/api/staff-directory/search', requireStaff, (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q || q.length < 2) return res.json([]);

  db.all(
    `SELECT isse_file_no, full_name, department
       FROM staff_profiles
      WHERE LOWER(full_name) LIKE LOWER(?)
         OR LOWER(isse_file_no) LIKE LOWER(?)
      ORDER BY full_name ASC
      LIMIT 10`,
    [`%${q}%`, `%${q}%`],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows || []);
    }
  );
});

app.get('/api/leave/staff-history/:fileNo', requireStaff, (req, res) => {
  if (!requireSameStaff(req.params.fileNo, req, res)) return;
  db.all(`SELECT * FROM leave_requests WHERE LOWER(isse_file_no) = LOWER(?) ORDER BY id DESC`, [req.params.fileNo], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.get('/api/leave/applications', requireAuth, (req, res) => {
  const role = viewRoleFor(req.authContext);
  const deptFilter = departmentFilterFor(req);
  const { statusFilter } = req.query;

  let sql = `SELECT * FROM leave_requests WHERE 1=1`;
  let params = [];

  if (role === 'hou' && deptFilter) {
    sql += ` AND LOWER(department) = LOWER(?)`;
    params.push(deptFilter);
  } else if (role === 'head_of_admin') {
    sql += ` AND (hou_status = 'APPROVED' OR admin_status != 'PENDING')`;
  }

  if (statusFilter && statusFilter !== 'all') {
    if (statusFilter === 'pending_hou') sql += ` AND hou_status = 'PENDING'`;
    else if (statusFilter === 'pending_hoa') sql += ` AND hou_status = 'APPROVED' AND admin_status = 'PENDING'`;
    else if (statusFilter === 'approved') sql += ` AND overall_status = 'HEAD OF ADMIN APPROVED'`;
    else if (statusFilter === 'rejected') sql += ` AND overall_status LIKE '%REJECTED%'`;
    else if (statusFilter === 'currently_on_leave') sql += ` AND overall_status = 'HEAD OF ADMIN APPROVED' AND (resumption_status IS NULL OR resumption_status NOT LIKE '%APPROVED%') AND start_date <= TO_CHAR(CURRENT_DATE, 'YYYY-MM-DD')`;
    else if (statusFilter === 'completed') sql += ` AND resumption_status LIKE '%APPROVED%'`;
  }

  sql += ` ORDER BY id DESC`;

  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.get('/api/leave/admin-queue', requireAuth, requireWorkflow('final'), (req, res) => {
  db.all(`SELECT * FROM leave_requests WHERE hou_status = 'APPROVED' AND admin_status = 'PENDING' ORDER BY id DESC`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.get('/api/leave/all-queue', requireAuth, (req, res) => {
  const role = viewRoleFor(req.authContext);
  const deptFilter = departmentFilterFor(req);

  if (role === 'hou' && deptFilter) {
    return db.all(`SELECT * FROM leave_requests WHERE LOWER(department) = LOWER(?) ORDER BY id DESC`, [deptFilter], (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    });
  }
  db.all(`SELECT * FROM leave_requests ORDER BY id DESC`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.get('/api/leave/details/:id', requireAuth, (req, res) => {
  const { id } = req.params;
  db.get(`SELECT * FROM leave_requests WHERE id = ?`, [id], (err, row) => {
    if (err || !row) return res.status(404).json({ error: 'Leave request record not found.' });
    res.json(row);
  });
});

// ==========================================
// WORKFLOW ACTIONS
// ==========================================

app.patch('/api/leave/hou-action', requireAuth, requireWorkflow('unit'), (req, res) => {
  const { requestId, status, remarks } = req.body;
  const isApproved = status === 'APPROVED';
  const overall = isApproved ? 'APPROVED BY HOU (PENDING ADMIN)' : 'REJECTED BY HOU';
  const finalRemarks = isApproved ? '' : (remarks || 'Rejected by Head of Unit');

  const deptFilter = departmentFilterFor(req);
  const guardSql = deptFilter
    ? `SELECT id, isse_file_no, full_name, department, leave_type, relieving_officer_file_no FROM leave_requests WHERE id = $1 AND LOWER(department) = LOWER($2)`
    : `SELECT id, isse_file_no, full_name, department, leave_type, relieving_officer_file_no FROM leave_requests WHERE id = $1`;
  const guardParams = deptFilter ? [requestId, deptFilter] : [requestId];

  db.get(guardSql, guardParams, (guardErr, found) => {
    if (guardErr) return res.status(500).json({ error: 'Permission check failed.' });
    if (!found) return res.status(403).json({ error: 'Request not found, or you do not have permission to act on it.' });

    db.run(
      `UPDATE leave_requests SET hou_status = ?, hou_remarks = ?, overall_status = ? WHERE id = ?`,
      [status, finalRemarks, overall, requestId],
      function (err) {
        if (err) return res.status(500).json({ error: err.message });
        logAudit(req.authUser.username, req.authContext.role.title, isApproved ? 'HOU_ENDORSED' : 'HOU_REJECTED', requestId,
          isApproved ? 'HOU endorsed leave application' : `HOU rejected leave application: ${finalRemarks}`);

        if (found.isse_file_no) {
          if (isApproved) {
            createNotification(
              'staff',
              found.isse_file_no,
              'Leave Endorsed by HOU',
              `Your ${found.leave_type} application (#LA-${requestId}) has been endorsed by your Head of Unit and is now awaiting final approval from the Head of Administration.`,
              'statusSection',
              requestId
            );
          } else {
            createNotification(
              'staff',
              found.isse_file_no,
              'Leave Rejected by HOU',
              `Your ${found.leave_type} application (#LA-${requestId}) was rejected by your Head of Unit. Reason: ${finalRemarks || 'Not specified.'}`,
              'statusSection',
              requestId
            );
          }
        }

        if (isApproved) {
          createNotification('hoa', 'all', 'Leave Awaiting HOA Clearance',
            `Leave application #${requestId} endorsed by HOU and awaiting Head of Admin approval.`, 'adminQueueSection', requestId);
        } else {
          if (found.relieving_officer_file_no) {
            createNotification(
              'staff',
              found.relieving_officer_file_no,
              'Relieving Assignment Cancelled',
              `${found.full_name} (${found.department || 'No Dept'})'s ${found.leave_type} was rejected by their Head of Unit. You are no longer needed as relieving officer.`,
              'statusSection',
              requestId
            );
          }
        }
        markNotificationsReadForRequest(requestId, 'hou');
        res.json({ message: isApproved ? 'Application endorsed and approved by HOU.' : 'Application rejected by HOU.' });
      }
    );
  });
});

app.patch('/api/leave/admin-action', requireAuth, requireWorkflow('final'), (req, res) => {
  const { requestId, status, remarks } = req.body;
  const isApproved = status === 'APPROVED';
  const overall = isApproved ? 'HEAD OF ADMIN APPROVED' : 'REJECTED BY ADMIN';
  const finalRemarks = isApproved ? '' : (remarks || 'Rejected by Head of Administration');

  db.get(
    `SELECT isse_file_no, full_name, department, leave_type, relieving_officer_file_no FROM leave_requests WHERE id = ?`,
    [requestId],
    (lookupErr, leave) => {
      if (lookupErr) return res.status(500).json({ error: lookupErr.message });

      db.run(
        `UPDATE leave_requests SET admin_status = ?, admin_remarks = ?, overall_status = ? WHERE id = ?`,
        [status, finalRemarks, overall, requestId],
        function (err) {
          if (err) return res.status(500).json({ error: err.message });
          logAudit(req.authUser.username, req.authContext.role.title, isApproved ? 'ADMIN_APPROVED' : 'ADMIN_REJECTED', requestId,
            isApproved ? 'Head of Admin granted final clearance' : `Head of Admin rejected application: ${finalRemarks}`);

          if (leave && leave.isse_file_no) {
            if (isApproved) {
              createNotification(
                'staff',
                leave.isse_file_no,
                'Leave Approved by Head of Admin',
                `Your ${leave.leave_type} application (#LA-${requestId}) has been granted FINAL APPROVAL. You may now report for duty on the scheduled resumption date.`,
                'statusSection',
                requestId
              );
            } else {
              createNotification(
                'staff',
                leave.isse_file_no,
                'Leave Rejected by Head of Admin',
                `Your ${leave.leave_type} application (#LA-${requestId}) was rejected by the Head of Administration. Reason: ${finalRemarks || 'Not specified.'}`,
                'statusSection',
                requestId
              );
            }
          }

          if (!isApproved && leave && leave.relieving_officer_file_no) {
            createNotification(
              'staff',
              leave.relieving_officer_file_no,
              'Relieving Assignment Cancelled',
              `${leave.full_name} (${leave.department || 'No Dept'})'s ${leave.leave_type} was rejected by the Head of Administration. You are no longer needed as relieving officer.`,
              'statusSection',
              requestId
            );
          }

          markNotificationsReadForRequest(requestId, 'hoa');
          res.json({ message: isApproved ? 'Application granted final approval by Head of Admin.' : 'Application rejected by Head of Admin.' });
        }
      );
    }
  );
});

// ==========================================
// 6. RESUMPTION WORKFLOW
// ==========================================

app.patch('/api/leave/cancel/:id', requireStaff, (req, res) => {
  const { id } = req.params;
  // Identity comes from the bearer token — the request body is ignored.
  const isseFileNo = req.staff.isse_file_no;

  db.get(
    `SELECT id, isse_file_no, hou_status, overall_status, full_name, department, leave_type,
            start_date, end_date, relieving_officer_file_no, relieving_officer_name
       FROM leave_requests WHERE id = ?`,
    [id],
    (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!row) return res.status(404).json({ error: 'Leave application not found.' });

      if (String(row.isse_file_no).toLowerCase() !== String(isseFileNo).toLowerCase()) {
        return res.status(403).json({ error: 'You can only cancel your own leave applications.' });
      }

      const status = (row.overall_status || '').toUpperCase();
      if (status.includes('REJECTED')) {
        return res.status(400).json({ error: 'This application has already been rejected and cannot be cancelled.' });
      }
      if (status.includes('CANCELLED')) {
        return res.status(400).json({ error: 'This application has already been cancelled.' });
      }

      const houStatus = (row.hou_status || '').toUpperCase();
      if (houStatus !== 'PENDING') {
        return res.status(400).json({
          error: 'This application can no longer be cancelled — your Head of Unit has already reviewed it.'
        });
      }

      db.run(
        `UPDATE leave_requests SET hou_status = 'CANCELLED', overall_status = 'CANCELLED BY STAFF', hou_remarks = 'Cancelled by staff before HOU review.' WHERE id = ?`,
        [id],
        function (err2) {
          if (err2) return res.status(500).json({ error: err2.message });

          logAudit(row.full_name, 'Staff', 'LEAVE_CANCELLED', id,
            `Staff cancelled ${row.leave_type} application before HOU review`);

          markNotificationsReadForRequest(id, 'hou');

          if (row.relieving_officer_file_no) {
            createNotification(
              'staff',
              row.relieving_officer_file_no,
              'Relieving Assignment Cancelled',
              `${row.full_name} (${row.department || 'No Dept'}) has cancelled their ${row.leave_type}. You are no longer needed as relieving officer.`,
              'statusSection',
              id
            );
          }

          res.json({ message: 'Leave application cancelled successfully. You may submit a new request.' });
        }
      );
    }
  );
});

app.post('/api/leave/notify-resumption', requireStaff, (req, res) => {
  const { requestId, resumptionDate, resumptionRemarks } = req.body;
  if (!requestId) return res.status(400).json({ error: 'Request ID is required.' });

  const dateToSave = resumptionDate || new Date().toISOString().split('T')[0];
  const remarksToSave = resumptionRemarks || 'Staff reported resumption of duty.';

  db.get(
    `SELECT isse_file_no, department, full_name, leave_type, resumption_status FROM leave_requests WHERE id = ?`,
    [requestId],
    (lookupErr, row) => {
      if (lookupErr || !row) return res.status(404).json({ error: 'Leave request not found.' });

      if (String(row.isse_file_no || '').toLowerCase() !== String(req.staff.isse_file_no).toLowerCase()) {
        return res.status(403).json({ error: 'You can only file resumption notices for your own leave applications.' });
      }

      const currentStatus = (row.resumption_status || '').toUpperCase();
      if (currentStatus === 'RESUMPTION APPROVED') {
        return res.status(400).json({ error: 'Duty resumption has already been fully cleared for this application.' });
      }

      db.run(
        `UPDATE leave_requests
            SET resumption_status = 'PENDING HOU RESUMPTION APPROVAL',
                resumption_date = ?,
                resumption_remarks = ?,
                hou_resumption_status = NULL,
                hou_resumption_remarks = NULL,
                hou_resumption_date = NULL,
                admin_resumption_status = NULL,
                admin_resumption_remarks = NULL,
                admin_resumption_date = NULL
          WHERE id = ?`,
        [dateToSave, remarksToSave, requestId],
        function (err) {
          if (err) return res.status(500).json({ error: err.message });

          const wasRejected = currentStatus.includes('REJECTED');
          logAudit('Staff', 'Staff', wasRejected ? 'RESUMPTION_RE-FILED' : 'RESUMPTION_FILED', requestId,
            `Reported resumption of duty on ${dateToSave}${wasRejected ? ' (re-notification after rejection)' : ''}`);

          createNotification(
            'hou',
            row.department,
            wasRejected ? 'Duty Resumption Re-filed' : 'Duty Resumption Filed',
            `${row.full_name} (${row.department}) ${wasRejected ? 're-filed' : 'filed'} a return-to-duty notice for ${row.leave_type}. Please validate the resumption.`,
            'resumptionMgmtSection',
            requestId
          );

          res.json({ message: 'Resumption notice submitted successfully! Your HOU will validate your return.' });
        }
      );
    }
  );
});

// ==========================================
// LEAVE ATTACHMENTS
// ==========================================

const ALLOWED_ATTACHMENT_MIMES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
];

app.post('/api/leave/upload-attachment', requireStaff, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received.' });

  const { originalname, mimetype, size, buffer } = req.file;

  if (!ALLOWED_ATTACHMENT_MIMES.includes(mimetype)) {
    return res.status(400).json({
      error: 'File type not allowed. Please upload a PDF, JPG, PNG, WEBP, DOC, or DOCX file.'
    });
  }

  db.run(
    `DELETE FROM leave_attachments
      WHERE leave_request_id IS NULL
        AND created_at < NOW() - INTERVAL '24 hours'`,
    [],
    () => {
      db.run(
        `INSERT INTO leave_attachments (filename, mime_type, file_size, file_data)
         VALUES (?, ?, ?, ?)`,
        [originalname || 'attachment', mimetype, size, buffer],
        function (err) {
          if (err) return res.status(500).json({ error: err.message });
          res.json({
            attachmentId: this.lastID,
            filename: originalname,
            size,
            mimeType: mimetype
          });
        }
      );
    }
  );
});

app.get('/api/leave/attachment/:id', async (req, res) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;

  db.get(
    `SELECT a.id, a.filename, a.mime_type, a.file_data,
            lr.isse_file_no AS owner_file_no,
            lr.department  AS owner_department
       FROM leave_attachments a
       LEFT JOIN leave_requests lr ON lr.id = a.leave_request_id
      WHERE a.id = ?`,
    [req.params.id],
    async (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!row) return res.status(404).json({ error: 'Attachment not found.' });

      let authorized = false;

      if (token) {
        // (a) Admin token — allowed if global, or if department matches.
        try {
          const adminUser = await getUserByToken(token);
          if (adminUser) {
            const ctx = await getUserAuthContext(adminUser.id);
            if (ctx) {
              if (ctx.scope === 'global') {
                authorized = true;
              } else if (ctx.scope === 'department') {
                const adminDept = String(adminUser.department || '').trim().toLowerCase();
                const ownerDept = String(row.owner_department || '').trim().toLowerCase();
                if (adminDept && ownerDept && adminDept === ownerDept) {
                  authorized = true;
                }
              }
            }
          }
        } catch (_) { /* fall through to staff path */ }

        // (b) Staff token — allowed only if the request belongs to them.
        if (!authorized) {
          try {
            const staff = await getStaffByToken(token);
            if (staff && row.owner_file_no &&
                String(row.owner_file_no).toLowerCase() === String(staff.isse_file_no).toLowerCase()) {
              authorized = true;
            }
          } catch (_) { /* fall through to 403 */ }
        }
      }

      if (!authorized) {
        return res.status(403).json({ error: 'Not authorized to view this attachment.' });
      }

      // Sanitise the filename before putting it into Content-Disposition.
      // Strip CR/LF, quotes, backslashes, control chars and anything not
      // printable ASCII. Guarantee a non-empty fallback so the header is
      // never malformed.
      const safeName = String(row.filename || 'attachment')
        .replace(/[\r\n\t]/g, ' ')
        .replace(/["\\]/g, '')
        .replace(/[^\x20-\x7E]/g, '_')
        .substring(0, 200) || 'attachment';

      res.setHeader('Content-Type', row.mime_type || 'application/octet-stream');
      res.setHeader('Content-Disposition', `inline; filename="${safeName}"`);
      res.send(row.file_data);
    }
  );
});

app.get('/api/leave/resumption-queue', requireAuth, (req, res) => {
  const role = viewRoleFor(req.authContext);
  const deptFilter = departmentFilterFor(req);

  let query = `SELECT * FROM leave_requests WHERE 1=1`;
  let params = [];

  if (role === 'hou') {
    query += ` AND resumption_status = 'PENDING HOU RESUMPTION APPROVAL'`;
    if (deptFilter) {
      query += ` AND LOWER(department) = LOWER(?)`;
      params.push(deptFilter);
    }
  } else if (role === 'head_of_admin' || role === 'super_admin') {
    query += ` AND (resumption_status = 'PENDING HOA RESUMPTION APPROVAL' OR hou_resumption_status = 'VERIFIED' OR resumption_status = 'PENDING HOU RESUMPTION APPROVAL')`;
  } else {
    query += ` AND resumption_status LIKE '%PENDING%'`;
  }

  query += ` ORDER BY id DESC`;

  db.all(query, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.patch('/api/leave/hou-validate-resumption', requireAuth, requireWorkflow('unit'), (req, res) => {
  const { requestId, status, remarks } = req.body;
  if (!requestId) return res.status(400).json({ error: 'Request ID is required.' });

  const isApproved = status !== 'REJECTED';
  const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const houRemarks = remarks || (isApproved ? 'Return to duty officially validated by Head of Unit.' : 'Resumption rejected by Head of Unit.');
  const resStatus = isApproved ? 'PENDING HOA RESUMPTION APPROVAL' : 'RESUMPTION REJECTED BY HOU';
  const verStatus = isApproved ? 'VERIFIED' : 'REJECTED';

  const deptFilter = departmentFilterFor(req);
  const guardSql = deptFilter
    ? `SELECT id, isse_file_no, full_name, leave_type FROM leave_requests WHERE id = $1 AND LOWER(department) = LOWER($2)`
    : `SELECT id, isse_file_no, full_name, leave_type FROM leave_requests WHERE id = $1`;
  const guardParams = deptFilter ? [requestId, deptFilter] : [requestId];

  db.get(guardSql, guardParams, (guardErr, found) => {
    if (guardErr) return res.status(500).json({ error: 'Permission check failed.' });
    if (!found) return res.status(403).json({ error: 'Request not found, or you do not have permission to act on it.' });

    db.run(
      `UPDATE leave_requests SET resumption_status = ?, hou_resumption_status = ?, hou_resumption_remarks = ?, hou_resumption_date = ? WHERE id = ?`,
      [resStatus, verStatus, houRemarks, now, requestId],
      function (err) {
        if (err) return res.status(500).json({ error: err.message });
        logAudit(req.authUser.username, req.authContext.role.title, isApproved ? 'HOU_RESUMPTION_VALIDATED' : 'HOU_RESUMPTION_REJECTED', requestId, houRemarks);

        if (found.isse_file_no) {
          if (isApproved) {
            createNotification(
              'staff',
              found.isse_file_no,
              'Resumption Validated by HOU',
              `Your return-to-duty notice (#RS-${requestId}) has been validated by your Head of Unit. It is now awaiting final clearance from the Head of Administration.`,
              'statusSection',
              requestId
            );
          } else {
            createNotification(
              'staff',
              found.isse_file_no,
              'Resumption Rejected by HOU',
              `Your return-to-duty notice (#RS-${requestId}) was rejected by your Head of Unit. Reason: ${houRemarks || 'Not specified.'}`,
              'statusSection',
              requestId
            );
          }
        }

        if (isApproved) {
          createNotification('hoa', 'all', 'Resumption Awaiting HOA Approval',
            `Resumption for request #${requestId} validated by HOU and awaiting HOA clearance.`, 'adminResumptionQueueSection', requestId);
        }
        markNotificationsReadForRequest(requestId, 'hou');
        res.json({ message: isApproved ? 'Duty resumption verified by HOU. Forwarded to Head of Administration.' : 'Duty resumption rejected by HOU.' });
      }
    );
  });
});

app.patch('/api/leave/hoa-validate-resumption', requireAuth, requireWorkflow('final'), (req, res) => {
  const { requestId, status, remarks } = req.body;
  if (!requestId) return res.status(400).json({ error: 'Request ID is required.' });

  const isApproved = status !== 'REJECTED';
  const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const adminRemarks = remarks || (isApproved ? 'Final duty resumption cleared by Head of Administration.' : 'Resumption rejected by Head of Admin.');
  const resStatus = isApproved ? 'RESUMPTION APPROVED' : 'RESUMPTION REJECTED BY HOA';
  const verStatus = isApproved ? 'APPROVED' : 'REJECTED';

  db.get(
    `SELECT isse_file_no, full_name, leave_type FROM leave_requests WHERE id = ?`,
    [requestId],
    (lookupErr, leave) => {
      if (lookupErr) return res.status(500).json({ error: lookupErr.message });

      db.run(
        `UPDATE leave_requests SET resumption_status = ?, admin_resumption_status = ?, admin_resumption_remarks = ?, admin_resumption_date = ? WHERE id = ?`,
        [resStatus, verStatus, adminRemarks, now, requestId],
        function (err) {
          if (err) return res.status(500).json({ error: err.message });
          logAudit(req.authUser.username, req.authContext.role.title, isApproved ? 'HOA_RESUMPTION_APPROVED' : 'HOA_RESUMPTION_REJECTED', requestId, adminRemarks);

          if (leave && leave.isse_file_no) {
            if (isApproved) {
              createNotification(
                'staff',
                leave.isse_file_no,
                'Resumption Fully Cleared',
                `Your return-to-duty notice (#RS-${requestId}) has been granted FINAL CLEARANCE by the Head of Administration. Your ${leave.leave_type} is now fully concluded.`,
                'statusSection',
                requestId
              );
            } else {
              createNotification(
                'staff',
                leave.isse_file_no,
                'Resumption Rejected by Head of Admin',
                `Your return-to-duty notice (#RS-${requestId}) was rejected by the Head of Administration. Reason: ${adminRemarks || 'Not specified.'}`,
                'statusSection',
                requestId
              );
            }
          }

          markNotificationsReadForRequest(requestId, 'hoa');
          res.json({ message: isApproved ? 'Duty resumption officially granted final approval by Head of Admin!' : 'Duty resumption rejected by Head of Admin.' });
        }
      );
    }
  );
});

// ==========================================
// 7. UTILITIES
// ==========================================

app.get('/api/admin/audit-log', requireAuth, requirePermission('audit.view'), (req, res) => {
  db.all(`SELECT * FROM audit_logs ORDER BY id DESC LIMIT 300`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.get('/api/notifications', requireAuth, (req, res) => {
  const ctx = req.authContext;
  const role = viewRoleFor(ctx);

  // Anyone who can see staff enquiries — whether as a viewer or a
  // manager — should see the resulting notifications.
  const canSeeStaffEnquiries =
    ctx.authority === 'full' ||
    ctx.permissions.has('staff_enquiries.manage') ||
    ctx.permissions.has('staff_enquiries.view');

  let sql = `SELECT * FROM notifications WHERE recipient_type != 'staff'`;
  let params = [];

  if (role === 'super_admin') {
    // Super Admin sees every (non-staff) notification.
  } else if (role === 'hou') {
    const dept = (ctx.user && ctx.user.department) ? ctx.user.department : '';
    if (canSeeStaffEnquiries) {
      sql += ` AND ((recipient_type = 'hou' AND LOWER(recipient_id) = LOWER(?)) OR recipient_type = 'admin')`;
    } else {
      sql += ` AND recipient_type = 'hou' AND LOWER(recipient_id) = LOWER(?)`;
    }
    params.push(dept);
  } else if (role === 'head_of_admin') {
    if (canSeeStaffEnquiries) {
      sql += ` AND (recipient_type = 'hoa' OR recipient_type = 'admin')`;
    } else {
      sql += ` AND recipient_type = 'hoa'`;
    }
  } else {
    if (canSeeStaffEnquiries) {
      sql += ` AND recipient_type = 'admin'`;
    } else {
      sql += ` AND 1=0`;
    }
  }

  sql += ` ORDER BY id DESC LIMIT 50`;

  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// ==========================================
// STAFF NOTIFICATIONS (staff portal, fileNo-scoped)
// ==========================================

app.get('/api/staff-notifications/:fileNo', requireStaff, (req, res) => {
  if (!requireSameStaff(req.params.fileNo, req, res)) return;
  const fileNo = String(req.params.fileNo || '').trim();
  if (!fileNo) return res.json([]);

  db.all(
    `SELECT id, title, message, link_section, related_request_id, is_read, created_at
       FROM notifications
      WHERE recipient_type = 'staff'
        AND LOWER(recipient_id) = LOWER(?)
      ORDER BY id DESC
      LIMIT 30`,
    [fileNo],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows || []);
    }
  );
});

app.get('/api/staff-notifications/:fileNo/unread-count', requireStaff, (req, res) => {
  if (!requireSameStaff(req.params.fileNo, req, res)) return;
  const fileNo = String(req.params.fileNo || '').trim();
  if (!fileNo) return res.json({ count: 0 });

  db.get(
    `SELECT COUNT(*) AS count FROM notifications
      WHERE recipient_type = 'staff'
        AND LOWER(recipient_id) = LOWER(?)
        AND is_read = 0`,
    [fileNo],
    (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ count: row ? row.count : 0 });
    }
  );
});

app.patch('/api/staff-notifications/:id/read', requireStaff, (req, res) => {
  // Ownership is enforced in the UPDATE itself: only a staff row whose
  // recipient_id matches the bearer token's file number is touched.
  // If the row belongs to someone else (or doesn't exist), this.changes
  // is 0 and we return 404 — same message for both so the caller cannot
  // probe for existence of another staff member's notification IDs.
  db.run(
    `UPDATE notifications SET is_read = 1
      WHERE id = ? AND recipient_type = 'staff'
        AND LOWER(recipient_id) = LOWER(?)`,
    [req.params.id, req.staff.isse_file_no],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      if (!this.changes) {
        return res.status(404).json({ error: 'Notification not found or does not belong to you.' });
      }
      res.json({ success: true });
    }
  );
});

app.patch('/api/notifications/:id/read', requireAuth, (req, res) => {
  db.run(`UPDATE notifications SET is_read = 1 WHERE id = ?`, [req.params.id], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

app.delete('/api/notifications/all', requireAuth, (req, res) => {
  const ctx = req.authContext;
  const role = viewRoleFor(ctx);
  const canSeeStaffEnquiries =
    ctx.authority === 'full' ||
    (ctx.permissions && (ctx.permissions.has('staff_enquiries.manage') || ctx.permissions.has('staff_enquiries.view')));

  let where = `recipient_type != 'staff'`;
  const params = [];

  if (role === 'super_admin') {
    // all non-staff
  } else if (role === 'hou') {
    const dept = (ctx.user && ctx.user.department) ? ctx.user.department : '';
    if (canSeeStaffEnquiries) {
      where += ` AND ((recipient_type = 'hou' AND LOWER(recipient_id) = LOWER(?)) OR recipient_type = 'admin')`;
    } else {
      where += ` AND recipient_type = 'hou' AND LOWER(recipient_id) = LOWER(?)`;
    }
    params.push(dept);
  } else if (role === 'head_of_admin') {
    where += canSeeStaffEnquiries
      ? ` AND (recipient_type = 'hoa' OR recipient_type = 'admin')`
      : ` AND recipient_type = 'hoa'`;
  } else {
    where += canSeeStaffEnquiries
      ? ` AND recipient_type = 'admin'`
      : ` AND 1=0`;
  }

  db.run(`DELETE FROM notifications WHERE ${where}`, params, function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, deleted: this.changes || 0 });
  });
});

app.delete('/api/notifications/:id', requireAuth, (req, res) => {
  const ctx = req.authContext;
  const role = viewRoleFor(ctx);
  const canSeeStaffEnquiries =
    ctx.authority === 'full' ||
    (ctx.permissions && (ctx.permissions.has('staff_enquiries.manage') || ctx.permissions.has('staff_enquiries.view')));

  let where = `id = ? AND recipient_type != 'staff'`;
  const params = [req.params.id];

  if (role === 'super_admin') {
    // any non-staff
  } else if (role === 'hou') {
    const dept = (ctx.user && ctx.user.department) ? ctx.user.department : '';
    if (canSeeStaffEnquiries) {
      where += ` AND ((recipient_type = 'hou' AND LOWER(recipient_id) = LOWER(?)) OR recipient_type = 'admin')`;
    } else {
      where += ` AND recipient_type = 'hou' AND LOWER(recipient_id) = LOWER(?)`;
    }
    params.push(dept);
  } else if (role === 'head_of_admin') {
    where += canSeeStaffEnquiries
      ? ` AND (recipient_type = 'hoa' OR recipient_type = 'admin')`
      : ` AND recipient_type = 'hoa'`;
  } else {
    where += canSeeStaffEnquiries
      ? ` AND recipient_type = 'admin'`
      : ` AND 1=0`;
  }

  db.run(`DELETE FROM notifications WHERE ${where}`, params, function (err) {
    if (err) return res.status(500).json({ error: err.message });
    if (!this.changes) return res.status(404).json({ error: 'Notification not found or you cannot delete it.' });
    res.json({ success: true, deleted: this.changes });
  });
});

app.delete('/api/notifications/all', requireAuth, (req, res) => {
  const ctx = req.authContext;
  const role = viewRoleFor(ctx);
  const canSeeStaffEnquiries =
    ctx.authority === 'full' ||
    (ctx.permissions && (ctx.permissions.has('staff_enquiries.manage') || ctx.permissions.has('staff_enquiries.view')));

  let where = `recipient_type != 'staff'`;
  const params = [];

  if (role === 'super_admin') {
    // all non-staff
  } else if (role === 'hou') {
    const dept = (ctx.user && ctx.user.department) ? ctx.user.department : '';
    if (canSeeStaffEnquiries) {
      where += ` AND ((recipient_type = 'hou' AND LOWER(recipient_id) = LOWER(?)) OR recipient_type = 'admin')`;
    } else {
      where += ` AND recipient_type = 'hou' AND LOWER(recipient_id) = LOWER(?)`;
    }
    params.push(dept);
  } else if (role === 'head_of_admin') {
    where += canSeeStaffEnquiries
      ? ` AND (recipient_type = 'hoa' OR recipient_type = 'admin')`
      : ` AND recipient_type = 'hoa'`;
  } else {
    where += canSeeStaffEnquiries
      ? ` AND recipient_type = 'admin'`
      : ` AND 1=0`;
  }

  db.run(`DELETE FROM notifications WHERE ${where}`, params, function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, deleted: this.changes || 0 });
  });
});

app.get('/api/admin/dashboard-stats', requireAuth, (req, res) => {
  const role = viewRoleFor(req.authContext);
  const deptFilter = departmentFilterFor(req);
  const stats = {
    totalStaff: 0, staffOnLeave: 0, pendingApprovals: 0, pendingHoaApprovals: 0,
    pendingResumptions: 0, activeSessions: 0, totalDepartments: 0, approvedLeaves: 0, rejectedLeaves: 0
  };

  let deptClause = '';
  let params = [];
  if (role === 'hou' && deptFilter) {
    deptClause = ` AND LOWER(department) = LOWER(?)`;
    params.push(deptFilter);
  }

  db.get(`SELECT COUNT(*) AS count FROM staff_profiles WHERE 1=1 ${deptClause}`, params, (err, row) => {
    if (!err && row) stats.totalStaff = row.count;

    db.get(`SELECT COUNT(*) AS count FROM departments WHERE status = 'Active'`, [], (errD, rowD) => {
      if (!errD && rowD) stats.totalDepartments = rowD.count;

      db.get(`SELECT COUNT(DISTINCT isse_file_no) AS count FROM leave_requests WHERE overall_status = 'HEAD OF ADMIN APPROVED' AND (resumption_status IS NULL OR resumption_status != 'RESUMPTION APPROVED') ${deptClause}`, params, (err2, row2) => {
        if (!err2 && row2) stats.staffOnLeave = row2.count;

        db.get(`SELECT COUNT(*) AS count FROM leave_requests WHERE overall_status = 'HEAD OF ADMIN APPROVED' ${deptClause}`, params, (errA, rowA) => {
          if (!errA && rowA) stats.approvedLeaves = rowA.count;

          db.get(`SELECT COUNT(*) AS count FROM leave_requests WHERE overall_status LIKE '%REJECTED%' ${deptClause}`, params, (errR, rowR) => {
            if (!errR && rowR) stats.rejectedLeaves = rowR.count;

            db.get(`SELECT COUNT(*) AS count FROM leave_requests WHERE hou_status = 'PENDING' ${deptClause}`, params, (err3, row3) => {
              if (!err3 && row3) stats.pendingApprovals = row3.count;

              db.get(`SELECT COUNT(*) AS count FROM leave_requests WHERE hou_status = 'APPROVED' AND admin_status = 'PENDING' ${deptClause}`, params, (errHoa, rowHoa) => {
                if (!errHoa && rowHoa) stats.pendingHoaApprovals = rowHoa.count;

                db.get(`SELECT COUNT(*) AS count FROM leave_requests WHERE resumption_status LIKE '%PENDING%' ${deptClause}`, params, (errRes, rowRes) => {
                  if (!errRes && rowRes) stats.pendingResumptions = rowRes.count;

                  db.get(`SELECT COUNT(*) AS count FROM users WHERE is_active = 1`, [], (err4, row4) => {
                    if (!err4 && row4) stats.activeSessions = row4.count;
                    res.json(stats);
                  });
                });
              });
            });
          });
        });
      });
    });
  });
});

app.get('/api/admin/calendar-events', requireAuth, (req, res) => {
  const authDeptFilter = departmentFilterFor(req);
  const queryDept = req.query.department ? String(req.query.department).trim() : '';

  let sql = `SELECT id, full_name, isse_file_no, department, leave_type, start_date, end_date, total_days, overall_status FROM leave_requests WHERE overall_status = 'HEAD OF ADMIN APPROVED'`;
  let params = [];

  if (authDeptFilter) {
    sql += ` AND LOWER(department) = LOWER(?)`;
    params.push(authDeptFilter);
  } else if (queryDept && queryDept !== 'All Units') {
    sql += ` AND LOWER(department) = LOWER(?)`;
    params.push(queryDept);
  }

  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.delete('/api/staff-notifications/:id', requireStaff, (req, res) => {
  db.run(
    `DELETE FROM notifications
      WHERE id = ? AND recipient_type = 'staff'
        AND LOWER(recipient_id) = LOWER(?)`,
    [req.params.id, req.staff.isse_file_no],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      if (!this.changes) {
        return res.status(404).json({ error: 'Notification not found or does not belong to you.' });
      }
      res.json({ success: true, deleted: this.changes });
    }
  );
});

app.delete('/api/staff-notifications/all/:fileNo', requireStaff, (req, res) => {
  if (!requireSameStaff(req.params.fileNo, req, res)) return;
  const fileNo = String(req.params.fileNo || '').trim();
  if (!fileNo) return res.status(400).json({ error: 'File No required.' });

  db.run(
    `DELETE FROM notifications WHERE recipient_type = 'staff' AND LOWER(recipient_id) = LOWER(?)`,
    [fileNo],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, deleted: this.changes || 0 });
    }
  );
});

// ============================================================
// ATTENDANCE MODULE
// ============================================================

const ATTENDANCE_DEFAULT_THRESHOLDS = { warning: 75, good: 90, excellent: 95 };

// ============================================================
// ATTENDANCE THRESHOLDS — SHARED READER (Bug A1)
// ============================================================
// Used by the existing admin GET route AND by the public
// read-only route below, so the two portals always agree on
// the Excellent / Good / Low / Warning labels.
function readAttendanceThresholds(callback) {
  db.all(
    `SELECT setting_key, setting_value FROM system_settings
      WHERE setting_key IN ('attendance.warning_threshold',
                            'attendance.good_threshold',
                            'attendance.excellent_threshold')`,
    [],
    (err, rows) => {
      if (err) return callback(err);
      const out = { ...ATTENDANCE_DEFAULT_THRESHOLDS };
      (rows || []).forEach(r => {
        const v = parseFloat(r.setting_value);
        if (isNaN(v)) return;
        if (r.setting_key === 'attendance.warning_threshold')   out.warning   = v;
        if (r.setting_key === 'attendance.good_threshold')      out.good      = v;
        if (r.setting_key === 'attendance.excellent_threshold') out.excellent = v;
      });
      callback(null, out);
    }
  );
}

// ------------------------------------------------------------------
// LEAVE TYPE VISIBILITY SETTINGS
// ------------------------------------------------------------------

app.get('/api/admin/settings/hidden-leave-types',
  requireAuth, requireAnyPermission(['settings.view', 'settings.manage']),
  (req, res) => {
    db.get(
      `SELECT setting_value FROM system_settings WHERE setting_key = 'hidden_leave_types'`,
      [],
      (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        let hidden = [];
        if (row && row.setting_value) {
          try { hidden = JSON.parse(row.setting_value); } catch (_) { hidden = []; }
        }
        if (!Array.isArray(hidden)) hidden = [];
        res.json({
          hidden,
          available: ALL_LEAVE_TYPES
        });
      }
    );
  }
);

app.put('/api/admin/settings/hidden-leave-types',
  requireAuth, requirePermission('settings.manage'),
  (req, res) => {
    const { hidden } = req.body || {};
    if (!Array.isArray(hidden)) {
      return res.status(400).json({ error: '`hidden` must be an array of leave-type keys.' });
    }

    const validKeys = new Set(ALL_LEAVE_TYPES.map(t => t.key));
    const cleaned = hidden.filter(k => validKeys.has(k));

    const json = JSON.stringify(cleaned);

    db.run(
      `INSERT INTO system_settings (setting_key, setting_value, updated_at)
       VALUES ('hidden_leave_types', ?, NOW())
       ON CONFLICT (setting_key) DO UPDATE
         SET setting_value = EXCLUDED.setting_value,
             updated_at    = NOW()
       RETURNING setting_key`,
      [json],
      (err) => {
        if (err) return res.status(500).json({ error: err.message });
        logAudit(
          req.authUser.username,
          req.authContext.role.title,
          'LEAVE_TYPES_VISIBILITY_UPDATED',
          null,
          `Hidden leave types set to: ${cleaned.length === 0 ? '(none)' : cleaned.join(', ')}`
        );
        res.json({ message: 'Leave type visibility updated.', hidden: cleaned });
      }
    );
  }
);

app.get('/api/settings/hidden-leave-types', (req, res) => {
  db.get(
    `SELECT setting_value FROM system_settings WHERE setting_key = 'hidden_leave_types'`,
    [],
    (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      let hidden = [];
      if (row && row.setting_value) {
        try { hidden = JSON.parse(row.setting_value); } catch (_) { hidden = []; }
      }
      if (!Array.isArray(hidden)) hidden = [];
      res.json({ hidden });
    }
  );
});

// ============================================================
// PUBLIC ATTENDANCE-THRESHOLDS READER (Bug A1)
// ============================================================
// The staff portal needs the SAME threshold values the admin
// uses to label attendance percentages, but staff cannot call
// the admin route (which needs `attendance.view`). This route
// exposes ONLY the three numbers — no other settings, no auth.
app.get('/api/settings/attendance-thresholds', (req, res) => {
  readAttendanceThresholds((err, thresholds) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(thresholds);
  });
});

app.get('/api/admin/attendance/settings',
  requireAuth, requirePermission('attendance.view'),
  (req, res) => {
    readAttendanceThresholds((err, thresholds) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(thresholds);
    });
  }
);

app.put('/api/admin/attendance/settings',
  requireAuth, requirePermission('attendance.manage'),
  (req, res) => {
    const { warning, good, excellent } = req.body || {};

    // Server-side validation of whatever the client actually sent.
    const supplied = { warning, good, excellent };
    const fieldToKey = {
      warning:   'attendance.warning_threshold',
      good:      'attendance.good_threshold',
      excellent: 'attendance.excellent_threshold'
    };
    const toSave = [];

    for (const field of Object.keys(fieldToKey)) {
      if (supplied[field] === undefined) continue;
      const n = Number(supplied[field]);
      if (!Number.isFinite(n) || n < 0 || n > 100) {
        return res.status(400).json({
          error: `"${field}" must be a number between 0 and 100.`
        });
      }
      toSave.push([fieldToKey[field], String(n)]);
    }

    if (!toSave.length) {
      return res.status(400).json({ error: 'No valid thresholds provided.' });
    }

    // Read current values so we can validate the merged ordering.
    readAttendanceThresholds((readErr, current) => {
      if (readErr) return res.status(500).json({ error: readErr.message });

      const merged = {
        warning:   supplied.warning   !== undefined ? Number(supplied.warning)   : current.warning,
        good:      supplied.good      !== undefined ? Number(supplied.good)      : current.good,
        excellent: supplied.excellent !== undefined ? Number(supplied.excellent) : current.excellent
      };

      if (!(merged.warning <= merged.good && merged.good <= merged.excellent)) {
        return res.status(400).json({
          error: 'Thresholds must satisfy Warning ≤ Good ≤ Excellent. ' +
            `Received: warning=${merged.warning}, good=${merged.good}, excellent=${merged.excellent}.`
        });
      }

      let done = 0;
      let firstError = null;

      toSave.forEach(([key, value]) => {
        db.run(
          `INSERT INTO system_settings (setting_key, setting_value, updated_at)
           VALUES (?, ?, NOW())
           ON CONFLICT (setting_key) DO UPDATE
             SET setting_value = EXCLUDED.setting_value,
                 updated_at    = NOW()
           RETURNING setting_key`,
          [key, value],
          (e) => {
            if (e) {
              console.error('Settings save error:', e.message);
              if (!firstError) firstError = e.message;
            }
            if (++done === toSave.length) {
              if (firstError) {
                return res.status(500).json({ error: `Failed to save thresholds: ${firstError}` });
              }
              logAudit(req.authUser.username, req.authContext.role.title,
                'ATTENDANCE_SETTINGS_UPDATED', null,
                `Thresholds set: warning=${merged.warning} good=${merged.good} excellent=${merged.excellent}`);
              res.json({ message: 'Thresholds updated.' });
            }
          }
        );
      });
    });
  }
);

app.get('/api/admin/attendance/months',
  requireAuth, requirePermission('attendance.view'),
  (req, res) => {
    const deptFilter = departmentFilterFor(req);
    let sql = `SELECT DISTINCT year, month FROM attendance_records`;
    const params = [];
    if (deptFilter) {
      sql += ` WHERE LOWER(department) = LOWER(?)`;
      params.push(deptFilter);
    }
    sql += ` ORDER BY year DESC, month DESC`;

    db.all(sql, params, (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows || []);
    });
  }
);

app.get('/api/admin/attendance',
  requireAuth, requirePermission('attendance.view'),
  (req, res) => {
    const year  = parseInt(req.query.year, 10);
    const month = parseInt(req.query.month, 10);
    if (isNaN(year) || isNaN(month)) {
      return res.status(400).json({ error: 'Valid year and month are required.' });
    }

    const deptFilter = departmentFilterFor(req);
    let sql = `SELECT * FROM attendance_records WHERE year = ? AND month = ?`;
    const params = [year, month];
    if (deptFilter) {
      sql += ` AND LOWER(department) = LOWER(?)`;
      params.push(deptFilter);
    }
    sql += ` ORDER BY full_name ASC`;

    db.all(sql, params, (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows || []);
    });
  }
);

app.get('/api/admin/attendance/staff/:fileNo',
  requireAuth, requirePermission('attendance.view'),
  (req, res) => {
    const year  = parseInt(req.query.year, 10);
    const month = parseInt(req.query.month, 10);
    if (isNaN(year) || isNaN(month)) {
      return res.status(400).json({ error: 'Valid year and month are required.' });
    }

    const deptFilter = departmentFilterFor(req);

    let sql = `SELECT * FROM attendance_records
                WHERE LOWER(isse_file_no) = LOWER(?) AND year = ? AND month = ?`;
    const params = [req.params.fileNo, year, month];

    if (deptFilter) {
      sql += ` AND LOWER(department) = LOWER(?)`;
      params.push(deptFilter);
    }

    db.get(sql, params, (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!row) return res.status(404).json({ error: 'Attendance record not found.' });
      res.json(row);
    });
  }
);

app.post('/api/admin/attendance/import',
  requireAuth, requirePermission('attendance.manage'),
  (req, res) => {
    const { year, month, rows } = req.body;
    const y = parseInt(year, 10);
    const m = parseInt(month, 10);

    if (isNaN(y) || y < 2000 || y > 2100 || isNaN(m) || m < 1 || m > 12) {
      return res.status(400).json({ error: 'Invalid year or month.' });
    }
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: 'No rows provided.' });
    }

    const daysInMonth = new Date(y, m, 0).getDate();

    const isWorkingByIndex = [];
    for (let d = 1; d <= daysInMonth; d++) {
      isWorkingByIndex.push(isWorkingDay(new Date(y, m - 1, d)));
    }

    db.all(
      `SELECT isse_file_no, full_name, department FROM staff_profiles`,
      [],
      (staffErr, staffRows) => {
        if (staffErr) return res.status(500).json({ error: staffErr.message });

        const staffMap = new Map();
        (staffRows || []).forEach(s =>
          staffMap.set(String(s.isse_file_no).toLowerCase(), s)
        );

        const errors = [];
        const valid  = [];

        rows.forEach((row, i) => {
          const fileNo   = String(row.isseFileNo || '').trim();
          const fullName = String(row.fullName   || '').trim();
          const rawDays  = Array.isArray(row.days) ? row.days : [];

          if (!fileNo) {
            errors.push({ row: i + 1, error: 'Missing ISSE File Number' });
            return;
          }

          const staff = staffMap.get(fileNo.toLowerCase());
          if (!staff) {
            errors.push({ row: i + 1, fileNo, error: 'Staff not found in directory' });
            return;
          }

          const workingDaysList = [];
          for (let d = 1; d <= daysInMonth; d++) {
            if (isWorkingByIndex[d - 1]) workingDaysList.push(d);
          }
          const expectedWorkingDays = workingDaysList.length;

          if (rawDays.length !== expectedWorkingDays) {
            errors.push({
              row: i + 1,
              fileNo,
              error: `Expected ${expectedWorkingDays} working-day cells for this month, but got ${rawDays.length}.`
            });
            return;
          }

          const normalisedWorking = [];
          for (let wd = 0; wd < expectedWorkingDays; wd++) {
            const raw = rawDays[wd];
            const v = (raw === null || raw === undefined)
              ? ''
              : String(raw).trim().toUpperCase();
            if (v === '' || v === 'A' || v === 'P') {
              normalisedWorking.push(v);
            } else {
              errors.push({
                row: i + 1, fileNo,
                error: `Invalid value "${raw}" on working day ${wd + 1}`
              });
              normalisedWorking.push('');
            }
          }

          const expandedDays = new Array(daysInMonth).fill('');
          for (let wd = 0; wd < expectedWorkingDays; wd++) {
            expandedDays[workingDaysList[wd] - 1] = normalisedWorking[wd];
          }

          let present = 0, absent = 0, working = 0, provided = 0;
          for (let d = 0; d < daysInMonth; d++) {
            if (!isWorkingByIndex[d]) continue;
            working++;
            const v = expandedDays[d];
            if (v !== '') provided++;
            if (v === 'P') present++;
            else absent++;
          }

          const percentage = working > 0
            ? Number(((present / working) * 100).toFixed(2))
            : 0;

          valid.push({
            isseFileNo:   staff.isse_file_no,
            fullName:     staff.full_name || fullName,
            department:   staff.department || row.department || '',
            days:         expandedDays,
            daysProvided: provided,
            presentDays:  present,
            absentDays:   absent,
            workingDays:  working,
            percentage
          });
        });

        if (!valid.length) {
          return res.status(400).json({
            error: 'No valid rows to import.',
            imported: 0, skipped: errors.length, errors
          });
        }

        const upsertSql = `
          INSERT INTO attendance_records
            (isse_file_no, full_name, department, year, month, days,
             days_provided, present_days, absent_days, working_days,
             percentage, imported_at, imported_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?)
          ON CONFLICT (isse_file_no, year, month) DO UPDATE SET
            full_name     = EXCLUDED.full_name,
            department    = EXCLUDED.department,
            days          = EXCLUDED.days,
            days_provided = EXCLUDED.days_provided,
            present_days  = EXCLUDED.present_days,
            absent_days   = EXCLUDED.absent_days,
            working_days  = EXCLUDED.working_days,
            percentage    = EXCLUDED.percentage,
            imported_at   = NOW(),
            imported_by   = EXCLUDED.imported_by
        `;

        const actor = req.authUser.username;
        let imported = 0;
        let failed   = 0;

        const step = (idx) => {
          if (idx >= valid.length) {
            logAudit(
              actor, req.authContext.role.title,
              'ATTENDANCE_IMPORTED', null,
              `Imported ${imported} attendance record(s) for ${m}/${y}`
            );
            return res.json({
              message: `Import complete. ${imported} record(s) saved.`,
              imported,
              skipped: errors.length + failed,
              errors
            });
          }

          const r = valid[idx];
          db.run(upsertSql, [
            r.isseFileNo,
            r.fullName,
            r.department,
            y,
            m,
            JSON.stringify(r.days),
            r.daysProvided,
            r.presentDays,
            r.absentDays,
            r.workingDays,
            r.percentage,
            actor
          ], (e) => {
            if (e) {
              console.error('Attendance upsert error:', e.message);
              errors.push({ fileNo: r.isseFileNo, error: e.message });
              failed++;
            } else {
              imported++;
            }
            step(idx + 1);
          });
        };
        step(0);
      }
    );
  }
);

app.delete('/api/admin/attendance/record',
  requireAuth, requirePermission('attendance.manage'),
  (req, res) => {
    const fileNo = req.query.fileNo ? String(req.query.fileNo).trim() : '';
    const year  = parseInt(req.query.year, 10);
    const month = parseInt(req.query.month, 10);

    if (!fileNo) {
      return res.status(400).json({ error: 'fileNo is required.' });
    }
    if (isNaN(year) || isNaN(month)) {
      return res.status(400).json({ error: 'Valid year and month are required.' });
    }

    const deptFilter = departmentFilterFor(req);

    let sql = `DELETE FROM attendance_records
                WHERE LOWER(isse_file_no) = LOWER(?) AND year = ? AND month = ?`;
    const params = [fileNo, year, month];

    if (deptFilter) {
      sql += ` AND LOWER(department) = LOWER(?)`;
      params.push(deptFilter);
    }

    db.run(sql, params, function (err) {
      if (err) return res.status(500).json({ error: err.message });
      if (!this.changes) {
        return res.status(404).json({ error: 'Attendance record not found.' });
      }
      logAudit(req.authUser.username, req.authContext.role.title,
        'ATTENDANCE_RECORD_DELETED', null,
        `Deleted attendance for ${fileNo} (${month}/${year})`);
      res.json({ message: 'Attendance record deleted.' });
    });
  }
);

app.patch('/api/admin/attendance/record',
  requireAuth, requirePermission('attendance.manage'),
  (req, res) => {
    const fileNo = req.body.fileNo ? String(req.body.fileNo).trim() : '';
    const year   = parseInt(req.body.year, 10);
    const month  = parseInt(req.body.month, 10);
    const workingDayValues = Array.isArray(req.body.workingDayValues)
      ? req.body.workingDayValues
      : null;

    if (!fileNo) {
      return res.status(400).json({ error: 'fileNo is required.' });
    }
    if (isNaN(year) || isNaN(month)) {
      return res.status(400).json({ error: 'Valid year and month are required.' });
    }
    if (!workingDayValues) {
      return res.status(400).json({ error: 'workingDayValues array is required.' });
    }

    const daysInMonth = new Date(year, month, 0).getDate();

    const workingDaysList = [];
    for (let d = 1; d <= daysInMonth; d++) {
      if (isWorkingDay(new Date(year, month - 1, d))) workingDaysList.push(d);
    }

    if (workingDayValues.length !== workingDaysList.length) {
      return res.status(400).json({
        error: `Expected ${workingDaysList.length} working-day values for this month, got ${workingDayValues.length}.`
      });
    }

    const normalised = workingDayValues.map(v => {
      const s = (v === null || v === undefined)
        ? ''
        : String(v).trim().toUpperCase();
      return s === 'P' ? 'P' : 'A';
    });

    const expandedDays = new Array(daysInMonth).fill('');
    for (let wd = 0; wd < workingDaysList.length; wd++) {
      expandedDays[workingDaysList[wd] - 1] = normalised[wd];
    }

    let present = 0, absent = 0, working = 0, provided = 0;
    for (let d = 0; d < daysInMonth; d++) {
      if (!isWorkingDay(new Date(year, month - 1, d + 1))) continue;
      working++;
      const v = expandedDays[d];
      if (v !== '') provided++;
      if (v === 'P') present++;
      else absent++;
    }
    const percentage = working > 0
      ? Number(((present / working) * 100).toFixed(2))
      : 0;

    const deptFilter = departmentFilterFor(req);
    let lookupSql = `SELECT id FROM attendance_records
                      WHERE LOWER(isse_file_no) = LOWER(?) AND year = ? AND month = ?`;
    const lookupParams = [fileNo, year, month];
    if (deptFilter) {
      lookupSql += ` AND LOWER(department) = LOWER(?)`;
      lookupParams.push(deptFilter);
    }

    db.get(lookupSql, lookupParams, (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!row) return res.status(404).json({ error: 'Attendance record not found.' });

      db.run(
        `UPDATE attendance_records
            SET days = ?, days_provided = ?, present_days = ?, absent_days = ?,
                working_days = ?, percentage = ?, imported_at = NOW(), imported_by = ?
          WHERE id = ?`,
        [JSON.stringify(expandedDays), provided, present, absent, working, percentage,
         req.authUser.username, row.id],
        function (updErr) {
          if (updErr) return res.status(500).json({ error: updErr.message });

          logAudit(req.authUser.username, req.authContext.role.title,
            'ATTENDANCE_RECORD_EDITED', row.id,
            `Edited attendance for ${fileNo} (${month}/${year}) — ${present}P / ${absent}A (${percentage}%)`);

          res.json({
            message: 'Attendance record updated.',
            present_days: present,
            absent_days: absent,
            working_days: working,
            percentage
          });
        }
      );
    });
  }
);

app.delete('/api/admin/attendance/month',
  requireAuth, requirePermission('attendance.manage'),
  (req, res) => {
    const year  = parseInt(req.query.year, 10);
    const month = parseInt(req.query.month, 10);
    if (isNaN(year) || isNaN(month)) {
      return res.status(400).json({ error: 'Valid year and month are required.' });
    }

    const deptFilter = departmentFilterFor(req);

    let sql = `DELETE FROM attendance_records WHERE year = ? AND month = ?`;
    const params = [year, month];

    if (deptFilter) {
      sql += ` AND LOWER(department) = LOWER(?)`;
      params.push(deptFilter);
    }

    db.run(sql, params, function (err) {
      if (err) return res.status(500).json({ error: err.message });
      const deleted = this.changes || 0;
      logAudit(req.authUser.username, req.authContext.role.title,
        'ATTENDANCE_MONTH_DELETED', null,
        `Deleted ${deleted} attendance record(s) for ${month}/${year}` +
        (deptFilter ? ` (dept: ${deptFilter})` : ''));
      res.json({
        message: `Deleted ${deleted} record(s) for ${month}/${year}.`,
        deleted
      });
    });
  }
);

app.get('/api/attendance/my-months/:isseFileNo', requireStaff, (req, res) => {
  if (!requireSameStaff(req.params.isseFileNo, req, res)) return;
  const fileNo = req.params.isseFileNo;
  if (!fileNo) return res.status(400).json({ error: 'ISSE File Number required.' });

  db.all(
    `SELECT DISTINCT year, month FROM attendance_records
      WHERE LOWER(isse_file_no) = LOWER(?)
      ORDER BY year DESC, month DESC`,
    [fileNo],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows || []);
    }
  );
});

app.get('/api/attendance/my-record/:isseFileNo', requireStaff, (req, res) => {
  if (!requireSameStaff(req.params.isseFileNo, req, res)) return;
  const fileNo = req.params.isseFileNo;
  const year  = parseInt(req.query.year, 10);
  const month = parseInt(req.query.month, 10);
  if (!fileNo) return res.status(400).json({ error: 'ISSE File Number required.' });
  if (isNaN(year) || isNaN(month)) {
    return res.status(400).json({ error: 'Valid year and month are required.' });
  }

  db.get(
    `SELECT * FROM attendance_records
      WHERE LOWER(isse_file_no) = LOWER(?) AND year = ? AND month = ?`,
    [fileNo, year, month],
    (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!row) return res.status(404).json({ error: 'No attendance record found for this month.' });
      res.json(row);
    }
  );
});

// ============================================================
// STAFF ENQUIRIES MODULE
// ============================================================

app.post('/api/staff-enquiries', requireStaff, (req, res) => {
  const { subject, message } = req.body || {};
  // Identity comes from the bearer token — the body's isseFileNo is
  // ignored so a staff member cannot submit on behalf of another.
  const isseFileNo = req.staff.isse_file_no;

  if (!isseFileNo || !message || !String(message).trim()) {
    return res.status(400).json({ error: 'ISSE File Number and message are required.' });
  }

  db.get(
    `SELECT isse_file_no, full_name, official_email, department
       FROM staff_profiles
      WHERE LOWER(isse_file_no) = LOWER(?)`,
    [String(isseFileNo).trim()],
    (lookupErr, staff) => {
      if (lookupErr) return res.status(500).json({ error: lookupErr.message });
      if (!staff) return res.status(404).json({ error: 'Staff record not found.' });

      const cleanSubject = subject && String(subject).trim() ? String(subject).trim() : null;
      const cleanMessage = String(message).trim();

      db.run(
        `INSERT INTO staff_enquiries
           (isse_file_no, staff_name, staff_email, department, subject, message, status)
         VALUES (?, ?, ?, ?, ?, ?, 'unread')`,
        [
          staff.isse_file_no,
          staff.full_name,
          staff.official_email || null,
          staff.department || null,
          cleanSubject,
          cleanMessage
        ],
        function (err) {
          if (err) return res.status(500).json({ error: err.message });

          const newId = this.lastID;

          createNotification(
            'admin',
            'all',
            'New Staff Enquiry',
            `${staff.full_name} (${staff.department || 'No Dept'}) submitted a new enquiry.`,
            'enquiriesSection',
            newId
          );

          logAudit(
            staff.full_name,
            'Staff',
            'STAFF_ENQUIRY_SUBMITTED',
            newId,
            `Submitted enquiry from ${staff.department || 'Unknown dept'}`
          );

          res.json({ message: 'Enquiry submitted successfully.', id: newId });
        }
      );
    }
  );
});

app.get('/api/staff-enquiries/my/:fileNo', requireStaff, (req, res) => {
  if (!requireSameStaff(req.params.fileNo, req, res)) return;
  db.all(
    `SELECT id, subject, message, status, staff_viewed_reply_at, created_at, updated_at
       FROM staff_enquiries
      WHERE LOWER(isse_file_no) = LOWER(?)
      ORDER BY created_at DESC`,
    [req.params.fileNo],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows || []);
    }
  );
});

app.get('/api/staff-enquiries/my/:fileNo/:id', requireStaff, (req, res) => {
  if (!requireSameStaff(req.params.fileNo, req, res)) return;
  const { fileNo, id } = req.params;

  db.get(
    `SELECT * FROM staff_enquiries
      WHERE id = ? AND LOWER(isse_file_no) = LOWER(?)`,
    [id, fileNo],
    (err, enquiry) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!enquiry) return res.status(404).json({ error: 'Enquiry not found.' });

      db.get(
        `SELECT admin_username, admin_role, body, created_at
           FROM staff_enquiry_replies
          WHERE enquiry_id = ?
          ORDER BY id DESC LIMIT 1`,
        [id],
        (replyErr, reply) => {
          if (replyErr) return res.status(500).json({ error: replyErr.message });

          if (reply && !enquiry.staff_viewed_reply_at) {
            db.run(
              `UPDATE staff_enquiries SET staff_viewed_reply_at = NOW() WHERE id = ?`,
              [id],
              () => { }
            );
          }

          res.json({ ...enquiry, reply: reply || null });
        }
      );
    }
  );
});

// -------- Admin-facing --------

app.get(
  '/api/admin/staff-enquiries/unread-count',
  requireAuth,
  requireAnyPermission(['staff_enquiries.view', 'staff_enquiries.manage']),
  (req, res) => {
    db.get(
      `SELECT COUNT(*) AS count FROM staff_enquiries WHERE status = 'unread'`,
      [],
      (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ count: row ? row.count : 0 });
      }
    );
  }
);

app.get(
  '/api/admin/staff-enquiries',
  requireAuth,
  requireAnyPermission(['staff_enquiries.view', 'staff_enquiries.manage']),
  (req, res) => {
    const deptFilter = departmentFilterFor(req);

    let sql = `SELECT id, isse_file_no, staff_name, staff_email, department,
                      subject, message, status, staff_viewed_reply_at,
                      created_at, updated_at
                 FROM staff_enquiries`;
    const params = [];

    if (deptFilter) {
      sql += ` WHERE LOWER(department) = LOWER(?)`;
      params.push(deptFilter);
    }

    sql += ` ORDER BY CASE WHEN status = 'unread' THEN 0 ELSE 1 END, created_at DESC`;

    db.all(sql, params, (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows || []);
    });
  }
);

// Detail — view users can open it, but only managers flip
// 'unread' → 'not replied'. A viewer shouldn't change state.
app.get(
  '/api/admin/staff-enquiries/:id',
  requireAuth,
  requireAnyPermission(['staff_enquiries.view', 'staff_enquiries.manage']),
  (req, res) => {
    const { id } = req.params;

    db.get(`SELECT * FROM staff_enquiries WHERE id = ?`, [id], (err, enquiry) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!enquiry) return res.status(404).json({ error: 'Enquiry not found.' });

      const deptFilter = departmentFilterFor(req);
      if (deptFilter && (enquiry.department || '').toLowerCase() !== deptFilter.toLowerCase()) {
        return res.status(403).json({ error: 'You do not have permission to view this enquiry.' });
      }

      const canManage =
        req.authContext.authority === 'full' ||
        req.authContext.permissions.has('staff_enquiries.manage');

      db.get(
        `SELECT admin_username, admin_role, body, created_at
           FROM staff_enquiry_replies
          WHERE enquiry_id = ?
          ORDER BY id DESC LIMIT 1`,
        [id],
        (replyErr, reply) => {
          if (replyErr) return res.status(500).json({ error: replyErr.message });

          if (enquiry.status === 'unread' && canManage) {
            db.run(
              `UPDATE staff_enquiries
                  SET status = 'not replied', updated_at = NOW()
                WHERE id = ?`,
              [id],
              () => {
                db.run(
                  `UPDATE notifications
                      SET is_read = 1
                    WHERE related_request_id = ?
                      AND recipient_type = 'admin'
                      AND is_read = 0`,
                  [id],
                  () => { }
                );
              }
            );
          }

          res.json({ ...enquiry, reply: reply || null });
        }
      );
    });
  }
);

app.post(
  '/api/admin/staff-enquiries/:id/reply',
  requireAuth,
  requirePermission('staff_enquiries.manage'),
  (req, res) => {
    const { id } = req.params;
    const { body } = req.body || {};

    if (!body || !String(body).trim()) {
      return res.status(400).json({ error: 'Reply body is required.' });
    }

    const adminUsername = req.authUser.username;
    const adminRole = req.authContext.role.title;

    db.get(`SELECT * FROM staff_enquiries WHERE id = ?`, [id], (err, enquiry) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!enquiry) return res.status(404).json({ error: 'Enquiry not found.' });

      const deptFilter = departmentFilterFor(req);
      if (deptFilter && (enquiry.department || '').toLowerCase() !== deptFilter.toLowerCase()) {
        return res.status(403).json({ error: 'You do not have permission to reply to this enquiry.' });
      }

      db.run(
        `INSERT INTO staff_enquiry_replies (enquiry_id, admin_username, admin_role, body)
         VALUES (?, ?, ?, ?)`,
        [id, adminUsername, adminRole, String(body).trim()],
        function (replyErr) {
          if (replyErr) return res.status(500).json({ error: replyErr.message });

          db.run(
            `UPDATE staff_enquiries
                SET status = 'replied',
                    staff_viewed_reply_at = NULL,
                    updated_at = NOW()
              WHERE id = ?`,
            [id],
            (updErr) => {
              if (updErr) return res.status(500).json({ error: updErr.message });

              logAudit(
                adminUsername,
                adminRole,
                'STAFF_ENQUIRY_REPLIED',
                id,
                `Replied to enquiry from ${enquiry.staff_name}`
              );

              res.json({
                message: 'Reply sent successfully.',
                replyId: this.lastID,
                staffEmail: enquiry.staff_email,
                staffName: enquiry.staff_name,
                staffFileNo: enquiry.isse_file_no
              });
            }
          );
        }
      );
    });
  }
);

// ==========================================
// SERVER START
// ==========================================

const PORT = process.env.PORT || 5000;

const server = app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`❌ Port ${PORT} is already in use. Stop the other process or set a different PORT.`);
  } else {
    console.error('❌ Server error:', err);
  }
  process.exit(1);
});