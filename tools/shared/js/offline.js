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
    return { text: 'offline nicht bereit', cls: 'err', title: 'Der Offline-Speicher ist unvollständig (vom Browser geleert?). Mit Internet geöffnet, wird die Offline-Kopie automatisch repariert.' };
  }
  if (reply && reply.mode === 'dev') {
    return { text: 'Entwicklungsmodus (nicht offline)', cls: 'warn', title: 'Dieser Server liefert keine Dateiliste (precache.js ist ein Entwicklungs-Stub): nichts wird für offline gespeichert.' };
  }
  // a worker from before replies had a mode: { version } (null meant dev)
  if (reply && !reply.mode) return reply.version ? { text: 'offline bereit ✓', cls: 'ok' } : offlineStatus({ mode: 'dev' });
  return { text: 'offline nicht bereit', cls: 'err', title: 'Die Offline-Dateiliste ist fehlerhaft oder der Service Worker antwortet nicht.' };
}

// The save hook (beforeReload) contract: it resolves `true` when everything
// typed is safe in storage (or there was nothing to save, or what is not
// saved is already stored elsewhere and unchanged). Anything else means the
// save FAILED and the update/reload does not happen: `false`, another value,
// a rejection, or, to say why and what the user can do, a string, { message }
// or { message, actions: [{ label, run }], discards } (German, about the
// actual risk; the banner shows the message and one button per action, and
// `discards` names what "Trotzdem aktualisieren" would lose). After an
// action's run() resolves the save is checked again and the update goes on
// if it now succeeds. tools/shared/README.md, "Save hook".
export async function runSaveHook(beforeReload) {
  try {
    const r = await beforeReload();
    if (r === true) return { ok: true, message: '', actions: [], discards: '' };
    const obj = r && typeof r === 'object' ? r : {};
    const message = typeof r === 'string' ? r : (typeof obj.message === 'string' ? obj.message : '');
    const actions = Array.isArray(obj.actions)
      ? obj.actions.filter(a => a && typeof a.label === 'string' && typeof a.run === 'function')
      : [];
    return { ok: false, message, actions, discards: typeof obj.discards === 'string' ? obj.discards : '' };
  } catch (e) {
    console.warn('Sichern vor dem Update fehlgeschlagen', e);
    return { ok: false, message: '', actions: [], discards: '' };
  }
}
export async function saveSucceeded(beforeReload) {
  return (await runSaveHook(beforeReload)).ok;
}

