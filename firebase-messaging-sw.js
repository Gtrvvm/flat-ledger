/* Background push receiver.
 *
 * This runs even when the app is closed. It has to be at the site root,
 * next to index.html, and it must be named exactly firebase-messaging-sw.js
 * or the Firebase SDK won't find it.
 *
 * The config below is read from the query string the app appends when it
 * registers this worker, so there's nothing to hard-code and nothing secret
 * in here — Firebase web config is public by design.
 */

importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

const params = new URL(self.location).searchParams;
const config = {
  apiKey: params.get('apiKey'),
  projectId: params.get('projectId'),
  messagingSenderId: params.get('senderId'),
  appId: params.get('appId')
};

if (config.projectId) {
  firebase.initializeApp(config);
  const messaging = firebase.messaging();

  messaging.onBackgroundMessage(function (payload) {
    const d = payload.data || {};
    self.registration.showNotification(d.title || 'Flat Ledger', {
      body: d.body || '',
      icon: 'icon-192.png',
      badge: 'icon-192.png',
      tag: d.tag || 'flat-ledger',       // same tag replaces, rather than stacking
      renotify: false,
      data: { url: d.url || './' }
    });
  });
}

// Tapping the notification focuses the app if it's already open.
self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || './';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      for (const c of list) {
        if ('focus' in c) return c.focus();
      }
      if (clients.openWindow) return clients.openWindow(target);
    })
  );
});
