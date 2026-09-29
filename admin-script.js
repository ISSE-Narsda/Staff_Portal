// API_BASE resolves automatically:
//   - On localhost:5000  → '/api' (relative, same server)
//   - On localhost:any   → 'http://localhost:5000/api' (dev: Live Server → separate backend)
//   - Anywhere else      → '/api' (production: browser resolves against whatever domain served the page)
const API_BASE = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
  ? (window.location.port === '5000' ? '/api' : 'http://localhost:5000/api')
  : '/api';

// ============================================================
// AUTH TOKEN STORAGE
// ============================================================
// The admin session token is stored under a dedicated key.
// Cleared on logout and on any 401.

function getAdminToken() {
  return sessionStorage.getItem('isse_admin_token');
}

function setAdminToken(token) {
  if (token) sessionStorage.setItem('isse_admin_token', token);
}

function clearAdminToken() {
  sessionStorage.removeItem('isse_admin_token');
}

// ============================================================
// GLOBAL FETCH WRAPPER
// ============================================================
// Every request to our API automatically carries the token.
// Third-party requests pass through untouched. On 401 from a
// non-login endpoint we clear the session and return the user
// to the login modal.

const _originalFetch = window.fetch.bind(window);
window.fetch = function(url, options) {
  const opts = Object.assign({}, options);
  const urlStr = String(url);

  if (urlStr.startsWith(API_BASE)) {
    const token = getAdminToken();
    if (token) {
      opts.headers = Object.assign({}, opts.headers || {});
      opts.headers['Authorization'] = 'Bearer ' + token;
    }
  }

  return _originalFetch(url, opts).then(function(res) {
    if (res.status === 401 && !urlStr.includes('/auth/admin-login')) {
      clearAdminToken();
      sessionStorage.removeItem('currentAdminUser');
      if (typeof showAdminLogin === 'function') showAdminLogin();
    }
    return res;
  });
};
let currentAdminUser = null;
let activeLeaveFilter = 'all';
let activeResumptionFilter = 'all';
let pendingActionData = null;
let dashboardInterval = null;
let heartbeatInterval = null;

let cachedDepartments = [];
let cachedAllStaff = [];
let currentEditDeptId = null;
let currentCalendarYear = new Date().getFullYear();
let currentCalendarMonth = new Date().getMonth();

// ============================================================
// FRONTEND PERMISSION MODEL
// ============================================================
// Sections map to the permission key that unlocks them. A user
// sees a section if they have that permission OR if their role
// has 'full' workflow authority (Super Admin bypass, mirroring
// the backend).

const SECTION_PERMISSIONS = {
  dashboardSection:      null,                    // always visible
  leaveMgmtSection:      'leave.view',
  resumptionMgmtSection: 'resumption.view',
  leaveCalendarSection:  'leave.view',
  attendanceSection:     'attendance.view',
  staffSection:          'staff.view',
  enquiriesSection:      'staff_enquiries.manage',
  departmentsSection:    'departments.manage',
  reportsSection:        'reports.view',
  documentsSection:      'documents.view',
  notificationsSection:  'notifications.view',
  approvalHistorySection:'approval_history.view',
  auditLogSection:       'audit.view',
  settingsSection:       'settings.manage',
  rolesSection:          'settings.manage',
    usersSection:          'settings.manage',
  profileSection:        null                     // always visible
};

// Populated on login and on session restore from GET /auth/session.
let currentAdminPermissions = [];
let currentAdminAuthority = 'none';

function hasFrontendPermission(key) {
  if (!key) return true; // null = always visible
  if (currentAdminAuthority === 'full') return true;
  return currentAdminPermissions.includes(key);
}

function hasSectionAccess(sectionId) {
  const key = SECTION_PERMISSIONS[sectionId];
  return hasFrontendPermission(key);
}

async function loadPermissionsForCurrentUser() {
  // Populated from the login response (see handleAdminLogin) or from
  // GET /api/auth/session on bootstrap. Both write into the two globals.
}

// ================= HELPERS =================

function showAlert(message) {
  const modal = document.getElementById('customModal');
  const modalMsg = document.getElementById('modalMessage');
  if (modal && modalMsg) {
    modalMsg.textContent = message;
    modal.style.display = 'flex';
  } else {
    alert(message);
  }
}

function openModal(id) {
  const el = document.getElementById(id);
  if (el) el.style.display = 'flex';
}

function closeModal(id) {
  const el = document.getElementById(id);
  if (el) el.style.display = 'none';
}

// Converts a Date object OR date string OR Postgres date value into
// the "YYYY-MM-DD" format that <input type="date"> expects.
function formatDateForInput(val) {
  if (!val) return '';
  if (val instanceof Date) {
    const y = val.getFullYear();
    const m = String(val.getMonth() + 1).padStart(2, '0');
    const d = String(val.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const s = String(val);
  return s.length >= 10 ? s.substring(0, 10) : s;
}

function formatDateDisplay(dateStr) {
  if (!dateStr) return 'N/A';
  try {
    const parts = dateStr.split('-');
    if (parts.length === 3) {
      const d = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
      return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
    }
    const d = new Date(dateStr);
    return isNaN(d.getTime()) ? dateStr : d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  } catch (e) {
    return dateStr;
  }
}

// ================= BOOTSTRAP =================

document.addEventListener('DOMContentLoaded', async () => {
  const themeBtn = document.getElementById('themeToggleBtn');
  const themeIcon = document.getElementById('themeIcon');
  if (themeBtn) {
    themeBtn.addEventListener('click', () => {
      document.body.classList.toggle('light-mode');
      document.body.classList.toggle('dark-mode');
      if (themeIcon) themeIcon.textContent = document.body.classList.contains('light-mode') ? '🌙' : '☀️';
    });
  }

  const modal = document.getElementById('customModal');
  const okBtn = document.getElementById('modalOkBtn');
  if (okBtn && modal) okBtn.addEventListener('click', () => modal.style.display = 'none');

  document.getElementById('adminLoginBtn')?.addEventListener('click', handleAdminLogin);
  document.getElementById('adminPasswordInput')?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); handleAdminLogin(); }
  });
  document.getElementById('adminEmailInput')?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); handleAdminLogin(); }
  });  const badgeRole = document.getElementById('officerBadgeRole');
  const badgeUnit = document.getElementById('officerBadgeUnit');
  const avatar = document.getElementById('officerAvatarInitials');
  if (badgeRole) badgeRole.textContent = 'NOT SIGNED IN';
  if (badgeUnit) badgeUnit.textContent = '--';
  if (avatar) avatar.textContent = '--';

  const unitNotice = document.getElementById('adminUnitNotice');
  if (unitNotice) unitNotice.textContent = 'Please sign in to access the dashboard.';

  document.getElementById('adminProfileForm')?.addEventListener('submit', handleProfileUpdate);
    document.getElementById('registerStaffForm')?.addEventListener('submit', handleCreateStaff);
  document.getElementById('staffProfileForm')?.addEventListener('submit', handleUpdateStaffProfile);
  document.getElementById('createDeptForm')?.addEventListener('submit', handleCreateDept);
  document.getElementById('editDeptForm')?.addEventListener('submit', handleUpdateDept);

  const stored = sessionStorage.getItem('currentAdminUser');
  if (stored) {
    try {
      const parsed = JSON.parse(stored);
      const verified = await verifyAdminSession();
      if (verified) {
        currentAdminUser = verified;
        sessionStorage.setItem('currentAdminUser', JSON.stringify(currentAdminUser));
        await hydrateCurrentPermissions();
        hideAdminLogin();
        setupRoleInterface();
        switchAdminTab('dashboardSection');
        startPolling();
      } else {
        sessionStorage.removeItem('currentAdminUser');
        showAdminLogin();
      }
    } catch (e) {
      sessionStorage.removeItem('currentAdminUser');
      showAdminLogin();
    }
  } else {
    showAdminLogin();
  }
});

// ================= SESSION =================

async function verifyAdminSession() {
  try {
    const res = await fetch(`${API_BASE}/auth/session`);
    if (!res.ok) return null;
    const data = await res.json();
    return data.user;
  } catch (e) {
    return null;
  }
}

function showAdminLogin() {
  const modal = document.getElementById('adminLoginModal');
  if (modal) modal.style.display = 'flex';
  document.querySelectorAll('.section-card').forEach(s => s.classList.remove('active'));
  const nav = document.getElementById('adminSidebarNav');
  if (nav) nav.innerHTML = '';
  const roleBadge = document.getElementById('adminUserRoleBadge');
  if (roleBadge) roleBadge.textContent = 'NOT SIGNED IN';
  const unitNotice = document.getElementById('adminUnitNotice');
  if (unitNotice) unitNotice.textContent = 'Please sign in to access the dashboard.';
}

function hideAdminLogin() {
  const modal = document.getElementById('adminLoginModal');
  if (modal) modal.style.display = 'none';
  const errBox = document.getElementById('adminLoginError');
  if (errBox) { errBox.style.display = 'none'; errBox.textContent = ''; }
}

async function handleAdminLogin() {
  const email = document.getElementById('adminEmailInput')?.value.trim();
  const password = document.getElementById('adminPasswordInput')?.value;
  const errorBox = document.getElementById('adminLoginError');

  if (errorBox) { errorBox.style.display = 'none'; errorBox.textContent = ''; }

  if (!email || !password) {
    if (errorBox) { errorBox.textContent = 'Please enter both email and password.'; errorBox.style.display = 'block'; }
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/auth/admin-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });

    const data = await res.json();
    if (!res.ok) {
      if (errorBox) { errorBox.textContent = data.error || 'Login failed.'; errorBox.style.display = 'block'; }
      return;
    }

        currentAdminUser = data.user;
    if (data.token) {
      setAdminToken(data.token);
    }
    sessionStorage.setItem('currentAdminUser', JSON.stringify(currentAdminUser));

    await hydrateCurrentPermissions();

    document.getElementById('adminEmailInput').value = '';
    document.getElementById('adminPasswordInput').value = '';

    hideAdminLogin();
    setupRoleInterface();
    switchAdminTab('dashboardSection');
    startPolling();
  } catch (e) {
    if (errorBox) { errorBox.textContent = 'Cannot reach server. Please try again.'; errorBox.style.display = 'block'; }
  }
}

function startPolling() {
  if (dashboardInterval) clearInterval(dashboardInterval);
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  refreshDashboard();
  sendHeartbeat();
  dashboardInterval = setInterval(refreshDashboard, 10000);
  heartbeatInterval = setInterval(sendHeartbeat, 30000);
}

