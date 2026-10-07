// Offline readiness of a tool page: registers the tool's sw.js (cache-first,
// shared/js/sw-core.js), shows "offline bereit" and the version, and offers
// a new version only on the user's click ("Update"). An update reloads every
// open tab of the tool, since the old cache is gone; the page saves what is
// being typed first (beforeReload). Updates are looked for on reconnect, when
// the page comes back to the foreground and hourly, never required.

import { $, fill } from './dom.js';
import { versionItems } from './sources.js';

export function setChip(id, text, cls) {
  const c = $(id);
  c.textContent = text;
  c.className = 'chip' + (cls ? ' ' + cls : '');
}

// Footer version from build-info.js (or inlined in the offline file); the
// active service worker's content hash overrides the data part, since that
// is the version actually served from the cache.
let offlineBuild = null;
function showVersion(swVersion) {
  fill($('#st-version'), versionItems(offlineBuild, swVersion));
}

// Registers sw.js and runs the update flow. opts:
//   build        the tool's build info ({ commit, version }, build-info.js)
//   beforeReload async; save what is being typed before a reload
//   fileHidden   selectors of the online-only parts, hidden in the
//                single-file version (file://)
// Page elements it uses: #st-offline (chip), #st-version, #btn-update.
export async function initOffline({ build = null, beforeReload = async () => {}, fileHidden = [] } = {}) {
  offlineBuild = build;
  showVersion();
  if (location.protocol === 'file:') {
    setChip('#st-offline', 'Offline-Datei', 'ok');
    for (const sel of fileHidden) { const n = $(sel); if (n) n.hidden = true; }
    return;
  }
  if (!('serviceWorker' in navigator)) {
    setChip('#st-offline', 'nicht offline-fähig', 'err');
    return;
  }
  let reg;
  try {
    reg = await navigator.serviceWorker.register('sw.js');
  } catch (e) {
    console.warn('Service Worker nicht registriert', e);
    setChip('#st-offline', 'nicht offline-fähig', 'err');
    return;
  }
  // An update replaces a controller this page already had. Without one,
  // a controllerchange is just the first install claiming the page.
  let hadController = !!navigator.serviceWorker.controller;
  let updating = false;
  let reloading = false;
  const reloadForUpdate = async () => {
    if (reloading) return;
    reloading = true;
    await beforeReload();
    location.reload();
  };
  const offerUpdate = () => {
    if (!reg.waiting || !navigator.serviceWorker.controller) return;
    const btn = $('#btn-update');
    btn.hidden = false;
    btn.onclick = async () => {
      // Another tab may have activated it meanwhile: then only reload.
      if (!reg.waiting) return reloadForUpdate();
      updating = true;
      await beforeReload();
      reg.waiting.postMessage('skipWaiting');
    };
  };
  const watch = w => w?.addEventListener('statechange', () => {
    if (w.state === 'installed') offerUpdate();
    if (w.state === 'activated') reportOfflineVersion();
  });
  reg.addEventListener('updatefound', () => watch(reg.installing));
  // The browser's own update check may have started before this listener.
  watch(reg.installing);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // Update clicked here, or in another tab of this tool: the old cache is
    // gone, so every open tab must load the new version (draft kept).
    if (updating || hadController) reloadForUpdate();
    else reportOfflineVersion();
    hadController = true;
  });
  offerUpdate();
  reportOfflineVersion();
  // Look for a new version when we (re)gain connectivity, when the page comes
  // back to the foreground (an installed app resumes without a reload) and
  // hourly while it stays open — never required.
  let lastCheck = 0;
  const check = () => {
    if (!navigator.onLine || Date.now() - lastCheck < 60e3) return;
    lastCheck = Date.now();
    reg.update().catch(() => {});
  };
  window.addEventListener('online', check);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') check();
  });
  setInterval(check, 60 * 60e3);
  check();
}

function reportOfflineVersion() {
  const ctl = navigator.serviceWorker && navigator.serviceWorker.controller;
  if (!ctl) {
    setChip('#st-offline', 'offline: wird eingerichtet…', 'warn');
    return;
  }
  const ch = new MessageChannel();
  ch.port1.onmessage = ev => {
    const v = ev.data && ev.data.version;
    setChip('#st-offline', v ? 'offline bereit ✓' : 'offline bereit (dev)', v ? 'ok' : 'warn');
    showVersion(v);
  };
  ctl.postMessage('version', [ch.port2]);
}
