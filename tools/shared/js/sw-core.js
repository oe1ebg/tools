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
//
// Development mode is explicit: `just dev-precache` writes the stub
// precache.js { dev: true } (no offline caching; the page says so). Every
// other precache.js that is not a valid manifest (404, syntax error, wrong
// shape, no version, empty file list) is a broken build, not development:
// the install FAILS, so a working installation (worker + cache) is never
// replaced by it, and a first install is reported as failed, not "ready".

const CONFIG = self.OE1EBG_SW;

function readManifest() {
  let m;
  try {
    importScripts('precache.js'); // relative to the tool's sw.js
    m = self[CONFIG.precache];
  } catch (e) {
    return { error: `precache.js nicht ladbar: ${e && e.message ? e.message : e}` };
  }
  if (!m || typeof m !== 'object') return { error: 'precache.js definiert keine Dateiliste' };
  if (m.dev === true) return { dev: true };
  if (typeof m.version !== 'string' || !/^[\w.-]{1,64}$/.test(m.version)) return { error: 'precache.js: ungültige Version' };
  if (!Array.isArray(m.files) || !m.files.length) return { error: 'precache.js: leere Dateiliste' };
  if (!m.files.every(f => typeof f === 'string' && f)) return { error: 'precache.js: ungültiger Dateiname' };
  return { version: m.version, files: m.files };
}

const MANIFEST = readManifest();
const DEV = !!MANIFEST.dev;
const BROKEN = MANIFEST.error || null;
const PRECACHE = DEV || BROKEN ? null : MANIFEST;

const CACHE = PRECACHE ? `${CONFIG.prefix}-${PRECACHE.version}` : `${CONFIG.prefix}-dev`;
const SCOPE = new URL('./', self.location).pathname;
// Paths of the precached files, including those outside the scope: the
// modules and Leaflet from tools/shared/ (published at /tools/shared/,
// listed as ../shared/… in precache.js). A controlled page's requests reach
// this worker whatever their URL, so these are served from the cache like
// everything else.
const FILES = new Set(PRECACHE ? PRECACHE.files.map(f => new URL(f, self.location).pathname) : []);

self.addEventListener('install', event => {
  if (BROKEN) {
    event.waitUntil(Promise.reject(new Error(BROKEN)));
    return;
  }
  if (!PRECACHE) return; // development mode
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

// Reply to the page's 'version' message: { version, mode, ready }. mode is
// 'production' | 'dev' | 'broken'; ready only when every precached file is
// in the cache (the browser can evict it), never in dev or broken mode.
async function status() {
  if (DEV) return { version: null, mode: 'dev', ready: false };
  if (BROKEN) return { version: null, mode: 'broken', ready: false };
  let ready = false;
  if (await caches.has(CACHE)) {
    const have = new Set((await (await caches.open(CACHE)).keys()).map(r => new URL(r.url).pathname));
    ready = [...FILES].every(f => have.has(f));
  }
  return { version: PRECACHE.version, mode: 'production', ready };
}

self.addEventListener('message', event => {
  if (event.data === 'skipWaiting') self.skipWaiting();
  else if (event.data === 'version' && event.ports[0]) {
    const port = event.ports[0];
    status().then(st => port.postMessage(st), () => port.postMessage({ version: PRECACHE ? PRECACHE.version : null, mode: 'broken', ready: false }));
  }
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET' || !PRECACHE) return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Only precached files, and index.html as the tool's start page. Anything
  // else goes to the network untouched, above all the single-file bundle
  // (<tool>-offline.html, not precached): Firefox sends its
  // <a download> click as a navigation, and a navigation fallback to './'
  // made it save the ~30 KB start page instead of the multi-MB file.
  let key;
  if (FILES.has(url.pathname)) key = req;
  else if (req.mode === 'navigate' && url.pathname === `${SCOPE}index.html`) key = './';
  else return;
  event.respondWith((async () => {
    const hit = await (await caches.open(CACHE)).match(key, { ignoreSearch: true });
    if (hit) return hit;
    try {
      return await fetch(req);
    } catch (e) {
      return new Response('Offline und nicht im Cache.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
  })());
});
