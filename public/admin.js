const loginForm = document.getElementById('login-form');
const panel = document.getElementById('panel');
const logoutBtn = document.getElementById('logout');
const logDate = document.getElementById('log-date');

function showPanel(loggedIn) {
  loginForm.hidden = loggedIn;
  panel.hidden = !loggedIn;
  logoutBtn.hidden = !loggedIn;
  if (loggedIn) loadAll();
}

async function init() {
  logDate.value = todayIST();
  const { ok } = await api('/api/admin/me');
  showPanel(ok);
}

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(loginForm));
  const { ok, body } = await api('/api/admin/login', { method: 'POST', body: JSON.stringify(data) });
  const err = document.getElementById('login-error');
  err.hidden = ok;
  err.textContent = body.message || '';
  if (ok) { loginForm.reset(); showPanel(true); }
});

logoutBtn.addEventListener('click', async () => {
  await api('/api/admin/logout', { method: 'POST' });
  showPanel(false);
});

// Any 401 after login means the session expired.
async function adminApi(path, options) {
  const res = await api(path, options);
  if (res.status === 401) showPanel(false);
  return res;
}

function loadAll() {
  loadStats();
  loadSettings();
  loadLogs();
}

async function loadStats() {
  const { ok, body } = await adminApi('/api/admin/stats');
  if (ok) document.getElementById('stats').textContent =
    `${body.members} members registered · ${body.logs} log entries in total`;
}

// ---- Settings ----

const settingsForm = document.getElementById('settings-form');

async function loadSettings() {
  const { ok, body } = await adminApi('/api/admin/settings');
  if (!ok) return;
  settingsForm.opening_time.value = body.opening_time;
  settingsForm.closing_time.value = body.closing_time;
}

settingsForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(settingsForm));
  const { ok, body } = await adminApi('/api/admin/settings', { method: 'PUT', body: JSON.stringify(data) });
  document.getElementById('settings-msg').textContent = ok ? 'Saved' : body.message;
});

// ---- Import ----

const importForm = document.getElementById('import-form');

importForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const file = importForm.file.files[0];
  const out = document.getElementById('import-result');
  if (!file) return;
  out.textContent = 'Importing…';
  const { ok, body } = await adminApi('/api/admin/import', {
    method: 'POST',
    body: file,
    headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': file.name },
  });
  if (!ok) { out.replaceChildren(el('p', { className: 'error-text', textContent: body.message })); return; }

  const parts = [el('p', { textContent:
    `Added ${body.added}, updated ${body.updated}, skipped ${body.skipped.length}.` })];
  if (body.skipped.length) {
    parts.push(el('ul', { className: 'skipped' },
      ...body.skipped.map((s) => el('li', { textContent: `Row ${s.row}: ${s.reason}` }))));
  }
  out.replaceChildren(...parts);
  importForm.reset();
  loadStats();
});

// ---- Logs, CSV and chart ----

logDate.addEventListener('change', loadLogs);

document.getElementById('download-csv').addEventListener('click', () => {
  window.location.href = `/api/admin/export?date=${encodeURIComponent(logDate.value)}`;
});

async function loadLogs() {
  const date = logDate.value;
  const [logs, peak] = await Promise.all([
    adminApi(`/api/admin/logs?date=${encodeURIComponent(date)}`),
    adminApi(`/api/peak?date=${encodeURIComponent(date)}`),
  ]);
  if (logs.ok) renderLogs(logs.body);
  if (peak.ok) renderChart(peak.body);
}

function renderLogs(rows) {
  const tbody = document.querySelector('#logs-table tbody');
  tbody.replaceChildren(...rows.map((r) => {
    const tr = el('tr');
    const cells = [
      r.full_reg_no, r.name, r.branch, r.year, r.role,
      formatTime12(r.entry_time),
      r.exit_time ? formatTime12(r.exit_time) : 'Inside',
      r.exit_reason || '',
    ];
    for (const c of cells) tr.append(el('td', { textContent: c ?? '' }));
    if (r.exit_reason) tr.className = 'auto-exit';
    return tr;
  }));
  document.getElementById('logs-empty').hidden = rows.length > 0;
}

function renderChart({ peak, histogram }) {
  document.getElementById('peak-label').textContent = peak
    ? `Peak time: ${peak.label} (${peak.entries} entries)`
    : 'No entries on this date.';
  const max = Math.max(1, ...histogram);
  const chart = document.getElementById('chart');
  // Show library-ish hours, widened to include any hour that has entries.
  const used = histogram.map((n, h) => (n ? h : null)).filter((h) => h !== null);
  const from = Math.min(7, ...used);
  const to = Math.max(20, ...used);
  const bars = [];
  for (let h = from; h <= to; h++) {
    const n = histogram[h];
    const bar = el('div', { className: `bar${peak && peak.hour === h ? ' peak' : ''}`,
      title: `${n} entries` });
    bar.style.height = `${(n / max) * 100}%`;
    const label = h % 12 === 0 ? 12 : h % 12;
    bars.push(el('div', { className: 'bar-col' },
      el('span', { className: 'bar-val', textContent: n || '' }),
      el('div', { className: 'bar-track' }, bar),
      el('span', { className: 'bar-label', textContent: `${label}${h < 12 ? 'a' : 'p'}` })));
  }
  chart.replaceChildren(...bars);
}

init();