function sendHeartbeat() {
  if (currentAdminUser && currentAdminUser.id) {
    fetch(`${API_BASE}/admin/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: currentAdminUser.id })
    }).catch(() => {});
  }
}

// ================= ROLE INTERFACE =================

function setupRoleInterface() {
  if (!currentAdminUser) return;

  const unitNotice = document.getElementById('adminUnitNotice');
  const roleTitle = currentAdminUser.role || 'Unknown Role';
  const authority = currentAdminUser.authority || 'none';
  const dept = currentAdminUser.department || 'All Units';

  const badgeRole = document.getElementById('officerBadgeRole');
  const badgeUnit = document.getElementById('officerBadgeUnit');
  const avatar = document.getElementById('officerAvatarInitials');

  const initials =
    authority === 'full'  ? 'SA'  :
    authority === 'final' ? 'HOA' :
    authority === 'unit'  ? 'HOU' :
                            'VIEW';

  if (badgeRole) badgeRole.textContent = roleTitle;
  if (badgeUnit) badgeUnit.textContent = dept;
  if (avatar) avatar.textContent = initials;

  if (unitNotice) {
    if (authority === 'unit') {
      unitNotice.textContent = `Scope: ${dept} Unit Scope`;
    } else if (authority === 'full') {
      unitNotice.textContent = 'Scope: Super Admin Global Scope';
    } else if (authority === 'final') {
      unitNotice.textContent = 'Scope: Institutional HOA Master Scope';
    } else {
      unitNotice.textContent = 'Scope: Global Read-Only';
    }
  }

  renderRoleSidebar();
}

function renderRoleSidebar() {
  const nav = document.getElementById('adminSidebarNav');
  if (!nav || !currentAdminUser) return;

  function item(id, sectionId, label, badgeId) {
    if (!hasSectionAccess(sectionId)) return '';
    const badge = badgeId ? `<span id="${badgeId}" class="nav-badge badge-amber" style="display:none;">0</span>` : '';
    return `
      <div class="nav-item" id="${id}" onclick="switchAdminTab('${sectionId}')">
        <span>${label}</span>
        ${badge}
      </div>`;
  }

  let navHtml = '';

  // Always visible
  navHtml += item('navDashboard', 'dashboardSection', 'Dashboard');

    // Core operational
  navHtml += item('navLeaveMgmt',        'leaveMgmtSection',        'Leave Management', 'badgePendingLeave');
  navHtml += item('navResumptionMgmt',   'resumptionMgmtSection',   'Resumption Management', 'badgePendingResumption');
  navHtml += item('navLeaveCalendar',    'leaveCalendarSection',    'Leave Calendar');
  navHtml += item('navAttendance',       'attendanceSection',       'Attendance');
  navHtml += item('navStaff',            'staffSection',            'Staff Directory');

  // Communication
  navHtml += item('navEnquiries',        'enquiriesSection',        'Enquiries', 'badgeStaffEnquiries');

  // Administrative
  navHtml += item('navDepartments',      'departmentsSection',      'Departments & Units');

  // Reports & documents
  navHtml += item('navReports',          'reportsSection',          'Reports & Analytics');
  navHtml += item('navDocuments',        'documentsSection',        'HR Documents');

  // System
  navHtml += item('navApprovalHistory',  'approvalHistorySection',  'Approval History');
  navHtml += item('navAuditLog',         'auditLogSection',         'Audit Logs');
  navHtml += item('navSettings',         'settingsSection',         'Settings');
  navHtml += item('navRoles',            'rolesSection',            'Roles & Permissions');
  navHtml += item('navUsers',            'usersSection',            'User Accounts');

  nav.innerHTML = navHtml;
}

// ================= TAB SWITCHER =================

function switchAdminTab(tabId) {
  if (!currentAdminUser) { showAdminLogin(); return; }

  if (!hasSectionAccess(tabId)) {
    showAlert('Access Denied: Your role does not have permission to view this section.');
    return;
  }

      // Clear .active from EVERY section card actually present in the DOM,
  // rather than a hardcoded list that has to be kept in sync. Any new
  // section added to admin.html is picked up automatically — no risk of
  // forgetting to add it here and having it stack on top of the next page.
  document.querySelectorAll('.section-card').forEach(el => {
    el.classList.remove('active');
  });

  const target = document.getElementById(tabId);
  if (target) target.classList.add('active');

  document.querySelectorAll('#adminSidebarNav .nav-item').forEach(item => item.classList.remove('active'));
  const activeNavId = 'nav' + tabId.replace('Section', '').charAt(0).toUpperCase() + tabId.replace('Section', '').slice(1);
  const activeNavItem = document.getElementById(activeNavId);
  if (activeNavItem) activeNavItem.classList.add('active');

      if (tabId === 'leaveCalendarSection') renderLeaveCalendar();
  else if (tabId === 'attendanceSection') initAttendancePage();
  else if (tabId === 'staffSection') loadStaffTable();
  else if (tabId === 'enquiriesSection') {
    // The full page lands in Step 5. The guard keeps the tab safe
    // to click in the meantime so nothing errors out.
    if (typeof loadStaffEnquiriesPage === 'function') loadStaffEnquiriesPage();
  }
  else if (tabId === 'departmentsSection') loadDepartmentsTable();
  else if (tabId === 'reportsSection') loadReports();
  else if (tabId === 'documentsSection') loadDocumentsTable();
  else if (tabId === 'notificationsSection') loadNotificationsList();
  else if (tabId === 'approvalHistorySection') loadApprovalHistory();
  else if (tabId === 'auditLogSection') loadAuditLogs();
    else if (tabId === 'profileSection') loadProfileSection();
  else if (tabId === 'rolesSection') loadRolesPage();
    else if (tabId === 'usersSection') loadUsersPage();
}

// ================= DASHBOARD =================

function refreshDashboard() {
  if (!currentAdminUser) return;
  loadDashboardMetrics();
  loadLeaveMgmtTable(activeLeaveFilter);
  loadResumptionMgmtTable(activeResumptionFilter);
  refreshNotifBadge();
  refreshStaffEnquiriesBadge();
}

function loadDashboardMetrics() {
  const role = currentAdminUser.role;
  const dept = currentAdminUser.department;

  // 1. Load the stat cards
  fetch(`${API_BASE}/admin/dashboard-stats?role=${role}&department=${encodeURIComponent(dept || '')}`)
    .then(res => res.json())
    .then(stats => {
      const container = document.getElementById('dashboardMetricsContainer');
      if (!container) return;

      let html = '';
      const authority = currentAdminUser.authority || 'none';

      if (authority === 'full') {
        html = `
          <div class="admin-metric-card"><div class="admin-metric-title">Total Staff</div><div class="admin-metric-value" style="color: #16A34A;">${stats.totalStaff}</div><div class="admin-metric-sub">Registered Profiles</div></div>
          <div class="admin-metric-card"><div class="admin-metric-title">Departments</div><div class="admin-metric-value" style="color: #0284C7;">${stats.totalDepartments}</div><div class="admin-metric-sub">Active Units</div></div>
          <div class="admin-metric-card"><div class="admin-metric-title">Pending HOU Endorsements</div><div class="admin-metric-value" style="color: #F59E0B;">${stats.pendingApprovals}</div><div class="admin-metric-sub">Awaiting Unit Action</div></div>
          <div class="admin-metric-card"><div class="admin-metric-title">Pending HOA Approval</div><div class="admin-metric-value" style="color: #EAB308;">${stats.pendingHoaApprovals || 0}</div><div class="admin-metric-sub">Awaiting Final Clearance</div></div>
          <div class="admin-metric-card"><div class="admin-metric-title">Pending Resumptions</div><div class="admin-metric-value" style="color: #D4A843;">${stats.pendingResumptions}</div><div class="admin-metric-sub">Duty Return Notices</div></div>
          <div class="admin-metric-card"><div class="admin-metric-title">Approved Leaves</div><div class="admin-metric-value" style="color: #16A34A;">${stats.approvedLeaves}</div><div class="admin-metric-sub">Granted Applications</div></div>
          <div class="admin-metric-card"><div class="admin-metric-title">Currently On Leave</div><div class="admin-metric-value" style="color: #3B82F6;">${stats.staffOnLeave}</div><div class="admin-metric-sub">Active Absences</div></div>
        `;
      } else if (authority === 'unit') {
        html = `
          <div class="admin-metric-card"><div class="admin-metric-title">Pending Leave Endorsements</div><div class="admin-metric-value" style="color: #F59E0B;">${stats.pendingApprovals}</div><div class="admin-metric-sub">${dept} Department</div></div>
          <div class="admin-metric-card"><div class="admin-metric-title">Pending Duty Resumptions</div><div class="admin-metric-value" style="color: #EAB308;">${stats.pendingResumptions}</div><div class="admin-metric-sub">Return Validations</div></div>
          <div class="admin-metric-card"><div class="admin-metric-title">Department Staff On Leave</div><div class="admin-metric-value" style="color: #0284C7;">${stats.staffOnLeave}</div><div class="admin-metric-sub">Authorized Absences</div></div>
          <div class="admin-metric-card"><div class="admin-metric-title">Department Approved Leaves</div><div class="admin-metric-value" style="color: #16A34A;">${stats.approvedLeaves}</div><div class="admin-metric-sub">Total Endorsed</div></div>
        `;
      } else if (authority === 'final') {
        html = `
          <div class="admin-metric-card"><div class="admin-metric-title">Pending Final Leave Clearance</div><div class="admin-metric-value" style="color: #F59E0B;">${stats.pendingHoaApprovals}</div><div class="admin-metric-sub">HOU-Endorsed Applications</div></div>
          <div class="admin-metric-card"><div class="admin-metric-title">Pending Final Resumptions</div><div class="admin-metric-value" style="color: #EAB308;">${stats.pendingResumptions}</div><div class="admin-metric-sub">HOU-Verified Return Notices</div></div>
          <div class="admin-metric-card"><div class="admin-metric-title">Total Staff On Leave</div><div class="admin-metric-value" style="color: #0284C7;">${stats.staffOnLeave}</div><div class="admin-metric-sub">Institutional Absences</div></div>
          <div class="admin-metric-card"><div class="admin-metric-title">Total Approved Leaves</div><div class="admin-metric-value" style="color: #16A34A;">${stats.approvedLeaves}</div><div class="admin-metric-sub">Granted Clearances</div></div>
        `;
      }
      container.innerHTML = html;

      const bLeave = document.getElementById('badgePendingLeave');
      const bRes = document.getElementById('badgePendingResumption');
      if (bLeave) { bLeave.textContent = stats.pendingApprovals || 0; bLeave.style.display = stats.pendingApprovals > 0 ? 'inline-block' : 'none'; }
      if (bRes) { bRes.textContent = stats.pendingResumptions || 0; bRes.style.display = stats.pendingResumptions > 0 ? 'inline-block' : 'none'; }
    })
    .catch(err => console.error('Dashboard Stats Error:', err));

  // 2. Load Pending Workflow Applications Preview
  fetch(`${API_BASE}/leave/applications?statusFilter=pending_hou`)
    .then(res => res.json())
    .then(rows => {
      const container = document.getElementById('dashboardPendingPreview');
      if (!container) return;
      if (!rows || rows.length === 0) {
        container.innerHTML = '<p style="color: var(--text-muted); font-size: 0.85rem;">No pending applications at this time.</p>';
        return;
      }
      container.innerHTML = rows.slice(0, 5).map(r => `
        <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--border-color);">
          <div>
            <strong style="color: var(--accent-gold); font-size: 0.9rem;">#LA-${r.id}</strong>
            <span style="font-size: 0.85rem; margin-left: 8px;">${r.full_name}</span>
            <div style="font-size: 0.75rem; color: var(--text-muted);">${r.department} • ${r.leave_type}</div>
          </div>
          <button class="action-btn btn-edit" style="padding: 2px 8px; font-size: 0.7rem;" onclick="switchAdminTab('leaveMgmtSection')">View</button>
        </div>
      `).join('');
    })
    .catch(() => {
      document.getElementById('dashboardPendingPreview').innerHTML = '<p style="color: var(--text-muted); font-size: 0.85rem;">Could not load pending actions.</p>';
    });

  // 3. Load Recent System Activity Preview
  fetch(`${API_BASE}/admin/audit-log`)
    .then(res => res.json())
    .then(logs => {
      const container = document.getElementById('dashboardActivityPreview');
      if (!container) return;
      if (!logs || logs.length === 0) {
        container.innerHTML = '<p style="color: var(--text-muted); font-size: 0.85rem;">No recent activity.</p>';
        return;
      }
      container.innerHTML = logs.slice(0, 5).map(l => `
        <div style="border-bottom: 1px solid var(--border-color); padding: 6px 0; font-size: 0.8rem;">
          <span style="color: var(--accent-gold); font-weight: bold;">[${l.created_at.split(' ')[1] || l.created_at}]</span>
          <strong>${l.actor}</strong> — ${l.action}
        </div>
      `).join('');
    })
    .catch(() => {
      document.getElementById('dashboardActivityPreview').innerHTML = '<p style="color: var(--text-muted); font-size: 0.85rem;">Could not load recent activity.</p>';
    });
}

// ================= LEAVE MANAGEMENT =================

// Fetch the attachment with the admin Bearer token, then open it as a blob URL.
// (Direct links in a new tab would lose the Authorization header.)
async function viewLeaveAttachment(attachmentId) {
  try {
    const res = await fetch(`${API_BASE}/leave/attachment/${attachmentId}`);
    if (!res.ok) {
      let msg = 'Could not load attachment.';
      try { const j = await res.json(); msg = j.error || msg; } catch (_) {}
      showAlert(msg);
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (err) {
    showAlert('Could not open attachment: ' + err.message);
  }
}

function filterLeaveMgmt(filter, btn) {
  activeLeaveFilter = filter;
  document.querySelectorAll('#leaveMgmtSection .sub-filter-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  loadLeaveMgmtTable(filter);
}

function loadLeaveMgmtTable(statusFilter = 'all') {
  const tbody = document.getElementById('leaveMgmtTableBody');
  if (!tbody || !currentAdminUser) return;

  const role = currentAdminUser.role;
  const dept = currentAdminUser.department;

  fetch(`${API_BASE}/leave/applications?role=${role}&department=${encodeURIComponent(dept || '')}&statusFilter=${statusFilter}`)
    .then(res => res.json())
    .then(rows => {
      if (!rows || rows.length === 0) {
        tbody.innerHTML = '<tr><td colspan="9" style="text-align: center; color: var(--text-muted);">No leave applications found for this view.</td></tr>';
        return;
      }

      tbody.innerHTML = rows.map(r => {
        let badgeClass = 'badge-pending';
        if (r.overall_status === 'HEAD OF ADMIN APPROVED') badgeClass = 'badge-approved';
        else if (r.overall_status.includes('REJECTED')) badgeClass = 'badge-rejected';

        let actionBtns = '';
        const authority = currentAdminUser.authority || 'none';

        // Super Admin (full) can act at ANY stage of the workflow
        if (authority === 'full') {
          if (r.hou_status === 'PENDING') {
            actionBtns = `
              <button class="action-btn btn-approve" onclick="confirmLeaveAction(${r.id}, 'APPROVE', 'HOU')">Endorse (Admin)</button>
              <button class="action-btn btn-reject" onclick="confirmLeaveAction(${r.id}, 'REJECT', 'HOU')">Reject</button>
            `;
          } else if (r.hou_status === 'APPROVED' && r.admin_status === 'PENDING') {
            actionBtns = `
              <button class="action-btn btn-approve" onclick="confirmLeaveAction(${r.id}, 'APPROVE', 'HOA')">Grant Approval (Admin)</button>
              <button class="action-btn btn-reject" onclick="confirmLeaveAction(${r.id}, 'REJECT', 'HOA')">Reject</button>
            `;
          }
        } 
        // HOU (unit) can only endorse when pending HOU
        else if (authority === 'unit' && r.hou_status === 'PENDING') {
          actionBtns = `
            <button class="action-btn btn-approve" onclick="confirmLeaveAction(${r.id}, 'APPROVE', 'HOU')">Endorse</button>
            <button class="action-btn btn-reject" onclick="confirmLeaveAction(${r.id}, 'REJECT', 'HOU')">Reject</button>
          `;
        } 
        // HOA (final) can only grant final approval when pending HOA
        else if (authority === 'final' && r.hou_status === 'APPROVED' && r.admin_status === 'PENDING') {
          actionBtns = `
            <button class="action-btn btn-approve" onclick="confirmLeaveAction(${r.id}, 'APPROVE', 'HOA')">Grant Approval</button>
            <button class="action-btn btn-reject" onclick="confirmLeaveAction(${r.id}, 'REJECT', 'HOA')">Reject</button>
          `;
        }

        if (r.overall_status === 'HEAD OF ADMIN APPROVED') {
          actionBtns += `<button class="action-btn btn-download" onclick="downloadApplication(${r.id})">📄 Slip</button>`;
        }

        const remarksHtml = r.staff_remarks
          ? `<span style="font-size:0.78rem; color: var(--text-muted); font-style: italic; display:inline-block; max-width:180px; word-wrap:break-word;">${r.staff_remarks}</span>`
          : `<span style="color:var(--text-muted); font-size:0.75rem;">—</span>`;

        const attachmentHtml = r.attachment_id
          ? `<button class="action-btn btn-download" style="padding: 3px 8px; font-size: 0.72rem;" onclick="viewLeaveAttachment(${r.attachment_id})">📎 View</button>`
          : `<span style="color:var(--text-muted); font-size:0.75rem;">—</span>`;

        return `
          <tr>
            <td>#LA-${r.id}</td>
            <td><strong>${r.full_name}</strong><br><small style="color:var(--accent-gold);">${r.isse_file_no}</small></td>
            <td><span class="dept-badge">${r.department}</span></td>
            <td>${r.leave_type}</td>
            <td>${formatDateDisplay(r.start_date)} to ${formatDateDisplay(r.end_date)} (${r.total_days})</td>
            <td><span class="status-badge ${badgeClass}">${r.overall_status}</span></td>
            <td>${remarksHtml}</td>
            <td>${attachmentHtml}</td>
            <td>${actionBtns || '<span style="color:var(--text-muted); font-size:0.75rem;">Completed</span>'}</td>
          </tr>
        `;
      }).join('');
    })
    .catch(err => {
      console.error('Leave Mgmt Load Error:', err);
      tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: #DC2626;">Failed to load leave records.</td></tr>';
    });
}

// ================= RESUMPTION MANAGEMENT =================

function filterResumptionMgmt(filter, btn) {
  activeResumptionFilter = filter;
  document.querySelectorAll('#resumptionMgmtSection .sub-filter-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  loadResumptionMgmtTable(filter);
}

function loadResumptionMgmtTable(filter = 'all') {
  const tbody = document.getElementById('resumptionMgmtTableBody');
  if (!tbody || !currentAdminUser) return;

  const role = currentAdminUser.role;
  const dept = currentAdminUser.department;

  fetch(`${API_BASE}/leave/resumption-queue?role=${role}&department=${encodeURIComponent(dept || '')}`)
    .then(res => res.json())
    .then(rows => {
      if (!rows || rows.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" style="text-align: center; color: var(--text-muted);">No resumption requests pending in queue.</td></tr>';
        return;
      }

      tbody.innerHTML = rows.map(r => {
        let badgeClass = 'badge-pending';
        if (r.resumption_status === 'RESUMPTION APPROVED') badgeClass = 'badge-approved';
        else if (r.resumption_status.includes('REJECTED')) badgeClass = 'badge-rejected';

        let actionBtns = '';
        const authority = currentAdminUser.authority || 'none';
        const resStatusUpper = (r.resumption_status || '').toUpperCase();
        const houResStatusUpper = (r.hou_resumption_status || '').toUpperCase();

        // Only show action buttons if the resumption is still in-progress
        // (Hide completely once fully approved or rejected)
        const isFullyProcessed =
          resStatusUpper === 'RESUMPTION APPROVED' ||
          resStatusUpper.includes('REJECTED');

        if (!isFullyProcessed) {

          // Super Admin (full) — can act at BOTH stages
          if (authority === 'full') {
            if (resStatusUpper === 'PENDING HOU RESUMPTION APPROVAL') {
              actionBtns = `
                <button class="action-btn btn-approve" onclick="confirmResumptionAction(${r.id}, 'APPROVE', 'HOU')">Validate Return (Admin)</button>
                <button class="action-btn btn-reject" onclick="confirmResumptionAction(${r.id}, 'REJECT', 'HOU')">Reject Return</button>
              `;
            } else if (resStatusUpper === 'PENDING HOA RESUMPTION APPROVAL' || houResStatusUpper === 'VERIFIED') {
              actionBtns = `
                <button class="action-btn btn-approve" onclick="confirmResumptionAction(${r.id}, 'APPROVE', 'HOA')">Final Clearance (Admin)</button>
                <button class="action-btn btn-reject" onclick="confirmResumptionAction(${r.id}, 'REJECT', 'HOA')">Reject</button>
              `;
            }
          }
          // HOU (unit) — only HOU stage
          else if (authority === 'unit' && resStatusUpper === 'PENDING HOU RESUMPTION APPROVAL') {
            actionBtns = `
              <button class="action-btn btn-approve" onclick="confirmResumptionAction(${r.id}, 'APPROVE', 'HOU')">Validate Return</button>
              <button class="action-btn btn-reject" onclick="confirmResumptionAction(${r.id}, 'REJECT', 'HOU')">Reject Return</button>
            `;
          }
          // HOA (final) — only HOA stage
          else if (authority === 'final' && (resStatusUpper === 'PENDING HOA RESUMPTION APPROVAL' || houResStatusUpper === 'VERIFIED')) {
            actionBtns = `
              <button class="action-btn btn-approve" onclick="confirmResumptionAction(${r.id}, 'APPROVE', 'HOA')">Final Clearance</button>
              <button class="action-btn btn-reject" onclick="confirmResumptionAction(${r.id}, 'REJECT', 'HOA')">Reject</button>
            `;
          }
        }

        let downloadBtn = r.resumption_status === 'RESUMPTION APPROVED' ?
          `<button class="action-btn btn-download" onclick="downloadResumptionSlip(${r.id})">📄 Resumption Slip</button>` :
          `<span style="color:var(--text-muted); font-size:0.75rem;">Locked until HOA Clearance</span>`;

        return `
          <tr>
            <td>#RS-${r.id}</td>
            <td><strong>${r.full_name}</strong><br><small style="color:var(--accent-gold);">${r.isse_file_no}</small></td>
            <td><span class="dept-badge">${r.department}</span></td>
            <td>${r.leave_type}</td>
            <td>${formatDateDisplay(r.resumption_date)}</td>
            <td><span class="status-badge ${badgeClass}">${r.resumption_status}</span></td>
            <td>${downloadBtn}</td>
            <td>${actionBtns || '<span style="color:var(--text-muted); font-size:0.75rem;">Processed</span>'}</td>
          </tr>
        `;
      }).join('');
    })
    .catch(err => {
      console.error('Resumption Mgmt Error:', err);
      tbody.innerHTML = '<tr><td colspan="8" style="text-align: center; color: #DC2626;">Failed to load resumption records.</td></tr>';
    });
}

// ================= ACTION CONFIRMATION =================

function confirmLeaveAction(requestId, action, targetRole) {
  pendingActionData = { type: 'LEAVE', requestId, action, targetRole };
  const title = document.getElementById('actionModalTitle');
  const prompt = document.getElementById('actionModalPrompt');
  const remarksGroup = document.getElementById('rejectionReasonGroup');
  const confirmBtn = document.getElementById('actionModalConfirmBtn');

  if (title) title.textContent = `Confirm ${action === 'APPROVE' ? 'Approval' : 'Rejection'}`;
  if (prompt) prompt.textContent = `Are you sure you want to ${action.toLowerCase()} Leave Application #LA-${requestId} as ${targetRole}?`;
  if (remarksGroup) remarksGroup.style.display = action === 'REJECT' ? 'block' : 'none';
  if (document.getElementById('actionModalRemarks')) document.getElementById('actionModalRemarks').value = '';

  if (confirmBtn) {
    confirmBtn.className = action === 'APPROVE' ? 'action-btn btn-approve' : 'action-btn btn-reject';
    confirmBtn.onclick = executePendingAction;
  }
  openModal('actionConfirmModal');
}

function confirmResumptionAction(requestId, action, targetRole) {
  pendingActionData = { type: 'RESUMPTION', requestId, action, targetRole };
  const title = document.getElementById('actionModalTitle');
  const prompt = document.getElementById('actionModalPrompt');
  const remarksGroup = document.getElementById('rejectionReasonGroup');
  const confirmBtn = document.getElementById('actionModalConfirmBtn');

  if (title) title.textContent = `Confirm Duty Resumption ${action === 'APPROVE' ? 'Approval' : 'Rejection'}`;
  if (prompt) prompt.textContent = `Are you sure you want to ${action.toLowerCase()} Duty Resumption Notice #RS-${requestId} as ${targetRole}?`;
  if (remarksGroup) remarksGroup.style.display = action === 'REJECT' ? 'block' : 'none';
  if (document.getElementById('actionModalRemarks')) document.getElementById('actionModalRemarks').value = '';

  if (confirmBtn) {
    confirmBtn.className = action === 'APPROVE' ? 'action-btn btn-approve' : 'action-btn btn-reject';
    confirmBtn.onclick = executePendingAction;
  }
  openModal('actionConfirmModal');
}

function closeActionModal() {
  closeModal('actionConfirmModal');
  pendingActionData = null;
}

function executePendingAction() {
  if (!pendingActionData) return;

  const remarksEl = document.getElementById('actionModalRemarks');
  const remarks = remarksEl ? remarksEl.value.trim() : '';

  if (pendingActionData.action === 'REJECT' && !remarks) {
    alert('Please provide a reason for rejection.');
    return;
  }

  let endpoint = '';
  if (pendingActionData.type === 'LEAVE') {
    endpoint = pendingActionData.targetRole === 'HOU' ? '/leave/hou-action' : '/leave/admin-action';
  } else {
    endpoint = pendingActionData.targetRole === 'HOU' ? '/leave/hou-validate-resumption' : '/leave/hoa-validate-resumption';
  }

  fetch(`${API_BASE}${endpoint}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requestId: pendingActionData.requestId,
      status: pendingActionData.action === 'APPROVE' ? 'APPROVED' : 'REJECTED',
      remarks: remarks
    })
  })
  .then(res => res.json())
  .then(data => {
    closeActionModal();
    showAlert(data.message || 'Action processed successfully.');
    refreshDashboard();
  })
  .catch(err => {
    console.error('Action Execution Error:', err);
    showAlert('Failed to process action.');
  });
}

// ================= LEAVE CALENDAR =================

function padTwo(n) { return String(n).padStart(2, '0'); }

function localDateStr(d) {
  return `${d.getFullYear()}-${padTwo(d.getMonth() + 1)}-${padTwo(d.getDate())}`;
}

function safeParseDate(dateStr) {
  if (!dateStr) return null;
  const parts = String(dateStr).split('-');
  if (parts.length !== 3) return null;
  const d = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
  return isNaN(d.getTime()) ? null : d;
}

function calendarPrevMonth() {
  currentCalendarMonth--;
  if (currentCalendarMonth < 0) { currentCalendarMonth = 11; currentCalendarYear--; }
  renderLeaveCalendar();
}

function calendarNextMonth() {
  currentCalendarMonth++;
  if (currentCalendarMonth > 11) { currentCalendarMonth = 0; currentCalendarYear++; }
  renderLeaveCalendar();
}

async function renderLeaveCalendar() {
  const container = document.getElementById('calendarContainer');
  if (!container || !currentAdminUser) return;

  try {
    const dRes = await fetch(`${API_BASE}/admin/departments`);
    if (dRes.ok) {
      cachedDepartments = await dRes.json();
      populateCalendarDeptFilter();
    }
  } catch (e) { }

  const filterSelect = document.getElementById('calendarDeptFilter');
  const authority = currentAdminUser.authority || 'none';

  let useDept = '';
  if (authority === 'unit') {
    useDept = currentAdminUser.department || '';
    if (filterSelect) { filterSelect.value = useDept; filterSelect.disabled = true; }
  } else {
    if (filterSelect) filterSelect.disabled = false;
    const selected = filterSelect ? filterSelect.value : 'All Units';
    if (selected && selected !== 'All Units') useDept = selected;
  }

  const url = `${API_BASE}/admin/calendar-events${useDept ? '?department=' + encodeURIComponent(useDept) : ''}`;

  const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const monthLabel = document.getElementById('calendarMonthLabel');
  if (monthLabel) monthLabel.textContent = `${monthNames[currentCalendarMonth]} ${currentCalendarYear}`;

  fetch(url)
    .then(res => res.json())
    .then(events => {
      const year = currentCalendarYear;
      const month = currentCalendarMonth;

      const dayMap = {};
      (events || []).forEach(ev => {
        const start = safeParseDate(ev.start_date);
        const end = safeParseDate(ev.end_date);
        if (!start || !end) return;

        const cursor = new Date(start);
        const endTime = end.getTime();
        while (cursor.getTime() <= endTime) {
          if (cursor.getFullYear() === year && cursor.getMonth() === month) {
            const key = localDateStr(cursor);
            (dayMap[key] = dayMap[key] || []).push(ev);
          }
          cursor.setDate(cursor.getDate() + 1);
        }
      });

      const firstOfMonth = new Date(year, month, 1);
      const daysInMonth = new Date(year, month + 1, 0).getDate();
      const startDayOfWeek = firstOfMonth.getDay();
      const todayStr = localDateStr(new Date());

      const daysOfWeek = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      let html = daysOfWeek.map(d => `<div class="calendar-day-header">${d}</div>`).join('');

      for (let i = 0; i < startDayOfWeek; i++) {
        html += `<div class="calendar-cell calendar-cell-empty"></div>`;
      }

      for (let dayNum = 1; dayNum <= daysInMonth; dayNum++) {
        const d = new Date(year, month, dayNum);
        const key = localDateStr(d);
        const wd = d.getDay();
        const isWeekend = (wd === 0 || wd === 6);
        const isToday = (key === todayStr);

        const dayEvents = dayMap[key] || [];
        const shown = dayEvents.slice(0, 3);
        const moreCount = dayEvents.length - shown.length;

        const pills = shown.map(ev =>
          `<div class="calendar-event-pill" title="${ev.full_name} — ${ev.leave_type} (${ev.department})">${ev.full_name} — ${ev.leave_type}</div>`
        ).join('');

        const moreBadge = moreCount > 0
          ? `<div style="font-size:0.66rem;color:var(--text-muted);padding:2px 4px;">+${moreCount} more</div>`
          : '';

        let cellClass = 'calendar-cell';
        if (isWeekend) cellClass += ' calendar-cell-weekend';
        if (isToday)   cellClass += ' calendar-cell-today';

        html += `
          <div class="${cellClass}">
            <div class="day-num">${dayNum}</div>
            ${pills}
            ${moreBadge}
          </div>
        `;
      }

      const totalCells = startDayOfWeek + daysInMonth;
      const trailingBlanks = (7 - (totalCells % 7)) % 7;
      for (let i = 0; i < trailingBlanks; i++) {
        html += `<div class="calendar-cell calendar-cell-empty"></div>`;
      }

      container.innerHTML = html;
    })
    .catch(() => {
      container.innerHTML = '<p style="color: var(--text-muted);">Unable to load calendar events.</p>';
    });
}

// ================= STAFF DIRECTORY =================

function loadStaffTable() {
  const tbody = document.getElementById('staffTableBody');
  if (!tbody || !currentAdminUser) return;

  fetch(`${API_BASE}/admin/staff?department=${encodeURIComponent(currentAdminUser.department || '')}`)
    .then(res => res.json())
    .then(staff => {
      cachedAllStaff = staff || [];
      populateStaffDeptFilter();
      applyStaffFilters();
    })
    .catch(err => {
      console.error('Staff Load Error:', err);
      tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: #DC2626;">Failed to load staff records.</td></tr>';
    });
}

function populateStaffDeptFilter() {
  const sel = document.getElementById('staffDeptFilter');
  if (!sel) return;
  const current = sel.value;
  const depts = [...new Set(cachedAllStaff.map(s => s.department).filter(Boolean))].sort();
  let html = '<option value="">All Departments</option>';
  depts.forEach(d => { html += `<option value="${d}">${d}</option>`; });
  sel.innerHTML = html;
  sel.value = current;
}

function resetStaffFilters() {
  const search = document.getElementById('staffSearchInput');
  const dept = document.getElementById('staffDeptFilter');
  const gender = document.getElementById('staffGenderFilter');
  const sort = document.getElementById('staffSortSelect');
  if (search) search.value = '';
  if (dept) dept.value = '';
  if (gender) gender.value = '';
  if (sort) sort.value = 'name_asc';
  applyStaffFilters();
}

function applyStaffFilters() {
  const tbody = document.getElementById('staffTableBody');
  if (!tbody) return;

  const searchEl  = document.getElementById('staffSearchInput');
  const deptEl    = document.getElementById('staffDeptFilter');
  const genderEl  = document.getElementById('staffGenderFilter');
  const sortEl    = document.getElementById('staffSortSelect');

  const search       = (searchEl ? searchEl.value : '').trim().toLowerCase();
  const deptFilter   = deptEl ? deptEl.value : '';
  const genderFilter = genderEl ? genderEl.value : '';
  const sortKey      = sortEl ? sortEl.value : 'name_asc';

  let rows = cachedAllStaff.slice();

  // ---- Filter ----
  if (search) {
    rows = rows.filter(s => {
      return (
        (s.isse_file_no || '').toLowerCase().includes(search) ||
        (s.full_name || '').toLowerCase().includes(search) ||
        (s.designation || '').toLowerCase().includes(search) ||
        (s.grade_level || '').toLowerCase().includes(search) ||
        (s.department || '').toLowerCase().includes(search) ||
        (s.official_email || '').toLowerCase().includes(search)
      );
    });
  }
  if (deptFilter)   rows = rows.filter(s => (s.department || '') === deptFilter);
  if (genderFilter) rows = rows.filter(s => (s.gender || 'Male') === genderFilter);

  // ---- Sort ----
  const extractGL = (gl) => {
    const n = parseInt(String(gl || '').replace(/[^0-9]/g, ''), 10);
    return isNaN(n) ? 0 : n;
  };
  const cmp = {
    name_asc:   (a, b) => (a.full_name || '').localeCompare(b.full_name || ''),
    name_desc:  (a, b) => (b.full_name || '').localeCompare(a.full_name || ''),
    file_asc:   (a, b) => (a.isse_file_no || '').localeCompare(b.isse_file_no || ''),
    file_desc:  (a, b) => (b.isse_file_no || '').localeCompare(a.isse_file_no || ''),
    dept_asc:   (a, b) => (a.department || '').localeCompare(b.department || ''),
    gender_asc: (a, b) => (a.gender || '').localeCompare(b.gender || ''),
    gl_desc:    (a, b) => extractGL(b.grade_level) - extractGL(a.grade_level),
    gl_asc:     (a, b) => extractGL(a.grade_level) - extractGL(b.grade_level)
  };
  rows.sort(cmp[sortKey] || cmp.name_asc);

  // ---- Count indicator ----
  const countEl = document.getElementById('staffFilterCount');
  if (countEl) {
    const total = cachedAllStaff.length;
    const filtering = search || deptFilter || genderFilter;
    countEl.textContent = filtering
      ? `Showing ${rows.length} of ${total} staff`
      : `${total} staff total`;
  }

  // ---- Render ----
  if (rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" style="text-align: center; color: var(--text-muted);">No staff match the current filters.</td></tr>';
    return;
  }

    tbody.innerHTML = rows.map(s => `
    <tr>
      <td><strong>${s.isse_file_no}</strong></td>
      <td style="white-space: nowrap;">${s.full_name}</td>
      <td><span class="dept-badge">${s.department}</span></td>
      <td>${s.designation}<br><small style="color: var(--text-muted);">(${s.grade_level})</small></td>
      <td>${s.gender || 'Male'}</td>
      <td>${s.official_email || '—'}</td>
      <td>${s.last_promotion_date ? formatDateDisplay(formatDateForInput(s.last_promotion_date)) : '—'}</td>
      <td>${s.next_promotion_date ? formatDateDisplay(formatDateForInput(s.next_promotion_date)) : '—'}</td>
      <td>
        <button class="action-btn btn-edit" onclick="openStaffProfileModal(${s.id})">View Profile</button>
      </td>
    </tr>
  `).join('');
}

function openAddStaffModal() {
  ['staffRegFileNo','staffRegFullName','staffRegDesignation','staffRegGradeLevel','staffRegEmail'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  const genderSel = document.getElementById('staffRegGender');
  if (genderSel) genderSel.value = 'Male';
  const lastPromoEl = document.getElementById('staffRegLastPromotion');
  if (lastPromoEl) lastPromoEl.value = '';
  const nextPromoEl = document.getElementById('staffRegNextPromotion');
  if (nextPromoEl) nextPromoEl.value = '';

  const deptSel = document.getElementById('staffRegDepartment');
  if (deptSel) deptSel.innerHTML = '<option value="">-- Select Department --</option>';

  fetch(`${API_BASE}/admin/departments`)
    .then(res => res.json())
    .then(depts => {
      if (deptSel) {
        depts.forEach(d => {
          deptSel.innerHTML += `<option value="${d.name}">${d.name} (${d.code})</option>`;
        });
      }
    })
    .catch(() => {});

  openModal('registerStaffModal');
}

function handleCreateStaff(e) {
  e.preventDefault();

  const isseFileNo = document.getElementById('staffRegFileNo')?.value.trim();
  const fullName = document.getElementById('staffRegFullName')?.value.trim();
  const department = document.getElementById('staffRegDepartment')?.value;
  const designation = document.getElementById('staffRegDesignation')?.value.trim();
  const gradeLevel = document.getElementById('staffRegGradeLevel')?.value.trim();
  const gender = document.getElementById('staffRegGender')?.value;
  const officialEmail = document.getElementById('staffRegEmail')?.value.trim();
  const lastPromotionDate = document.getElementById('staffRegLastPromotion')?.value || null;
  const nextPromotionDate = document.getElementById('staffRegNextPromotion')?.value || null;

  if (!isseFileNo || !fullName || !department || !designation || !gradeLevel) {
    showAlert('Please fill in all required fields.');
    return;
  }

  fetch(`${API_BASE}/admin/staff`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      isseFileNo, fullName, department, designation, gradeLevel,
      officialEmail, gender,
      lastPromotionDate, nextPromotionDate
    })
  })
    .then(async res => {
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to register staff.');
      return data;
    })
    .then(data => {
      closeModal('registerStaffModal');
      showAlert(data.message || 'Staff registered successfully.');
      loadStaffTable();
      loadDepartmentsTable();
    })
    .catch(err => showAlert(err.message));
}

function openStaffProfileModal(staffId) {
  fetch(`${API_BASE}/admin/staff`)
    .then(res => res.json())
    .then(staff => {
      const s = staff.find(x => String(x.id) === String(staffId));
      if (!s) { showAlert('Staff profile not found.'); return; }

      document.getElementById('staffProfileModalTitle').textContent = `Staff Profile: ${s.full_name}`;
      document.getElementById('staffProfileId').value = s.id;
      document.getElementById('staffProfileFileNo').value = s.isse_file_no || '';
      document.getElementById('staffProfileFullName').value = s.full_name || '';
      document.getElementById('staffProfileDesignation').value = s.designation || '';
      document.getElementById('staffProfileGradeLevel').value = s.grade_level || '';
      document.getElementById('staffProfileEmail').value = s.official_email || '';
      document.getElementById('staffProfileGender').value = s.gender || 'Male';
      document.getElementById('staffProfileLastPromotion').value = formatDateForInput(s.last_promotion_date);
      document.getElementById('staffProfileNextPromotion').value = formatDateForInput(s.next_promotion_date);

      // Department dropdown
      const deptSel = document.getElementById('staffProfileDepartment');
      deptSel.innerHTML = '<option value="">-- Select Department --</option>';
      cachedDepartments.forEach(d => {
        const selected = (s.department && s.department.toLowerCase() === d.name.toLowerCase()) ? 'selected' : '';
        deptSel.innerHTML += `<option value="${d.name}" ${selected}>${d.name} (${d.code})</option>`;
      });

      // If current department isn't in cached list, add it as fallback
      if (s.department && !cachedDepartments.find(d => d.name.toLowerCase() === s.department.toLowerCase())) {
        deptSel.innerHTML += `<option value="${s.department}" selected>${s.department}</option>`;
      }

      openModal('staffProfileModal');
    })
    .catch(() => showAlert('Failed to load staff profile.'));
}

function handleUpdateStaffProfile(e) {
  e.preventDefault();

  const id = document.getElementById('staffProfileId')?.value;
  const fullName = document.getElementById('staffProfileFullName')?.value.trim();
  const department = document.getElementById('staffProfileDepartment')?.value;
  const designation = document.getElementById('staffProfileDesignation')?.value.trim();
  const gradeLevel = document.getElementById('staffProfileGradeLevel')?.value.trim();
  const gender = document.getElementById('staffProfileGender')?.value;
  const officialEmail = document.getElementById('staffProfileEmail')?.value.trim();
  const lastPromotionDate = document.getElementById('staffProfileLastPromotion')?.value || null;
  const nextPromotionDate = document.getElementById('staffProfileNextPromotion')?.value || null;

  if (!id || !fullName || !department || !designation || !gradeLevel) {
    showAlert('Please fill in all required fields.');
    return;
  }

  fetch(`${API_BASE}/admin/staff/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fullName, department, designation, gradeLevel,
      officialEmail: officialEmail || null, gender,
      lastPromotionDate, nextPromotionDate
    })
  })
    .then(async res => {
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to update staff profile.');
      return data;
    })
    .then(data => {
      closeModal('staffProfileModal');
      showAlert(data.message || 'Staff profile updated.');
      loadStaffTable();
      loadDepartmentsTable();
    })
    .catch(err => showAlert(err.message));
}

