/* lofy — service worker
   App-shell caching. Network-first for HTML, cache-first for static assets. */

const VERSION = 'lofy-v1.1.3';
const CACHE_NAME = `lofy-cache-${VERSION}`;

const APP_SHELL = [
  './',
  './index.html',
  './app.html',
  './offline.html',
  './manifest.json',
  './browserconfig.xml',
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
  './js/share.js',
  './js/demo-audio.js',
  './js/recorder.js',
  './js/modes/spectrum.js',
  './js/modes/flash.js',
  './js/modes/particles.js',
  './assets/favicon.svg',
  './assets/icon.svg',
  './assets/icon-192.png',
  './assets/icon-512.png',
  './assets/og-image.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // allSettled — single 404 must not break install
      Promise.allSettled(APP_SHELL.map((u) => cache.add(u))).then((results) => {
        const failed = results.filter((r) => r.status === 'rejected');
        if (failed.length) console.warn('[sw] failed to precache', failed.length, 'urls');
      }),
    ).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Enable navigation preload for faster nav fetches
      if (self.registration.navigationPreload) {
        try { await self.registration.navigationPreload.enable(); } catch {}
      }
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Cross-origin (Google Fonts, etc.) — network-first with cache fallback.
  // Cache-first would freeze fonts forever; this lets updates land while
  // staying functional offline.
  if (url.origin !== self.location.origin){
    event.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((c) => c.put(req, copy)).catch(()=>{});
        return res;
      }).catch(() => caches.match(req)),
    );
    return;
  }

  if (req.mode === 'navigate' || req.destination === 'document'){
    // network-first for HTML; falls back to cache then offline page.
    event.respondWith((async () => {
      try {
        const preload = await event.preloadResponse;
        if (preload){
          caches.open(CACHE_NAME).then((c) => c.put(req, preload.clone())).catch(()=>{});
          return preload;
        }
        const res = await fetch(req);
        const copy = res.clone();
        caches.open(CACHE_NAME).then((c) => c.put(req, copy)).catch(()=>{});
        return res;
      } catch {
        const hit = await caches.match(req);
        if (hit) return hit;
        return (await caches.match('./offline.html')) || (await caches.match('./index.html'));
      }
    })());
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
