const loginForm = document.getElementById('login-form');
const loginView = document.getElementById('login-view');
const appView = document.getElementById('app');
const $ = (id) => document.getElementById(id);

let config = {};

// ---- Helpers ----

function setMsg(node, text, kind = '') {
  node.textContent = text || '';
  node.className = `msg ${kind}`;
}

function bytes(n) {
  return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
}

// Fetches a file and saves it. Returns the Blob and its filename.
async function downloadFile(url) {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (res.status === 401) { showApp(false); throw new Error('Login required'); }
  if (!res.ok) {
    let msg = 'Download failed';
    try { msg = (await res.json()).message || msg; } catch { /* not JSON */ }
    throw new Error(msg);
  }
  const blob = await res.blob();
  const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '')?.[1] || 'download';
  const a = el('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  return { blob, name };
}

// Any 401 after login means the session expired.
async function adminApi(path, options) {
  const res = await api(path, options);
  if (res.status === 401) showApp(false);
  return res;
}

const dialog = $('dialog');
function ask({ title, text, password = false, okLabel = 'OK' }) {
  $('dlg-title').textContent = title;
  $('dlg-text').textContent = text;
  $('dlg-ok').textContent = okLabel;
  const pw = $('dlg-password');
  pw.hidden = !password;
  pw.value = '';
  dialog.returnValue = '';
  dialog.showModal();
  if (password) pw.focus();
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => {
      resolve(dialog.returnValue === 'ok' ? (password ? pw.value : true) : null);
    }, { once: true });
  });
}

// ---- Period picker (Day / Week / Month + calendar) ----

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function rangeLabel(period, date) {
  const d = new Date(`${date}T00:00:00`);
  const nice = (x) => `${x.getDate()} ${MONTH_NAMES[x.getMonth()]} ${x.getFullYear()}`;
  if (period === 'day') return `${DAY_NAMES[d.getDay()]} ${nice(d)}`;
  if (period === 'month') return `${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`;
  const mon = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
  const sun = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 6);
  return `Mon ${nice(mon)} – Sun ${nice(sun)}`;
}

function createPicker(container, onChange) {
  let period = 'day';
  const seg = el('div', { className: 'seg', role: 'group' });
  const buttons = ['day', 'week', 'month'].map((p) => {
    const b = el('button', { type: 'button', textContent: p[0].toUpperCase() + p.slice(1) });
    b.addEventListener('click', () => { period = p; sync(); onChange?.(); });
    seg.append(b);
    return b;
  });
  const dateInput = el('input', { type: 'date', value: todayIST() });
  const monthInput = el('input', { type: 'month', value: todayIST().slice(0, 7) });
  const label = el('span', { className: 'range-label' });
  const dateLabel = el('label', {}, 'Date', dateInput);
  const monthLabel = el('label', {}, 'Month', monthInput);
  container.replaceChildren(el('div', { className: 'picker' }, el('label', {}, 'Period', seg), dateLabel, monthLabel, label));
  dateInput.addEventListener('change', () => { sync(); onChange?.(); });
  monthInput.addEventListener('change', () => { sync(); onChange?.(); });

  function value() {
    const date = period === 'month' ? `${monthInput.value || todayIST().slice(0, 7)}-01` : (dateInput.value || todayIST());
    return { period, date };
  }
  function sync() {
    buttons.forEach((b, i) => b.classList.toggle('on', ['day', 'week', 'month'][i] === period));
    dateLabel.hidden = period === 'month';
    monthLabel.hidden = period !== 'month';
    const v = value();
    label.textContent = rangeLabel(v.period, v.date);
  }
  sync();
  return { value, label: () => label.textContent };
}

const query = (o) => new URLSearchParams(o).toString();

// ---- Login / logout ----

function showApp(loggedIn) {
  loginView.hidden = loggedIn;
  appView.hidden = !loggedIn;
  if (loggedIn) {
    loadConfig();
    loadAlerts();
    showSection(location.hash.slice(1) || 'dashboard');
  }
}

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(loginForm));
  const btn = loginForm.querySelector('.lv-submit');
  btn.disabled = true;
  const { ok, body } = await api('/api/admin/login', { method: 'POST', body: JSON.stringify(data) });
  btn.disabled = false;
  const err = $('login-error');
  err.hidden = ok;
  err.textContent = body.message || '';
  if (ok) { loginForm.reset(); showApp(true); }
});

