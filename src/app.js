const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { getSettings, setSetting } = require('./db');
const { dateStr, isValidHHMM, isValidDate, formatClock } = require('./time');
const library = require('./library');
const { importMembers } = require('./importer');
const { toCsv } = require('./csv');
const { createAuth } = require('./auth');
const { audit, recentAudit } = require('./audit');
const { PERIODS } = require('./periods');
const { buildReport, summaryText, analytics } = require('./reports');
const { mailConfig, cleanEmail, sendMail } = require('./mailer');
const { createBackups } = require('./backup');
const { runDailyJobs } = require('./jobs');

// The admin ID defaults to PU01A; the password must come from the environment
// (ADMIN_PASSWORD, or ADMIN_PASSWORD_HASH as scrypt:<salt>:<hash>), so no
// credential lives in the code. Without one, admin login is disabled.
const DEFAULT_ADMIN_USER = 'PU01A';
const FORMATS = ['xlsx', 'csv'];

const EXPORT_COLUMNS = [
  'full_reg_no', 'name', 'branch', 'year', 'entry_date', 'entry_time',
  'exit_date', 'exit_time', 'role', 'exit_reason',
];

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  // Inline style attributes are used for chart bar heights and the icon sprite.
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "connect-src 'self' https://formspree.io",
  "form-action 'self' https://formspree.io",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
].join('; ');

function securityHeaders(req, res, next) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (req.secure || req.get('x-forwarded-proto') === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
}

// Optional ADMIN_ALLOWED_IPS (comma-separated) limits the admin area to
// known machines, e.g. the library PC.
function ipAllowList(allowed) {
  const list = (allowed || '').split(',').map((s) => s.trim()).filter(Boolean);
  return (req, res, next) => {
    if (!list.length) return next();
    const ip = String(req.ip || '').replace(/^::ffff:/, '');
    if (list.includes(ip)) return next();
    res.status(403).json({ message: 'The admin area is not available from this network.' });
  };
}

const validPeriod = (q) => PERIODS.includes(q.period) && isValidDate(q.date);
const validFormat = (f) => FORMATS.includes(f);
const parseId = (v) => (/^\d{1,9}$/.test(String(v)) ? Number(v) : null);
const cleanText = (v, max) => String(v ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);

function sendFile(res, { filename, contentType, buffer }) {
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buffer);
}

