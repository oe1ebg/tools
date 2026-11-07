// The dialog of the user's named places (issue #181), shared by the tools
// like the callsign lists' dialog (callsignlists.js) and built the same
// way (same classes): add a list from a CSV file, replace it (with undo),
// export it, delete (restorable) and erase it, and search the places that
// are in use. The data is shared by all tools of the same address, so the
// dialog says so first. German only (Notfunk uses it; a tool with English
// would add tx()). Nothing here makes a request.
//
//   const dlg = createPlaceLists({ service });   // places-service.js
//   dlg.open(opener)                             // focus returns to opener
//
// Top-level names start with "placeLists" (single-file bundles).

import { el, fill, rowRoles, tableRoles } from './dom.js';
import { placesDecode, placesParseCsv, placesSkippedText, placesToCsv, PLACES_MAX_BYTES, PLACES_MAX_ROWS } from './places.js';
import { importPlacesList, swapPlacesGeneration, deletePlacesList, restorePlacesList, erasePlacesList } from './places-store.js';

const placeListsIsFile = () => globalThis.location && globalThis.location.protocol === 'file:';
const placeListsDay = iso => (iso ? String(iso).slice(0, 10) : '–');
const placeListsNum = n => Number(n).toLocaleString('de-AT');
const PLACE_LISTS_SEARCH_MAX = 50;

