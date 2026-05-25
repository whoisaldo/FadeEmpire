// sw.js — Fade Empire service worker.
//
// Strategy:
//   * `index.html` — network-first (fall back to cache when offline)
//   * `/assets/**`, CSS, JS — cache-first (immutable in practice; bust with ?v= queries)
//   * Supabase REST/RPC — network only (always fresh availability)

const VERSION = 'fe-1';
const STATIC_CACHE = `fe-static-${VERSION}`;
const HTML_CACHE   = `fe-html-${VERSION}`;

const PRECACHE = [
  '/',
  '/index.html',
  '/404.html',
  '/manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== STATIC_CACHE && k !== HTML_CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Never cache Supabase
  if (url.hostname.endsWith('supabase.co')) return;

  // Never cache fonts/CDN that have their own caching
  if (url.hostname.includes('esm.sh') ||
      url.hostname.includes('fonts.googleapis.com') ||
      url.hostname.includes('fonts.gstatic.com') ||
      url.hostname.includes('fontshare.com')) {
    return;
  }

  // HTML: network-first
  if (req.mode === 'navigate' || req.destination === 'document') {
    event.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(HTML_CACHE).then((c) => c.put(req, copy));
        return res;
      }).catch(() => caches.match(req).then((r) => r || caches.match('/index.html')))
    );
    return;
  }

  // Same-origin static: cache-first
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(req).then((hit) => {
        if (hit) return hit;
        return fetch(req).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(STATIC_CACHE).then((c) => c.put(req, copy));
          }
          return res;
        }).catch(() => hit);
      })
    );
  }
});
