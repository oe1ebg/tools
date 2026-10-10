// Storage notices of the offline tools (UI): what openToolStorage()
// reports while opening (another tab blocks the upgrade, another tab took
// the database over) and the offer to move records a session without
// IndexedDB left in the localStorage fallback.
//
// They use their own box (`.storage-note`, inserted after the page's
// banner) and never touch the banner itself, so its classes (`err`,
// `no-print`) stay as the page set them for save errors.

import { el, fill } from './dom.js';

const storageNotes = new WeakMap();

function showStorageNote(anchor, kind, ...content) {
  let note = storageNotes.get(anchor);
  if (!note) {
    note = el('div', { class: 'banner storage-note no-print' });
    anchor.after(note);
    storageNotes.set(anchor, note);
  }
  note.className = `banner storage-note no-print ${kind}`;
  note.setAttribute('role', kind === 'err' ? 'alert' : 'status');
  fill(note, ...content);
  note.hidden = false;
  return note;
}

function hideStorageNote(anchor) {
  const note = storageNotes.get(anchor);
  if (note) note.hidden = true;
}

const reloadButton = () => el('button', { type: 'button', onclick: () => location.reload() }, 'Neu laden');

// open(hooks): the tool's openStorage(); resolves to its result. anchor:
// the page's banner, the notices go right after it.
export async function openStorageWithNotices(open, anchor) {
  let waited = false;
  const store = await open({
    onBlocked() {
      waited = true;
      showStorageNote(anchor, 'warn', 'Warte auf die Datenbank: ein anderer Tab dieses Werkzeugs hat noch eine ältere Version offen. '
        + 'Bitte jenen Tab schließen oder neu laden, dann geht es hier von selbst weiter.');
    },
    onClosed() {
      showStorageNote(anchor, 'err', 'Die Datenbank wurde von einem anderen Tab (neuere Version) übernommen, hier kann nichts mehr gespeichert werden. '
        + 'Bitte diese Seite neu laden.', reloadButton());
    },
  });
  if (waited) hideStorageNote(anchor);
  return store;
}

// The fallback records as a JSON download (nothing is deleted).
async function downloadFallback(store, stores) {
  const data = {};
  for (const name of stores) data[name] = await store.readFallback(name);
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' }));
  const a = el('a', { href: url, download: `ersatzspeicher-${new Date().toISOString().slice(0, 10)}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function keptNotice(store, anchor, found) {
  const n = found.conflicts + found.unreadable;
  showStorageNote(anchor, 'warn',
    `${n} Datensätze im Ersatzspeicher (localStorage) weichen von den gespeicherten ab und wurden nicht übernommen; sie bleiben dort erhalten.`,
    el('button', { type: 'button', onclick: () => downloadFallback(store, Object.keys(found.stores)) }, 'Als JSON sichern'),
    el('button', {
      type: 'button',
      onclick: async () => {
        try { await store.dismissConflicts(); } catch (e) { console.warn(e); }
        hideStorageNote(anchor);
      },
    }, 'Ausblenden'));
}

// IndexedDB is in use, but the localStorage fallback still holds records:
// offer to copy them over (store.migrateFallback(); nothing in IndexedDB
// is overwritten, what can't be copied stays in the fallback). Records it
// can't take are shown apart, with a download, until dismissed.
export async function offerFallbackMigration(store, anchor) {
  let found = null;
  try {
    found = await store.fallbackData();
  } catch (e) {
    console.warn(e);
  }
  if (!found) return;
  if (!found.pending) {
    if (found.conflicts && !found.conflictsSeen) keptNotice(store, anchor, found);
    return;
  }
  const run = async ev => {
    ev.currentTarget.disabled = true;
    try {
      const r = await store.migrateFallback();
      const moved = r.copied + r.merged;
      showStorageNote(anchor, r.kept.length ? 'warn' : 'ok',
        `${moved} Datensätze aus dem Ersatzspeicher übernommen`,
        r.identical ? `, ${r.identical} waren schon vorhanden` : '',
        r.kept.length ? `; ${r.kept.length} weichen von den gespeicherten ab und bleiben im Ersatzspeicher (localStorage).` : '.',
        ' Zum Anzeigen bitte neu laden.', reloadButton());
    } catch (e) {
      console.error(e);
      showStorageNote(anchor, 'err', 'Übernahme fehlgeschlagen, nichts wurde geändert: ',
        el('small', {}, String(e && (e.name || e.message) || e)));
    }
  };
  showStorageNote(anchor, 'warn',
    `Im Ersatzspeicher (localStorage) liegen noch ${found.pending} Datensätze aus einer Sitzung ohne IndexedDB; sie werden hier nicht angezeigt.`,
    el('button', { type: 'button', onclick: run }, 'In IndexedDB übernehmen'));
}
