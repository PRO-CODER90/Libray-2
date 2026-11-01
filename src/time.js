// All timestamps come from the server clock. server.js sets TZ=Asia/Kolkata
// before anything else runs, so the local getters below are IST.

const pad = (n) => String(n).padStart(2, '0');

function dateStr(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function timeStr(d = new Date()) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// "HH:MM" or "HH:MM:SS" -> "HH:MM:SS"
function toFullTime(t) {
  return t.length === 5 ? `${t}:00` : t;
}

function isValidHHMM(t) {
  return typeof t === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(t);
}

function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00`);
  return !Number.isNaN(d.getTime()) && dateStr(d) === s;
}

// 13 -> "1:00 PM"
function hourLabel(h) {
  const suffix = h < 12 ? 'AM' : 'PM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:00 ${suffix}`;
}

// 12 -> "12:00 – 1:00 PM"
function hourRangeLabel(h) {
  const start = hourLabel(h);
  const end = hourLabel((h + 1) % 24);
  const sameHalf = start.slice(-2) === end.slice(-2);
  return `${sameHalf ? start.slice(0, -3) : start} – ${end}`;
}

// "17:00" -> "5:00 PM"
function formatClock(t) {
  const [h, m] = t.split(':').map(Number);
  const suffix = h < 12 ? 'AM' : 'PM';
  return `${h % 12 === 0 ? 12 : h % 12}:${pad(m)} ${suffix}`;
}

module.exports = {
  dateStr, timeStr, toFullTime, isValidHHMM, isValidDate,
  hourLabel, hourRangeLabel, formatClock,
};
