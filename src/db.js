const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DEFAULT_SETTINGS = {
  opening_time: '08:30',
  closing_time: '17:00',
};

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

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
  `);
  const insert = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insert.run(k, v);
  return db;
}

function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function getSettings(db) {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

function setSetting(db, key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value);
}

module.exports = { openDb, transaction, getSettings, setSetting };