// Registers sw.js and runs the update flow. opts:
//   build        the tool's build info ({ commit, version }, build-info.js)
//   beforeReload async; save what is being typed before a reload. Resolves
//                true when saved, otherwise a failure, optionally with a
//                message and actions (see runSaveHook)
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
  let busy = false; // a save check or an action of the banner is running
  let queued = null; // [action, what, intro] that arrived meanwhile (e.g. a controllerchange)
  let forceReload = false; // "Trotzdem aktualisieren" of a local update: its own controllerchange reloads without the hook
  let asked = false; // skipWaiting sent from here, no controllerchange yet (a newer install may replace that worker)
  let current = null; // { action, what, intro, res } of the banner shown

  const updChip = el('span', { id: 'st-update', class: 'chip warn', role: 'status', hidden: true });
  ($('#btn-update') || $('#st-offline')).after(updChip);
  const setUpdateNote = (text, title) => {
    updChip.hidden = !text;
    updChip.textContent = text || '';
    updChip.title = title || '';
  };
  // The banner is one stable element: its text and buttons are updated in
  // place (only what changed), so focus stays on the button just used and a
  // screen reader hears a changed message, not the same one again.
  const pTitle = el('strong', { id: 'update-problem-title', tabindex: '-1' });
  const pText = el('span', { id: 'update-problem-text' });
  const pNote = el('span', { id: 'update-problem-note' });
  const pCopy = el('textarea', { id: 'update-problem-copy', readonly: true, rows: 4, 'aria-label': 'Text zum Kopieren', hidden: true });
  const pButtons = el('span', { id: 'update-problem-buttons' });
  const problem = el('div', { id: 'update-problem', class: 'banner err', role: 'alert', hidden: true }, pTitle, ' ', pText, ' ', pNote, pCopy, pButtons);
  ($('#site-header') || document.body.firstElementChild).after(problem);
  const setIfChanged = (node, text) => { if (node.textContent !== text) node.textContent = text; };
  // The update button says that the update waits for the user while the
  // banner is up (it may be scrolled out of sight).
  const updateLabel = $('#btn-update')?.textContent;
  let buttonsKey = null;
  const setBusy = on => {
    if (on) problem.setAttribute('aria-busy', 'true');
    else problem.removeAttribute('aria-busy');
    for (const b of pButtons.querySelectorAll('button')) {
      if (on) b.setAttribute('aria-disabled', 'true');
      else b.removeAttribute('aria-disabled');
    }
  };
  const hideProblem = () => {
    problem.hidden = true;
    for (const n of [pTitle, pText, pNote]) n.textContent = '';
    pCopy.hidden = true;
    pCopy.value = '';
    pButtons.replaceChildren();
    buttonsKey = null;
    const btn = $('#btn-update');
    if (btn && updateLabel) btn.textContent = updateLabel;
  };
  // What an action reports: nothing/true = done; false, a string, { message,
  // text } or an exception = it did not work (text is shown to copy by hand).
  const actionFailure = r => {
    if (r === false) return { message: 'Die Aktion ist fehlgeschlagen. ' };
    if (typeof r === 'string') return { message: r };
    if (r && typeof r === 'object' && (r.message || r.text)) return { message: r.message || '', text: r.text || '' };
    return null;
  };
  const showNote = f => {
    setIfChanged(pNote, f ? f.message : '');
    pCopy.hidden = !(f && f.text);
    if (f && f.text) {
      pCopy.value = f.text;
      pCopy.focus();
      pCopy.select();
    }
  };
  // After a finished check or action: what waited meanwhile goes on first.
  const drain = recheck => {
    const q = queued;
    queued = null;
    if (q) afterSave(...q);
    else if (recheck && current) afterSave(current.action, current.what, current.intro);
  };
  const runAction = async i => {
    if (busy) return;
    busy = true;
    setBusy(true);
    let failure;
    try {
      failure = actionFailure(await current.res.actions[i].run());
    } catch (e) {
      console.warn('Aktion vor dem Update fehlgeschlagen', e);
      failure = { message: 'Die Aktion ist fehlgeschlagen. ' };
    }
    busy = false;
    setBusy(false);
    showNote(failure);
    drain(!failure); // the choice is made: check again and go on if it is safe now
  };
  const render = () => {
    const { res, what, intro } = current;
    setIfChanged(pTitle, `${what} nicht ausgeführt: `);
    setIfChanged(pText, `${intro}${res.message || 'Die laufende Eingabe konnte nicht gesichert werden. '}${res.actions.length ? '' : 'Sie bleibt in diesem Fenster erhalten. Sichern Sie sie zuerst (Text kopieren oder die Sicherung/den Export des Werkzeugs nutzen) und versuchen Sie es dann erneut. '}`);
    const key = res.actions.map(a => a.label).join('\n');
    if (key === buttonsKey) return;
    buttonsKey = key;
    const hadFocus = pButtons.contains(document.activeElement);
    pButtons.replaceChildren(
      ...res.actions.map((a, i) => el('button', { type: 'button', class: 'update-action', id: `btn-update-action-${i}`, onclick: () => runAction(i) }, a.label)),
      el('button', { type: 'button', id: 'btn-update-retry', onclick: () => { if (!busy) afterSave(current.action, current.what, current.intro); } }, 'Erneut versuchen'),
      el('button', { type: 'button', id: 'btn-update-anyway', onclick: () => {
        if (busy) return;
        if (!globalThis.confirm(`${current.res.discards || 'Nicht gesicherte Eingaben gehen verloren.'} Trotzdem aktualisieren?`)) return;
        const { action } = current;
        hideProblem();
        action(true);
      } }, 'Trotzdem aktualisieren'),
    );
    if (hadFocus) pButtons.querySelector('button')?.focus();
  };

  // Run `action` (reload, or telling the new worker to take over) only when
  // the save hook reports success. On failure nothing happens: the page, the
  // old worker and its cache stay, the input stays in the form, and the
  // banner says what to do. "Trotzdem aktualisieren" (asks to confirm) is the
  // one explicit way past it, for that one action. A request that arrives
  // while a check or an action runs is kept and handled right after.
  const afterSave = async (action, what, intro = '') => {
    if (busy) { queued = [action, what, intro]; return; }
    busy = true;
    forceReload = false;
    setBusy(true);
    let res;
    try {
      res = await runSaveHook(beforeReload);
    } finally {
      busy = false;
      setBusy(false);
    }
    if (res.ok) { hideProblem(); action(false); drain(false); return; }
    const first = problem.hidden;
    current = { action, what, intro, res };
    render();
    problem.hidden = false;
    const btn = $('#btn-update');
    if (btn) btn.textContent = 'Update wartet: Eingabe klären';
    if (first && what === 'Update') pTitle.focus(); // the user just clicked: take them to the message
    drain(false);
  };

  const doReload = () => { reloading = true; location.reload(); };
  const reloadForUpdate = () => {
    if (reloading) return;
    afterSave(doReload, 'Neuladen', 'Ein anderes Fenster dieses Werkzeugs hat ein Update installiert; diese Seite läuft noch mit der alten Version und muss neu laden, sobald die Eingabe geklärt ist. ');
  };
  // The waiting worker is looked up when the action runs (another tab may
  // have activated it while the banner was up): then only reload. A forced
  // update reloads on its own controllerchange without asking the hook.
  const doUpdate = force => {
    if (!reg.waiting) return doReload();
    updating = true;
    asked = true;
    forceReload = !!force;
    reg.waiting.postMessage('skipWaiting');
  };
  const updateIntro = 'Ein Update wartet; bevor die Seite neu lädt, muss die Eingabe geklärt sein. ';
  // An update waits beside the active version. On the first install, WebKit
  // may already report the claiming worker as controller while it is still
  // the waiting one, with no active worker yet: no update to offer (#36).
  const offerUpdate = () => {
    if (!reg.waiting || !reg.active || !navigator.serviceWorker.controller) return;
    setUpdateNote('');
    const btn = $('#btn-update');
    btn.hidden = false;
    btn.onclick = () => afterSave(doUpdate, 'Update', updateIntro);
  };
  // The worker told to take over activates only once the old one has served
  // its requests; a newer version that finishes installing meanwhile replaces
  // it, and with it the skipWaiting (#41). The update asked for goes on with
  // the newer one: forced as it was, otherwise after another save check (the
  // input may have changed since the click).
  const goOn = () => {
    if (forceReload) doUpdate(true);
    else afterSave(doUpdate, 'Update', updateIntro);
  };
  // One listener per worker: the start and updatefound can both see the same
  // installing worker, and goOn() must run once.
  const watched = new WeakSet();
  const watch = w => {
    if (!w || watched.has(w)) return;
    watched.add(w);
    w.addEventListener('statechange', () => onState(w));
  };
  const onState = w => {
    if (w.state === 'installed') {
      offerUpdate();
      if (asked && reg.waiting === w) goOn();
    }
    if (w.state === 'activated') reportOfflineVersion();
    if (w.state === 'redundant' && !reg.installing && !reg.waiting) {
      // installation failed (not just replaced by a newer install: broken manifest, files missing, network)
      if (navigator.serviceWorker.controller) {
        setUpdateNote('Update fehlgeschlagen', 'Die neue Version konnte nicht geladen werden. Die installierte Version läuft weiter.');
      } else if (!reg.active) {
        setChip('#st-offline', 'Offline-Einrichtung fehlgeschlagen', 'err');
        $('#st-offline').title = 'Der Offline-Speicher konnte nicht eingerichtet werden (Dateiliste fehlerhaft oder Dateien nicht ladbar). Seite mit Internet neu laden.';
      }
    }
  };
  reg.addEventListener('updatefound', () => watch(reg.installing));
  // The browser's own update check may have started before this listener.
  watch(reg.installing);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    asked = false;
    // Update clicked here, or in another tab of this tool: the old cache is
    // gone, so every open tab must load the new version (draft kept; if the
    // save fails the page stays and the banner explains).
    if (forceReload) { forceReload = false; doReload(); }
    else if (updating || hadController) reloadForUpdate();
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
  window.addEventListener('online', () => {
    // back online: an incomplete offline copy gets another repair attempt
    if (navigator.serviceWorker.controller && $('#st-offline').textContent !== 'offline bereit ✓') { repairTried = false; reportOfflineVersion(); }
    check();
  });
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

