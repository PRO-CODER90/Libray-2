// Must be set before any Date is created.
process.env.TZ = 'Asia/Kolkata';

const path = require('node:path');
const { openDb, dbOptionsFromEnv } = require('./src/db');
const { createApp, appOptionsFromEnv } = require('./src/app');
const { createBackups } = require('./src/backup');
const { runDailyJobs } = require('./src/jobs');

// Local settings such as ADMIN_PASSWORD live in .env, which is not committed.
try {
  process.loadEnvFile(path.join(__dirname, '.env'));
} catch {
  // No .env file.
}

const PORT = Number(process.env.PORT) || 5000;
// Only this PC can reach the app unless LAN access is deliberately enabled
// (HOST=0.0.0.0 in .env).
const HOST = process.env.HOST || '127.0.0.1';

if (!process.env.ADMIN_PASSWORD && !process.env.ADMIN_PASSWORD_HASH) {
  console.warn('WARNING: no admin password set (ADMIN_PASSWORD in .env); admin login is disabled.');
}

async function main() {
  const options = dbOptionsFromEnv(path.join(__dirname, 'data', 'library.db'));
  const db = await openDb(options);
  const appOptions = appOptionsFromEnv();
  const app = createApp(db, appOptions);
  const backups = createBackups(db, { dir: appOptions.backupDir, keepDays: appOptions.backupKeepDays });

  // Closing-time auto-exit, then the daily backup and automatic reports. It
  // reads the schedule from the database on every tick, so it keeps working
  // across restarts and after the admin changes the timings.
  async function tick() {
    try {
      const done = await runDailyJobs(db, backups);
      if (done.length) console.log(`Daily jobs: ${done.join(', ')}`);
    } catch (err) {
      console.error('Daily jobs failed:', err);
    }
  }
  await tick();
  setInterval(tick, 30 * 1000);

  app.listen(PORT, HOST, () => {
    console.log(`Database: ${options.url ? `Turso (${options.url})` : options.file}`);
    console.log(`Library entry system running at http://localhost:${PORT}`);
    console.log(`Admin panel: http://localhost:${PORT}/admin.html`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
