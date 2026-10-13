// Called every few minutes by a scheduler: looks for new mail and sends phone notifications.
// Safe to call publicly: it never returns mail content, and runs at most once every 45 seconds.
const webpush = require('web-push');
const { guard, send, withImap, readNote, writeNote, PUSH_NOTE } = require('./_lib');

module.exports = guard(async (req, res) => {
  const pub = process.env.VAPID_PUBLIC_KEY, priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) return send(res, 200, { ok: true, skipped: 'no push keys' });
  webpush.setVapidDetails('mailto:info@cutransportationla.com', pub, priv);
  const out = await withImap(async (client) => {
    let st = {}; try { st = JSON.parse((await readNote(client, PUSH_NOTE)) || '{}'); } catch (_) {}
    st.subs = Array.isArray(st.subs) ? st.subs : [];
    if (st.lastCheck && Date.now() - st.lastCheck < 45000) return { skipped: 'too soon' };
    const lock = await client.getMailboxLock('INBOX');
    let fresh = [], top = st.lastUid || 0;
    try {
      const next = client.mailbox.uidNext || 1;
      if (!st.lastUid) { top = next - 1; } // first run: start from now, no flood of old mail
      else if (next - 1 > st.lastUid) {
        for await (const m of client.fetch(`${st.lastUid + 1}:*`, { uid: true, envelope: true, flags: true }, { uid: true })) {
          if (m.uid <= st.lastUid) continue;
          top = Math.max(top, m.uid);
          if (m.flags && m.flags.has('\\Seen')) continue;
          const f = (m.envelope.from && m.envelope.from[0]) || {};
          fresh.push({ from: f.name || f.address || 'New email', subject: m.envelope.subject || '(no subject)' });
        }
      }
    } finally { lock.release(); }
    const dead = [];
    if (fresh.length && st.subs.length) {
      const quote = (s) => /quote request|would like a quote/i.test(s);
      const msgs = fresh.length > 3
        ? [{ title: fresh.length + ' new emails', body: fresh.slice(0, 3).map((x) => x.from).join(', ') + '\u2026' }]
        : fresh.map((x) => ({ title: (quote(x.subject) ? '\u{1F697} New quote request: ' : '') + x.from, body: x.subject }));
      for (const sub of st.subs) {
        for (const n of msgs) {
          try { await webpush.sendNotification(sub, JSON.stringify({ ...n, url: '/inbox' }), { TTL: 3600 }); }
          catch (e) { if (e.statusCode === 404 || e.statusCode === 410) { dead.push(sub.endpoint); break; } console.error('push failed', e.statusCode); }
        }
      }
    }
    st.subs = st.subs.filter((s) => !dead.includes(s.endpoint));
    st.lastUid = top; st.lastCheck = Date.now();
    await writeNote(client, PUSH_NOTE, JSON.stringify(st), 'Used by CU Inbox to send new-email notifications. Please do not delete.');
    return { newMail: fresh.length, devices: st.subs.length };
  });
  send(res, 200, { ok: true, ...out });
}, { auth: false, methods: ['GET', 'POST'] });
