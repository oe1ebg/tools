// The callsign lists of this device (shared callsign store) with their
// dialog, one for every tool. The data is shared by all tools of the same
// address, so the dialog says so first thing. It adds, orders, switches,
// replaces, deletes and erases lists, looks into them and tests the
// lookup. The lists and the lookup themselves are the tool's
// callsign-service.js object, which the dialog changes and shows.
// Nothing here makes a request (the online Wavelog import is a page of its
// own, ../wavelog-import/, linked from the dialog).
//
//   const lists = createCallsignLists({ service, getLang });
//   lists.open(opener)            // the dialog; focus returns to opener
//
// Texts: tx(en, de) of i18n.js. Top-level names start with "callsignLists"
// (the single-file bundles share one scope).

import { el, fill, rowRoles, tableRoles } from './dom.js';
import { tx, setUiLang } from './i18n.js';
import { callsignNoteText, callsignSourceOrder, CALLSIGN_BUILTIN_ID } from './callsign-merge.js';
import { callsignBuiltinName } from './callsign-service.js';
import {
  importCallsignSource, swapCallsignGeneration,
  setCallsignSourceEnabled, deleteCallsignSource, restoreCallsignSource, moveCallsignSource, eraseCallsignSource,
} from './callsign-store.js';
import { parseCallsignFile, CALLSIGN_IMPORT_MAX_BYTES, CALLSIGN_IMPORT_MAX_ROWS } from './callsign-import.js';

const callsignListsDate = iso => (iso ? String(iso).slice(0, 10) : '');
const callsignListsIsFile = () => globalThis.location && globalThis.location.protocol === 'file:';

function callsignListsKind(kind) {
  if (kind === 'csv') return 'CSV';
  if (kind === 'wavelog') return tx('Wavelog import', 'Wavelog-Import');
  if (kind === 'polo') return tx('text file (PoLo)', 'Textdatei (PoLo)');
  return tx('built in', 'eingebaut');
}

function callsignListsFold(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ß/g, 'ss');
}

// How many rows the quick view draws at once; the search narrows the rest.
const CALLSIGN_LISTS_VIEW_MAX = 200;

