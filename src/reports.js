const ExcelJS = require('exceljs');
const { escapeField } = require('./csv');
const { getSettings } = require('./db');
const { periodRange, eachDate, DAYS } = require('./periods');
const { hourLabel, hourRangeLabel } = require('./time');
const { AUTO_EXIT_REASON } = require('./library');

const AUTO_LOGOUT_NOTE = 'AUTO-LOGOUT';

// The library's own "Daily Logs" sheet: the same layout the staff upload
// (daily_logs_YYYY-MM-DD.xlsx), including the blank fifth column. Every
// report file uses exactly this layout and nothing else.
const SHEET_NAME = 'Daily Logs';
const TEMPLATE = [
  { header: 'full_reg_no', key: 'full_reg_no', width: 16.66 },
  { header: 'name', key: 'name', width: 24.33 },
  { header: 'branch', key: 'branch', width: 48.55 },
  { header: 'year', key: 'year', width: 14.55 },
  { header: '', key: null, width: 18 },
  { header: 'entry_date', key: 'entry_date', width: 17.78 },
  { header: 'entry_time', key: 'entry_time', width: 15 },
  { header: 'exit_date', key: 'exit_date', width: 14.66 },
  { header: 'exit_time', key: 'exit_time', width: 13.66 },
  { header: 'role', key: 'role', width: 9 },
  { header: 'Reason', key: 'note', width: 16 },
];
const DETAIL_COLUMNS = TEMPLATE.map((c) => c.header);

// Every visit whose entry falls in from..to, oldest first.
async function visitsInRange(db, from, to) {
  const rows = await db.all(`
    SELECT m.role, l.full_reg_no, m.name, m.branch, m.year,
           l.entry_date, l.entry_time, l.exit_date, l.exit_time, l.exit_reason
    FROM library_logs l JOIN members m ON m.full_reg_no = l.full_reg_no
    WHERE l.entry_date BETWEEN ? AND ?
    ORDER BY l.entry_date, l.entry_time, l.id
  `, [from, to]);
  // The note is AUTO-LOGOUT only when the system closed the visit; manual
  // exits and people still inside get a blank note.
  return rows.map((r) => ({ ...r, note: r.exit_reason === AUTO_EXIT_REASON ? AUTO_LOGOUT_NOTE : '' }));
}

const isAuto = (r) => r.note === AUTO_LOGOUT_NOTE;
const minutesBetween = (r) =>
  (new Date(`${r.exit_date}T${r.exit_time}`) - new Date(`${r.entry_date}T${r.entry_time}`)) / 60000;

function summarize(range, rows) {
  const exits = rows.filter((r) => r.exit_date);
  const auto = exits.filter(isAuto);
  const manual = exits.filter((r) => !isAuto(r));
  const stays = manual.map(minutesBetween).filter((m) => m >= 0);
  return {
    period: range.label,
    from: range.from,
    to: range.to,
    total_entries: rows.length,
    total_exits: exits.length,
    manual_exits: manual.length,
    auto_logouts: auto.length,
    still_inside: rows.length - exits.length,
    unique_visitors: new Set(rows.map((r) => r.full_reg_no)).size,
    students: rows.filter((r) => r.role === 'Student').length,
    faculty: rows.filter((r) => r.role === 'Faculty').length,
    avg_stay_minutes: stays.length ? Math.round(stays.reduce((a, b) => a + b, 0) / stays.length) : null,
  };
}

const SUMMARY_LINES = [
  ['Period', 'period'],
  ['Total entries', 'total_entries'],
  ['Total exits', 'total_exits'],
  ['Manual exits', 'manual_exits'],
  ['Auto-logouts', 'auto_logouts'],
  ['Still inside', 'still_inside'],
  ['Unique visitors', 'unique_visitors'],
  ['Students', 'students'],
  ['Faculty', 'faculty'],
];

// A leading = + - @ is prefixed so a value can't turn into a formula.
const safeText = (v) => (typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? `'${v}` : v);
const cellValues = (r) => TEMPLATE.map((c) => (c.key ? safeText(r[c.key] ?? '') : ''));

