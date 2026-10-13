// Change the inbox password: POST {current, next}
const { guard, send, readBody, verifyPassword, hashPassword, withImap, writeStoredHash } = require('./_lib');

module.exports = guard(async (req, res) => {
  const { current, next } = await readBody(req);
  if (!current || !(await verifyPassword(current))) {
    await new Promise((r) => setTimeout(r, 900));
    return send(res, 403, { error: 'Your current password is not right.' });
  }
  if (!next || String(next).length < 8) return send(res, 400, { error: 'Use at least 8 characters for the new password.' });
  const hash = hashPassword(next);
  await withImap((client) => writeStoredHash(client, hash));
  send(res, 200, { ok: true });
}, { methods: ['POST'] });
