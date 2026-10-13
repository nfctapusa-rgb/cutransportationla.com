// Shared helpers for the private inbox. Credentials live only in Vercel env vars.
const crypto = require('crypto');
const { ImapFlow } = require('imapflow');

const COOKIE = 'cu_inbox';
const MAX_AGE = 60 * 60 * 24 * 365; // stays signed in for a year (renewed on use)

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
      if (auth) setCookie(res, makeToken(), MAX_AGE); // keep him signed in while he uses it
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

// ---- small settings store: notes kept in a hidden IMAP folder (no database needed) ----
const SETTINGS_FOLDER = 'CU Inbox Settings';
const PASS_NOTE = 'cu-inbox-password';
const PUSH_NOTE = 'cu-inbox-push';

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
async function hasFolder(client) {
  const list = await client.list();
  return !!list.find((b) => b.path === SETTINGS_FOLDER);
}
async function readNote(client, subject) {
  if (!(await hasFolder(client))) return null;
  const lock = await client.getMailboxLock(SETTINGS_FOLDER);
  try {
    if (!client.mailbox.exists) return null;
    let found = null;
    for await (const m of client.fetch('1:*', { envelope: true, source: true })) {
      if (m.envelope && m.envelope.subject === subject) {
        const parts = m.source.toString('utf8').split(/\r?\n\r?\n/);
        found = parts.slice(1).join('\n\n').trim().split(/\r?\n/)[0].trim();
      }
    }
    return found;
  } finally { lock.release(); }
}
async function writeNote(client, subject, value, explain) {
  if (!(await hasFolder(client))) await client.mailboxCreate(SETTINGS_FOLDER);
  const lock = await client.getMailboxLock(SETTINGS_FOLDER);
  try {
    const uids = await client.search({ subject }, { uid: true });
    const exact = [];
    if (uids && uids.length) {
      for await (const m of client.fetch(uids.join(','), { envelope: true, uid: true }, { uid: true })) if (m.envelope && m.envelope.subject === subject) exact.push(m.uid);
    }
    if (exact.length) await client.messageDelete(exact.join(','), { uid: true });
  } finally { lock.release(); }
  const raw = 'From: CU Inbox <' + mailUser() + '>\r\nTo: ' + mailUser() + '\r\nSubject: ' + subject +
    '\r\nDate: ' + new Date().toUTCString() + '\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n' + value +
    '\r\n\r\n' + (explain || 'Used by CU Inbox. Please do not delete.') + '\r\n';
  await client.append(SETTINGS_FOLDER, raw, ['\\Seen']);
}
async function readStoredHash(client) {
  const v = await readNote(client, PASS_NOTE);
  return v && v.startsWith('scrypt$') ? v : null;
}
async function writeStoredHash(client, hash) {
  await writeNote(client, PASS_NOTE, hash, 'This note stores the CU Inbox password (scrambled). Deleting it resets the inbox password to the original setup password.');
}
// Returns 'owner' for his own password, 'admin' for the setup/recovery password, or false.
async function checkPassword(pw) {
  const stored = await withImap(readStoredHash);
  if (stored && checkHash(pw, stored)) return { ok: 'owner', setup: false };
  if (process.env.INBOX_PASSWORD && safeEqual(pw, process.env.INBOX_PASSWORD)) return { ok: 'admin', setup: !stored };
  return { ok: false, setup: !stored };
}
async function verifyPassword(pw) { return !!(await checkPassword(pw)).ok; }

module.exports = { hashPassword, verifyPassword, checkPassword, writeStoredHash, readStoredHash, readNote, writeNote, PUSH_NOTE, guard, send, isAuthed, makeToken, setCookie, safeEqual, withImap, readBody, mailUser, MAX_AGE, env };
