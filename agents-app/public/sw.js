// App shell cache: pages and code load instantly and work offline; API calls always go to the network.
const CACHE = 'esim-admin-shell-v38';
const SHELL = [
  '/portal',
  '/css/app.css',
  '/icon-192.png',
  '/icon-512.png',
  '/icon.svg',
  '/index.html',
  '/js/catalog-compare.js',
  '/js/chart.js',
  '/js/core.js',
  '/js/exporter.js',
  '/js/main.js',
  '/js/views/buyers.js',
  '/js/views/catalog.js',
  '/js/views/home.js',
  '/js/views/login.js',
  '/js/views/reports.js',
  '/js/views/settings.js',
  '/js/views/shop.js',
  '/js/views/tasks.js',
  '/manifest.webmanifest',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/') || url.pathname === '/' || /^\/shop(\/|$)/.test(url.pathname)) return;
  // Network first so updates show up at once; the cache answers when offline.
  e.respondWith(
    fetch(e.request)
      .then((res) => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); } return res; })
      .catch(() => caches.match(e.request)
        .then((r) => r || caches.match(e.request, { ignoreSearch: true }))
        .then((r) => {
          if (r) return r;
          if (e.request.mode === 'navigate') return caches.match('/portal').then((p) => p || caches.match('/index.html'));
          return new Response('', { status: 503, statusText: 'Offline' });
        })),
  );
});
