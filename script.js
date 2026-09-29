// API_BASE resolves automatically:
//   - On localhost:5000  → '/api' (relative, same server)
//   - On localhost:any   → 'http://localhost:5000/api' (dev: Live Server → separate backend)
//   - Anywhere else      → '/api' (production: browser resolves against whatever domain served the page)
const API_BASE = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
  ? (window.location.port === '5000' ? '/api' : 'http://localhost:5000/api')
  : '/api';

// ---- Leave durations defined in WORKING DAYS ----
const LEAVE_DAYS_MAP = {
  'Annual Leave (30 Working Days)': 30,
  'Casual Leave (5-7 Days)': 7,
  'Sick Leave (Up to 42 Days)': 42,
  'Maternity Leave (112 Working Days)': 112,
  'Paternity Leave (14 Working Days)': 14,
  'Study Leave': 30,
  'Pre-retirement Leave (3 Months)': 90,
  'Sabbatical Leave (1 Year)': 365
};

// Helper: Parse Grade Level to a number (e.g., "GL 12" -> 12) and return annual leave days
function getAnnualLeaveDaysForGrade(gradeLevel) {
  if (!gradeLevel) return 30; // Fallback
  const gl = parseInt(String(gradeLevel).replace(/[^0-9]/g, ''), 10);
  if (isNaN(gl)) return 30;
  if (gl >= 7) return 30;
  if (gl >= 4) return 21;
  return 14; // GL 03 and below
}

// ---- Nigerian Public Holidays (2024 – 2027) ----
const PUBLIC_HOLIDAYS = new Set([
  // 2024
  '2024-01-01','2024-03-29','2024-04-01','2024-04-10','2024-04-11',
  '2024-05-01','2024-06-12','2024-06-16','2024-06-17','2024-09-16',
  '2024-10-01','2024-12-25','2024-12-26',
  // 2025
  '2025-01-01','2025-03-30','2025-03-31','2025-04-18','2025-04-21',
  '2025-05-01','2025-06-06','2025-06-07','2025-06-12','2025-09-05',
  '2025-10-01','2025-12-25','2025-12-26',
  // 2026
  '2026-01-01','2026-03-20','2026-03-21','2026-04-03','2026-04-06',
  '2026-05-01','2026-05-27','2026-05-28','2026-06-12','2026-08-26',
  '2026-10-01','2026-12-25','2026-12-26',
  // 2027
  '2027-01-01','2027-03-10','2027-03-11','2027-03-26','2027-03-29',
  '2027-05-01','2027-05-16','2027-05-17','2027-06-12','2027-08-15',
  '2027-10-01','2027-12-25','2027-12-26'
]);

let currentStaff = null;
let currentLeaveType = 'Annual Leave (30 Working Days)';
let cachedLeaveRecords = [];

// ============================================================
// CUSTOM PORTAL ALERT & PROMPT (Replaces generic browser popups)
// ============================================================

let promptCallback = null;

// Override the global alert() function so every existing alert() call
// in script.js automatically uses our styled modal instead.
window.alert = function(message) {
  const modal = document.getElementById('customModal');
  const modalMsg = document.getElementById('modalMessage');
  if (modal && modalMsg) {
    modalMsg.textContent = message;
    modal.style.display = 'flex';
  } else {
    // Fallback if modal isn't loaded yet
    console.log('ALERT:', message);
  }
};

function showPrompt(title, message, defaultValue, callback) {
  const modal = document.getElementById('promptModal');
  const titleEl = document.getElementById('promptTitle');
  const msgEl = document.getElementById('promptMessage');
  const inputEl = document.getElementById('promptInput');

  if (!modal || !titleEl || !msgEl || !inputEl) return;

  titleEl.textContent = title;
  msgEl.textContent = message;
  inputEl.value = defaultValue || '';
  modal.style.display = 'flex';
  promptCallback = callback;
  setTimeout(() => inputEl.focus(), 100);
}

function closePromptModal() {
  const modal = document.getElementById('promptModal');
  if (modal) modal.style.display = 'none';
  promptCallback = null;
}

function submitPromptModal() {
  const inputEl = document.getElementById('promptInput');
  if (!inputEl) return;
  const val = inputEl.value;
  const modal = document.getElementById('promptModal');
  if (modal) modal.style.display = 'none';
  const cb = promptCallback;
  promptCallback = null;
  if (cb) cb(val);
}

// Allow Enter key to submit the prompt
document.addEventListener('keydown', function(e) {
  const modal = document.getElementById('promptModal');
  if (modal && modal.style.display === 'flex' && e.key === 'Enter') {
    e.preventDefault();
    submitPromptModal();
  }
});

// ============================================================
// DATE & WORKING-DAY HELPERS
// ============================================================

function toDateString(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseLocalDate(dateStr) {
  if (!dateStr) return null;
  const parts = dateStr.split('-');
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
  while (!isWorkingDay(result)) {
    result.setDate(result.getDate() + 1);
  }
  return result;
}

function prevWorkingDay(d) {
  const result = new Date(d);
  result.setHours(0, 0, 0, 0);
  while (!isWorkingDay(result)) {
    result.setDate(result.getDate() - 1);
  }
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

// ============================================================
// APPLICATION BOOTSTRAP
// ============================================================

document.addEventListener('DOMContentLoaded', () => {
  // --- Theme Toggle Logic ---
  const themeToggleBtn = document.getElementById('themeToggleBtn');
  const themeIcon = document.getElementById('themeIcon');
  const body = document.body;

  const savedTheme = localStorage.getItem('portalTheme') || 'dark-mode';
  body.className = savedTheme;
  if (themeIcon) {
    themeIcon.textContent = savedTheme === 'dark-mode' ? '☀️' : '🌙';
  }

  if (themeToggleBtn) {
    themeToggleBtn.addEventListener('click', () => {
      if (body.classList.contains('dark-mode')) {
        body.classList.remove('dark-mode');
        body.classList.add('light-mode');
        localStorage.setItem('portalTheme', 'light-mode');
        if (themeIcon) themeIcon.textContent = '🌙';
      } else {
        body.classList.remove('light-mode');
        body.classList.add('dark-mode');
        localStorage.setItem('portalTheme', 'dark-mode');
        if (themeIcon) themeIcon.textContent = '☀️';
      }
    });
  }

  // Session Check
  const loginModal = document.getElementById('staffLoginModal');
  const activeSession = sessionStorage.getItem('currentStaff');

  if (activeSession) {
    try {
      currentStaff = JSON.parse(activeSession);
      populateStaffProfile(currentStaff);
      if (loginModal) loginModal.style.display = 'none';
      fetchStaffLeaveHistory(currentStaff.isse_file_no);
    } catch (e) {
      sessionStorage.removeItem('currentStaff');
      showLoginModal();
    }
  } else {
    showLoginModal();
  }

  const savedSection = sessionStorage.getItem('activeSection') || 'statusSection';
  showSection(savedSection);

  const subDate = document.getElementById('submissionDate');
  if (subDate) subDate.valueAsDate = new Date();

  setupDateConstraints();

  // Sidebar Leave Dropdown Toggle
  const leaveMenuToggle = document.getElementById('leaveMenuToggle');
  const leaveDropdown = document.getElementById('leaveDropdown');
  const arrow = document.getElementById('arrow');

  if (leaveMenuToggle && leaveDropdown) {
    leaveMenuToggle.addEventListener('click', () => {
      const isHidden = leaveDropdown.style.display === 'none' || !leaveDropdown.style.display;
      leaveDropdown.style.display = isHidden ? 'flex' : 'none';
      if (arrow) arrow.textContent = isHidden ? '▲' : '▼';
    });
  }

  // Select Leave Type from Dropdown
  const dropdownItems = document.querySelectorAll('.dropdown-item');
  dropdownItems.forEach((item) => {
    item.addEventListener('click', (e) => {
      dropdownItems.forEach((i) => i.classList.remove('active'));
      e.target.classList.add('active');

      const selectedType = e.target.getAttribute('data-leave-type');
      if (selectedType) {
        selectLeaveType(selectedType);
      }
    });
  });

  // Navigation Section Switcher
        const statusNavBtn = document.getElementById('statusNavBtn');
  const historyNavBtn = document.getElementById('historyNavBtn');
  const myAttendanceNavBtn = document.getElementById('myAttendanceNavBtn');
  const myEnquiriesNavBtn = document.getElementById('myEnquiriesNavBtn');
  const profileNavBtn = document.getElementById('profileNavBtn');

  if (statusNavBtn) statusNavBtn.addEventListener('click', () => showSection('statusSection'));
  if (historyNavBtn) historyNavBtn.addEventListener('click', () => showSection('historySection'));
  if (myAttendanceNavBtn) myAttendanceNavBtn.addEventListener('click', () => showSection('myAttendanceSection'));
  if (myEnquiriesNavBtn) myEnquiriesNavBtn.addEventListener('click', () => showSection('myEnquiriesSection'));
  if (profileNavBtn) profileNavBtn.addEventListener('click', () => showSection('profileSection'));

  // New enquiry form
  const newEnquiryForm = document.getElementById('newEnquiryForm');
  if (newEnquiryForm) {
    newEnquiryForm.addEventListener('submit', handleEnquirySubmission);
  }

  // View Mode Toggles
  const viewToggleCardsBtn = document.getElementById('viewToggleCardsBtn');
  const viewToggleTableBtn = document.getElementById('viewToggleTableBtn');
  const statusCardsContainer = document.getElementById('statusCardsContainer');
  const statusTableWrapper = document.getElementById('statusTableWrapper');

  if (viewToggleCardsBtn && viewToggleTableBtn && statusCardsContainer && statusTableWrapper) {
    viewToggleCardsBtn.addEventListener('click', () => {
      statusCardsContainer.style.display = 'block';
      statusTableWrapper.style.display = 'none';
      viewToggleCardsBtn.style.background = '#0284C7';
      viewToggleCardsBtn.style.color = '#FFFFFF';
      viewToggleTableBtn.style.background = 'var(--bg-main)';
      viewToggleTableBtn.style.color = 'var(--text-primary)';
      viewToggleTableBtn.style.border = '1px solid var(--border-color)';
    });

    viewToggleTableBtn.addEventListener('click', () => {
      statusCardsContainer.style.display = 'none';
      statusTableWrapper.style.display = 'block';
      viewToggleTableBtn.style.background = '#0284C7';
      viewToggleTableBtn.style.color = '#FFFFFF';
      viewToggleCardsBtn.style.background = 'var(--bg-main)';
      viewToggleCardsBtn.style.color = 'var(--text-primary)';
      viewToggleCardsBtn.style.border = '1px solid var(--border-color)';
    });
  }

  // Table Search & Filter Controls
  document.getElementById('statusSearchInput')?.addEventListener('input', renderStatusTable);
  document.getElementById('statusSortSelect')?.addEventListener('change', renderStatusTable);
  document.getElementById('historySearchInput')?.addEventListener('input', renderHistoryTable);
  document.getElementById('historySortSelect')?.addEventListener('change', renderHistoryTable);

  // Date Change Calculation
  const startDateInput = document.getElementById('startDate');
  const endDateInput = document.getElementById('endDate');

  if (startDateInput) {
    startDateInput.addEventListener('change', autoCalculateEndDate);
  }
  if (endDateInput) {
    endDateInput.addEventListener('change', calculateLeaveDays);
  }

  // Auth & Form Submissions
  const staffLoginBtn = document.getElementById('staffLoginBtn');
  if (staffLoginBtn) {
    staffLoginBtn.addEventListener('click', (e) => {
      e.preventDefault();
      handleStaffLogin();
    });
  }

  const loginInput = document.getElementById('loginFileNoInput');
  if (loginInput) {
    loginInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleStaffLogin();
      }
    });
  }

  const leaveForm = document.getElementById('leaveApplicationForm');
  if (leaveForm) {
    leaveForm.addEventListener('submit', (e) => {
      e.preventDefault();
      handleLeaveSubmission(e);
    });
  }

  const logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', handleLogout);
  }

  // Resumption & Print Modal Listeners
  document.getElementById('resumptionForm')?.addEventListener('submit', handleResumptionSubmission);
  document.getElementById('resumptionModalCloseBtn')?.addEventListener('click', closeResumptionModal);
  document.getElementById('printModalCloseBtn')?.addEventListener('click', closePrintModal);
  document.getElementById('printModalOkBtn')?.addEventListener('click', closePrintModal);

  // Wire up the Custom Alert Modal close buttons
  const customModal = document.getElementById('customModal');
  document.getElementById('modalOkBtn')?.addEventListener('click', () => { if (customModal) customModal.style.display = 'none'; });
  document.getElementById('modalCloseBtn')?.addEventListener('click', () => { if (customModal) customModal.style.display = 'none'; });
});

