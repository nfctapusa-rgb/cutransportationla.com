const { guard, send, makeToken, setCookie, readBody, verifyPassword, MAX_AGE } = require('./_lib');

module.exports = guard(async (req, res) => {
  const { password } = await readBody(req);
  if (!password || !(await verifyPassword(password))) {
    await new Promise((r) => setTimeout(r, 900)); // slow down guessing
    return send(res, 401, { error: 'Wrong password' });
  }
  setCookie(res, makeToken(), MAX_AGE);
  send(res, 200, { ok: true });
}, { auth: false, methods: ['POST'] });