function handleDeleteStaffProfile() {
  const id = document.getElementById('staffProfileId')?.value;
  const name = document.getElementById('staffProfileFullName')?.value.trim();
  if (!id) return;

  if (!confirm(`Delete staff profile "${name}"? This action cannot be undone.`)) return;

  fetch(`${API_BASE}/admin/staff/${id}`, { method: 'DELETE' })
    .then(async res => {
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to delete staff profile.');
      return data;
    })
    .then(data => {
      closeModal('staffProfileModal');
      showAlert(data.message || 'Staff profile deleted.');
      loadStaffTable();
      loadDepartmentsTable();
    })
    .catch(err => showAlert(err.message));
}

// ================= DEPARTMENTS (FULL CRUD) =================

function loadDepartmentsTable() {
  const tbody = document.getElementById('departmentsTableBody');
  if (!tbody) return;

  fetch(`${API_BASE}/admin/departments`)
    .then(res => res.json())
    .then(depts => {
      cachedDepartments = depts || [];
      if (!depts || depts.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--text-muted);">No departments found.</td></tr>';
        return;
      }

      tbody.innerHTML = depts.map(d => `
        <tr>
          <td>#DEPT-${d.id}</td>
          <td><strong>${d.name}</strong></td>
          <td>${d.code}</td>
          <td><span class="status-badge ${d.assigned_hou && d.assigned_hou !== 'Unassigned' ? 'badge-approved' : 'badge-neutral'}">${d.assigned_hou || 'Unassigned'}</span></td>
          <td>${d.staff_count || 0} Members</td>
          <td><span class="status-badge badge-approved">${d.status}</span></td>
          <td>
            <button class="action-btn btn-edit" onclick="openEditDeptModal(${d.id})">Edit</button>
          </td>
        </tr>
      `).join('');

      populateCalendarDeptFilter();
    });
}

function populateCalendarDeptFilter() {
  const sel = document.getElementById('calendarDeptFilter');
  if (!sel) return;
  const current = sel.value;
  let html = '<option value="All Units">All Departments</option>';
  cachedDepartments.forEach(d => {
    html += `<option value="${d.name}">${d.name}</option>`;
  });
  sel.innerHTML = html;
  sel.value = current || 'All Units';
}

function openAddDeptModal() {
  // Reset form
  const nameEl = document.getElementById('deptName');
  const codeEl = document.getElementById('deptCode');
  if (nameEl) nameEl.value = '';
  if (codeEl) codeEl.value = '';

  // Populate HOU dropdown (all HOU accounts not yet assigned to a department)
  const houSelect = document.getElementById('deptHouSelect');
  if (houSelect) {
    houSelect.innerHTML = '<option value="Unassigned">-- Unassigned --</option>';
  }

  fetch(`${API_BASE}/admin/officers`)
    .then(res => res.json())
    .then(users => {
      const hous = users.filter(u => u.role_title === 'Head of Unit');
      if (houSelect) {
        hous.forEach(h => {
          houSelect.innerHTML += `<option value="${h.username}">${h.username} (${h.department || 'No Dept'})</option>`;
        });
      }
    })
    .catch(() => {});

  openModal('createDeptModal');
}

function handleCreateDept(e) {
  e.preventDefault();
  const name = document.getElementById('deptName')?.value.trim();
  const code = document.getElementById('deptCode')?.value.trim();
  const assignedHou = document.getElementById('deptHouSelect')?.value || 'Unassigned';

  if (!name || !code) {
    showAlert('Please fill in both Department Name and Code.');
    return;
  }

  fetch(`${API_BASE}/admin/departments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, code, assignedHou })
  })
    .then(async res => {
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create department.');
      return data;
    })
    .then(data => {
      closeModal('createDeptModal');
      showAlert(data.message || 'Department created.');
      loadDepartmentsTable();
    })
    .catch(err => showAlert(err.message));
}

function openEditDeptModal(deptId) {
  const dept = cachedDepartments.find(d => d.id === deptId);
  if (!dept) {
    showAlert('Department not found in cache. Please refresh.');
    return;
  }

  currentEditDeptId = deptId;

  document.getElementById('editDeptId').value = deptId;
  document.getElementById('editDeptName').value = dept.name;
  document.getElementById('editDeptCode').value = dept.code;
  document.getElementById('editDeptTitle').textContent = `Edit Department: ${dept.name}`;

  // Populate HOU dropdown
  const houSelect = document.getElementById('editDeptHouSelect');
  if (houSelect) {
    houSelect.innerHTML = `<option value="Unassigned">-- Unassigned --</option>`;
  }

  fetch(`${API_BASE}/admin/officers`)
    .then(res => res.json())
    .then(users => {
      const hous = users.filter(u => u.role_title === 'Head of Unit');
      hous.forEach(h => {
        const selected = (h.username === dept.assigned_hou) ? 'selected' : '';
        houSelect.innerHTML += `<option value="${h.username}" ${selected}>${h.username} (${h.department || 'No Dept'})</option>`;
      });
      if (!hous.find(h => h.username === dept.assigned_hou)) {
        houSelect.value = 'Unassigned';
      }
    })
    .catch(() => {});

  // Load staff for this department + all staff for the "Add" dropdown
  loadEditDeptStaff(dept.name);

  openModal('editDeptModal');
}

function loadEditDeptStaff(deptName) {
  const staffList = document.getElementById('editDeptStaffList');
  const addSelect = document.getElementById('editDeptAddStaffSelect');
  if (!staffList || !addSelect) return;

  staffList.innerHTML = '<p style="color: var(--text-muted); font-size: 0.8rem;">Loading staff...</p>';

  // Get all staff across all departments
  fetch(`${API_BASE}/admin/staff`)
    .then(res => res.json())
    .then(allStaff => {
      cachedAllStaff = allStaff || [];

      const deptStaff = allStaff.filter(s => s.department && s.department.toLowerCase() === deptName.toLowerCase());

      if (deptStaff.length === 0) {
        staffList.innerHTML = '<p style="color: var(--text-muted); font-size: 0.8rem; font-style: italic;">No staff currently in this department.</p>';
      } else {
        staffList.innerHTML = deptStaff.map(s => `
          <div class="staff-list-item">
            <div>
              <div class="name">${s.full_name}</div>
              <div class="file-no">${s.isse_file_no} • ${s.designation}</div>
            </div>
            <button type="button" class="btn-small btn-small-remove" onclick="removeStaffFromDept(${s.id}, '${deptName.replace(/'/g, "\\'")}')">Remove</button>
          </div>
        `).join('');
      }

      // Populate the "Add staff" dropdown with staff NOT in this department
      const eligible = allStaff.filter(s => !s.department || s.department.toLowerCase() !== deptName.toLowerCase());
      addSelect.innerHTML = '<option value="">-- Select a staff member --</option>';
      eligible.forEach(s => {
        addSelect.innerHTML += `<option value="${s.id}">${s.full_name} (${s.isse_file_no}) — Currently: ${s.department || 'Unassigned'}</option>`;
      });
    })
    .catch(() => {
      staffList.innerHTML = '<p style="color: #DC2626; font-size: 0.8rem;">Failed to load staff.</p>';
    });
}

function addStaffToDept() {
  const select = document.getElementById('editDeptAddStaffSelect');
  const deptName = document.getElementById('editDeptName')?.value.trim();

  if (!select || !select.value) {
    showAlert('Please select a staff member to add.');
    return;
  }

  const staffId = select.value;
  const staff = cachedAllStaff.find(s => String(s.id) === String(staffId));
  if (!staff) return;

  fetch(`${API_BASE}/admin/staff/${staffId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fullName: staff.full_name,
      department: deptName,
      designation: staff.designation,
      gradeLevel: staff.grade_level,
      officialEmail: staff.official_email,
      gender: staff.gender,
      lastPromotionDate: staff.last_promotion_date || null,
      nextPromotionDate: staff.next_promotion_date || null
    })
  })
    .then(res => res.json())
    .then(() => {
      loadEditDeptStaff(deptName);
      loadDepartmentsTable();
    })
    .catch(() => showAlert('Failed to add staff.'));
}

function removeStaffFromDept(staffId, deptName) {
  const staff = cachedAllStaff.find(s => String(s.id) === String(staffId));
  if (!staff) return;

  if (!confirm(`Remove ${staff.full_name} from ${deptName}? They will be marked as "Unassigned".`)) return;

  fetch(`${API_BASE}/admin/staff/${staffId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fullName: staff.full_name,
      department: 'Unassigned',
      designation: staff.designation,
      gradeLevel: staff.grade_level,
      officialEmail: staff.official_email,
      gender: staff.gender,
      lastPromotionDate: staff.last_promotion_date || null,
      nextPromotionDate: staff.next_promotion_date || null
    })
  })
    .then(res => res.json())
    .then(() => {
      loadEditDeptStaff(deptName);
      loadDepartmentsTable();
    })
    .catch(() => showAlert('Failed to remove staff.'));
}

function handleUpdateDept(e) {
  e.preventDefault();
  const id = document.getElementById('editDeptId')?.value;
  const name = document.getElementById('editDeptName')?.value.trim();
  const code = document.getElementById('editDeptCode')?.value.trim();
  const assignedHou = document.getElementById('editDeptHouSelect')?.value || 'Unassigned';

  if (!id || !name || !code) {
    showAlert('Please fill in Name and Code.');
    return;
  }

  fetch(`${API_BASE}/admin/departments/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, code, assignedHou, status: 'Active' })
  })
    .then(async res => {
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to update department.');
      return data;
    })
    .then(data => {
      closeModal('editDeptModal');
      showAlert(data.message || 'Department updated.');
      loadDepartmentsTable();
    })
    .catch(err => showAlert(err.message));
}

function handleDeleteDept() {
  const id = document.getElementById('editDeptId')?.value;
  const name = document.getElementById('editDeptName')?.value.trim();
  if (!id) return;

  if (!confirm(`Delete department "${name}"? This cannot be undone. Departments with staff cannot be deleted.`)) return;

  fetch(`${API_BASE}/admin/departments/${id}`, { method: 'DELETE' })
    .then(async res => {
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to delete department.');
      return data;
    })
    .then(data => {
      closeModal('editDeptModal');
      showAlert(data.message || 'Department deleted.');
      loadDepartmentsTable();
    })
    .catch(err => showAlert(err.message));
}


// ================= REPORTS =================

function loadReports() {
  const container = document.getElementById('reportSummaryContainer');
  if (!container) return;

  fetch(`${API_BASE}/admin/dashboard-stats?role=super_admin`)
    .then(res => res.json())
    .then(stats => {
      container.innerHTML = `
        <div class="admin-metric-card"><div class="admin-metric-title">Total Applications</div><div class="admin-metric-value" style="color: #0284C7;">${stats.approvedLeaves + stats.rejectedLeaves + stats.pendingApprovals}</div></div>
        <div class="admin-metric-card"><div class="admin-metric-title">Total Granted Clearances</div><div class="admin-metric-value" style="color: #16A34A;">${stats.approvedLeaves}</div></div>
        <div class="admin-metric-card"><div class="admin-metric-title">Total Rejections</div><div class="admin-metric-value" style="color: #DC2626;">${stats.rejectedLeaves}</div></div>
      `;
    });
}