// ============================================================
// WORKING-DAY AWARE FORM LOGIC
// ============================================================

function setupDateConstraints() {
  const startDateInput = document.getElementById('startDate');
  if (!startDateInput) return;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let minDate;
  if (currentLeaveType.includes('Annual')) {
    minDate = new Date(today);
    minDate.setDate(today.getDate() + 14);
    minDate = nextWorkingDay(minDate);
  } else {
    minDate = nextWorkingDay(today);
  }

  const minDateStr = toDateString(minDate);
  startDateInput.min = minDateStr;

  const currentVal = startDateInput.value;
  if (!currentVal || currentVal < minDateStr) {
    startDateInput.value = minDateStr;
  } else {
    const curDate = parseLocalDate(currentVal);
    if (curDate && !isWorkingDay(curDate)) {
      const snapped = nextWorkingDay(curDate);
      const snappedStr = toDateString(snapped);
      startDateInput.value = (snappedStr >= minDateStr) ? snappedStr : minDateStr;
    }
  }
  autoCalculateEndDate();
}

function selectLeaveType(typeName) {
  let finalLeaveType = typeName;
  let isDemoLeave = false;

  // Handle Demo Leave separately (testing only)
  if (typeName === 'Demo Leave (Minutes)') {
    showPrompt("Demo Leave", "Enter duration in minutes (for testing resumption):", "5", function(mins) {
      const minsNum = parseInt(mins, 10);
      if (isNaN(minsNum) || minsNum <= 0) {
        alert("Please enter a valid number of minutes.");
        return;
      }

      const demoLeaveType = `Demo Leave (${minsNum} Minutes)`;
      const todayStr = new Date().toISOString().split('T')[0];
      const startInput = document.getElementById('startDate');
      const endInput = document.getElementById('endDate');
      const totalInput = document.getElementById('totalDays');

      if (startInput) { startInput.value = todayStr; startInput.disabled = true; }
      if (endInput) { endInput.value = todayStr; endInput.disabled = true; }
      if (totalInput) { totalInput.value = `${minsNum} Minute(s)`; }

      currentLeaveType = demoLeaveType;
      const formTitle = document.getElementById('formLeaveTitle');
      if (formTitle) formTitle.textContent = demoLeaveType;

      const annualPolicyNotice = document.getElementById('annualLeavePolicyNotice');
      if (annualPolicyNotice) annualPolicyNotice.style.display = 'none';

      const maternityPolicyNotice = document.getElementById('maternityLeavePolicyNotice');
      if (maternityPolicyNotice) maternityPolicyNotice.style.display = 'none';

      showSection('leaveFormSection');
    });
    return;
  } else {
    // Re-enable dates if they were disabled by a previous Demo Leave selection
    const startInput = document.getElementById('startDate');
    const endInput = document.getElementById('endDate');
    if (startInput) startInput.disabled = false;
    if (endInput) endInput.disabled = false;
  }

  // Annual Leave → show the Full / Half choice modal first
  if (finalLeaveType === 'Annual Leave') {
    openAnnualChoiceModal();
    return;
  }

  // Custom Leave → user picks both dates manually. No auto-sizing.
  if (finalLeaveType === 'Custom Leave') {
    currentLeaveType = 'Custom Leave';

    const formTitle = document.getElementById('formLeaveTitle');
    if (formTitle) formTitle.textContent = 'Custom Leave (Special Cases)';

    const annualNotice = document.getElementById('annualLeavePolicyNotice');
    if (annualNotice) annualNotice.style.display = 'none';
    const maternityNotice = document.getElementById('maternityLeavePolicyNotice');
    if (maternityNotice) maternityNotice.style.display = 'none';

    const startInput = document.getElementById('startDate');
    const endInput = document.getElementById('endDate');
    const totalInput = document.getElementById('totalDays');
    if (startInput) { startInput.disabled = false; startInput.value = ''; }
    if (endInput) { endInput.disabled = false; endInput.value = ''; }
    if (totalInput) totalInput.value = '';

    // Minimum: next working day (no 14-day advance notice for custom leave)
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const minDate = nextWorkingDay(today);
    if (startInput) startInput.min = toDateString(minDate);

    showSection('leaveFormSection');
    return;
  }

  currentLeaveType = finalLeaveType;
  const formTitle = document.getElementById('formLeaveTitle');
  if (formTitle) formTitle.textContent = finalLeaveType;

  const annualPolicyNotice = document.getElementById('annualLeavePolicyNotice');
  if (annualPolicyNotice) {
    annualPolicyNotice.style.display = finalLeaveType.includes('Annual') ? 'flex' : 'none';
  }

  const maternityPolicyNotice = document.getElementById('maternityLeavePolicyNotice');
  if (maternityPolicyNotice) {
    maternityPolicyNotice.style.display = finalLeaveType.includes('Maternity') ? 'flex' : 'none';
  }

  const staffGender = (currentStaff && currentStaff.gender) ? currentStaff.gender : 'Male';
  if (finalLeaveType.includes('Paternity') && staffGender.toLowerCase() !== 'male') {
    alert('Institutional Policy Regulation:\nIn accordance with Nigerian Public Service Rules (PSR 100219), Paternity Leave can strictly be granted to Male officers only.');
  }
  if (finalLeaveType.includes('Maternity') && staffGender.toLowerCase() !== 'female') {
    alert('Institutional Policy Regulation:\nIn accordance with Nigerian Public Service Rules (PSR 100218), Maternity Leave can strictly be granted to Female officers only.');
  }

  if (!isDemoLeave) {
    // Reset the start date so setupDateConstraints picks a fresh minimum
    // for the new leave type (Annual = +14 days, others = next working day).
    const startInput = document.getElementById('startDate');
    if (startInput) startInput.value = '';
    setupDateConstraints();
  }
  showSection('leaveFormSection');
}

// ================= ANNUAL LEAVE CHOICE =================

let _currentAnnualStatus = null;

