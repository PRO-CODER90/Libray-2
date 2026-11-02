const crypto = require('node:crypto');
const { getSettings, setSetting } = require('./db');
const { audit, nowStamp } = require('./audit');

const COOKIE = 'lib_admin';
const SESSION_HOURS = 8;
const IDLE_MINUTES = 20;
const MAX_FAILS = 5;
const LOCK_MINUTES = 15;

// A short list of passwords that are always refused.
const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password123', '123456789012', 'qwertyuiop', 'admin', 'admin123',
  'administrator', 'welcome123', 'letmein', 'iloveyou', 'library', 'library123', 'poornima',
  'poornima123', 'changeme', 'p@ssw0rd', 'passw0rd',
]);

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest();
}

function safeEqual(a, b) {
  return crypto.timingSafeEqual(sha256(a), sha256(b));
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  return `scrypt:${salt.toString('hex')}:${crypto.scryptSync(String(password), salt, 32).toString('hex')}`;
}

// passwordHash is "scrypt:<salt hex>:<hash hex>".
function checkHash(given, passwordHash) {
  const [, salt, hash] = String(passwordHash).split(':');
  const expected = Buffer.from(hash || '', 'hex');
  const actual = crypto.scryptSync(String(given), Buffer.from(salt || '', 'hex'), expected.length || 32);
  return expected.length > 0 && crypto.timingSafeEqual(actual, expected);
}

