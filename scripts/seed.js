// Loads members from an .xlsx/.csv file into the SQLite database, optionally
// adding sample visits so peak time, auto-exit and CSV export can be tested.
//
//   node scripts/seed.js <file> [--demo-logs YYYY-MM-DD] [--reset]

process.env.TZ = 'Asia/Kolkata';

const fs = require('node:fs');
const path = require('node:path');
const { openDb, dbOptionsFromEnv, getSettings } = require('../src/db');
const { importMembers } = require('../src/importer');
const { isValidDate, toFullTime } = require('../src/time');

const DB_OPTIONS = dbOptionsFromEnv(path.join(__dirname, '..', 'data', 'library.db'));

function parseArgs(argv) {
  const args = { file: null, demoDate: null, reset: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--demo-logs') args.demoDate = argv[++i];
    else if (argv[i] === '--reset') args.reset = true;
    else args.file = argv[i];
  }
  return args;
}

const pad = (n) => String(n).padStart(2, '0');
const toTime = (secs) => `${pad(Math.floor(secs / 3600))}:${pad(Math.floor(secs / 60) % 60)}:${pad(secs % 60)}`;
const toSecs = (t) => t.split(':').reduce((acc, v) => acc * 60 + Number(v), 0);

// One or two visits per member, spread across opening hours with a midday
// rush. Roughly one in five visits is left open so auto-exit has work to do.
async function addDemoLogs(db, date) {
  const settings = await getSettings(db);
  const open = toSecs(toFullTime(settings.opening_time));
  const close = toSecs(toFullTime(settings.closing_time));
  const members = await db.all('SELECT full_reg_no FROM members');
  const insert = `
    INSERT INTO library_logs (full_reg_no, entry_date, entry_time, exit_date, exit_time)
    VALUES (?, ?, ?, ?, ?)`;
  const statements = [];
  const rand = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo));
  for (const { full_reg_no } of members) {
    let cursor = open;
    const visits = Math.random() < 0.3 ? 2 : 1;
    for (let v = 0; v < visits && cursor < close - 1800; v++) {
      const midday = Math.random() < 0.5;
      const lo = midday ? Math.max(cursor, open + (close - open) * 0.4) : cursor;
      const entry = rand(lo, Math.min(close - 1800, lo + (close - open) * 0.3));
      const stay = rand(15 * 60, 3 * 3600);
      const leftOpen = v === visits - 1 && Math.random() < 0.2;
      const exit = Math.min(entry + stay, close - 60);
      statements.push({ sql: insert, args: [full_reg_no, date, toTime(entry),
        leftOpen ? null : date, leftOpen ? null : toTime(exit)] });
      cursor = exit + 600;
    }
  }
  if (statements.length) await db.batch(statements);
  return statements.length;
}

async function main() {
  const { file, demoDate, reset } = parseArgs(process.argv.slice(2));
  if (!file) {
    console.error('Usage: node scripts/seed.js <members.xlsx|csv> [--demo-logs YYYY-MM-DD] [--reset]');
    process.exit(1);
  }
  if (demoDate && !isValidDate(demoDate)) {
    console.error(`Invalid --demo-logs date "${demoDate}", expected YYYY-MM-DD`);
    process.exit(1);
  }

  const db = await openDb(DB_OPTIONS);
  if (reset) {
    await db.batch([{ sql: 'DELETE FROM library_logs' }, { sql: 'DELETE FROM members' }]);
    console.log('Cleared members and logs.');
  }

  const result = await importMembers(db, fs.readFileSync(file), path.basename(file));
  console.log(`Members: added ${result.added}, updated ${result.updated}, skipped ${result.skipped.length}`);
  for (const s of result.skipped) console.log(`  row ${s.row}: ${s.reason}`);

  if (demoDate) console.log(`Demo visits added for ${demoDate}: ${await addDemoLogs(db, demoDate)}`);
  console.log(`Database: ${DB_OPTIONS.url || DB_OPTIONS.file}`);
  await db.close();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
