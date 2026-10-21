// sw.js — Fade Empire service worker.
//
// Strategy:
//   * index.html              → network-first (fall back to cache)
//   * Same-origin JS/CSS      → network-first (so deploys propagate immediately)
//   * Same-origin images      → cache-first (the pipeline never rewrites a file in place)
//   * Video                   → left to the browser (range requests need the real server)
//   * Supabase REST / RPC     → network-only (always-fresh availability)
//   * Fonts CDN               → bypass; they manage their own caching
//
// Bump VERSION on every client release. The new worker skips waiting and
// claims open tabs; scripts/main.js reloads a tab that was already controlled
// by an older worker. Caches from any other version are deleted on activate.

const VERSION = 'fe-16';
const STATIC_CACHE = `fe-static-${VERSION}`;
const HTML_CACHE   = `fe-html-${VERSION}`;

const PRECACHE = [
  '/',
  '/index.html',
  '/404.html',
  '/manifest.webmanifest',
  '/scripts/vendor/postgrest-js-1.16.3.mjs',
  '/scripts/nav.js',
  '/scripts/page.js',
  '/scripts/booking-return.js',
  '/scripts/booking-calendar.js',
  '/assets/img/hassan-face-160.webp',
  '/assets/img/hassan-face-160.jpg',
  '/assets/img/larry-face-160.webp',
  '/assets/img/larry-face-160.jpg',
  '/assets/img/interior-480.webp',
  '/assets/img/interior-480.jpg',
  '/assets/brand/logo-full-240.png',
  '/assets/brand/logo-full-480.png',
  '/assets/img/shop-tour-540-poster.jpg',
  '/assets/img/shop-tour-720-poster.jpg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then((c) => c.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== STATIC_CACHE && k !== HTML_CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

function isScriptOrStyle(req, url) {
  if (req.destination === 'script' || req.destination === 'style') return true;
  if (/\.(js|mjs|css)(\?|$)/.test(url.pathname)) return true;
  return false;
}

function isImageOrFont(req) {
  return ['image', 'font'].includes(req.destination);
}

function isVideo(req, url) {
  return req.destination === 'video' || /\.(mp4|webm|mov)$/.test(url.pathname);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Never cache Supabase or anything cross-origin from CDNs we don't manage.
  if (url.hostname.endsWith('supabase.co')) return;
  if (url.hostname.includes('fonts.googleapis.com') ||
      url.hostname.includes('fonts.gstatic.com') ||
      url.hostname.includes('fontshare.com')) {
    return;
  }

  // HTML — network-first
  if (req.mode === 'navigate' || req.destination === 'document') {
    event.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(HTML_CACHE).then((c) => c.put(req, copy));
        return res;
      }).catch(() =>
        caches.match(req).then((r) => r || caches.match('/index.html'))
      )
    );
    return;
  }

  // Same-origin only beyond this point
  if (url.origin !== self.location.origin) return;

  // Video plays through range requests; a cached full response would break
  // seeking and iOS playback, so the browser talks to the server directly.
  if (isVideo(req, url)) return;

  // Same-origin JS/CSS — network-first so deploys propagate immediately.
  // Falls back to cache only if offline.
  if (isScriptOrStyle(req, url)) {
    event.respondWith(
      fetch(req).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(STATIC_CACHE).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => caches.match(req))
    );
    return;
  }

  // Same-origin images/fonts — cache-first (these don't change often)
  if (isImageOrFont(req)) {
    event.respondWith(
      caches.match(req).then((hit) => {
        if (hit) return hit;
        return fetch(req).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(STATIC_CACHE).then((c) => c.put(req, copy));
          }
          return res;
        });
      })
    );
    return;
  }

  // Anything else (manifest, svg, etc.) — try cache, fall back to network
  event.respondWith(
    caches.match(req).then((hit) =>
      hit || fetch(req).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(STATIC_CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
    )
  );
});