$('toggle-password').addEventListener('click', (e) => {
  const field = loginForm.password;
  const show = field.type === 'password';
  field.type = show ? 'text' : 'password';
  e.currentTarget.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  e.currentTarget.querySelector('use').setAttribute('href', show ? '#i-eye-off' : '#i-eye');
});

$('logout').addEventListener('click', async () => {
  await api('/api/admin/logout', { method: 'POST' });
  showApp(false);
});

async function loadConfig() {
  const { ok, body } = await adminApi('/api/admin/config');
  if (!ok) return;
  config = body;
  $('rp-admin-email').textContent = body.admin_email ? `(${body.admin_email})` : '';
  if (!body.mail_configured || !body.admin_email) {
    $('rp-email').checked = false;
    $('rp-email').disabled = true;
    $('rp-email-only').disabled = true;
    $('rp-admin-email').textContent = '(email is not set up: SMTP and ADMIN_EMAIL)';
  }
}

// ---- Sections ----

const loaders = {
  dashboard: loadDashboard,
  analytics: loadAnalytics,
  share: loadRecipients,
  backups: loadBackups,
  members: () => { loadSettings(); loadLogs(); },
  contact: loadContact,
  security: loadAudit,
};

function showSection(name) {
  if (!document.getElementById(`sec-${name}`)) name = 'dashboard';
  document.querySelectorAll('.section').forEach((s) => { s.hidden = s.id !== `sec-${name}`; });
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.section === name || a.dataset.also === name));
  closeMenus();
  window.scrollTo(0, 0);
  loaders[name]?.();
}

window.addEventListener('hashchange', () => { if (!appView.hidden) showSection(location.hash.slice(1)); });

// ---- Header menus and alerts ----

