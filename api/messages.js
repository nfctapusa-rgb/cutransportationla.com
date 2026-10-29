// List recent messages in a folder (default INBOX).
const { guard, send, withImap } = require('./_lib');

const FOLDERS = { inbox: 'INBOX', sent: ['Sent', 'INBOX.Sent', 'Sent Messages', 'Sent Items'], trash: ['Trash', 'INBOX.Trash', 'Deleted Messages'], spam: ['Junk', 'Spam', 'INBOX.Junk', 'INBOX.Spam', 'Junk E-mail'] };

async function openFolder(client, key) {
  const want = FOLDERS[key] || 'INBOX';
  if (typeof want === 'string') return client.getMailboxLock(want);
  const list = await client.list();
  const bySpecial = list.find((b) => b.specialUse === ({ sent: '\\Sent', trash: '\\Trash', spam: '\\Junk' })[key]);
  const name = bySpecial ? bySpecial.path : (list.find((b) => want.includes(b.path)) || {}).path;
  if (!name) return null;
  return client.getMailboxLock(name);
}

module.exports = guard(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const folder = (url.searchParams.get('folder') || 'inbox').toLowerCase();
  const limit = Math.min(100, Number(url.searchParams.get('limit') || 50));
  const out = await withImap(async (client) => {
    const lock = await openFolder(client, folder);
    if (!lock) return { messages: [], unread: 0 };
    try {
      const total = client.mailbox.exists;
      if (!total) return { messages: [], unread: 0 };
      const from = Math.max(1, total - limit + 1);
      const msgs = [];
      for await (const m of client.fetch(`${from}:*`, { uid: true, envelope: true, flags: true, internalDate: true, bodyStructure: false })) {
        const e = m.envelope || {};
        const f = (e.from && e.from[0]) || {};
        const t = (e.to && e.to[0]) || {};
        msgs.push({
          uid: m.uid,
          subject: e.subject || '(no subject)',
          from: { name: f.name || '', address: f.address || '' },
          to: { name: t.name || '', address: t.address || '' },
          date: (e.date || m.internalDate || new Date()).toISOString(),
          seen: m.flags ? m.flags.has('\\Seen') : false,
          flagged: m.flags ? m.flags.has('\\Flagged') : false,
        });
      }
      msgs.sort((a, b) => new Date(b.date) - new Date(a.date));
      let unread = 0;
      if (folder === 'inbox') { try { const st = await client.status('INBOX', { unseen: true }); unread = st.unseen || 0; } catch (_) {} }
      return { messages: msgs, unread };
    } finally { lock.release(); }
  });
  send(res, 200, out);
});
module.exports.openFolder = openFolder;
