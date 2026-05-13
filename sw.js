/* lofy — service worker
   App-shell caching. Network-first for HTML, cache-first for static assets. */

const VERSION = 'lofy-v1.0.4';
const CACHE_NAME = `lofy-cache-${VERSION}`;

const APP_SHELL = [
  './',
  './index.html',
  './app.html',
  './manifest.json',
  './css/main.css',
  './css/landing.css',
  './css/app.css',
  './js/landing.js',
  './js/app.js',
  './js/audio.js',
  './js/visualizer.js',
  './js/bpm.js',
  './js/controls.js',
  './js/palettes.js',
  './js/presets.js',
  './js/modes/spectrum.js',
  './js/modes/flash.js',
  './js/modes/particles.js',
  './assets/favicon.svg',
  './assets/icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))),
    ).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Same-origin only for cache strategy
  if (url.origin !== self.location.origin){
    // pass through for fonts etc — try cache first then network
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((c) => c.put(req, copy)).catch(()=>{});
        return res;
      }).catch(() => hit)),
    );
    return;
  }

  if (req.mode === 'navigate' || req.destination === 'document'){
    // network-first for HTML so updates land fast
    event.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((c) => c.put(req, copy)).catch(()=>{});
        return res;
      }).catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html'))),
    );
    return;
  }

  // cache-first for static assets
  event.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((c) => c.put(req, copy)).catch(()=>{});
        return res;
      });
    }),
  );
});