function exportReportCSV() {
  fetch(`${API_BASE}/leave/all-queue`)
    .then(res => {
      if (!res.ok) throw new Error('Server returned ' + res.status);
      return res.json();
    })
    .then(rows => {
      if (!Array.isArray(rows) || rows.length === 0) {
        showAlert('No leave records available to export.');
        return;
      }

      // CSV cell escape: wrap in quotes and double any internal quotes
      const esc = (v) => {
        if (v === null || v === undefined) return '';
        const s = String(v);
        return `"${s.replace(/"/g, '""')}"`;
      };

      const headers = [
        'Ref ID', 'Staff Name', 'File No', 'Department', 'Leave Type',
        'Start Date', 'End Date', 'Days', 'Workflow Status', 'Resumption Status'
      ];

      // UTF-8 BOM so Excel opens it correctly
      let csv = '\uFEFF' + headers.map(esc).join(',') + '\r\n';

      rows.forEach(r => {
        csv += [
          '#LA-' + (r.id || ''),
          r.full_name || '',
          r.isse_file_no || '',
          r.department || '',
          r.leave_type || '',
          r.start_date || '',
          r.end_date || '',
          r.total_days || '',
          r.overall_status || '',
          r.resumption_status || ''
        ].map(esc).join(',') + '\r\n';
      });

      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = window.URL.createObjectURL(blob);
      const stamp = new Date().toISOString().slice(0, 10);

      const a = document.createElement('a');
      a.href = url;
      a.download = `ISSE_Leave_Report_${stamp}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);

      showAlert(`Exported ${rows.length} leave record(s) to CSV.`);
    })
    .catch(err => {
      showAlert('Export failed: ' + err.message);
    });
}

// Opens a printable executive report in a new window.
// Bypasses the print media query in styles.css (which is only for the slip modal).
function printExecutiveReport() {
  Promise.all([
    fetch(`${API_BASE}/admin/dashboard-stats?role=super_admin`).then(r => r.json()),
    fetch(`${API_BASE}/leave/all-queue`).then(r => r.json())
  ])
    .then(([stats, rows]) => {
      const allRows = Array.isArray(rows) ? rows : [];
      const totalApps  = (stats.approvedLeaves || 0) + (stats.rejectedLeaves || 0) + (stats.pendingApprovals || 0);
      const generated  = new Date().toLocaleString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
      const scopeLabel = currentAdminUser
        ? `${currentAdminUser.role} — ${currentAdminUser.department || 'All Units'}`
        : 'Institutional';

      // Summary rows
      const statusBreakdown = {};
      allRows.forEach(r => {
        const s = (r.overall_status || 'UNKNOWN').trim();
        statusBreakdown[s] = (statusBreakdown[s] || 0) + 1;
      });

      const statusRowsHtml = Object.entries(statusBreakdown)
        .sort((a, b) => b[1] - a[1])
        .map(([status, count]) => `<tr><td>${status}</td><td style="text-align:right;font-weight:bold;">${count}</td></tr>`)
        .join('') || '<tr><td colspan="2" style="text-align:center;color:#64748b;">No data</td></tr>';

      // Recent 25 applications table
      const recentHtml = allRows.slice(0, 25).map(r => `
        <tr>
          <td>#LA-${r.id}</td>
          <td>${r.full_name || ''}<br><small style="color:#64748b;">${r.isse_file_no || ''}</small></td>
          <td>${r.department || ''}</td>
          <td>${r.leave_type || ''}</td>
          <td>${r.start_date || ''} → ${r.end_date || ''}</td>
          <td>${r.total_days || ''}</td>
          <td>${r.overall_status || ''}</td>
        </tr>
      `).join('') || '<tr><td colspan="7" style="text-align:center;color:#64748b;">No records</td></tr>';

      const win = window.open('', '_blank');
      win.document.write(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>ISSE Leave Report — ${generated}</title>
          <style>
            body { font-family: 'Segoe UI', Arial, sans-serif; color: #1e293b; padding: 32px; margin: 0; }
            .header { display: flex; align-items: center; border-bottom: 3px double #0B1A3A; padding-bottom: 14px; margin-bottom: 22px; }
            .header img { max-width: 90px; margin-right: 20px; }
            .header-text h1 { margin: 0; font-size: 1.15rem; color: #0B1A3A; text-transform: uppercase; letter-spacing: 0.5px; }
            .header-text h2 { margin: 4px 0 0 0; font-size: 0.85rem; color: #475569; font-weight: 500; text-transform: uppercase; letter-spacing: 0.5px; }
            .doc-title { display: inline-block; background: #0B1A3A; color: #FFF; padding: 4px 12px; border-radius: 3px; font-size: 0.82rem; font-weight: bold; letter-spacing: 1px; margin-top: 8px; }
            h3 { font-size: 0.95rem; color: #0B1A3A; margin: 26px 0 10px 0; border-bottom: 1px solid #CBD5E1; padding-bottom: 6px; text-transform: uppercase; letter-spacing: 0.5px; }
            .meta { font-size: 0.8rem; color: #64748b; margin-bottom: 6px; }
            .stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 20px; }
            .stat { border: 1px solid #E2E8F0; border-left: 4px solid #D4A843; border-radius: 6px; padding: 12px 16px; background: #F8FAFC; }
            .stat .label { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.6px; color: #64748b; font-weight: 700; margin-bottom: 4px; }
            .stat .value { font-size: 1.6rem; font-weight: 800; }
            table { width: 100%; border-collapse: collapse; font-size: 0.78rem; margin-bottom: 12px; }
            th, td { padding: 7px 9px; border: 1px solid #CBD5E1; text-align: left; vertical-align: top; }
            th { background: #0B1A3A; color: #FFF; font-weight: 700; text-transform: uppercase; font-size: 0.7rem; letter-spacing: 0.5px; }
            tbody tr:nth-child(even) { background: #F8FAFC; }
            .footer { margin-top: 26px; padding-top: 12px; border-top: 1px solid #E2E8F0; font-size: 0.72rem; color: #64748b; text-align: center; }
          </style>
        </head>
        <body>
          <div class="header">
            <img src="isselogo.png" alt="ISSE">
            <div class="header-text">
              <h1>Institute of Space Science &amp; Engineering (ISSE)</h1>
              <h2>National Space Research &amp; Development Agency (NASRDA)</h2>
              <div class="doc-title">EXECUTIVE LEAVE ANALYTICS REPORT</div>
            </div>
          </div>

          <div class="meta"><strong>Generated:</strong> ${generated}</div>
          <div class="meta"><strong>Scope:</strong> ${scopeLabel}</div>

          <h3>1. Executive Summary</h3>
          <div class="stats">
            <div class="stat"><div class="label">Total Applications</div><div class="value" style="color:#0284C7;">${totalApps}</div></div>
            <div class="stat"><div class="label">Granted Clearances</div><div class="value" style="color:#16A34A;">${stats.approvedLeaves || 0}</div></div>
            <div class="stat"><div class="label">Total Rejections</div><div class="value" style="color:#DC2626;">${stats.rejectedLeaves || 0}</div></div>
          </div>

          <h3>2. Status Breakdown</h3>
          <table>
            <thead><tr><th>Workflow Status</th><th style="text-align:right;">Count</th></tr></thead>
            <tbody>${statusRowsHtml}</tbody>
          </table>

          <h3>3. Recent Applications (up to 25)</h3>
          <table>
            <thead>
              <tr>
                <th>Ref</th><th>Staff</th><th>Department</th><th>Leave Type</th>
                <th>Period</th><th>Days</th><th>Status</th>
              </tr>
            </thead>
            <tbody>${recentHtml}</tbody>
          </table>

          <div class="footer">
            This report is generated by the ISSE Leave Management System and reflects records at the time of generation.
            Governed by ISSE Public Service Rules.
          </div>

          <script>window.onload = function() { setTimeout(function(){ window.print(); }, 300); };</script>
        </body>
        </html>
      `);
      win.document.close();
    })
    .catch(err => showAlert('Could not generate report: ' + err.message));
}

// ================= DOCUMENTS =================

function loadDocumentsTable() {
  const tbody = document.getElementById('documentsTableBody');
  if (!tbody) return;

  fetch(`${API_BASE}/leave/all-queue`)
    .then(res => res.json())
    .then(rows => {
      const approved = rows.filter(r => r.overall_status === 'HEAD OF ADMIN APPROVED');
      if (approved.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted);">No approved clearance slips generated yet.</td></tr>';
        return;
      }

      tbody.innerHTML = approved.map(r => `
        <tr>
          <td>#DOC-${r.id}</td>
          <td>Leave Clearance Certificate</td>
          <td><strong>${r.full_name}</strong> (${r.isse_file_no})</td>
          <td><span class="dept-badge">${r.department}</span></td>
          <td>${formatDateDisplay(r.end_date)}</td>
          <td>
            <button class="action-btn btn-download" onclick="downloadApplication(${r.id})">📄 Leave Slip</button>
            ${r.resumption_status === 'RESUMPTION APPROVED' ? `<button class="action-btn btn-download" style="background:#16A34A;" onclick="downloadResumptionSlip(${r.id})">📄 Resumption Slip</button>` : ''}
          </td>
        </tr>
      `).join('');
    });
}

// ================= NOTIFICATIONS (Bell Dropdown) =================

// Maps backend link_section values to the current sidebar section IDs.
function resolveNotifLink(linkSection) {
  if (!linkSection) return null;
  if (document.getElementById(linkSection)) return linkSection;

  const map = {
    'houQueueSection':             'leaveMgmtSection',
    'adminQueueSection':           'leaveMgmtSection',
    'adminResumptionQueueSection': 'resumptionMgmtSection',
    'houResumptionQueueSection':   'resumptionMgmtSection',
    'notificationsSection':        null
  };
  return map[linkSection] || null;
}

function formatNotifTime(ts) {
  if (!ts) return '';
  try {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    const now = new Date();
    const diffMs = now - d;
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return 'Just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days < 7) return `${days}d ago`;
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch (e) { return ''; }
}

function updateNotifBadge(count) {
  const badge = document.getElementById('unreadNotifBadge');
  if (!badge) return;
  if (count > 0) {
    badge.textContent = count > 99 ? '99+' : count;
    badge.style.display = 'inline-block';
  } else {
    badge.style.display = 'none';
  }
}

function refreshNotifBadge() {
  if (!currentAdminUser) return;
  fetch(`${API_BASE}/notifications?role=${encodeURIComponent(currentAdminUser.role)}`)
    .then(r => r.json())
    .then(list => {
      const unread = (list || []).filter(n => !n.is_read).length;
      updateNotifBadge(unread);
    })
    .catch(() => {});
}

function toggleNotifDropdown(event) {
  if (event) event.stopPropagation();
  const dd = document.getElementById('notifDropdown');
  if (!dd) return;
  const isOpen = dd.style.display === 'flex';
  if (isOpen) {
    dd.style.display = 'none';
  } else {
    dd.style.display = 'flex';
    loadNotifDropdown();
  }
}

function closeNotifDropdown() {
  const dd = document.getElementById('notifDropdown');
  if (dd) dd.style.display = 'none';
}

function loadNotifDropdown() {
  const list = document.getElementById('notifDropdownList');
  if (!list || !currentAdminUser) return;

  list.innerHTML = '<div class="notif-empty">Loading...</div>';

  fetch(`${API_BASE}/notifications?role=${encodeURIComponent(currentAdminUser.role)}`)
    .then(r => r.json())
    .then(notifs => {
      const items = notifs || [];
      const unread = items.filter(n => !n.is_read).length;
      updateNotifBadge(unread);

      if (items.length === 0) {
        list.innerHTML = '<div class="notif-empty">No notifications yet.</div>';
      } else {
        list.innerHTML = items.slice(0, 30).map(n => {
          const linkSafe = String(n.link_section || '').replace(/'/g, "\\'");
          return `
            <div class="notif-item ${n.is_read ? '' : 'unread'}"
                 onclick="openNotification(${n.id}, '${linkSafe}')">
              <div class="notif-item-title">${n.title || 'Notification'}</div>
              <div class="notif-item-msg">${n.message || ''}</div>
              <div class="notif-item-time">${formatNotifTime(n.created_at)}</div>
            </div>
          `;
        }).join('');
      }

      const cnt = document.getElementById('notifCountText');
      if (cnt) {
        cnt.textContent = items.length === 0
          ? 'No notifications'
          : `Showing ${Math.min(items.length, 30)} of ${items.length}`;
      }
    })
    .catch(() => {
      list.innerHTML = '<div class="notif-empty">Failed to load notifications.</div>';
    });
}

function openNotification(id, linkSection) {
  fetch(`${API_BASE}/notifications/${id}/read`, { method: 'PATCH' })
    .finally(() => {
      closeNotifDropdown();
      const target = resolveNotifLink(linkSection);
      if (target) {
        switchAdminTab(target);
      } else {
        // Nothing to route to — just refresh the badge so the unread count updates.
        refreshNotifBadge();
      }
    });
}

function markAllNotificationsRead(event) {
  if (event) event.stopPropagation();
  fetch(`${API_BASE}/notifications?role=${encodeURIComponent(currentAdminUser.role)}`)
    .then(r => r.json())
    .then(list => {
      const unread = (list || []).filter(n => !n.is_read);
      return Promise.all(unread.map(n =>
        fetch(`${API_BASE}/notifications/${n.id}/read`, { method: 'PATCH' })
      ));
    })
    .then(() => loadNotifDropdown())
    .catch(() => {});
}

// Close dropdown when clicking anywhere outside the panel
document.addEventListener('click', function (e) {
  const dd = document.getElementById('notifDropdown');
  const bell = document.getElementById('notifBellBtn');
  if (!dd || dd.style.display !== 'flex') return;
  if (bell && bell.contains(e.target)) return;
  if (dd.contains(e.target)) return;
  dd.style.display = 'none';
});

// ================= APPROVAL HISTORY =================

function loadApprovalHistory() {
  const tbody = document.getElementById('approvalHistoryTableBody');
  if (!tbody) return;

  fetch(`${API_BASE}/admin/audit-log`)
    .then(res => res.json())
    .then(logs => {
      const approvals = logs.filter(l =>
        l.action.includes('APPROVED') || l.action.includes('ENDORSED') ||
        l.action.includes('REJECTED') || l.action.includes('VALIDATED')
      );
      if (approvals.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted);">No approval history actions recorded.</td></tr>';
        return;
      }

      tbody.innerHTML = approvals.map(l => `
        <tr>
          <td>${l.created_at}</td>
          <td><strong>${l.actor}</strong></td>
          <td><span class="status-badge badge-approved">${l.actor_role}</span></td>
          <td>${l.action}</td>
          <td>#LA-${l.target_id || 'N/A'}</td>
          <td>${l.details}</td>
        </tr>
      `).join('');
    });
}

// ================= AUDIT LOGS =================

function loadAuditLogs() {
  const tbody = document.getElementById('auditLogTableBody');
  if (!tbody) return;

  fetch(`${API_BASE}/admin/audit-log`)
    .then(res => res.json())
    .then(logs => {
      tbody.innerHTML = logs.map(l => `
        <tr>
          <td>#${l.id}</td>
          <td>${l.created_at}</td>
          <td><strong>${l.actor}</strong> (${l.actor_role})</td>
          <td><span class="status-badge badge-neutral">${l.action}</span></td>
          <td>${l.details}</td>
        </tr>
      `).join('');
    });
}


// ================= DOWNLOADS =================

function downloadApplication(requestId) {
  fetch(`${API_BASE}/leave/details/${requestId}`)
    .then(res => res.json())
    .then(req => {
      if (req.overall_status !== 'HEAD OF ADMIN APPROVED') {
        showAlert('Public Service Regulation Directive: Leave Application Slips can strictly be generated ONLY AFTER final clearance is granted by the Head of Administration.');
        return;
      }

      const printWindow = window.open('', '_blank');
      printWindow.document.write(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Leave Certificate - ${req.full_name}</title>
          <style>
            body { font-family: 'Segoe UI', Arial, sans-serif; padding: 40px; color: #1e293b; background: #fff; }
            .cert-box { border: 3px double #1e3a8a; padding: 30px; max-width: 800px; margin: 0 auto; }
            .header-table { width: 100%; border-bottom: 2px solid #1e3a8a; padding-bottom: 15px; margin-bottom: 20px; }
            .logo { max-width: 100px; }
            .title { text-align: center; color: #1e3a8a; }
            .title h2 { margin: 0; font-size: 1.4rem; }
            .field-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin: 20px 0; background: #f8fafc; padding: 15px; border-radius: 6px; }
            .stamp-box { margin-top: 40px; display: flex; justify-content: space-between; text-align: center; }
            .stamp-sig { border-top: 1px dashed #64748b; width: 220px; padding-top: 5px; font-size: 0.85rem; font-weight: bold; }
          </style>
        </head>
        <body>
          <div class="cert-box">
            <table class="header-table">
              <tr>
                <td style="width: 110px;"><img src="isselogo.png" class="logo"></td>
                <td class="title">
                  <h2>INSTITUTE OF SPACE SCIENCE AND ENGINEERING</h2>
                  <h4>OFFICIAL APPROVED LEAVE CLEARANCE CERTIFICATE</h4>
                  <div style="color: #16a34a; font-weight: bold;">[ STATUS: HEAD OF ADMIN APPROVED ]</div>
                </td>
              </tr>
            </table>

            <div class="field-grid">
              <div><strong>Staff Name:</strong> ${req.full_name}</div>
              <div><strong>File No:</strong> ${req.isse_file_no}</div>
              <div><strong>Department:</strong> ${req.department}</div>
              <div><strong>Leave Type:</strong> ${req.leave_type}</div>
              <div><strong>Start Date:</strong> ${formatDateDisplay(req.start_date)}</div>
              <div><strong>End Date:</strong> ${formatDateDisplay(req.end_date)}</div>
              <div><strong>Duration:</strong> ${req.total_days} Working Days</div>
            </div>

            <div class="stamp-box">
              <div class="stamp-sig">Head of Unit (HOU)<br>${req.department}</div>
              <div class="stamp-sig">Head of Administration<br>ISSE Central Admin</div>
            </div>

            <p style="margin-top: 30px; font-size: 0.78rem; text-align: center; color: #64748b; border-top: 1px solid #e2e8f0; padding-top: 15px;">
              This document serves as the official approved leave clearance issued by the Institute of Space Science and Engineering (ISSE).
            </p>
          </div>
          <script>window.onload = function() { window.print(); };</script>
        </body>
        </html>
      `);
      printWindow.document.close();
    });
}

function downloadResumptionSlip(requestId) {
  fetch(`${API_BASE}/leave/details/${requestId}`)
    .then(res => res.json())
    .then(req => {
      if (req.resumption_status !== 'RESUMPTION APPROVED') {
        showAlert('Public Service Regulation Directive: Duty Resumption Clearance Slips can strictly be generated ONLY AFTER both HOU and HOA have fully validated the return.');
        return;
      }

      const printWindow = window.open('', '_blank');
      printWindow.document.write(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Duty Resumption Clearance - ${req.full_name}</title>
          <style>
            body { font-family: 'Segoe UI', Arial, sans-serif; padding: 40px; color: #1e293b; background: #fff; }
            .cert-box { border: 3px double #1e3a8a; padding: 30px; max-width: 800px; margin: 0 auto; }
            .header-table { width: 100%; border-bottom: 2px solid #1e3a8a; padding-bottom: 15px; margin-bottom: 20px; }
            .logo { max-width: 100px; }
            .title { text-align: center; color: #1e3a8a; }
            .field-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin: 20px 0; background: #f8fafc; padding: 15px; }
            .stamp-box { margin-top: 40px; display: flex; justify-content: space-between; text-align: center; }
            .stamp-sig { border-top: 1px dashed #64748b; width: 220px; padding-top: 5px; font-size: 0.85rem; font-weight: bold; }
          </style>
        </head>
        <body>
          <div class="cert-box">
            <table class="header-table">
              <tr>
                <td style="width: 110px;"><img src="isselogo.png" class="logo"></td>
                <td class="title">
                  <h2>INSTITUTE OF SPACE SCIENCE AND ENGINEERING</h2>
                  <h4>OFFICIAL DUTY RESUMPTION CLEARANCE CERTIFICATE</h4>
                  <div style="color: #16a34a; font-weight: bold;">[ STATUS: RESUMPTION FULLY APPROVED ]</div>
                </td>
              </tr>
            </table>

            <div class="field-grid">
              <div><strong>Staff Name:</strong> ${req.full_name}</div>
              <div><strong>File No:</strong> ${req.isse_file_no}</div>
              <div><strong>Department:</strong> ${req.department}</div>
              <div><strong>Concluded Leave:</strong> ${req.leave_type}</div>
              <div><strong>Resumption Date:</strong> ${formatDateDisplay(req.resumption_date)}</div>
              <div><strong>HOU Verification:</strong> ${formatDateDisplay(req.hou_resumption_date || 'N/A')}</div>
              <div><strong>HOA Clearance:</strong> ${formatDateDisplay(req.admin_resumption_date || 'N/A')}</div>
            </div>

            <div class="stamp-box">
              <div class="stamp-sig">Head of Unit (HOU)<br>${req.department}</div>
              <div class="stamp-sig">Head of Administration<br>ISSE Central Admin</div>
            </div>

            <p style="margin-top: 30px; font-size: 0.78rem; text-align: center; color: #64748b; border-top: 1px solid #e2e8f0; padding-top: 15px;">
              This document certifies the official return and resumption of duty for staff member ${req.full_name} (${req.isse_file_no}) at ISSE.
            </p>
          </div>
          <script>window.onload = function() { window.print(); };</script>
        </body>
        </html>
      `);
      printWindow.document.close();
    });
}

// ================= PROFILE =================

function loadProfileSection() {
  if (!currentAdminUser) return;

  const usernameEl = document.getElementById('profileUsername');
  const emailEl = document.getElementById('profileEmail');
  const roleEl = document.getElementById('profileRole');
  const deptEl = document.getElementById('profileDepartment');

  if (usernameEl) usernameEl.value = currentAdminUser.username || '';
  if (emailEl) emailEl.value = currentAdminUser.email || '';
  if (roleEl) roleEl.value = (currentAdminUser.role || '').toUpperCase();
  if (deptEl) deptEl.value = currentAdminUser.department || 'All Units';

  const curPwd = document.getElementById('profileCurrentPassword');
  const newPwd = document.getElementById('profileNewPassword');
  if (curPwd) curPwd.value = '';
  if (newPwd) newPwd.value = '';
}

function handleProfileUpdate(e) {
  e.preventDefault();
  if (!currentAdminUser) return;

  const username = document.getElementById('profileUsername')?.value.trim();
  const email = document.getElementById('profileEmail')?.value.trim();
  const currentPassword = document.getElementById('profileCurrentPassword')?.value;
  const newPassword = document.getElementById('profileNewPassword')?.value;

  if (!username || !email || !currentPassword) {
    showAlert('Please fill in username, email, and current password.');
    return;
  }

  fetch(`${API_BASE}/admin/profile/${currentAdminUser.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, email, currentPassword, newPassword })
  })
    .then(async (res) => {
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to update profile.');
      return data;
    })
    .then(data => {
      currentAdminUser.username = username;
      currentAdminUser.email = email;
      sessionStorage.setItem('currentAdminUser', JSON.stringify(currentAdminUser));
      setupRoleInterface();
      showAlert(data.message || 'Profile updated successfully.');
      const curPwd = document.getElementById('profileCurrentPassword');
      const newPwd = document.getElementById('profileNewPassword');
      if (curPwd) curPwd.value = '';
      if (newPwd) newPwd.value = '';
    })
    .catch(err => showAlert(err.message || 'Failed to update profile.'));
}

// ================= LOGOUT =================

function logoutAdmin() {
  const finishLogout = () => {
    clearAdminToken();
    sessionStorage.removeItem('currentAdminUser');
    currentAdminUser = null;
    if (dashboardInterval) clearInterval(dashboardInterval);
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    showAdminLogin();
  };

  if (currentAdminUser && currentAdminUser.id) {
    // Token is attached automatically by the fetch wrapper.
    fetch(`${API_BASE}/auth/admin-logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }).finally(finishLogout);
  } else {
    finishLogout();
  }
}
// ============================================================
// ROLES PAGE — Phase 2
// ============================================================

let cachedRoles = [];
let cachedPermissionCatalog = [];

async function loadRolesPage() {
  const tbody = document.getElementById('rolesTableBody');
  if (!tbody) return;

  try {
    const [rolesRes, permsRes] = await Promise.all([
      fetch(`${API_BASE}/admin/roles`),
      fetch(`${API_BASE}/admin/permissions`)
    ]);

    if (!rolesRes.ok) throw new Error('Failed to load roles');
    if (!permsRes.ok) throw new Error('Failed to load permission catalog');

    cachedRoles = await rolesRes.json();
    cachedPermissionCatalog = await permsRes.json();

    renderRolesTable();
  } catch (err) {
    console.error('Load roles page error:', err);
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:#DC2626;">Failed to load roles.</td></tr>`;
  }
}

function renderRolesTable() {
  const tbody = document.getElementById('rolesTableBody');
  if (!tbody) return;

  if (!cachedRoles.length) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--text-muted);">No roles found.</td></tr>`;
    return;
  }

  const authClass = {
    full:  'role-authority-full',
    final: 'role-authority-final',
    unit:  'role-authority-unit',
    none:  'role-authority-none'
  };
  const authLabel = {
    full:  'Full',
    final: 'Final',
    unit:  'Unit',
    none:  'None'
  };

  tbody.innerHTML = cachedRoles.map((r, i) => {
    const isProtected = r.is_protected === true;

    const actions = [];
    if (hasFrontendPermission('settings.manage')) {
      actions.push(`<button class="action-btn btn-edit" onclick="openRoleModal(${r.id})">✏️ Edit</button>`);
    }
    if (!isProtected && hasFrontendPermission('settings.manage')) {
      actions.push(`<button class="action-btn btn-reject" onclick="deleteRole(${r.id})">🗑️ Delete</button>`);
    }
    if (isProtected) {
      actions.push(`<span style="font-size:0.75rem;color:var(--text-muted);">Protected</span>`);
    }

    return `
      <tr>
        <td>${i + 1}</td>
        <td>
          <strong>${escapeHtml(r.title)}</strong>
          ${isProtected ? '<span class="role-protected-tag">Protected</span>' : ''}
          ${r.description ? `<div style="font-size:0.78rem;color:var(--text-muted);margin-top:3px;">${escapeHtml(r.description)}</div>` : ''}
        </td>
        <td><span class="role-authority-pill ${authClass[r.workflow_authority] || 'role-authority-none'}">${authLabel[r.workflow_authority] || r.workflow_authority}</span></td>
        <td><span class="role-scope-pill">${r.scope === 'global' ? '🌐 Global' : '🏢 Department'}</span></td>
        <td>${r.user_count || 0}</td>
        <td>${r.permission_count || 0}</td>
        <td><div style="display:flex;gap:6px;flex-wrap:wrap;">${actions.join('') || '—'}</div></td>
      </tr>
    `;
  }).join('');
}

function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function openRoleModal(roleId) {
  const isEdit = !!roleId;
  const role = isEdit ? cachedRoles.find(r => r.id === roleId) : null;

  // Get the role's current permissions (needs a per-role fetch)
  let currentPerms = [];
  if (isEdit) {
    try {
      const res = await fetch(`${API_BASE}/admin/roles/${roleId}/permissions`);
      if (res.ok) currentPerms = await res.json();
    } catch (e) {
      console.warn('Could not load role permissions:', e);
    }
  }

  // Build modal HTML
  const modalId = 'roleModal';
  let existing = document.getElementById(modalId);
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = modalId;
  modal.className = 'modal-overlay';
  modal.style.display = 'flex';

  const authOptions = [
    { value: 'full',  label: 'Full — can act at any workflow stage (Super Admin class)' },
    { value: 'final', label: 'Final — HOA-class final approval authority' },
    { value: 'unit',  label: 'Unit — HOU-class endorsement authority' },
    { value: 'none',  label: 'None — no workflow authority (viewer/auditor)' }
  ];

  const scopeOptions = [
    { value: 'global',     label: 'Global — sees all departments' },
    { value: 'department', label: 'Department — scoped to assigned department' }
  ];

  modal.innerHTML = `
    <div class="modal-card" style="max-width:720px; width:95%; max-height:92vh; overflow-y:auto;">
      <div class="modal-header">
        <span class="modal-title">${isEdit ? 'Edit Role' : 'Create Role'}</span>
        <button class="modal-close-btn" onclick="closeRoleModal()">&times;</button>
      </div>
      <div class="modal-body" style="padding:22px;">
        <div class="role-form-grid">
          <div class="form-field">
            <label>Role Title *</label>
            <input type="text" id="roleTitleInput" value="${isEdit ? escapeHtml(role.title) : ''}" ${isEdit && role.is_protected ? 'readonly' : ''} required>
          </div>
          <div class="form-field">
            <label>Description</label>
            <input type="text" id="roleDescInput" value="${isEdit && role.description ? escapeHtml(role.description) : ''}">
          </div>
          <div class="form-field">
            <label>Workflow Authority *</label>
            <select id="roleAuthInput" ${isEdit && role.is_protected ? 'disabled' : ''}>
              ${authOptions.map(o => `<option value="${o.value}" ${isEdit && role.workflow_authority === o.value ? 'selected' : ''}>${o.label}</option>`).join('')}
            </select>
          </div>
          <div class="form-field">
            <label>Scope *</label>
            <select id="roleScopeInput" ${isEdit && role.is_protected ? 'disabled' : ''}>
              ${scopeOptions.map(o => `<option value="${o.value}" ${isEdit && role.scope === o.value ? 'selected' : ''}>${o.label}</option>`).join('')}
            </select>
          </div>
        </div>

        <h4 style="font-size:0.9rem;color:var(--accent-gold);margin:18px 0 10px;border-top:1px solid var(--border-color);padding-top:14px;">Permissions</h4>
        <div id="rolePermContainer"></div>

        <div id="roleModalMessage" style="display:none;margin-top:14px;padding:10px;border-radius:6px;font-size:0.85rem;"></div>

        <div class="modal-btn-row" style="justify-content:flex-end;gap:10px;margin-top:18px;">
          <button class="action-btn" style="background:var(--text-muted);color:#fff;" onclick="closeRoleModal()">Cancel</button>
          <button class="action-btn btn-approve" id="roleSaveBtn">${isEdit ? 'Save Changes' : 'Create Role'}</button>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  // Render permission checkboxes
  renderPermissionCheckboxes(currentPerms, isEdit && role.is_protected);

  // Wire save
  document.getElementById('roleSaveBtn').addEventListener('click', function () {
    saveRole(roleId, isEdit);
  });
}

function closeRoleModal() {
  const modal = document.getElementById('roleModal');
  if (modal) modal.remove();
}

function renderPermissionCheckboxes(currentPerms, isProtected) {
  const container = document.getElementById('rolePermContainer');
  if (!container) return;

  const byGroup = {};
  cachedPermissionCatalog.forEach(p => {
    if (!byGroup[p.group]) byGroup[p.group] = [];
    byGroup[p.group].push(p);
  });

  let html = '';
  Object.keys(byGroup).forEach(groupName => {
    html += `
      <div class="role-perm-group">
        <div class="role-perm-group-header">${escapeHtml(groupName)}</div>
        <div class="role-perm-group-body">
    `;

        byGroup[groupName].forEach(p => {
      const checked = currentPerms.includes(p.key) || (p.workflow && isProtected);
      const workflowLocked = !!p.workflow;
      // Only workflow-governed permissions are locked. Protected roles
      // can still have their other permissions toggled (attendance.view,
      // staff.view, reports.view, etc.).
      const disabled = workflowLocked ? 'disabled' : '';
      const rowClass = workflowLocked ? 'disabled' : '';
      const note = workflowLocked ? `<span class="workflow-note">Granted automatically by the role's authority level.</span>` : '';

      html += `
        <label class="role-perm-row ${rowClass}">
          <input type="checkbox" class="role-perm-checkbox" value="${p.key}" ${checked ? 'checked' : ''} ${disabled}>
          <span>
            ${escapeHtml(p.label)}
            ${note}
          </span>
        </label>
      `;
    });

    html += `</div></div>`;
  });

  container.innerHTML = html;
}