async function openAnnualChoiceModal() {
  if (!currentStaff) return;

  const modal = document.getElementById('annualChoiceModal');
  const infoEl = document.getElementById('annualChoiceInfo');
  const btnWrap = document.getElementById('annualChoiceButtons');
  if (!modal || !infoEl || !btnWrap) return;

  infoEl.innerHTML = '<em style="color: var(--text-muted);">Loading your entitlement...</em>';
  btnWrap.innerHTML = '';
  modal.style.display = 'flex';

  try {
    const res = await fetch(`${API_BASE}/leave/annual-status/${encodeURIComponent(currentStaff.isse_file_no)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not load entitlement.');

    _currentAnnualStatus = data;

    const y = data.year;
    const total = data.totalDays;
    const used = data.usedDays;
    const remaining = data.remainingDays;

    if (data.mode === 'exhausted') {
      infoEl.innerHTML = `
        <div style="background: rgba(220,38,38,0.1); border-left: 4px solid #DC2626; padding: 12px 14px; border-radius: 4px;">
          <strong style="color: #DC2626;">Annual leave fully used for ${y}.</strong><br>
          You have already taken your full entitlement of <strong>${total} working days</strong>. You cannot submit another annual leave request this calendar year.
        </div>
      `;
      btnWrap.innerHTML = '';
      return;
    }

    infoEl.innerHTML = `
      <div style="background: rgba(212,168,67,0.08); border-left: 4px solid var(--accent-gold); padding: 12px 14px; border-radius: 4px;">
        <div style="margin-bottom: 6px;"><strong>${y} Annual Leave Entitlement:</strong> ${total} working days</div>
        <div style="font-size: 0.85rem; color: var(--text-muted);">Used: ${used} &nbsp;|&nbsp; Remaining: <strong>${remaining}</strong></div>
      </div>
      <p style="margin-top: 14px; color: var(--text-muted); font-size: 0.85rem;">How would you like to take your leave?</p>
    `;

    if (data.mode === 'fresh') {
      btnWrap.innerHTML = `
        <button class="btn-submit" style="margin-top: 0; text-align: left; padding: 14px 18px; white-space: normal; line-height: 1.45;" onclick="chooseAnnualOption('full')">
          📅 <strong>Full Leave</strong> — take all ${total} working days in one continuous period
        </button>
        <button class="btn-action btn-action-print" style="text-align: left; padding: 14px 18px; font-size: 0.9rem; white-space: normal; line-height: 1.45;" onclick="chooseAnnualOption('first-half')">
          ✂️ <strong>First Half</strong> — take ${data.firstHalfDays} working days now, and the remaining ${data.secondHalfDays} later in the year
        </button>
      `;
    } else if (data.mode === 'half-remaining') {
      btnWrap.innerHTML = `
        <button class="btn-action btn-action-print" style="text-align: left; padding: 14px 18px; font-size: 0.9rem; white-space: normal; line-height: 1.45;" onclick="chooseAnnualOption('second-half')">
          ✂️ <strong>Second Half</strong> — take the remaining ${data.secondHalfDays} working days
        </button>
      `;
    }
  } catch (err) {
    infoEl.innerHTML = `<span style="color: #DC2626;">Failed to load entitlement: ${err.message}</span>`;
  }
}

function closeAnnualChoiceModal() {
  const modal = document.getElementById('annualChoiceModal');
  if (modal) modal.style.display = 'none';
  _currentAnnualStatus = null;
}

function chooseAnnualOption(option) {
  const status = _currentAnnualStatus;
  if (!status) return;

  let label = '';
  if (option === 'full') {
    label = `Annual Leave (${status.totalDays} Working Days)`;
  } else if (option === 'first-half') {
    label = `Annual Leave - First Half (${status.firstHalfDays} Working Days)`;
  } else if (option === 'second-half') {
    label = `Annual Leave - Second Half (${status.secondHalfDays} Working Days)`;
  } else {
    return;
  }

  closeAnnualChoiceModal();

  currentLeaveType = label;

  const formTitle = document.getElementById('formLeaveTitle');
  if (formTitle) formTitle.textContent = label;

  const annualPolicyNotice = document.getElementById('annualLeavePolicyNotice');
  if (annualPolicyNotice) annualPolicyNotice.style.display = 'flex';

  const maternityPolicyNotice = document.getElementById('maternityLeavePolicyNotice');
  if (maternityPolicyNotice) maternityPolicyNotice.style.display = 'none';

  const startInput = document.getElementById('startDate');
  if (startInput) startInput.value = '';
  setupDateConstraints();
  showSection('leaveFormSection');
}

function showSection(sectionId) {
  const sections = document.querySelectorAll('.section-card');
  sections.forEach((sec) => sec.classList.remove('active'));

  const target = document.getElementById(sectionId);
  if (target) target.classList.add('active');

  sessionStorage.setItem('activeSection', sectionId);

  document.querySelectorAll('.nav-menu .nav-item').forEach((item) => item.classList.remove('active'));
      if (sectionId === 'leaveFormSection') {
    document.getElementById('leaveMenuToggle')?.classList.add('active');
  } else if (sectionId === 'statusSection') {
    document.getElementById('statusNavBtn')?.classList.add('active');
  } else if (sectionId === 'historySection') {
    document.getElementById('historyNavBtn')?.classList.add('active');
  } else if (sectionId === 'myAttendanceSection') {
    document.getElementById('myAttendanceNavBtn')?.classList.add('active');
    loadMyAttendancePage();
  } else if (sectionId === 'myEnquiriesSection') {
    document.getElementById('myEnquiriesNavBtn')?.classList.add('active');
    loadMyEnquiriesPage();
  } else if (sectionId === 'profileSection') {
    document.getElementById('profileNavBtn')?.classList.add('active');
    refreshAnnualEntitlementDisplay();
  }
}

function showLoginModal() {
  const loginModal = document.getElementById('staffLoginModal');
  if (loginModal) loginModal.style.display = 'flex';
}

function getDaysForLeaveType(type) {
  if (!type) return 1;
  if (type.includes('Annual')) {
    const m = type.match(/\((\d+)\s+Working/i);
    if (m) return parseInt(m[1], 10);
    if (currentStaff) return getAnnualLeaveDaysForGrade(currentStaff.grade_level);
    return 30;
  }
  return LEAVE_DAYS_MAP[type] || 1;
}

function autoCalculateEndDate() {
  const startDateInput = document.getElementById('startDate');
  const endDateInput = document.getElementById('endDate');

  if (!startDateInput || !startDateInput.value) return;

  const originalStart = parseLocalDate(startDateInput.value);
  if (!originalStart) return;

  const startDate = nextWorkingDay(originalStart);

  if (toDateString(startDate) !== startDateInput.value) {
    startDateInput.value = toDateString(startDate);
  }

  // Custom Leave: user fills the end date manually — don't auto-fill.
  if (currentLeaveType === 'Custom Leave') {
    calculateLeaveDays();
    return;
  }

  const daysToAdd = getDaysForLeaveType(currentLeaveType);
  const estimatedEndDate = addWorkingDays(startDate, daysToAdd);

  if (endDateInput) {
    endDateInput.value = toDateString(estimatedEndDate);
  }

  calculateLeaveDays();
}

function calculateLeaveDays() {
  const startVal = document.getElementById('startDate')?.value;
  const endVal = document.getElementById('endDate')?.value;
  const totalDaysInput = document.getElementById('totalDays');

  if (!startVal || !endVal || !totalDaysInput) return;

  const start = parseLocalDate(startVal);
  let end = parseLocalDate(endVal);

  if (end < start) {
    totalDaysInput.value = 'Invalid Date Range';
    return;
  }

  const snappedEnd = prevWorkingDay(end);
  if (toDateString(snappedEnd) !== endVal) {
    document.getElementById('endDate').value = toDateString(snappedEnd);
    end = snappedEnd;
  }

  const workingDaysCount = countWorkingDays(start, end);
  totalDaysInput.value = `${workingDaysCount} Working Day(s)`;
}

async function handleStaffLogin() {
  const input = document.getElementById('loginFileNoInput');
  if (!input || !input.value.trim()) {
    alert('Please enter a valid ISSE File Number.');
    return;
  }

  const isseFileNo = input.value.trim();

  try {
    const response = await fetch(`${API_BASE}/auth/staff-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isseFileNo })
    });

    const data = await response.json();

    if (!response.ok) {
      alert(data.error || 'Login failed. Please check your File Number.');
      return;
    }

    currentStaff = data.staff;
    sessionStorage.setItem('currentStaff', JSON.stringify(currentStaff));

    populateStaffProfile(currentStaff);

    const loginModal = document.getElementById('staffLoginModal');
    if (loginModal) loginModal.style.display = 'none';

    await fetchStaffLeaveHistory(currentStaff.isse_file_no);

    const savedSec = sessionStorage.getItem('activeSection') || 'statusSection';
    showSection(savedSec);
  } catch (err) {
    console.error('Login request failed:', err);
    alert('Unable to connect to server. Ensure backend daemon is running.');
  }
}

// Normalise a Postgres DATE value (returned as a Date object at UTC midnight
// by the pg driver) or a plain string into a YYYY-MM-DD string.
function normaliseDateValue(v) {
  if (!v) return null;
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return null;
    const y = v.getUTCFullYear();
    const m = String(v.getUTCMonth() + 1).padStart(2, '0');
    const d = String(v.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const s = String(v);
  return s.length >= 10 ? s.substring(0, 10) : s;
}

function populateStaffProfile(staff) {
  const fields = {
    'fullName': staff.full_name,
    'isseStaffNo': staff.isse_file_no,
    'designation': staff.designation,
    'gradeLevel': staff.grade_level,
    'department': staff.department,
    'infoName': staff.full_name,
    'infoIppis': staff.isse_file_no,
    'infoDept': staff.department,
    'infoGl': staff.grade_level,
    'infoEmail': staff.official_email
  };

  Object.entries(fields).forEach(([id, val]) => {
    const el = document.getElementById(id);
    if (el) {
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        el.value = val || '';
      } else {
        el.textContent = val || '--';
      }
    }
  });

  // ---- Promotion dates ----
  const lastPromoEl = document.getElementById('infoLastPromotion');
  if (lastPromoEl) {
    const norm = normaliseDateValue(staff.last_promotion_date);
    lastPromoEl.textContent = norm ? formatDateDisplay(norm) : '—';
  }

  const nextPromoEl = document.getElementById('infoNextPromotion');
  if (nextPromoEl) {
    const norm = normaliseDateValue(staff.next_promotion_date);
    nextPromoEl.textContent = norm ? formatDateDisplay(norm) : '—';
  }

    // ---- Annual leave entitlement (live) ----
  refreshAnnualEntitlementDisplay();

  // ---- Unseen-reply badge on the MY ENQUIRIES link ----
  loadMyEnquiriesBadge();
}

// Fetches the annual entitlement status from the backend and updates the
// Profile row with the actual remaining days for the current year.
async function refreshAnnualEntitlementDisplay() {
  const entitlementEl = document.getElementById('infoAnnualEntitlement');
  if (!entitlementEl || !currentStaff) return;

  // Show a static fallback immediately so the row isn't blank while loading.
  const gl = parseInt(String(currentStaff.grade_level || '').replace(/[^0-9]/g, ''), 10);
  let fallbackDays = 30;
  let glLabel = '?';
  if (!isNaN(gl)) {
    glLabel = gl;
    if (gl >= 7) fallbackDays = 30;
    else if (gl >= 4) fallbackDays = 21;
    else fallbackDays = 14;
  }
  entitlementEl.textContent = `${fallbackDays} Working Days (GL ${glLabel})`;

  try {
    const res = await fetch(`${API_BASE}/leave/annual-status/${encodeURIComponent(currentStaff.isse_file_no)}`);
    if (!res.ok) return;
    const data = await res.json();

    const total     = data.totalDays;
    const used      = data.usedDays;
    const remaining = data.remainingDays;
    const year      = data.year;

    let text;
    if (used === 0) {
      text = `${total} Working Days available for ${year} (GL ${glLabel})`;
    } else if (remaining === 0) {
      text = `0 of ${total} Working Days — fully used for ${year} (GL ${glLabel})`;
    } else {
      text = `${remaining} of ${total} Working Days remaining for ${year} (GL ${glLabel})`;
    }

    entitlementEl.textContent = text;
  } catch (_) {
    // Keep the fallback text if the fetch fails.
  }
}