// An evicted or emptied cache is repaired by the worker when the page is
// online (once per page load and per reconnect): the worker fetches the
// files of its own version again. The chip says what happens.
let repairTried = false;
function repairOfflineCopy(ctl) {
  repairTried = true;
  setChip('#st-offline', 'Offline-Kopie wird repariert…', 'warn');
  const ch = new MessageChannel();
  ch.port1.onmessage = ev => {
    if (ev.data && ev.data.ok) reportOfflineVersion();
    else if (ev.data && ev.data.newer) {
      // the server publishes another release: the normal update path takes over
      setChip('#st-offline', 'Neue Version auf dem Server – bitte aktualisieren', 'warn');
      navigator.serviceWorker.getRegistration().then(r => r && r.update()).catch(() => {});
    } else setChip('#st-offline', 'Reparatur fehlgeschlagen', 'err');
  };
  ctl.postMessage('repair', [ch.port2]);
}

function reportOfflineVersion() {
  const ctl = navigator.serviceWorker && navigator.serviceWorker.controller;
  if (!ctl) {
    setChip('#st-offline', 'offline: lädt…', 'warn');
    return;
  }
  // A worker the browser has stopped needs a moment (or a second message) to
  // wake up: ask again once before saying "nicht bereit", and a late reply
  // still replaces that text.
  let attempt = 0;
  let answered = false;
  const ask = () => {
    const ch = new MessageChannel();
    ch.port1.onmessage = ev => {
      answered = true;
      const st = offlineStatus(ev.data);
      if (ev.data && ev.data.mode === 'production' && !ev.data.ready && navigator.onLine && !repairTried) {
        repairOfflineCopy(ctl);
        return;
      }
      setChip('#st-offline', st.text, st.cls);
      $('#st-offline').title = st.title || '';
      showVersion(ev.data && ev.data.version);
    };
    ctl.postMessage('version', [ch.port2]);
    setTimeout(() => {
      if (answered) return;
      if (++attempt < 2) ask();
      else setChip('#st-offline', 'offline nicht bereit', 'err');
    }, 5e3);
  };
  ask();
}
