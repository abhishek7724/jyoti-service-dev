self.addEventListener("install", event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
  let payload;
  try { payload = event.data?.json(); } catch { return; }
  if (!payload) return;
  event.waitUntil(self.registration.showNotification(payload.title, {
    body: payload.body, icon: '/icon-192.png',badge:'/icon-192.png',requireInteraction:true,renotify:true,
    data: { ticketNumber: payload.ticketNumber },
    tag: 'jyoti-ticket-' + payload.ticketNumber,
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const number = event.notification.data?.ticketNumber;
  const url = new URL('/staff', self.location.origin);
  if (/^[1-9][0-9]{4}$/.test(String(number))) url.searchParams.set('ticket',number);
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const staff = windows.find(client => ['/staff', '/staff.html'].includes(new URL(client.url).pathname));
    if (staff) {
      try {
        const focused = await staff.focus();
        const navigated = await focused.navigate(url.href);
        if (navigated) return navigated;
      } catch {
        // The existing window can disappear while the notification is being handled.
      }
    }
    return self.clients.openWindow(url.href);
  })());
});
