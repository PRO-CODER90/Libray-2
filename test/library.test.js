process.env.TZ = 'Asia/Kolkata';

const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const lib = require('../src/library');
const { parseCsv, toCsv } = require('../src/csv');
const { importMembers } = require('../src/importer');

const at = (s) => new Date(s);

function setup() {
  const db = openDb(':memory:');
  const ins = db.prepare('INSERT INTO members VALUES (?, ?, ?, ?, ?)');
  ins.run('2026/29917', 'Yuvraj Soni', 'B.Tech. (Mechanical)', 'FET2026-2027', 'Student');
  ins.run('20070', 'HERO', 'CSE', null, 'Faculty');
  return db;
}

test('entry, then manual exit with blank reason', () => {
  const db = setup();
  const r1 = lib.recordScan(db, ' 2026/29917 ', at('2026-08-19T10:42:15'));
  assert.equal(r1.message, 'Yuvraj Soni Entered');
  assert.equal(r1.type, 'success');
  assert.equal(lib.insideCount(db), 1);

  const r2 = lib.recordScan(db, '2026/29917', at('2026-08-19T11:00:00'));
  assert.equal(r2.message, 'Yuvraj Soni Exited');
  const row = db.prepare('SELECT * FROM library_logs').get();
  assert.equal(row.entry_time, '10:42:15');
  assert.equal(row.exit_time, '11:00:00');
  assert.equal(row.exit_reason, null);
});

test('unknown number creates no row', () => {
  const db = setup();
  const r = lib.recordScan(db, '99999', at('2026-08-19T10:00:00'));
  assert.equal(r.message, 'Student/Faculty is not found');
  assert.equal(r.status, 404);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM library_logs').get().n, 0);
});

test('empty input warns', () => {
  assert.equal(lib.recordScan(setup(), '   ').type, 'warning');
});

test('double scan within debounce window is ignored', () => {
  const db = setup();
  lib.recordScan(db, '20070', at('2026-08-19T10:00:00'));
  const r = lib.recordScan(db, '20070', at('2026-08-19T10:00:04'));
  assert.equal(r.action, 'ignored');
  assert.equal(lib.insideCount(db), 1);
});

test('entry outside library hours is rejected', () => {
  const db = setup();
  assert.equal(lib.recordScan(db, '20070', at('2026-08-19T17:30:00')).message, 'Library is closed');
  assert.equal(lib.recordScan(db, '20070', at('2026-08-19T07:00:00')).message, 'Library is closed');
});

test('auto-exit closes only open sessions and is idempotent', () => {
  const db = setup();
  lib.recordScan(db, '20070', at('2026-08-19T10:00:00'));
  lib.recordScan(db, '20070', at('2026-08-19T11:00:00')); // manual exit
  lib.recordScan(db, '2026/29917', at('2026-08-19T12:00:00'));

  assert.equal(lib.runAutoExit(db, at('2026-08-19T16:59:00')), 0);
  assert.equal(lib.runAutoExit(db, at('2026-08-19T17:00:05')), 1);
  assert.equal(lib.runAutoExit(db, at('2026-08-19T17:01:00')), 0);

  const rows = db.prepare('SELECT * FROM library_logs ORDER BY id').all();
  assert.equal(rows[0].exit_reason, null);
  assert.equal(rows[1].exit_reason, 'DO NOT LOGOUT');
  assert.equal(rows[1].exit_date, '2026-08-19');
  assert.equal(rows[1].exit_time, '17:00:00');
});

test('session left open from a previous day is closed, next scan is an entry', () => {
  const db = setup();
  lib.recordScan(db, '20070', at('2026-08-19T16:00:00'));
  const r = lib.recordScan(db, '20070', at('2026-08-20T09:00:00'));
  assert.equal(r.action, 'entry');
  const rows = db.prepare('SELECT * FROM library_logs ORDER BY id').all();
  assert.equal(rows[0].exit_date, '2026-08-19');
  assert.equal(rows[0].exit_reason, 'DO NOT LOGOUT');
  assert.equal(rows[1].exit_date, null);
});

test('peak hour picks the busiest hour, ties go earlier', () => {
  const counts = new Array(24).fill(0);
  counts[10] = 3; counts[12] = 3; counts[14] = 1;
  const p = lib.peakFromHistogram(counts);
  assert.equal(p.hour, 10);
  assert.equal(p.label, '10:00 – 11:00 AM');
  counts[12] = 4;
  assert.equal(lib.peakFromHistogram(counts).label, '12:00 – 1:00 PM');
  assert.equal(lib.peakFromHistogram(new Array(24).fill(0)), null);
});

test('CSV round trip with quoting and formula guard', () => {
  const csv = toCsv(['a', 'b'], [{ a: 'B.Tech. (Mechanical), CSE', b: '=1+1' }]);
  const rows = parseCsv(csv);
  assert.deepEqual(rows[0], ['a', 'b']);
  assert.deepEqual(rows[1], ['B.Tech. (Mechanical), CSE', "'=1+1"]);
});

test('import upserts members and reports bad rows', async () => {
  const db = setup();
  const csv = [
    'full_reg_no,name,branch,year,role',
    '2026/11111,Rahul Beniwal,B.Tech. (Mechanical),FET2026-2027,student',
    '2026/11111,Rahul Again,X,Y,Student',
    '20070,HERO Updated,CSE,,Faculty',
    ',No Number,,,Student',
    '2026/22222,Bad Role,,,Guest',
  ].join('\n');
  const r = await importMembers(db, Buffer.from(csv), 'members.csv');
  assert.equal(r.added, 1);
  assert.equal(r.updated, 1);
  assert.deepEqual(r.skipped.map((s) => s.row), [3, 5, 6]);
  assert.equal(db.prepare("SELECT name FROM members WHERE full_reg_no='20070'").get().name, 'HERO Updated');
});

test('import reads the Daily Logs sheet layout with a blank column', async () => {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('Daily Logs');
  sheet.addRow(['full_reg_no', 'name', 'branch', 'year', null, 'entry_date', 'entry_time', 'exit_date', 'exit_time', 'role']);
  sheet.addRow(['2026/29917', 'Yuvraj Soni', 'B.Tech. (Mechanical)', 'FET2026-2027', null, null, null, null, null, 'Student']);
  sheet.addRow(['2026/29313', 'Rahul Beniwal', 'B.Tech. (Mechanical)', 'FET2026-2027', null, null, null, null, null, 'Student']);

  const db = openDb(':memory:');
  const r = await importMembers(db, Buffer.from(await wb.xlsx.writeBuffer()), 'daily_logs_2026-08-19.xlsx');
  assert.deepEqual(r, { added: 2, updated: 0, skipped: [] });
  const m = db.prepare("SELECT * FROM members WHERE full_reg_no = '2026/29313'").get();
  assert.equal(m.name, 'Rahul Beniwal');
  assert.equal(m.year, 'FET2026-2027');
  assert.equal(m.role, 'Student');
});
