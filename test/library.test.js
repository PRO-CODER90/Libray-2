process.env.TZ = 'Asia/Kolkata';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('exceljs');
const { openDb } = require('../src/db');
const lib = require('../src/library');
const { parseCsv, toCsv } = require('../src/csv');
const { importMembers } = require('../src/importer');

const at = (s) => new Date(s);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'libtest-'));
let fileNo = 0;

// Every database test runs against both backends: local node:sqlite, and
// @libsql/client (what Turso uses) pointed at a local file.
const BACKENDS = {
  sqlite: () => openDb({ file: ':memory:' }),
  libsql: () => openDb({ url: `file:${path.join(tmp, `t${fileNo++}.db`)}` }),
};

async function setup(kind) {
  const db = await BACKENDS[kind]();
  const ins = 'INSERT INTO members VALUES (?, ?, ?, ?, ?)';
  await db.run(ins, ['2026/29917', 'Yuvraj Soni', 'B.Tech. (Mechanical)', 'FET2026-2027', 'Student']);
  await db.run(ins, ['20070', 'HERO', 'CSE', null, 'Faculty']);
  return db;
}

const logCount = async (db) => Number((await db.get('SELECT COUNT(*) AS n FROM library_logs')).n);
const allLogs = (db) => db.all('SELECT * FROM library_logs ORDER BY id');

for (const kind of Object.keys(BACKENDS)) {
  test(`${kind}: entry, then manual exit with blank reason`, async () => {
    const db = await setup(kind);
    const r1 = await lib.recordScan(db, ' 2026/29917 ', at('2026-08-19T10:42:15'));
    assert.equal(r1.message, 'Yuvraj Soni Entered');
    assert.equal(r1.type, 'success');
    assert.equal(await lib.insideCount(db), 1);

    const r2 = await lib.recordScan(db, '2026/29917', at('2026-08-19T11:00:00'));
    assert.equal(r2.message, 'Yuvraj Soni Exited');
    const [row] = await allLogs(db);
    assert.equal(row.entry_date, '2026-08-19');
    assert.equal(row.entry_time, '10:42:15');
    assert.equal(row.exit_time, '11:00:00');
    assert.equal(row.exit_reason, null);
  });

  test(`${kind}: unknown number creates no row`, async () => {
    const db = await setup(kind);
    const r = await lib.recordScan(db, '99999', at('2026-08-19T10:00:00'));
    assert.equal(r.message, 'Student/Faculty is not found');
    assert.equal(r.status, 404);
    assert.equal(await logCount(db), 0);
  });

  test(`${kind}: empty input warns`, async () => {
    assert.equal((await lib.recordScan(await setup(kind), '   ')).type, 'warning');
  });

  test(`${kind}: double scan within debounce window is ignored`, async () => {
    const db = await setup(kind);
    await lib.recordScan(db, '20070', at('2026-08-19T10:00:00'));
    const r = await lib.recordScan(db, '20070', at('2026-08-19T10:00:04'));
    assert.equal(r.action, 'ignored');
    assert.equal(await lib.insideCount(db), 1);
  });

  test(`${kind}: entry outside library hours is rejected`, async () => {
    const db = await setup(kind);
    assert.equal((await lib.recordScan(db, '20070', at('2026-08-19T17:30:00'))).message, 'Library is closed');
    assert.equal((await lib.recordScan(db, '20070', at('2026-08-19T07:00:00'))).message, 'Library is closed');
  });

  test(`${kind}: auto-exit closes only open sessions and is idempotent`, async () => {
    const db = await setup(kind);
    await lib.recordScan(db, '20070', at('2026-08-19T10:00:00'));
    await lib.recordScan(db, '20070', at('2026-08-19T11:00:00')); // manual exit
    await lib.recordScan(db, '2026/29917', at('2026-08-19T12:00:00'));

    assert.equal(await lib.runAutoExit(db, at('2026-08-19T16:59:00')), 0);
    assert.equal(await lib.runAutoExit(db, at('2026-08-19T17:00:05')), 1);
    assert.equal(await lib.runAutoExit(db, at('2026-08-19T17:01:00')), 0);

    const rows = await allLogs(db);
    assert.equal(rows[0].exit_reason, null);
    assert.equal(rows[1].exit_reason, 'DO NOT LOGOUT');
    assert.equal(rows[1].exit_date, '2026-08-19');
    assert.equal(rows[1].exit_time, '17:00:00');
  });

  test(`${kind}: session left open from a previous day is closed, next scan is an entry`, async () => {
    const db = await setup(kind);
    await lib.recordScan(db, '20070', at('2026-08-19T16:00:00'));
    const r = await lib.recordScan(db, '20070', at('2026-08-20T09:00:00'));
    assert.equal(r.action, 'entry');
    const rows = await allLogs(db);
    assert.equal(rows[0].exit_date, '2026-08-19');
    assert.equal(rows[0].exit_reason, 'DO NOT LOGOUT');
    assert.equal(rows[1].exit_date, null);
  });

  test(`${kind}: concurrent scans for different members both record`, async () => {
    const db = await setup(kind);
    const now = at('2026-08-19T10:00:00');
    const [a, b] = await Promise.all([
      lib.recordScan(db, '20070', now),
      lib.recordScan(db, '2026/29917', now),
    ]);
    assert.equal(a.action, 'entry');
    assert.equal(b.action, 'entry');
    assert.equal(await lib.insideCount(db), 2);
  });

  test(`${kind}: peak info from logged entries`, async () => {
    const db = await setup(kind);
    await lib.recordScan(db, '20070', at('2026-08-19T12:10:00'));
    await lib.recordScan(db, '2026/29917', at('2026-08-19T12:40:00'));
    const info = await lib.peakInfo(db, '2026-08-19');
    assert.equal(info.peak.label, '12:00 – 1:00 PM');
    assert.equal(info.histogram[12], 2);
  });

  test(`${kind}: import upserts members and reports bad rows`, async () => {
    const db = await setup(kind);
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
    const m = await db.get("SELECT name FROM members WHERE full_reg_no = '20070'");
    assert.equal(m.name, 'HERO Updated');
  });

  test(`${kind}: import reads the Daily Logs sheet layout with a blank column`, async () => {
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet('Daily Logs');
    sheet.addRow(['full_reg_no', 'name', 'branch', 'year', null, 'entry_date', 'entry_time', 'exit_date', 'exit_time', 'role']);
    sheet.addRow(['2026/29917', 'Yuvraj Soni', 'B.Tech. (Mechanical)', 'FET2026-2027', null, null, null, null, null, 'Student']);
    sheet.addRow(['2026/29313', 'Rahul Beniwal', 'B.Tech. (Mechanical)', 'FET2026-2027', null, null, null, null, null, 'Student']);

    const db = await BACKENDS[kind]();
    const r = await importMembers(db, Buffer.from(await wb.xlsx.writeBuffer()), 'daily_logs_2026-08-19.xlsx');
    assert.deepEqual(r, { added: 2, updated: 0, skipped: [] });
    const m = await db.get("SELECT * FROM members WHERE full_reg_no = '2026/29313'");
    assert.equal(m.name, 'Rahul Beniwal');
    assert.equal(m.year, 'FET2026-2027');
    assert.equal(m.role, 'Student');
  });
}

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