async function handleLeaveSubmission(e) {
  if (e) e.preventDefault();

  if (!currentStaff) {
    alert('Please log in first.');
    return;
  }

  const existingActive = cachedLeaveRecords.find(isActiveLeave);
  if (existingActive) {
    alert(`Public Service Regulation:\nYou currently have an active leave application or ongoing authorized leave in progress (${existingActive.leave_type}). Staff are permitted to take only ONE leave at a time. Please wait until your current leave is concluded and duty resumption is validated before applying again.`);
    return;
  }

  const staffGender = currentStaff.gender || 'Male';
  if (currentLeaveType.includes('Paternity') && staffGender.toLowerCase() !== 'male') {
    alert('Institutional Policy Regulation:\nIn accordance with Nigerian Public Service Rules (PSR 100219), Paternity Leave can strictly be taken by Male officers only.');
    return;
  }
  if (currentLeaveType.includes('Maternity') && staffGender.toLowerCase() !== 'female') {
    alert('Institutional Policy Regulation:\nIn accordance with Nigerian Public Service Rules (PSR 100218), Maternity Leave can strictly be taken by Female officers only.');
    return;
  }

  const startDateVal = document.getElementById('startDate')?.value;
  const endDateVal = document.getElementById('endDate')?.value;
  let totalDaysVal = document.getElementById('totalDays')?.value || '';

  if (!startDateVal || !endDateVal) {
    alert('Please specify valid commencement and end dates.');
    return;
  }

  const isDemoLeave = currentLeaveType.includes('Demo Leave');

  if (!isDemoLeave) {
    // Convert to number for regular leave types
    totalDaysVal = parseInt(totalDaysVal, 10) || 0;

    if (currentLeaveType.includes('Annual')) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const startParts = startDateVal.split('-');
      const startDate = new Date(parseInt(startParts[0], 10), parseInt(startParts[1], 10) - 1, parseInt(startParts[2], 10));
      startDate.setHours(0, 0, 0, 0);

      const diffDays = Math.ceil((startDate - today) / (1000 * 60 * 60 * 24));
      if (diffDays < 14) {
        alert('Institutional Policy Regulation:\nAnnual Leave applications must strictly be submitted at least 14 days (2 weeks) prior to the commencement date.');
        return;
      }
    }

    // Custom Leave: no advance-notice rule, no entitlement cap. Just needs
    // a valid span of at least one working day (validated below).
    if (currentLeaveType === 'Custom Leave') {
      if (!endDateVal || endDateVal < startDateVal) {
        alert('Please select a valid end date for your custom leave.');
        return;
      }
    }
  }

  // Upload attachment first (if provided)
  let attachmentId = null;
  const fileInput = document.getElementById('attachment');
  if (fileInput && fileInput.files && fileInput.files[0]) {
    const file = fileInput.files[0];
    if (file.size > 5 * 1024 * 1024) {
      alert('Attachment must be 5MB or smaller.');
      return;
    }

    const fd = new FormData();
    fd.append('file', file);

    try {
      const upRes = await fetch(`${API_BASE}/leave/upload-attachment`, {
        method: 'POST',
        body: fd
      });
      const upData = await upRes.json();
      if (!upRes.ok) throw new Error(upData.error || 'File upload failed.');
      attachmentId = upData.attachmentId;
    } catch (err) {
      alert('Attachment upload failed: ' + err.message);
      return;
    }
  }

  const payload = {
    isseFileNo: currentStaff.isse_file_no,
    fullName: currentStaff.full_name,
    department: currentStaff.department,
    designation: currentStaff.designation,
    leaveType: currentLeaveType,
    startDate: startDateVal,
    endDate: endDateVal,
    totalDays: totalDaysVal,
    remarks: document.getElementById('staffComments')?.value || '',
    attachmentId: attachmentId
  };

  try {
    const res = await fetch(`${API_BASE}/leave/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (!res.ok) {
      alert(data.error || 'Submission failed. Please check regulations.');
      return;
    }

    alert('Leave application submitted successfully!');

    const commentsInput = document.getElementById('staffComments');
    if (commentsInput) commentsInput.value = '';
    const attachInput = document.getElementById('attachment');
    if (attachInput) attachInput.value = '';

    await fetchStaffLeaveHistory(currentStaff.isse_file_no);
    showSection('statusSection');
  } catch (err) {
    alert(err.message || 'Error submitting application.');
  }
}

// Active leaves: pending (in-pipeline) OR approved-and-awaiting-HOU-resumption-validation.
// Rejected leaves are excluded here and live in History.
function isActiveLeave(item) {
  const status = (item.overall_status || '').toUpperCase();

  if (status.includes('REJECTED') || status.includes('CANCELLED')) {
    return false;
  }

  if (status.includes('PENDING')) {
    return true;
  }

  if (status.includes('APPROVED') || status.includes('FINAL APPROVAL')) {
    const rStatus = (item.resumption_status || '').toUpperCase();
    // Fully cleared once HOA grants final resumption approval.
    if (rStatus === 'RESUMPTION APPROVED') return false;
    // Otherwise still active — either awaiting resumption, or mid-validation.
    return true;
  }

  return false;
}

// Archived leaves: rejected applications (by HOU or Admin) OR approved leaves
// with a validated duty resumption.
function isCompletedLeave(item) {
  const status = (item.overall_status || '').toUpperCase();

  // Rejected or staff-cancelled leaves are permanently archived in history
  if (status.includes('REJECTED') || status.includes('CANCELLED')) {
    return true;
  }

  const isApproved = status.includes('APPROVED') || status.includes('FINAL APPROVAL');
  const rStatus = (item.resumption_status || '').toUpperCase();
  // Completed = fully cleared by HOA.
  const isResumptionValidated = rStatus === 'RESUMPTION APPROVED';

  return isApproved && isResumptionValidated;
}

function getStatusBadgeClass(status) {
  if (!status) return 'status-pending';
  const str = status.toUpperCase();
  if (str.includes('REJECTED')) return 'status-rejected';
  if (str.includes('CANCELLED')) return 'status-pending';
  if (str.includes('HEAD OF ADMIN') || str.includes('APPROVED BY HOU') || str.includes('FINAL APPROVAL')) return 'status-approved';
  return 'status-pending';
}

function getResumptionBadge(item) {
  const status = (item.overall_status || '').toUpperCase();
  if (status.includes('REJECTED')) {
    return `<span style="color: var(--text-muted); font-size: 0.8rem;">N/A (Declined)</span>`;
  }
  if (status.includes('CANCELLED')) {
    return `<span style="color: var(--text-muted); font-size: 0.8rem;">N/A (Cancelled)</span>`;
  }
  if (!status.includes('HEAD OF ADMIN') && !status.includes('FINAL APPROVAL') && status !== 'APPROVED') {
    return `<span style="color: var(--text-muted); font-size: 0.8rem;">Awaiting Authorization</span>`;
  }

  const rStatus = (item.resumption_status || 'NOT RESUMED').toUpperCase();
  if (rStatus === 'RESUMPTION APPROVED') {
    return `<span class="badge-resumption badge-resumption-verified">Cleared (${formatDateDisplay(item.resumption_date)})</span>`;
  }
  if (rStatus.includes('PENDING')) {
    return `<span class="badge-resumption badge-resumption-pending">Reported (${formatDateDisplay(item.resumption_date)}) - In Validation</span>`;
  }
  if (rStatus === 'NOT RESUMED') {
    return `<span style="color: var(--text-muted); font-size: 0.8rem;">Pending Resumption</span>`;
  }
  if (rStatus.includes('REJECTED')) {
    const reason = item.hou_resumption_remarks || item.admin_resumption_remarks || '';
    const shortReason = reason ? ` — ${reason.substring(0, 60)}${reason.length > 60 ? '…' : ''}` : '';
    return `<span class="badge-resumption" style="background: rgba(220,38,38,0.15); color: #EF4444; border: 1px solid #EF4444;" title="${reason}">${rStatus}${shortReason}</span>`;
  }
  return `<span style="color: var(--text-muted); font-size: 0.8rem;">${rStatus}</span>`;
}

function getActionsCell(item) {
  const status = (item.overall_status || '').toUpperCase();
  const houStatus = (item.hou_status || '').toUpperCase();

  // Rejected or cancelled leaves are read-only archive entries — no actions available.
  if (status.includes('REJECTED') || status.includes('CANCELLED')) {
    return `<span style="color: var(--text-muted); font-size: 0.85rem;">—</span>`;
  }

  const isApproved = status.includes('HEAD OF ADMIN') || status.includes('FINAL APPROVAL') || status === 'APPROVED';

  if (!isApproved) {
    // Still in pipeline — allow cancellation ONLY while HOU has not yet acted.
    if (houStatus === 'PENDING') {
      return `<button class="btn-action" style="background:#DC2626; color:#FFFFFF;" onclick="confirmCancelLeave(${item.id})">✖ Cancel Application</button>`;
    }
    return `<span style="color: var(--text-muted); font-size: 0.8rem;">Awaiting Approval</span>`;
  }

  const rStatus = (item.resumption_status || 'NOT RESUMED').toUpperCase();
  let buttons = `<button class="btn-action btn-action-print" onclick="printLeaveSlip(${item.id})">🖨️ Approval Slip</button>`;

  const isResumptionRejected = rStatus.includes('REJECTED');

  if (rStatus === 'NOT RESUMED' || isResumptionRejected) {
    const todayStr = new Date().toISOString().split('T')[0];
    const leaveEndDate = item.end_date || '9999-12-31';

    // Rejected resumptions can be re-notified immediately, regardless of end date.
    if (!isResumptionRejected && todayStr < leaveEndDate) {
      buttons += `<button class="btn-action btn-disabled" disabled title="Duty resumption clearance can strictly be initiated on or after your scheduled resumption date (${formatDateDisplay(leaveEndDate)})">⌛ Resumption Opens ${formatDateDisplay(leaveEndDate)}</button>`;
    } else {
      const label = isResumptionRejected ? '🔁 Re-notify Return' : '📢 Notify Return';
      buttons += `<button class="btn-action btn-action-return" onclick="openResumptionModal(${item.id})">${label}</button>`;
    }
  } else if (rStatus === 'RESUMPTION APPROVED') {
    buttons += `<button class="btn-action btn-action-clearance" onclick="printReturnSlip(${item.id})">📄 Return Slip</button>`;
  } else {
    // PENDING HOU / PENDING HOA / anything else in-flight
    buttons += `<span style="color: var(--text-muted); font-size: 0.8rem; margin-left: 8px;">⌛ Awaiting validation</span>`;
  }

  return buttons;
}

function buildStepperTrack(item) {
  const houStatus = (item.hou_status || 'PENDING').toUpperCase();
  const adminStatus = (item.admin_status || 'PENDING').toUpperCase();
  const resStatus = (item.resumption_status || 'NOT RESUMED').toUpperCase();
  const houResStatus = (item.hou_resumption_status || '').toUpperCase();

  const step1Class = 'step-completed';
  const step1Detail = formatDateDisplay(item.created_at ? item.created_at.split('T')[0] : '');

  let step2Class = 'step-pending';
  let step2Name = 'HOU Recommendation';
  let step2Detail = 'Queued for Review';
  let step2Icon = '2';

  if (houStatus === 'APPROVED') {
    step2Class = 'step-completed';
    step2Name = 'HOU Endorsed';
    step2Detail = 'Recommended';
    step2Icon = '✓';
  } else if (houStatus === 'REJECTED') {
    step2Class = 'step-rejected';
    step2Name = 'HOU Declined';
    step2Detail = 'Not Recommended';
    step2Icon = '✕';
  } else {
    step2Class = 'step-active';
    step2Name = 'HOU Review';
    step2Detail = 'Awaiting Endorsement';
  }

  let step3Class = 'step-pending';
  let step3Name = 'Head of Admin Authorized';
  let step3Detail = 'Pending HOU';
  let step3Icon = '3';

  if (adminStatus === 'APPROVED') {
    step3Class = 'step-completed';
    step3Name = 'Head of Admin Approved';
    step3Detail = 'Authorization Granted';
    step3Icon = '✓';
  } else if (adminStatus === 'REJECTED') {
    step3Class = 'step-rejected';
    step3Name = 'Admin Declined';
    step3Detail = 'Authorization Declined';
    step3Icon = '✕';
  } else if (houStatus === 'APPROVED') {
    step3Class = 'step-active';
    step3Name = 'Head of Admin Review';
    step3Detail = 'Awaiting Authorization';
  }

  let step4Class = 'step-pending';
  let step4Name = 'Duty Resumption';
  let step4Detail = 'Pending Leave Duration';
  let step4Icon = '4';

  if (houResStatus === 'VERIFIED' || resStatus.includes('VALIDATED')) {
    step4Class = 'step-completed';
    step4Name = 'Resumed & Cleared';
    step4Detail = 'Validated by HOU';
    step4Icon = '✓';
  } else if (resStatus.includes('RESUMED')) {
    step4Class = 'step-active';
    step4Name = 'Return Reported';
    step4Detail = 'Awaiting HOU Verification';
    step4Icon = '4';
  } else if (adminStatus === 'APPROVED') {
    step4Class = 'step-pending';
    step4Name = 'Duty Resumption';
    step4Detail = 'Clearance Required upon Return';
    step4Icon = '4';
  }

  return `
    <div class="stepper-track">
      <div class="step-item ${step1Class}">
        <div class="step-node">✓</div>
        <div class="step-name">Application Filed</div>
        <div class="step-detail">${step1Detail}</div>
      </div>
      <div class="step-item ${step2Class}">
        <div class="step-node">${step2Icon}</div>
        <div class="step-name">${step2Name}</div>
        <div class="step-detail">${step2Detail}</div>
      </div>
      <div class="step-item ${step3Class}">
        <div class="step-node">${step3Icon}</div>
        <div class="step-name">${step3Name}</div>
        <div class="step-detail">${step3Detail}</div>
      </div>
      <div class="step-item ${step4Class}">
        <div class="step-node">${step4Icon}</div>
        <div class="step-name">${step4Name}</div>
        <div class="step-detail">${step4Detail}</div>
      </div>
    </div>
  `;
}

function renderStatusCards(activeRecords) {
  const container = document.getElementById('statusCardsContainer');
  if (!container) return;

  if (!currentStaff) {
    container.innerHTML = `
      <div class="empty-state-cell" style="background: var(--card-bg); border-radius: 8px; border: 1px dashed var(--border-color); padding: 30px;">
        Please log in with your ISSE File Number to view active leaves.
      </div>
    `;
    return;
  }

  if (!activeRecords.length) {
    container.innerHTML = `
      <div class="empty-state-cell" style="background: var(--card-bg); border-radius: 8px; border: 1px dashed var(--border-color); padding: 35px; text-align: center;">
        <div style="font-size: 2rem; margin-bottom: 8px;">📋</div>
        <div style="font-weight: 700; color: var(--text-primary); margin-bottom: 4px;">No Active Leave Applications</div>
        <div style="font-size: 0.85rem; color: var(--text-muted);">You currently have no leave requests under review or active leaves awaiting resumption.</div>
      </div>
    `;
    return;
  }

  container.innerHTML = activeRecords.map(item => {
    const badgeClass = getStatusBadgeClass(item.overall_status);
    const displayStatus = (item.overall_status || 'PENDING').replace('FINAL APPROVAL', 'HEAD OF ADMIN APPROVED');
    const refCode = `ISSE/LV/${new Date(item.created_at || Date.now()).getFullYear()}/${String(item.id).padStart(4, '0')}`;
    const stepperHtml = buildStepperTrack(item);
    const actionsButtons = getActionsCell(item);
    const resumptionBadge = getResumptionBadge(item);

    return `
      <div class="executive-leave-card">
        <div class="leave-card-top">
          <div class="leave-card-title-group">
            <span class="leave-type-chip">${item.leave_type}</span>
            <span class="leave-ref-chip">REF: ${refCode}</span>
          </div>
          <span class="status-badge ${badgeClass}">${displayStatus}</span>
        </div>

        <div class="leave-date-timeline">
          <div class="date-timeline-point">
            <div class="date-point-title">COMMENCEMENT</div>
            <div class="date-point-day">${formatDateDisplay(item.start_date)}</div>
            <div class="date-point-sub">Official Start Date</div>
          </div>
          <div class="timeline-duration-badge">
            <span class="duration-arrow">➔</span>
            <span class="duration-pill">${item.total_days} Working Day(s)</span>
          </div>
          <div class="date-timeline-point text-right">
            <div class="date-point-title">SCHEDULED END / RETURN</div>
            <div class="date-point-day">${formatDateDisplay(item.end_date)}</div>
            <div class="date-point-sub">Scheduled Duty Resumption</div>
          </div>
        </div>

        ${stepperHtml}

        <div class="card-actions-dock">
          <div style="margin-right: auto; display: flex; align-items: center; gap: 8px;">
            <span style="font-size: 0.76rem; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-muted); font-weight: bold;">Clearance:</span>
            ${resumptionBadge}
          </div>
          <div class="table-actions-cell">
            ${actionsButtons}
          </div>
        </div>
      </div>
    `;
  }).join('');
}

function renderStatusTable() {
  let activeRecords = cachedLeaveRecords.filter(isActiveLeave);

  const query = (document.getElementById('statusSearchInput')?.value || '').trim().toLowerCase();
  if (query) {
    activeRecords = activeRecords.filter(item =>
      (item.leave_type && item.leave_type.toLowerCase().includes(query)) ||
      (item.start_date && item.start_date.toLowerCase().includes(query)) ||
      (item.end_date && item.end_date.toLowerCase().includes(query)) ||
      (item.overall_status && item.overall_status.toLowerCase().includes(query)) ||
      (item.resumption_status && item.resumption_status.toLowerCase().includes(query))
    );
  }

  const sortOrder = document.getElementById('statusSortSelect')?.value || 'newest';
  activeRecords.sort((a, b) => {
    const dateA = new Date(a.created_at || a.start_date || 0);
    const dateB = new Date(b.created_at || b.start_date || 0);
    return sortOrder === 'newest' ? dateB - dateA : dateA - dateB;
  });

  renderStatusCards(activeRecords);

  const tbody = document.getElementById('statusTableBody');
  if (!tbody) return;

  if (!currentStaff) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty-state-cell">Please log in with your ISSE File Number to view active leaves.</td></tr>`;
    return;
  }

  if (!activeRecords.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty-state-cell">No active leave applications currently in progress.</td></tr>`;
    return;
  }

  tbody.innerHTML = activeRecords.map(item => {
    const badgeClass = getStatusBadgeClass(item.overall_status);
    const displayStatus = (item.overall_status || 'PENDING').replace('FINAL APPROVAL', 'HEAD OF ADMIN APPROVED');
    const submittedDate = formatDateDisplay(item.created_at ? item.created_at.split('T')[0] : '');
    const periodDisplay = `${formatDateDisplay(item.start_date)} to ${formatDateDisplay(item.end_date)}`;
    const resumptionBadge = getResumptionBadge(item);
    const actionsButtons = getActionsCell(item);

    return `
      <tr>
        <td>${submittedDate}</td>
        <td style="font-weight: 600;">${item.leave_type}</td>
        <td><span class="duration-pill" style="font-size: 0.75rem; padding: 2px 8px;">${item.total_days} Working Day(s)</span></td>
        <td>${periodDisplay}</td>
        <td><span class="status-badge ${badgeClass}">${displayStatus}</span></td>
        <td>${resumptionBadge}</td>
        <td><div class="table-actions-cell">${actionsButtons}</div></td>
      </tr>
    `;
  }).join('');
}

