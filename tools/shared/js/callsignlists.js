// The callsign lists of this device (shared callsign store) with their
// dialog, one for every tool: Netlog today, Confirm and Notfunk can open
// the same. The data is shared by all tools of the same address, so the
// dialog says so first thing. It adds, orders, switches, replaces, deletes
// and erases lists; the tool reads the merged view through directory().
// Nothing here makes a request (the online Wavelog import is a page of its
// own, ../wavelog-import/, linked from the dialog).
//
//   const lists = createCallsignLists({ getLang, getCallbook, onChange });
//   await lists.init();            // opens the store; failing is not fatal
//   lists.directory()              // buildCallsignDirectory() view, always
//   lists.open(opener)             // the dialog; focus returns to opener
//   lists.summary()                // { available, active, total }
//
// getLang(): 'de' | 'en' of the tool; getCallbook(): the bundled Austrian
// list; onChange(): after any change of the lists (the tool re-renders).
// Texts: tx(en, de) of i18n.js. Top-level names start with "callsignLists"
// (the single-file bundles share one scope).

import { el, fill } from './dom.js';
import { tx, setUiLang } from './i18n.js';
import { buildCallsignDirectory, CALLSIGN_BUILTIN_ID } from './callsign-merge.js';
import {
  openCallsignStorage, ensureBuiltinSource, loadCallsignStore, importCallsignSource, swapCallsignGeneration,
  setCallsignSourceEnabled, deleteCallsignSource, restoreCallsignSource, moveCallsignSource, eraseCallsignSource,
} from './callsign-store.js';
import { parseCallsignFile, CALLSIGN_IMPORT_MAX_BYTES, CALLSIGN_IMPORT_MAX_ROWS } from './callsign-import.js';

const callsignListsBuiltinName = () => tx('Austrian callsign list (Fernmeldebüro)', 'Österreichische Rufzeichenliste (Fernmeldebüro)');
const callsignListsDate = iso => (iso ? String(iso).slice(0, 10) : '');
const callsignListsIsFile = () => globalThis.location && globalThis.location.protocol === 'file:';

function callsignListsKind(kind) {
  if (kind === 'csv') return 'CSV';
  if (kind === 'wavelog') return tx('Wavelog import', 'Wavelog-Import');
  if (kind === 'polo') return tx('text file (PoLo)', 'Textdatei (PoLo)');
  return tx('built in', 'eingebaut');
}

