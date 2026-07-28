const CACHE_NAME = 'boomtown-crew-v4';
const SHELL_ASSETS = ['./', './index.html', './manifest.json', './icons/icon-192.png', './icons/icon-512.png'];
// Firebase's SDK scripts are loaded from a cross-origin CDN with plain <script>
// tags, so responses for them are opaque (no CORS headers requested) - cache.addAll
// rejects on those for some engines, so they're fetched+cached separately below
// with an explicit no-cors mode instead of being mixed into SHELL_ASSETS.
const EXTERNAL_ASSETS = [
  'https://www.gstatic.com/firebasejs/10.13.0/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/10.13.0/firebase-database-compat.js',
  'https://www.gstatic.com/firebasejs/10.13.0/firebase-auth-compat.js',
  'https://www.gstatic.com/firebasejs/10.13.0/firebase-storage-compat.js',
  'https://www.gstatic.com/firebasejs/10.13.0/firebase-messaging-compat.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => Promise.all([
      cache.addAll(SHELL_ASSETS),
      ...EXTERNAL_ASSETS.map(url =>
        fetch(url, {mode: 'no-cors'}).then(res => cache.put(url, res)).catch(() => {})
      )
    ])).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if(req.method !== 'GET') return;

  // The app shell itself (the HTML page) always tries the network first, so a
  // fresh deploy shows up on the very next load instead of getting masked by
  // a stale cached copy - only falling back to cache if truly offline. Other
  // static assets stay cache-first for speed and offline resilience, since
  // they change far less often and matter more when signal is bad on-site.
  if(req.mode === 'navigate' || req.destination === 'document'){
    event.respondWith(
      fetch(req).then(res => {
        if(res && res.status === 200){
          const resClone = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(req, resClone));
        }
        return res;
      }).catch(() => caches.match(req))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then(cached => {
      const networkFetch = fetch(req).then(res => {
        // opaque (status 0) responses show up for cross-origin requests made
        // without CORS, like the Firebase SDK <script> tags - still worth
        // caching so they're available offline, we just can't inspect them
        if(res && (res.status === 200 || res.type === 'opaque')){
          const resClone = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(req, resClone));
        }
        return res;
      }).catch(() => cached);
      return cached || networkFetch;
    })
  );
});

// ---------------------------------------------------------------------
// Background push notifications (Firebase Cloud Messaging)
//
// This is folded into the app's own service worker rather than a separate
// firebase-messaging-sw.js, deliberately - only one service worker can
// actually control a given scope, and this app already registers this file
// at the root scope for offline caching. Registering a second one would
// mean one silently replaces the other as the controller for that scope,
// breaking the offline support built above. Firebase supports pointing
// getToken() at an existing service worker registration instead of
// auto-registering its own, which is what the app does (see
// requestPushToken() in index.html).
// ---------------------------------------------------------------------
try {
  importScripts('https://www.gstatic.com/firebasejs/10.13.0/firebase-app-compat.js');
  importScripts('https://www.gstatic.com/firebasejs/10.13.0/firebase-messaging-compat.js');

  firebase.initializeApp({
    apiKey: 'AIzaSyBfdRk5KUGINJtpAehZweLfLevx602GtGI',
    authDomain: 'boomtown-yourcrew.firebaseapp.com',
    databaseURL: 'https://boomtown-yourcrew-default-rtdb.europe-west1.firebasedatabase.app',
    projectId: 'boomtown-yourcrew',
    storageBucket: 'boomtown-yourcrew.firebasestorage.app',
    messagingSenderId: '40912478731',
    appId: '1:40912478731:web:b6a65954bcbc0aff0a5d0e'
  });

  const messaging = firebase.messaging();
  messaging.onBackgroundMessage((payload) => {
    const title = (payload.notification && payload.notification.title) || 'Boomtown Crew';
    const body = (payload.notification && payload.notification.body) || '';
    self.registration.showNotification(title, {
      body,
      icon: './icons/icon-192.png',
      badge: './icons/icon-192.png',
      data: payload.data || {}
    });
  });
} catch (e) {
  // FCM isn't available in every browser/context (e.g. some in-app
  // browsers) - the rest of this service worker (offline caching) still
  // needs to work regardless of whether push notifications do
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({type: 'window', includeUncontrolled: true}).then(clientsArr => {
      const existing = clientsArr.find(c => c.url.includes(self.registration.scope) && 'focus' in c);
      if(existing) return existing.focus();
      return self.clients.openWindow('./');
    })
  );
});
