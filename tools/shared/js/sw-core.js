// Service worker logic shared by the offline tools (confirm, notfunk):
// cache-first, so after the first visit a tool never needs the network
// again. Each tool's sw.js sets self.OE1EBG_SW = { prefix, precache } and
// then importScripts() this file: `prefix` names the caches (each tool only
// ever deletes its own), `precache` the global its generated precache.js
// defines ({ version, files }, scripts/offline_tool.py).
//
// Browsers byte-compare importScripts() dependencies on update checks, so a
// new build (new version hash in precache.js) is detected even though the
// worker files themselves are unchanged. A new version installs in the
// background but only takes over when the user clicks "Update" in the page
// (message 'skipWaiting', shared/js/offline.js): nothing ever changes in the
// middle of a net.

const CONFIG = self.OE1EBG_SW;
let PRECACHE = null;
try {
  importScripts('precache.js'); // relative to the tool's sw.js
  PRECACHE = self[CONFIG.precache];
} catch (e) {
  // Dev server without a build (zensical serve): no precache list, so no
  // offline caching: the page shows "offline bereit (dev)".
}

const CACHE = PRECACHE ? `${CONFIG.prefix}-${PRECACHE.version}` : `${CONFIG.prefix}-dev`;
const SCOPE = new URL('./', self.location).pathname;
// Precached files outside the scope: the modules and Leaflet from
// tools/shared/ (published at /shared/, listed as ../shared/… in
// precache.js). A controlled page's requests reach this worker whatever
// their URL, so these are served from the cache like everything else.
const EXTRA = new Set(PRECACHE ? PRECACHE.files.map(f => new URL(f, self.location).pathname).filter(p => !p.startsWith(SCOPE)) : []);

self.addEventListener('install', event => {
  if (!PRECACHE) return;
  event.waitUntil(
    caches.open(CACHE).then(cache =>
      // cache: 'reload' bypasses the HTTP cache so we never pin stale files.
      cache.addAll(PRECACHE.files.map(f => new Request(f, { cache: 'reload' })))),
  );
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith(`${CONFIG.prefix}-`) && key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data === 'skipWaiting') self.skipWaiting();
  else if (event.data === 'version' && event.ports[0]) {
    event.ports[0].postMessage({ version: PRECACHE ? PRECACHE.version : null });
  }
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || !(url.pathname.startsWith(SCOPE) || EXTRA.has(url.pathname))) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    let hit = await cache.match(req, { ignoreSearch: true });
    if (!hit && req.mode === 'navigate') hit = await cache.match('./');
    if (hit) return hit;
    try {
      return await fetch(req);
    } catch (e) {
      return new Response('Offline und nicht im Cache.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
  })());
});
