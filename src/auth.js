const crypto = require('node:crypto');

const COOKIE = 'lib_admin';
const SESSION_HOURS = 8;
const sessions = new Map(); // token -> expiry (ms)

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

function createAuth({ username, password }) {
  function login(req, res) {
    const { username: u = '', password: p = '' } = req.body || {};
    // Evaluate both so timing doesn't reveal which one was wrong.
    const ok = safeEqual(u, username) & safeEqual(p, password);
    if (!ok) return res.status(401).json({ message: 'Invalid username or password' });

    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, Date.now() + SESSION_HOURS * 3600 * 1000);
    res.setHeader('Set-Cookie',
      `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_HOURS * 3600}`);
    res.json({ ok: true });
  }

  function logout(req, res) {
    sessions.delete(parseCookies(req.headers.cookie)[COOKIE]);
    res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
    res.json({ ok: true });
  }

  function requireAdmin(req, res, next) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    const expiry = token && sessions.get(token);
    if (!expiry || expiry < Date.now()) {
      if (token) sessions.delete(token);
      return res.status(401).json({ message: 'Login required' });
    }
    next();
  }

  return { login, logout, requireAdmin };
}

module.exports = { createAuth };