// dbReady is the database, or a promise of it, so the app can be created
// synchronously (Vercel needs the handler at import time).
function createApp(dbReady, options) {
  const {
    adminUser, adminPassword, adminPasswordHash, sessionSecret, cronSecret,
    allowedIps, backupDir, backupKeepDays = 30, contact = {},
  } = options;
  const app = express();
  let db;
  let backups;
  const getDb = async () => (db ??= await dbReady);
  const getBackups = async () => (backups ??= createBackups(await getDb(), { dir: backupDir, keepDays: backupKeepDays }));
  const auth = createAuth({
    getDb, username: adminUser, password: adminPassword, passwordHash: adminPasswordHash, secret: sessionSecret,
  });
  const adminOnly = ipAllowList(allowedIps);

  if (process.env.VERCEL) app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(securityHeaders);
  app.use(express.json({ limit: '10kb' }));
  app.use(['/admin.html', '/admin.js', '/login.css', '/admin.css'], adminOnly);
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use('/api', async (req, res, next) => {
    await getDb();
    next();
  });

  // Admin requests: allow-list, never cached, and a custom header on every
  // state-changing call (with SameSite=Strict cookies, this blocks CSRF).
  app.use('/api/admin', adminOnly, (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'GET' && req.get('X-Requested-With') !== 'XMLHttpRequest') {
      return res.status(403).json({ message: 'Missing request header.' });
    }
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
    const [inside, today, overall, todayCount] = await Promise.all([
      library.insideCount(db),
      library.peakInfo(db, dateStr()),
      library.peakInfo(db, null),
      db.get('SELECT COUNT(*) AS n FROM library_logs WHERE entry_date = ?', [dateStr()]),
    ]);
    res.json({
      inside,
      entries_today: Number(todayCount.n),
      peak_today: today.peak,
      peak_overall: overall.peak,
      opening_time: settings.opening_time,
      closing_time: settings.closing_time,
      opening_label: formatClock(settings.opening_time),
      closing_label: formatClock(settings.closing_time),
      server_time: new Date().toISOString(),
    });
  });

  // Only what the kiosk shows: no registration numbers.
  app.get('/api/inside', async (req, res) => {
    const rows = await library.listInside(db);
    res.json(rows.map(({ name, branch, role, entry_time }) => ({ name, branch, role, entry_time })));
  });

  app.get('/api/peak', async (req, res) => {
    const scope = req.query.date;
    if (scope === 'overall') return res.json(await library.peakInfo(db, null));
    const date = scope || dateStr();
    if (!isValidDate(date)) return res.status(400).json({ message: 'Invalid date' });
    res.json(await library.peakInfo(db, date));
  });

  // Vercel Cron calls this daily; it sends CRON_SECRET as a bearer token when
  // one is configured. Runs the auto-exit, the daily backup and any
  // automatic reports.
  app.get('/api/cron/auto-exit', async (req, res) => {
    if (cronSecret) {
      const given = req.get('authorization') || '';
      const expected = `Bearer ${cronSecret}`;
      const ok = given.length === expected.length &&
        crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
      if (!ok) return res.status(401).json({ message: 'Unauthorized' });
    }
    res.json({ done: await runDailyJobs(db, await getBackups()) });
  });

  // ---- Admin: session ----

  app.post('/api/admin/login', auth.login);
  app.post('/api/admin/logout', auth.logout);
  app.get('/api/admin/me', auth.requireAdmin, (req, res) => res.json({ ok: true, user: adminUser }));
  app.post('/api/admin/password', auth.requireAdmin, auth.changePassword);

  app.get('/api/admin/config', auth.requireAdmin, async (req, res) => {
    const cfg = mailConfig();
    res.json({
      mail_configured: cfg.configured,
      admin_email: cfg.adminEmail,
      backup_mode: (await getBackups()).mode,
      backup_keep_days: backupKeepDays,
    });
  });

  // ---- Admin: members and settings ----

  app.post('/api/admin/import', auth.requireAdmin,
    express.raw({ type: () => true, limit: '20mb' }),
    async (req, res) => {
      const filename = String(req.get('X-Filename') || '');
      if (!/\.(xlsx|csv)$/i.test(filename)) return res.status(400).json({ message: 'Upload a .xlsx or .csv file.' });
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return res.status(400).json({ message: 'No file uploaded' });
      }
      try {
        const result = await importMembers(db, req.body, filename);
        await audit(db, 'import', `${cleanText(filename, 100)}: +${result.added} ~${result.updated} skipped ${result.skipped.length}`, req.ip);
        res.json(result);
      } catch (err) {
        res.status(400).json({ message: err.message });
      }
    });

  const publicSettings = async () => {
    const s = await getSettings(db);
    return { opening_time: s.opening_time, closing_time: s.closing_time };
  };

  app.get('/api/admin/settings', auth.requireAdmin, async (req, res) => {
    res.json(await publicSettings());
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
    await audit(db, 'settings', `timings ${opening_time}-${closing_time}`, req.ip);
    res.json(await publicSettings());
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
    await audit(db, 'report_download', `daily csv ${date}`, req.ip);
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

  // ---- Admin: analytics and reports ----

  app.get('/api/admin/analytics', auth.requireAdmin, async (req, res) => {
    if (!validPeriod(req.query)) return res.status(400).json({ message: 'Choose a period and a date.' });
    await library.runAutoExit(db);
    res.json(await analytics(db, req.query.period, req.query.date));
  });

  app.get('/api/admin/report', auth.requireAdmin, async (req, res) => {
    const format = req.query.format || 'xlsx';
    if (!validPeriod(req.query) || !validFormat(format)) return res.status(400).json({ message: 'Choose a period, a date and a format.' });
    await library.runAutoExit(db);
    const report = await buildReport(db, { period: req.query.period, date: req.query.date, format });
    await audit(db, 'report_download', `${req.query.period} ${report.range.from}..${report.range.to} ${format}`, req.ip);
    sendFile(res, report);
  });

  app.post('/api/admin/report/email', auth.requireAdmin, async (req, res) => {
    const { period, date, format = 'xlsx' } = req.body || {};
    if (!validPeriod({ period, date }) || !validFormat(format)) return res.status(400).json({ message: 'Choose a period, a date and a format.' });
    const cfg = mailConfig();
    if (!cfg.adminEmail) return res.status(400).json({ message: 'ADMIN_EMAIL is not set.' });
    const report = await buildReport(db, { period, date, format });
    try {
      await sendMail({
        to: cfg.adminEmail,
        subject: `Library report: ${report.range.label}`,
        text: `${summaryText(report.summary)}\n\nThe report is attached.`,
        attachments: [{ filename: report.filename, content: report.buffer }],
      });
      await audit(db, 'report_email', `${period} ${report.range.from}..${report.range.to} to admin`, req.ip);
      res.json({ ok: true, to: cfg.adminEmail });
    } catch (err) {
      await audit(db, 'report_email_fail', err.message, req.ip);
      res.status(502).json({ message: `Email could not be sent: ${err.message}` });
    }
  });

  // ---- Admin: sharing ----

  app.get('/api/admin/recipients', auth.requireAdmin, async (req, res) => {
    res.json(await db.all('SELECT id, name, email, role, active FROM recipients ORDER BY name'));
  });

  async function saveRecipient(req, res, id) {
    const name = cleanText(req.body?.name, 80);
    const email = cleanEmail(req.body?.email);
    const role = cleanText(req.body?.role, 60);
    const active = req.body?.active === false || req.body?.active === 0 ? 0 : 1;
    if (!name || !email) return res.status(400).json({ message: 'A name and a valid email are required.' });
    try {
      if (id) await db.run('UPDATE recipients SET name = ?, email = ?, role = ?, active = ? WHERE id = ?', [name, email, role, active, id]);
      else await db.run('INSERT INTO recipients (name, email, role, active) VALUES (?, ?, ?, ?)', [name, email, role, active]);
    } catch {
      return res.status(409).json({ message: 'That email is already in the list.' });
    }
    await audit(db, 'recipients', `${id ? 'edit' : 'add'} ${email}`, req.ip);
    res.json({ ok: true });
  }

  app.post('/api/admin/recipients', auth.requireAdmin, (req, res) => saveRecipient(req, res, null));
  app.put('/api/admin/recipients/:id', auth.requireAdmin, (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ message: 'Bad id' });
    return saveRecipient(req, res, id);
  });
  app.delete('/api/admin/recipients/:id', auth.requireAdmin, async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ message: 'Bad id' });
    const row = await db.get('SELECT email FROM recipients WHERE id = ?', [id]);
    await db.run('DELETE FROM recipients WHERE id = ?', [id]);
    if (row) await audit(db, 'recipients', `remove ${row.email}`, req.ip);
    res.json({ ok: true });
  });

  // Sends a report to saved recipients (and optionally one extra address).
  app.post('/api/admin/report/share', auth.requireAdmin, async (req, res) => {
    const { period, date, format = 'xlsx', recipients = [], extra = '', note = '', summary_only: summaryOnly = false } = req.body || {};
    if (!validPeriod({ period, date }) || !validFormat(format)) return res.status(400).json({ message: 'Choose a period, a date and a format.' });
    const ids = [].concat(recipients).map(parseId).filter(Boolean).slice(0, 100);
    const saved = ids.length
      ? await db.all(`SELECT email FROM recipients WHERE active = 1 AND id IN (${ids.map(() => '?').join(',')})`, ids)
      : [];
    const to = saved.map((r) => r.email);
    if (String(extra).trim()) {
      const e = cleanEmail(extra);
      if (!e) return res.status(400).json({ message: 'The extra email address is not valid.' });
      to.push(e);
    }
    if (!to.length) return res.status(400).json({ message: 'Pick at least one recipient.' });

    const report = await buildReport(db, { period, date, format, summaryOnly: Boolean(summaryOnly) });
    const message = cleanText(note, 1000);
    try {
      await sendMail({
        to,
        subject: `Library report: ${report.range.label}`,
        text: `${message ? `${message}\n\n` : ''}${summaryText(report.summary)}\n\n` +
          'This report contains personal data for official library use only. Please do not forward it.',
        attachments: [{ filename: report.filename, content: report.buffer }],
      });
      await audit(db, 'share', `${period} ${report.range.from}..${report.range.to} ${summaryOnly ? 'summary' : 'full'} to ${to.join(', ')}`, req.ip);
      res.json({ ok: true, sent_to: to });
    } catch (err) {
      await audit(db, 'share_fail', err.message, req.ip);
      res.status(502).json({ message: `Email could not be sent: ${err.message}` });
    }
  });

  // ---- Admin: backups ----

  app.get('/api/admin/backups', auth.requireAdmin, async (req, res) => {
    const b = await getBackups();
    res.json({ mode: b.mode, keep_days: backupKeepDays, backups: await b.list() });
  });

  app.post('/api/admin/backups', auth.requireAdmin, async (req, res) => {
    try {
      const result = await (await getBackups()).create();
      await audit(db, 'backup', `manual ${result.name}`, req.ip);
      res.json(result);
    } catch (err) {
      await audit(db, 'backup_fail', err.message, req.ip);
      res.status(500).json({ message: err.message });
    }
  });

  app.get('/api/admin/backups/:name', auth.requireAdmin, async (req, res) => {
    const file = await (await getBackups()).read(req.params.name);
    if (!file) return res.status(404).json({ message: 'Backup not found.' });
    await audit(db, 'backup_download', file.filename, req.ip);
    sendFile(res, file);
  });

  app.post('/api/admin/backups/:name/restore', auth.requireAdmin, async (req, res) => {
    if (!await auth.verifyPassword(req, req.body?.password || '')) {
      await audit(db, 'restore_fail', 'wrong password', req.ip);
      return res.status(403).json({ message: 'Wrong password.' });
    }
    try {
      const result = await (await getBackups()).restore(req.params.name);
      await audit(db, 'restore', `${result.restored} (safety ${result.safety_backup})`, req.ip);
      res.json(result);
    } catch (err) {
      await audit(db, 'restore_fail', err.message, req.ip);
      res.status(400).json({ message: err.message });
    }
  });

  // ---- Admin: security and contact ----

  app.get('/api/admin/audit', auth.requireAdmin, async (req, res) => {
    res.json(await recentAudit(db));
  });

  app.get('/api/admin/contact', auth.requireAdmin, (req, res) => res.json(contact));

  app.use('/api', (req, res) => res.status(404).json({ message: 'Not found' }));

  app.use((err, req, res, next) => {
    console.error(err);
    const status = err.status || err.statusCode || 500;
    res.status(status).json({ message: status === 500 ? 'Server error' : err.message });
  });

  return app;
}

function appOptionsFromEnv() {
  const env = process.env;
  return {
    adminUser: env.ADMIN_USER || DEFAULT_ADMIN_USER,
    adminPassword: env.ADMIN_PASSWORD,
    adminPasswordHash: env.ADMIN_PASSWORD_HASH,
    sessionSecret: env.SESSION_SECRET,
    cronSecret: env.CRON_SECRET,
    allowedIps: env.ADMIN_ALLOWED_IPS,
    backupDir: env.BACKUP_DIR,
    backupKeepDays: Number(env.BACKUP_KEEP_DAYS) || 30,
    contact: {
      name: env.DEV_NAME || '',
      role: env.DEV_ROLE || 'Developer / maintainer of the Library Entry System',
      email: env.DEV_EMAIL || '',
      phone: env.DEV_PHONE || '',
      availability: env.DEV_HOURS || '',
      response_time: env.DEV_RESPONSE || '',
    },
  };
}

module.exports = { createApp, appOptionsFromEnv, EXPORT_COLUMNS };
