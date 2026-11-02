const { getSettings, setSetting } = require('./db');
const { dateStr, timeStr, toFullTime } = require('./time');
const { runAutoExit } = require('./library');
const { buildReport, summaryText } = require('./reports');
const { mailConfig, sendMail } = require('./mailer');
const { audit } = require('./audit');

const AUTO_REPORT_TIME = '07:00:00';

// Work that runs once a day. Called by the 30-second timer offline and by
// Vercel Cron online; markers in settings make repeat calls harmless.
//   - After closing time (and the auto-exit): a backup, with old ones pruned.
//   - With AUTO_REPORTS=1 and email set up, from 7 AM: yesterday's report
//     every day, last week's on Monday, last month's on the 1st.
async function runDailyJobs(db, backups, now = new Date()) {
  const done = [];
  await runAutoExit(db, now);
  const settings = await getSettings(db);
  const today = dateStr(now);
  const time = timeStr(now);

  if (backups && time >= toFullTime(settings.closing_time) && settings.last_backup_date !== today) {
    try {
      const b = await backups.create(now);
      await setSetting(db, 'last_backup_date', today);
      await audit(db, 'backup', `automatic ${b.name}`);
      done.push(`backup ${b.name}`);
    } catch (err) {
      await audit(db, 'backup_fail', err.message);
    }
  }

  const cfg = mailConfig();
  if (process.env.AUTO_REPORTS === '1' && cfg.configured && cfg.adminEmail && time >= AUTO_REPORT_TIME) {
    const yesterday = dateStr(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
    const due = [['day', 'last_report_day']];
    if (now.getDay() === 1) due.push(['week', 'last_report_week']);
    if (now.getDate() === 1) due.push(['month', 'last_report_month']);
    for (const [period, marker] of due) {
      if (settings[marker] === today) continue;
      try {
        const report = await buildReport(db, { period, date: yesterday, format: 'xlsx' });
        await sendMail({
          to: cfg.adminEmail,
          subject: `Library report: ${report.range.label}`,
          text: `Automatic ${period} report.\n\n${summaryText(report.summary)}`,
          attachments: [{ filename: report.filename, content: report.buffer }],
        });
        await setSetting(db, marker, today);
        await audit(db, 'report_email', `automatic ${period} ${report.range.from}..${report.range.to}`);
        done.push(`report ${period}`);
      } catch (err) {
        await audit(db, 'report_email_fail', `automatic ${period}: ${err.message}`);
      }
    }
  }
  return done;
}

module.exports = { runDailyJobs };