// History shows: completed (resumption validated) AND rejected leaves.
function renderHistoryTable() {
  const tbody = document.getElementById('historyTableBody');
  if (!tbody) return;

  if (!currentStaff) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty-state-cell">Please log in with your ISSE File Number to view archived leave history.</td></tr>`;
    return;
  }

  let historyRecords = cachedLeaveRecords.filter(isCompletedLeave);

  const query = (document.getElementById('historySearchInput')?.value || '').trim().toLowerCase();
  if (query) {
    historyRecords = historyRecords.filter(item =>
      (item.leave_type && item.leave_type.toLowerCase().includes(query)) ||
      (item.start_date && item.start_date.toLowerCase().includes(query)) ||
      (item.end_date && item.end_date.toLowerCase().includes(query)) ||
      (item.overall_status && item.overall_status.toLowerCase().includes(query)) ||
      (item.hou_remarks && item.hou_remarks.toLowerCase().includes(query)) ||
      (item.admin_remarks && item.admin_remarks.toLowerCase().includes(query))
    );
  }

  const sortOrder = document.getElementById('historySortSelect')?.value || 'newest';
  historyRecords.sort((a, b) => {
    const dateA = new Date(a.created_at || a.start_date || 0);
    const dateB = new Date(b.created_at || b.start_date || 0);
    return sortOrder === 'newest' ? dateB - dateA : dateA - dateB;
  });

  if (!historyRecords.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty-state-cell">No archived leave records available.</td></tr>`;
    return;
  }

  tbody.innerHTML = historyRecords.map(item => {
    const statusRaw = (item.overall_status || '').toUpperCase();
    const isRejected = statusRaw.includes('REJECTED');
    const isCancelled = statusRaw.includes('CANCELLED');

    const submittedDate = formatDateDisplay(item.created_at ? item.created_at.split('T')[0] : '');
    const periodDisplay = `${formatDateDisplay(item.start_date)} to ${formatDateDisplay(item.end_date)}`;
    const resumptionBadge = getResumptionBadge(item);
    const actionsButtons = getActionsCell(item);

    let statusBadgeHtml;
    if (isRejected) {
      let rejectionLabel = 'REJECTED';
      if (statusRaw.includes('HOU')) rejectionLabel = 'REJECTED BY HOU';
      else if (statusRaw.includes('ADMIN')) rejectionLabel = 'REJECTED BY ADMIN';
      statusBadgeHtml = `<span class="status-badge status-rejected">${rejectionLabel}</span>`;
    } else if (isCancelled) {
      statusBadgeHtml = `<span class="status-badge" style="background:rgba(148,163,184,0.2); color:#94A3B8; border:1px solid #94A3B8;">CANCELLED BY STAFF</span>`;
    } else {
      statusBadgeHtml = `<span class="status-badge status-approved">COMPLETED</span>`;
    }

    let remarksText = '—';
    if (isRejected) {
      remarksText = item.admin_remarks || item.hou_remarks || 'No reason provided';
    } else if (isCancelled) {
      remarksText = 'Application withdrawn by staff before approval.';
    }

    return `
      <tr>
        <td>${submittedDate}</td>
        <td style="font-weight: 600;">${item.leave_type}</td>
        <td><span class="duration-pill" style="font-size: 0.75rem; padding: 2px 8px;">${item.total_days} Working Day(s)</span></td>
        <td>${periodDisplay}</td>
        <td>${statusBadgeHtml}</td>
        <td>${resumptionBadge}</td>
        <td><span style="font-size: 0.82rem; color: var(--text-muted); font-style: italic; display: inline-block; max-width: 220px; word-wrap: break-word;">${remarksText}</span></td>
        <td><div class="table-actions-cell">${actionsButtons}</div></td>
      </tr>
    `;
  }).join('');
}

// Resumption Modal Handlers
function openResumptionModal(requestId) {
  const reqIdInput = document.getElementById('resumptionRequestId');
  const dateInput = document.getElementById('resumptionDateInput');
  const remarksInput = document.getElementById('resumptionRemarksInput');
  const modal = document.getElementById('resumptionModal');
  const modalTitle = modal ? modal.querySelector('.modal-title') : null;

  // Detect if this is a re-notification after a rejection
  const item = cachedLeaveRecords.find(r => r.id === requestId);
  const rStatus = item ? (item.resumption_status || '').toUpperCase() : '';
  const isRejected = rStatus.includes('REJECTED');

  if (reqIdInput) reqIdInput.value = requestId;
  if (dateInput) dateInput.value = new Date().toISOString().split('T')[0];
  if (remarksInput) remarksInput.value = '';

  if (modalTitle) {
    modalTitle.textContent = isRejected ? 'Re-notify Return to Duty' : 'Notify Return to Duty';
  }

  // Inject or remove a contextual warning banner
  let warnBox = document.getElementById('resumptionWarnBox');
  if (isRejected && modal) {
    if (!warnBox) {
      warnBox = document.createElement('div');
      warnBox.id = 'resumptionWarnBox';
      warnBox.style.cssText = 'background: rgba(220,38,38,0.1); border-left: 4px solid #DC2626; padding: 10px 14px; border-radius: 4px; margin-bottom: 14px; font-size: 0.82rem; line-height: 1.5;';
      const body = modal.querySelector('.modal-body');
      const form = modal.querySelector('#resumptionForm');
      if (body && form) body.insertBefore(warnBox, form);
    }
    const reason = (item && (item.hou_resumption_remarks || item.admin_resumption_remarks)) || 'No reason provided.';
    warnBox.innerHTML = `<strong style="color: #DC2626;">Previous resumption was rejected.</strong><br>Reason: <em>${reason}</em><br>Please re-submit with corrected details.`;
    warnBox.style.display = 'block';
  } else if (warnBox) {
    warnBox.style.display = 'none';
  }

  if (modal) modal.style.display = 'flex';
}

