self.addEventListener('push', event => {
  let payload;
  try { payload = event.data?.json(); } catch { return; }
  if (!payload) return;
  event.waitUntil(self.registration.showNotification(payload.title, {
    body: payload.body, icon: '/icon-192.png',
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
    const windows = await self.clients.matchAll({ type: 'window' });
    const staff = windows.find(client => new URL(client.url).pathname.startsWith('/staff'));
    if (staff) {
      await staff.navigate(url.href);
      return staff.focus();
    }
    return self.clients.openWindow(url.href);
  })());
});
