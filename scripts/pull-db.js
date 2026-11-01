// Copies the whole Turso database (members, logs, settings) into the local
// SQLite file used by start.bat. Run this when moving from the online test
// setup to the offline click-and-run setup.
//
//   TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... node scripts/pull-db.js [--force]

const fs = require('node:fs');
const path = require('node:path');
const { openDb } = require('../src/db');

const LOCAL_FILE = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'library.db');
const TABLES = {
  members: ['full_reg_no', 'name', 'branch', 'year', 'role'],
  library_logs: ['id', 'full_reg_no', 'entry_date', 'entry_time', 'exit_date', 'exit_time', 'exit_reason'],
  settings: ['key', 'value'],
};

async function main() {
  const url = process.env.TURSO_DATABASE_URL;
  if (!url) {
    console.error('Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN to the online database first.');
    process.exit(1);
  }
  if (fs.existsSync(LOCAL_FILE) && !process.argv.includes('--force')) {
    console.error(`${LOCAL_FILE} already exists. Re-run with --force to replace its contents.`);
    process.exit(1);
  }

  const remote = await openDb({ url, authToken: process.env.TURSO_AUTH_TOKEN });
  const local = await openDb({ file: LOCAL_FILE });

  // Children first when clearing, parents first when filling.
  const statements = [
    { sql: 'DELETE FROM library_logs' }, { sql: 'DELETE FROM members' }, { sql: 'DELETE FROM settings' },
  ];
  for (const [table, cols] of Object.entries(TABLES)) {
    const rows = await remote.all(`SELECT ${cols.join(', ')} FROM ${table}`);
    const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
    for (const r of rows) statements.push({ sql, args: cols.map((c) => r[c] ?? null) });
    console.log(`${table}: ${rows.length} row(s)`);
  }
  await local.batch(statements);

  await remote.close();
  await local.close();
  console.log(`Copied into ${LOCAL_FILE}. Double-click start.bat to run offline.`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