const menus = [['bell', 'bell-menu'], ['account', 'account-menu']];
function closeMenus() {
  for (const [btn, menu] of menus) { $(menu).hidden = true; $(btn).setAttribute('aria-expanded', 'false'); }
}
for (const [btn, menu] of menus) {
  $(btn).addEventListener('click', (e) => {
    e.stopPropagation();
    const open = $(menu).hidden;
    closeMenus();
    $(menu).hidden = !open;
    $(btn).setAttribute('aria-expanded', String(open));
    if (open && btn === 'bell') $('bell-dot').hidden = true;
  });
}
document.addEventListener('click', (e) => { if (!e.target.closest('.menu')) closeMenus(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenus(); });

const ALERT_LABELS = {
  login_fail: 'Failed admin login', login_locked: 'Admin login locked', backup_fail: 'Backup failed',
  restore: 'Backup restored', restore_fail: 'Restore failed', report_email_fail: 'Report email failed',
  share_fail: 'Report share failed', password_change: 'Admin password changed', password_change_fail: 'Wrong current password',
};

// Security and failure events from the audit log in the last 24 hours.
async function loadAlerts() {
  const { ok, body } = await adminApi('/api/admin/audit');
  if (!ok) return;
  const since = new Date(Date.now() + clockOffset - 86400000);
  const sinceStr = `${since.toLocaleDateString('en-CA', { timeZone: TZ })} ${since.toLocaleTimeString('en-GB', { timeZone: TZ })}`;
  const alerts = body.filter((r) => ALERT_LABELS[r.action] && r.at >= sinceStr);
  $('bell-dot').hidden = alerts.length === 0;
  $('alerts-list').replaceChildren(...(alerts.length
    ? alerts.slice(0, 12).map((r) => el('li', {},
      el('b', { textContent: ALERT_LABELS[r.action] }),
      el('span', { className: 'muted', textContent: `${r.at.slice(11, 16)} · ${r.detail || r.ip || ''}` })))
    : [el('li', { className: 'muted', textContent: 'Nothing needs attention.' })]));
}
setInterval(() => { if (!appView.hidden) loadAlerts(); }, 5 * 60000);

// ---- 1. Dashboard ----

let clockOffset = 0;
const dateFmt = new Intl.DateTimeFormat('en-IN', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const timeFmt = new Intl.DateTimeFormat('en-IN', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });

function tickClock() {
  const now = new Date(Date.now() + clockOffset);
  const p = dateFmt.formatToParts(now);
  const get = (t) => p.find((x) => x.type === t)?.value;
  $('dash-date').textContent = `${get('weekday')}, ${get('day')} ${get('month')} ${get('year')}`;
  $('dash-time').textContent = timeFmt.format(now).toUpperCase();
}
setInterval(tickClock, 1000);

async function syncStatus() {
  const sent = Date.now();
  const { ok, body } = await api('/api/status');
  if (!ok) return;
  clockOffset = new Date(body.server_time).getTime() + (Date.now() - sent) / 2 - Date.now();
  tickClock();
  $('kpi-inside').textContent = body.inside;
  $('kpi-today').textContent = body.entries_today;
  $('kpi-peak').textContent = body.peak_today ? body.peak_today.label : 'No entries yet';
  $('kpi-timings').textContent = `${body.opening_label} – ${body.closing_label}`;
}
setInterval(() => { if (!appView.hidden) syncStatus(); }, 60000);

async function loadDashboard() {
  tickClock();
  syncStatus();
  const { ok, body } = await adminApi('/api/admin/stats');
  if (ok) $('stats').textContent = `${body.members} members registered · ${body.logs} visits recorded in total`;
}

// ---- 2. Entry Analytics ----

const anPicker = createPicker($('an-picker'), () => loadAnalytics());

async function loadAnalytics() {
  const { ok, body } = await adminApi(`/api/admin/analytics?${query(anPicker.value())}`);
  if (!ok) return;
  const t = body.totals;
  const cards = [
    ['Total entries', t.entries],
    ['Unique visitors', t.unique_visitors],
    ['Peak hour', body.peak_hour ? `${body.peak_hour.label} (${body.peak_hour.entries})` : '–'],
    ['Busiest day', body.busiest_day ? `${rangeLabel('day', body.busiest_day.date)} (${body.busiest_day.entries})` : '–'],
    ['Average stay', t.avg_stay_minutes == null ? '–' : `${Math.floor(t.avg_stay_minutes / 60)}h ${t.avg_stay_minutes % 60}m`],
    ['Auto-logouts', `${t.auto_logouts} of ${t.auto_logouts + t.manual_exits} exits`],
  ];
  $('an-cards').replaceChildren(...cards.map(([k, v]) => el('div', { className: 'card kpi' }, el('span', { textContent: k }), el('b', { textContent: v }))));
  renderAnalytics(body);
}

// ---- 3. Reports ----

const rpPicker = createPicker($('rp-picker'));
const rpFormat = () => document.querySelector('input[name="rp-format"]:checked').value;

async function emailReport(v, format) {
  const { ok, body } = await adminApi('/api/admin/report/email', { method: 'POST', body: JSON.stringify({ ...v, format }) });
  return ok ? `Emailed to ${body.to}.` : (body.message || 'Email could not be sent.');
}

$('rp-download').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const v = rpPicker.value();
  const format = rpFormat();
  btn.disabled = true;
  setMsg($('rp-msg'), 'Preparing…');
  try {
    await downloadFile(`/api/admin/report?${query({ ...v, format })}`);
    let text = 'Downloaded.';
    if ($('rp-email').checked) text += ` ${await emailReport(v, format)}`;
    setMsg($('rp-msg'), text, /could not|not set/i.test(text) ? 'err' : 'ok');
  } catch (err) {
    setMsg($('rp-msg'), err.message, 'err');
  } finally {
    btn.disabled = false;
  }
});

$('rp-email-only').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  setMsg($('rp-msg'), 'Sending…');
  const text = await emailReport(rpPicker.value(), rpFormat());
  setMsg($('rp-msg'), text, text.startsWith('Emailed') ? 'ok' : 'err');
  btn.disabled = false;
});

// ---- 4. Share Report ----

const shPicker = createPicker($('sh-picker'));
const shFormat = () => document.querySelector('input[name="sh-format"]:checked').value;
let recipients = [];

