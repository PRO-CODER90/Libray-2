process.env.TZ = 'Asia/Kolkata';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('exceljs');
const { openDb } = require('../src/db');
const lib = require('../src/library');
const { periodRange } = require('../src/periods');
const { buildReport, analytics, visitsInRange } = require('../src/reports');
const { importMembers } = require('../src/importer');
const { createBackups } = require('../src/backup');
const { createApp } = require('../src/app');
const { passwordProblems, MAX_FAILS } = require('../src/auth');
const { cleanEmail } = require('../src/mailer');

const at = (s) => new Date(s);

async function seeded() {
  const db = await openDb({ file: ':memory:' });
  await db.run('INSERT INTO members VALUES (?, ?, ?, ?, ?)', ['2026/1', 'Asha', 'CSE', 'FET2026', 'Student']);
  await db.run('INSERT INTO members VALUES (?, ?, ?, ?, ?)', ['F1', '=HYPERLINK("x")', 'Physics', null, 'Faculty']);
  await lib.recordScan(db, '2026/1', at('2026-10-28T10:00:00'));
  await lib.recordScan(db, '2026/1', at('2026-10-28T11:30:00')); // manual exit
  await lib.recordScan(db, 'F1', at('2026-10-28T12:15:00'));
  await lib.runAutoExit(db, at('2026-10-28T17:05:00')); // F1 auto-exited
  await lib.recordScan(db, '2026/1', at('2026-11-02T09:10:00')); // still inside
  return db;
}

test('period ranges: day, Monday–Sunday week, calendar month', () => {
  assert.deepEqual(
    [periodRange('day', '2026-11-02').from, periodRange('day', '2026-11-02').to],
    ['2026-11-02', '2026-11-02']);
  const w = periodRange('week', '2026-10-29');
  assert.equal(w.from, '2026-10-26');
  assert.equal(w.to, '2026-11-01');
  assert.equal(periodRange('week', '2026-11-01').from, '2026-10-26');
  const m = periodRange('month', '2024-02-10');
  assert.equal(m.from, '2024-02-01');
  assert.equal(m.to, '2024-02-29');
  assert.equal(periodRange('year', '2026-01-01'), null);
  assert.equal(periodRange('day', '2026-13-01'), null);
});

const LAYOUT = ['full_reg_no', 'name', 'branch', 'year', '', 'entry_date', 'entry_time', 'exit_date', 'exit_time', 'role', 'Reason'];

test('report summary counts and DO NOT LOGOUT only on system-closed visits', async () => {
  const db = await seeded();
  const r = await buildReport(db, { period: 'month', date: '2026-10-15', format: 'csv' });
  assert.equal(r.summary.total_entries, 2);
  assert.equal(r.summary.total_exits, 2);
  assert.equal(r.summary.manual_exits, 1);
  assert.equal(r.summary.auto_logouts, 1);
  assert.equal(r.summary.still_inside, 0);
  assert.equal(r.summary.unique_visitors, 2);
  assert.equal(r.filename, 'daily_logs_2026-10-01_to_2026-10-31.csv');

  const rows = await visitsInRange(db, '2026-10-01', '2026-11-30');
  const notes = Object.fromEntries(rows.map((v) => [`${v.full_reg_no}@${v.entry_date}`, v.note]));
  assert.equal(notes['2026/1@2026-10-28'], '');
  assert.equal(notes['F1@2026-10-28'], 'DO NOT LOGOUT');
  assert.equal(notes['2026/1@2026-11-02'], '');

  const lines = r.buffer.toString('utf8').replace(/^﻿/, '').trim().split('\r\n');
  assert.equal(lines[0], LAYOUT.join(','));
  assert.equal(lines[1], '2026/1,Asha,CSE,FET2026,,2026-10-28,10:00:00,2026-10-28,11:30:00,Student,');
  assert.match(lines[2], /^F1,"'=HYPERLINK\(""x""\)",Physics,,,2026-10-28,12:15:00,2026-10-28,17:00:00,Faculty,DO NOT LOGOUT$/);
});

