// Must be set before any Date is created.
process.env.TZ = 'Asia/Kolkata';

const path = require('node:path');
const { openDb, dbOptionsFromEnv } = require('./src/db');
const { createApp, appOptionsFromEnv } = require('./src/app');
const { runAutoExit } = require('./src/library');

const PORT = Number(process.env.PORT) || 5000;

if (!process.env.ADMIN_PASSWORD) {
  console.warn('WARNING: using the default admin password. Set ADMIN_PASSWORD before going live.');
}

async function main() {
  const options = dbOptionsFromEnv(path.join(__dirname, 'data', 'library.db'));
  const db = await openDb(options);
  const app = createApp(db, appOptionsFromEnv());

  // Closing-time job. It reads the schedule from the database on every tick, so
  // it keeps working across restarts and after the admin changes the timings.
  async function tick() {
    try {
      const closed = await runAutoExit(db);
      if (closed) console.log(`Auto-exit: closed ${closed} open session(s) with "DO NOT LOGOUT"`);
    } catch (err) {
      console.error('Auto-exit failed:', err);
    }
  }
  await tick();
  setInterval(tick, 30 * 1000);

  app.listen(PORT, () => {
    console.log(`Database: ${options.url ? `Turso (${options.url})` : options.file}`);
    console.log(`Library entry system running at http://localhost:${PORT}`);
    console.log(`Admin panel: http://localhost:${PORT}/admin.html`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