async function saveRole(roleId, isEdit) {
  const titleEl = document.getElementById('roleTitleInput');
  const descEl  = document.getElementById('roleDescInput');
  const authEl  = document.getElementById('roleAuthInput');
  const scopeEl = document.getElementById('roleScopeInput');
  const msgEl   = document.getElementById('roleModalMessage');
  const saveBtn = document.getElementById('roleSaveBtn');

  const title = titleEl.value.trim();
  const description = descEl.value.trim();
  const workflow_authority = authEl.value;
  const scope = scopeEl.value;

  // Collect checked permissions (skip the disabled workflow ones)
  const permissions = Array.from(document.querySelectorAll('.role-perm-checkbox:not(:disabled):checked'))
    .map(cb => cb.value);

  if (!title) {
    msgEl.style.display = 'block';
    msgEl.style.background = 'rgba(220,38,38,0.15)';
    msgEl.style.color = '#DC2626';
    msgEl.textContent = 'Role title is required.';
    return;
  }

  saveBtn.disabled = true;
  const originalLabel = saveBtn.textContent;
  saveBtn.textContent = 'Saving...';

  try {
    const url = isEdit ? `${API_BASE}/admin/roles/${roleId}` : `${API_BASE}/admin/roles`;
    const method = isEdit ? 'PUT' : 'POST';

    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, description, workflow_authority, scope, permissions })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Save failed.');

    closeRoleModal();
    showAlert(data.message || 'Role saved.');
    await loadRolesPage();
  } catch (err) {
    msgEl.style.display = 'block';
    msgEl.style.background = 'rgba(220,38,38,0.15)';
    msgEl.style.color = '#DC2626';
    msgEl.textContent = err.message;
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = originalLabel;
  }
}

async function deleteRole(roleId) {
  const role = cachedRoles.find(r => r.id === roleId);
  if (!role) return;
  if (role.is_protected) {
    showAlert('Protected roles cannot be deleted.');
    return;
  }
  if (!confirm(`Delete role "${role.title}"? This cannot be undone.`)) return;

  try {
    const res = await fetch(`${API_BASE}/admin/roles/${roleId}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Delete failed.');
    showAlert(data.message || 'Role deleted.');
    await loadRolesPage();
  } catch (err) {
    showAlert(err.message);
  }
}
async function hydrateCurrentPermissions() {
  try {
    const res = await fetch(`${API_BASE}/auth/permissions`);
    if (!res.ok) {
      currentAdminPermissions = [];
      currentAdminAuthority = 'none';
      return;
    }
    const data = await res.json();
    currentAdminPermissions = Array.isArray(data.permissions) ? data.permissions : [];
    currentAdminAuthority = data.authority || 'none';
  } catch (err) {
    console.warn('Could not load permissions:', err);
    currentAdminPermissions = [];
    currentAdminAuthority = 'none';
  }
}
// ============================================================
// USER MANAGEMENT — Phase 3
// ============================================================

let cachedUsers = [];

async function loadUsersPage() {
  const tbody = document.getElementById('usersTableBody');
  if (!tbody) return;

  try {
    const res = await fetch(`${API_BASE}/admin/users`);
    if (!res.ok) throw new Error('Failed to load users');
    cachedUsers = await res.json();

    // Ensure roles are loaded too (needed by the modal)
    if (!cachedRoles.length) {
      const rolesRes = await fetch(`${API_BASE}/admin/roles`);
      if (rolesRes.ok) cachedRoles = await rolesRes.json();
    }

    renderUsersTable();
  } catch (err) {
    console.error('Load users error:', err);
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:#DC2626;">Failed to load users.</td></tr>`;
  }
}

function renderUsersTable() {
  const tbody = document.getElementById('usersTableBody');
  if (!tbody) return;

  if (!cachedUsers.length) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:var(--text-muted);">No users found.</td></tr>`;
    return;
  }

  tbody.innerHTML = cachedUsers.map((u, i) => {
    const isCurrent = currentAdminUser && String(u.id) === String(currentAdminUser.id);
    const statusCls = u.is_active ? 'badge-approved' : 'badge-neutral';
    const statusTxt = u.is_active ? 'Active' : 'Inactive';
    const roleLabel = u.role_title || '—';
    const deptLabel = u.department || '—';
    const lastSeen = u.last_seen
      ? new Date(u.last_seen).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
      : 'Never';

    const actions = [];
    if (hasFrontendPermission('settings.manage')) {
      actions.push(`<button class="action-btn btn-edit" onclick="openUserModal(${u.id})">✏️</button>`);
      if (!isCurrent) {
        actions.push(`<button class="action-btn btn-reject" onclick="deleteUser(${u.id}, '${escapeJs(u.username)}')">🗑️</button>`);
      }
    }
    if (isCurrent) {
      actions.push(`<span style="font-size:0.72rem;color:var(--accent-gold);font-weight:700;">YOU</span>`);
    }

    return `
      <tr>
        <td>${i + 1}</td>
        <td><strong>${escapeHtml(u.username)}</strong></td>
        <td>${escapeHtml(u.email)}</td>
        <td><span class="role-scope-pill">${escapeHtml(roleLabel)}</span></td>
        <td>${escapeHtml(deptLabel)}</td>
        <td><span class="status-badge ${statusCls}">${statusTxt}</span></td>
        <td style="font-size:0.78rem;color:var(--text-muted);">${lastSeen}</td>
        <td><div style="display:flex;gap:6px;flex-wrap:wrap;">${actions.join('') || '—'}</div></td>
      </tr>
    `;
  }).join('');
}

async function openUserModal(userId) {
  const isEdit = !!userId;
  const user = isEdit ? cachedUsers.find(u => String(u.id) === String(userId)) : null;

  if (isEdit && !user) return;

  if (!cachedRoles.length) {
    const r = await fetch(`${API_BASE}/admin/roles`);
    if (r.ok) cachedRoles = await r.json();
  }

  // Fetch departments to populate the dropdown
  let deptList = [];
  try {
    const dRes = await fetch(`${API_BASE}/admin/departments`);
    if (dRes.ok) deptList = await dRes.json();
  } catch (e) {
    console.warn('Could not load departments:', e);
  }
  
  let existing = document.getElementById('userModal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'userModal';
  modal.className = 'modal-overlay';
  modal.style.display = 'flex';

  const roleOptions = cachedRoles.map(r =>
    `<option value="${r.id}" data-scope="${r.scope}" ${isEdit && user.role_id === r.id ? 'selected' : ''}>${escapeHtml(r.title)} (${r.scope === 'global' ? 'Global' : 'Department'})</option>`
  ).join('');

  modal.innerHTML = `
    <div class="modal-card" style="max-width:560px; width:95%; max-height:92vh; overflow-y:auto;">
      <div class="modal-header">
        <span class="modal-title">${isEdit ? 'Edit User' : 'Create User'}</span>
        <button class="modal-close-btn" onclick="closeUserModal()">&times;</button>
      </div>
      <div class="modal-body" style="padding:22px;">
        <div class="role-form-grid">
          <div class="form-field">
            <label>Username *</label>
            <input type="text" id="userUsernameInput" value="${isEdit ? escapeHtml(user.username) : ''}" required>
          </div>
          <div class="form-field">
            <label>Email *</label>
            <input type="email" id="userEmailInput" value="${isEdit ? escapeHtml(user.email) : ''}" required>
          </div>
        </div>

        <div class="form-field">
          <label>Password ${isEdit ? '(leave blank to keep current)' : '*'}</label>
          <input type="text" id="userPasswordInput" placeholder="${isEdit ? 'Leave blank to keep current password' : 'Set initial password'}" ${isEdit ? '' : 'required'}>
          <small style="color:var(--text-muted);font-size:0.72rem;display:block;margin-top:4px;">Minimum 6 characters.</small>
        </div>

        <div class="form-field">
          <label>Role *</label>
          <select id="userRoleInput" onchange="onUserRoleChange()">
            <option value="">-- Select a role --</option>
            ${roleOptions}
          </select>
        </div>

        <div class="form-field" id="userDepartmentGroup">
          <label>Department</label>
          <select id="userDepartmentInput" style="width:100%; padding:9px; border-radius:5px; border:1px solid var(--input-border); background:var(--input-bg); color:var(--text-primary);">
            <option value="">-- Select a Department --</option>
            ${deptList.map(d => `<option value="${d.name}" ${isEdit && user.department === d.name ? 'selected' : ''}>${d.name} (${d.code})</option>`).join('')}
          </select>
          <small style="color:var(--text-muted);font-size:0.72rem;display:block;margin-top:4px;">Required for department-scoped roles.</small>
        </div>

        <div class="form-field">
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:normal;">
            <input type="checkbox" id="userActiveInput" ${!isEdit || user.is_active ? 'checked' : ''} style="width:auto;">
            Active account
          </label>
        </div>

        <div id="userModalMessage" style="display:none;margin-top:14px;padding:10px;border-radius:6px;font-size:0.85rem;"></div>

        <div class="modal-btn-row" style="justify-content:flex-end;gap:10px;margin-top:18px;">
          <button class="action-btn" style="background:var(--text-muted);color:#fff;" onclick="closeUserModal()">Cancel</button>
          <button class="action-btn btn-approve" id="userSaveBtn">${isEdit ? 'Save Changes' : 'Create User'}</button>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  onUserRoleChange();

  document.getElementById('userSaveBtn').addEventListener('click', function () {
    saveUser(userId, isEdit);
  });
}

function onUserRoleChange() {
  const sel = document.getElementById('userRoleInput');
  const group = document.getElementById('userDepartmentGroup');
  const input = document.getElementById('userDepartmentInput');
  if (!sel || !group || !input) return;

  const opt = sel.options[sel.selectedIndex];
  const scope = opt ? opt.getAttribute('data-scope') : null;

  if (scope === 'department') {
    group.style.display = 'block';
    input.required = true;
    // Ensure a department is selected if creating a new HOU
    if (!input.value) input.value = '';
  } else {
    group.style.display = 'block';
    input.required = false;
    // For global roles, we don't need a specific department
    input.value = 'All Units'; 
  }
}

function closeUserModal() {
  const modal = document.getElementById('userModal');
  if (modal) modal.remove();
}

async function saveUser(userId, isEdit) {
  const usernameEl = document.getElementById('userUsernameInput');
  const emailEl = document.getElementById('userEmailInput');
  const passwordEl = document.getElementById('userPasswordInput');
  const roleEl = document.getElementById('userRoleInput');
  const deptEl = document.getElementById('userDepartmentInput');
  const activeEl = document.getElementById('userActiveInput');
  const msgEl = document.getElementById('userModalMessage');
  const saveBtn = document.getElementById('userSaveBtn');

  const username = usernameEl.value.trim();
  const email = emailEl.value.trim();
  const password = passwordEl.value;
  const role_id = parseInt(roleEl.value, 10);
  const department = deptEl.value.trim();
  const is_active = activeEl.checked;

  if (!username || !email || !role_id) {
    showUserMsg('Please fill in username, email, and role.', 'error');
    return;
  }
  if (!isEdit && (!password || password.length < 6)) {
    showUserMsg('Password must be at least 6 characters.', 'error');
    return;
  }
  if (isEdit && password && password.length < 6) {
    showUserMsg('New password must be at least 6 characters.', 'error');
    return;
  }

  const selRole = cachedRoles.find(r => r.id === role_id);
  if (selRole && selRole.scope === 'department' && !department) {
    showUserMsg('Department is required for this role.', 'error');
    return;
  }

  saveBtn.disabled = true;
  const orig = saveBtn.textContent;
  saveBtn.textContent = 'Saving...';

  try {
    const body = { username, email, role_id, department, is_active };
    if (password) body.password = password;

    const url = isEdit ? `${API_BASE}/admin/users/${userId}` : `${API_BASE}/admin/users`;
    const method = isEdit ? 'PUT' : 'POST';

    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Save failed.');

    closeUserModal();
    showAlert(data.message || 'User saved.');
    await loadUsersPage();
  } catch (err) {
    showUserMsg(err.message, 'error');
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = orig;
  }
}

function showUserMsg(text, kind) {
  const el = document.getElementById('userModalMessage');
  if (!el) return;
  el.style.display = 'block';
  el.style.background = kind === 'error' ? 'rgba(220,38,38,0.15)' : 'rgba(22,163,74,0.15)';
  el.style.color = kind === 'error' ? '#DC2626' : '#16A34A';
  el.textContent = text;
}

async function deleteUser(userId, username) {
  if (!confirm(`Delete user "${username}"? This cannot be undone.`)) return;

  try {
    const res = await fetch(`${API_BASE}/admin/users/${userId}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Delete failed.');
    showAlert(data.message || 'User deleted.');
    await loadUsersPage();
  } catch (err) {
    showAlert(err.message);
  }
}