export function createCallsignLists({ getLang = () => 'de', getCallbook = () => null, onChange = () => {} } = {}) {
  let store = null;
  let sources = [];
  let records = [];
  let dir = null;
  let dlg = null;
  let opener = null;
  let replaceId = null;
  const ui = {};

  const lang = () => setUiLang(getLang());

  function rebuild() {
    lang();
    const srcs = store
      ? sources.map(s => (s.id === CALLSIGN_BUILTIN_ID ? { ...s, name: callsignListsBuiltinName() } : s))
      : [{ id: CALLSIGN_BUILTIN_ID, kind: 'builtin', name: callsignListsBuiltinName(), enabled: true, rank: 1000, gen: 1 }];
    dir = buildCallsignDirectory({ sources: srcs, records: store ? records : [], callbook: getCallbook() });
    onChange();
  }

  async function reload() {
    ({ sources, records } = await loadCallsignStore(store));
    rebuild();
    render();
  }

  async function init() {
    try {
      const s = await openCallsignStorage();
      if (!s) throw new Error('no IndexedDB');
      lang();
      await ensureBuiltinSource(s, callsignListsBuiltinName());
      store = s;
      ({ sources, records } = await loadCallsignStore(s));
    } catch (e) {
      console.warn('Rufzeichenlisten nicht verfügbar', e);
      store = null;
    }
    rebuild();
  }

  const say = (text, kind = '') => {
    if (!ui.msg) return;
    ui.msg.className = `cl-msg ${kind}`;
    ui.msg.textContent = text;
  };

  async function importFile(file, targetId) {
    if (!file) return;
    lang();
    const parsed = parseCallsignFile(file.name, await file.text());
    if (parsed.error === 'too-large') { say(tx(`The file is too large (at most ${CALLSIGN_IMPORT_MAX_BYTES / 1048576} MB). Nothing was changed.`, `Die Datei ist zu groß (höchstens ${CALLSIGN_IMPORT_MAX_BYTES / 1048576} MB). Es wurde nichts geändert.`), 'err'); return; }
    if (parsed.error === 'too-many') { say(tx(`The file has too many entries (at most ${CALLSIGN_IMPORT_MAX_ROWS.toLocaleString('en')}). Nothing was changed.`, `Die Datei hat zu viele Einträge (höchstens ${CALLSIGN_IMPORT_MAX_ROWS.toLocaleString('de')}). Es wurde nichts geändert.`), 'err'); return; }
    if (!parsed.rows.length) {
      say(tx(`"${file.name}" contains no callsign. Expected: a text file with "callsign text" per line, or CSV with "callsign;name;QTH". Nothing was changed.`, `„${file.name}“ enthält kein Rufzeichen. Erwartet: eine Textdatei mit „Rufzeichen Text“ je Zeile oder CSV mit „Rufzeichen;Name;QTH“. Es wurde nichts geändert.`), 'err');
      return;
    }
    const name = parsed.title || file.name.replace(/\.[^.]+$/, '');
    try {
      const src = await importCallsignSource(store, { kind: parsed.kind, name, fileName: file.name, rows: parsed.rows, replaceId: targetId });
      await reload();
      const skipped = Object.values(parsed.skipped || {}).reduce((a, b) => a + b, 0);
      say(targetId
        ? tx(`List "${src.name}" replaced: ${parsed.rows.length} entries (${skipped} lines skipped). "Undo replace" brings the previous version back.`, `Liste „${src.name}“ ersetzt: ${parsed.rows.length} Einträge (${skipped} Zeilen übersprungen). „Ersetzen rückgängig“ holt die vorige Fassung zurück.`)
        : tx(`List "${src.name}" added: ${parsed.rows.length} entries (${skipped} lines skipped).`, `Liste „${src.name}“ hinzugefügt: ${parsed.rows.length} Einträge (${skipped} Zeilen übersprungen).`), 'ok');
    } catch (e) {
      console.warn(e);
      say(tx(`The list could not be saved: ${e.message || e}. Nothing was changed.`, `Die Liste konnte nicht gespeichert werden: ${e.message || e}. Es wurde nichts geändert.`), 'err');
    }
  }

  function build() {
    ui.list = el('ul', { class: 'cl-list', 'aria-labelledby': 'cl-title' });
    ui.msg = el('p', { class: 'cl-msg', role: 'status' });
    ui.file = el('input', { type: 'file', accept: '.txt,.csv,text/plain,text/csv', hidden: true });
    ui.add = el('button', { type: 'button', class: 'primary' });
    ui.title = el('h2', { id: 'cl-title' });
    ui.close = el('button', { type: 'button', class: 'cl-close' });
    ui.shared = el('p', { class: 'cl-shared' });
    ui.hint = el('p', { class: 'hint' });
    ui.wavelog = el('a', { class: 'cl-online', href: '../wavelog-import/', target: '_blank', rel: 'noopener' });
    ui.add.addEventListener('click', () => { replaceId = null; ui.file.click(); });
    ui.file.addEventListener('change', async ev => {
      const f = ev.target.files[0];
      ev.target.value = '';
      const id = replaceId;
      replaceId = null;
      await importFile(f, id);
    });
    ui.close.addEventListener('click', () => dlg.close());
    ui.list.addEventListener('change', async ev => {
      const box = ev.target.closest('input[data-act=enable]');
      if (!box || !store) return;
      await run(() => setCallsignSourceEnabled(store, box.dataset.id, box.checked), null, box);
    });
    ui.list.addEventListener('click', async ev => {
      const b = ev.target.closest('button[data-act]');
      if (!b || !store) return;
      const id = b.dataset.id;
      const s = sources.find(x => x.id === id);
      if (!s) return;
      const name = s.id === CALLSIGN_BUILTIN_ID ? callsignListsBuiltinName() : s.name;
      const act = b.dataset.act;
      lang();
      if (act === 'replace') { replaceId = id; ui.file.click(); return; }
      if (act === 'up' || act === 'down') { await run(() => moveCallsignSource(store, id, act === 'up' ? -1 : 1), null, b); return; }
      if (act === 'undo') { await run(() => swapCallsignGeneration(store, id), tx(`List "${name}": other version restored.`, `Liste „${name}“: andere Fassung wiederhergestellt.`), b); return; }
      if (act === 'delete') { await run(() => deleteCallsignSource(store, id), tx(`List "${name}" deleted. It can be restored.`, `Liste „${name}“ gelöscht. Wiederherstellen ist möglich.`), b); return; }
      if (act === 'restore') { await run(() => restoreCallsignSource(store, id), tx(`List "${name}" restored.`, `Liste „${name}“ wiederhergestellt.`), b); return; }
      if (act === 'erase') {
        if (!globalThis.confirm(tx(`Erase the list "${name}" from this device for good? This cannot be undone; the original file is not touched.`, `Die Liste „${name}“ endgültig von diesem Gerät löschen? Das lässt sich nicht rückgängig machen; die Originaldatei bleibt unberührt.`))) return;
        await run(() => eraseCallsignSource(store, id), tx(`List "${name}" erased for good.`, `Liste „${name}“ endgültig gelöscht.`), b);
      }
    });
    dlg = el('dialog', { id: 'callsign-lists-dlg', class: 'help-dlg cl-dlg', 'aria-labelledby': 'cl-title' },
      el('div', { class: 'help-head' }, ui.title, ui.close),
      el('div', { class: 'cl-body' }, ui.shared, ui.list,
        el('div', { class: 'toolbar' }, ui.add, ui.wavelog), ui.file, ui.msg, ui.hint));
    dlg.addEventListener('close', () => { if (opener && opener.isConnected) opener.focus(); opener = null; });
    document.body.append(dlg);
  }

  // Runs a change, reloads, says what happened, and keeps the focus on the
  // same control (the rows are rebuilt).
  async function run(change, done, control) {
    const key = control ? [control.dataset.act, control.dataset.id] : null;
    try {
      await change();
      await reload();
      if (done) say(done, 'ok');
    } catch (e) {
      console.warn(e);
      lang();
      say(tx(`The change could not be saved: ${e.message || e}. Nothing was changed.`, `Die Änderung konnte nicht gespeichert werden: ${e.message || e}. Es wurde nichts geändert.`), 'err');
    }
    if (key) {
      const again = ui.list.querySelector(`[data-act="${key[0]}"][data-id="${CSS.escape(key[1])}"]:not([hidden]):not([disabled])`)
        || ui.list.querySelector(`[data-act="${key[0]}"]:not([hidden]):not([disabled])`);
      if (again) again.focus();
    }
  }

  function row(s, visible) {
    const builtin = s.id === CALLSIGN_BUILTIN_ID;
    const name = builtin ? callsignListsBuiltinName() : s.name;
    const idx = visible.indexOf(s);
    const btn = (act, label, aria, { cls = '', disabled = false } = {}) => el('button', {
      type: 'button', class: `mini${cls}`, 'data-act': act, 'data-id': s.id, 'aria-label': `${aria} – ${name}`, disabled,
    }, label);
    const meta = builtin ? tx('built in, works offline', 'eingebaut, ohne Internet')
      : tx(`${s.count} entries · ${callsignListsKind(s.kind)} · imported ${callsignListsDate(s.importedAt)}`, `${s.count} Einträge · ${callsignListsKind(s.kind)} · importiert ${callsignListsDate(s.importedAt)}`);
    const li = el('li', { class: 'cl-row' },
      el('label', { class: 'cl-name' }, el('input', { type: 'checkbox', 'data-act': 'enable', 'data-id': s.id, checked: s.enabled !== false, disabled: !!s.deleted }), ' ', el('span', {}, name)),
      ' ', el('small', { class: 'cl-meta' }, s.deleted ? `${meta} · ${tx('deleted', 'gelöscht')}` : meta), ' ');
    const add = (...x) => x.forEach(n => li.append(n, ' '));
    if (!s.deleted) {
      add(btn('up', '↑', tx('Move up', 'Nach oben'), { disabled: idx <= 0 }), btn('down', '↓', tx('Move down', 'Nach unten'), { disabled: idx >= visible.length - 1 }));
      if (!builtin && s.kind !== 'wavelog') add(btn('replace', tx('Replace…', 'Ersetzen…'), tx('Replace the list with a new file', 'Liste durch eine neue Datei ersetzen')));
      if (!builtin && s.prevGen != null) add(btn('undo', tx('Undo replace', 'Ersetzen rückgängig'), tx('Undo or redo the last replacement', 'Letztes Ersetzen rückgängig machen oder wiederholen')));
      if (!builtin) add(btn('delete', tx('Delete', 'Löschen'), tx('Delete list', 'Liste löschen'), { cls: ' danger' }));
    } else {
      add(btn('restore', tx('Restore', 'Wiederherstellen'), tx('Restore list', 'Liste wiederherstellen')));
      if (!builtin) add(btn('erase', tx('Erase permanently', 'Endgültig löschen'), tx('Erase list permanently', 'Liste endgültig löschen'), { cls: ' danger' }));
    }
    return li;
  }

  function render() {
    if (!dlg) return;
    lang();
    ui.title.textContent = tx('Callsign lists', 'Rufzeichenlisten');
    ui.close.textContent = tx('Close', 'Schließen');
    ui.shared.replaceChildren(el('span', { 'aria-hidden': 'true' }, '⇄ '), el('b', {}, callsignListsIsFile()
      ? tx('Only in this file. ', 'Nur in dieser Datei. ')
      : tx('Shared by all tools. ', 'Gemeinsam für alle Tools. ')),
    callsignListsIsFile()
      ? tx('This offline file keeps its own data; lists added in the installed version or in another file are not visible here, and the other way round.', 'Diese Offline-Datei hat einen eigenen Speicher; Listen aus der installierten Version oder aus einer anderen Datei sind hier nicht sichtbar und umgekehrt.')
      : tx('These lists apply to Confirm, Notfunk and Netlog on this device (same address in this browser). A change here takes effect everywhere.', 'Diese Listen gelten für Bestätigungsverkehr, Notfunk-Meldebuch und Netlog auf diesem Gerät (gleiche Adresse in diesem Browser). Eine Änderung hier wirkt überall.'));
    ui.add.textContent = tx('Add list…', 'Liste hinzufügen…');
    ui.add.disabled = !store;
    ui.wavelog.textContent = tx('Get QSOs from Wavelog (online) ↗', 'QSOs aus Wavelog holen (online) ↗');
    ui.wavelog.hidden = callsignListsIsFile();
    ui.hint.textContent = tx('A list is a text file in the Ham2K PoLo format (callsign, then text) or a CSV (callsign, name, QTH). Every list is kept as it is. For a callsign the first list in this order that has a name or QTH decides; the notes of all lists are shown. The lists are not part of any backup: keep the original files.', 'Eine Liste ist eine Textdatei im Ham2K-PoLo-Format (Rufzeichen, danach Text) oder eine CSV (Rufzeichen, Name, QTH). Jede Liste bleibt für sich erhalten. Für ein Rufzeichen entscheidet die erste Liste in dieser Reihenfolge, die einen Namen oder QTH hat; die Notizen aller Listen werden angezeigt. Die Listen sind in keiner Sicherung enthalten: die Originaldateien aufbewahren.');
    if (!store) {
      fill(ui.list, el('li', { class: 'hint' }, tx('Your own lists need IndexedDB, which this browser does not offer. The built-in list keeps working.', 'Eigene Listen brauchen IndexedDB, das dieser Browser nicht bietet. Die eingebaute Liste funktioniert weiter.')));
      return;
    }
    const sorted = sources.slice().sort((a, b) => (Number(!!a.deleted) - Number(!!b.deleted)) || (a.rank - b.rank));
    const visible = sorted.filter(s => !s.deleted);
    fill(ui.list, sorted.map(s => row(s, visible)));
  }

  return {
    init,
    directory: () => dir,
    summary: () => {
      const total = sources.filter(s => !s.deleted).length;
      return { available: !!store, active: sources.filter(s => !s.deleted && s.enabled !== false).length, total };
    },
    open(from) {
      if (!dlg) build();
      opener = from || document.activeElement;
      render();
      say('');
      dlg.showModal();
      ui.add.focus();
    },
    // After a language change of the tool.
    relabel() { rebuild(); render(); },
    // After another page changed the store (the Wavelog import).
    refresh: async () => { if (store) await reload(); },
  };
}