export function createCallsignLists({ service, getLang = () => 'de' } = {}) {
  let dlg = null;
  let opener = null;
  let replaceId = null;
  let viewing = null;   // { id, rows: [{ call, name, qth, grid, note, hay }] } of the list in the quick view
  const ui = {};

  const lang = () => setUiLang(getLang());
  const reload = () => service.reload();   // rebuilds the lookup, which redraws the dialog (see below)

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
      const src = await importCallsignSource(service.store(), { kind: parsed.kind, name, fileName: file.name, rows: parsed.rows, replaceId: targetId });
      await reload();
      const skipped = Object.values(parsed.skipped || {}).reduce((a, b) => a + b, 0);
      say(targetId
        ? tx(`List "${src.name}" replaced: ${parsed.rows.length} entries (${skipped} lines skipped). "Undo" brings the previous version back.`, `Liste „${src.name}“ ersetzt: ${parsed.rows.length} Einträge (${skipped} Zeilen übersprungen). „Rückgängig“ holt die vorige Fassung zurück.`)
        : tx(`List "${src.name}" added: ${parsed.rows.length} entries (${skipped} lines skipped).`, `Liste „${src.name}“ hinzugefügt: ${parsed.rows.length} Einträge (${skipped} Zeilen übersprungen).`), 'ok');
    } catch (e) {
      console.warn(e);
      say(tx(`The list could not be saved: ${e.message || e}. Nothing was changed.`, `Die Liste konnte nicht gespeichert werden: ${e.message || e}. Es wurde nichts geändert.`), 'err');
    }
  }

  function build() {
    ui.head = el('tr', {});
    ui.rows = el('tbody', {});
    ui.table = el('table', { class: 'cl-table', 'aria-labelledby': 'cl-title' }, el('thead', {}, ui.head), ui.rows);
    ui.list = el('div', { class: 'table-wrap cl-wrap' }, ui.table);
    ui.empty = el('p', { class: 'hint' });
    ui.vTitle = el('h3', { id: 'cl-view-title' });
    ui.vBack = el('button', { type: 'button', class: 'mini' });
    ui.vSearch = el('input', { type: 'search', id: 'cl-view-search', autocomplete: 'off', spellcheck: 'false' });
    ui.vLabel = el('label', { for: 'cl-view-search' });
    ui.vCount = el('p', { class: 'cl-count', role: 'status' });
    ui.vHead = el('tr', {});
    ui.vRows = el('tbody', {});
    ui.vTable = el('table', { class: 'cl-table cl-entries', 'aria-labelledby': 'cl-view-title' }, el('thead', {}, ui.vHead), ui.vRows);
    ui.vWrap = el('div', { class: 'table-wrap cl-wrap' }, ui.vTable);
    ui.sLabel = el('label', { for: 'cl-test-search' });
    ui.sSearch = el('input', { type: 'search', id: 'cl-test-search', autocomplete: 'off', spellcheck: 'false' });
    ui.sCount = el('p', { class: 'cl-count', role: 'status' });
    ui.mTitle = el('h4', { id: 'cl-merged-title' });
    ui.mHead = el('tr', {});
    ui.mRows = el('tbody', {});
    ui.mTable = el('table', { class: 'cl-table cl-entries cl-merged-table', 'aria-labelledby': 'cl-merged-title' }, el('thead', {}, ui.mHead), ui.mRows);
    ui.sMerged = el('div', { class: 'cl-merged-box', hidden: true }, ui.mTitle, el('div', { class: 'table-wrap cl-wrap' }, ui.mTable));
    ui.eTitle = el('h4', { id: 'cl-entries-title' });
    ui.sHead = el('tr', {});
    ui.sRows = el('tbody', {});
    ui.sTable = el('table', { class: 'cl-table cl-entries', 'aria-labelledby': 'cl-entries-title' }, el('thead', {}, ui.sHead), ui.sRows);
    ui.sWrap = el('div', { class: 'table-wrap cl-wrap' }, ui.sTable);
    ui.sTitle = el('h3', { id: 'cl-test-title' });
    ui.view = el('div', { class: 'cl-view', hidden: true },
      el('div', { class: 'toolbar' }, ui.vBack), ui.vTitle,
      el('div', { class: 'field' }, ui.vLabel, ui.vSearch), ui.vCount, ui.vWrap);
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
    ui.rows.addEventListener('change', async ev => {
      const box = ev.target.closest('input[data-act=enable]');
      if (!box || !service.store()) return;
      await run(() => setCallsignSourceEnabled(service.store(), box.dataset.id, box.checked), null, box);
    });
    ui.rows.addEventListener('click', async ev => {
      const b = ev.target.closest('button[data-act]');
      if (!b || !service.store()) return;
      const id = b.dataset.id;
      const s = service.sources().find(x => x.id === id);
      if (!s) return;
      const name = s.id === CALLSIGN_BUILTIN_ID ? callsignBuiltinName() : s.name;
      const act = b.dataset.act;
      lang();
      if (act === 'view') { openView(id, b); return; }
      if (act === 'replace') { replaceId = id; ui.file.click(); return; }
      if (act === 'up' || act === 'down') { await run(() => moveCallsignSource(service.store(), id, act === 'up' ? -1 : 1), null, b); return; }
      if (act === 'undo') { await run(() => swapCallsignGeneration(service.store(), id), tx(`List "${name}": other version restored.`, `Liste „${name}“: andere Fassung wiederhergestellt.`), b); return; }
      if (act === 'delete') { await run(() => deleteCallsignSource(service.store(), id), tx(`List "${name}" deleted. It can be restored.`, `Liste „${name}“ gelöscht. Wiederherstellen ist möglich.`), b); return; }
      if (act === 'restore') { await run(() => restoreCallsignSource(service.store(), id), tx(`List "${name}" restored.`, `Liste „${name}“ wiederhergestellt.`), b); return; }
      if (act === 'erase') {
        if (!globalThis.confirm(tx(`Erase the list "${name}" from this device for good? This cannot be undone; the original file is not touched.`, `Die Liste „${name}“ endgültig von diesem Gerät löschen? Das lässt sich nicht rückgängig machen; die Originaldatei bleibt unberührt.`))) return;
        await run(() => eraseCallsignSource(service.store(), id), tx(`List "${name}" erased for good.`, `Liste „${name}“ endgültig gelöscht.`), b);
      }
    });
    dlg = el('dialog', { id: 'callsign-lists-dlg', class: 'help-dlg cl-dlg', 'aria-labelledby': 'cl-title' },
      el('div', { class: 'help-head' }, ui.title, ui.close),
      el('div', { class: 'cl-body' }, ui.shared,
        el('div', { class: 'cl-main-body' }, ui.empty, ui.list, el('div', { class: 'toolbar' }, ui.add, ui.wavelog), ui.file, ui.msg, ui.hint,
          el('section', { class: 'cl-test', 'aria-labelledby': 'cl-test-title' }, ui.sTitle, el('div', { class: 'field' }, ui.sLabel, ui.sSearch), ui.sCount, ui.sMerged, ui.eTitle, ui.sWrap)),
        ui.view));
    ui.mainBody = dlg.querySelector('.cl-main-body');
    ui.vBack.addEventListener('click', closeView);
    ui.sSearch.addEventListener('input', () => { clearTimeout(ui.sTimer); ui.sTimer = setTimeout(renderTest, 120); });
    ui.sSearch.addEventListener('keydown', ev => { if (ev.key === 'Escape' && ui.sSearch.value) { ev.stopPropagation(); ev.preventDefault(); ui.sSearch.value = ''; renderTest(); } });
    ui.vSearch.addEventListener('input', () => { clearTimeout(ui.vTimer); ui.vTimer = setTimeout(renderEntries, 120); });
    ui.vSearch.addEventListener('keydown', ev => { if (ev.key === 'Escape' && ui.vSearch.value) { ev.stopPropagation(); ev.preventDefault(); ui.vSearch.value = ''; renderEntries(); } });
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
      const again = ui.rows.querySelector(`[data-act="${key[0]}"][data-id="${CSS.escape(key[1])}"]:not([disabled])`)
        || ui.rows.querySelector(`[data-act="${key[0]}"]:not([disabled])`);
      if (again) again.focus();
    }
  }

  // The entries of a list for the quick view.
  function entriesOf(id) {
    const src = service.sources().find(x => x.id === id);
    if (!src) return [];
    if (id === CALLSIGN_BUILTIN_ID) {
      const b = service.callbook();
      return b ? b.calls.map(c => ({ call: c[0], name: c[1] || '', qth: c[2] || '', grid: '', note: '' })) : [];
    }
    return service.records().filter(r => r.source === id && r.gen === src.gen);
  }

  function openView(id, from) {
    lang();
    const src = service.sources().find(x => x.id === id);
    if (!src) return;
    viewing = { id, from, name: id === CALLSIGN_BUILTIN_ID ? callsignBuiltinName() : src.name,
      rows: entriesOf(id).map(r => ({ ...r, text: callsignNoteText(r.note), hay: callsignListsFold(`${r.call} ${r.name} ${r.qth} ${r.grid} ${callsignNoteText(r.note)}`) })) };
    ui.vSearch.value = '';
    ui.mainBody.hidden = true;
    ui.view.hidden = false;
    renderView();
    ui.vSearch.focus();
  }

  function closeView() {
    const from = viewing && viewing.from;
    viewing = null;
    ui.view.hidden = true;
    ui.mainBody.hidden = false;
    say('');
    if (from && from.isConnected) from.focus(); else ui.add.focus();
  }

  function renderView() {
    lang();
    ui.vBack.textContent = tx('← Back to the lists', '← Zurück zu den Listen');
    ui.vTitle.textContent = tx(`List: ${viewing.name}`, `Liste: ${viewing.name}`);
    ui.vLabel.textContent = tx('Search this list (callsign, name, QTH, note)', 'In dieser Liste suchen (Rufzeichen, Name, QTH, Notiz)');
    const hasGrid = viewing.rows.some(r => r.grid);
    const cols = [tx('Callsign', 'Rufzeichen'), tx('Name', 'Name'), 'QTH', ...(hasGrid ? [tx('Locator', 'Locator')] : []), tx('Note', 'Notiz')];
    fill(ui.vHead, cols.map(c => el('th', { scope: 'col' }, c)));
    viewing.cols = cols;
    viewing.hasGrid = hasGrid;
    tableRoles(ui.vTable);
    renderEntries();
  }

  function renderEntries() {
    if (!viewing) return;
    lang();
    const terms = callsignListsFold(ui.vSearch.value).split(/\s+/).filter(Boolean);
    const hits = terms.length ? viewing.rows.filter(r => terms.every(t => r.hay.includes(t))) : viewing.rows;
    const shown = hits.slice(0, CALLSIGN_LISTS_VIEW_MAX);
    const total = viewing.rows.length;
    ui.vCount.textContent = !total ? tx('This list has no entries.', 'Diese Liste hat keine Einträge.')
      : !hits.length ? tx(`No match in ${total} entries.`, `Kein Treffer in ${total} Einträgen.`)
        : hits.length > shown.length ? tx(`${shown.length} of ${hits.length} matches shown (${total} entries): narrow the search.`, `${shown.length} von ${hits.length} Treffern angezeigt (${total} Einträge): Suche eingrenzen.`)
          : terms.length ? tx(`${hits.length} of ${total} entries.`, `${hits.length} von ${total} Einträgen.`) : tx(`${total} entries.`, `${total} Einträge.`);
    fill(ui.vRows, shown.map(r => {
      const cells = [r.call, r.name, r.qth, ...(viewing.hasGrid ? [r.grid] : []), r.text];
      const tr = el('tr', {}, cells.map((c, i) => el('td', { 'data-label': viewing.cols[i], class: i === 0 ? 'cl-call' : '' }, c)));
      return rowRoles(tr);
    }));
  }

  // The test search: what the lookup finds in the lists that are switched
  // on, one row per list that has the callsign, with that list's name.
  function renderTest() {
    if (!dlg) return;
    lang();
    const q = ui.sSearch.value.trim();
    const dir = service.directory();
    const active = dir.sources.length;
    ui.sTitle.textContent = tx('Search callsigns', 'Rufzeichen suchen');
    ui.sLabel.textContent = tx('Callsign (also partial: OE1AB, 1ABC, OE1A?…), name, QTH or note – in all lists that are switched on', 'Rufzeichen (auch teilweise: OE1AB, 1ABC, OE1A?…), Name, QTH oder Notiz – in allen eingeschalteten Listen');
    ui.mTitle.textContent = tx('Result – what the tools see (all lists combined)', 'Ergebnis – das sehen die Tools (alle Listen zusammengeführt)');
    ui.eTitle.textContent = tx('Entries per list', 'Einträge je Liste');
    const cols = [tx('Callsign', 'Rufzeichen'), tx('Name', 'Name'), 'QTH', tx('Note', 'Notiz'), tx('List', 'Liste')];
    fill(ui.sHead, cols.map(c => el('th', { scope: 'col' }, c)));
    tableRoles(ui.sTable);
    ui.sMerged.hidden = true;
    ui.eTitle.hidden = true;
    if (!q) {
      ui.sCount.textContent = tx(`Searches ${active} list(s) that are switched on.`, `Durchsucht ${active} eingeschaltete Liste(n).`);
      fill(ui.sRows, []);
      fill(ui.mRows, []);
      return;
    }
    const found = service.search(q, 30);
    const merged = found.map(m => service.lookup(m.call)).filter(Boolean);
    const rowsOut = merged.flatMap(hit => hit.entries.map(e => ({ e })));
    const shown = rowsOut.slice(0, 100);
    ui.sCount.textContent = !found.length ? tx(`No match in ${active} list(s) that are switched on.`, `Kein Treffer in ${active} eingeschalteten Liste(n).`)
      : tx(`${found.length} callsign(s), ${rowsOut.length} list entries${rowsOut.length > shown.length ? ` (first ${shown.length} shown)` : ''}.`, `${found.length} Rufzeichen, ${rowsOut.length} Listeneinträge${rowsOut.length > shown.length ? ` (die ersten ${shown.length} angezeigt)` : ''}.`);
    // the combined result, one row per callsign, each value with its list
    const from = name => el('small', { class: 'cl-from' }, tx(`from ${name}`, `aus ${name}`));
    const val = (v, name) => (v ? [el('span', { class: 'cl-val' }, v), from(name)] : '–');
    const hasGrid = merged.some(m => m.grid);
    const mcols = [cols[0], cols[1], 'QTH', ...(hasGrid ? [tx('Locator', 'Locator')] : []), cols[3]];
    fill(ui.mHead, mcols.map(c => el('th', { scope: 'col' }, c)));
    tableRoles(ui.mTable);
    fill(ui.mRows, merged.map(m => {
      const cells = [
        el('span', { class: 'cl-val' }, m.base),
        val(m.name, m.from.name), val(m.qth, m.from.qth), ...(hasGrid ? [val(m.grid, m.from.grid)] : []),
        m.notes.length ? el('div', { class: 'cl-notes' }, m.notes.map(n => el('div', { class: 'cl-note' }, n.text, from(n.source)))) : '–',
      ];
      const tr = el('tr', {}, cells.map((c, i) => el('td', { 'data-label': mcols[i], class: i === 0 ? 'cl-call' : '' }, c)));
      return rowRoles(tr);
    }));
    ui.sMerged.hidden = !merged.length;
    ui.eTitle.hidden = !merged.length;
    fill(ui.sRows, shown.map(({ e }) => {
      const cells = [e.call, e.name, e.qth, callsignNoteText(e.note), e.source];
      const tr = el('tr', {}, cells.map((c, i) => el('td', { 'data-label': cols[i], class: i === 0 ? 'cl-call' : '' }, c)));
      return rowRoles(tr);
    }));
  }

  function row(s, visible) {
    const builtin = s.id === CALLSIGN_BUILTIN_ID;
    const name = builtin ? callsignBuiltinName() : s.name;
    const idx = visible.indexOf(s);
    const btn = (act, label, aria, { cls = '', disabled = false } = {}) => el('button', {
      type: 'button', class: `mini${cls}`, 'data-act': act, 'data-id': s.id, 'aria-label': `${aria} – ${name}`, disabled,
    }, label);
    const b = service.callbook();
    const count = builtin ? (b ? b.calls.length : 0) : s.count;
    const date = builtin ? (b && b.stand ? String(b.stand).slice(0, 10) : '–') : (callsignListsDate(s.importedAt) || '–');
    // Three action columns, so the buttons of all rows line up: look at the
    // list (also when it is switched off or deleted), replace (with its
    // undo), delete (or restore and erase for a deleted one).
    let view = null; let change = []; let remove = null;
    view = btn('view', tx('View', 'Ansehen'), tx('View the entries of the list', 'Einträge der Liste ansehen'));
    if (!s.deleted) {
      if (!builtin && s.kind !== 'wavelog') change.push(btn('replace', tx('Replace…', 'Ersetzen…'), tx('Replace the list with a new file', 'Liste durch eine neue Datei ersetzen')));
      if (!builtin && s.prevGen != null) change.push(btn('undo', tx('Undo', 'Rückgängig'), tx('Undo or redo the last replacement', 'Letztes Ersetzen rückgängig machen oder wiederholen')));
      if (!builtin) remove = btn('delete', tx('Delete', 'Löschen'), tx('Delete list', 'Liste löschen'), { cls: ' danger' });
    } else {
      change.push(btn('restore', tx('Restore', 'Wiederherstellen'), tx('Restore list', 'Liste wiederherstellen')));
      if (!builtin) remove = btn('erase', tx('Erase permanently', 'Endgültig löschen'), tx('Erase list permanently', 'Liste endgültig löschen'), { cls: ' danger' });
    }
    const label = i => ({ 'data-label': COLS()[i] });
    const tr = el('tr', { class: s.deleted ? 'cl-deleted' : (s.enabled === false ? 'cl-off' : '') },
      el('td', { ...label(0), class: 'cl-on' }, el('input', { type: 'checkbox', 'data-act': 'enable', 'data-id': s.id, checked: s.enabled !== false, disabled: !!s.deleted, 'aria-label': tx(`Use ${name}`, `${name} verwenden`) })),
      el('td', { ...label(1), class: 'cl-name' }, el('span', { class: 'cl-title' }, name), ' ',
        el('small', { class: 'cl-meta' }, [callsignListsKind(s.kind), s.deleted ? tx('deleted', 'gelöscht') : (s.enabled === false ? tx('switched off', 'ausgeschaltet') : null)].filter(Boolean).join(' · '))),
      el('td', { ...label(2), class: 'cl-num' }, String(count)),
      el('td', { ...label(3), class: 'cl-date' }, date),
      el('td', { ...label(4), class: 'cl-order' }, s.deleted ? '' : [
        btn('up', '↑', tx('Move up', 'Nach oben'), { disabled: idx <= 0 }), ' ',
        btn('down', '↓', tx('Move down', 'Nach unten'), { disabled: idx >= visible.length - 1 })]),
      el('td', { class: 'cl-act' }, view),
      el('td', { class: 'cl-act' }, change.flatMap((x, i) => (i ? [' ', x] : [x]))),
      el('td', { class: 'cl-act' }, remove));
    return rowRoles(tr);
  }

  const COLS = () => [tx('Active', 'Aktiv'), tx('List', 'Liste'), tx('Entries', 'Einträge'), tx('Imported', 'Stand'), tx('Priority', 'Rang'), tx('Actions', 'Aktionen')];

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
    ui.add.disabled = !service.store();
    ui.wavelog.textContent = tx('Get QSOs from Wavelog (online) ↗', 'QSOs aus Wavelog holen (online) ↗');
    ui.wavelog.hidden = callsignListsIsFile();
    ui.hint.textContent = tx('A list is a text file in the Ham2K PoLo format (callsign, then text) or a CSV (callsign, name, QTH). Every list is kept as it is. The order is the priority: for a callsign the topmost list that has a name or QTH decides (the others fill in what is missing); the notes of all lists are shown. The lists are not part of any backup: keep the original files.', 'Eine Liste ist eine Textdatei im Ham2K-PoLo-Format (Rufzeichen, danach Text) oder eine CSV (Rufzeichen, Name, QTH). Jede Liste bleibt für sich erhalten. Die Reihenfolge ist die Rangfolge: Für ein Rufzeichen entscheidet die oberste Liste, die einen Namen oder QTH hat (die anderen ergänzen, was fehlt); die Notizen aller Listen werden angezeigt. Die Listen sind in keiner Sicherung enthalten: die Originaldateien aufbewahren.');
    if (viewing) renderView();
    if (!service.store()) {
      ui.empty.textContent = tx('Your own lists need IndexedDB, which this browser does not offer. The built-in list keeps working.', 'Eigene Listen brauchen IndexedDB, das dieser Browser nicht bietet. Die eingebaute Liste funktioniert weiter.');
      ui.empty.hidden = false;
      ui.list.hidden = true;
      renderTest();
      return;
    }
    ui.empty.hidden = true;
    ui.list.hidden = false;
    fill(ui.head, COLS().map((c, i) => el('th', { scope: 'col', class: i === 2 ? 'cl-num' : '', colspan: i === 5 ? 3 : null }, c)));
    tableRoles(ui.table);
    const sorted = service.sources().slice().sort((a, b) => (Number(!!a.deleted) - Number(!!b.deleted)) || callsignSourceOrder(a, b));
    const visible = sorted.filter(s => !s.deleted);
    fill(ui.rows, sorted.map(s => row(s, visible)));
    renderTest();
  }

  // Redraw whenever the lists or the lookup change (here, in another tab,
  // after a language change).
  service.onChange(() => { render(); });

  return {
    open(from) {
      if (!dlg) build();
      opener = from || document.activeElement;
      viewing = null;
      ui.view.hidden = true;
      ui.mainBody.hidden = false;
      render();
      say('');
      dlg.showModal();
      ui.add.focus();
    },
  };
}
