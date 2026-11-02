const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { dateStr, timeStr } = require('./time');

// Daily and on-demand backups, keeping only the last keepDays days.
//   Offline (SQLite file): VACUUM INTO data/backups/library_<stamp>.db, a
//     consistent copy that is safe while the app runs.
//   Online (Turso, no disk): members and logs as gzipped JSON in the
//     backups table.
// Visit logs themselves are never deleted; only old backups are. A restore
// brings back members, logs and library timings, never the admin password.
const RESTORED_SETTINGS = "('opening_time', 'closing_time')";

const NAME_RE = /^library_\d{4}-\d{2}-\d{2}_\d{6}\.(db|json\.gz)$/;
const stamp = (d = new Date()) => `${dateStr(d)}_${timeStr(d).replace(/:/g, '')}`;
const dateOfName = (name) => name.slice(8, 18);
const cutoffDate = (keepDays, now) => dateStr(new Date(now.getTime() - keepDays * 86400000));

function createBackups(db, { dir, keepDays = 30 } = {}) {
  return db.kind === 'sqlite'
    ? localBackups(db, dir || path.join(path.dirname(db.file), 'backups'), keepDays)
    : remoteBackups(db, keepDays);
}

function localBackups(db, dir, keepDays) {
  const { DatabaseSync } = require('node:sqlite');

  function inspect(file) {
    const copy = new DatabaseSync(file, { readOnly: true });
    try {
      const ok = copy.prepare('PRAGMA integrity_check').get();
      return {
        ok: Object.values(ok)[0] === 'ok',
        rows_members: Number(copy.prepare('SELECT COUNT(*) AS n FROM members').get().n),
        rows_logs: Number(copy.prepare('SELECT COUNT(*) AS n FROM library_logs').get().n),
      };
    } finally {
      copy.close();
    }
  }

  async function prune(now = new Date()) {
    const cutoff = cutoffDate(keepDays, now);
    let removed = 0;
    for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      if (NAME_RE.test(name) && dateOfName(name) < cutoff) {
        fs.unlinkSync(path.join(dir, name));
        removed++;
      }
    }
    return removed;
  }

  // Written to a temporary file, checked, then renamed, so a failed backup
  // never replaces a good one.
  async function create(now = new Date()) {
    fs.mkdirSync(dir, { recursive: true });
    const name = `library_${stamp(now)}.db`;
    const final = path.join(dir, name);
    const tmp = `${final}.tmp`;
    fs.rmSync(tmp, { force: true });
    db.sqlite.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    const info = inspect(tmp);
    const live = Number(db.sqlite.prepare('SELECT COUNT(*) AS n FROM library_logs').get().n);
    if (!info.ok || info.rows_logs !== live) {
      fs.rmSync(tmp, { force: true });
      throw new Error('Backup check failed; the previous backups were kept.');
    }
    fs.renameSync(tmp, final);
    await prune(now);
    return { name, size: fs.statSync(final).size, ...info };
  }

  async function list() {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((n) => NAME_RE.test(n)).sort().reverse().map((name) => {
      const file = path.join(dir, name);
      let counts = {};
      try { counts = inspect(file); } catch { counts = { ok: false }; }
      return { name, created_at: name.slice(8, 18) + ' ' + name.slice(19, 25).replace(/(..)(..)(..)/, '$1:$2:$3'), size: fs.statSync(file).size, ...counts };
    });
  }

  async function read(name) {
    if (!NAME_RE.test(name) || !fs.existsSync(path.join(dir, name))) return null;
    return { filename: name, contentType: 'application/vnd.sqlite3', buffer: fs.readFileSync(path.join(dir, name)) };
  }

  // Replaces members, logs and timings with the backup's, after taking a
  // safety backup of the current data.
  async function restore(name) {
    const file = path.join(dir, name);
    if (!NAME_RE.test(name) || !fs.existsSync(file)) throw new Error('Backup not found.');
    if (!inspect(file).ok) throw new Error('That backup file is damaged.');
    const safety = await create();
    const s = db.sqlite;
    s.exec(`ATTACH DATABASE '${file.replace(/'/g, "''")}' AS b`);
    try {
      s.exec('BEGIN IMMEDIATE');
      try {
        s.exec(`
          DELETE FROM library_logs; DELETE FROM members;
          DELETE FROM settings WHERE key IN ${RESTORED_SETTINGS};
          INSERT INTO members SELECT * FROM b.members;
          INSERT INTO library_logs SELECT * FROM b.library_logs;
          INSERT INTO settings SELECT * FROM b.settings WHERE key IN ${RESTORED_SETTINGS};
        `);
        s.exec('COMMIT');
      } catch (err) {
        s.exec('ROLLBACK');
        throw err;
      }
    } finally {
      s.exec('DETACH DATABASE b');
    }
    return { restored: name, safety_backup: safety.name };
  }

  return { mode: 'file', dir, create, list, prune, read, restore };
}

