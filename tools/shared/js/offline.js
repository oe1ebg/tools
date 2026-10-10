// Offline readiness of a tool page: registers the tool's sw.js (cache-first,
// shared/js/sw-core.js), shows "offline bereit" and the version, and offers
// a new version only on the user's click ("Update"). An update reloads every
// open tab of the tool, since the old cache is gone; the page saves what is
// being typed first (beforeReload) and does NOT update or reload when that
// save fails. Updates are looked for on reconnect, when the page comes back
// to the foreground and hourly, never required.

import { $, el, fill } from './dom.js';
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

// What the chip says for the active worker's reply to 'version'
// ({ version, mode, ready }, sw-core.js). Ready only with a complete cache;
// no answer or a broken worker is never "ready".
export function offlineStatus(reply) {
  if (reply && reply.mode === 'production' && reply.version) {
    if (reply.ready) return { text: 'offline bereit ✓', cls: 'ok' };
    return { text: 'offline nicht bereit', cls: 'err', title: 'Der Offline-Speicher ist unvollständig (vom Browser geleert?). Einmal mit Internet neu laden.' };
  }
  if (reply && reply.mode === 'dev') {
    return { text: 'Entwicklungsmodus (nicht offline)', cls: 'warn', title: 'Dieser Server liefert keine Dateiliste (precache.js ist ein Entwicklungs-Stub): nichts wird für offline gespeichert.' };
  }
  // a worker from before replies had a mode: { version } (null meant dev)
  if (reply && !reply.mode) return reply.version ? { text: 'offline bereit ✓', cls: 'ok' } : offlineStatus({ mode: 'dev' });
  return { text: 'offline nicht bereit', cls: 'err', title: 'Die Offline-Dateiliste ist fehlerhaft oder der Service Worker antwortet nicht.' };
}

// The save hook (beforeReload) contract: it resolves `true` when everything
// typed is safe in storage (or there was nothing to save). `false`, any other
// value or a rejection means the save FAILED: the update/reload then does not
// happen (tools/shared/README.md, "Save hook").
export async function saveSucceeded(beforeReload) {
  try {
    return (await beforeReload()) === true;
  } catch (e) {
    console.warn('Sichern vor dem Update fehlgeschlagen', e);
    return false;
  }
}

// Registers sw.js and runs the update flow. opts:
//   build        the tool's build info ({ commit, version }, build-info.js)
//   beforeReload async; save what is being typed before a reload. Resolves
//                true when saved, false/rejects when not (see saveSucceeded)
//   fileHidden   selectors of the online-only parts, hidden in the
//                single-file version (file://)
// Page elements it uses: #st-offline (chip), #st-version, #btn-update. It
// adds #st-update (chip: update check/installation failed) after
// #btn-update and #update-problem (banner: update held back because the
// save failed) after the header.
export async function initOffline({ build = null, beforeReload = async () => true, fileHidden = [] } = {}) {
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
    setChip('#st-offline', 'Offline-Einrichtung fehlgeschlagen', 'err');
    return;
  }
  // An update replaces a controller this page already had. Without one,
  // a controllerchange is just the first install claiming the page.
  let hadController = !!navigator.serviceWorker.controller;
  let updating = false;
  let reloading = false;
  let attempting = false;
  let forced = false;

  const updChip = el('span', { id: 'st-update', class: 'chip warn', role: 'status', hidden: true });
  ($('#btn-update') || $('#st-offline')).after(updChip);
  const setUpdateNote = (text, title) => {
    updChip.hidden = !text;
    updChip.textContent = text || '';
    updChip.title = title || '';
  };
  const problem = el('div', { id: 'update-problem', class: 'banner err', role: 'alert', hidden: true });
  ($('#site-header') || document.body.firstElementChild).after(problem);
  const hideProblem = () => { problem.hidden = true; problem.replaceChildren(); };

  // Run `action` (reload, or telling the new worker to take over) only when
  // the save hook reports success. On failure nothing happens: the page, the
  // old worker and its cache stay, the input stays in the form, and the
  // banner says what to do. "Trotzdem aktualisieren" (asks to confirm) is the
  // one explicit way past it.
  const afterSave = async (action, what) => {
    if (attempting) return;
    attempting = true;
    let ok;
    try {
      ok = forced || await saveSucceeded(beforeReload);
    } finally {
      attempting = false;
    }
    if (ok) { hideProblem(); action(); return; }
    fill(problem,
      el('strong', {}, `${what} nicht ausgeführt: `),
      'Die laufende Eingabe konnte nicht gesichert werden. Sie bleibt in diesem Fenster erhalten. ',
      'Sichere sie zuerst (Text kopieren oder die Sicherung/den Export des Werkzeugs nutzen) und versuche es dann erneut.',
      el('button', { type: 'button', id: 'btn-update-retry', onclick: () => afterSave(action, what) }, 'Erneut versuchen'),
      el('button', { type: 'button', id: 'btn-update-anyway', onclick: () => {
        if (!globalThis.confirm('Nicht gesicherte Eingaben gehen verloren. Trotzdem aktualisieren?')) return;
        forced = true;
        hideProblem();
        action();
      } }, 'Trotzdem aktualisieren'));
    problem.hidden = false;
  };

  const reloadForUpdate = () => {
    if (reloading) return;
    afterSave(() => { reloading = true; location.reload(); }, 'Neuladen');
  };
  const offerUpdate = () => {
    if (!reg.waiting || !navigator.serviceWorker.controller) return;
    setUpdateNote('');
    const btn = $('#btn-update');
    btn.hidden = false;
    btn.onclick = () => {
      // Another tab may have activated it meanwhile: then only reload.
      if (!reg.waiting) return reloadForUpdate();
      afterSave(() => { updating = true; reg.waiting.postMessage('skipWaiting'); }, 'Update');
    };
  };
  const watch = w => w?.addEventListener('statechange', () => {
    if (w.state === 'installed') offerUpdate();
    if (w.state === 'activated') reportOfflineVersion();
    if (w.state === 'redundant') {
      // installation failed (broken manifest, files missing, network)
      if (navigator.serviceWorker.controller) {
        setUpdateNote('Update fehlgeschlagen', 'Die neue Version konnte nicht geladen werden. Die installierte Version läuft weiter.');
      } else if (!reg.active) {
        setChip('#st-offline', 'Offline-Einrichtung fehlgeschlagen', 'err');
        $('#st-offline').title = 'Der Offline-Speicher konnte nicht eingerichtet werden (Dateiliste fehlerhaft oder Dateien nicht ladbar). Seite mit Internet neu laden.';
      }
    }
  });
  reg.addEventListener('updatefound', () => watch(reg.installing));
  // The browser's own update check may have started before this listener.
  watch(reg.installing);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // Update clicked here, or in another tab of this tool: the old cache is
    // gone, so every open tab must load the new version (draft kept; if the
    // save fails the page stays and the banner explains).
    if (updating || hadController) reloadForUpdate();
    else reportOfflineVersion();
    hadController = true;
  });
  offerUpdate();
  reportOfflineVersion();
  checkOldInstall();
  // Look for a new version when we (re)gain connectivity, when the page comes
  // back to the foreground (an installed app resumes without a reload) and
  // hourly while it stays open — never required.
  let lastCheck = 0;
  const check = () => {
    if (!navigator.onLine || Date.now() - lastCheck < 60e3) return;
    lastCheck = Date.now();
    reg.update().then(() => { if (!reg.waiting) setUpdateNote(''); }, e => {
      console.warn('Update-Prüfung fehlgeschlagen', e);
      setUpdateNote('Update-Prüfung fehlgeschlagen', 'Der Server war nicht erreichbar oder lieferte eine fehlerhafte Version. Die installierte Version läuft weiter.');
    });
  };
  window.addEventListener('online', check);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    // resumed: a new version may have been installed meanwhile
    offerUpdate();
    check();
  });
  setInterval(check, 60 * 60e3);
  check();
}