function buildCsv(rows) {
  const lines = [TEMPLATE.map((c) => escapeField(c.header)).join(',')];
  for (const r of rows) lines.push(cellValues(r).map((v) => escapeField(v)).join(','));
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

async function buildXlsx(rows) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Poornima University Library';
  const ws = wb.addWorksheet(SHEET_NAME);
  ws.columns = TEMPLATE.map((c) => ({ width: c.width }));
  const head = ws.addRow(TEMPLATE.map((c) => c.header || null));
  const thin = { style: 'thin' };
  head.eachCell({ includeEmpty: true }, (cell, col) => {
    cell.font = { bold: true, size: 11, name: 'Calibri', family: 2 };
    if (col <= 10) {
      cell.alignment = { horizontal: 'center', vertical: 'top' };
      cell.border = { left: thin, right: thin, top: thin, bottom: thin };
    }
  });
  for (const r of rows) ws.addRow(cellValues(r).map((v) => (v === '' ? null : v)));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// Builds a report file in the Daily Logs layout. Returns null when
// period/date are invalid.
async function buildReport(db, { period, date, format = 'xlsx' }) {
  const range = periodRange(period, date);
  if (!range || !['xlsx', 'csv'].includes(format)) return null;
  const rows = await visitsInRange(db, range.from, range.to);
  const summary = summarize(range, rows);
  const filename = range.from === range.to
    ? `daily_logs_${range.from}.${format}`
    : `daily_logs_${range.from}_to_${range.to}.${format}`;
  const buffer = format === 'csv' ? Buffer.from(buildCsv(rows), 'utf8') : await buildXlsx(rows);
  const contentType = format === 'csv'
    ? 'text/csv; charset=utf-8'
    : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  return { range, summary, filename, contentType, buffer };
}

function summaryText(summary) {
  return SUMMARY_LINES.map(([label, key]) => `${label}: ${summary[key]}`).join('\n');
}

// Data for the Entry Analytics charts.
async function analytics(db, period, date) {
  const range = periodRange(period, date);
  if (!range) return null;
  const rows = await visitsInRange(db, range.from, range.to);
  const summary = summarize(range, rows);

  let buckets;
  let keyOf;
  if (period === 'day') {
    const settings = await getSettings(db);
    const used = rows.map((r) => Number(r.entry_time.slice(0, 2)));
    const lo = Math.min(Number(settings.opening_time.slice(0, 2)), ...used);
    const hi = Math.max(Number(settings.closing_time.slice(0, 2)) - 1, ...used);
    buckets = [];
    for (let h = lo; h <= hi; h++) buckets.push({ key: h, label: hourLabel(h).replace(':00', ''), range: hourRangeLabel(h) });
    keyOf = (r) => Number(r.entry_time.slice(0, 2));
  } else {
    buckets = eachDate(range.from, range.to).map((d) => {
      const day = new Date(`${d}T00:00:00`);
      return { key: d, label: period === 'week' ? DAYS[day.getDay()] : String(day.getDate()), range: d };
    });
    keyOf = (r) => r.entry_date;
  }

  const byKey = new Map(buckets.map((b) => [b.key, { label: b.label, range: b.range, entries: 0, manual: 0, auto: 0, inside: 0 }]));
  for (const r of rows) {
    const b = byKey.get(keyOf(r));
    if (!b) continue;
    b.entries++;
    if (!r.exit_date) b.inside++;
    else if (isAuto(r)) b.auto++;
    else b.manual++;
  }
  const series = [...byKey.values()];
  const best = (list, val) => list.reduce((m, x) => (val(x) > val(m) ? x : m), list[0]);

  const peakBucket = series.length && best(series, (s) => s.entries);
  const hours = new Array(24).fill(0);
  for (const r of rows) hours[Number(r.entry_time.slice(0, 2))]++;
  const peakHour = hours.indexOf(Math.max(...hours));
  const days = new Map();
  for (const r of rows) days.set(r.entry_date, (days.get(r.entry_date) || 0) + 1);
  const busiest = [...days.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];

  const branches = new Map();
  for (const r of rows) {
    const k = r.branch || 'Not set';
    branches.set(k, (branches.get(k) || 0) + 1);
  }

  return {
    range,
    totals: {
      entries: summary.total_entries,
      unique_visitors: summary.unique_visitors,
      auto_logouts: summary.auto_logouts,
      manual_exits: summary.manual_exits,
      still_inside: summary.still_inside,
      avg_stay_minutes: summary.avg_stay_minutes,
    },
    series,
    by_role: { Student: summary.students, Faculty: summary.faculty },
    by_branch: [...branches.entries()]
      .map(([branch, entries]) => ({ branch, entries }))
      .sort((a, b) => b.entries - a.entries || a.branch.localeCompare(b.branch))
      .slice(0, 10),
    peak: peakBucket && peakBucket.entries ? { label: peakBucket.range || peakBucket.label, entries: peakBucket.entries } : null,
    peak_hour: rows.length ? { label: hourRangeLabel(peakHour), entries: hours[peakHour] } : null,
    busiest_day: busiest ? { date: busiest[0], entries: busiest[1] } : null,
  };
}

module.exports = {
  AUTO_LOGOUT_NOTE, DETAIL_COLUMNS, SHEET_NAME,
  visitsInRange, summarize, buildReport, summaryText, analytics,
};