function closeResumptionModal() {
  const modal = document.getElementById('resumptionModal');
  if (modal) modal.style.display = 'none';
}

async function handleResumptionSubmission(e) {
  if (e) e.preventDefault();
  const requestId = document.getElementById('resumptionRequestId')?.value;
  const resumptionDate = document.getElementById('resumptionDateInput')?.value;
  const resumptionRemarks = document.getElementById('resumptionRemarksInput')?.value;

  if (!requestId) return;

  try {
    const res = await fetch(`${API_BASE}/leave/notify-resumption`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: parseInt(requestId, 10), resumptionDate, resumptionRemarks })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to submit return notification');

    alert(data.message || 'Resumption notice submitted successfully!');
    closeResumptionModal();
    const remarksInput = document.getElementById('resumptionRemarksInput');
    if (remarksInput) remarksInput.value = '';

    if (currentStaff) {
      await fetchStaffLeaveHistory(currentStaff.isse_file_no);
    }
  } catch (err) {
    alert(err.message || 'Error submitting return notification.');
  }
}

// Leave Cancellation Handlers
let cancelLeaveTargetId = null;

function confirmCancelLeave(id) {
  cancelLeaveTargetId = id;
  const modal = document.getElementById('cancelLeaveModal');
  const btn = document.getElementById('cancelLeaveConfirmBtn');
  if (btn) {
    btn.textContent = 'Yes, Cancel Application';
    btn.disabled = false;
    btn.onclick = executeCancelLeave;
  }
  if (modal) modal.style.display = 'flex';
}

function closeCancelLeaveModal() {
  const modal = document.getElementById('cancelLeaveModal');
  if (modal) modal.style.display = 'none';
  cancelLeaveTargetId = null;
}

