const { guard, send, setCookie } = require('./_lib');
module.exports = guard(async (req, res) => { setCookie(res, '', 0); send(res, 200, { ok: true }); }, { auth: false, methods: ['POST'] });
