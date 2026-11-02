const nodemailer = require('nodemailer');

// SMTP settings come from the environment and never reach the browser.
// For Gmail use an App Password (needs 2-step verification), not the real one.
function mailConfig() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM, ADMIN_EMAIL } = process.env;
  return {
    configured: Boolean(SMTP_HOST && SMTP_USER && SMTP_PASS),
    host: SMTP_HOST,
    port: Number(SMTP_PORT) || 465,
    user: SMTP_USER,
    pass: SMTP_PASS,
    from: MAIL_FROM || SMTP_USER,
    adminEmail: ADMIN_EMAIL || '',
  };
}

const EMAIL_RE = /^[^\s@<>()[\],;:"\\]+@[^\s@<>()[\],;:"\\]+\.[^\s@<>()[\],;:"\\]+$/;

// Line breaks are stripped so a user-supplied address can't inject headers.
function cleanEmail(value) {
  const email = String(value ?? '').replace(/[\r\n]/g, '').trim().toLowerCase();
  return email.length <= 254 && EMAIL_RE.test(email) ? email : null;
}

let transport;
function getTransport(cfg) {
  transport ??= nodemailer.createTransport({
    host: cfg.host, port: cfg.port, secure: cfg.port === 465,
    auth: { user: cfg.user, pass: cfg.pass },
  });
  return transport;
}

// Sends one message. Throws when SMTP isn't configured or sending fails.
async function sendMail({ to, subject, text, attachments = [] }) {
  const cfg = mailConfig();
  if (!cfg.configured) throw new Error('Email is not set up (SMTP_HOST, SMTP_USER, SMTP_PASS).');
  const list = [].concat(to).map(cleanEmail).filter(Boolean);
  if (!list.length) throw new Error('No valid recipient.');
  await getTransport(cfg).sendMail({
    from: cfg.from, to: list.join(', '),
    subject: String(subject).replace(/[\r\n]+/g, ' '),
    text, attachments,
  });
  return list;
}

module.exports = { mailConfig, cleanEmail, sendMail };
