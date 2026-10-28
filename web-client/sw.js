// Service worker: caches the app shell so the PWA opens instantly and shows its own "PC offline"
// state when the network is down. API/WebSocket traffic is never cached.
const CACHE = 'pr-shell-v1';
const SHELL = [
  './', 'index.html', 'app.css', 'app.js', 'manifest.webmanifest',
  'lib/idb.js', 'lib/identity.js', 'lib/session.js', 'lib/surface.js', 'lib/jog.js',
  'shared/protocol.js', 'shared/mapping.js', 'shared/commands.js',
  'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

// network first (always newest code when online), cache as offline fallback
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || !url.pathname.startsWith('/app/')) return;
  e.respondWith(
    fetch(e.request)
      .then((r) => {
        if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
        return r;
      })
      .catch(() => caches.match(e.request)),
  );
});
