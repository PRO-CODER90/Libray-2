const path = require('node:path');
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

function createApp(db, { adminUser, adminPassword }) {
  const app = express();
  const auth = createAuth({ username: adminUser, password: adminPassword });

  app.disable('x-powered-by');
  app.use(express.json({ limit: '10kb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // ---- Public API ----

  app.post('/api/entry', (req, res) => {
    const result = library.recordScan(db, req.body?.reg_no);
    const { status, ...body } = result;
    res.status(status).json(body);
  });

  app.get('/api/status', (req, res) => {
    const settings = getSettings(db);
    const today = library.peakInfo(db, dateStr());
    const overall = library.peakInfo(db, null);
    res.json({
      inside: library.insideCount(db),
      peak_today: today.peak,
      peak_overall: overall.peak,
      opening_time: settings.opening_time,
      closing_time: settings.closing_time,
      opening_label: formatClock(settings.opening_time),
      closing_label: formatClock(settings.closing_time),
      server_time: new Date().toISOString(),
    });
  });

  app.get('/api/inside', (req, res) => {
    res.json(library.listInside(db));
  });

  app.get('/api/peak', (req, res) => {
    const scope = req.query.date;
    if (scope === 'overall') return res.json(library.peakInfo(db, null));
    const date = scope || dateStr();
    if (!isValidDate(date)) return res.status(400).json({ message: 'Invalid date' });
    res.json(library.peakInfo(db, date));
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

  app.get('/api/admin/settings', auth.requireAdmin, (req, res) => {
    res.json(getSettings(db));
  });

  app.put('/api/admin/settings', auth.requireAdmin, (req, res) => {
    const { opening_time, closing_time } = req.body || {};
    if (!isValidHHMM(opening_time) || !isValidHHMM(closing_time)) {
      return res.status(400).json({ message: 'Times must be in HH:MM (24-hour) format' });
    }
    if (opening_time >= closing_time) {
      return res.status(400).json({ message: 'Opening time must be before closing time' });
    }
    setSetting(db, 'opening_time', opening_time);
    setSetting(db, 'closing_time', closing_time);
    library.runAutoExit(db);
    res.json(getSettings(db));
  });

  app.get('/api/admin/logs', auth.requireAdmin, (req, res) => {
    const date = req.query.date || dateStr();
    if (!isValidDate(date)) return res.status(400).json({ message: 'Invalid date' });
    res.json(library.logsForDate(db, date));
  });

  app.get('/api/admin/export', auth.requireAdmin, (req, res) => {
    const date = req.query.date || dateStr();
    if (!isValidDate(date)) return res.status(400).json({ message: 'Invalid date' });
    const csv = toCsv(EXPORT_COLUMNS, library.logsForDate(db, date));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="daily_logs_${date}.csv"`);
    res.send(csv);
  });

  app.get('/api/admin/stats', auth.requireAdmin, (req, res) => {
    res.json({
      members: db.prepare('SELECT COUNT(*) AS n FROM members').get().n,
      logs: db.prepare('SELECT COUNT(*) AS n FROM library_logs').get().n,
    });
  });

  app.use('/api', (req, res) => res.status(404).json({ message: 'Not found' }));

  app.use((err, req, res, next) => {
    console.error(err);
    const status = err.status || err.statusCode || 500;
    res.status(status).json({ message: status === 500 ? 'Server error' : err.message });
  });

  return app;
}

module.exports = { createApp, EXPORT_COLUMNS };