// An install from before the tools moved to /tools/<tool>/ (scope /<tool>/,
// now served by shared/js/sw-move.js) still in this browser: the data is
// per origin and already here, so offer to remove the old worker and its
// caches (<tool>-<hash>; this app's are tools-<tool>-…). Page elements:
// #old-install (hidden), #old-install-text, #btn-old-remove, #btn-old-later.
async function checkOldInstall() {
  const m = /\/tools\/([^/]+)\//.exec(location.pathname);
  const box = $('#old-install');
  if (!m || !box || !navigator.serviceWorker.getRegistrations) return;
  const oldScope = new URL(`/${m[1]}/`, location.href).href;
  let reg;
  try {
    reg = (await navigator.serviceWorker.getRegistrations()).find(r => r.scope === oldScope);
  } catch (e) {
    return;
  }
  if (!reg) return;
  box.hidden = false;
  $('#btn-old-later').onclick = () => { box.hidden = true; };
  $('#btn-old-remove').onclick = async () => {
    try {
      await reg.unregister();
      for (const key of await caches.keys()) {
        if (key.startsWith(`${m[1]}-`)) await caches.delete(key);
      }
    } catch (e) {
      console.warn('Alte Installation nicht entfernt', e);
      return;
    }
    $('#old-install-text').textContent = 'Alte Installation entfernt. Ein altes Symbol auf dem Startbildschirm kannst du jetzt löschen.';
    $('#btn-old-remove').hidden = true;
    $('#btn-old-later').textContent = 'OK';
  };
}

function reportOfflineVersion() {
  const ctl = navigator.serviceWorker && navigator.serviceWorker.controller;
  if (!ctl) {
    setChip('#st-offline', 'offline: wird eingerichtet…', 'warn');
    return;
  }
  const ch = new MessageChannel();
  let answered = false;
  ch.port1.onmessage = ev => {
    answered = true;
    const st = offlineStatus(ev.data);
    setChip('#st-offline', st.text, st.cls);
    $('#st-offline').title = st.title || '';
    showVersion(ev.data && ev.data.version);
  };
  ctl.postMessage('version', [ch.port2]);
  // a worker that never answers is not "ready" either
  setTimeout(() => { if (!answered) setChip('#st-offline', 'offline nicht bereit', 'err'); }, 10e3);
}