function placeListsDownload(text, name) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = el('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function createPlaceLists({ service } = {}) {
  let dlg = null;
  let opener = null;
  let replaceId = null;
  const ui = {};

  const say = (text, kind = '') => {
    ui.msg.className = `cl-msg ${kind}`;
    ui.msg.textContent = text;
  };

  async function importFile(file, targetId) {
    if (!file) return;
    if (file.size > PLACES_MAX_BYTES) {
      say(`Die Datei ist zu groß (höchstens ${PLACES_MAX_BYTES / 1048576} MB). Es wurde nichts geändert.`, 'err');
      return;
    }
    const parsed = placesParseCsv(placesDecode(new Uint8Array(await file.arrayBuffer())));
    if (parsed.error === 'too-large') { say(`Die Datei ist zu groß (höchstens ${PLACES_MAX_BYTES / 1048576} MB). Es wurde nichts geändert.`, 'err'); return; }
    if (parsed.error === 'too-many') { say(`Die Datei hat zu viele Zeilen (höchstens ${placeListsNum(PLACES_MAX_ROWS)} Orte je Liste). Es wurde nichts geändert.`, 'err'); return; }
    if (parsed.error === 'no-header') {
      say(`„${file.name}“: Die erste Zeile muss die Spalten benennen, mindestens Name, Breite und Länge, z. B. „Name;Typ;Adresse;Breite;Länge;Aliase“. Es wurde nichts geändert.`, 'err');
      return;
    }
    const skipped = placesSkippedText(parsed.skipped);
    if (!parsed.rows.length) {
      say(`„${file.name}“ enthält keinen Ort mit Name, Breite und Länge.${skipped ? ` ${skipped}.` : ''} Es wurde nichts geändert.`, 'err');
      return;
    }
    const name = file.name.replace(/\.[^.]+$/, '');
    try {
      const list = await importPlacesList(service.store(), { name, fileName: file.name, rows: parsed.rows, replaceId: targetId });
      await service.reload();
      say(targetId
        ? `Liste „${list.name}“ ersetzt: ${placeListsNum(parsed.rows.length)} Orte.${skipped ? ` ${skipped}.` : ''} „Rückgängig“ holt die vorige Fassung zurück.`
        : `Liste „${list.name}“ hinzugefügt: ${placeListsNum(parsed.rows.length)} Orte.${skipped ? ` ${skipped}.` : ''}`, skipped ? 'warn' : 'ok');
    } catch (e) {
      console.warn(e);
      say(`Die Liste konnte nicht gespeichert werden: ${e.message || e}. Es wurde nichts geändert.`, 'err');
    }
  }

  function build() {
    ui.title = el('h2', { id: 'pl-title' }, 'Ortslisten');
    ui.close = el('button', { type: 'button', class: 'cl-close' }, 'Schließen');
    ui.shared = el('p', { class: 'cl-shared' });
    ui.empty = el('p', { class: 'hint' });
    ui.head = el('tr', {});
    ui.rows = el('tbody', {});
    ui.table = el('table', { class: 'cl-table', 'aria-labelledby': 'pl-title' }, el('thead', {}, ui.head), ui.rows);
    ui.list = el('div', { class: 'table-wrap cl-wrap' }, ui.table);
    ui.add = el('button', { type: 'button', class: 'primary' }, 'Liste hinzufügen…');
    ui.file = el('input', { type: 'file', accept: '.csv,.txt,text/csv,text/plain', hidden: true });
    ui.msg = el('p', { class: 'cl-msg', role: 'status' });
    ui.hint = el('div', { class: 'hint' },
      el('p', {}, 'Eine Ortsliste ist eine CSV-Datei (UTF-8 oder wie Excel sie speichert) mit einer Kopfzeile, getrennt durch Strichpunkt oder Komma:'),
      el('pre', {}, 'Name;Typ;Adresse;Breite;Länge;Aliase\nLichtinsel Musterpark;Lichtinsel;Mustergasse 1, 1210 Wien;48,2701;16,4012;LI Musterpark|Musterpark'),
      el('p', {}, 'Name, Breite und Länge (Grad, Dezimalpunkt oder -komma) sind Pflicht; Typ, Adresse und Aliase (getrennt durch |) sind freiwillig. Zeilen ohne Name oder gültige Koordinaten werden übersprungen und genannt. Höchstens 2 MB und 10.000 Orte je Liste, 50.000 insgesamt. Die Listen sind in keiner Sicherung enthalten: die Originaldatei aufbewahren (oder „Exportieren“).'));
    ui.sTitle = el('h3', { id: 'pl-test-title' }, 'Ort suchen');
    ui.sLabel = el('label', { for: 'pl-test-search' }, 'Name oder Alias – in allen Listen, wie im Feld Ort');
    ui.sSearch = el('input', { type: 'search', id: 'pl-test-search', autocomplete: 'off', spellcheck: 'false' });
    ui.sCount = el('p', { class: 'cl-count', role: 'status' });
    ui.sHead = el('tr', {});
    ui.sRows = el('tbody', {});
    ui.sTable = el('table', { class: 'cl-table cl-entries', 'aria-labelledby': 'pl-test-title' }, el('thead', {}, ui.sHead), ui.sRows);
    ui.add.addEventListener('click', () => { replaceId = null; ui.file.click(); });
    ui.file.addEventListener('change', async ev => {
      const f = ev.target.files[0];
      ev.target.value = '';
      const id = replaceId;
      replaceId = null;
      await importFile(f, id);
    });
    ui.close.addEventListener('click', () => dlg.close());
    ui.rows.addEventListener('click', ev => {
      const b = ev.target.closest('button[data-act]');
      if (b && service.store()) act(b);
    });
    ui.sSearch.addEventListener('input', () => { clearTimeout(ui.sTimer); ui.sTimer = setTimeout(renderSearch, 120); });
    ui.sSearch.addEventListener('keydown', ev => {
      if (ev.key === 'Escape' && ui.sSearch.value) { ev.stopPropagation(); ev.preventDefault(); ui.sSearch.value = ''; renderSearch(); }
    });
    dlg = el('dialog', { id: 'place-lists-dlg', class: 'help-dlg cl-dlg', 'aria-labelledby': 'pl-title' },
      el('div', { class: 'help-head' }, ui.title, ui.close),
      el('div', { class: 'cl-body' }, ui.shared, ui.empty, ui.list,
        el('div', { class: 'toolbar' }, ui.add), ui.file, ui.msg, ui.hint,
        el('section', { class: 'cl-test', 'aria-labelledby': 'pl-test-title' }, ui.sTitle,
          el('div', { class: 'field' }, ui.sLabel, ui.sSearch), ui.sCount, el('div', { class: 'table-wrap cl-wrap' }, ui.sTable))));
    dlg.addEventListener('close', () => { if (opener && opener.isConnected) opener.focus(); opener = null; });
    document.body.append(dlg);
  }

  async function act(b) {
    const id = b.dataset.id;
    const l = service.lists().find(x => x.id === id);
    if (!l) return;
    const a = b.dataset.act;
    const store = service.store();
    if (a === 'replace') { replaceId = id; ui.file.click(); return; }
    if (a === 'export') {
      const day = new Date().toISOString().slice(0, 10);
      const slug = l.name.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').toLowerCase() || 'orte';
      placeListsDownload(placesToCsv(service.placesOf(id)), `ortsliste-${slug}-${day}.csv`);
      say(`Liste „${l.name}“: Export gestartet (${placeListsNum(l.count)} Orte).`, 'ok');
      return;
    }
    let change = null; let done = '';
    if (a === 'undo') { change = () => swapPlacesGeneration(store, id); done = `Liste „${l.name}“: andere Fassung wiederhergestellt.`; }
    if (a === 'delete') { change = () => deletePlacesList(store, id); done = `Liste „${l.name}“ gelöscht. Wiederherstellen ist möglich.`; }
    if (a === 'restore') { change = () => restorePlacesList(store, id); done = `Liste „${l.name}“ wiederhergestellt.`; }
    if (a === 'erase') {
      if (!globalThis.confirm(`Die Liste „${l.name}“ endgültig von diesem Gerät löschen? Das lässt sich nicht rückgängig machen; die Originaldatei bleibt unberührt.`)) return;
      change = () => erasePlacesList(store, id); done = `Liste „${l.name}“ endgültig gelöscht.`;
    }
    if (!change) return;
    try {
      await change();
      await service.reload();
      say(done, 'ok');
    } catch (e) {
      console.warn(e);
      say(`Die Änderung konnte nicht gespeichert werden: ${e.message || e}. Es wurde nichts geändert.`, 'err');
    }
    // the rows are rebuilt: keep the focus on the same kind of control
    const again = ui.rows.querySelector(`[data-act="${a}"][data-id="${CSS.escape(id)}"]`)
      || ui.rows.querySelector(`[data-act="${a === 'delete' ? 'restore' : a === 'restore' ? 'delete' : a}"][data-id="${CSS.escape(id)}"]`)
      || ui.add;
    again.focus();
  }

  const COLS = ['Liste', 'Orte', 'Stand', 'Aktionen'];

  function row(l) {
    const btn = (a, label, aria, cls = '') => el('button', { type: 'button', class: `mini${cls}`, 'data-act': a, 'data-id': l.id, 'aria-label': `${aria} – ${l.name}` }, label);
    const change = [];
    let remove = null;
    if (!l.deleted) {
      change.push(btn('export', 'Exportieren', 'Liste als CSV exportieren'), ' ', btn('replace', 'Ersetzen…', 'Liste durch eine neue Datei ersetzen'));
      if (l.prevGen != null) change.push(' ', btn('undo', 'Rückgängig', 'Letztes Ersetzen rückgängig machen oder wiederholen'));
      remove = btn('delete', 'Löschen', 'Liste löschen', ' danger');
    } else {
      change.push(btn('restore', 'Wiederherstellen', 'Liste wiederherstellen'));
      remove = btn('erase', 'Endgültig löschen', 'Liste endgültig löschen', ' danger');
    }
    const tr = el('tr', { class: l.deleted ? 'cl-deleted' : '' },
      el('td', { 'data-label': COLS[0], class: 'cl-name' }, el('span', { class: 'cl-title' }, l.name), ' ',
        el('small', { class: 'cl-meta' }, [l.fileName, l.deleted ? 'gelöscht' : null].filter(Boolean).join(' · '))),
      el('td', { 'data-label': COLS[1], class: 'cl-num' }, placeListsNum(l.count)),
      el('td', { 'data-label': COLS[2], class: 'cl-date' }, placeListsDay(l.importedAt)),
      el('td', { class: 'cl-act' }, change),
      el('td', { class: 'cl-act' }, remove));
    return rowRoles(tr);
  }

  function renderSearch() {
    const q = ui.sSearch.value.trim();
    const cols = ['Name', 'Typ', 'Adresse', 'Breite, Länge', 'Liste'];
    fill(ui.sHead, cols.map(c => el('th', { scope: 'col' }, c)));
    tableRoles(ui.sTable);
    const n = service.active().length;
    if (!q) {
      ui.sCount.textContent = n ? `Durchsucht ${placeListsNum(n)} Orte.` : 'Noch keine Orte: zuerst eine Liste hinzufügen.';
      fill(ui.sRows, []);
      return;
    }
    const hits = service.search(q, PLACE_LISTS_SEARCH_MAX);
    ui.sCount.textContent = !hits.length ? `Kein Treffer in ${placeListsNum(n)} Orten.`
      : hits.length >= PLACE_LISTS_SEARCH_MAX ? `Die ersten ${hits.length} Treffer: Suche eingrenzen.` : `${hits.length} Treffer.`;
    fill(ui.sRows, hits.map(r => rowRoles(el('tr', {}, [
      [r.label, r.matchedName ? el('small', { class: 'cl-from' }, `gefunden als „${r.matchedName}“`) : null],
      r.placeType, r.address, `${r.lat.toFixed(5)}, ${r.lon.toFixed(5)}`, r.list,
    ].map((c, i) => el('td', { 'data-label': cols[i], class: i === 0 ? 'cl-call' : '' }, c))))));
  }

  function render() {
    if (!dlg) return;
    ui.shared.replaceChildren(el('span', { 'aria-hidden': 'true' }, '⇄ '), el('b', {}, placeListsIsFile() ? 'Nur in dieser Datei. ' : 'Gemeinsam für alle Tools. '),
      placeListsIsFile()
        ? 'Diese Offline-Datei hat einen eigenen Speicher; Ortslisten aus der installierten Version oder aus einer anderen Datei sind hier nicht sichtbar und umgekehrt.'
        : 'Diese Ortslisten gelten für alle Tools auf diesem Gerät (gleiche Adresse in diesem Browser). Die Orte bleiben auf diesem Gerät; nichts davon ist im Tool enthalten oder wird gesendet.');
    ui.add.disabled = !service.store();
    if (!service.store()) {
      ui.empty.textContent = 'Ortslisten brauchen IndexedDB, das dieser Browser nicht bietet. Die Adresssuche funktioniert weiter.';
      ui.empty.hidden = false;
      ui.list.hidden = true;
    } else {
      const sorted = service.lists().slice().sort((a, b) => (Number(!!a.deleted) - Number(!!b.deleted)) || String(a.importedAt).localeCompare(String(b.importedAt)));
      ui.empty.textContent = 'Noch keine Ortsliste.';
      ui.empty.hidden = sorted.length > 0;
      ui.list.hidden = !sorted.length;
      fill(ui.head, COLS.map((c, i) => el('th', { scope: 'col', class: i === 1 ? 'cl-num' : '', colspan: i === 3 ? 2 : null }, c)));
      tableRoles(ui.table);
      fill(ui.rows, sorted.map(row));
    }
    renderSearch();
  }

  service.onChange(render);

  return {
    open(from) {
      if (!dlg) build();
      opener = from || document.activeElement;
      render();
      say('');
      dlg.showModal();
      ui.add.focus();
    },
  };
}
