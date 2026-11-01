const form = document.getElementById('entry-form');
const input = document.getElementById('reg-no');
const goBtn = document.getElementById('go');
const toast = document.getElementById('toast');

// ---- Live clock (always IST, rolls over at midnight on its own) ----

const dateFmt = new Intl.DateTimeFormat('en-IN', {
  timeZone: TZ, weekday: 'long', day: 'numeric', month: 'short', year: 'numeric',
});
const timeFmt = new Intl.DateTimeFormat('en-IN', {
  timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true,
});

function renderClock() {
  const now = new Date();
  const parts = dateFmt.formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  document.getElementById('clock-date').textContent =
    `${get('weekday')}, ${get('day')} ${get('month')} ${get('year')}`;
  document.getElementById('clock-time').textContent = timeFmt.format(now).toUpperCase();
}
renderClock();
setInterval(renderClock, 1000);

// ---- Pop-up ----

let toastTimer;
function showToast(message, type) {
  toast.textContent = message;
  toast.className = `toast toast-${type}`;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 3000);
}

// ---- Entry / exit ----

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const regNo = input.value.trim();
  if (!regNo) {
    showToast('Please enter an enrollment / employee number', 'warning');
    input.focus();
    return;
  }
  goBtn.disabled = true;
  try {
    const { body } = await api('/api/entry', {
      method: 'POST', body: JSON.stringify({ reg_no: regNo }),
    });
    showToast(body.message || 'Something went wrong', body.type || 'error');
    refresh();
  } catch {
    showToast('Cannot reach the server', 'error');
  } finally {
    goBtn.disabled = false;
    input.value = '';
    input.focus();
  }
});

// Keep the field focused for barcode / ID-card scanners.
document.addEventListener('click', (e) => {
  if (!e.target.closest('a, button, input')) input.focus();
});
window.addEventListener('focus', () => input.focus());

// ---- Live data ----

async function refresh() {
  try {
    const [status, inside] = await Promise.all([api('/api/status'), api('/api/inside')]);
    if (status.ok) renderStatus(status.body);
    if (inside.ok) renderInside(inside.body);
  } catch { /* try again on next poll */ }
}

function renderStatus(s) {
  document.getElementById('stat-inside').textContent = s.inside;
  document.getElementById('stat-peak').textContent = s.peak_today ? s.peak_today.label : 'No entries yet';
  document.getElementById('stat-peak-overall').textContent =
    s.peak_overall ? `Overall: ${s.peak_overall.label}` : '';
  document.getElementById('stat-open').textContent = s.opening_label;
  document.getElementById('stat-close').textContent = s.closing_label;
}

function renderInside(list) {
  const ul = document.getElementById('inside-list');
  ul.replaceChildren(...list.map((m) => el('li', {},
    el('span', { className: 'in-name', textContent: m.name }),
    el('span', { className: 'in-branch', textContent: [m.branch, m.role].filter(Boolean).join(' · ') }),
    el('span', { className: 'in-time', textContent: formatTime12(m.entry_time) }),
  )));
  document.getElementById('inside-empty').hidden = list.length > 0;
  document.getElementById('inside-count').textContent = list.length ? `(${list.length})` : '';
}

refresh();
setInterval(refresh, 5000);
