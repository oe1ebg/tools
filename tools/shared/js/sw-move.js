// Move worker for installs from before the tools moved to /tools/<tool>/.
// scripts/stage_tools.py publishes it as /confirm/sw.js and /notfunk/sw.js
// (the old worker URLs, exempt from the nginx redirects). An old install
// finds it through its normal update check and, as always, only switches to
// it when the user clicks "Update" (shared/js/offline.js): nothing changes in
// the middle of a net. Then, in the old scope:
//   online:  navigations go to the network, which redirects them (301) to
//            /tools/<tool>/; the data is per origin, so the logs are there.
//   offline: the old app keeps working from its old cache (`<tool>-<hash>`).
//            This worker never deletes a cache; the new app uses its own
//            prefix (`tools-<tool>`) and offers to remove the old install.
// A standalone script without importScripts(): the old shared/ URLs are
// redirected, and a redirected worker import fails.
// Remove after the transition period (about April 2027).

const SCOPE = new URL('./', self.location).pathname;

self.addEventListener('install', () => {
  // No skipWaiting: the old page offers the update (reg.waiting).
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('message', event => {
  if (event.data === 'skipWaiting') self.skipWaiting();
  else if (event.data === 'version' && event.ports[0]) event.ports[0].postMessage({ version: null });
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(async () =>
      (await caches.match(req, { ignoreSearch: true })) || (await caches.match(SCOPE)) || offline()));
  } else {
    // The old app's files (/<tool>/…, /shared/…) from its cache, else the
    // network (which follows the redirect to /tools/…).
    event.respondWith((async () =>
      (await caches.match(req, { ignoreSearch: true })) || fetch(req).catch(offline))());
  }
});

function offline() {
  return new Response('Offline und nicht im Cache.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}