async function executeCancelLeave() {
  if (!cancelLeaveTargetId || !currentStaff) return;

  const btn = document.getElementById('cancelLeaveConfirmBtn');
  const original = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Cancelling...'; }

  try {
    const res = await fetch(`${API_BASE}/leave/cancel/${cancelLeaveTargetId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isseFileNo: currentStaff.isse_file_no })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Cancellation failed.');

    closeCancelLeaveModal();
    alert(data.message || 'Leave application cancelled successfully.');

    if (currentStaff) {
      await fetchStaffLeaveHistory(currentStaff.isse_file_no);
    }
  } catch (err) {
    alert(err.message || 'Error cancelling leave.');
    if (btn) { btn.disabled = false; btn.textContent = original; }
  }
}


// Print Modal Handlers
function openPrintModal() {
  const modal = document.getElementById('printableSlipModal');
  if (modal) modal.style.display = 'flex';
}

function closePrintModal() {
  const modal = document.getElementById('printableSlipModal');
  if (modal) modal.style.display = 'none';
}

function printLeaveSlip(requestId) {
  const item = cachedLeaveRecords.find(r => r.id === requestId);
  if (!item || !currentStaff) return;

  const titleEl = document.getElementById('slipModalTitle');
  if (titleEl) titleEl.textContent = 'Official Leave Approval Certificate';

  const container = document.getElementById('printableSlipContent');
  if (!container) return;

  const today = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const appDate = formatDateDisplay(item.created_at ? item.created_at.split('T')[0] : '');

  container.innerHTML = `
    <div class="official-slip">
      <div class="slip-header">
        <img src="isselogo.png" alt="ISSE Logo" class="slip-header-logo">
        <div class="slip-header-text">
          <div class="slip-institution-name">Institute of Space Science & Engineering (ISSE)</div>
          <div class="slip-sub-institution">National Space Research & Development Agency (NASRDA)</div>
          <div class="slip-doc-title">OFFICIAL LEAVE APPROVAL CERTIFICATE</div>
        </div>
        <div class="slip-ref-box">
          <div>Ref: <strong>ISSE/LV/${new Date().getFullYear()}/${String(item.id).padStart(4, '0')}</strong></div>
          <div style="font-size: 0.72rem; margin-top: 3px;">Date: ${today}</div>
        </div>
      </div>

      <div class="slip-section-heading">1. Staff Applicant Details</div>
      <div class="slip-grid">
        <div class="slip-data-item"><span class="slip-data-label">Staff Full Name</span><span class="slip-data-value">${currentStaff.full_name}</span></div>
        <div class="slip-data-item"><span class="slip-data-label">ISSE Staff File No</span><span class="slip-data-value">${currentStaff.isse_file_no}</span></div>
        <div class="slip-data-item"><span class="slip-data-label">Department / Division</span><span class="slip-data-value">${currentStaff.department}</span></div>
        <div class="slip-data-item"><span class="slip-data-label">Designation / Rank</span><span class="slip-data-value">${currentStaff.designation}</span></div>
        <div class="slip-data-item"><span class="slip-data-label">Salary Grade Level</span><span class="slip-data-value">${currentStaff.grade_level}</span></div>
        <div class="slip-data-item"><span class="slip-data-label">Official Email</span><span class="slip-data-value">${currentStaff.official_email}</span></div>
      </div>

      <div class="slip-section-heading">2. Authorized Leave Specifications</div>
      <div class="slip-grid">
        <div class="slip-data-item"><span class="slip-data-label">Leave Category</span><span class="slip-data-value">${item.leave_type}</span></div>
        <div class="slip-data-item"><span class="slip-data-label">Approved Duration</span><span class="slip-data-value">${item.total_days} Working Day(s)</span></div>
        <div class="slip-data-item"><span class="slip-data-label">Commencement Date</span><span class="slip-data-value">${formatDateDisplay(item.start_date)}</span></div>
        <div class="slip-data-item"><span class="slip-data-label">Scheduled Resumption Date</span><span class="slip-data-value">${formatDateDisplay(item.end_date)}</span></div>
        <div class="slip-data-item"><span class="slip-data-label">Date Applied</span><span class="slip-data-value">${appDate}</span></div>
        <div class="slip-data-item"><span class="slip-data-label">Official Authorization</span><span class="slip-data-value" style="color: #16A34A; font-weight: bold;">HEAD OF ADMIN APPROVED</span></div>
      </div>

      <div class="slip-section-heading">3. Official Executive Endorsements & Authorization Trail</div>
      <div class="slip-approval-trail">
        <div class="slip-sign-box">
          <div class="slip-sign-title">Stage 1: Head of Unit (HOU)</div>
          <span class="slip-status-stamp slip-stamp-approved">RECOMMENDED & ENDORSED</span>
          <div class="slip-sign-line" style="margin-top: 28px;">Head of Unit Signature / Clearance Stamp</div>
        </div>
        <div class="slip-sign-box">
          <div class="slip-sign-title">Stage 2: Head of Administration</div>
          <span class="slip-status-stamp slip-stamp-approved">HEAD OF ADMIN APPROVED</span>
          <div class="slip-sign-line" style="margin-top: 28px;">Head of Administration Signature / Official Seal</div>
        </div>
      </div>

      <div class="slip-footer-note">
        This document serves as the official approved leave clearance issued by the Institute of Space Science and Engineering (ISSE). All leave provisions are governed by ISSE Public Service Rules. Staff members are required to report for physical duty resumption clearance upon return.
      </div>
    </div>
  `;

  openPrintModal();
}

function printReturnSlip(requestId) {
  const item = cachedLeaveRecords.find(r => r.id === requestId);
  if (!item || !currentStaff) return;

  const titleEl = document.getElementById('slipModalTitle');
  if (titleEl) titleEl.textContent = 'Official Duty Resumption Clearance Certificate';

  const container = document.getElementById('printableSlipContent');
  if (!container) return;

  const today = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const isVerified = (item.hou_resumption_status || '').toUpperCase() === 'VERIFIED';

  container.innerHTML = `
    <div class="official-slip">
      <div class="slip-header">
        <img src="isselogo.png" alt="ISSE Logo" class="slip-header-logo">
        <div class="slip-header-text">
          <div class="slip-institution-name">Institute of Space Science & Engineering (ISSE)</div>
          <div class="slip-sub-institution">National Space Research & Development Agency (NASRDA)</div>
          <div class="slip-doc-title">DUTY RESUMPTION CLEARANCE CERTIFICATE</div>
        </div>
        <div class="slip-ref-box">
          <div>Ref: <strong>ISSE/RS/${new Date().getFullYear()}/${String(item.id).padStart(4, '0')}</strong></div>
          <div style="font-size: 0.72rem; margin-top: 3px;">Date: ${today}</div>
        </div>
      </div>

      <div class="slip-section-heading">1. Resuming Staff Information</div>
      <div class="slip-grid">
        <div class="slip-data-item"><span class="slip-data-label">Staff Full Name</span><span class="slip-data-value">${currentStaff.full_name}</span></div>
        <div class="slip-data-item"><span class="slip-data-label">ISSE Staff File No</span><span class="slip-data-value">${currentStaff.isse_file_no}</span></div>
        <div class="slip-data-item"><span class="slip-data-label">Department / Division</span><span class="slip-data-value">${currentStaff.department}</span></div>
        <div class="slip-data-item"><span class="slip-data-label">Designation / Grade</span><span class="slip-data-value">${currentStaff.designation} (${currentStaff.grade_level})</span></div>
      </div>

      <div class="slip-section-heading">2. Concluded Leave Details</div>
      <div class="slip-grid">
        <div class="slip-data-item"><span class="slip-data-label">Concluded Leave Type</span><span class="slip-data-value">${item.leave_type}</span></div>
        <div class="slip-data-item"><span class="slip-data-label">Approved Duration</span><span class="slip-data-value">${item.total_days} Working Day(s)</span></div>
        <div class="slip-data-item"><span class="slip-data-label">Leave Period</span><span class="slip-data-value">${formatDateDisplay(item.start_date)} to ${formatDateDisplay(item.end_date)}</span></div>
        <div class="slip-data-item"><span class="slip-data-label">Leave Status</span><span class="slip-data-value" style="color: #16A34A; font-weight: bold;">CONCLUDED</span></div>
      </div>

      <div class="slip-section-heading">3. Official Resumption of Duty Certification</div>
      <div class="slip-resumption-section">
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-bottom: 12px;">
          <div>
            <span class="slip-data-label">Official Resumption Date:</span>
            <div style="font-size: 1.05rem; font-weight: bold; color: #0B1A3A; margin-top: 2px;">${formatDateDisplay(item.resumption_date)}</div>
          </div>
          <div>
            <span class="slip-data-label">Staff Declaration:</span>
            <div style="font-size: 0.85rem; font-style: italic; color: #334155; margin-top: 2px;">"${item.resumption_remarks || 'I confirm I have returned and resumed full official duties.'}"</div>
          </div>
        </div>

        <div style="margin-top: 15px; padding-top: 12px; border-top: 1px dashed #94A3B8;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
            <div class="slip-sign-title" style="margin: 0;">Head of Unit (HOU) Verification & Acceptance</div>
            <span class="slip-status-stamp ${isVerified ? 'slip-stamp-approved' : 'slip-stamp-verified'}">
              ${isVerified ? 'VERIFIED & CLEARED AT STATION BY HOU' : 'REPORTED - PENDING HOU COUNTERSIGN'}
            </span>
          </div>
          ${item.hou_resumption_date ? `<div style="font-size: 0.75rem; color: #64748B; margin-top: 4px;">Validated on: ${formatDateDisplay(item.hou_resumption_date)}</div>` : ''}
          <div class="slip-sign-line" style="margin-top: 25px;">Head of Unit (HOU) Signature & Unit Stamp</div>
        </div>
      </div>

      <div class="slip-footer-note">
        This document certifies the official return and resumption of duty for staff member ${currentStaff.full_name} (${currentStaff.isse_file_no}) at ISSE.
        A copy is officially recorded with the Head of Administration for institutional personnel records.
      </div>
    </div>
  `;

  openPrintModal();
}

async function fetchStaffLeaveHistory(isseFileNo) {
  try {
    const res = await fetch(`${API_BASE}/leave/staff-history/${encodeURIComponent(isseFileNo)}`);
    if (!res.ok) throw new Error('Failed to fetch leave records');
    cachedLeaveRecords = await res.json();
    renderStatusTable();
    renderHistoryTable();
    // Keep the Profile entitlement row fresh — cheap call, runs after
    // every submit / cancel / login / resumption.
    refreshAnnualEntitlementDisplay();
  } catch (err) {
    console.error('History fetch error:', err);
  }
}

function handleLogout() {
  sessionStorage.removeItem('currentStaff');
  sessionStorage.removeItem('activeSection');
  localStorage.removeItem('currentStaff');
  currentStaff = null;
  cachedLeaveRecords = [];
  renderStatusTable();
  renderHistoryTable();
  showLoginModal();
}

// ============================================================
// MY ATTENDANCE — STAFF SELF-SERVICE
// ============================================================

const MY_ATTENDANCE_MONTH_NAMES = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December'
];

// Mirror of the admin defaults. Kept here so the staff portal does not
// need an authenticated call to /api/admin/attendance/settings.
const MY_ATTENDANCE_THRESHOLDS = { warning: 75, good: 90, excellent: 95 };

let cachedMyAttendanceMonths = [];
let cachedMyAttendanceRecord = null;
let currentMyAttendanceYear  = null;
let currentMyAttendanceMonth = null;
let myAttendanceLoaded       = false;

function classifyMyAttendance(pct) {
  const t = MY_ATTENDANCE_THRESHOLDS;
  if (pct >= 100)         return { label: 'Perfect',   cls: 'status-approved', color: '#16A34A' };
  if (pct >= t.excellent) return { label: 'Excellent', cls: 'status-approved', color: '#0284C7' };
  if (pct >= t.good)      return { label: 'Good',      cls: 'status-pending',  color: '#F59E0B' };
  if (pct >= t.warning)   return { label: 'Low',       cls: 'status-pending',  color: '#EAB308' };
  return                         { label: 'Warning',   cls: 'status-rejected', color: '#DC2626' };
}

async function loadMyAttendancePage() {
  const tbody = document.getElementById('myAttendanceTableBody');
  const sel   = document.getElementById('myAttendanceMonthSelect');
  if (!tbody || !sel) return;

  if (!currentStaff || !currentStaff.isse_file_no) {
    sel.innerHTML = '<option value="">No data available</option>';
    sel.disabled = true;
    tbody.innerHTML = `<tr><td colspan="6" class="empty-state-cell">Please log in to view your attendance.</td></tr>`;
    return;
  }

  // --- Load the list of months this staff member has data for ---
  try {
    const res = await fetch(
      `${API_BASE}/attendance/my-months/${encodeURIComponent(currentStaff.isse_file_no)}`
    );
    if (!res.ok) throw new Error('Failed to load attendance months.');
    cachedMyAttendanceMonths = await res.json();
  } catch (err) {
    console.error('My attendance months load error:', err);
    cachedMyAttendanceMonths = [];
  }

  if (!Array.isArray(cachedMyAttendanceMonths) || cachedMyAttendanceMonths.length === 0) {
    sel.innerHTML = '<option value="">No data available</option>';
    sel.disabled = true;
    currentMyAttendanceYear  = null;
    currentMyAttendanceMonth = null;
    cachedMyAttendanceRecord = null;
    tbody.innerHTML = `
      <tr>
        <td colspan="6" class="empty-state-cell" style="padding: 35px 16px; text-align: center;">
          <div style="font-size: 2rem; margin-bottom: 8px;">📅</div>
          <div style="font-weight: 700; color: var(--text-primary); margin-bottom: 4px;">No attendance records available yet</div>
          <div style="font-size: 0.85rem; color: var(--text-muted);">Once your monthly attendance has been uploaded by HR, it will appear here.</div>
        </td>
      </tr>
    `;
    return;
  }

  // --- Populate the dropdown ---
  sel.disabled = false;
  sel.innerHTML = cachedMyAttendanceMonths.map(m =>
    `<option value="${m.year}-${m.month}">${MY_ATTENDANCE_MONTH_NAMES[m.month - 1]} ${m.year}</option>`
  ).join('');

  // Preserve current selection if still present; otherwise default to the newest month
  let stillValid = false;
  if (currentMyAttendanceYear && currentMyAttendanceMonth) {
    const key = `${currentMyAttendanceYear}-${currentMyAttendanceMonth}`;
    if (cachedMyAttendanceMonths.find(m => `${m.year}-${m.month}` === key)) {
      sel.value = key;
      stillValid = true;
    }
  }
  if (!stillValid) {
    currentMyAttendanceYear  = cachedMyAttendanceMonths[0].year;
    currentMyAttendanceMonth = cachedMyAttendanceMonths[0].month;
    sel.value = `${currentMyAttendanceYear}-${currentMyAttendanceMonth}`;
  }

  // --- Load the record for the currently selected month ---
  await loadMyAttendanceRecord();
}

async function loadMyAttendanceRecord() {
  const tbody = document.getElementById('myAttendanceTableBody');
  if (!tbody) return;

  if (!currentStaff || !currentMyAttendanceYear || !currentMyAttendanceMonth) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty-state-cell">No attendance record selected.</td></tr>`;
    return;
  }

  try {
    const res = await fetch(
      `${API_BASE}/attendance/my-record/${encodeURIComponent(currentStaff.isse_file_no)}` +
      `?year=${currentMyAttendanceYear}&month=${currentMyAttendanceMonth}`
    );
    if (!res.ok) throw new Error('Failed to load attendance record.');
    cachedMyAttendanceRecord = await res.json();
  } catch (err) {
    console.error('My attendance record load error:', err);
    cachedMyAttendanceRecord = null;
    tbody.innerHTML = `<tr><td colspan="6" class="empty-state-cell">Could not load your attendance for this month.</td></tr>`;
    return;
  }

  renderMyAttendanceTable();
}

function renderMyAttendanceTable() {
  const tbody = document.getElementById('myAttendanceTableBody');
  if (!tbody) return;

  const r = cachedMyAttendanceRecord;
  if (!r) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty-state-cell">No attendance record available for this month.</td></tr>`;
    return;
  }

  const pct = parseFloat(r.percentage) || 0;
  const cls = classifyMyAttendance(pct);

  tbody.innerHTML = `
    <tr>
      <td style="text-align:center; color:#16A34A; font-weight:700;">${r.present_days}</td>
      <td style="text-align:center; color:#DC2626; font-weight:700;">${r.absent_days}</td>
      <td style="text-align:center;">${r.working_days}</td>
      <td style="text-align:center; font-weight:800; color:${cls.color};">${pct.toFixed(2)}%</td>
      <td><span class="status-badge ${cls.cls}">${cls.label}</span></td>
      <td>
        <button class="btn-action btn-action-print"
                onclick="openMyAttendanceDetail()">📅 View Grid</button>
      </td>
    </tr>
  `;
}

function openMyAttendanceDetail() {
  const r = cachedMyAttendanceRecord;
  if (!r || !currentMyAttendanceYear || !currentMyAttendanceMonth) return;

  const daysInMonth = new Date(currentMyAttendanceYear, currentMyAttendanceMonth, 0).getDate();
  const pct = parseFloat(r.percentage) || 0;
  const cls = classifyMyAttendance(pct);

  const titleEl = document.getElementById('myAttendanceDetailTitle');
  if (titleEl) {
    titleEl.textContent =
      `My Attendance — ${MY_ATTENDANCE_MONTH_NAMES[currentMyAttendanceMonth - 1]} ${currentMyAttendanceYear}`;
  }

  let html = `
    <div style="display: grid; grid-template-columns: 2fr 1fr; gap: 15px; margin-bottom: 18px;">
      <div>
        <div style="font-size: 0.72rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px;">Period</div>
        <div style="font-size: 1.05rem; font-weight: 700;">
          ${MY_ATTENDANCE_MONTH_NAMES[currentMyAttendanceMonth - 1]} ${currentMyAttendanceYear}
        </div>
        <div style="font-size: 0.82rem; color: var(--text-muted);">
          ${currentStaff.full_name || ''} &middot; ${currentStaff.isse_file_no || ''}
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
        <div style="font-size: 1.4rem; font-weight: 800; color: #16A34A;">${r.present_days}</div>
      </div>
      <div style="padding: 10px; background: rgba(220,38,38,0.08); border-radius: 6px; text-align: center;">
        <div style="font-size: 0.7rem; text-transform: uppercase; color: var(--text-muted); font-weight: 700;">Absent</div>
        <div style="font-size: 1.4rem; font-weight: 800; color: #DC2626;">${r.absent_days}</div>
      </div>
      <div style="padding: 10px; background: rgba(2,132,199,0.08); border-radius: 6px; text-align: center;">
        <div style="font-size: 0.7rem; text-transform: uppercase; color: var(--text-muted); font-weight: 700;">Working Days</div>
        <div style="font-size: 1.4rem; font-weight: 800; color: #0284C7;">${r.working_days}</div>
      </div>
      <div style="padding: 10px; background: rgba(212,168,67,0.08); border-radius: 6px; text-align: center;">
        <div style="font-size: 0.7rem; text-transform: uppercase; color: var(--text-muted); font-weight: 700;">Cells Filled</div>
        <div style="font-size: 1.4rem; font-weight: 800; color: var(--accent-gold);">
          ${r.days_provided}/${r.working_days}
        </div>
      </div>
    </div>

    <h4 style="font-size: 0.85rem; color: var(--accent-gold); margin-bottom: 10px;
               text-transform: uppercase; letter-spacing: 0.4px;">
      Daily Grid
    </h4>
    <div style="display: grid; grid-template-columns: repeat(7, 1fr); gap: 6px;">
  `;

  ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].forEach(d => {
    html += `<div style="text-align:center; font-size:0.7rem; font-weight:700;
                         color: var(--text-muted); padding: 4px;">${d}</div>`;
  });

  const firstDow = new Date(currentMyAttendanceYear, currentMyAttendanceMonth - 1, 1).getDay();
  for (let i = 0; i < firstDow; i++) html += `<div></div>`;

  const days = Array.isArray(r.days) ? r.days : [];
  for (let d = 1; d <= daysInMonth; d++) {
    const date = new Date(currentMyAttendanceYear, currentMyAttendanceMonth - 1, d);
    const working = isWorkingDay(date);   // reuses the helper already in script.js
    const v = days[d - 1] || '';

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
  html += `</div>`;

  document.getElementById('myAttendanceDetailBody').innerHTML = html;
  document.getElementById('myAttendanceDetailModal').style.display = 'flex';
}

