// Send (or reply) from info@ via Porkbun SMTP, then file a copy in Sent.
const nodemailer = require('nodemailer');
const { guard, send, readBody, withImap, mailUser, env } = require('./_lib');

module.exports = guard(async (req, res) => {
  const b = await readBody(req);
  const to = String(b.to || '').trim();
  const subject = String(b.subject || '').trim();
  const text = String(b.text || '');
  if (!/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+(\s*[,;]\s*[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+)*$/.test(to)) return send(res, 400, { error: 'Enter a valid email address to send to.' });
  if (!text.trim()) return send(res, 400, { error: 'Write a message first.' });

  const from = { name: process.env.MAIL_FROM_NAME || 'Clarity Ultimate Transportation', address: mailUser() };
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.porkbun.com',
    port: Number(process.env.SMTP_PORT || 587),
    secure: false, requireTLS: true,
    auth: { user: mailUser(), pass: env('MAIL_PASSWORD') },
  });
  const mail = { from, to, subject: subject || '(no subject)', text };
  if (b.inReplyTo) { mail.inReplyTo = b.inReplyTo; mail.references = [].concat(b.references || [], b.inReplyTo); }
  const info = await transport.sendMail(mail);

  // Best effort: keep a copy in the Sent folder so it shows in webmail too.
  try {
    const raw = await new Promise((resolve, reject) => {
      const c = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'windows' });
      c.sendMail({ ...mail, messageId: info.messageId }, (err, out) => (err ? reject(err) : resolve(out.message)));
    });
    await withImap(async (client) => {
      const list = await client.list();
      const sent = list.find((x) => x.specialUse === '\\Sent') || list.find((x) => /^(INBOX\.)?Sent/i.test(x.path));
      if (sent) await client.append(sent.path, raw, ['\\Seen']);
    });
  } catch (e) { console.error('Could not save to Sent', e.message); }

  send(res, 200, { ok: true });
}, { methods: ['POST'] });
