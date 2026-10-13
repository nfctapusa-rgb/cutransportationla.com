// CU Inbox service worker: shows new-email notifications and opens the inbox when tapped.
self.addEventListener('install', (e) => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {}); // network only; keeps the app installable

self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (_) { d = { title: 'New email', body: event.data && event.data.text() }; }
  event.waitUntil(self.registration.showNotification(d.title || 'New email', {
    body: d.body || 'You have a new message in CU Inbox',
    icon: '/icon-192.png', badge: '/icon-192.png', tag: d.tag || undefined,
    data: { url: d.url || '/inbox' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/inbox';
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) if (c.url.includes('/inbox')) { c.focus(); c.postMessage({ type: 'refresh' }); return; }
    return self.clients.openWindow(url);
  }));
});
