const fs = require('node:fs');
const path = require('node:path');

// Two interchangeable backends with the same async interface:
//   - a local SQLite file via node:sqlite (used by start.bat), or
//   - Turso, hosted SQLite, via @libsql/client (used on Vercel).
// Both speak the same SQL, so the rest of the app doesn't know which it has.
//
// Interface: all(sql, args) -> rows, get(sql, args) -> row | undefined,
// run(sql, args) -> { changes }, batch([{ sql, args }]) runs statements
// atomically in one go, close().

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS members (
    full_reg_no TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    branch      TEXT,
    year        TEXT,
    role        TEXT CHECK (role IN ('Student','Faculty'))
  );

  CREATE TABLE IF NOT EXISTS library_logs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    full_reg_no TEXT NOT NULL REFERENCES members(full_reg_no),
    entry_date  TEXT NOT NULL,
    entry_time  TEXT NOT NULL,
    exit_date   TEXT,
    exit_time   TEXT,
    exit_reason TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_logs_open  ON library_logs(exit_date);
  CREATE INDEX IF NOT EXISTS idx_logs_reg   ON library_logs(full_reg_no);
  CREATE INDEX IF NOT EXISTS idx_logs_entry ON library_logs(entry_date);

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

const DEFAULT_SETTINGS = {
  opening_time: '08:30',
  closing_time: '17:00',
};

function openLocal(file) {
  const { DatabaseSync } = require('node:sqlite');
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);

  // node:sqlite is synchronous, so each call (and each batch) runs start to
  // finish without anything else interleaving.
  return {
    kind: 'sqlite',
    all: async (sql, args = []) => db.prepare(sql).all(...args),
    get: async (sql, args = []) => db.prepare(sql).get(...args),
    run: async (sql, args = []) => ({ changes: Number(db.prepare(sql).run(...args).changes) }),
    batch: async (statements) => {
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const { sql, args = [] } of statements) db.prepare(sql).run(...args);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
    close: async () => db.close(),
  };
}

function openRemote(url, authToken) {
  const { createClient } = require('@libsql/client');
  const client = createClient({ url, authToken });

  const toObjects = (rs) => rs.rows.map((row) =>
    Object.fromEntries(rs.columns.map((c, i) => [c, row[i]])));

  // Create the schema once per process, before the first query.
  const ready = client.executeMultiple(SCHEMA);
  const exec = async (sql, args = []) => { await ready; return client.execute({ sql, args }); };

  return {
    kind: 'turso',
    all: async (sql, args) => toObjects(await exec(sql, args)),
    get: async (sql, args) => toObjects(await exec(sql, args))[0],
    run: async (sql, args) => ({ changes: (await exec(sql, args)).rowsAffected }),
    // One round trip, which matters over the network.
    batch: async (statements) => {
      await ready;
      await client.batch(statements.map(({ sql, args = [] }) => ({ sql, args })), 'write');
    },
    close: async () => client.close(),
  };
}

// Picks Turso when TURSO_DATABASE_URL is set, otherwise the local file.
async function openDb({ file, url, authToken } = {}) {
  const db = url ? openRemote(url, authToken) : openLocal(file);
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    await db.run('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)', [k, v]);
  }
  return db;
}

function dbOptionsFromEnv(defaultFile) {
  return {
    file: process.env.DB_FILE || defaultFile,
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  };
}

async function getSettings(db) {
  const rows = await db.all('SELECT key, value FROM settings');
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

async function setSetting(db, key, value) {
  await db.run(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, value]
  );
}

module.exports = { openDb, dbOptionsFromEnv, getSettings, setSetting };