// Returns a list of problems; empty when the password is acceptable.
function passwordProblems(password, username = '') {
  const p = String(password);
  const problems = [];
  if (p.length < 12) problems.push('at least 12 characters');
  if (!/[A-Za-z]/.test(p)) problems.push('a letter');
  if (!/\d/.test(p)) problems.push('a number');
  if (!/[^A-Za-z0-9]/.test(p)) problems.push('a symbol');
  if (COMMON_PASSWORDS.has(p.toLowerCase())) problems.push('not a common password');
  if (username && p.toLowerCase().includes(String(username).toLowerCase())) problems.push('not containing the admin ID');
  return problems;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const minutesAgo = (m) => nowStamp(new Date(Date.now() - m * 60000));

// Sessions are signed cookies, so they work on Vercel where each request may
// hit a different instance. The cookie carries issued and last-seen times
// and a session version kept in the database: logging out or changing the
// password bumps the version, which revokes every older cookie. Each
// authorised request refreshes last-seen, giving a 20-minute idle timeout
// inside the 8-hour hard limit.
//
// The password is checked against, in order: a hash saved by "Change
// password" (settings.admin_password_hash), ADMIN_PASSWORD, ADMIN_PASSWORD_HASH.
function createAuth({ getDb, username, password, passwordHash, secret }) {
  const key = secret || sha256(`library-session:${username}:${password || passwordHash}`).toString('hex');
  const sign = (body) => crypto.createHmac('sha256', key).update(body).digest('hex');

  async function sessionVersion(db) {
    return (await getSettings(db)).session_version || '1';
  }

  async function passwordOk(db, given) {
    const saved = (await getSettings(db)).admin_password_hash;
    if (saved) return checkHash(given, saved);
    if (password) return safeEqual(given, password);
    if (passwordHash) return checkHash(given, passwordHash);
    return false;
  }

  function cookie(req, value, maxAge) {
    const secure = req.secure || req.get('x-forwarded-proto') === 'https' ? '; Secure' : '';
    return `${COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`;
  }

  function issue(req, res, issued, version) {
    const body = `${issued}.${Date.now()}.${version}`;
    const left = Math.max(0, Math.floor((issued + SESSION_HOURS * 3600000 - Date.now()) / 1000));
    res.setHeader('Set-Cookie', cookie(req, `${body}.${sign(body)}`, left));
  }

  async function readSession(db, req) {
    const token = parseCookies(req.headers.cookie)[COOKIE] || '';
    const parts = token.split('.');
    if (parts.length !== 4) return null;
    const [issued, last, version, sig] = parts;
    if (!safeEqual(sig, sign(`${issued}.${last}.${version}`))) return null;
    const now = Date.now();
    if (now - Number(issued) > SESSION_HOURS * 3600000) return null;
    if (now - Number(last) > IDLE_MINUTES * 60000) return null;
    if (version !== await sessionVersion(db)) return null;
    return { issued: Number(issued), version };
  }

  async function failures(db, keys) {
    const since = minutesAgo(LOCK_MINUTES);
    let worst = 0;
    for (const k of keys) {
      const row = await db.get('SELECT COUNT(*) AS n FROM login_attempts WHERE key = ? AND at >= ?', [k, since]);
      worst = Math.max(worst, Number(row.n));
    }
    return worst;
  }

  async function login(req, res) {
    const db = await getDb();
    const { username: u = '', password: p = '' } = req.body || {};
    const keys = [`ip:${req.ip}`, `user:${String(u).toLowerCase().slice(0, 64)}`];

    if (await failures(db, keys) >= MAX_FAILS) {
      await audit(db, 'login_locked', `user=${String(u).slice(0, 64)}`, req.ip);
      return res.status(429).json({ message: `Too many failed attempts. Try again in ${LOCK_MINUTES} minutes.` });
    }

    // Evaluate both so timing doesn't reveal which one was wrong.
    const ok = safeEqual(u, username) & await passwordOk(db, p);
    if (!ok) {
      const at = nowStamp();
      await db.batch(keys.map((k) => ({ sql: 'INSERT INTO login_attempts (key, at) VALUES (?, ?)', args: [k, at] })));
      await db.run('DELETE FROM login_attempts WHERE at < ?', [minutesAgo(24 * 60)]);
      await audit(db, 'login_fail', `user=${String(u).slice(0, 64)}`, req.ip);
      // Growing delay with each failure.
      await sleep(Math.min(250 * 2 ** (await failures(db, keys)), 4000));
      return res.status(401).json({ message: 'Invalid username or password' });
    }

    await db.run(`DELETE FROM login_attempts WHERE key IN (?, ?)`, keys);
    await audit(db, 'login_ok', '', req.ip);
    issue(req, res, Date.now(), await sessionVersion(db));
    res.json({ ok: true });
  }

  async function bumpVersion(db) {
    await setSetting(db, 'session_version', String(Number(await sessionVersion(db)) + 1));
  }

  async function logout(req, res) {
    const db = await getDb();
    if (await readSession(db, req)) {
      await bumpVersion(db);
      await audit(db, 'logout', '', req.ip);
    }
    res.setHeader('Set-Cookie', cookie(req, '', 0));
    res.json({ ok: true });
  }

  async function requireAdmin(req, res, next) {
    const db = await getDb();
    const session = await readSession(db, req);
    if (!session) return res.status(401).json({ message: 'Login required' });
    issue(req, res, session.issued, session.version);
    next();
  }

  async function verifyPassword(req, given) {
    return passwordOk(await getDb(), given);
  }

  async function changePassword(req, res) {
    const db = await getDb();
    const { current = '', next: newPassword = '', confirm = '' } = req.body || {};
    if (!await passwordOk(db, current)) {
      await audit(db, 'password_change_fail', 'wrong current password', req.ip);
      return res.status(403).json({ message: 'The current password is wrong.' });
    }
    if (newPassword !== confirm) return res.status(400).json({ message: 'The new passwords do not match.' });
    const problems = passwordProblems(newPassword, username);
    if (problems.length) return res.status(400).json({ message: `The new password needs ${problems.join(', ')}.` });
    await setSetting(db, 'admin_password_hash', hashPassword(newPassword));
    await bumpVersion(db);
    await audit(db, 'password_change', '', req.ip);
    // Keep this session; every other one is now revoked.
    issue(req, res, Date.now(), await sessionVersion(db));
    res.json({ ok: true });
  }

  return { login, logout, requireAdmin, changePassword, verifyPassword };
}

module.exports = { createAuth, hashPassword, passwordProblems, MAX_FAILS, IDLE_MINUTES };
