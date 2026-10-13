// Save (POST {subscription}) or remove (POST {remove: endpoint}) a phone/computer for notifications.
const { guard, send, readBody, withImap, readNote, writeNote, PUSH_NOTE } = require('./_lib');
module.exports = guard(async (req, res) => {
  const b = await readBody(req);
  await withImap(async (client) => {
    let st = {}; try { st = JSON.parse((await readNote(client, PUSH_NOTE)) || '{}'); } catch (_) {}
    st.subs = Array.isArray(st.subs) ? st.subs : [];
    if (b.subscription && b.subscription.endpoint) {
      st.subs = st.subs.filter((s) => s.endpoint !== b.subscription.endpoint);
      st.subs.push({ endpoint: b.subscription.endpoint, keys: b.subscription.keys, ua: String(req.headers['user-agent'] || '').slice(0, 120), at: Date.now() });
      st.subs = st.subs.slice(-10);
    }
    if (b.remove) st.subs = st.subs.filter((s) => s.endpoint !== b.remove);
    await writeNote(client, PUSH_NOTE, JSON.stringify(st), 'Used by CU Inbox to send new-email notifications. Please do not delete.');
  });
  send(res, 200, { ok: true });
}, { methods: ['POST'] });