function escapeJs(value) {
  return String(value ?? '').replaceAll("'", "\\'");
}

window.loadUsersPage = loadUsersPage;
window.openUserModal = openUserModal;
window.closeUserModal = closeUserModal;
window.saveUser = saveUser;
window.deleteUser = deleteUser;
window.onUserRoleChange = onUserRoleChange;

// ================= BULK IMPORT STAFF =================

function openBulkStaffModal() {
  const ta = document.getElementById('bulkStaffData');
  if (ta) ta.value = '';
  openModal('bulkStaffModal');
}

async function handleBulkStaffImport() {
  const textarea = document.getElementById('bulkStaffData');
  if (!textarea || !textarea.value.trim()) {
    showAlert('Please paste some staff data to import.');
    return;
  }

  const lines = textarea.value.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const staffList = [];
  const errors = [];

  lines.forEach((line, index) => {
    // Split by comma, trim each part
    const parts = line.split(',').map(p => p.trim());
    
    // We need at least 6 columns (File No, Name, Dept, Desig, Grade, Gender)
    if (parts.length < 6) {
      errors.push(`Line ${index + 1}: Missing required columns. Expected at least 6.`);
      return;
    }

    const [isseFileNo, fullName, department, designation, gradeLevel, gender, email] = parts;

    if (!isseFileNo || !fullName || !department || !designation || !gradeLevel) {
      errors.push(`Line ${index + 1}: Missing required fields (File No, Name, Dept, Desig, Grade).`);
      return;
    }

    staffList.push({
      isseFileNo,
      fullName,
      department,
      designation,
      gradeLevel,
      gender: gender || 'Male',
      officialEmail: email || null
    });
  });

  if (errors.length > 0) {
    showAlert(`Import Failed. Please fix the following errors:\n\n${errors.slice(0, 5).join('\n')}${errors.length > 5 ? '\n...and more.' : ''}`);
    return;
  }

  if (staffList.length === 0) {
    showAlert('No valid staff data found to import.');
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/admin/staff/bulk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ staffList })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Bulk import failed.');

    closeModal('bulkStaffModal');
    showAlert(data.message || `Successfully imported ${staffList.length} staff members.`);
    loadStaffTable();
    loadDepartmentsTable();
  } catch (err) {
    showAlert(err.message);
  }
}

// ================= EXPORT STAFF CSV =================

function exportStaffCSV() {
  if (!cachedAllStaff || cachedAllStaff.length === 0) {
    showAlert('No staff records to export.');
    return;
  }

  // CSV escape helper — wraps in quotes and doubles any internal quotes
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return `"${s.replace(/"/g, '""')}"`;
  };

  // Header row
  const headers = [
    'ISSE File No',
    'Full Name',
    'Department',
    'Designation',
    'Grade Level',
    'Gender',
    'Official Email',
    'Last Promotion',
    'Next Promotion'
  ];

  const rows = cachedAllStaff.map(s => [
    s.isse_file_no,
    s.full_name,
    s.department,
    s.designation,
    s.grade_level,
    s.gender || 'Male',
    s.official_email || '',
    s.last_promotion_date ? formatDateForInput(s.last_promotion_date) : '',
    s.next_promotion_date ? formatDateForInput(s.next_promotion_date) : ''
  ]);

  // BOM at the start so Excel opens UTF-8 correctly
  let csv = '\uFEFF' + headers.map(esc).join(',') + '\r\n';
  rows.forEach(r => {
    csv += r.map(esc).join(',') + '\r\n';
  });

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);

  const stamp = new Date().toISOString().slice(0, 10);
  const a = document.createElement('a');
  a.href = url;
  a.download = `ISSE_Staff_Directory_${stamp}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  showAlert(`Exported ${cachedAllStaff.length} staff records to CSV.`);
}

// ================= DELETE ALL STAFF =================

function confirmDeleteAllStaff() {
  if (!cachedAllStaff || cachedAllStaff.length === 0) {
    showAlert('There are no staff records to delete.');
    return;
  }

  const input = document.getElementById('deleteAllConfirmInput');
  if (input) input.value = '';

  const btn = document.getElementById('deleteAllConfirmBtn');
  if (btn) {
    btn.disabled = true;
    btn.style.opacity = '0.4';
    btn.style.cursor = 'not-allowed';
  }

  openModal('deleteAllStaffModal');
}

function onDeleteAllInputChange() {
  const input = document.getElementById('deleteAllConfirmInput');
  const btn = document.getElementById('deleteAllConfirmBtn');
  if (!input || !btn) return;

  const ok = input.value.trim().toUpperCase() === 'DELETE ALL';
  btn.disabled = !ok;
  btn.style.opacity = ok ? '1' : '0.4';
  btn.style.cursor = ok ? 'pointer' : 'not-allowed';
}

async function executeDeleteAllStaff() {
  const input = document.getElementById('deleteAllConfirmInput');
  if (!input || input.value.trim().toUpperCase() !== 'DELETE ALL') return;

  const btn = document.getElementById('deleteAllConfirmBtn');
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Deleting...';

  try {
    const res = await fetch(`${API_BASE}/admin/staff/delete-all`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to delete staff.');

    closeModal('deleteAllStaffModal');
    showAlert(data.message || 'All staff deleted.');
    loadStaffTable();
    loadDepartmentsTable();
  } catch (err) {
    showAlert(err.message);
    btn.disabled = false;
    btn.textContent = orig;
  }
}

// ============================================================
// ATTENDANCE MODULE
// ============================================================

// Nigerian public holidays (mirrors the backend list)
const ATTENDANCE_PUBLIC_HOLIDAYS = new Set([
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

const ATTENDANCE_MONTH_NAMES = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December'
];

let cachedAttendanceRecords    = [];
let cachedAttendanceThresholds = { warning: 75, good: 90, excellent: 95 };
let currentAttendanceYear      = null;
let currentAttendanceMonth     = null;
let attendanceMonthsLoaded     = false;
let pendingAttendanceImport    = null;

// ------------------------------------------------------------------
// Working-day helper (mirrors the backend)
// ------------------------------------------------------------------
function _attendanceToDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function _attendanceIsWorkingDay(d) {
  const dow = d.getDay();
  if (dow === 0 || dow === 6) return false;
  return !ATTENDANCE_PUBLIC_HOLIDAYS.has(_attendanceToDateStr(d));
}

// ------------------------------------------------------------------
// Classification using configurable thresholds
// ------------------------------------------------------------------
function classifyAttendance(pct) {
  const t = cachedAttendanceThresholds;
  if (pct >= 100)         return { label: 'Perfect',   cls: 'badge-approved', color: '#16A34A' };
  if (pct >= t.excellent) return { label: 'Excellent', cls: 'badge-approved', color: '#0284C7' };
  if (pct >= t.good)      return { label: 'Good',      cls: 'badge-pending',  color: '#F59E0B' };
  if (pct >= t.warning)   return { label: 'Low',       cls: 'badge-pending',  color: '#EAB308' };
  return                         { label: 'Warning',   cls: 'badge-rejected', color: '#DC2626' };
}

// ------------------------------------------------------------------
// Loaders
// ------------------------------------------------------------------
async function loadAttendanceThresholds() {
  try {
    const res = await fetch(`${API_BASE}/admin/attendance/settings`);
    if (res.ok) cachedAttendanceThresholds = await res.json();
  } catch (_) { /* keep defaults */ }
}

async function loadAttendanceMonths() {
  const sel = document.getElementById('attendanceMonthSelect');
  if (!sel) return;

  try {
    const res = await fetch(`${API_BASE}/admin/attendance/months`);
    const months = await res.json();

    if (!Array.isArray(months) || months.length === 0) {
      sel.innerHTML = '<option value="">No data imported yet</option>';
      sel.disabled = true;
      currentAttendanceYear  = null;
      currentAttendanceMonth = null;
      return;
    }

    sel.disabled = false;
    sel.innerHTML = months.map(m =>
      `<option value="${m.year}-${m.month}">${ATTENDANCE_MONTH_NAMES[m.month - 1]} ${m.year}</option>`
    ).join('');

    // Preserve current selection if still present; else pick newest
    if (currentAttendanceYear && currentAttendanceMonth) {
      const key = `${currentAttendanceYear}-${currentAttendanceMonth}`;
      if (months.find(m => `${m.year}-${m.month}` === key)) {
        sel.value = key;
        return;
      }
    }

    currentAttendanceYear  = months[0].year;
    currentAttendanceMonth = months[0].month;
    sel.value = `${currentAttendanceYear}-${currentAttendanceMonth}`;
  } catch (err) {
    console.error('Attendance months load error:', err);
  }
}

async function loadAttendanceRecords() {
  const tbody = document.getElementById('attendanceTableBody');
  if (!tbody) return;

  if (!currentAttendanceYear || !currentAttendanceMonth) {
    cachedAttendanceRecords = [];
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;color:var(--text-muted);">
      No attendance has been imported yet. Click <strong>Bulk Import Attendance</strong> to begin.
    </td></tr>`;
    renderAttendanceMetrics([]);
    return;
  }

  try {
    const res = await fetch(
      `${API_BASE}/admin/attendance?year=${currentAttendanceYear}&month=${currentAttendanceMonth}`
    );
    if (!res.ok) throw new Error('Failed to load attendance records.');

    cachedAttendanceRecords = await res.json();
    applyAttendanceFilters();
    renderAttendanceMetrics(cachedAttendanceRecords);
  } catch (err) {
    console.error('Attendance load error:', err);
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;color:#DC2626;">
      Failed to load attendance records.
    </td></tr>`;
  }
}

async function initAttendancePage() {
  // Reveal the manage-only buttons for users with attendance.manage.
  // They ship hidden in the HTML, so a viewer-only role never sees
  // them flash on screen.
  const canManage = hasFrontendPermission('attendance.manage');
  const manageBtnIds = [
    'attendanceImportBtn',
    'attendanceThresholdsBtn',
    'deleteAttendanceMonthBtn'
  ];
  manageBtnIds.forEach(id => {
    const btn = document.getElementById(id);
    if (btn) btn.style.display = canManage ? 'inline-flex' : 'none';
  });

  await loadAttendanceThresholds();
  if (!attendanceMonthsLoaded) {
    await loadAttendanceMonths();
    attendanceMonthsLoaded = true;
  }
  await loadAttendanceRecords();
}

// ------------------------------------------------------------------
// Filters + table render
// ------------------------------------------------------------------
function resetAttendanceFilters() {
  const s = document.getElementById('attendanceSearchInput');
  const f = document.getElementById('attendanceStatusFilter');
  if (s) s.value = '';
  if (f) f.value = '';
  applyAttendanceFilters();
}

function applyAttendanceFilters() {
  const tbody = document.getElementById('attendanceTableBody');
  if (!tbody) return;

  const search = (document.getElementById('attendanceSearchInput')?.value || '').trim().toLowerCase();
  const statusFilter = document.getElementById('attendanceStatusFilter')?.value || '';

  let rows = cachedAttendanceRecords.slice();

  if (search) {
    rows = rows.filter(r =>
      (r.full_name    || '').toLowerCase().includes(search) ||
      (r.isse_file_no || '').toLowerCase().includes(search) ||
      (r.department   || '').toLowerCase().includes(search)
    );
  }

  if (statusFilter) {
    const t = cachedAttendanceThresholds;
    rows = rows.filter(r => {
      const pct = parseFloat(r.percentage) || 0;
      if (statusFilter === 'perfect')   return pct >= 100;
      if (statusFilter === 'excellent') return pct >= t.excellent && pct < 100;
      if (statusFilter === 'good')      return pct >= t.good && pct < t.excellent;
      if (statusFilter === 'warning')   return pct < t.warning;
      return true;
    });
  }

  const countEl = document.getElementById('attendanceFilterCount');
  if (countEl) {
    countEl.textContent = `Showing ${rows.length} of ${cachedAttendanceRecords.length} staff`;
  }

  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;color:var(--text-muted);">
      No attendance records match the current filters.
    </td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map(r => {
    const pct = parseFloat(r.percentage) || 0;
    const cls = classifyAttendance(pct);
    const fileSafe = escapeJs(r.isse_file_no);
    return `
      <tr>
        <td><strong>${escapeHtml(r.isse_file_no)}</strong></td>
        <td>${escapeHtml(r.full_name)}</td>
        <td><span class="dept-badge">${escapeHtml(r.department || '—')}</span></td>
        <td style="text-align:center;color:#16A34A;font-weight:700;">${r.present_days}</td>
        <td style="text-align:center;color:#DC2626;font-weight:700;">${r.absent_days}</td>
        <td style="text-align:center;">${r.working_days}</td>
        <td style="text-align:center;font-weight:800;color:${cls.color};">${pct.toFixed(2)}%</td>
        <td><span class="status-badge ${cls.cls}">${cls.label}</span></td>
                <td>
          <button class="action-btn btn-edit"
                  onclick="openAttendanceDetail('${fileSafe}')">View Grid</button>
          ${hasFrontendPermission('attendance.manage') ? `
            <button class="action-btn" style="background:#6366F1; color:#fff;"
                    onclick="openAttendanceEditModal('${fileSafe}')">✏️ Edit</button>
            <button class="action-btn btn-reject"
                    onclick="confirmDeleteAttendanceRecord('${fileSafe}')">🗑️</button>
          ` : ''}
        </td>
      </tr>
    `;
  }).join('');
}

function renderAttendanceMetrics(records) {
  const c = document.getElementById('attendanceMetricsContainer');
  if (!c) return;

  if (!records || records.length === 0) {
    c.innerHTML = '';
    return;
  }

  const t = cachedAttendanceThresholds;
  let sumPct = 0, perfect = 0, warning = 0;

  records.forEach(r => {
    const pct = parseFloat(r.percentage) || 0;
    sumPct += pct;
    if (pct >= 100) perfect++;
    if (pct < t.warning) warning++;
  });

  const avg = (sumPct / records.length).toFixed(2);

  c.innerHTML = `
    <div class="admin-metric-card">
      <div class="admin-metric-title">Staff Tracked</div>
      <div class="admin-metric-value" style="color:#0284C7;">${records.length}</div>
      <div class="admin-metric-sub">For this month</div>
    </div>
    <div class="admin-metric-card">
      <div class="admin-metric-title">Average Attendance</div>
      <div class="admin-metric-value" style="color:#D4A843;">${avg}%</div>
      <div class="admin-metric-sub">Across all staff</div>
    </div>
    <div class="admin-metric-card">
      <div class="admin-metric-title">Perfect Attendance</div>
      <div class="admin-metric-value" style="color:#16A34A;">${perfect}</div>
      <div class="admin-metric-sub">100% attendance</div>
    </div>
    <div class="admin-metric-card">
      <div class="admin-metric-title">Below ${t.warning}%</div>
      <div class="admin-metric-value" style="color:#DC2626;">${warning}</div>
      <div class="admin-metric-sub">Flagged for review</div>
    </div>
  `;
}

// ------------------------------------------------------------------
// Detail modal — day-by-day grid
// ------------------------------------------------------------------
async function openAttendanceDetail(fileNo) {
  if (!currentAttendanceYear || !currentAttendanceMonth) return;

  try {
    const res = await fetch(
      `${API_BASE}/admin/attendance/staff/${encodeURIComponent(fileNo)}` +
      `?year=${currentAttendanceYear}&month=${currentAttendanceMonth}`
    );
    if (!res.ok) throw new Error('Failed to load attendance detail.');
    const record = await res.json();

    const daysInMonth = new Date(currentAttendanceYear, currentAttendanceMonth, 0).getDate();
    const pct = parseFloat(record.percentage) || 0;
    const cls = classifyAttendance(pct);

    document.getElementById('attendanceDetailTitle').textContent =
      `Attendance Detail — ${record.full_name} (${ATTENDANCE_MONTH_NAMES[currentAttendanceMonth - 1]} ${currentAttendanceYear})`;

    let html = `
      <div style="display: grid; grid-template-columns: 2fr 1fr; gap: 15px; margin-bottom: 18px;">
        <div>
          <div style="font-size: 0.72rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px;">Staff</div>
          <div style="font-size: 1.05rem; font-weight: 700;">${escapeHtml(record.full_name)}</div>
          <div style="font-size: 0.82rem; color: var(--text-muted);">
            ${escapeHtml(record.isse_file_no)} &middot; ${escapeHtml(record.department || '—')}
          </div>
        </div>
        <div style="text-align: right;">
          <div style="font-size: 0.72rem; color: var(--text-muted); text-transform: uppercase;">Attendance</div>
          <div style="font-size: 1.6rem; font-weight: 800; color: ${cls.color};">
            ${pct.toFixed(2)}%
          </div>
          <span class="status-badge ${cls.cls}" style="margin-top: 4px; display: inline-block;">${cls.label}</span>
        </div>
      </div>

      <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 18px;">
        <div style="padding: 10px; background: rgba(22,163,74,0.08); border-radius: 6px; text-align: center;">
          <div style="font-size: 0.7rem; text-transform: uppercase; color: var(--text-muted); font-weight: 700;">Present</div>
          <div style="font-size: 1.4rem; font-weight: 800; color: #16A34A;">${record.present_days}</div>
        </div>
        <div style="padding: 10px; background: rgba(220,38,38,0.08); border-radius: 6px; text-align: center;">
          <div style="font-size: 0.7rem; text-transform: uppercase; color: var(--text-muted); font-weight: 700;">Absent</div>
          <div style="font-size: 1.4rem; font-weight: 800; color: #DC2626;">${record.absent_days}</div>
        </div>
        <div style="padding: 10px; background: rgba(2,132,199,0.08); border-radius: 6px; text-align: center;">
          <div style="font-size: 0.7rem; text-transform: uppercase; color: var(--text-muted); font-weight: 700;">Working Days</div>
          <div style="font-size: 1.4rem; font-weight: 800; color: #0284C7;">${record.working_days}</div>
        </div>
        <div style="padding: 10px; background: rgba(212,168,67,0.08); border-radius: 6px; text-align: center;">
          <div style="font-size: 0.7rem; text-transform: uppercase; color: var(--text-muted); font-weight: 700;">Cells Filled</div>
          <div style="font-size: 1.4rem; font-weight: 800; color: var(--accent-gold);">
            ${record.days_provided}/${record.working_days}
          </div>
        </div>
      </div>

      <h4 style="font-size: 0.85rem; color: var(--accent-gold); margin-bottom: 10px;
                 text-transform: uppercase; letter-spacing: 0.4px;">
        Daily Grid — ${ATTENDANCE_MONTH_NAMES[currentAttendanceMonth - 1]} ${currentAttendanceYear}
      </h4>
      <div style="display: grid; grid-template-columns: repeat(7, 1fr); gap: 6px;">
    `;

    ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].forEach(d => {
      html += `<div style="text-align:center; font-size:0.7rem; font-weight:700;
                           color: var(--text-muted); padding: 4px;">${d}</div>`;
    });

    const firstDow = new Date(currentAttendanceYear, currentAttendanceMonth - 1, 1).getDay();
    for (let i = 0; i < firstDow; i++) html += `<div></div>`;

    const days = Array.isArray(record.days) ? record.days : [];
    for (let d = 1; d <= daysInMonth; d++) {
      const date = new Date(currentAttendanceYear, currentAttendanceMonth - 1, d);
      const working = _attendanceIsWorkingDay(date);
      const v = days[d - 1] || '';

            // Rule: P = green; A or blank = red (both shown as 'A').
      let bg, color, label;
      if (!working) {
        bg = 'rgba(148,163,184,0.12)'; color = 'var(--text-muted)'; label = '·';
      } else if (v === 'P') {
        bg = 'rgba(22,163,74,0.15)';  color = '#16A34A'; label = 'P';
      } else {
        bg = 'rgba(220,38,38,0.15)';  color = '#DC2626'; label = 'A';
      }

      html += `
        <div style="padding:8px 4px; background:${bg}; border-radius:4px; text-align:center;
                    border: 1px solid var(--border-color);">
          <div style="font-size:0.68rem; color:var(--text-muted); font-weight:600;">${d}</div>
          <div style="font-size:0.9rem; font-weight:800; color:${color};">${label}</div>
        </div>
      `;
    }
    html += `</div>
      <div style="margin-top:16px; padding:10px; background: rgba(212,168,67,0.08);
                  border-left: 3px solid var(--accent-gold); border-radius: 4px;
                  font-size:0.75rem; color: var(--text-muted);">
        <strong style="color: var(--accent-gold);">Legend:</strong>
        <span style="color:#16A34A; font-weight:700;">P</span> = Present,
        <span style="color:#DC2626; font-weight:700;">A</span> = Absent,
        <span style="color:var(--text-muted);">·</span> = Weekend or public holiday (not counted).
      </div>
    `;

    document.getElementById('attendanceDetailBody').innerHTML = html;
    openModal('attendanceDetailModal');
  } catch (err) {
    showAlert('Could not load detail: ' + err.message);
  }
}

