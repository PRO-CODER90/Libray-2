const form = document.getElementById('entry-form');
const input = document.getElementById('reg-no');
const goBtn = document.getElementById('go');
const backdrop = document.getElementById('toast-backdrop');
const toast = document.getElementById('toast');

// ---- Partner logo: show the block only if the image exists ----

const partnerLogo = document.getElementById('partner-logo');
partnerLogo.addEventListener('load', () => { partnerLogo.closest('.partner').hidden = false; });
if (partnerLogo.complete && partnerLogo.naturalWidth) partnerLogo.closest('.partner').hidden = false;

// ---- Live clock: IST, offset to the server clock, rolls over at midnight ----

let clockOffset = 0; // server time minus browser time, in ms

const dateFmt = new Intl.DateTimeFormat('en-IN', {
  timeZone: TZ, weekday: 'long', day: 'numeric', month: 'short', year: 'numeric',
});
const timeFmt = new Intl.DateTimeFormat('en-IN', {
  timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true,
});

function renderClock() {
  const now = new Date(Date.now() + clockOffset);
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
function showToast(message, kind) {
  toast.textContent = message;
  toast.className = `toast toast-${kind}`;
  backdrop.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { backdrop.hidden = true; }, 3000);
}
backdrop.addEventListener('click', () => { backdrop.hidden = true; input.focus(); });

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
    showToast(body.message || 'Something went wrong', body.action === 'exit' ? 'exit' : body.type || 'error');
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
    const sent = Date.now();
    const [status, inside] = await Promise.all([api('/api/status'), api('/api/inside')]);
    if (status.ok) {
      const latency = (Date.now() - sent) / 2;
      clockOffset = new Date(status.body.server_time).getTime() + latency - Date.now();
      renderStatus(status.body);
    }
    if (inside.ok) renderInside(inside.body);
  } catch { /* try again on next poll */ }
}

function renderStatus(s) {
  document.getElementById('stat-inside').textContent = s.inside;
  document.getElementById('stat-peak').textContent = s.peak_today ? s.peak_today.label : 'No entries yet';
  document.getElementById('stat-open').textContent = s.opening_label;
  document.getElementById('stat-close').textContent = s.closing_label;
}

function renderInside(list) {
  document.getElementById('inside-list').replaceChildren(...list.map((m) => el('li', {
    title: [m.branch, m.role].filter(Boolean).join(' · '),
  },
  el('span', { textContent: m.name }),
  el('span', { className: 'chip-time', textContent: ` · ${formatTime12(m.entry_time)}` }),
  )));
  document.getElementById('inside-empty').hidden = list.length > 0;
}

refresh();
setInterval(refresh, 5000);
