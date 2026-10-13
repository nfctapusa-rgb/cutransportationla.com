const { guard, send, makeToken, setCookie, safeEqual, readBody, MAX_AGE, env } = require('./_lib');

module.exports = guard(async (req, res) => {
  const { password } = await readBody(req);
  if (!password || !safeEqual(password, env('INBOX_PASSWORD'))) {
    await new Promise((r) => setTimeout(r, 900)); // slow down guessing
    return send(res, 401, { error: 'Wrong password' });
  }
  setCookie(res, makeToken(), MAX_AGE);
  send(res, 200, { ok: true });
}, { auth: false, methods: ['POST'] });
