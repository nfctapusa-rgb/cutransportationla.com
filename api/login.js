const { guard, send, makeToken, setCookie, readBody, checkPassword, MAX_AGE } = require('./_lib');

module.exports = guard(async (req, res) => {
  const { password } = await readBody(req);
  const r = password ? await checkPassword(password) : { ok: false };
  if (!r.ok) {
    await new Promise((x) => setTimeout(x, 900)); // slow down guessing
    return send(res, 401, { error: 'Wrong password' });
  }
  setCookie(res, makeToken(), MAX_AGE);
  send(res, 200, { ok: true, setup: !!r.setup });
}, { auth: false, methods: ['POST'] });
