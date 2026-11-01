// Must be set before any Date is created.
process.env.TZ = 'Asia/Kolkata';

const path = require('node:path');
const { openDb } = require('./src/db');
const { createApp } = require('./src/app');
const { runAutoExit } = require('./src/library');

const PORT = Number(process.env.PORT) || 5000;
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data', 'library.db');
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

if (!process.env.ADMIN_PASSWORD) {
  console.warn('WARNING: using the default admin password. Set ADMIN_PASSWORD before going live.');
}

const db = openDb(DB_FILE);
const app = createApp(db, { adminUser: ADMIN_USER, adminPassword: ADMIN_PASSWORD });

// Closing-time job. It reads the schedule from the database on every tick, so
// it keeps working across restarts and after the admin changes the timings.
function tick() {
  try {
    const closed = runAutoExit(db);
    if (closed) console.log(`Auto-exit: closed ${closed} open session(s) with "DO NOT LOGOUT"`);
  } catch (err) {
    console.error('Auto-exit failed:', err);
  }
}
tick();
setInterval(tick, 30 * 1000);

app.listen(PORT, () => {
  console.log(`Library entry system running at http://localhost:${PORT}`);
  console.log(`Admin panel: http://localhost:${PORT}/admin.html`);
});
