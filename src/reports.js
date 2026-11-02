const ExcelJS = require('exceljs');
const { toCsv, escapeField } = require('./csv');
const { getSettings } = require('./db');
const { periodRange, eachDate, DAYS } = require('./periods');
const { hourLabel, hourRangeLabel } = require('./time');
const { AUTO_EXIT_REASON } = require('./library');

const AUTO_LOGOUT_NOTE = 'AUTO-LOGOUT';
const DETAIL_COLUMNS = [
  'role', 'full_reg_no', 'name', 'branch', 'year',
  'entry_date', 'entry_time', 'exit_date', 'exit_time', 'note',
];

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

function buildCsv(summary, rows, summaryOnly) {
  const head = SUMMARY_LINES.map(([label, key]) => `${escapeField(label)},${escapeField(summary[key])}`);
  if (summaryOnly) return `﻿${head.join('\r\n')}\r\n`;
  // toCsv adds its own BOM; the file gets one at the very start.
  return `﻿${head.join('\r\n')}\r\n\r\n${toCsv(DETAIL_COLUMNS, rows).replace(/^﻿/, '')}`;
}

// Spreadsheet text is stored as text, but a leading = + - @ is still
// prefixed so a copied value can't turn into a formula.
const safeText = (v) => (typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? `'${v}` : v);
const asDate = (s) => (s ? new Date(`${s}T00:00:00Z`) : null);

async function buildXlsx(summary, rows, summaryOnly) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Poornima University Library';

  const sum = wb.addWorksheet('Summary');
  sum.columns = [{ header: 'Item', key: 'item', width: 22 }, { header: 'Value', key: 'value', width: 44 }];
  sum.getRow(1).font = { bold: true };
  for (const [label, key] of SUMMARY_LINES) sum.addRow({ item: label, value: summary[key] });

  if (!summaryOnly) {
    const ws = wb.addWorksheet('Details', { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = DETAIL_COLUMNS.map((key) => ({ header: key, key }));
    ws.getRow(1).font = { bold: true };
    for (const r of rows) {
      const row = ws.addRow({
        role: r.role, full_reg_no: safeText(r.full_reg_no), name: safeText(r.name),
        branch: safeText(r.branch), year: safeText(r.year),
        entry_date: asDate(r.entry_date), entry_time: r.entry_time,
        exit_date: asDate(r.exit_date), exit_time: r.exit_time, note: r.note,
      });
      if (isAuto(r)) {
        row.getCell('note').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFDE2E1' } };
      }
    }
    ws.getColumn('entry_date').numFmt = 'yyyy-mm-dd';
    ws.getColumn('exit_date').numFmt = 'yyyy-mm-dd';
    const total = ws.addRow({ role: 'Total visits', full_reg_no: rows.length, note: `${summary.auto_logouts} ${AUTO_LOGOUT_NOTE}` });
    total.font = { bold: true };
    // Auto-width from the longest value in each column.
    ws.columns.forEach((col) => {
      let max = col.header.length;
      col.eachCell({ includeEmpty: false }, (cell) => {
        const v = cell.value instanceof Date ? 10 : String(cell.value ?? '').length;
        if (v > max) max = v;
      });
      col.width = Math.min(max + 2, 50);
    });
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// Builds a report file. Returns null when period/date are invalid.
async function buildReport(db, { period, date, format = 'xlsx', summaryOnly = false }) {
  const range = periodRange(period, date);
  if (!range || !['xlsx', 'csv'].includes(format)) return null;
  const rows = await visitsInRange(db, range.from, range.to);
  const summary = summarize(range, rows);
  const filename = `library_report_${period}_${range.from}_to_${range.to}.${format}`;
  const buffer = format === 'csv'
    ? Buffer.from(buildCsv(summary, rows, summaryOnly), 'utf8')
    : await buildXlsx(summary, rows, summaryOnly);
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
  AUTO_LOGOUT_NOTE, DETAIL_COLUMNS,
  visitsInRange, summarize, buildReport, summaryText, analytics,
};
