const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { getSettings, setSetting } = require('./db');
const { dateStr, isValidHHMM, isValidDate, formatClock } = require('./time');
const library = require('./library');
const { importMembers } = require('./importer');
const { toCsv } = require('./csv');
const { createAuth } = require('./auth');

const EXPORT_COLUMNS = [
  'full_reg_no', 'name', 'branch', 'year', 'entry_date', 'entry_time',
  'exit_date', 'exit_time', 'role', 'exit_reason',
];

// dbReady is the database, or a promise of it, so the app can be created
// synchronously (Vercel needs the handler at import time).
function createApp(dbReady, { adminUser, adminPassword, sessionSecret, cronSecret }) {
  const app = express();
  const auth = createAuth({ username: adminUser, password: adminPassword, secret: sessionSecret });
  let db;

  app.disable('x-powered-by');
  app.use(express.json({ limit: '10kb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use('/api', async (req, res, next) => {
    db ??= await dbReady;
    next();
  });

  // ---- Public API ----

  app.post('/api/entry', async (req, res) => {
    const { status, ...body } = await library.recordScan(db, req.body?.reg_no);
    res.status(status).json(body);
  });

  app.get('/api/status', async (req, res) => {
    await library.runAutoExit(db);
    const settings = await getSettings(db);
    const [inside, today, overall] = await Promise.all([
      library.insideCount(db),
      library.peakInfo(db, dateStr()),
      library.peakInfo(db, null),
    ]);
    res.json({
      inside,
      peak_today: today.peak,
      peak_overall: overall.peak,
      opening_time: settings.opening_time,
      closing_time: settings.closing_time,
      opening_label: formatClock(settings.opening_time),
      closing_label: formatClock(settings.closing_time),
      server_time: new Date().toISOString(),
    });
  });

  app.get('/api/inside', async (req, res) => {
    res.json(await library.listInside(db));
  });

  app.get('/api/peak', async (req, res) => {
    const scope = req.query.date;
    if (scope === 'overall') return res.json(await library.peakInfo(db, null));
    const date = scope || dateStr();
    if (!isValidDate(date)) return res.status(400).json({ message: 'Invalid date' });
    res.json(await library.peakInfo(db, date));
  });

  // Vercel Cron calls this daily as a safety net; it sends CRON_SECRET as a
  // bearer token when one is configured.
  app.get('/api/cron/auto-exit', async (req, res) => {
    if (cronSecret) {
      const given = req.get('authorization') || '';
      const expected = `Bearer ${cronSecret}`;
      const ok = given.length === expected.length &&
        crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
      if (!ok) return res.status(401).json({ message: 'Unauthorized' });
    }
    res.json({ closed: await library.runAutoExit(db) });
  });

  // ---- Admin API ----

  app.post('/api/admin/login', auth.login);
  app.post('/api/admin/logout', auth.logout);
  app.get('/api/admin/me', auth.requireAdmin, (req, res) => res.json({ ok: true }));

  app.post('/api/admin/import', auth.requireAdmin,
    express.raw({ type: () => true, limit: '20mb' }),
    async (req, res) => {
      const filename = String(req.get('X-Filename') || '');
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return res.status(400).json({ message: 'No file uploaded' });
      }
      try {
        res.json(await importMembers(db, req.body, filename));
      } catch (err) {
        res.status(400).json({ message: err.message });
      }
    });

  app.get('/api/admin/settings', auth.requireAdmin, async (req, res) => {
    res.json(await getSettings(db));
  });

  app.put('/api/admin/settings', auth.requireAdmin, async (req, res) => {
    const { opening_time, closing_time } = req.body || {};
    if (!isValidHHMM(opening_time) || !isValidHHMM(closing_time)) {
      return res.status(400).json({ message: 'Times must be in HH:MM (24-hour) format' });
    }
    if (opening_time >= closing_time) {
      return res.status(400).json({ message: 'Opening time must be before closing time' });
    }
    await setSetting(db, 'opening_time', opening_time);
    await setSetting(db, 'closing_time', closing_time);
    await library.runAutoExit(db);
    res.json(await getSettings(db));
  });

  app.get('/api/admin/logs', auth.requireAdmin, async (req, res) => {
    const date = req.query.date || dateStr();
    if (!isValidDate(date)) return res.status(400).json({ message: 'Invalid date' });
    await library.runAutoExit(db);
    res.json(await library.logsForDate(db, date));
  });

  app.get('/api/admin/export', auth.requireAdmin, async (req, res) => {
    const date = req.query.date || dateStr();
    if (!isValidDate(date)) return res.status(400).json({ message: 'Invalid date' });
    await library.runAutoExit(db);
    const csv = toCsv(EXPORT_COLUMNS, await library.logsForDate(db, date));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="daily_logs_${date}.csv"`);
    res.send(csv);
  });

  app.get('/api/admin/stats', auth.requireAdmin, async (req, res) => {
    const [members, logs] = await Promise.all([
      db.get('SELECT COUNT(*) AS n FROM members'),
      db.get('SELECT COUNT(*) AS n FROM library_logs'),
    ]);
    res.json({ members: Number(members.n), logs: Number(logs.n), database: db.kind });
  });

  app.use('/api', (req, res) => res.status(404).json({ message: 'Not found' }));

  app.use((err, req, res, next) => {
    console.error(err);
    const status = err.status || err.statusCode || 500;
    res.status(status).json({ message: status === 500 ? 'Server error' : err.message });
  });

  return app;
}

function appOptionsFromEnv() {
  return {
    adminUser: process.env.ADMIN_USER || 'admin',
    adminPassword: process.env.ADMIN_PASSWORD || 'admin123',
    sessionSecret: process.env.SESSION_SECRET,
    cronSecret: process.env.CRON_SECRET,
  };
}

module.exports = { createApp, appOptionsFromEnv, EXPORT_COLUMNS };
