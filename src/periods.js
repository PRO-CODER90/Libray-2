const { dateStr, isValidDate } = require('./time');

const PERIODS = ['day', 'week', 'month'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const parse = (s) => new Date(`${s}T00:00:00`);
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const nice = (d) => `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;

// The date range a period covers: the day itself, the Monday–Sunday week
// containing the date, or the calendar month. Returns null for bad input.
function periodRange(period, date) {
  if (!PERIODS.includes(period) || !isValidDate(date)) return null;
  const d = parse(date);
  if (period === 'day') {
    return { period, from: date, to: date, label: `${DAYS[d.getDay()]} ${nice(d)}` };
  }
  if (period === 'week') {
    const monday = addDays(d, -((d.getDay() + 6) % 7));
    const sunday = addDays(monday, 6);
    return {
      period, from: dateStr(monday), to: dateStr(sunday),
      label: `Week ${DAYS[1]} ${nice(monday)} – ${DAYS[0]} ${nice(sunday)}`,
    };
  }
  const first = new Date(d.getFullYear(), d.getMonth(), 1);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  return {
    period, from: dateStr(first), to: dateStr(last),
    label: `${MONTHS[d.getMonth()]} ${d.getFullYear()}`,
  };
}

// Every date from..to inclusive, as YYYY-MM-DD.
function eachDate(from, to) {
  const out = [];
  for (let d = parse(from); dateStr(d) <= to; d = addDays(d, 1)) out.push(dateStr(d));
  return out;
}

module.exports = { PERIODS, DAYS, periodRange, eachDate };