test('xlsx report is the Daily Logs sheet in the uploaded layout', async () => {
  const db = await seeded();
  const r = await buildReport(db, { period: 'day', date: '2026-10-28', format: 'xlsx' });
  assert.equal(r.filename, 'daily_logs_2026-10-28.xlsx');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(r.buffer);
  assert.deepEqual(wb.worksheets.map((w) => w.name), ['Daily Logs']);
  const ws = wb.getWorksheet('Daily Logs');
  const header = [];
  for (let c = 1; c <= 11; c++) header.push(ws.getRow(1).getCell(c).value ?? '');
  assert.deepEqual(header, LAYOUT);
  assert.equal(ws.getRow(1).getCell(1).font.bold, true);
  assert.equal(ws.getRow(3).getCell(9).value, '17:00:00');
  assert.equal(ws.getRow(3).getCell(11).value, 'DO NOT LOGOUT');
  assert.equal(ws.getRow(2).getCell(11).value, null);
  assert.equal(ws.rowCount, 3);
});

test('the report layout can be uploaded back as a member list', async () => {
  const db = await seeded();
  const r = await buildReport(db, { period: 'month', date: '2026-10-01', format: 'xlsx' });
  const fresh = await openDb({ file: ':memory:' });
  const result = await importMembers(fresh, r.buffer, r.filename);
  assert.equal(result.added, 2);
});

test('analytics buckets by weekday and counts roles and auto-logouts', async () => {
  const db = await seeded();
  const a = await analytics(db, 'week', '2026-10-28');
  assert.deepEqual(a.series.map((s) => s.label), ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
  assert.equal(a.series[2].entries, 2);
  assert.equal(a.series[2].auto, 1);
  assert.deepEqual(a.by_role, { Student: 1, Faculty: 1 });
  assert.equal(a.busiest_day.date, '2026-10-28');
});

test('backups: verified copy, 30-day pruning, restore with safety backup', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'libbk-'));
  const db = await openDb({ file: path.join(dir, 'library.db') });
  await db.run('INSERT INTO members VALUES (?, ?, ?, ?, ?)', ['A1', 'Asha', null, null, 'Student']);
  await lib.recordScan(db, 'A1', at('2026-10-01T10:00:00'));
  const backups = createBackups(db, { dir: path.join(dir, 'backups'), keepDays: 30 });

  const old = await backups.create(at('2026-09-01T18:00:00'));
  const first = await backups.create(at('2026-10-01T18:00:00'));
  assert.equal(first.rows_logs, 1);
  // A backup on 2 Nov drops anything older than 3 Oct (30 days).
  await backups.create(at('2026-11-02T18:00:00'));
  const names = (await backups.list()).map((b) => b.name);
  assert.ok(!names.includes(old.name));
  assert.ok(!names.includes(first.name));
  assert.equal(names.length, 1);

  await db.run('DELETE FROM library_logs');
  const result = await backups.restore(names[0]);
  assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM library_logs')).n), 1);
  assert.ok(result.safety_backup);
});

test('password policy and email cleaning', () => {
  assert.deepEqual(passwordProblems('Library#2026-PU', 'PU01A'), []);
  assert.ok(passwordProblems('short1!').length);
  assert.ok(passwordProblems('NoNumbersHere!!').length);
  assert.ok(passwordProblems('pu01a-Secret#99', 'PU01A').length);
  assert.equal(cleanEmail(' Lib@Uni.edu '), 'lib@uni.edu');
  assert.equal(cleanEmail('a@b.com\r\nBcc: x@y.com'), null);
  assert.equal(cleanEmail('not-an-email'), null);
});

test('admin API: CSRF header, lockout after repeated failures, no-store', async () => {
  const app = createApp(openDb({ file: ':memory:' }), { adminUser: 'PU01A', adminPassword: 'test-pass' });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body, headers = { 'x-requested-with': 'XMLHttpRequest' }) => fetch(`${base}/api/admin/login`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  try {
    assert.equal((await post({ username: 'PU01A', password: 'test-pass' }, {})).status, 403);
    const ok = await post({ username: 'PU01A', password: 'test-pass' });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('cache-control'), 'no-store');
    for (let i = 0; i < MAX_FAILS; i++) await post({ username: 'PU01A', password: 'nope' });
    assert.equal((await post({ username: 'PU01A', password: 'test-pass' })).status, 429);
    const home = await fetch(`${base}/api/status`);
    assert.match(home.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    const inside = await (await fetch(`${base}/api/inside`)).json();
    assert.deepEqual(inside, []);
  } finally {
    server.close();
  }
});
