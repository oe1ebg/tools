// Storage notices of the offline tools (UI): what openToolStorage()
// reports while opening (another tab blocks the upgrade, another tab took
// the database over) and the offer to move records a session without
// IndexedDB left in the localStorage fallback. All in the page's banner.

import { el, fill } from './dom.js';

function showStorageBanner(banner, cls, ...content) {
  banner.className = `banner ${cls}`;
  fill(banner, ...content);
  banner.hidden = false;
}

const reloadButton = () => el('button', { type: 'button', onclick: () => location.reload() }, 'Neu laden');

// open(hooks): the tool's openStorage(); resolves to its result.
export async function openStorageWithNotices(open, banner) {
  let waited = false;
  const store = await open({
    onBlocked() {
      waited = true;
      showStorageBanner(banner, 'warn', 'Warte auf die Datenbank: ein anderer Tab dieses Werkzeugs hat noch eine ältere Version offen. '
        + 'Bitte jenen Tab schließen oder neu laden, dann geht es hier von selbst weiter.');
    },
    onClosed() {
      showStorageBanner(banner, 'err', 'Die Datenbank wurde von einem anderen Tab (neuere Version) übernommen, hier kann nichts mehr gespeichert werden. '
        + 'Bitte diese Seite neu laden.', reloadButton());
    },
  });
  if (waited) banner.hidden = true;
  return store;
}

// IndexedDB is in use, but the localStorage fallback still holds records:
// offer to copy them over (store.migrateFallback(); nothing in IndexedDB
// is overwritten, what can't be copied stays in the fallback).
export async function offerFallbackMigration(store, banner) {
  let found = null;
  try {
    found = await store.fallbackData();
  } catch (e) {
    console.warn(e);
  }
  if (!found || !found.total) return;
  const run = async ev => {
    ev.currentTarget.disabled = true;
    try {
      const r = await store.migrateFallback();
      const moved = r.copied + r.merged;
      showStorageBanner(banner, r.kept.length ? 'warn' : 'ok',
        `${moved} Datensätze aus dem Ersatzspeicher übernommen`,
        r.identical ? `, ${r.identical} waren schon vorhanden` : '',
        r.kept.length ? `; ${r.kept.length} weichen von den gespeicherten ab und bleiben im Ersatzspeicher (localStorage).` : '.',
        ' Zum Anzeigen bitte neu laden.', reloadButton());
    } catch (e) {
      console.error(e);
      showStorageBanner(banner, 'err', 'Übernahme fehlgeschlagen, nichts wurde geändert: ',
        el('small', {}, String(e && (e.name || e.message) || e)));
    }
  };
  showStorageBanner(banner, 'warn',
    `Im Ersatzspeicher (localStorage) liegen noch ${found.total} Datensätze aus einer Sitzung ohne IndexedDB; sie werden hier nicht angezeigt.`,
    el('button', { type: 'button', onclick: run }, 'In IndexedDB übernehmen'));
}