async function loadRecipients() {
  const { ok, body } = await adminApi('/api/admin/recipients');
  if (!ok) return;
  recipients = body;
  $('rc-table').querySelector('tbody').replaceChildren(...body.map((r) => {
    const edit = el('button', { type: 'button', className: 'btn sm', textContent: 'Edit' });
    const del = el('button', { type: 'button', className: 'btn sm danger', textContent: 'Remove' });
    edit.addEventListener('click', () => {
      const f = $('rc-form');
      f.id.value = r.id; f.name.value = r.name; f.email.value = r.email; f.role.value = r.role || ''; f.active.checked = Boolean(r.active);
      f.name.focus();
    });
    del.addEventListener('click', async () => {
      if (!await ask({ title: 'Remove recipient', text: `Remove ${r.name} (${r.email}) from the list?`, okLabel: 'Remove' })) return;
      await adminApi(`/api/admin/recipients/${r.id}`, { method: 'DELETE' });
      loadRecipients();
    });
    return el('tr', {},
      el('td', { textContent: r.name }), el('td', { textContent: r.email }), el('td', { textContent: r.role || '' }),
      el('td', { textContent: r.active ? 'Yes' : 'No' }), el('td', {}, edit, ' ', del));
  }));
  const active = body.filter((r) => r.active);
  $('sh-recipients').replaceChildren(...(active.length
    ? active.map((r) => el('label', { className: 'check' }, el('input', { type: 'checkbox', value: r.id }), `${r.name} <${r.email}>${r.role ? ` · ${r.role}` : ''}`))
    : [el('p', { className: 'muted', textContent: 'No saved recipients yet. Add them on the right.' })]));
}

$('rc-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.currentTarget;
  const data = { name: f.name.value.trim(), email: f.email.value.trim(), role: f.role.value.trim(), active: f.active.checked };
  const id = f.id.value;
  const { ok, body } = await adminApi(id ? `/api/admin/recipients/${id}` : '/api/admin/recipients', { method: id ? 'PUT' : 'POST', body: JSON.stringify(data) });
  setMsg($('rc-msg'), ok ? 'Saved.' : body.message, ok ? 'ok' : 'err');
  if (ok) { f.reset(); f.id.value = ''; loadRecipients(); }
});
$('rc-form').addEventListener('reset', (e) => { e.currentTarget.id.value = ''; });

function chosenRecipients() {
  return [...$('sh-recipients').querySelectorAll('input:checked')].map((i) => Number(i.value));
}

async function reportSize(v) {
  const { ok, body } = await adminApi(`/api/admin/analytics?${query(v)}`);
  return ok ? body.totals.unique_visitors : 0;
}

$('sh-send').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const v = shPicker.value();
  const ids = chosenRecipients();
  const extra = $('sh-extra').value.trim();
  const count = ids.length + (extra ? 1 : 0);
  if (!count) return setMsg($('sh-msg'), 'Pick at least one recipient.', 'err');
  if (extra && !$('sh-extra').checkValidity()) return setMsg($('sh-msg'), 'The other email address is not valid.', 'err');
  const people = await reportSize(v);
  if (!await ask({ title: 'Send report?', text: `This report (${shPicker.label()}) contains personal data of ${people} students/faculty. Send to ${count} recipient${count > 1 ? 's' : ''}?`, okLabel: 'Send' })) return;
  btn.disabled = true;
  setMsg($('sh-msg'), 'Sending…');
  const { ok, body } = await adminApi('/api/admin/report/share', {
    method: 'POST',
    body: JSON.stringify({ ...v, format: shFormat(), recipients: ids, extra, note: $('sh-note').value.trim() }),
  });
  setMsg($('sh-msg'), ok ? `Sent to ${body.sent_to.join(', ')}.` : body.message, ok ? 'ok' : 'err');
  btn.disabled = false;
});

const shareUrl = (v) => `/api/admin/report?${query({ ...v, format: shFormat() })}`;

$('sh-download').addEventListener('click', async () => {
  try {
    await downloadFile(shareUrl(shPicker.value()));
    setMsg($('sh-msg'), 'Downloaded. Attach it in any app to share.', 'ok');
  } catch (err) {
    setMsg($('sh-msg'), err.message, 'err');
  }
});

// Gmail can't receive an attachment from a web page, so the file downloads
// and a prefilled draft opens; the admin attaches the file.
$('sh-gmail').addEventListener('click', async () => {
  const v = shPicker.value();
  const emails = recipients.filter((r) => chosenRecipients().includes(r.id)).map((r) => r.email);
  const extra = $('sh-extra').value.trim();
  if (extra) emails.push(extra);
  const draft = window.open('about:blank', '_blank');
  try {
    const { name } = await downloadFile(shareUrl(v));
    const params = new URLSearchParams({
      view: 'cm', fs: '1', to: emails.join(','), su: `Library report: ${shPicker.label()}`,
      body: `${$('sh-note').value.trim()}\n\nPlease find the library report (${name}) attached.\nFor official library use only.`.trim(),
    });
    if (draft) { draft.opener = null; draft.location = `https://mail.google.com/mail/?${params}`; }
    setMsg($('sh-msg'), `Gmail draft opened. Attach the downloaded file: ${name}`, 'ok');
  } catch (err) {
    draft?.close();
    setMsg($('sh-msg'), err.message, 'err');
  }
});