// ------------------------------------------------------------------
// Import flow
// ------------------------------------------------------------------
function openAttendanceImportModal() {
  const now = new Date();
  document.getElementById('attendanceImportMonth').value = now.getMonth() + 1;
  document.getElementById('attendanceImportYear').value  = now.getFullYear();
  document.getElementById('attendancePasteData').value   = '';
  document.getElementById('attendanceFileInput').value   = '';
  document.getElementById('attendanceImportPreview').style.display = 'none';
  pendingAttendanceImport = null;
  openModal('attendanceImportModal');
}

function handleAttendanceFileUpload(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    document.getElementById('attendancePasteData').value = e.target.result;
  };
  reader.readAsText(file);
}

function parseAttendanceText(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  if (!lines.length) return { rows: [], skippedHeader: false };

  // Split the first line the same way we'll split every line.
  const firstLine = lines[0];
  const firstParts = (firstLine.includes('\t')
    ? firstLine.split('\t')
    : firstLine.split(',')).map(p => p.trim());

  // A real header has these traits:
  //   1. First cell is literally "name" or "full name" (or contains "full name")
  //   2. Second cell mentions "file" or "isse file"
  // A data row will have a person's name in cell 1, so this check is safe.
  const firstCell  = (firstParts[0] || '').toLowerCase();
  const secondCell = (firstParts[1] || '').toLowerCase();

  const looksLikeNameHeader =
    firstCell === 'name' ||
    firstCell === 'full name' ||
    firstCell.includes('full name') ||
    firstCell.includes('staff name');

  const looksLikeFileHeader =
    secondCell.includes('file no') ||
    secondCell.includes('file number') ||
    secondCell.includes('isse file');

  const skipFirst = looksLikeNameHeader && looksLikeFileHeader;
  const startIdx = skipFirst ? 1 : 0;

  const rows = [];
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];
    const parts = line.includes('\t')
      ? line.split('\t').map(p => p.trim())
      : line.split(',').map(p => p.trim());

    if (parts.length < 3) continue;

    rows.push({
      fullName:   parts[0],
      isseFileNo: parts[1],
      days:       parts.slice(2)
    });
  }

  return { rows, skippedHeader: skipFirst };
}

async function previewAttendanceImport() {
  const year  = parseInt(document.getElementById('attendanceImportYear').value, 10);
  const month = parseInt(document.getElementById('attendanceImportMonth').value, 10);
  const text  = document.getElementById('attendancePasteData').value;

  if (!year || !month || !text.trim()) {
    showAlert('Please select a month/year and paste the attendance data.');
    return;
  }

  const daysInMonth = new Date(year, month, 0).getDate();
  const { rows, skippedHeader } = parseAttendanceText(text);

  if (!rows.length) {
    showAlert('No valid rows found in the pasted data.');
    return;
  }

  // Fetch staff to validate file numbers
  const staffRes = await fetch(`${API_BASE}/admin/staff`);
  const staffList = await staffRes.json();
  const staffMap = new Map();
  (staffList || []).forEach(s => staffMap.set(String(s.isse_file_no).toLowerCase(), s));

  const validRows = [];
  const rowErrors = [];

  rows.forEach((r, i) => {
    const staff = staffMap.get(String(r.isseFileNo).toLowerCase());
    if (!staff) {
      rowErrors.push(`Row ${i + 1} (${r.isseFileNo}): Staff not found in directory.`);
      return;
    }

        // Build the working-day calendar list for this month.
    // The biometric sheet has ONLY working-day columns, so pasted cell N
    // maps to workingDaysList[N-1] — a specific calendar day.
    const workingDaysList = [];
    for (let d = 1; d <= daysInMonth; d++) {
      if (_attendanceIsWorkingDay(new Date(year, month - 1, d))) {
        workingDaysList.push(d);
      }
    }
    const expectedWorkingDays = workingDaysList.length;

    // Validate + normalise the pasted working-day cells.
    const normalisedWorking = [];
    for (let wd = 0; wd < expectedWorkingDays; wd++) {
      const raw = r.days[wd];
      const v = (raw === null || raw === undefined)
        ? ''
        : String(raw).trim().toUpperCase();
      if (v === '' || v === 'A' || v === 'P') {
        normalisedWorking.push(v);
      } else {
        rowErrors.push(`Row ${i + 1} (${r.isseFileNo}): invalid value "${raw}" on working day ${wd + 1}.`);
        normalisedWorking.push('');
      }
    }

        // Calculate directly from the working-day cells (no expansion here).
    // The backend performs its own expansion on receipt.
    // Rule: P = Present; A or blank = Absent.
    let present = 0, absent = 0, provided = 0;
    for (let wd = 0; wd < expectedWorkingDays; wd++) {
      const v = normalisedWorking[wd];
      if (v !== '') provided++;
      if (v === 'P') present++;
      else absent++;
    }
    const working = expectedWorkingDays;
    const percentage = working > 0 ? Number(((present / working) * 100).toFixed(2)) : 0;

    validRows.push({
      fullName:     staff.full_name || r.fullName,
      isseFileNo:   staff.isse_file_no,
      department:   staff.department || '',
      // Send working-day cells — the backend will expand them into
      // the full calendar-day array before storing.
      days:         normalisedWorking,
      presentDays:  present,
      absentDays:   absent,
      workingDays:  working,
      daysProvided: provided,
      percentage
    });
  });

  const preview = document.getElementById('attendanceImportPreview');
  preview.style.display = 'block';

  const partialRows = validRows.filter(r => r.daysProvided < r.workingDays).length;

  let html = `
    <div style="margin-bottom: 8px;">
      <strong>Preview:</strong> ${validRows.length} valid row(s), ${rowErrors.length} error(s)
      ${skippedHeader ? ' <em style="color: var(--text-muted);">(header row skipped)</em>' : ''}
    </div>
    <div style="max-height: 220px; overflow-y: auto; border: 1px solid var(--border-color); border-radius: 4px;">
      <table style="width: 100%; font-size: 0.78rem; border-collapse: collapse;">
        <thead>
          <tr style="background: var(--nav-dark); color: var(--text-header);">
            <th style="padding: 6px; text-align: left;">File No</th>
            <th style="padding: 6px; text-align: left;">Name</th>
            <th style="padding: 6px; text-align: center;">Present</th>
            <th style="padding: 6px; text-align: center;">Absent</th>
            <th style="padding: 6px; text-align: center;">Filled</th>
            <th style="padding: 6px; text-align: center;">%</th>
          </tr>
        </thead>
        <tbody>
  `;

  validRows.slice(0, 25).forEach(r => {
    html += `
      <tr style="border-bottom: 1px solid var(--border-color);">
        <td style="padding: 4px 6px;">${escapeHtml(r.isseFileNo)}</td>
        <td style="padding: 4px 6px;">${escapeHtml(r.fullName)}</td>
        <td style="padding: 4px 6px; text-align: center; color: #16A34A; font-weight: 700;">${r.presentDays}</td>
        <td style="padding: 4px 6px; text-align: center; color: #DC2626; font-weight: 700;">${r.absentDays}</td>
        <td style="padding: 4px 6px; text-align: center;">${r.daysProvided}/${r.workingDays}</td>
        <td style="padding: 4px 6px; text-align: center; font-weight: 800;">${r.percentage}%</td>
      </tr>
    `;
  });

  if (validRows.length > 25) {
    html += `<tr><td colspan="6" style="padding: 6px; text-align: center; color: var(--text-muted);">
      …and ${validRows.length - 25} more rows
    </td></tr>`;
  }

  html += `</tbody></table></div>`;

    if (partialRows > 0) {
    html += `
      <div style="margin-top: 10px; padding: 10px 12px; background: rgba(245,158,11,0.12);
                  border-left: 3px solid #F59E0B; border-radius: 3px; font-size: 0.8rem;">
        ⚠️ <strong>${partialRows} row(s)</strong> have missing cells for some working days.
        Per the current rule, missing cells count as <strong>Absent</strong>, which may deflate percentages.
        Confirm the sheet is complete for the month before importing.
      </div>
    `;
  }

  if (rowErrors.length > 0) {
    html += `
      <div style="margin-top: 10px; padding: 8px 12px; background: rgba(220,38,38,0.1);
                  border-left: 3px solid #DC2626; border-radius: 3px;">
        <strong style="color: #DC2626;">Errors (${rowErrors.length}):</strong>
        <div style="font-size: 0.75rem; margin-top: 4px; max-height: 100px; overflow-y: auto;">
          ${rowErrors.slice(0, 15).map(e => escapeHtml(e)).join('<br>')}
          ${rowErrors.length > 15 ? '<br>…and more.' : ''}
        </div>
      </div>
    `;
  }

  preview.innerHTML = html;

  pendingAttendanceImport = {
    year, month,
    rows: validRows.map(r => ({
      fullName:   r.fullName,
      isseFileNo: r.isseFileNo,
      days:       r.days
    }))
  };
}

async function confirmAttendanceImport() {
  if (!pendingAttendanceImport || !pendingAttendanceImport.rows.length) {
    showAlert('Please click Preview first to validate the data.');
    return;
  }

  const btn = document.getElementById('attendanceImportConfirmBtn');
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Importing...';

  try {
    const res = await fetch(`${API_BASE}/admin/attendance/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(pendingAttendanceImport)
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Import failed.');

    // Jump the picker to the month we just imported
    currentAttendanceYear  = pendingAttendanceImport.year;
    currentAttendanceMonth = pendingAttendanceImport.month;
    attendanceMonthsLoaded = false;
    pendingAttendanceImport = null;

        closeModal('attendanceImportModal');

    // Compose a message that also lists any rows the backend skipped.
    let msg = data.message || `Imported ${data.imported} records.`;
    if (data.skipped > 0 && Array.isArray(data.errors) && data.errors.length > 0) {
      const preview = data.errors.slice(0, 5).map(e => {
        const label = e.row ? `Row ${e.row}` : (e.fileNo || 'unknown');
        return `${label}: ${e.error}`;
      }).join('\n');
      msg += `\n\nSkipped rows:\n${preview}`;
      if (data.errors.length > 5) {
        msg += `\n…and ${data.errors.length - 5} more.`;
      }
    }
    showAlert(msg);

    await initAttendancePage();
  } catch (err) {
    showAlert(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
}

// ------------------------------------------------------------------
// Threshold settings modal
// ------------------------------------------------------------------
async function openAttendanceSettingsModal() {
  await loadAttendanceThresholds();
  document.getElementById('attendanceExcellentThreshold').value = cachedAttendanceThresholds.excellent;
  document.getElementById('attendanceGoodThreshold').value      = cachedAttendanceThresholds.good;
  document.getElementById('attendanceWarningThreshold').value   = cachedAttendanceThresholds.warning;
  openModal('attendanceSettingsModal');
}

async function saveAttendanceSettings() {
  const excellent = parseFloat(document.getElementById('attendanceExcellentThreshold').value);
  const good      = parseFloat(document.getElementById('attendanceGoodThreshold').value);
  const warning   = parseFloat(document.getElementById('attendanceWarningThreshold').value);

  if ([excellent, good, warning].some(v => isNaN(v))) {
    showAlert('All thresholds must be valid numbers.');
    return;
  }
  if (warning > good || good > excellent) {
    showAlert('Thresholds must be ordered: Warning ≤ Good ≤ Excellent.');
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/admin/attendance/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ excellent, good, warning })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Save failed.');

    cachedAttendanceThresholds = { excellent, good, warning };
    closeModal('attendanceSettingsModal');
    showAlert('Thresholds saved.');

    renderAttendanceMetrics(cachedAttendanceRecords);
    applyAttendanceFilters();
  } catch (err) {
    showAlert(err.message);
  }
}

// ------------------------------------------------------------------
// CSV export
// ------------------------------------------------------------------
function exportAttendanceCSV() {
  if (!cachedAttendanceRecords.length) {
    showAlert('No attendance records to export.');
    return;
  }

  const esc = v => v === null || v === undefined ? '' :
    `"${String(v).replace(/"/g, '""')}"`;

  const headers = ['ISSE File No','Full Name','Department','Present','Absent','Working Days','Filled','Percentage','Status'];

  let csv = '\uFEFF' + headers.map(esc).join(',') + '\r\n';

  cachedAttendanceRecords.forEach(r => {
    const pct = parseFloat(r.percentage) || 0;
    const cls = classifyAttendance(pct);
    csv += [
      r.isse_file_no, r.full_name, r.department || '',
      r.present_days, r.absent_days, r.working_days,
      `${r.days_provided}/${r.working_days}`,
      pct.toFixed(2) + '%', cls.label
    ].map(esc).join(',') + '\r\n';
  });

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const stamp = `${ATTENDANCE_MONTH_NAMES[currentAttendanceMonth - 1]}_${currentAttendanceYear}`;

  const a = document.createElement('a');
  a.href = url;
  a.download = `ISSE_Attendance_${stamp}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  showAlert(`Exported ${cachedAttendanceRecords.length} attendance records.`);
}

// ------------------------------------------------------------------
// Wire up month picker (runs once on load)
// ------------------------------------------------------------------
// ------------------------------------------------------------------
// Delete entire month (admin)
// ------------------------------------------------------------------
async function confirmDeleteAttendanceMonth() {
  if (!currentAttendanceYear || !currentAttendanceMonth) {
    showAlert('No month is currently selected.');
    return;
  }

  // Refresh the record list first so the count is accurate
  try {
    const res = await fetch(
      `${API_BASE}/admin/attendance?year=${currentAttendanceYear}&month=${currentAttendanceMonth}`
    );
    if (res.ok) {
      cachedAttendanceRecords = await res.json();
    }
  } catch (_) { /* proceed with whatever we have cached */ }

  const recordCount = cachedAttendanceRecords.length;

  if (recordCount === 0) {
    showAlert('There are no attendance records for the selected month.');
    return;
  }

  const monthLabel = `${ATTENDANCE_MONTH_NAMES[currentAttendanceMonth - 1]} ${currentAttendanceYear}`;
  const infoEl = document.getElementById('deleteAttendanceMonthInfo');
  if (infoEl) {
    infoEl.innerHTML = `You are about to permanently delete <strong>all ${recordCount} attendance record(s)</strong>
      for <strong>${monthLabel}</strong>. This will wipe the entire month for every staff member in your scope.`;
  }

  const btn = document.getElementById('deleteAttendanceMonthConfirmBtn');
  if (btn) { btn.disabled = false; btn.textContent = 'Yes, Delete Month'; }

  openModal('deleteAttendanceMonthModal');
}

function closeDeleteAttendanceMonthModal() {
  closeModal('deleteAttendanceMonthModal');
}

async function executeDeleteAttendanceMonth() {
  if (!currentAttendanceYear || !currentAttendanceMonth) return;

  const year  = currentAttendanceYear;
  const month = currentAttendanceMonth;
  const monthLabel = `${ATTENDANCE_MONTH_NAMES[month - 1]} ${year}`;

  const btn = document.getElementById('deleteAttendanceMonthConfirmBtn');
  const orig = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Deleting...'; }

  try {
    const res = await fetch(
      `${API_BASE}/admin/attendance/month?year=${year}&month=${month}`,
      { method: 'DELETE' }
    );
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Delete failed.');

    closeDeleteAttendanceMonthModal();
    showAlert(data.message || `Deleted ${data.deleted || 0} record(s) for ${monthLabel}.`);

    // Refresh the month dropdown and reset the current selection,
    // because this month may have just disappeared entirely.
    attendanceMonthsLoaded = false;
    currentAttendanceYear  = null;
    currentAttendanceMonth = null;
    await initAttendancePage();
  } catch (err) {
    showAlert(err.message);
    if (btn) { btn.disabled = false; btn.textContent = orig; }
  }
}
// ------------------------------------------------------------------
// Per-record edit (admin)
// ------------------------------------------------------------------
let _editingAttendance = null;

function openAttendanceEditModal(fileNo) {
  if (!currentAttendanceYear || !currentAttendanceMonth) return;

  const record = cachedAttendanceRecords.find(
    r => String(r.isse_file_no).toLowerCase() === String(fileNo).toLowerCase()
  );
  if (!record) {
    showAlert('Attendance record not found in the current view.');
    return;
  }

  const year  = currentAttendanceYear;
  const month = currentAttendanceMonth;
  const daysInMonth = new Date(year, month, 0).getDate();

  // Build the working-day calendar list for the month.
  const workingDaysList = [];
  for (let d = 1; d <= daysInMonth; d++) {
    if (_attendanceIsWorkingDay(new Date(year, month - 1, d))) workingDaysList.push(d);
  }

  // Extract current P/A values for each working day.
  // Blank → 'A' (matching the stored rule that blank = absent).
  const days = Array.isArray(record.days) ? record.days : [];
  const values = workingDaysList.map(calDay => {
    const v = days[calDay - 1] || '';
    return v === 'P' ? 'P' : 'A';
  });

  _editingAttendance = {
    fileNo: record.isse_file_no,
    fullName: record.full_name,
    department: record.department,
    year, month, daysInMonth, workingDaysList, values
  };

  renderAttendanceEditModal();
  openModal('editAttendanceRecordModal');
}

function renderAttendanceEditModal() {
  if (!_editingAttendance) return;
  const { fullName, fileNo, year, month, daysInMonth, workingDaysList, values } = _editingAttendance;

  document.getElementById('editAttendanceRecordTitle').textContent =
    `Edit Attendance — ${fullName} (${ATTENDANCE_MONTH_NAMES[month - 1]} ${year})`;

  // Live summary
  let present = 0, absent = 0;
  values.forEach(v => { if (v === 'P') present++; else absent++; });
  const working = values.length;
  const percentage = working > 0
    ? Number(((present / working) * 100).toFixed(2))
    : 0;
  const cls = classifyAttendance(percentage);

  let html = `
    <div style="display: grid; grid-template-columns: 2fr 1fr; gap: 15px; margin-bottom: 15px;">
      <div>
        <div style="font-size: 0.72rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px;">Staff</div>
        <div style="font-size: 1.05rem; font-weight: 700;">${escapeHtml(fullName)}</div>
        <div style="font-size: 0.82rem; color: var(--text-muted);">
          ${escapeHtml(fileNo)} &middot; ${escapeHtml(_editingAttendance.department || '—')}
        </div>
      </div>
      <div style="text-align: right;">
        <div style="font-size: 0.72rem; color: var(--text-muted); text-transform: uppercase;">Live Attendance</div>
        <div style="font-size: 1.6rem; font-weight: 800; color: ${cls.color};">
          ${percentage.toFixed(2)}%
        </div>
        <span class="status-badge ${cls.cls}" style="margin-top: 4px; display: inline-block;">${cls.label}</span>
      </div>
    </div>

    <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 18px;">
      <div style="padding: 10px; background: rgba(22,163,74,0.08); border-radius: 6px; text-align: center;">
        <div style="font-size: 0.7rem; text-transform: uppercase; color: var(--text-muted); font-weight: 700;">Present</div>
        <div style="font-size: 1.4rem; font-weight: 800; color: #16A34A;">${present}</div>
      </div>
      <div style="padding: 10px; background: rgba(220,38,38,0.08); border-radius: 6px; text-align: center;">
        <div style="font-size: 0.7rem; text-transform: uppercase; color: var(--text-muted); font-weight: 700;">Absent</div>
        <div style="font-size: 1.4rem; font-weight: 800; color: #DC2626;">${absent}</div>
      </div>
      <div style="padding: 10px; background: rgba(2,132,199,0.08); border-radius: 6px; text-align: center;">
        <div style="font-size: 0.7rem; text-transform: uppercase; color: var(--text-muted); font-weight: 700;">Working Days</div>
        <div style="font-size: 1.4rem; font-weight: 800; color: #0284C7;">${working}</div>
      </div>
    </div>

    <div style="font-size: 0.78rem; color: var(--text-muted); margin-bottom: 10px;">
      Click a working day to toggle between
      <strong style="color:#16A34A;">P</strong> (Present) and
      <strong style="color:#DC2626;">A</strong> (Absent).
      Weekends and public holidays are not editable.
    </div>

    <div style="display: grid; grid-template-columns: repeat(7, 1fr); gap: 6px;">
  `;

  ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].forEach(d => {
    html += `<div style="text-align:center; font-size:0.7rem; font-weight:700;
                         color: var(--text-muted); padding: 4px;">${d}</div>`;
  });

  const firstDow = new Date(year, month - 1, 1).getDay();
  for (let i = 0; i < firstDow; i++) html += `<div></div>`;

  const calDayToWorkingIdx = {};
  workingDaysList.forEach((calDay, idx) => { calDayToWorkingIdx[calDay] = idx; });

  for (let d = 1; d <= daysInMonth; d++) {
    const date = new Date(year, month - 1, d);
    const isWorking = _attendanceIsWorkingDay(date);
    const wIdx = calDayToWorkingIdx[d];

    if (!isWorking || wIdx === undefined) {
      html += `
        <div style="padding:8px 4px; background: rgba(148,163,184,0.12); border-radius:4px;
                    text-align:center; border: 1px solid var(--border-color); opacity: 0.55;">
          <div style="font-size:0.68rem; color:var(--text-muted); font-weight:600;">${d}</div>
          <div style="font-size:0.9rem; font-weight:800; color:var(--text-muted);">·</div>
        </div>
      `;
    } else {
      const isP = values[wIdx] === 'P';
      const bg    = isP ? 'rgba(22,163,74,0.15)' : 'rgba(220,38,38,0.15)';
      const color = isP ? '#16A34A' : '#DC2626';
      html += `
        <button type="button"
                onclick="toggleAttendanceCell(${wIdx})"
                title="Click to toggle"
                style="padding:8px 4px; background:${bg}; border-radius:4px; text-align:center;
                       border: 2px solid ${color}; cursor: pointer; font-family: inherit;
                       transition: transform 0.1s; padding: 8px 4px;">
          <div style="font-size:0.68rem; color:var(--text-muted); font-weight:600;">${d}</div>
          <div style="font-size:0.95rem; font-weight:800; color:${color};">${values[wIdx]}</div>
        </button>
      `;
    }
  }
  html += `</div>`;

  document.getElementById('editAttendanceRecordBody').innerHTML = html;
}

