const ExcelJS = require('exceljs');
const { parseCsv } = require('./csv');
const { transaction } = require('./db');
const { normalizeRegNo, isValidRegNo } = require('./library');

const HEADER_ALIASES = {
  full_reg_no: ['full_reg_no', 'reg_no', 'enrollment_no', 'employee_no', 'enrollment', 'registration_no'],
  name: ['name', 'full_name'],
  branch: ['branch', 'department', 'course'],
  year: ['year', 'batch', 'session'],
  role: ['role', 'type'],
};

async function readRows(buffer, filename) {
  if (/\.xlsx$/i.test(filename)) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const sheet = wb.getWorksheet('Daily Logs') || wb.worksheets[0];
    if (!sheet) return [];
    const rows = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const cells = [];
      for (let c = 1; c <= sheet.columnCount; c++) cells.push(row.getCell(c).text ?? '');
      rows.push(cells);
    });
    return rows;
  }
  if (/\.csv$/i.test(filename)) return parseCsv(buffer.toString('utf8'));
  throw new Error('Unsupported file type. Upload a .xlsx or .csv file.');
}

function mapHeaders(headerRow) {
  const normalized = headerRow.map((h) => String(h).trim().toLowerCase().replace(/[\s.]+/g, '_'));
  const index = {};
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    index[field] = normalized.findIndex((h) => aliases.includes(h));
  }
  return index;
}

function normalizeRole(value) {
  const v = String(value || '').trim().toLowerCase();
  if (v === 'student') return 'Student';
  if (v === 'faculty') return 'Faculty';
  return null;
}

// Upserts members from an uploaded file. Bad or duplicate rows are skipped
// and reported back with their spreadsheet row number.
async function importMembers(db, buffer, filename) {
  const rows = await readRows(buffer, filename);
  if (rows.length === 0) throw new Error('The file is empty.');

  const index = mapHeaders(rows[0]);
  const missing = ['full_reg_no', 'name', 'role'].filter((f) => index[f] === -1);
  if (missing.length) throw new Error(`Missing required column(s): ${missing.join(', ')}`);

  const cell = (row, field) => (index[field] === -1 ? '' : String(row[index[field]] ?? '').trim());
  const seen = new Set();
  const valid = [];
  const skipped = [];

  rows.slice(1).forEach((row, i) => {
    const rowNo = i + 2;
    const regNo = normalizeRegNo(cell(row, 'full_reg_no'));
    const name = cell(row, 'name');
    const role = normalizeRole(cell(row, 'role'));

    if (!regNo || !isValidRegNo(regNo)) return skipped.push({ row: rowNo, reason: `Malformed number "${cell(row, 'full_reg_no')}"` });
    if (!name) return skipped.push({ row: rowNo, reason: 'Missing name' });
    if (!role) return skipped.push({ row: rowNo, reason: `Invalid role "${cell(row, 'role')}"` });
    if (seen.has(regNo)) return skipped.push({ row: rowNo, reason: `Duplicate number ${regNo}` });

    seen.add(regNo);
    valid.push({ regNo, name, branch: cell(row, 'branch') || null, year: cell(row, 'year') || null, role });
  });

  let added = 0;
  let updated = 0;
  transaction(db, () => {
    const exists = db.prepare('SELECT 1 FROM members WHERE full_reg_no = ?');
    const upsert = db.prepare(`
      INSERT INTO members (full_reg_no, name, branch, year, role) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(full_reg_no) DO UPDATE SET
        name = excluded.name, branch = excluded.branch, year = excluded.year, role = excluded.role
    `);
    for (const m of valid) {
      if (exists.get(m.regNo)) updated++; else added++;
      upsert.run(m.regNo, m.name, m.branch, m.year, m.role);
    }
  });

  return { added, updated, skipped };
}

module.exports = { importMembers };