function remoteBackups(db, keepDays) {
  async function dump() {
    return {
      members: await db.all('SELECT full_reg_no, name, branch, year, role FROM members'),
      library_logs: await db.all('SELECT id, full_reg_no, entry_date, entry_time, exit_date, exit_time, exit_reason FROM library_logs'),
      settings: await db.all(`SELECT key, value FROM settings WHERE key IN ${RESTORED_SETTINGS}`),
    };
  }

  async function prune(now = new Date()) {
    return (await db.run('DELETE FROM backups WHERE created_at < ?', [cutoffDate(keepDays, now)])).changes;
  }

  async function create(now = new Date()) {
    const data = await dump();
    const gz = zlib.gzipSync(JSON.stringify(data));
    // Round-trip check before saving.
    const back = JSON.parse(zlib.gunzipSync(gz));
    if (back.library_logs.length !== data.library_logs.length) throw new Error('Backup check failed.');
    const name = `library_${stamp(now)}.json.gz`;
    await db.run(
      'INSERT INTO backups (name, created_at, rows_members, rows_logs, data) VALUES (?, ?, ?, ?, ?)',
      [name, `${dateStr(now)} ${timeStr(now)}`, data.members.length, data.library_logs.length, gz]
    );
    await prune(now);
    return { name, size: gz.length, ok: true, rows_members: data.members.length, rows_logs: data.library_logs.length };
  }

  async function list() {
    const rows = await db.all('SELECT name, created_at, rows_members, rows_logs, length(data) AS size FROM backups ORDER BY created_at DESC');
    return rows.map((r) => ({ ...r, size: Number(r.size), rows_members: Number(r.rows_members), rows_logs: Number(r.rows_logs), ok: true }));
  }

  async function read(name) {
    if (!NAME_RE.test(name)) return null;
    const row = await db.get('SELECT data FROM backups WHERE name = ?', [name]);
    if (!row) return null;
    return { filename: name, contentType: 'application/gzip', buffer: Buffer.from(row.data) };
  }

  async function restore(name) {
    const file = await read(name);
    if (!file) throw new Error('Backup not found.');
    const data = JSON.parse(zlib.gunzipSync(file.buffer));
    const safety = await create();
    const ins = (table, cols, rows) => rows.map((r) => ({
      sql: `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
      args: cols.map((c) => r[c] ?? null),
    }));
    await db.batch([
      { sql: 'DELETE FROM library_logs' }, { sql: 'DELETE FROM members' },
      { sql: `DELETE FROM settings WHERE key IN ${RESTORED_SETTINGS}` },
      ...ins('members', ['full_reg_no', 'name', 'branch', 'year', 'role'], data.members),
      ...ins('library_logs', ['id', 'full_reg_no', 'entry_date', 'entry_time', 'exit_date', 'exit_time', 'exit_reason'], data.library_logs),
      ...ins('settings', ['key', 'value'], data.settings.filter((r) => RESTORED_SETTINGS.includes(`'${r.key}'`))),
    ]);
    return { restored: name, safety_backup: safety.name };
  }

  return { mode: 'database', create, list, prune, read, restore };
}

module.exports = { createBackups, NAME_RE };
