// Session info for the app: is first-time setup still needed? push key for notifications.
const { guard, send, withImap, readStoredHash } = require('./_lib');
module.exports = guard(async (req, res) => {
  const stored = await withImap(readStoredHash);
  send(res, 200, { setup: !stored, vapidKey: process.env.VAPID_PUBLIC_KEY || '' });
});
