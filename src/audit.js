const { dateStr, timeStr } = require('./time');

const KEEP_DAYS = 90;
const nowStamp = (d = new Date()) => `${dateStr(d)} ${timeStr(d)}`;

// Records an admin action. Entries older than 90 days are dropped as new
// ones arrive. Never throws: a failed audit write must not break the action.
async function audit(db, action, detail = '', ip = '') {
  try {
    await db.run('INSERT INTO admin_audit (at, action, detail, ip) VALUES (?, ?, ?, ?)',
      [nowStamp(), action, String(detail).slice(0, 500), String(ip || '').slice(0, 64)]);
    const cutoff = nowStamp(new Date(Date.now() - KEEP_DAYS * 86400000));
    await db.run('DELETE FROM admin_audit WHERE at < ?', [cutoff]);
  } catch (err) {
    console.error('Audit write failed:', err.message);
  }
}

function recentAudit(db, limit = 200) {
  return db.all('SELECT at, action, detail, ip FROM admin_audit ORDER BY id DESC LIMIT ?', [limit]);
}

module.exports = { audit, recentAudit, nowStamp };