// Web Share with a real file, where the browser supports it (mostly phones).
if (navigator.canShare && navigator.canShare({ files: [new File(['x'], 'x.csv', { type: 'text/csv' })] })) {
  $('sh-native').hidden = false;
  $('sh-native').addEventListener('click', async () => {
    try {
      const res = await fetch(shareUrl(shPicker.value()), { credentials: 'same-origin' });
      if (!res.ok) throw new Error('Could not prepare the report.');
      const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '')?.[1] || 'report';
      const file = new File([await res.blob()], name, { type: res.headers.get('Content-Type') });
      await navigator.share({ files: [file], title: `Library report: ${shPicker.label()}` });
    } catch (err) {
      if (err.name !== 'AbortError') setMsg($('sh-msg'), err.message, 'err');
    }
  });
}

// ---- 5. Backups ----

async function loadBackups() {
  const { ok, body } = await adminApi('/api/admin/backups');
  if (!ok) return;
  $('bk-info').textContent = body.mode === 'file'
    ? `A backup is taken automatically every day after closing time, and kept for ${body.keep_days} days. Backups are stored in data/backups on this PC; copy that folder to a USB drive or cloud folder regularly, because a backup on the same PC does not survive a dead disk.`
    : `A backup is taken automatically every day after closing time and kept in the online database for ${body.keep_days} days. Turso's own point-in-time restore is a second safety net.`;
  $('bk-empty').hidden = body.backups.length > 0;
  $('bk-table').querySelector('tbody').replaceChildren(...body.backups.map((b) => {
    const dl = el('button', { type: 'button', className: 'btn sm', textContent: 'Download' });
    const rs = el('button', { type: 'button', className: 'btn sm danger', textContent: 'Restore' });
    dl.addEventListener('click', () => downloadFile(`/api/admin/backups/${encodeURIComponent(b.name)}`).catch((err) => setMsg($('bk-msg'), err.message, 'err')));
    rs.addEventListener('click', async () => {
      const password = await ask({
        title: 'Restore backup',
        text: `Replace all members and visits with the backup from ${b.created_at}? A safety backup of the current data is taken first. Enter the admin password to continue.`,
        password: true, okLabel: 'Restore',
      });
      if (password == null) return;
      setMsg($('bk-msg'), 'Restoring…');
      const res = await adminApi(`/api/admin/backups/${encodeURIComponent(b.name)}/restore`, { method: 'POST', body: JSON.stringify({ password }) });
      setMsg($('bk-msg'), res.ok ? `Restored. Safety backup: ${res.body.safety_backup}` : res.body.message, res.ok ? 'ok' : 'err');
      loadBackups();
    });
    return el('tr', {},
      el('td', { textContent: b.name }), el('td', { textContent: b.created_at }), el('td', { textContent: bytes(b.size) }),
      el('td', { textContent: b.rows_members ?? '–' }), el('td', { textContent: b.rows_logs ?? '–' }), el('td', {}, dl, ' ', rs));
  }));
}

$('bk-now').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  setMsg($('bk-msg'), 'Backing up…');
  const { ok, body } = await adminApi('/api/admin/backups', { method: 'POST' });
  setMsg($('bk-msg'), ok ? `Backup ${body.name} saved (${body.rows_logs} visits).` : body.message, ok ? 'ok' : 'err');
  btn.disabled = false;
  loadBackups();
});

// ---- 6. Members & Settings ----

const settingsForm = $('settings-form');
const logDate = $('log-date');
logDate.value = todayIST();

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
  setMsg($('settings-msg'), ok ? 'Saved.' : body.message, ok ? 'ok' : 'err');
});

