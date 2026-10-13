// Shared helpers for the private inbox. Credentials live only in Vercel env vars.
const crypto = require('crypto');
const { ImapFlow } = require('imapflow');

const COOKIE = 'cu_inbox';
const MAX_AGE = 60 * 60 * 24 * 30; // 30 days

function env(name) {
  const v = process.env[name];
  if (!v) throw Object.assign(new Error('Server is missing ' + name), { status: 500 });
  return v;
}

function sign(value) {
  // Signing key: INBOX_SECRET if set, otherwise derived from the two passwords
  // (changing either password signs everyone out).
  const key = process.env.INBOX_SECRET || crypto.createHash('sha256').update('cu-inbox:' + env('INBOX_PASSWORD') + ':' + env('MAIL_PASSWORD')).digest();
  return crypto.createHmac('sha256', key).update(value).digest('base64url');
}

function makeToken() {
  const exp = String(Math.floor(Date.now() / 1000) + MAX_AGE);
  return exp + '.' + sign(exp);
}

function readCookie(req) {
  const raw = req.headers.cookie || '';
  const m = raw.split(/;\s*/).find((c) => c.startsWith(COOKIE + '='));
  return m ? decodeURIComponent(m.slice(COOKIE.length + 1)) : '';
}

function isAuthed(req) {
  const tok = readCookie(req);
  const [exp, sig] = tok.split('.');
  if (!exp || !sig) return false;
  if (Number(exp) < Date.now() / 1000) return false;
  const good = sign(exp);
  return sig.length === good.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good));
}

function setCookie(res, value, maxAge) {
  res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`);
}

function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function guard(handler, { auth = true, methods = ['GET'] } = {}) {
  return async (req, res) => {
    try {
      if (!methods.includes(req.method)) return send(res, 405, { error: 'Method not allowed' });
      if (auth && !isAuthed(req)) return send(res, 401, { error: 'Please sign in' });
      await handler(req, res);
    } catch (e) {
      console.error(e);
      send(res, e.status || 500, { error: e.status ? e.message : 'Something went wrong talking to the mail server. Try again in a moment.' });
    }
  };
}

function mailUser() { return process.env.MAIL_USER || 'info@cutransportationla.com'; }

async function withImap(fn) {
  const client = new ImapFlow({
    host: process.env.IMAP_HOST || 'imap.porkbun.com',
    port: Number(process.env.IMAP_PORT || 993),
    secure: true,
    auth: { user: mailUser(), pass: env('MAIL_PASSWORD') },
    logger: false,
  });
  await client.connect();
  try { return await fn(client); } finally { try { await client.logout(); } catch (_) {} }
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch (_) { return {}; } }
  const chunks = []; for await (const c of req) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch (_) { return {}; }
}

// ---- owner-settable password, stored as a scrypt hash in a hidden IMAP folder ----
const SETTINGS_FOLDER = 'CU Inbox Settings';
const SETTINGS_SUBJECT = 'cu-inbox-password';

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(String(pw), salt, 32);
  return 'scrypt$' + salt.toString('base64') + '$' + h.toString('base64');
}
function checkHash(pw, stored) {
  const [alg, salt, h] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !salt || !h) return false;
  const want = Buffer.from(h, 'base64');
  const got = crypto.scryptSync(String(pw), Buffer.from(salt, 'base64'), want.length);
  return crypto.timingSafeEqual(want, got);
}
async function readStoredHash(client) {
  const list = await client.list();
  if (!list.find((b) => b.path === SETTINGS_FOLDER)) return null;
  const lock = await client.getMailboxLock(SETTINGS_FOLDER);
  try {
    if (!client.mailbox.exists) return null;
    let found = null;
    for await (const m of client.fetch('1:*', { envelope: true, source: true })) {
      if (m.envelope && m.envelope.subject === SETTINGS_SUBJECT) {
        const body = m.source.toString('utf8').split(/\r?\n\r?\n/).slice(1).join('\n').trim();
        if (body.startsWith('scrypt$')) found = body.split(/\s/)[0];
      }
    }
    return found;
  } finally { lock.release(); }
}
async function writeStoredHash(client, hash) {
  const list = await client.list();
  if (!list.find((b) => b.path === SETTINGS_FOLDER)) await client.mailboxCreate(SETTINGS_FOLDER);
  const lock = await client.getMailboxLock(SETTINGS_FOLDER);
  try {
    if (client.mailbox.exists) await client.messageDelete('1:*');
  } finally { lock.release(); }
  const raw = 'From: CU Inbox <' + mailUser() + '>\r\nTo: ' + mailUser() + '\r\nSubject: ' + SETTINGS_SUBJECT +
    '\r\nDate: ' + new Date().toUTCString() + '\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n' + hash +
    '\r\n\r\nThis note stores the CU Inbox password (scrambled). Do not delete it unless you want to reset the inbox password back to the original one.\r\n';
  await client.append(SETTINGS_FOLDER, raw, ['\\Seen']);
}
// The admin password (INBOX_PASSWORD env var) always works, as a recovery key.
async function verifyPassword(pw) {
  if (process.env.INBOX_PASSWORD && safeEqual(pw, process.env.INBOX_PASSWORD)) return true;
  const stored = await withImap(readStoredHash);
  return stored ? checkHash(pw, stored) : false;
}

module.exports = { hashPassword, verifyPassword, writeStoredHash, guard, send, isAuthed, makeToken, setCookie, safeEqual, withImap, readBody, mailUser, MAX_AGE, env };