function toggleAttendanceCell(wIdx) {
  if (!_editingAttendance) return;
  const values = _editingAttendance.values;
  values[wIdx] = values[wIdx] === 'P' ? 'A' : 'P';
  renderAttendanceEditModal();
}

function closeEditAttendanceRecordModal() {
  closeModal('editAttendanceRecordModal');
  _editingAttendance = null;
}

async function saveAttendanceEdit() {
  if (!_editingAttendance) return;

  const { fileNo, year, month, values } = _editingAttendance;
  const btn = document.getElementById('editAttendanceRecordSaveBtn');
  const orig = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }

  try {
    const res = await fetch(`${API_BASE}/admin/attendance/record`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileNo, year, month, workingDayValues: values })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Save failed.');

    closeEditAttendanceRecordModal();
    showAlert(data.message || 'Attendance record updated.');

    // Refresh the table so the updated counts and % appear
    await loadAttendanceRecords();
  } catch (err) {
    showAlert(err.message);
    if (btn) { btn.disabled = false; btn.textContent = orig; }
  }
}

// ------------------------------------------------------------------
// Per-record delete (admin)
// ------------------------------------------------------------------
let _deleteAttendanceTarget = null;

function confirmDeleteAttendanceRecord(fileNo) {
  if (!currentAttendanceYear || !currentAttendanceMonth) return;

  const record = cachedAttendanceRecords.find(
    r => String(r.isse_file_no).toLowerCase() === String(fileNo).toLowerCase()
  );
  const displayName = record ? record.full_name : fileNo;

  _deleteAttendanceTarget = { fileNo, year: currentAttendanceYear, month: currentAttendanceMonth };

  const infoEl = document.getElementById('deleteAttendanceRecordInfo');
  if (infoEl) {
    infoEl.innerHTML = `You are about to permanently delete the attendance record for
      <strong>${escapeHtml(displayName)}</strong> (${escapeHtml(fileNo)})
      for <strong>${ATTENDANCE_MONTH_NAMES[currentAttendanceMonth - 1]} ${currentAttendanceYear}</strong>.`;
  }

  const btn = document.getElementById('deleteAttendanceRecordConfirmBtn');
  if (btn) { btn.disabled = false; btn.textContent = 'Yes, Delete'; }

  openModal('deleteAttendanceRecordModal');
}

function closeDeleteAttendanceRecordModal() {
  closeModal('deleteAttendanceRecordModal');
  _deleteAttendanceTarget = null;
}

async function executeDeleteAttendanceRecord() {
  if (!_deleteAttendanceTarget) return;

  const { fileNo, year, month } = _deleteAttendanceTarget;
  const btn = document.getElementById('deleteAttendanceRecordConfirmBtn');
  const orig = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Deleting...'; }

    try {
    const res = await fetch(
      `${API_BASE}/admin/attendance/record?fileNo=${encodeURIComponent(fileNo)}&year=${year}&month=${month}`,
      { method: 'DELETE' }
    );
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Delete failed.');

    closeDeleteAttendanceRecordModal();
    showAlert(data.message || 'Attendance record deleted.');

    // Refresh the current month's records + metrics + dropdown
    attendanceMonthsLoaded = false;
    await loadAttendanceMonths();
    await loadAttendanceRecords();
  } catch (err) {
    showAlert(err.message);
    if (btn) { btn.disabled = false; btn.textContent = orig; }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const sel = document.getElementById('attendanceMonthSelect');
  if (sel) {
    sel.addEventListener('change', (e) => {
      const [y, m] = e.target.value.split('-').map(Number);
      if (!y || !m) return;
      currentAttendanceYear  = y;
      currentAttendanceMonth = m;
      loadAttendanceRecords();
    });
  }
});

// ============================================================
// STAFF ENQUIRIES BADGE
// ============================================================
// Sidebar bubble showing how many staff enquiries are still
// unread. Refreshed by refreshDashboard() on the same 10-second
// polling interval as the other badges.

async function refreshStaffEnquiriesBadge() {
  if (!currentAdminUser) return;
  if (!hasFrontendPermission('staff_enquiries.manage')) return;

  try {
    const res = await fetch(`${API_BASE}/admin/staff-enquiries/unread-count`);
    if (!res.ok) return;
    const data = await res.json();

    const badge = document.getElementById('badgeStaffEnquiries');
    if (!badge) return;

    const count = data && typeof data.count === 'number' ? data.count : 0;
    if (count > 0) {
      badge.textContent = count > 99 ? '99+' : count;
      badge.style.display = 'inline-block';
    } else {
      badge.style.display = 'none';
    }
  } catch (_) {
    /* silent — the badge just won't update this cycle */
  }
}

window.refreshStaffEnquiriesBadge = refreshStaffEnquiriesBadge;

// ============================================================
// STAFF ENQUIRIES — ADMIN PAGE
// ============================================================

let cachedStaffEnquiries = [];
let currentEnquiryId       = null;

function escapeEnquiryHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatEnquiryDate(ts) {
  if (!ts) return '—';
  try {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleString('en-GB', {
      day: 'numeric', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
  } catch (_) {
    return '—';
  }
}

function staffEnquiryStatusBadge(status) {
  if (status === 'replied') {
    return '<span class="status-badge badge-approved">Replied</span>';
  }
  if (status === 'not replied') {
    return '<span class="status-badge badge-pending">Awaiting Reply</span>';
  }
  return '<span class="status-badge" style="background:rgba(220,38,38,0.15); color:#DC2626; border:1px solid #DC2626;">Unread</span>';
}

// ---- Load list ----
async function loadStaffEnquiriesPage() {
  const tbody = document.getElementById('enquiriesTableBody');
  if (!tbody) return;

  tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--text-muted);">Loading enquiries...</td></tr>';

  try {
    const res = await fetch(`${API_BASE}/admin/staff-enquiries`);
    if (!res.ok) throw new Error('Failed to load enquiries.');
    cachedStaffEnquiries = await res.json();
    applyStaffEnquiriesFilters();
    refreshStaffEnquiriesBadge();
  } catch (err) {
    console.error('Enquiries load error:', err);
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#DC2626;">Failed to load enquiries.</td></tr>';
  }
}

// ---- Filters + render ----
function resetStaffEnquiriesFilters() {
  const s = document.getElementById('enquiriesSearchInput');
  const f = document.getElementById('enquiriesStatusFilter');
  if (s) s.value = '';
  if (f) f.value = '';
  applyStaffEnquiriesFilters();
}

function applyStaffEnquiriesFilters() {
  const tbody = document.getElementById('enquiriesTableBody');
  if (!tbody) return;

  const search = (document.getElementById('enquiriesSearchInput')?.value || '').trim().toLowerCase();
  const statusFilter = document.getElementById('enquiriesStatusFilter')?.value || '';

  let rows = cachedStaffEnquiries.slice();

  if (search) {
    rows = rows.filter(e =>
      (e.staff_name    || '').toLowerCase().includes(search) ||
      (e.isse_file_no  || '').toLowerCase().includes(search) ||
      (e.department    || '').toLowerCase().includes(search) ||
      (e.subject       || '').toLowerCase().includes(search) ||
      (e.message       || '').toLowerCase().includes(search)
    );
  }

  if (statusFilter) {
    rows = rows.filter(e => e.status === statusFilter);
  }

  const countEl = document.getElementById('enquiriesFilterCount');
  if (countEl) {
    countEl.textContent = `Showing ${rows.length} of ${cachedStaffEnquiries.length} enquir${cachedStaffEnquiries.length === 1 ? 'y' : 'ies'}`;
  }

  if (!rows.length) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" class="empty-state-cell" style="padding: 35px 16px; text-align: center;">
          <div style="font-size: 1.8rem; margin-bottom: 6px;">✉️</div>
          <div style="font-weight: 700; color: var(--text-primary); margin-bottom: 4px;">No enquiries match</div>
          <div style="font-size: 0.85rem; color: var(--text-muted);">Try clearing filters or check back later.</div>
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = rows.map(e => {
    const isUnread = e.status === 'unread';
    const rowStyle = isUnread
      ? 'background: rgba(212,168,67,0.06); border-left: 3px solid var(--accent-gold);'
      : '';

    const subject = e.subject && e.subject.trim() ? e.subject : '(No subject)';
    const preview = (e.message || '').length > 70
      ? e.message.substring(0, 70) + '…'
      : (e.message || '');

    const refCode = `#SE-${e.id}`;

    return `
      <tr style="${rowStyle}">
        <td><strong style="color: var(--accent-gold);">${refCode}</strong></td>
        <td style="font-size: 0.8rem;">${formatEnquiryDate(e.created_at)}</td>
        <td>
          <strong>${escapeEnquiryHtml(e.staff_name)}</strong>
          <div style="font-size: 0.75rem; color: var(--accent-gold);">${escapeEnquiryHtml(e.isse_file_no)}</div>
        </td>
        <td><span class="dept-badge">${escapeEnquiryHtml(e.department || '—')}</span></td>
        <td style="max-width: 320px;">
          <div style="font-weight: 600; font-size: 0.85rem; margin-bottom: 3px;">${escapeEnquiryHtml(subject)}</div>
          <div style="font-size: 0.78rem; color: var(--text-muted); word-wrap: break-word;">${escapeEnquiryHtml(preview)}</div>
        </td>
        <td>${staffEnquiryStatusBadge(e.status)}</td>
        <td>
          <button class="action-btn btn-edit" onclick="openStaffEnquiryDetail(${e.id})">👁️ View</button>
        </td>
      </tr>
    `;
  }).join('');
}

// ---- Detail modal ----
async function openStaffEnquiryDetail(enquiryId) {
  currentEnquiryId = enquiryId;

  const modal = document.getElementById('staffEnquiryModal');
  const titleEl = document.getElementById('staffEnquiryModalTitle');
  const bodyEl = document.getElementById('staffEnquiryModalBody');
  if (!modal || !bodyEl) return;

  if (titleEl) titleEl.textContent = 'Loading enquiry...';
  bodyEl.innerHTML = 'Loading...';
  modal.style.display = 'flex';

  try {
    const res = await fetch(`${API_BASE}/admin/staff-enquiries/${enquiryId}`);
    if (!res.ok) throw new Error('Failed to load enquiry.');
    const e = await res.json();

    // Backend flips 'unread' → 'not replied' when we GET the detail.
    // Refresh the list + badge so the sidebar reflects the change.
    if (e.status === 'not replied' && cachedStaffEnquiries.some(x => x.id === enquiryId && x.status === 'unread')) {
      const cached = cachedStaffEnquiries.find(x => x.id === enquiryId);
      if (cached) cached.status = 'not replied';
      applyStaffEnquiriesFilters();
    }

    if (titleEl) {
      titleEl.textContent = `Enquiry ${e.subject && e.subject.trim() ? '· ' + e.subject : '#SE-' + e.id}`;
    }

    const hasPermission = hasFrontendPermission('staff_enquiries.manage');

    let html = `
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 18px; padding: 14px 16px; background: var(--bg-main); border-radius: 8px; border: 1px solid var(--border-color);">
        <div>
          <div style="font-size: 0.7rem; text-transform: uppercase; color: var(--text-muted); letter-spacing: 0.5px; font-weight: 700;">Staff</div>
          <div style="font-size: 0.92rem; font-weight: 700;">${escapeEnquiryHtml(e.staff_name)}</div>
          <div style="font-size: 0.8rem; color: var(--accent-gold);">${escapeEnquiryHtml(e.isse_file_no)}</div>
        </div>
        <div>
          <div style="font-size: 0.7rem; text-transform: uppercase; color: var(--text-muted); letter-spacing: 0.5px; font-weight: 700;">Department</div>
          <div style="font-size: 0.92rem; font-weight: 700;">${escapeEnquiryHtml(e.department || '—')}</div>
          <div style="font-size: 0.8rem; color: var(--text-muted);">${escapeEnquiryHtml(e.staff_email || 'No email on file')}</div>
        </div>
        <div style="grid-column: 1 / -1;">
          <div style="font-size: 0.7rem; text-transform: uppercase; color: var(--text-muted); letter-spacing: 0.5px; font-weight: 700;">Sent</div>
          <div style="font-size: 0.85rem;">${formatEnquiryDate(e.created_at)}</div>
        </div>
      </div>

      <div style="background: var(--bg-main); border-left: 4px solid var(--accent-gold); padding: 14px 16px; border-radius: 6px; margin-bottom: 20px;">
        <div style="font-size: 0.72rem; color: var(--accent-gold); font-weight: 700; text-transform: uppercase; letter-spacing: 0.4px; margin-bottom: 8px;">
          Staff Message
        </div>
        <div style="font-size: 0.9rem; line-height: 1.65; white-space: pre-wrap; color: var(--text-primary);">${escapeEnquiryHtml(e.message || '')}</div>
      </div>
    `;

    if (e.reply) {
      html += `
        <div style="background: rgba(22,163,74,0.08); border-left: 4px solid #16A34A; padding: 14px 16px; border-radius: 6px; margin-bottom: 18px;">
          <div style="font-size: 0.72rem; color: #16A34A; font-weight: 700; text-transform: uppercase; letter-spacing: 0.4px; margin-bottom: 8px;">
            ✅ Reply sent by ${escapeEnquiryHtml(e.reply.admin_username)}${e.reply.admin_role ? ` · ${escapeEnquiryHtml(e.reply.admin_role)}` : ''}
          </div>
          <div style="font-size: 0.9rem; line-height: 1.65; white-space: pre-wrap; color: var(--text-primary); margin-bottom: 6px;">${escapeEnquiryHtml(e.reply.body)}</div>
          <div style="font-size: 0.72rem; color: var(--text-muted); text-align: right;">${formatEnquiryDate(e.reply.created_at)}</div>
        </div>
      `;
    } else if (hasPermission) {
      html += `
        <div style="border-top: 1px solid var(--border-color); padding-top: 16px;">
          <label for="staffEnquiryReplyText" style="font-size: 0.85rem; font-weight: 700; color: var(--accent-gold); text-transform: uppercase; letter-spacing: 0.4px; display: block; margin-bottom: 8px;">
            Reply
          </label>
          <textarea id="staffEnquiryReplyText" rows="5"
                    placeholder="Write your reply. It will be emailed to ${escapeEnquiryHtml(e.staff_email || 'the staff member')} immediately."
                    style="width: 100%; padding: 10px 12px; border-radius: 6px; border: 1px solid var(--input-border); background: var(--input-bg); color: var(--text-primary); font-family: inherit; font-size: 0.9rem; resize: vertical;"></textarea>
          <div id="staffEnquiryReplyMsg" style="display: none; margin-top: 10px; padding: 10px 12px; border-radius: 5px; font-size: 0.85rem;"></div>
          <div style="display: flex; justify-content: flex-end; gap: 10px; margin-top: 14px;">
            <button class="action-btn" style="background: var(--text-muted); color: #fff;" onclick="closeStaffEnquiryModal()">Cancel</button>
            <button class="action-btn btn-approve" id="staffEnquirySendBtn" onclick="sendStaffEnquiryReply(${e.id})">✉️ Send Reply</button>
          </div>
        </div>
      `;
    } else {
      html += `
        <div style="background: rgba(148,163,184,0.08); padding: 12px 14px; border-radius: 6px; font-size: 0.85rem; color: var(--text-muted);">
          You do not have permission to reply to this enquiry.
        </div>
      `;
    }

    bodyEl.innerHTML = html;
  } catch (err) {
    console.error('Enquiry detail error:', err);
    bodyEl.innerHTML = `<p style="color:#DC2626;">Could not load this enquiry. Please close and try again.</p>`;
  }
}

function closeStaffEnquiryModal() {
  const modal = document.getElementById('staffEnquiryModal');
  if (modal) modal.style.display = 'none';
  currentEnquiryId = null;
}

// ---- Send reply + fire EmailJS ----
async function sendStaffEnquiryReply(enquiryId) {
  if (!hasFrontendPermission('staff_enquiries.manage')) {
    showAlert('You do not have permission to reply to enquiries.');
    return;
  }

  const textarea = document.getElementById('staffEnquiryReplyText');
  const msgEl = document.getElementById('staffEnquiryReplyMsg');
  const btn = document.getElementById('staffEnquirySendBtn');

  const body = textarea ? textarea.value.trim() : '';
  if (!body) {
    if (msgEl) {
      msgEl.style.display = 'block';
      msgEl.style.background = 'rgba(220,38,38,0.12)';
      msgEl.style.color = '#DC2626';
      msgEl.textContent = 'Please write a reply before sending.';
    }
    return;
  }

  if (btn) { btn.disabled = true; btn.textContent = 'Sending...'; }

  try {
    const res = await fetch(`${API_BASE}/admin/staff-enquiries/${enquiryId}/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to send reply.');

    // Fire the email via EmailJS — same service + template as the
    // website's admin panel, fired client-side.
    let emailSent = false;
    let emailError = null;

    if (typeof emailjs !== 'undefined' && data.staffEmail) {
      try {
        await emailjs.send(
          'service_hwsisjp',
          'template_s4cgwlp',
          {
            to_email: data.staffEmail,
            email_subject: 'Reply to Your Enquiry',
            header_title: 'Reply to Your Enquiry',
            email_body:
              `<p>Dear ${escapeEnquiryHtml(data.staffName || 'Staff member')},</p>` +
              `<p>${escapeEnquiryHtml(body).replace(/\n/g, '<br>')}</p>` +
              `<p>— ${escapeEnquiryHtml(currentAdminUser ? currentAdminUser.username : 'HR')}, ISSE</p>`
          }
        );
        emailSent = true;
      } catch (emailErr) {
        console.error('EmailJS error:', emailErr);
        emailError = emailErr && (emailErr.text || emailErr.message) ? (emailErr.text || emailErr.message) : 'Email could not be delivered.';
      }
    } else if (!data.staffEmail) {
      emailError = 'No email address on file for this staff member.';
    } else {
      emailError = 'EmailJS SDK not loaded.';
    }

    if (msgEl) {
      msgEl.style.display = 'block';
      if (emailSent) {
        msgEl.style.background = 'rgba(22,163,74,0.12)';
        msgEl.style.color = '#16A34A';
        msgEl.textContent = '✅ Reply saved and emailed successfully.';
      } else {
        msgEl.style.background = 'rgba(245,158,11,0.12)';
        msgEl.style.color = '#F59E0B';
        msgEl.textContent = `✅ Reply saved, but email failed: ${emailError || 'unknown reason'}`;
      }
    }

    // Update the cached row + refresh the list view
    const cached = cachedStaffEnquiries.find(x => x.id === enquiryId);
    if (cached) cached.status = 'replied';
    if (typeof applyStaffEnquiriesFilters === 'function') applyStaffEnquiriesFilters();

    // Reload the modal in read-only "replied" state
    setTimeout(() => {
      openStaffEnquiryDetail(enquiryId);
      refreshStaffEnquiriesBadge();
    }, 900);

  } catch (err) {
    console.error('Send reply error:', err);
    if (msgEl) {
      msgEl.style.display = 'block';
      msgEl.style.background = 'rgba(220,38,38,0.12)';
      msgEl.style.color = '#DC2626';
      msgEl.textContent = '❌ ' + err.message;
    }
    if (btn) { btn.disabled = false; btn.textContent = '✉️ Send Reply'; }
  }
}

// Close on backdrop click
document.addEventListener('click', function(e) {
  const modal = document.getElementById('staffEnquiryModal');
  if (modal && e.target === modal) {
    closeStaffEnquiryModal();
  }
});

window.loadStaffEnquiriesPage = loadStaffEnquiriesPage;
window.applyStaffEnquiriesFilters = applyStaffEnquiriesFilters;
window.resetStaffEnquiriesFilters = resetStaffEnquiriesFilters;
window.openStaffEnquiryDetail = openStaffEnquiryDetail;
window.closeStaffEnquiryModal = closeStaffEnquiryModal;
window.sendStaffEnquiryReply = sendStaffEnquiryReply;