function closeMyAttendanceDetailModal() {
  const modal = document.getElementById('myAttendanceDetailModal');
  if (modal) modal.style.display = 'none';
}
// Month picker for the My Attendance page (wired once at load)
document.addEventListener('DOMContentLoaded', () => {
  const sel = document.getElementById('myAttendanceMonthSelect');
  if (sel) {
    sel.addEventListener('change', (e) => {
      const [y, m] = e.target.value.split('-').map(Number);
      if (!y || !m) return;
      currentMyAttendanceYear  = y;
      currentMyAttendanceMonth = m;
      loadMyAttendanceRecord();
    });
  }
});

// ============================================================
// MY ENQUIRIES — STAFF SELF-SERVICE
// ============================================================

let cachedMyEnquiries = [];

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

function enquiryStatusBadge(status) {
  if (status === 'replied') {
    return '<span class="status-badge status-approved">Replied</span>';
  }
  if (status === 'not replied') {
    return '<span class="status-badge status-pending">Awaiting Reply</span>';
  }
  return '<span class="status-badge" style="background:rgba(220,38,38,0.15); color:#DC2626; border:1px solid #DC2626;">Unread</span>';
}

// ---- Sidebar badge ----
async function loadMyEnquiriesBadge() {
  if (!currentStaff || !currentStaff.isse_file_no) return;
  try {
    const res = await fetch(`${API_BASE}/staff-enquiries/my/${encodeURIComponent(currentStaff.isse_file_no)}`);
    if (!res.ok) return;
    const rows = await res.json();
    updateMyEnquiriesBadge(rows);
  } catch (_) {
    /* silent — badge just won't show */
  }
}

function updateMyEnquiriesBadge(enquiries) {
  const badge = document.getElementById('myEnquiriesBadge');
  if (!badge) return;
  const unseen = (enquiries || []).filter(
    e => e.status === 'replied' && !e.staff_viewed_reply_at
  ).length;
  if (unseen > 0) {
    badge.textContent = unseen;
    badge.style.display = 'inline-block';
  } else {
    badge.style.display = 'none';
  }
}

// ---- Full page load ----
async function loadMyEnquiriesPage() {
  const tbody = document.getElementById('myEnquiriesTableBody');
  if (!tbody) return;

  if (!currentStaff || !currentStaff.isse_file_no) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty-state-cell">Log in to view your enquiries.</td></tr>`;
    return;
  }

  tbody.innerHTML = `<tr><td colspan="5" class="empty-state-cell">Loading your enquiries...</td></tr>`;

  try {
    const res = await fetch(`${API_BASE}/staff-enquiries/my/${encodeURIComponent(currentStaff.isse_file_no)}`);
    if (!res.ok) throw new Error('Failed to load enquiries.');
    cachedMyEnquiries = await res.json();

    updateMyEnquiriesBadge(cachedMyEnquiries);

    if (!cachedMyEnquiries.length) {
      tbody.innerHTML = `
        <tr>
          <td colspan="5" class="empty-state-cell" style="padding: 35px 16px;">
            <div style="font-size: 1.8rem; margin-bottom: 6px;">✉️</div>
            <div style="font-weight: 700; color: var(--text-primary); margin-bottom: 4px;">No enquiries yet</div>
            <div style="font-size: 0.85rem; color: var(--text-muted);">Use the form above to send your first enquiry.</div>
          </td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = cachedMyEnquiries.map(e => {
      const subject = e.subject && e.subject.trim() ? e.subject : '(No subject)';
      const preview = (e.message || '').length > 90
        ? e.message.substring(0, 90) + '…'
        : (e.message || '');
      const isUnseen = e.status === 'replied' && !e.staff_viewed_reply_at;
      const rowStyle = isUnseen ? 'background: rgba(212,168,67,0.06);' : '';
      const unseenDot = isUnseen
        ? '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#DC2626;margin-left:6px;" title="New reply"></span>'
        : '';

      return `
        <tr style="${rowStyle}">
          <td style="font-size: 0.82rem;">${formatEnquiryDate(e.created_at)}</td>
          <td style="font-weight: 600;">${escapeEnquiryHtml(subject)}${unseenDot}</td>
          <td style="font-size: 0.82rem; color: var(--text-muted);">${escapeEnquiryHtml(preview)}</td>
          <td>${enquiryStatusBadge(e.status)}</td>
          <td>
            <button class="btn-action btn-action-print" onclick="openMyEnquiryDetail(${e.id})">👁️ View</button>
          </td>
        </tr>
      `;
    }).join('');
  } catch (err) {
    console.error('Enquiry load error:', err);
    tbody.innerHTML = `<tr><td colspan="5" class="empty-state-cell" style="color:#DC2626;">Could not load your enquiries. Please refresh.</td></tr>`;
  }
}

// ---- Detail modal ----
async function openMyEnquiryDetail(enquiryId) {
  if (!currentStaff || !currentStaff.isse_file_no) return;

  const modal = document.getElementById('myEnquiryDetailModal');
  const titleEl = document.getElementById('myEnquiryDetailTitle');
  const bodyEl = document.getElementById('myEnquiryDetailBody');
  if (!modal || !bodyEl) return;

  if (titleEl) titleEl.textContent = 'Enquiry Detail';
  bodyEl.innerHTML = 'Loading...';
  modal.style.display = 'flex';

  try {
    const res = await fetch(
      `${API_BASE}/staff-enquiries/my/${encodeURIComponent(currentStaff.isse_file_no)}/${enquiryId}`
    );
    if (!res.ok) throw new Error('Failed to load enquiry.');
    const e = await res.json();

    if (titleEl) {
      titleEl.textContent = e.subject && e.subject.trim() ? e.subject : 'Enquiry Detail';
    }

    const sentDate = formatEnquiryDate(e.created_at);

    let html = `
      <div style="margin-bottom: 16px;">
        <div style="font-size: 0.72rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px;">Sent</div>
        <div style="font-size: 0.9rem; font-weight: 600;">${sentDate}</div>
        <div style="margin-top: 6px;">${enquiryStatusBadge(e.status)}</div>
      </div>

      <div style="background: var(--bg-main); border-left: 4px solid var(--accent-gold); padding: 14px 16px; border-radius: 6px; margin-bottom: 18px;">
        <div style="font-size: 0.75rem; color: var(--accent-gold); font-weight: 700; text-transform: uppercase; letter-spacing: 0.4px; margin-bottom: 8px;">
          Your Message
        </div>
        <div style="font-size: 0.9rem; line-height: 1.6; color: var(--text-primary); white-space: pre-wrap;">${escapeEnquiryHtml(e.message || '')}</div>
      </div>
    `;

    if (e.reply) {
      html += `
        <div style="background: rgba(2,132,199,0.08); border-left: 4px solid #0284C7; padding: 14px 16px; border-radius: 6px;">
          <div style="font-size: 0.75rem; color: #0284C7; font-weight: 700; text-transform: uppercase; letter-spacing: 0.4px; margin-bottom: 8px;">
            Reply from ${escapeEnquiryHtml(e.reply.admin_username)}${e.reply.admin_role ? ` · ${escapeEnquiryHtml(e.reply.admin_role)}` : ''}
          </div>
          <div style="font-size: 0.9rem; line-height: 1.6; color: var(--text-primary); white-space: pre-wrap; margin-bottom: 8px;">${escapeEnquiryHtml(e.reply.body)}</div>
          <div style="font-size: 0.72rem; color: var(--text-muted); text-align: right;">${formatEnquiryDate(e.reply.created_at)}</div>
        </div>
      `;
    } else {
      html += `
        <div style="background: rgba(245,158,11,0.08); border-left: 4px solid #F59E0B; padding: 14px 16px; border-radius: 6px;">
          <div style="font-size: 0.85rem; color: #F59E0B; font-weight: 600;">⏳ Awaiting reply</div>
          <div style="font-size: 0.82rem; color: var(--text-muted); margin-top: 4px;">
            HR/Admin has been notified. You'll receive an email once they respond.
          </div>
        </div>
      `;
    }

    bodyEl.innerHTML = html;

    // If a reply was just revealed, refresh the badge and the list,
    // because the backend stamped staff_viewed_reply_at on this call.
    if (e.reply && !e.staff_viewed_reply_at) {
      loadMyEnquiriesPage();
    }
  } catch (err) {
    console.error('Enquiry detail error:', err);
    bodyEl.innerHTML = `<p style="color:#DC2626;">Could not load this enquiry. Please try again.</p>`;
  }
}

function closeMyEnquiryDetailModal() {
  const modal = document.getElementById('myEnquiryDetailModal');
  if (modal) modal.style.display = 'none';
}

// ---- Submit new enquiry ----
async function handleEnquirySubmission(e) {
  e.preventDefault();
  if (!currentStaff) {
    alert('Please log in first.');
    return;
  }

  const subjectEl = document.getElementById('enquirySubject');
  const messageEl = document.getElementById('enquiryMessage');
  const btn = document.getElementById('submitEnquiryBtn');

  const subject = subjectEl ? subjectEl.value.trim() : '';
  const message = messageEl ? messageEl.value.trim() : '';

  if (!message || message.length < 5) {
    alert('Please write a message before submitting.');
    return;
  }

  const orig = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Submitting...'; }

  try {
    const res = await fetch(`${API_BASE}/staff-enquiries`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        isseFileNo: currentStaff.isse_file_no,
        subject: subject || null,
        message
      })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Submission failed.');

    alert('Your enquiry has been sent. You will receive an email when HR replies.');

    if (subjectEl) subjectEl.value = '';
    if (messageEl) messageEl.value = '';

    loadMyEnquiriesPage();
  } catch (err) {
    alert(err.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = orig || 'Submit Enquiry'; }
  }
}

window.openMyEnquiryDetail = openMyEnquiryDetail;
window.closeMyEnquiryDetailModal = closeMyEnquiryDetailModal;