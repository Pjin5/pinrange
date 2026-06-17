// Minimal offline cache so PinRange works on the course without signal.
const CACHE = 'pinrange-v13';
const ASSETS = [
  './', './index.html', './style.css', './app.js', './rangefinder.js',
  './manifest.webmanifest', './icons/icon.svg',
];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) =>
    Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
// NETWORK-FIRST: always fetch fresh when online (so code updates show up
// immediately), fall back to cache only when offline (on the course).
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(e.request))
  );
});
