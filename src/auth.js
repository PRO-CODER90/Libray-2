const crypto = require('node:crypto');

const COOKIE = 'lib_admin';
const SESSION_HOURS = 8;

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

// passwordHash is "scrypt:<salt hex>:<hash hex>".
function checkHash(given, passwordHash) {
  const [, salt, hash] = String(passwordHash).split(':');
  const expected = Buffer.from(hash || '', 'hex');
  const actual = crypto.scryptSync(String(given), Buffer.from(salt || '', 'hex'), expected.length || 32);
  return expected.length > 0 && crypto.timingSafeEqual(actual, expected);
}

// Sessions are signed tokens rather than server memory, so they keep working
// on Vercel where each request may hit a different instance. Without a
// SESSION_SECRET the key derives from the credentials, so changing the admin
// password logs everyone out. A plain password, when given, takes precedence
// over passwordHash.
function createAuth({ username, password, passwordHash, secret }) {
  const key = secret || sha256(`library-session:${username}:${password || passwordHash}`).toString('hex');
  const passwordOk = (p) => (password ? safeEqual(p, password) : checkHash(p, passwordHash));
  const sign = (expiry) => crypto.createHmac('sha256', key).update(String(expiry)).digest('hex');

  function cookie(req, value, maxAge) {
    const secure = req.secure || req.get('x-forwarded-proto') === 'https' ? '; Secure' : '';
    return `${COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`;
  }

  function isValid(token) {
    const [expiry, sig] = String(token || '').split('.');
    if (!expiry || !sig || Number(expiry) < Date.now()) return false;
    return safeEqual(sig, sign(expiry));
  }

  function login(req, res) {
    const { username: u = '', password: p = '' } = req.body || {};
    // Evaluate both so timing doesn't reveal which one was wrong.
    const ok = safeEqual(u, username) & passwordOk(p);
    if (!ok) return res.status(401).json({ message: 'Invalid username or password' });

    const expiry = Date.now() + SESSION_HOURS * 3600 * 1000;
    res.setHeader('Set-Cookie', cookie(req, `${expiry}.${sign(expiry)}`, SESSION_HOURS * 3600));
    res.json({ ok: true });
  }

  function logout(req, res) {
    res.setHeader('Set-Cookie', cookie(req, '', 0));
    res.json({ ok: true });
  }

  function requireAdmin(req, res, next) {
    if (!isValid(parseCookies(req.headers.cookie)[COOKIE])) {
      return res.status(401).json({ message: 'Login required' });
    }
    next();
  }

  return { login, logout, requireAdmin };
}

module.exports = { createAuth };
