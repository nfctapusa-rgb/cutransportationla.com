// Read one message (marks it read), or act on it: POST {uid, action: 'unread'|'delete'}.
const { simpleParser } = require('mailparser');
const { guard, send, withImap, readBody } = require('./_lib');
const { openFolder } = require('./messages');

module.exports = guard(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const body = req.method === 'POST' ? await readBody(req) : {};
  const folder = (url.searchParams.get('folder') || body.folder || 'inbox').toLowerCase();
  const uid = Number(url.searchParams.get('uid') || body.uid);
  if (!uid) return send(res, 400, { error: 'Missing message id' });

  const out = await withImap(async (client) => {
    const lock = await openFolder(client, folder);
    if (!lock) return { error: 'Folder not found' };
    try {
      if (req.method === 'POST') {
        if (body.action === 'unread') await client.messageFlagsRemove(String(uid), ['\\Seen'], { uid: true });
        else if (body.action === 'delete') {
          const list = await client.list();
          const trash = list.find((b) => b.specialUse === '\\Trash');
          if (trash && folder !== 'trash') await client.messageMove(String(uid), trash.path, { uid: true });
          else await client.messageDelete(String(uid), { uid: true });
        }
        return { ok: true };
      }
      const msg = await client.fetchOne(String(uid), { source: true, flags: true }, { uid: true });
      if (!msg) return { error: 'Message not found' };
      const p = await simpleParser(msg.source);
      await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
      const addr = (a) => (a && a.value ? a.value.map((x) => ({ name: x.name || '', address: x.address || '' })) : []);
      return {
        uid,
        subject: p.subject || '(no subject)',
        from: addr(p.from), to: addr(p.to), cc: addr(p.cc), replyTo: addr(p.replyTo),
        date: (p.date || new Date()).toISOString(),
        messageId: p.messageId || '',
        references: Array.isArray(p.references) ? p.references : p.references ? [p.references] : [],
        text: p.text || '',
        html: p.html || '',
        attachments: (p.attachments || []).map((a) => ({ filename: a.filename || 'attachment', size: a.size, contentType: a.contentType })),
      };
    } finally { lock.release(); }
  });
  send(res, out.error ? 404 : 200, out);
}, { methods: ['GET', 'POST'] });
