// sw.js — Fade Empire service worker.
//
// Strategy:
//   * `index.html`              → network-first (fall back to cache)
//   * Same-origin JS/CSS        → network-first (so deploys propagate immediately)
//   * Same-origin images / SVG  → cache-first (immutable in practice)
//   * Supabase REST / RPC       → network-only (always-fresh availability)
//   * Fonts CDN, esm.sh         → bypass — they manage their own caching
//
// VERSION bump on every meaningful client release. New SW skips waiting and
// claims existing clients, so a tab reload picks it up. Old caches get nuked
// in the `activate` event.

const VERSION = 'fe-8';
const STATIC_CACHE = `fe-static-${VERSION}`;
const HTML_CACHE   = `fe-html-${VERSION}`;

// Known-old version caches to nuke aggressively on activate. The generic
// "delete everything not matching the current name" loop below covers these,
// but listing them explicitly is belt-and-suspenders for devices that
// somehow accumulate multiple stale generations.
const KNOWN_OLD = [
  'fe-static-fe-1', 'fe-html-fe-1',
  'fe-static-fe-2', 'fe-html-fe-2',
  'fe-static-fe-3', 'fe-html-fe-3',
  'fe-static-fe-4', 'fe-html-fe-4',
  'fe-static-fe-5', 'fe-html-fe-5',
  'fe-static-fe-6', 'fe-html-fe-6',
  'fe-static-fe-7', 'fe-html-fe-7',
];

const PRECACHE = [
  '/',
  '/index.html',
  '/404.html',
  '/manifest.webmanifest',
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
    Promise.all([
      // Belt: aggressively delete known-old caches by name.
      ...KNOWN_OLD.map((k) => caches.delete(k)),
      // Suspenders: generic cleanup of anything not on the current generation.
      caches.keys().then((keys) =>
        Promise.all(
          keys.filter((k) => k !== STATIC_CACHE && k !== HTML_CACHE)
              .map((k) => caches.delete(k))
        )
      ),
    ]).then(() => self.clients.claim())
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

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Never cache Supabase or anything cross-origin from CDNs we don't manage.
  if (url.hostname.endsWith('supabase.co')) return;
  if (url.hostname.includes('esm.sh') ||
      url.hostname.includes('fonts.googleapis.com') ||
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