const importForm = $('import-form');
importForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const file = importForm.file.files[0];
  const out = $('import-result');
  if (!file) return;
  out.textContent = 'Importing…';
  const { ok, body } = await adminApi('/api/admin/import', {
    method: 'POST', body: file,
    headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': file.name },
  });
  if (!ok) { out.replaceChildren(el('p', { className: 'msg err', textContent: body.message })); return; }
  const parts = [el('p', { className: 'msg ok', textContent: `Added ${body.added}, updated ${body.updated}, skipped ${body.skipped.length}.` })];
  if (body.skipped.length) {
    parts.push(el('ul', {}, ...body.skipped.map((s) => el('li', { textContent: `Row ${s.row}: ${s.reason}` }))));
  }
  out.replaceChildren(...parts);
  importForm.reset();
});

logDate.addEventListener('change', loadLogs);
$('download-csv').addEventListener('click', () => {
  downloadFile(`/api/admin/export?date=${encodeURIComponent(logDate.value)}`).catch(() => {});
});

async function loadLogs() {
  const { ok, body } = await adminApi(`/api/admin/logs?date=${encodeURIComponent(logDate.value)}`);
  if (!ok) return;
  $('logs-table').querySelector('tbody').replaceChildren(...body.map((r) => {
    const auto = r.exit_reason === 'DO NOT LOGOUT';
    return el('tr', {},
      ...[r.full_reg_no, r.name, r.branch, r.year, r.role, formatTime12(r.entry_time), r.exit_time ? formatTime12(r.exit_time) : 'Inside']
        .map((c) => el('td', { textContent: c ?? '' })),
      el('td', { className: auto ? 'auto' : '', textContent: auto ? 'AUTO-LOGOUT' : '' }));
  }));
  $('logs-empty').hidden = body.length > 0;
}

// ---- 7. Contact Developer ----

async function loadContact() {
  const { ok, body } = await adminApi('/api/admin/contact');
  if (!ok) return;
  const rows = [
    ['Name', body.name], ['Role', body.role], ['Email', body.email], ['Phone / WhatsApp', body.phone],
    ['Availability', body.availability], ['Response time', body.response_time],
  ];
  $('dev-card').replaceChildren(...rows.flatMap(([k, v]) => {
    let value = v || 'Not set yet';
    if (v && k === 'Email') value = el('a', { href: `mailto:${v}`, textContent: v });
    if (v && k.startsWith('Phone')) value = el('a', { href: `tel:${v.replace(/[^\d+]/g, '')}`, textContent: v });
    return [el('dt', { textContent: k }), el('dd', {}, value)];
  }));
}

const contactForm = $('contact-form');
contactForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  for (const f of contactForm.elements) if (f.name && typeof f.value === 'string' && f.type !== 'select-one') f.value = f.value.trim();
  if (!contactForm.reportValidity()) return;
  const btn = contactForm.querySelector('button[type="submit"]');
  btn.disabled = true;
  setMsg($('contact-msg'), 'Sending…');
  try {
    const res = await fetch(contactForm.action, { method: 'POST', headers: { Accept: 'application/json' }, body: new FormData(contactForm) });
    if (!res.ok) throw new Error();
    contactForm.reset();
    setMsg($('contact-msg'), 'Thank you, your message has been sent.', 'ok');
  } catch {
    const email = $('dev-card').querySelector('a[href^="mailto:"]')?.textContent;
    setMsg($('contact-msg'), `The message could not be sent.${email ? ` Please email ${email} instead.` : ' Please try again later.'}`, 'err');
  } finally {
    btn.disabled = false;
  }
});

// ---- 8. Security & Privacy ----

$('password-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.currentTarget;
  const data = { current: f.current.value, next: f.next.value, confirm: f.confirm.value };
  const { ok, body } = await adminApi('/api/admin/password', { method: 'POST', body: JSON.stringify(data) });
  setMsg($('password-msg'), ok ? 'Password changed. Other sessions have been signed out.' : body.message, ok ? 'ok' : 'err');
  if (ok) f.reset();
  loadAudit();
});

async function loadAudit() {
  const { ok, body } = await adminApi('/api/admin/audit');
  if (!ok) return;
  $('audit-table').querySelector('tbody').replaceChildren(...body.map((r) =>
    el('tr', {}, ...[r.at, r.action, r.detail, r.ip].map((c) => el('td', { textContent: c ?? '' })))));
}

// ---- Start ----

(async () => {
  const { ok } = await api('/api/admin/me');
  showApp(ok);
})();
