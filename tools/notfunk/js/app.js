// Notfunk-Meldebuch: the page. Operations (Einsätze), the message book with
// its entry form, one message in detail, exports and printouts. Design,
// sources and open questions: ../README.md; rules: ../AGENTS.md.
//
// Persistence rules: a message number is taken only by saveNumbered()
// (numbering.js), in the same storage transaction as the message (and the
// "answered" status of the message a reply answers, ops.js), so a failed
// save consumes no number and two tabs never get the same one. Every write
// goes to storage before the UI reports it; a change of a stored message
// (edit, status, attempt, delete, restore) is a compare-and-set on its
// `updated`: a message changed meanwhile in another tab is not overwritten
// but reported (onConflict()). Edits keep the replaced version as a
// revision; deletes are soft and keep the number; the half-typed message is
// kept as a draft (never overwriting another tab's). Nothing here talks to
// the network.

import { openNotfunkStorage } from './db.js';
import { requestPersistence, ConflictError } from '../../shared/js/storage.js';
import { openStorageWithNotices, offerFallbackMigration } from '../../shared/js/storageui.js';
import { initHelpDialog } from '../../shared/js/helpdialog.js';
import { $, el, fill, focusNext, submitForm, isComposing, trackExpanded, rowRoles, tableRoles, revertOnEscape, popover } from '../../shared/js/dom.js';
import { prefGet, prefSet } from '../../shared/js/prefs.js';
import { loadDataFile } from '../../shared/js/data.js';
import { buildCallbook, lookupCall, normalizeCall } from '../../shared/js/callbook.js';
import { formatMHz } from '../../shared/js/repeaters.js';
import { newId, nowIso } from '../../shared/js/time.js';
import { attachCallSearch } from '../../shared/js/callsearch.js';
import { attachRepeaterSearch, loadRepeaterIndex } from '../../shared/js/repeaterui.js';
import { createLocationField, describeLocation } from '../../shared/js/locfield.js';
import { initLocationPanel, loadLocationIndex } from '../../shared/js/locationui.js';
import { locate } from '../../shared/js/location/index.js';
import { notfunkOpenMap, notfunkCloseMap, notfunkRefreshMap, notfunkMapVisible } from './mapview.js';
import { sourceItem, standDate, trackOnline, mapLinks, repoLink } from '../../shared/js/sources.js';
import { initOffline, setChip } from '../../shared/js/offline.js';
import {
  DIRECTIONS, CHANNELS, MESSAGE_TYPES, PRIORITIES, REF_KINDS, statusLabel, statusEntry, timeLabel, readBackLabel,
  editMessage, messageFields, softDelete, restoreDeleted, setStatus, addAttempt, currentStatus, filterMessages,
  repliesTo, fmtVienna, viennaTime, viennaDate, viennaStamp, zoneHint, normFreq, fmtFreq,
} from './model.js';
import { normalizePrefix, PREFIX_RE, nextSeq, formatNumber, counterKey } from './numbering.js';
import { toGeschaeftsbuchCSV, toBackupTexts, checkBackup, combineBackupParts, BACKUP_MAX_BYTES } from './export.js';
import { groupParts, partFileName, partsTooLarge } from '../../shared/js/backup-parts.js';
import { saveNewMessage, updateMessage, changedFields, editBaseOf, editTarget, draftEditState, applyBackup, patchOperation, writeDraft, clearDraft } from './ops.js';
import {
  emptyForm, setDirection, formToFields, formIsBlank, messageToForm, replyForm, nextStep, statusSteps, bookSummary, partyText,
  readDateTime, readClock, readBound, normDate, normTime, dateText, clockText, needsZone, upgradeForm, normalizeRef,
} from './form.js';
import { blankFormPdf, formPdf } from './paperpdf.js';
import { bookPdf } from './bookpdf.js';
import { pdfOpen } from '../../shared/js/pdf.js';
import { attachDatePicker, attachTimePicker } from './picker.js';
import { createRowCache, syncRows, resetRows } from '../../shared/js/rowcache.js';
import { trackSiteHeaderHeight } from '../../shared/js/stickyhead.js';

const LAST_OP_KEY = 'oe1ebg-notfunk-last-op';

const state = {
  store: null,
  tab: 'active',
  op: null,
  msgs: [],
  revisions: [],
  counter: null,
  editing: null, // message being edited (its current version)
  filter: 'all',
  query: '',
  callbook: null,
  locField: null,
  origLocField: null,
  rptSearch: null,
  showErrors: false, // field errors are shown after the first save attempt
  warned: '',        // the warnings already shown once (saving again = save anyway)
  saving: false,
  forUpdate: false,  // the update flow is flushing the draft (offline.js beforeReload)
  noticeKey: null,   // which draft notice #banner shows (conflict / review), so typing does not re-show it
  heldForm: null,    // the form as the held-back draft shows it (readForm() as JSON)
  editStale: false,  // an older edit draft not reviewed yet: nothing is saved or overwritten
  editBase: null,    // { id, fields }: the fields of the version an edit was opened on, kept after a conflict
  saveKey: null,    // { sig, id }: the id a failed save used, kept while the form is unchanged (a retry can't number it twice)
  draftSeen: undefined, // `updated` of the draft this tab last read or wrote (undefined: none); another one = another tab's
  channel: null,
  draftTimer: null,
};

/* ---------------------------------------------------------------- errors */

function showFatal(msg) {
  const b = $('#banner');
  b.textContent = msg;
  b.hidden = false;
}

function showSaveError(err) {
  console.error(err);
  const b = $('#banner');
  fill(b,
    'SPEICHERN FEHLGESCHLAGEN – die Eingabe ist noch im Formular. Bitte sofort sichern („Sichern (JSON)“). ',
    el('small', {}, `(${err && (err.message || err.name) || err})`),
    el('button', { type: 'button', onclick: () => { b.hidden = true; } }, 'ausblenden'));
  b.hidden = false;
}

// A notice that is no failure (a conflict with another tab, a warning after
// a save that went through): in the banner, with what to do.
function showNotice(...content) {
  const b = $('#banner');
  fill(b, ...content, el('button', { type: 'button', onclick: () => { b.hidden = true; } }, 'ausblenden'));
  b.hidden = false;
}

// Another tab changed what this one wanted to write: nothing was written
// (compare-and-set), the current data is loaded, the user's input stays.
async function onConflict(what, keeps) {
  try { await reloadMsgs(); } catch (e) { console.warn(e); }
  showNotice(`NICHT GESPEICHERT – ${what} wurde inzwischen geändert (z. B. in einem anderen Tab oder Fenster). Die aktuelle Fassung ist geladen. `,
    keeps ? 'Ihre Eingabe steht noch im Formular: bitte prüfen und erneut speichern; dabei werden nur die Felder übernommen, die Sie geändert haben. ' : 'Bitte die Angabe erneut eintragen. ');
}

// aria-live lines are read out on every write: only write real changes.
function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

function bookStatus(...content) {
  fill($('#book-status'), el('span', { class: 'ok-mark', 'aria-hidden': 'true' }, '✓'), ...content);
}

/* ---------------------------------------------------------------- clock */

// Austrian local time ("14:53"; in the repeated hour "02:30 MESZ").
function tick() {
  setText($('#clock-local'), viennaTime(nowIso()));
  tickLive();
}

/* ---------------------------------------------------------------- "jetzt" */

// Date and time fields that show the current time and run with the clock
// (class "live") until someone types or picks a value, or, in the message
// form, the message is begun. A live field means "now" when it is saved.
function setLive(input, on) {
  input.classList.toggle('live', on);
  if (on) tickLive();
}

function isLive(input) {
  return input.classList.contains('live');
}

function tickLive() {
  const now = nowIso();
  for (const input of document.querySelectorAll('input.live')) {
    const v = input.classList.contains('dt-date') ? dateText(now) : clockText(now);
    // no input event: the clock writing is no change by the operator
    if (input.value !== v) input.value = v;
  }
}

/* ---------------------------------------------------------------- downloads */

function download(text, name, type) {
  const blob = new Blob([text], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function fileStem() {
  const day = nowIso().slice(0, 10);
  return `meldebuch-${state.op.prefix}-${day}`;
}

/* ---------------------------------------------------------------- operations */

async function renderOps() {
  const ops = (await state.store.getAll('operations'))
    .filter(o => (state.tab === 'deleted' ? o.deleted : !o.deleted && (state.tab === 'archived' ? o.archived : !o.archived)))
    .sort((a, b) => (a.created < b.created ? 1 : -1));
  const counts = new Map();
  for (const m of await state.store.getAll('messages')) if (!m.deleted) counts.set(m.eventId, (counts.get(m.eventId) || 0) + 1);
  const list = $('#op-list');
  if (!ops.length) {
    fill(list, el('li', { class: 'empty' }, state.tab === 'active' ? 'Noch keine Einsätze. „+ Neuer Einsatz“ legt einen an.' : 'Leer.'));
    return;
  }
  fill(list, ops.map(op => {
    const open = () => { location.hash = `#/e/${op.id}`; };
    const actions = op.deleted
      ? [el('button', { type: 'button', onclick: () => updateOp(op, { deleted: null }) }, 'Wiederherstellen')]
      : [
        el('button', { type: 'button', class: 'primary', 'aria-label': `„${op.name}“ öffnen`, onclick: open }, 'Öffnen'),
        el('button', { type: 'button', onclick: () => updateOp(op, { archived: !op.archived }) }, op.archived ? 'Reaktivieren' : 'Archivieren'),
        el('button', {
          type: 'button', class: 'danger',
          onclick: () => { if (confirm(`„${op.name}“ in den Papierkorb verschieben? (Kann wiederhergestellt werden.)`)) updateOp(op, { deleted: nowIso() }); },
        }, 'Löschen'),
      ];
    return el('li', {
      class: op.deleted ? 'op-card' : 'op-card clickable',
      title: op.deleted ? null : 'Meldebuch öffnen',
      onclick: op.deleted ? null : e => { if (!e.target.closest('button')) open(); },
    },
    el('div', { class: 'info' },
      el('div', { class: 't' }, op.name),
      el('div', { class: 'meta' }, `${fmtVienna(op.created).split(' ')[0]} · ${['Station', op.prefix, op.call].filter(Boolean).join(' ')}${op.station ? ` · ${op.station}` : ''} · ${counts.get(op.id) || 0} Meldungen`),
      el('div', { class: 'meta' }, [op.operator && `Op ${op.operator}`, op.home && `für ${op.home}`, op.freq && `${fmtFreq(op.freq)} MHz`, op.via && `via ${op.via}`].filter(Boolean).join(' · '))),
    el('div', { class: 'actions' }, actions));
  }));
}

async function updateOp(op, patch) {
  try {
    // the patch goes onto the operation as stored now (another tab's change to other fields stays)
    const next = await patchOperation(state.store, op.id, patch, nowIso());
    if (state.op?.id === op.id) state.op = next;
    broadcast({ type: 'ops' });
  } catch (e) {
    showSaveError(e);
  }
  renderOps();
}

function openNewOpForm() {
  const form = $('#new-op');
  form.hidden = false;
  const last = JSON.parse(prefGet(LAST_OP_KEY) || '{}');
  $('#n-prefix').value = last.prefix || '';
  $('#n-call').value = last.call || '';
  $('#n-station').value = last.station || '';
  $('#n-operator').value = last.operator || '';
  $('#n-home').value = last.home || 'Stab';
  $('#n-freq').value = fmtFreq(last.freq || '');
  $('#n-via').value = last.via || '';
  renderPartyInfo('#n-operator', '#n-operator-info');
  renderPartyInfo('#n-call', '#n-call-info');
  state.newOpRpt?.refresh();
  $('#n-name').focus();
}

async function createOp() {
  const v = id => $(id).value.trim();
  const prefix = normalizePrefix(v('#n-prefix'));
  const status = $('#new-op-status');
  if (!v('#n-name')) { status.textContent = 'Name des Einsatzes fehlt.'; $('#n-name').focus(); return; }
  if (!PREFIX_RE.test(prefix)) { status.textContent = 'Stationskürzel: 1–6 Buchstaben oder Ziffern, z. B. W1.'; $('#n-prefix').focus(); return; }
  status.textContent = '';
  const now = nowIso();
  const op = {
    id: newId(), name: v('#n-name'), prefix, call: normalizeCall(v('#n-call')), station: v('#n-station'), operator: normalizeCall(v('#n-operator')),
    home: v('#n-home'), freq: normFreq(v('#n-freq')), via: normalizeCall(v('#n-via')), created: now, updated: now, archived: false, deleted: null,
  };
  try {
    await state.store.tx([{ store: 'operations', put: op }]);
  } catch (e) {
    showSaveError(e);
    return;
  }
  prefSet(LAST_OP_KEY, JSON.stringify({ prefix, call: op.call, station: op.station, operator: op.operator, home: op.home, freq: op.freq, via: op.via }));
  $('#new-op').hidden = true;
  $('#new-op').reset();
  broadcast({ type: 'ops' });
  location.hash = `#/e/${op.id}`;
}

/* ---------------------------------------------------------------- the operation's header */

// The "Einsatz" panel above the form, like the confirmation log's header:
// changes apply to new messages (stored ones keep what they were saved
// with). The station code is the number prefix: it can only change while
// the operation has no message, so no number is ever ambiguous.
const OP_FIELDS = { name: '#e-name', prefix: '#e-prefix', call: '#e-call', station: '#e-station', operator: '#e-operator', home: '#e-home', freq: '#e-freq', via: '#e-via' };
const OP_PANEL_KEY = 'oe1ebg-notfunk-op-open';

function renderOpPanel() {
  const op = state.op;
  for (const [k, sel] of Object.entries(OP_FIELDS)) if (document.activeElement !== $(sel)) $(sel).value = k === 'freq' ? fmtFreq(op[k] || '') : op[k] || '';
  $('#e-prefix').readOnly = state.msgs.length > 0;
  renderPartyInfo('#e-operator', '#e-operator-info');
  renderPartyInfo('#e-call', '#e-call-info');
  state.opRpt?.refresh();
  $('#book-title').textContent = op.name;
  setText($('#op-sum'), [
    op.prefix,
    op.call,
    op.station,
    op.operator ? `Op ${op.operator}` : 'Operator fehlt',
    op.home && `für ${op.home}`,
    op.freq && `${fmtFreq(op.freq)} MHz`,
    op.via && `via ${op.via}`,
  ].filter(Boolean).join(' · '));
  renderBackupChip();
  $('#op-sum').classList.toggle('warn-text', !op.operator);
  updateOpUndo();
}

// "Rückgängig" in the Einsatz panel: the panel's fields as they were when
// the panel was opened (or the book loaded with it open). Taken from the
// operation as this tab has it; another tab's later change to the operation
// does not move the baseline (undo then puts these fields back over it, as
// any edit here would). The Stationskürzel is not part of it once messages
// use it.
function takeOpUndo() {
  state.opUndo = state.op ? Object.fromEntries(Object.keys(OP_FIELDS).map(k => [k, state.op[k] || ''])) : null;
}

function opUndoPatch() {
  const u = state.opUndo, op = state.op;
  if (!u || !op) return {};
  const patch = {};
  for (const [k, val] of Object.entries(u)) {
    if (k === 'prefix' && state.msgs.length) continue;
    if ((op[k] || '') !== val) patch[k] = val;
  }
  return patch;
}

function updateOpUndo() {
  $('#btn-op-undo').disabled = !Object.keys(opUndoPatch()).length;
}

async function undoOp() {
  const patch = opUndoPatch();
  if (!Object.keys(patch).length) return;
  await applyOpPatch({ ...patch });
  bookStatus('Einsatz wie beim Öffnen.');
}

async function saveOpPanel() {
  const op = state.op;
  const v = sel => $(sel).value.trim();
  const status = $('#op-status');
  const patch = {
    name: v('#e-name') || op.name, call: normalizeCall(v('#e-call')), station: v('#e-station'), operator: normalizeCall(v('#e-operator')),
    home: v('#e-home'), freq: normFreq(v('#e-freq')), via: normalizeCall(v('#e-via')),
  };
  const prefix = normalizePrefix(v('#e-prefix'));
  if (prefix !== op.prefix) {
    if (state.msgs.length) {
      status.textContent = 'Das Stationskürzel ist schon in Meldungsnummern verwendet und bleibt.';
    } else if (!PREFIX_RE.test(prefix)) {
      status.textContent = 'Stationskürzel: 1–6 Buchstaben oder Ziffern, z. B. W1.';
    } else {
      patch.prefix = prefix;
      status.textContent = '';
    }
  } else {
    status.textContent = '';
  }
  if (Object.entries(patch).every(([k, val]) => (op[k] || '') === val)) { renderOpPanel(); return; }
  await applyOpPatch(patch);
  bookStatus(`Einsatz geändert: ${Object.keys(patch).filter(k => (op[k] || '') !== patch[k]).map(k => OP_LABELS[k]).join(', ')}`);
}

// Store a patch of the operation; an untouched message form follows the new
// defaults (frequency, relay, own post). Used by the panel's fields and its
// "Rückgängig".
async function applyOpPatch(patch) {
  const op = state.op;
  const f = readForm();
  const follow = {};
  if (normFreq(f.freq) === normFreq(op.freq || '')) follow.freq = patch.freq;
  if (f.via === (op.via || '')) follow.via = patch.via;
  if (f.to === (op.home || '') && f.direction === 'in') follow.to = patch.home;
  if (f.from === (op.home || '') && f.direction === 'out') follow.from = patch.home;
  for (const k of Object.keys(follow)) if (follow[k] === undefined) delete follow[k];
  await updateOp(op, patch);
  if (patch.prefix) state.counter = await state.store.get('counters', counterKey(op.id, patch.prefix));
  if (Object.keys(follow).length && !state.editing) writeForm({ ...readForm(), ...follow });
  renderOpPanel();
  renderFormState();
}

const OP_LABELS = { name: 'Name', prefix: 'Stationskürzel', call: 'Stationsrufzeichen', station: 'Standort der Station (Adresse)', operator: 'Operator', home: 'Für Stelle', freq: 'Frequenz', via: 'Relais' };

// Completion on the operator and relay fields of an operation (the
// "+ Neuer Einsatz" form and the Einsatz panel), as in the confirmation
// log's header: operators from earlier operations and the callsign list,
// relays from the ÖVSV list (a pick also sets the frequency).
async function recentOperators() {
  const ops = (await state.store.getAll('operations')).filter(o => o.operator && !o.deleted)
    .sort((a, b) => (a.updated < b.updated ? 1 : -1));
  const seen = new Set();
  return ops.filter(o => !seen.has(o.operator) && seen.add(o.operator)).map(o => ({ call: o.operator, title: o.name }));
}

function attachOpLookups(prefix, onChange) {
  const op = $(`#${prefix}-operator`);
  let recent = [];
  op.addEventListener('focus', async () => { recent = await recentOperators(); });
  attachCallSearch({
    input: op, pop: $(`#${prefix}-operator-pop`),
    getBook: () => state.callbook,
    recent: () => recent,
    onPick: () => { renderPartyInfo(`#${prefix}-operator`, `#${prefix}-operator-info`); onChange(); },
  });
  op.addEventListener('input', () => renderPartyInfo(`#${prefix}-operator`, `#${prefix}-operator-info`));
  $(`#${prefix}-call`).addEventListener('input', () => renderPartyInfo(`#${prefix}-call`, `#${prefix}-call-info`));
  const via = $(`#${prefix}-via`);
  return attachRepeaterSearch({
    input: via, pop: $(`#${prefix}-via-pop`), info: $(`#${prefix}-via-info`),
    getHeader: () => ({ myGrid: '', repeaterFreq: $(`#${prefix}-freq`).value }),
    onPick: r => {
      via.value = r.call;
      if (r.out) $(`#${prefix}-freq`).value = fmtFreq(formatMHz(r.out));
      onChange();
    },
  });
}

function initOpPanel() {
  state.opRpt = attachOpLookups('e', saveOpPanel);
  const panel = $('#op-panel');
  panel.open = prefGet(OP_PANEL_KEY) === '1';
  panel.addEventListener('toggle', () => {
    prefSet(OP_PANEL_KEY, panel.open ? '1' : '');
    if (panel.open) { takeOpUndo(); updateOpUndo(); }
  });
  $('#btn-op-undo').addEventListener('click', undoOp);
  const form = $('#op-form');
  form.addEventListener('change', saveOpPanel);
  // Esc in a field: back to the value it had when it got the focus (open
  // suggestion lists take Esc first). The reverted field equals the stored
  // value again, so the change/blur after it saves nothing.
  revertOnEscape(form, { onRevert: () => renderOpPanel() });
  form.addEventListener('keydown', ev => {
    if (ev.key !== 'Enter' || isComposing(ev) || ev.target.tagName !== 'INPUT') return;
    ev.preventDefault();
    // Enter = next field; from the last one on to the message form.
    if (!focusNext(form, ev.target)) { saveOpPanel(); $('#m-from').focus(); }
  });
}

/* ---------------------------------------------------------------- views */

function showView(id) {
  for (const v of ['#view-ops', '#view-book', '#view-msg']) $(v).hidden = v !== id;
  if (id !== '#view-book') closeMap(); // the map belongs to the book
  renderBackupChip();
}

/* ---------------------------------------------------------------- map */

// "Karte" in the book: the messages of the book's current list (filter
// and search) at their Ort, the own station as the star (mapview.js).
function mapContext(list) {
  return {
    opId: state.op.id,
    msgs: list,
    station: state.op.station,
    call: state.op.call,
    describe: m => ({
      time: viennaTime(m.ts),
      dir: m.direction === 'in' ? '↓' : '↑',
      subject: m.subject || m.text.slice(0, 40),
      status: statusLabel(currentStatus(m), m.direction),
    }),
    hrefOf: m => `#/e/${state.op.id}/m/${m.id}`,
    // a place text counts only if it resolves confidently (as in Confirm)
    resolve: async text => {
      const idx = await loadLocationIndex();
      return idx ? locate(idx, text, { autoSelect: 'high' }).autoSelect : null;
    },
  };
}

function setMapButton(on) {
  const btn = $('#btn-map');
  btn.classList.toggle('active', on);
  btn.setAttribute('aria-pressed', String(on));
}

function closeMap() {
  if (!notfunkMapVisible()) return;
  notfunkCloseMap();
  setMapButton(false);
}

async function toggleMap() {
  if (notfunkMapVisible()) { closeMap(); return; }
  setMapButton(true);
  await notfunkOpenMap(mapContext(state.bookList || []));
}

async function route() {
  const m = /^#\/e\/([\w-]+)(?:\/m\/([\w-]+))?/.exec(location.hash);
  if (!m) {
    await leaveOp();
    showView('#view-ops');
    renderOps();
    return;
  }
  if (state.op?.id !== m[1]) {
    await leaveOp();
    const op = await state.store.get('operations', m[1]);
    if (!op) { location.hash = '#/'; return; }
    state.op = op;
    await loadOp();
    takeOpUndo();
    updateOpUndo();
    restoreDraft();
  }
  if (m[2]) {
    showView('#view-msg');
    renderDetail(m[2]);
  } else {
    showView('#view-book');
    renderBook();
  }
}

async function loadOp() {
  const [msgs, revisions, counter] = await Promise.all([
    state.store.getByEvent('messages', state.op.id),
    state.store.getByEvent('revisions', state.op.id),
    state.store.get('counters', counterKey(state.op.id, state.op.prefix)),
  ]);
  state.msgs = msgs;
  state.revisions = revisions;
  state.counter = counter;
  $('#book-title').textContent = state.op.name;
  renderOpPanel();
  document.title = `${state.op.name} – Notfunk-Meldebuch`;
}

async function leaveOp() {
  if (!state.op) return;
  await flushDraft();
  state.op = null;
  state.msgs = [];
  setEditing(null);
  document.title = 'Notfunk-Meldebuch';
}

async function reloadMsgs() {
  if (!state.op) return;
  await loadOp();
  renderBackupChip();
  if (!$('#view-book').hidden) renderBook();
  const m = /\/m\/([\w-]+)/.exec(location.hash);
  if (m && !$('#view-msg').hidden) renderDetail(m[1]);
}

/* ---------------------------------------------------------------- the entry form */

function radioGroup(container, name, options) {
  fill(container, Object.entries(options).map(([value, label], i) => {
    const r = el('input', { type: 'radio', name, value, id: `${name}-${value}` });
    r.addEventListener('change', onFormChange);
    r.addEventListener('keydown', ev => radioKey(ev, [...container.querySelectorAll('input')]));
    return el('label', { for: r.id, title: `Taste ${i + 1}` }, r, el('span', {}, label));
  }));
}

// Digits pick the n-th option of a radio group (like the confirmation log).
function radioKey(ev, radios) {
  if (!/^[1-9]$/.test(ev.key) || ev.ctrlKey || ev.metaKey || ev.altKey) return;
  const pick = radios[Number(ev.key) - 1];
  if (!pick) return;
  ev.preventDefault();
  pick.checked = true;
  pick.focus();
  onFormChange();
}

function radioValue(name) {
  return document.querySelector(`input[name="${name}"]:checked`)?.value || '';
}

function setRadio(name, value) {
  for (const r of document.querySelectorAll(`input[name="${name}"]`)) r.checked = r.value === value;
}

function readForm() {
  const v = id => $(id).value;
  return {
    direction: radioValue('m-dir'), date: isLive($('#m-date')) ? '' : v('#m-date'), time: isLive($('#m-time')) ? '' : v('#m-time'), zone: $('#m-zone').hidden ? '' : v('#m-zone'), channel: radioValue('m-channel'),
    freq: v('#m-freq'), via: v('#m-via'), type: v('#m-type'), priority: radioValue('m-prio'),
    from: v('#m-from'), to: v('#m-to'), peer: v('#m-peer'), subject: v('#m-subject'), text: v('#m-text'), readBack: $('#m-readback').checked,
    stichzeit: v('#m-stichzeit'), distribution: v('#m-distribution'), remarks: v('#m-remarks'),
    origStation: v('#m-orig-station'), origPlace: v('#m-orig-place'), origPlaceLoc: state.origLocField?.get() || null, origFiled: v('#m-orig-filed'),
    refKind: v('#m-ref-kind') || 'antwort', ref: v('#m-ref'),
    replyTo: $('#msg-form').dataset.replyTo || null,
    ...keptTimes(),
    location: state.locField?.get() || null, locationText: v('#m-loc'),
  };
}

// The stored times of an edited message (form.js keeps them while the
// fields still show them), on the form element.
const KEPT_TIMES = ['ts', 'stichzeitTs', 'origFiledTs'];

function keptTimes() {
  const ds = $('#msg-form').dataset;
  return Object.fromEntries(KEPT_TIMES.map(k => [k, ds[k] || null]));
}

function writeForm(form) {
  const f = upgradeForm(form);
  setRadio('m-dir', f.direction);
  setRadio('m-channel', f.channel);
  setRadio('m-prio', f.priority);
  const set = (id, val) => { $(id).value = val ?? ''; };
  set('#m-date', f.date); set('#m-time', f.time);
  // a new message without a time yet: date and time run with the clock
  const live = !f.date && !f.time && !f.ts;
  setLive($('#m-date'), live);
  setLive($('#m-time'), live);
  set('#m-freq', fmtFreq(f.freq)); set('#m-via', f.via); set('#m-type', f.type);
  set('#m-from', f.from); set('#m-to', f.to); set('#m-peer', f.peer); set('#m-subject', f.subject); set('#m-text', f.text);
  set('#m-stichzeit', f.stichzeit); set('#m-distribution', f.distribution); set('#m-remarks', f.remarks);
  set('#m-orig-station', f.origStation); set('#m-orig-filed', f.origFiled);
  set('#m-ref-kind', f.refKind || 'antwort'); set('#m-ref', f.ref);
  $('#m-readback').checked = !!f.readBack;
  if (f.replyTo) $('#msg-form').dataset.replyTo = f.replyTo;
  else delete $('#msg-form').dataset.replyTo;
  for (const k of KEPT_TIMES) {
    if (f[k]) $('#msg-form').dataset[k] = f[k];
    else delete $('#msg-form').dataset[k];
  }
  showZone(f.zone);
  if (state.locField) {
    // A stored resolution is restored as it was (edit, draft), not resolved again.
    $('#m-loc').value = f.locationText || '';
    if (f.location) state.locField.set(f.location);
    else { state.locField.clear(); if (f.locationText) state.locField.refresh(); }
  }
  if (state.origLocField) {
    $('#m-orig-place').value = f.origPlace || '';
    if (f.origPlaceLoc) state.origLocField.set(f.origPlaceLoc);
    else state.origLocField.clear();
  } else {
    set('#m-orig-place', f.origPlace);
  }
  $('#m-more').open = !!(f.ref || f.distribution || f.remarks || f.origStation || f.origPlace || f.origFiled);
  state.rptSearch?.refresh();
  state.showErrors = false;
  state.warned = '';
  hideBars();
  renderFormState();
  growText();
}

// Number preview, edit/reply state, the fields that depend on others.
function renderFormState() {
  const f = readForm();
  const editing = state.editing;
  setText($('#form-title'), editing ? 'Meldung bearbeiten' : 'Neue Meldung');
  setText($('#form-number'), editing ? editing.number : `→ ${previewNumber()}`);
  setText($('#form-station'), state.op.call ? `Station ${state.op.call} · ` : '');
  setText($('#form-op'), state.op.operator || 'Operator fehlt');
  $('#form-op').classList.toggle('warn-text', !state.op.operator);
  // the Bezug: a number of this operation shows what it refers to
  const refNo = normalizeRef(f.ref);
  const refMsg = refNo && state.msgs.find(m => m.number === refNo && !m.deleted);
  const chip = $('#form-reply');
  chip.hidden = !refNo;
  if (refNo) {
    fill(chip, `${REF_KINDS[f.refKind] || REF_KINDS.antwort} ${refNo} `,
      el('button', { type: 'button', class: 'link', 'aria-label': `Bezug auf ${refNo} entfernen`, onclick: () => { delete $('#msg-form').dataset.replyTo; $('#m-ref').value = ''; onFormChange(); } }, '✕'));
  }
  setText($('#m-ref-info'), !refNo ? '' : refMsg ? `${refMsg.number}: ${refMsg.subject || refMsg.text.slice(0, 50)}` : 'nicht in diesem Einsatz – wird als Text gespeichert');
  setText($('#btn-save'), editing ? `Änderung speichern ⇧⏎` : `Speichern als ${previewNumber()} ⇧⏎`);
  for (const n of document.querySelectorAll('#msg-form .lage-only')) n.hidden = f.type !== 'lagemeldung';
  for (const n of document.querySelectorAll('#msg-form .radio-only')) n.hidden = f.channel !== 'funk';
  $('#msg-form').classList.toggle('urgent', f.priority === 'emergency');
  $('#msg-form').classList.toggle('editing', !!editing);
  // the words that depend on the direction
  setText($('#m-time-label'), timeLabel(f.direction));
  setText($('#m-readback-label'), readBackLabel(f.direction));
  $('#m-peer').title = f.direction === 'out' ? 'Empfangende Funkstation' : 'Übermittelnde Funkstation';
  showZone();
  renderPartyInfo('#m-peer', '#m-peer-info');
  renderPartyInfo('#m-orig-station', '#m-orig-station-info');
  if (state.showErrors) showFieldErrors(check(f).fieldErrors);
}

// The form checked as it would be saved.
function check(f = readForm()) {
  return formToFields(f, { now: nowIso(), byNumber: new Map(state.msgs.filter(m => !m.deleted).map(m => [m.number, m])), editing: !!state.editing, keepText: state.editing ? state.editing.text : null });
}

// Errors at the fields (German), aria-invalid on the inputs.
const ERROR_INPUTS = { time: '#m-time', from: '#m-from', to: '#m-to', subject: '#m-subject', text: '#m-text', stichzeit: '#m-stichzeit', origFiled: '#m-orig-filed' };

function showFieldErrors(errs) {
  for (const [k, sel] of Object.entries(ERROR_INPUTS)) {
    const msg = errs[k] || '';
    setText(document.querySelector(`#msg-form .ferr[data-field="${k}"]`), msg);
    for (const node of k === 'time' ? [$('#m-date'), $(sel)] : [$(sel)]) {
      if (msg) node.setAttribute('aria-invalid', 'true');
      else node.removeAttribute('aria-invalid');
    }
  }
}

// The MESZ/MEZ choice, only while date + time fall in the hour that
// repeats when the clocks go back; preset to `zone` (an edited message's)
// or the occurrence nearest now.
function showZone(zone) {
  const sel = $('#m-zone');
  const date = $('#m-date').value, time = $('#m-time').value;
  const need = needsZone(date || dateText(nowIso()), time);
  if (need && (sel.hidden || zone)) sel.value = zone || zoneHint(readDateTime(date, time, nowIso()));
  sel.hidden = !need;
}

// Warnings at the fields they come from (like the errors, in the warning
// colour), while the bar "Vor dem Speichern prüfen" is shown; hiding the
// bar clears them (an observer, so every way of hiding it does).
const WARN_INPUTS = { time: ['#m-date', '#m-time'], peer: ['#m-peer'] };

function showFieldWarnings(warns = {}) {
  for (const [k, sels] of Object.entries(WARN_INPUTS)) {
    setText(document.querySelector(`#msg-form .fwarn[data-warn="${k}"]`), warns[k] || '');
    for (const sel of sels) {
      if (warns[k]) $(sel).dataset.warned = 'true';
      else delete $(sel).dataset.warned;
    }
  }
}

// The message text grows with what is typed.
function growText() {
  const t = $('#m-text');
  t.style.height = '';
  if (t.scrollHeight > t.clientHeight) t.style.height = `${t.scrollHeight + 2}px`;
}

function hideBars() {
  $('#warn-bar').hidden = true;
  $('#discard-bar').hidden = true;
}

// The info line under Von/An and the operator fields: the callbook entry
// of a callsign in it.
function renderPartyInfo(inputSel, infoSel) {
  const info = $(infoSel);
  const text = $(inputSel).value.trim();
  const call = /\/\s*([A-Za-z0-9/]+)$/.exec(text)?.[1] || (!/\s/.test(text) ? text : '');
  const hit = call && state.callbook ? lookupCall(state.callbook, normalizeCall(call)) : null;
  info.className = hit?.entry ? 'ac-info known' : 'ac-info';
  setText(info, hit?.entry ? [hit.entry[0], hit.entry[1], hit.entry[2]].filter(Boolean).join(' · ') : '');
}

function previewNumber() {
  return formatNumber(state.op.prefix, nextSeq(state.counter, state.msgs, state.op.prefix));
}

function onFormChange(ev) {
  // Date and time run with the clock until the message is begun (the
  // first keystroke in any other field): then they stay at that moment,
  // with the date, and can be corrected.
  const d = $('#m-date'), t = $('#m-time');
  if (isLive(t) && ev?.target && ev.target !== t && ev.target !== d && !formIsBlank(readForm(), state.op)) {
    tickLive();
    setLive(d, false);
    setLive(t, false);
  }
  if (ev?.target?.id === 'm-text') growText();
  if (!$('#warn-bar').hidden) { $('#warn-bar').hidden = true; state.warned = ''; }
  renderFormState();
  clearTimeout(state.draftTimer);
  state.draftTimer = setTimeout(flushDraft, 600);
}

function formIsEmpty(f) {
  return formIsBlank(f, state.op);
}

// flushDraft() resolves true when the draft is safe (saved, or nothing to
// save) and false when it is not (storage error, conflict with another tab's
// draft): a string says why (shown by the update flow, shared/js/offline.js).
// An older draft held back for review is stored already: true while the form
// is unchanged since, else a message.
// Draft writes run one after the other, each reading the form and the token
// (draftSeen) when its turn comes: a debounce that fires during a save, or
// the clear after it, can't work with a stale token and leave the saved
// message's draft behind (it would come back on the next load).
// The message an edit is on, with the version it was opened on (editBase).
function setEditing(msg, savedBase = null) {
  state.editStale = false;
  state.editing = msg;
  state.editBase = msg ? editBaseOf(msg, savedBase) : null;
  markEditing();
}

// The book row of the message in the form gets `row-editing` (one at a
// time); rows are cached, so the class follows the state, not the build.
let editingRow = null;
function markEditing() {
  editingRow?.classList.remove('row-editing');
  editingRow = (state.editing && bookRows.get(state.editing.id)?.node) || null;
  editingRow?.classList.add('row-editing');
}

let draftChain = Promise.resolve();
function flushDraft() {
  clearTimeout(state.draftTimer);
  draftChain = draftChain.then(flushDraftNow, flushDraftNow);
  return draftChain;
}

async function flushDraftNow() {
  // an older draft waiting for the user's review is left as it is (a new write would look current)
  if (state.editStale) {
    // the held-back draft is what is stored and what the form shows: nothing
    // is at risk until the user types something else
    if (JSON.stringify(readForm()) === state.heldForm) return true;
    if (state.forUpdate) reviewDraft(); // the notice is shown again if another message replaced it
    return staleResult();
  }
  if (!state.op || $('#view-book').hidden && $('#view-msg').hidden) return true;
  const f = readForm();
  const empty = formIsEmpty(f) && !state.editing;
  const opId = state.op.id;
  try {
    if (empty) {
      // an empty form never removes a draft that another tab wrote
      if (await clearDraft(state.store, opId, state.draftSeen)) state.draftSeen = undefined;
      setText($('#draft-status'), '');
    } else {
      const draft = { form: f, editingId: state.editing?.id || null, base: state.editing ? state.editBase : null, saved: nowIso() };
      try {
        state.draftSeen = await writeDraft(state.store, opId, draft, state.draftSeen);
      } catch (e) {
        // the draft this tab knew is gone (another tab saved its message and removed it): ours is the only one
        if (!(e instanceof ConflictError) || e.current !== undefined) throw e;
        state.draftSeen = await writeDraft(state.store, opId, draft, undefined);
      }
      setText($('#draft-status'), `✓ Entwurf gesichert ${viennaTime(draft.saved)}`);
    }
    return true;
  } catch (e) {
    if (e instanceof ConflictError) {
      // the notice shows once per conflict (not on every keystroke), and again when the update asks
      if (state.forUpdate || state.noticeKey !== `conflict:${e.actual}`) draftConflict(e);
      return conflictResult(e);
    }
    console.warn('Entwurf nicht gespeichert', e);
    setText($('#draft-status'), 'Entwurf nicht gesichert!');
    return false;
  }
}

// Another tab saved a draft for this operation since this one read it:
// neither is overwritten silently. The user chooses.
// What the two choices do (also offered by the update banner, offline.js):
// keep mine = my text is saved and replaces the other window's draft; take
// the other = its draft replaces what is typed here.
async function keepMyDraft(e) {
  state.noticeKey = null;
  state.draftSeen = e.actual;
  $('#banner').hidden = true;
  await flushDraft();
}
function takeOtherDraft(e) {
  state.noticeKey = null;
  state.draftSeen = e.actual;
  $('#banner').hidden = true;
  applyDraft(e.current);
  setText($('#draft-status'), '✓ Entwurf aus dem anderen Tab geladen');
}
function conflictResult(e) {
  return {
    message: 'Zwei Fenster haben für diesen Einsatz verschiedene Entwürfe (ein Entwurf ist eine noch nicht gespeicherte Meldung); Ihr Text in diesem Fenster ist nicht gesichert. Wählen Sie, welcher Text bleibt: ',
    actions: [
      { label: 'Meinen Text sichern (ersetzt den Entwurf des anderen Fensters)', run: () => keepMyDraft(e) },
      { label: 'Entwurf des anderen Fensters laden (ersetzt meinen Text hier)', run: () => takeOtherDraft(e) },
    ],
    discards: 'Ihr aktueller Text in diesem Fenster geht verloren; der Entwurf aus dem anderen Fenster bleibt.',
  };
}
function draftConflict(e) {
  state.noticeKey = `conflict:${e.actual}`;
  setText($('#draft-status'), 'Entwurf nicht gesichert: anderer Tab!');
  showNotice('ENTWURF NICHT GESICHERT – In einem anderen Tab oder Fenster liegt ein anderer Entwurf für diesen Einsatz. ',
    el('button', { type: 'button', onclick: () => keepMyDraft(e) }, 'Meinen Entwurf sichern (ersetzt den anderen)'),
    ' ',
    el('button', { type: 'button', onclick: () => takeOtherDraft(e) }, 'Den anderen Entwurf laden (ersetzt meine Eingabe)'),
    ' ');
}

// A stored draft into the form. An edit draft keeps the version the edit was
// opened on; one without it (older drafts) is checked against the message:
// its version is unknown, so it is only shown, saving is held back until
// the user has reviewed it (reviewDraft()). A message that is gone: the
// draft is shown as a new message, and the user is told.
function applyDraft(d) {
  const st = draftEditState(d?.editingId ? state.msgs.find(m => m.id === d.editingId) : undefined, d);
  setEditing(st.editing, st.base);
  writeForm(d?.form || emptyForm(state.op));
  // an older draft's version is unknown: reviewed unless it holds nothing the message doesn't
  state.editStale = st.stale && draftDiff().length > 0;
  state.heldForm = state.editStale ? JSON.stringify(readForm()) : null;
  if (state.editStale) reviewDraft();
  else if (st.gone) showNotice('ENTWURF – Die Meldung, die dieser Entwurf bearbeitet, gibt es in diesem Einsatz nicht mehr. Der Entwurf steht im Formular und würde als neue Meldung gespeichert. ');
}

const FIELD_LABELS = {
  direction: 'Richtung', ts: 'Zeit', channel: 'Übermittlung', radio: 'Frequenz/Relais', peer: 'Funkstelle', type: 'Art', priority: 'Dringlichkeit',
  from: 'Absender', to: 'Adressat', distribution: 'Verteiler', subject: 'Betreff', text: 'Inhalt', stichzeit: 'Stichzeit', origin: 'Ursprung',
  readBack: 'Rücklesen', location: 'Ort', locationText: 'Ort', replyTo: 'Bezug', refKind: 'Bezug', refNumber: 'Bezug', remarks: 'Anmerkungen',
};

// The message changed after this (older) edit draft was saved: say which
// fields differ and let the user choose; nothing is saved before.
function draftDiff() {
  const { staffRef: _ref, ...mine } = check().fields;
  return [...new Set(Object.keys(changedFields(mine, messageFields(state.editing))).map(k => FIELD_LABELS[k] || k))];
}

function applyStaleDraft() {
  state.noticeKey = null;
  state.editStale = false;
  state.editBase = editBaseOf(state.editing);
  $('#banner').hidden = true;
}
function discardStaleDraft() {
  state.noticeKey = null;
  const m = state.editing;
  $('#banner').hidden = true;
  startEdit(m);
  return flushDraft();
}
function staleResult() {
  return {
    message: `Ein älterer Entwurf zu ${state.editing?.number || 'einer Meldung'} wurde noch nicht geprüft, und Sie haben seither etwas geändert; das ist nicht gesichert. Wählen Sie: `,
    actions: [
      { label: 'Meinen Text auf die aktuelle Fassung anwenden (wird gesichert)', run: async () => { applyStaleDraft(); await flushDraft(); } },
      { label: 'Entwurf verwerfen, gespeicherte Fassung laden (meine Änderungen gehen verloren)', run: discardStaleDraft },
    ],
    discards: 'Ihre ungesicherten Änderungen an dieser Meldung gehen verloren; die gespeicherte Fassung bleibt.',
  };
}

function reviewDraft() {
  const cur = state.editing;
  const diff = draftDiff();
  state.noticeKey = `review:${cur.id}:${diff.join(',')}`;
  showNotice(`ENTWURF PRÜFEN – Dieser Entwurf stammt aus einer älteren Version des Werkzeugs; es ist nicht bekannt, auf welcher Fassung von ${cur.number} er beruht (sie kann inzwischen, z. B. in einem anderen Tab, geändert worden sein). Der Entwurf steht im Formular, es wird nichts gespeichert, bevor Sie gewählt haben. Abweichend von der gespeicherten Fassung: ${diff.join(', ') || 'nichts'}. `,
    el('button', { type: 'button', onclick: applyStaleDraft }, 'Entwurf auf die aktuelle Fassung anwenden'),
    ' ',
    el('button', { type: 'button', onclick: discardStaleDraft }, 'Entwurf verwerfen (gespeicherte Fassung laden)'),
    ' ');
}

async function restoreDraft() {
  const d = await state.store.get('drafts', state.op.id);
  state.draftSeen = d ? d.updated ?? null : undefined;
  applyDraft(d);
  setText($('#draft-status'), d ? `✓ Entwurf gesichert ${viennaTime(d.saved)}` : '');
}

function resetForm(keep = true) {
  const prev = readForm();
  const next = emptyForm(state.op);
  // Direction, channel and frequency usually stay the same for the next message.
  if (keep) Object.assign(next, setDirection(next, prev.direction, state.op), { channel: prev.channel, freq: prev.freq, via: prev.via });
  setEditing(null);
  state.saveKey = null;
  writeForm(next);
}

// Save (⇧⏎, Strg+⏎, the button). Errors block and are shown at the fields;
// warnings ask once (the bar), saving again saves anyway.
async function saveMessage({ anyway = false } = {}) {
  // a second ⇧⏎ while the first save is still running must not save twice
  if (state.saving) return;
  state.saving = true;
  try {
    await saveMessageNow(anyway);
  } finally {
    state.saving = false;
  }
}

async function saveMessageNow(anyway) {
  const status = $('#form-status');
  const form = readForm();
  const now = nowIso();
  const { fields, errors, fieldErrors, warnings, fieldWarnings } = check(form);
  state.showErrors = true;
  showFieldErrors(fieldErrors);
  if (errors.length) {
    status.className = 'form-status err';
    status.textContent = `Nicht gespeichert: ${errors.join(' · ')}`;
    const first = Object.keys(ERROR_INPUTS).find(k => fieldErrors[k]);
    if (first) {
      if (first === 'origFiled') $('#m-more').open = true;
      $(ERROR_INPUTS[first]).focus();
    }
    return;
  }
  const sig = warnings.join('|');
  if (warnings.length && !anyway && state.warned !== sig) {
    state.warned = sig;
    setText($('#warn-list'), warnings.join(' · '));
    $('#discard-bar').hidden = true;
    $('#warn-bar').hidden = false;
    showFieldWarnings(fieldWarnings);
    status.textContent = '';
    return;
  }
  if (state.editing && state.editStale) { reviewDraft(); return; }
  const operator = state.op.operator || '';
  const op = state.op;
  const wasEdit = !!state.editing;
  // The id of a new message stays the same while the form is unchanged, so a
  // retry after a save whose outcome was lost returns the committed message
  // instead of numbering a second one.
  const formSig = JSON.stringify(form);
  if (state.saveKey?.sig !== formSig) state.saveKey = { sig: formSig, id: newId() };
  let saved;
  try {
    if (wasEdit) {
      // The staff reference is kept with the message, not in the form. The
      // revision holds the record as it was stored when it was replaced.
      // The write is checked against the version the edit was opened on
      // (also after a draft restore), and only what the user changed against
      // it is sent, so a change another tab made is a conflict, never undone.
      const base = state.editBase;
      const { staffRef: _ref, ...all } = fields;
      const changes = changedFields(all, base.fields);
      saved = await updateMessage(state.store, editTarget(state.editing, base), cur => editMessage(cur, changes, { revisionId: newId(), operator, now }));
    } else {
      // number, message and the "answered" status of a replied-to message: one transaction
      saved = await saveNewMessage(state.store, { op, fields, messageId: state.saveKey.id, meta: { operator, stationCall: op.call || '', now } });
    }
  } catch (e) {
    if (e instanceof ConflictError) {
      // changed meanwhile: the edit continues on the current version, the input stays
      // (the field values the user opened stay the baseline of "what did I change"; the token moves on)
      if (e.current) {
        state.editing = e.current;
        state.editBase = { ...state.editBase, updated: e.current.updated ?? null };
      }
      await onConflict(state.editing?.number || 'Die Meldung', true);
      return;
    }
    showSaveError(e);
    return;
  }
  // From here the message is committed: nothing below may make it look
  // unsaved or let a retry number it again. The form is cleared first.
  resetForm();
  status.className = 'form-status';
  status.textContent = '';
  const notes = [];
  // the draft of the message just saved goes first (queued behind any write in flight)
  await flushDraft();
  try {
    await rememberStations(fields);
  } catch (e) {
    console.warn('Funkstelle nicht für die Vervollständigung gemerkt', e);
    notes.push('Die Funkstelle konnte nicht für die Vervollständigung gemerkt werden.');
  }
  try {
    await loadOp();
    renderBook();
    renderBackupChip();
  } catch (e) {
    console.warn('Anzeige nach dem Speichern', e);
    notes.push('Die Anzeige konnte nicht aktualisiert werden – bitte die Seite neu laden.');
  }
  bookStatus(`${saved.number} ${wasEdit ? 'geändert (vorige Fassung gespeichert)' : 'gespeichert'}: ${saved.subject || saved.text.slice(0, 60)}`);
  if (notes.length) showNotice(`${saved.number} ist gespeichert. `, ...notes, ' ');
  broadcast({ type: 'msgs', opId: op.id });
  flashRow(saved.id);
  $('#m-from').focus();
}

// Who was heard, per operation, for the completion of the Funkstelle and
// the Ursprungsstation (Von/An are free text, no callsign search).
async function rememberStations(fields) {
  const call = fields.peer;
  if (!call || call === state.op.home) return;
  await state.store.tx([{ store: 'stations', put: { id: `${state.op.id}:${call}`, eventId: state.op.id, text: call, call, last: nowIso() } }]);
}

async function recentStations() {
  const list = state.op ? await state.store.getByEvent('stations', state.op.id) : [];
  return list.sort((a, b) => (a.last < b.last ? 1 : -1));
}

// Esc / "Verwerfen": an empty form is left alone; a filled one asks first
// (the bar: "Verwerfen" or "Weiter erfassen", Esc again = keep). After
// discarding, "Rückgängig" brings it back.
let discardReturn = null;

function askDiscard() {
  if (formIsEmpty(readForm()) && !state.editing) return;
  if (!$('#discard-bar').hidden) { keepEditing(); return; }
  discardReturn = document.activeElement?.closest('#msg-form') ? document.activeElement : $('#m-from');
  $('#warn-bar').hidden = true;
  $('#discard-bar').hidden = false;
  $('#btn-discard-no').focus();
}

function keepEditing() {
  $('#discard-bar').hidden = true;
  (discardReturn || $('#m-from')).focus();
}

function discardForm() {
  const before = readForm();
  const editing = state.editing;
  const editBase = state.editBase;
  $('#discard-bar').hidden = true;
  if (formIsEmpty(before) && !editing) return;
  resetForm();
  flushDraft();
  const status = $('#form-status');
  status.className = 'form-status';
  fill(status, editing ? 'Bearbeitung abgebrochen. ' : 'Eingabe verworfen. ',
    el('button', {
      type: 'button', class: 'link',
      onclick: () => { setEditing(editing, editBase); writeForm(before); fill(status); onFormChange(); $('#m-from').focus(); },
    }, 'Rückgängig'));
  $('#m-from').focus();
}

function startEdit(msg) {
  setEditing(msg);
  writeForm(messageToForm(msg));
  location.hash = `#/e/${state.op.id}`;
  setTimeout(() => $('#m-subject').focus(), 0);
}

function startReply(msg) {
  setEditing(null);
  writeForm(replyForm(msg, state.op));
  location.hash = `#/e/${state.op.id}`;
  setTimeout(() => $('#m-text').focus(), 0);
}

function initForm() {
  radioGroup($('#m-dir'), 'm-dir', { in: '↓ Eingang', out: '↑ Ausgang' });
  radioGroup($('#m-channel'), 'm-channel', CHANNELS);
  radioGroup($('#m-prio'), 'm-prio', PRIORITIES);
  fill($('#m-type'), Object.entries(MESSAGE_TYPES).map(([v, l]) => el('option', { value: v }, l)));
  fill($('#m-ref-kind'), Object.entries(REF_KINDS).map(([v, l]) => el('option', { value: v }, l)));
  const form = $('#msg-form');
  // Direction switch: the own post moves to the other side.
  $('#m-dir').addEventListener('change', () => {
    const f = readForm();
    const prev = f.direction === 'in' ? 'out' : 'in';
    const moved = setDirection({ ...f, direction: prev }, f.direction, state.op);
    $('#m-from').value = moved.from;
    $('#m-to').value = moved.to;
    onFormChange();
  });
  form.addEventListener('input', onFormChange);
  form.addEventListener('change', onFormChange);
  // one way to write a frequency: 145,500
  $('#m-freq').addEventListener('change', () => { $('#m-freq').value = fmtFreq($('#m-freq').value); });
  form.addEventListener('submit', ev => { ev.preventDefault(); saveMessage(); });
  form.addEventListener('keydown', ev => {
    if (isComposing(ev)) return;
    if (ev.key === 'Enter' && (ev.shiftKey || ev.ctrlKey || ev.metaKey)) {
      // ⇧⏎ / Strg+⏎ / ⌘⏎ save from any field; with the warnings shown,
      // saving again saves anyway
      ev.preventDefault();
      saveMessage({ anyway: !$('#warn-bar').hidden });
    } else if (ev.key === 'Enter' && ev.target.tagName === 'INPUT' && ev.target.type !== 'checkbox' && !ev.defaultPrevented) {
      ev.preventDefault();
      focusNext(form, ev.target);
    } else if (ev.key === 'Escape' && !ev.defaultPrevented) {
      ev.preventDefault();
      if (!$('#warn-bar').hidden) { $('#warn-bar').hidden = true; state.warned = ''; return; }
      askDiscard();
    }
  });
  $('#btn-discard').addEventListener('click', askDiscard);
  $('#btn-discard-yes').addEventListener('click', discardForm);
  $('#btn-discard-no').addEventListener('click', keepEditing);
  $('#btn-save-anyway').addEventListener('click', () => saveMessage({ anyway: true }));
  $('#btn-warn-back').addEventListener('click', () => { $('#warn-bar').hidden = true; state.warned = ''; $('#m-from').focus(); });
  new MutationObserver(() => { if ($('#warn-bar').hidden) showFieldWarnings(); }).observe($('#warn-bar'), { attributes: true, attributeFilter: ['hidden'] });
  $('#btn-form-op').addEventListener('click', () => { $('#op-panel').open = true; $('#e-operator').focus(); });

  // Typed dates and times are shown in the one format on leaving the field
  // ("1405" -> "14:05", "20261008" -> "2026-10-08"); unreadable ones stay
  // as typed for the error at the field.
  // A value typed or picked into a live field stops it running with the
  // clock (in the message form, date and time together).
  document.addEventListener('input', ev => {
    const t = ev.target;
    if (!(t instanceof HTMLInputElement) || !isLive(t)) return;
    for (const input of t.closest('.dt-pair')?.querySelectorAll('input.live') || [t]) setLive(input, false);
  }, true);
  document.addEventListener('focusout', ev => {
    const t = ev.target;
    if (!(t instanceof HTMLInputElement) || !t.matches('input.dt-date, input.dt-time')) return;
    const norm = t.matches('.dt-date') ? normDate(t.value) : normTime(t.value);
    if (norm && norm !== t.value) { t.value = norm; t.dispatchEvent(new Event('input', { bubbles: true })); }
  });

  // A click anywhere in a row of the book opens the message (the link on
  // its number is the keyboard way); not on the row's buttons, and not
  // when text was selected.
  $('#book-body').addEventListener('click', ev => {
    const row = ev.target.closest('tr[data-id]');
    if (!row || ev.target.closest('a, button, input, select, textarea')) return;
    if (String(globalThis.getSelection?.() || '')) return;
    const link = row.querySelector('td.num a');
    if (link) location.hash = link.getAttribute('href');
  });

  // Calendar and time grid next to the date and time fields.
  attachDatePicker($('#m-date'), $('#m-time'));
  attachTimePicker($('#m-stichzeit'));
  attachTimePicker($('#m-orig-filed'));
  attachDatePicker($('#pr-from-date'), $('#pr-from-time'));
  attachDatePicker($('#pr-to-date'), $('#pr-to-time'));

  // Completion: stations heard in this operation first, then the callbook.
  let recent = [];
  const refreshRecent = async () => { recent = (await recentStations()).filter(s => s.call).map(s => ({ call: s.call, title: s.text })); };
  for (const key of ['peer', 'orig-station']) {
    const input = $(`#m-${key}`);
    input.addEventListener('focus', refreshRecent);
    attachCallSearch({
      input, pop: $(`#m-${key}-pop`),
      // No callbook guesses for the own post ("Stab" is no callsign).
      getBook: () => (input.value.trim() === state.op?.home ? null : state.callbook),
      recent: () => (input.value.trim() === state.op?.home ? [] : recent),
      onPick: onFormChange,
    });
  }
  state.rptSearch = attachRepeaterSearch({
    input: $('#m-via'), pop: $('#m-via-pop'), info: $('#m-via-info'),
    getHeader: () => ({ myGrid: '', repeaterFreq: $('#m-freq').value }),
    onPick: r => { if (r.out) $('#m-freq').value = fmtFreq(formatMHz(r.out)); onFormChange(); },
  });
  // Location lookups: they add a resolved place next to the text typed,
  // never change the message text.
  state.locField = createLocationField({
    input: $('#m-loc'), chip: $('#m-loc-info'), results: $('#m-loc-pop'), onChange: onFormChange,
  });
  state.origLocField = createLocationField({
    input: $('#m-orig-place'), chip: $('#m-orig-place-info'), results: $('#m-orig-place-pop'), onChange: onFormChange,
  });
  initHelpDialog({ keys: ['F1'] }); // "? Hilfe" in the header, F1, ? outside text fields
}

/* ---------------------------------------------------------------- help */

/* ---------------------------------------------------------------- the book */

const FILTERS = {
  all: {}, open: { open: true }, in: { direction: 'in' }, out: { direction: 'out' }, urgent: { urgent: true },
};

function pill(cls, text) {
  return el('span', { class: `pill ${cls}` }, text);
}

function statusPill(msg) {
  const s = currentStatus(msg);
  return pill(`st-${s}`, statusLabel(s, msg.direction));
}

function prioPill(msg) {
  return msg.priority === 'routine' ? el('span', { class: 'dim' }, PRIORITIES.routine) : pill(`pr-${msg.priority}`, PRIORITIES[msg.priority]);
}

// Stores a changed message (status step, attempt) and says so.
// change(cur) gets the message as stored (it is the one the user saw, or the
// write is refused: ConflictError, shown as such) and returns the new record.
async function storeMsg(msg, change, text) {
  try {
    await updateMessage(state.store, msg, cur => ({ next: change(cur) }));
  } catch (e) {
    if (e instanceof ConflictError) await onConflict(msg.number, false);
    else showSaveError(e);
    return false;
  }
  await reloadMsgs();
  bookStatus(text);
  broadcast({ type: 'msgs', opId: state.op.id });
  return true;
}

// A status step: now, by the operator, with optional details (to whom,
// confirmed by whom, at what time).
async function advance(msg, state_, details = {}) {
  const step = { operator: state.op.operator || '', now: nowIso(), ...details };
  try {
    setStatus(msg, state_, step); // refused here: already recorded, or a step back
  } catch (e) {
    return e.message;
  }
  return await storeMsg(msg, cur => setStatus(cur, state_, step), `${msg.number}: ${statusLabel(state_, msg.direction)}`) ? '' : 'nicht gespeichert';
}

function renderSummary() {
  const s = bookSummary(state.msgs);
  fill($('#book-summary'),
    s.emergencyOpen ? el('span', { class: 'sum sum-err' }, el('b', {}, String(s.emergencyOpen)), ' Notfall offen') : null,
    s.unacknowledged ? el('span', { class: 'sum sum-warn' }, el('b', {}, String(s.unacknowledged)), ' noch nicht bestätigt') : null,
    el('span', { class: 'sum' }, el('b', {}, String(s.total)), ` Meldungen${s.range.length ? ` · ${s.range.join(', ')}` : ''}${s.gaps.length ? '' : s.total ? ', lückenlos' : ''}`),
    s.gaps.length ? el('span', { class: 'sum sum-err' }, `Lücke: ${s.gaps.join(', ')}`) : null);
}

// A party by its name (the callsign only when there is no name): the book
// shows who, the message itself the callsign.
function partyName(p) {
  return p?.name || p?.call || '';
}

// The own side (recipient of incoming, sender of outgoing messages) that
// most live messages have.
function usualOwnSide(msgs) {
  const count = new Map();
  for (const m of msgs) {
    if (m.deleted) continue;
    const own = partyName(m.direction === 'in' ? m.to : m.from);
    if (own) count.set(own, (count.get(own) || 0) + 1);
  }
  return [...count].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
}

// The rows of the book (see renderBook).
const bookRows = createRowCache();
let bookOp = null;

function renderBook() {
  if (!state.op) return;
  renderFormState();
  renderSummary();
  const f = FILTERS[state.filter];
  let list = filterMessages(state.msgs, { ...f, urgent: undefined, query: state.query });
  if (f.urgent) list = list.filter(m => m.priority !== 'routine');
  list.reverse(); // newest first
  state.bookList = list;
  notfunkRefreshMap(mapContext(list));
  const body = $('#book-body');
  if (!list.length) {
    resetRows(bookRows);
    fill(body, rowRoles(el('tr', {}, el('td', { colspan: '6', class: 'empty' }, state.msgs.some(m => !m.deleted) ? 'Keine Meldung passt zum Filter.' : 'Noch keine Meldungen. Die erste oben eintragen.'))));
  } else {
    // Rows are kept between renders (keyed by message id, signature = the
    // message's `updated` token): a new or changed message builds one row,
    // searching/filtering only moves, adds and removes rows.
    if (bookOp !== state.op.id) { resetRows(bookRows); bookOp = state.op.id; }
    // Operations run over days: a time shows its date when that is not the
    // newest message's day (so a day change is visible without hovering).
    const today = viennaDate(list[0].ts);
    const dateOf = iso => { const d = viennaDate(iso); return d && d !== today ? d : ''; };
    // the own side most messages have (in practice the Einsatz's "Für
    // Stelle", which the form fills in); shown only where a message differs
    const home = usualOwnSide(state.msgs) || state.op.home || '';
    const numberOf = new Map(state.msgs.map(x => [x.id, x.number]));
    syncRows(body, bookRows, list, { key: m => m.id, sig: m => `${m.updated}|${m.deleted || ''}|${m.status.length}|${dateOf(m.ts)}|${dateOf(m.status[m.status.length - 1].at)}|${home}|${numberOf.get(m.replyTo) || ''}`, build: m => {
      const step = nextStep(m);
      const last = m.status[m.status.length - 1];
      const dated = (iso, text) => {
        const d = dateOf(iso);
        return d ? [el('span', { class: 'date' }, d), ' ', text] : text;
      };
      // the other party with the direction; the own post (the Einsatz's
      // "Für Stelle") is the same in every row and shown only where it differs
      const inbound = m.direction === 'in';
      const peer = partyName(inbound ? m.from : m.to);
      const own = partyName(inbound ? m.to : m.from);
      const refTo = m.replyTo ? numberOf.get(m.replyTo) : m.refNumber;
      return rowRoles(el('tr', { 'data-id': m.id, class: m.priority === 'emergency' ? 'urgent' : null },
        // Nr., the time, the reference (Meldesammelstelle's, the message it answers)
        el('td', { class: 'num' }, el('a', { href: `#/e/${state.op.id}/m/${m.id}` }, m.number),
          el('div', { class: 'when mono', title: viennaStamp(m.ts) }, ...[dated(m.ts, viennaTime(m.ts))].flat()),
          m.staffRef ? el('div', { class: 'ref', title: 'Referenz der Meldesammelstelle' }, m.staffRef) : null,
          refTo ? el('div', { class: 'ref', title: 'Bezug: Antwort auf diese Meldung' }, `↪ ${refTo}`) : null),
        el('td', { class: 'peer' },
          el('div', { class: 'peer-line', title: inbound ? 'Eingang: von' : 'Ausgang: an' },
            // the arrow alone on screen; screen readers hear "von" / "an"
            el('span', { class: 'arrow', 'aria-hidden': 'true' }, inbound ? '↓' : '↑'), el('span', {}, el('span', { class: 'sr-only' }, inbound ? 'von ' : 'an '), peer)),
          own && own !== home ? el('div', { class: 'sub' }, inbound ? `an ${own}` : `von ${own}`) : null),
        // the type always, as a label; the priority when not routine
        el('td', { class: 'content' },
          el('div', { class: 'subj' }, el('span', { class: 'kind', title: 'Meldungsart' }, MESSAGE_TYPES[m.type] || m.type),
            m.priority === 'routine' ? null : prioPill(m), el('b', {}, m.subject || '')),
          el('div', { class: 'sub clamp' }, m.text)),
        el('td', { class: 'st' }, statusPill(m)),
        el('td', { class: 'st-when mono', title: viennaStamp(last.at) }, el('span', {}, ...[dated(last.at, viennaTime(last.at))].flat()), el('br'), el('span', { class: 'by' }, last.by || '')),
        el('td', { class: 'act' }, el('div', { class: 'act-stack' },
          step ? el('button', { type: 'button', class: 'mini next', 'aria-haspopup': 'dialog', onclick: () => openStepDialog(m, step), 'aria-label': `${m.number} ${step.label} …` }, step.label) : null,
          el('button', { type: 'button', class: 'mini', onclick: () => printForm(m), 'aria-label': `Ausdruck ${m.number} (Meldeaufnahmeformular)` }, 'Ausdruck')))));
    } });
  }
  markEditing();
  renderTrash();
}

function renderTrash() {
  const gone = state.msgs.filter(m => m.deleted).sort((a, b) => a.seq - b.seq);
  $('#trash-panel').hidden = !gone.length;
  fill($('#trash-list'), gone.map(m => el('li', {},
    el('span', { class: 'mono' }, m.number), ` ${m.subject || m.text.slice(0, 40)} – gelöscht ${fmtVienna(m.deleted)}${m.deletedBy ? ` von ${m.deletedBy}` : ''} `,
    el('button', { type: 'button', class: 'mini', onclick: () => restoreMsg(m) }, 'Wiederherstellen'))));
}

function flashRow(id) {
  const tr = $('#book-body')?.querySelector(`tr[data-id="${id}"]`);
  if (!tr) return;
  tr.classList.add('fresh');
  setTimeout(() => tr.classList.remove('fresh'), 2500);
}

async function deleteMsg(m) {
  if (!confirm(`${m.number} löschen? Die Nummer bleibt vergeben, die Meldung kommt in „Gelöschte Meldungen“ und kann wiederhergestellt werden.`)) return;
  const operator = state.op.operator || '';
  const now = nowIso();
  await storeMsg(m, cur => softDelete(cur, { operator, now }), `${m.number} gelöscht (Nummer bleibt vergeben)`);
}

async function restoreMsg(m) {
  const now = nowIso();
  await storeMsg(m, cur => restoreDeleted(cur, { now }), `${m.number} wiederhergestellt`);
}

/* ---------------------------------------------------------------- one message */

// A small inline form in the detail view (a status step, the staff
// reference, an announcement): labelled inputs, a button, an error line.
// fields: [{ key, label, value, placeholder, mono, check, time }] (time: a
// time-of-day input, empty = now); onSubmit(values)
// returns an error text or ''.
let inlineSeq = 0;
function inlineForm(fields, button, onSubmit) {
  const err = el('div', { class: 'ferr', role: 'status' });
  const inputs = {};
  const rows = fields.map(f => {
    const id = `if-${++inlineSeq}`;
    if (f.check) {
      inputs[f.key] = el('input', { type: 'checkbox', id });
      return el('label', { class: 'check', for: id }, inputs[f.key], ` ${f.label}`);
    }
    inputs[f.key] = el('input', { id, class: f.time ? 'mono dt-time' : f.mono ? 'mono' : null, inputmode: f.time ? 'numeric' : null, maxlength: f.time ? '5' : null, placeholder: f.time ? 'HH:MM' : f.placeholder || null, value: f.value || '', autocomplete: 'off' });
    // names used before in this Einsatz: the app's own suggestion list (the
    // same in every browser; a native datalist swallows Enter in Safari).
    // Enter records, ↓ then Enter or a click takes a name.
    const control = f.suggest?.length ? suggestNames(inputs[f.key], f.suggest) : inputs[f.key];
    const row = el('label', { class: 'field', for: id }, el('span', {}, f.label, f.time ? el('span', { class: 'dim' }, ' (leer = jetzt)') : null), control);
    if (f.time) { attachTimePicker(inputs[f.key]); setLive(inputs[f.key], true); }
    return row;
  });
  const form = el('form', { class: 'inline-form', autocomplete: 'off', novalidate: '' },
    el('div', { class: 'inline-fields' }, ...rows.filter(r => r.classList.contains('field'))),
    ...rows.filter(r => !r.classList.contains('field')),
    el('div', { class: 'inline-foot' }, el('button', { type: 'submit' }, button), err));
  form.addEventListener('submit', async ev => {
    ev.preventDefault();
    // a live time field (still running with the clock) means "now"
    const values = Object.fromEntries(Object.entries(inputs).map(([k, i]) => [k, i.type === 'checkbox' ? i.checked : isLive(i) ? '' : i.value.trim()]));
    err.textContent = await onSubmit(values) || '';
  });
  return form;
}

// A name field with suggestions (names used in this Einsatz): the field in
// an .ac-wrap with its list, filtered by what is typed.
function suggestNames(input, names) {
  const pop = el('div', { class: 'ac-pop' });
  const wrap = el('div', { class: 'ac-wrap' }, input, pop);
  const ctl = popover(input, pop, { enterPicksFirst: false, label: 'Namen aus diesem Einsatz' });
  const render = () => {
    const q = input.value.trim().toLowerCase();
    const hits = names.filter(n => n.toLowerCase() !== q && (!q || n.toLowerCase().includes(q))).slice(0, 8);
    fill(pop, hits.map(n => el('button', { type: 'button', class: 'ac-item', onclick: () => { input.value = n; fill(pop); ctl.hide(); input.focus(); } }, n)));
    ctl.update();
  };
  // only while typing, or with ↓: an open list never covers the buttons
  // under the field when it gets the focus
  input.addEventListener('input', render);
  input.addEventListener('keydown', ev => {
    if (ev.key === 'ArrowDown' && pop.hidden) { ev.preventDefault(); render(); pop.querySelector('button')?.focus(); }
  });
  input.addEventListener('blur', () => setTimeout(() => { if (!wrap.contains(document.activeElement)) fill(pop); }, 200));
  return wrap;
}

// A time of day (the last one before now, so after midnight the day
// before; empty = now) or an error.
function stepTime(text) {
  if (!text) return { at: null };
  const at = readClock(text, nowIso());
  return at ? { at } : { error: 'Zeitpunkt als Uhrzeit (HH:MM)' };
}

// The handling of a message as steps: taken down, read back, saved, then
// handed over / transmitted and confirmed, each with who and when. Steps
// not done yet get a small form (a step can be skipped, never undone).
function flowCard(m) {
  const out = m.direction === 'out';
  const editable = !m.deleted;
  const when = (iso, by) => [fmtVienna(iso), by].filter(Boolean).join(' · ');
  const item = (done, label, ...detail) => el('li', { class: done ? 'done' : '' },
    el('span', { class: 'dot', 'aria-hidden': 'true' }),
    el('div', {}, el('div', { class: 'step-label' }, label, done ? el('span', { class: 'sr-only' }, ' (erledigt)') : null), ...detail));
  const fwd = statusEntry(m, 'forwarded');
  const ack = statusEntry(m, 'acknowledged');
  const ans = statusEntry(m, 'answered');
  const items = [];
  if (out) {
    items.push(item(true, 'Liegt zur Übertragung vor', el('div', { class: 'sub mono' }, `${m.number} · ${when(m.created, m.operator)}`)));
  } else {
    items.push(item(true, 'Wortlaut aufgenommen', el('div', { class: 'sub mono' }, when(m.ts, m.operator))));
    items.push(item(m.readBack, 'Rücklesen bestätigt', el('div', { class: 'sub' }, m.readBack ? 'vom Absender als richtig bestätigt' : 'nicht vermerkt')));
    items.push(item(true, `Gesichert als ${m.number}`, el('div', { class: 'sub mono' }, fmtVienna(m.created))));
  }
  for (const a of m.attempts || []) {
    items.push(el('li', { class: 'attempt' }, el('span', { class: 'dot', 'aria-hidden': 'true' }),
      el('div', {}, el('div', { class: 'step-label' }, 'Fehlversuch / Rückfrage'), el('div', { class: 'sub mono' }, [when(a.at, a.by), a.note].filter(Boolean).join(' · ')))));
  }
  const stepForm = (state_) => {
    // only the next step gets a form (one at a time, in order)
    if (!editable || nextStep(m)?.state !== state_) return null;
    const { fields, button, submit } = stepInputs(m, state_);
    return inlineForm(fields, button, submit);
  };
  items.push(item(!!fwd, out ? 'Übertragen' : 'Übergeben',
    fwd ? el('div', { class: 'sub mono' }, [fwd.to && `an ${fwd.to}`, when(fwd.at, fwd.by), fwd.readBack ? 'rückgelesen ✓' : ''].filter(Boolean).join(' · ')) : stepForm('forwarded')));
  items.push(item(!!ack, out ? 'Empfang bestätigt' : 'Übernahme bestätigt',
    ack ? el('div', { class: 'sub mono' }, [ack.who && `durch ${ack.who}`, when(ack.at, ack.by)].filter(Boolean).join(' · ')) : stepForm('acknowledged')));
  items.push(item(!!ans, 'Beantwortet', el('div', { class: 'sub' }, ans ? `${when(ans.at, ans.by)}${ans.note ? ` · ${ans.note}` : ''}` : 'mit „Antwort erfassen“')));
  return el('section', { 'aria-label': 'Ablauf' },
    el('h3', { class: 'cap' }, out ? 'Ablauf (Ausgang)' : 'Ablauf (Eingang)'),
    el('ol', { class: 'steps' }, items),
    out && editable && !ack ? el('details', { class: 'attempt-add' }, el('summary', {}, 'Fehlversuch / Rückfrage eintragen'),
      inlineForm([{ key: 'note', label: 'Was war', placeholder: 'z. B. keine Antwort, Rückfrage zu …' }, { key: 'at', label: 'Zeitpunkt', time: true }],
        'Eintragen', async v => {
          const t = stepTime(v.at);
          if (t.error) return t.error;
          const attempt = { operator: state.op.operator || '', now: nowIso(), at: t.at, note: v.note };
          return await storeMsg(m, cur => addAttempt(cur, attempt), `${m.number}: Fehlversuch / Rückfrage vermerkt`) ? '' : 'nicht gespeichert';
        })) : null,
    el('p', { class: 'hint' }, out
      ? '„Übertragen“ heißt: gesendet. Erst „Empfang bestätigt“ heißt, die Funkstelle hat sie.'
      : '„Übergeben“ heißt: die Meldung liegt bei der Meldesammelstelle. Es heißt nicht, dass ein Auftrag im Inhalt erledigt ist.'));
}

// A status step's inputs, the same in the detail view's Ablauf and in the
// dialog from the book's step button: to whom (handed over / sent) or by
// whom (taken over / receipt confirmed) and when; the Meldesammelstelle's
// reference with the takeover of an incoming message (it usually comes
// then). The name fields suggest the names used in this Einsatz.
function stepInputs(m, state_) {
  const out = m.direction === 'out';
  const names = usedNames();
  const fields = state_ === 'forwarded'
    ? [{ key: 'to', label: out ? 'Übertragen an' : 'Übergeben an', value: out ? m.peer : lastUsed('forwarded', 'to', m.direction), placeholder: out ? 'Funkstation' : 'Meldesammelstelle', suggest: names },
      { key: 'at', label: out ? 'Übertragungszeitpunkt' : 'Übergabezeitpunkt', time: true },
      ...(out ? [{ key: 'readBack', label: readBackLabel('out'), check: true }] : [])]
    : [{ key: 'who', label: out ? 'Empfang bestätigt durch' : 'Übernommen durch', value: out ? m.peer : '', placeholder: out ? 'Funkstation' : 'Name / Funktion', suggest: names },
      { key: 'at', label: 'Zeitpunkt', time: true },
      ...(!out ? [{ key: 'ref', label: 'Referenz der Meldesammelstelle (optional)', value: m.staffRef || '', mono: true }] : [])];
  const button = state_ === 'forwarded' ? (out ? 'Übertragung eintragen' : 'Übergabe eintragen') : (out ? 'Empfang eintragen' : 'Übernahme eintragen');
  const submit = async v => {
    const t = stepTime(v.at);
    if (t.error) return t.error;
    const err = await advance(m, state_, { at: t.at, to: v.to || '', who: v.who || '', readBack: !!v.readBack });
    if (err) return err;
    const fresh = state.msgs.find(x => x.id === m.id) || m;
    if (v.ref !== undefined && v.ref !== (fresh.staffRef || '')) return saveStaffRef(fresh, v.ref);
    return '';
  };
  return { fields, button, submit };
}

// Names used in this Einsatz for whom a message went to or came from:
// earlier handovers and takeovers, the own post, Verteiler, the parties;
// the most used first.
function usedNames() {
  const count = new Map();
  const add = v => { if (v && v.trim()) count.set(v.trim(), (count.get(v.trim()) || 0) + 1); };
  add(state.op?.home);
  for (const m of state.msgs) {
    if (m.deleted) continue;
    for (const s of m.status) { add(s.to); add(s.who); }
    for (const d of m.distribution || []) add(d);
    add(m.from?.name); add(m.to?.name);
  }
  return [...count].sort((a, b) => b[1] - a[1]).map(([v]) => v).slice(0, 30);
}

// The value given at this step last time (for incoming handovers: usually
// the same Meldesammelstelle every time).
function lastUsed(state_, key, direction) {
  let best = null;
  for (const m of state.msgs) {
    if (m.deleted || m.direction !== direction) continue;
    const s = statusEntry(m, state_);
    if (s?.[key] && (!best || s.at > best.at)) best = s;
  }
  return best?.[key] || '';
}

// The book's step button: the step's inputs in a small dialog (the book
// stays as it is behind it). Enter records, Esc closes.
function openStepDialog(m, step) {
  let dlg = $('#step-dlg');
  if (!dlg) {
    dlg = el('dialog', { id: 'step-dlg', class: 'step-dlg', 'aria-labelledby': 'step-dlg-title' });
    document.body.append(dlg);
  }
  const { fields, button, submit } = stepInputs(m, step.state);
  const form = inlineForm(fields, button, async v => {
    const err = await submit(v);
    if (!err) dlg.close();
    return err;
  });
  form.querySelector('button[type=submit]').classList.add('primary');
  form.querySelector('.inline-foot').classList.add('over-suggestions');
  form.querySelector('.inline-foot').append(el('button', { type: 'button', onclick: () => dlg.close() }, 'Abbrechen'));
  fill(dlg, el('div', { class: 'step-dlg-body' },
    el('h2', { id: 'step-dlg-title' }, `${m.number}: ${step.label}`),
    el('p', { class: 'sub' }, m.subject || ''),
    form));
  const opener = document.activeElement;
  dlg.onclose = () => {
    // back to the row (it may have been rebuilt meanwhile)
    const row = $('#book-body')?.querySelector(`tr[data-id="${m.id}"]`);
    (row?.querySelector('.act-stack button') || row?.querySelector('a') || opener)?.focus?.();
  };
  dlg.showModal();
  form.querySelector('input:not([type=checkbox])')?.select();
}

// The Meldesammelstelle's reference (detail view and step dialog).
async function saveStaffRef(m, ref) {
  const meta = { revisionId: newId(), operator: state.op.operator || '', now: nowIso() };
  try {
    await updateMessage(state.store, m, cur => editMessage(cur, { staffRef: ref }, meta));
  } catch (e) {
    if (e instanceof ConflictError) await onConflict(m.number, false);
    else showSaveError(e);
    return 'nicht gespeichert';
  }
  await reloadMsgs();
  bookStatus(`${m.number}: Referenz der Meldesammelstelle ${ref || 'entfernt'}`);
  broadcast({ type: 'msgs', opId: state.op.id });
  return '';
}

// The Meldesammelstelle's own number, to match the two lists. Changing it
// keeps the previous version, like any edit.
function staffRefCard(m) {
  return el('section', { class: 'staff-card', 'aria-label': 'Referenz der Meldesammelstelle' },
    el('h3', { class: 'cap' }, 'Referenz der Meldesammelstelle'),
    m.deleted ? el('p', {}, m.staffRef || '–') : inlineForm([{ key: 'ref', label: 'Referenz / Geschäftsbuch-Nr.', value: m.staffRef || '', mono: true }],
      m.staffRef ? 'Referenz ändern' : 'Referenz eintragen', async v => (v.ref === (m.staffRef || '') ? '' : saveStaffRef(m, v.ref))),
    el('p', { class: 'hint' }, `Nur zum Zuordnen: die Nummer, unter der die Meldesammelstelle die Meldung führt. Nicht die Notfunk-Nr. ${m.number}.`));
}

function renderDetail(id) {
  const m = state.msgs.find(x => x.id === id);
  const box = $('#msg-detail');
  if (!m) {
    $('#msg-title').textContent = 'Meldung';
    fill(box, el('p', { class: 'empty' }, 'Diese Meldung gibt es in diesem Einsatz nicht.'));
    return;
  }
  $('#msg-title').textContent = m.number;
  const byId = new Map(state.msgs.map(x => [x.id, x]));
  const revs = state.revisions.filter(r => r.messageId === m.id).sort((a, b) => (a.at < b.at ? 1 : -1));
  // a small block under the text: caption and value (left out when empty)
  const fact = (cap, ...v) => (v.some(x => x != null && x !== '') ? el('div', { class: 'fact' }, el('div', { class: 'cap' }, cap), el('div', { class: 'val' }, ...v)) : null);
  // a party: name, the callsign grey after it
  const party = p => [p?.name || p?.call || '–', p?.name && p?.call && p.call !== p.name ? el('span', { class: 'call' }, ` ${p.call}`) : null];
  const link = x => el('a', { href: `#/e/${state.op.id}/m/${x.id}`, class: 'mono' }, x.number);
  const replies = repliesTo(state.msgs, m.id);
  const ref = m.replyTo && byId.get(m.replyTo);
  const refKind = REF_KINDS[m.refKind] || REF_KINDS.antwort;
  fill(box, el('div', { class: 'detail' },
    el('article', { class: 'detail-main' },
      el('div', { class: 'detail-tags' },
        m.deleted ? pill('st-deleted', 'gelöscht') : null,
        statusPill(m),
        m.priority !== 'routine' ? pill(`pr-${m.priority}`, PRIORITIES[m.priority]) : null,
        el('span', { class: 'kind', title: 'Meldungsart' }, MESSAGE_TYPES[m.type] || m.type),
        el('span', { class: 'dim', title: timeLabel(m.direction) }, `${m.direction === 'in' ? '↓' : '↑'} ${DIRECTIONS[m.direction]} · `, el('span', { class: 'mono' }, fmtVienna(m.ts))),
        m.staffRef ? el('span', { class: 'chip', title: 'Referenz der Meldesammelstelle' }, `Ref. ${m.staffRef}`) : null),
      el('h3', { class: 'detail-subject' }, m.subject || '(ohne Betreff)'),
      // what the message refers to, right under its subject
      ref ? el('div', { class: 'detail-bezug' }, `↪ ${refKind} `, link(ref), ` ${ref.subject || ''}`)
        : m.refNumber ? el('div', { class: 'detail-bezug' }, `↪ ${refKind} `, el('span', { class: 'mono' }, m.refNumber)) : null,
      // who to whom, as on the paper form; the Verteiler below
      el('div', { class: 'route', role: 'group', 'aria-label': 'Von, an' },
        el('div', {}, el('div', { class: 'side-cap' }, 'Von (Absender)'), el('div', { class: 'who' }, ...party(m.from))),
        el('div', { class: 'arrow', 'aria-hidden': 'true' }, '→'),
        el('div', {}, el('div', { class: 'side-cap' }, 'An (Adressat)'), el('div', { class: 'who' }, ...party(m.to))),
        m.distribution.length ? el('div', { class: 'verteiler' }, `Verteiler: ${m.distribution.join(', ')}`) : null),
      el('section', { class: 'verbatim', 'aria-label': 'Inhalt, wörtlich' },
        el('div', { class: 'cap' }, 'Inhalt – wörtlich'),
        el('p', {}, m.text || '–'),
        el('div', { class: m.readBack ? 'sub ok' : 'sub' }, m.readBack ? `✓ ${readBackLabel(m.direction)}` : 'Rücklesen nicht vermerkt')),
      // the rest in small blocks ("Erfasst" is the Ablauf's first step)
      el('div', { class: 'facts' },
        fact('Übermittlung', [CHANNELS[m.channel], m.channel === 'funk' && m.radio.freq && `${fmtFreq(m.radio.freq)} MHz`,
          m.channel === 'funk' ? (m.radio.via ? `via ${m.radio.via}` : 'direkt') : null].filter(Boolean).join(' · '),
          m.peer ? el('div', {}, el('span', { class: 'dim', title: m.direction === 'out' ? 'die empfangende Funkstation' : 'die übermittelnde Funkstation' }, 'Funkstelle '), el('span', { class: 'mono' }, m.peer)) : null),
        m.location ? fact('Ort', describeLocation(m.location), el('div', { class: 'links' }, mapLinks(m.location)))
          : m.locationText ? fact('Ort', m.locationText, el('span', { class: 'dim' }, ' (nicht zugeordnet)')) : null,
        m.stichzeit ? fact('Stichzeit', el('span', { class: 'mono' }, fmtVienna(m.stichzeit))) : null,
        m.origin.station || m.origin.place || m.origin.filed ? fact('Ursprung',
          [m.origin.station, m.origin.placeLoc ? describeLocation(m.origin.placeLoc) : m.origin.place].filter(Boolean).join(' · '),
          m.origin.filed ? el('div', {}, el('span', { class: 'dim' }, 'aufgegeben '), el('span', { class: 'mono' }, fmtVienna(m.origin.filed))) : null) : null,
        m.remarks ? el('div', { class: 'fact wide' }, el('div', { class: 'cap' }, 'Anmerkungen'), el('div', { class: 'val' }, m.remarks)) : null),
      el('div', { class: 'toolbar detail-actions' },
        m.deleted ? null : el('button', { type: 'button', onclick: () => startReply(m) }, 'Antwort erfassen'),
        m.deleted ? null : el('button', { type: 'button', onclick: () => startEdit(m) }, 'Bearbeiten'),
        el('button', { type: 'button', class: 'primary', onclick: () => printForm(m) }, 'Ausdruck / PDF'),
        m.deleted
          ? el('button', { type: 'button', onclick: () => restoreMsg(m) }, 'Wiederherstellen')
          : el('button', { type: 'button', class: 'danger', onclick: () => deleteMsg(m) }, 'Löschen'))),
    el('aside', { class: 'detail-side' },
      flowCard(m),
      staffRefCard(m),
      el('section', { 'aria-label': 'Antworten' },
        el('h3', { class: 'cap' }, 'Antworten'),
        el('p', {}, replies.length ? replies.flatMap((r, i) => [i ? ', ' : '', link(r)]) : el('span', { class: 'dim' }, 'noch keine'))),
      el('section', { 'aria-label': 'Fassungen' },
        el('h3', { class: 'cap' }, 'Fassungen'),
        revs.length ? el('ul', { class: 'revs' }, revs.map(r => el('li', {},
          el('details', {},
            el('summary', {}, el('span', { class: 'mono' }, `${fmtVienna(r.at)} ${r.by || ''}`), ' geändert; vorher:'),
            el('div', { class: 'sub' }, el('b', {}, r.old.subject || ''), ' ', r.old.text, r.old.staffRef !== undefined && r.old.staffRef !== m.staffRef ? ` · Referenz: ${r.old.staffRef || '–'}` : ''))))) : null,
        el('p', { class: 'sub' }, el('span', { class: 'mono' }, `${fmtVienna(m.created)} ${m.operator || ''}`), ' erfasst'),
        el('p', { class: 'hint' }, 'Jede Änderung behält die vorige Fassung. Die Nummer bleibt immer gleich.')))));
}

/* ---------------------------------------------------------------- print, exports, backup */

// One message as a PDF (paperpdf.js): the filled Meldeaufnahmeformular on an
// A4 page (more for a very long text), opened in a new tab to print at its
// own size. The same in every browser: no print dialog settings to get right.
function printForm(m) {
  const revisions = state.revisions.filter(r => r.messageId === m.id).length;
  const byId = new Map(state.msgs.map(x => [x.id, x]));
  pdfOpen(formPdf(m, state.op, { now: nowIso(), revisions, byId }), `${fileStem()}_${m.number}.pdf`);
}

// An empty form (for a stack of paper forms) as a PDF (paperpdf.js), opened
// in a new tab to print at its own size: with the operation's name when one
// is open. It prints the same in every browser; the number of copies is
// chosen in the print dialog of the PDF viewer.
function printBlankForm() {
  pdfOpen(blankFormPdf(state.op, { now: nowIso() }), state.op ? `${fileStem()}_Vordruck.pdf` : 'Notfunk_Vordruck.pdf');
}

// The book of a time range as a PDF (bookpdf.js), A4 landscape.
function printBook() {
  const status = $('#pr-status');
  const now = nowIso();
  const v = id => $(id).value;
  const fromIso = readBound(v('#pr-from-date'), v('#pr-from-time'), now);
  const toIso = readBound(v('#pr-to-date'), v('#pr-to-time'), now, true);
  if ((!fromIso && (v('#pr-from-date') || v('#pr-from-time'))) || (!toIso && (v('#pr-to-date') || v('#pr-to-time')))) {
    status.textContent = 'Diese Zeit gibt es nicht (Zeitumstellung?).';
    return;
  }
  status.textContent = '';
  pdfOpen(bookPdf(state.msgs, state.op, { now, fromIso, toIso }), `${fileStem()}_Meldebuch.pdf`);
}

async function exportBackup() {
  // What is committed in the storage, not this tab's memory (after a failed
  // save or a change in another tab it may be stale); the memory only when
  // the storage can't be read.
  const id = state.op.id;
  let data;
  let fromMemory = false;
  try {
    const [operation, messages, revisions, counters] = await Promise.all([
      state.store.get('operations', id), state.store.getByEvent('messages', id),
      state.store.getByEvent('revisions', id), state.store.getByEvent('counters', id),
    ]);
    data = { operation: operation || state.op, messages, revisions, counters };
  } catch (e) {
    console.warn('Sicherung aus dem Speicher des Tabs', e);
    fromMemory = true;
    data = { operation: state.op, messages: state.msgs, revisions: state.revisions, counters: state.counter ? [state.counter] : [] };
  }
  const now = nowIso();
  // one file, or - beyond what an import accepts (50 MB, 200000 records) -
  // several parts, imported together; nothing is left out
  let texts;
  try {
    texts = toBackupTexts(data, now, newId(), globalThis.NOTFUNK_PART_LIMITS); // (test hook)
  } catch (e) {
    if (!e.tooLarge) throw e;
    showNotice(el('strong', {}, 'Nicht gesichert. '), e.message); // refused before anything is downloaded
    return;
  }
  for (const [i, text] of texts.entries()) {
    if (i) await new Promise(r => setTimeout(r, 400)); // browsers ask before many downloads at once
    download(text, texts.length === 1 ? `${fileStem()}-sicherung.json` : partFileName(`${fileStem()}-sicherung`, i + 1, texts.length), 'application/json');
  }
  const lead = texts.length > 1
    ? `Sicherung (JSON): Download von ${texts.length} Dateien gestartet (große Sicherung, geteilt). Prüfen Sie, dass alle ${texts.length} angekommen sind – der Browser fragt eventuell, ob mehrere Downloads erlaubt sind. Beim Import alle Teile gemeinsam auswählen`
    : 'Download der Sicherung (JSON) gestartet';
  const text = fromMemory ? `${lead} – der Speicher war nicht lesbar, sie enthält den Stand dieses Tabs` : lead;
  if (texts.length > 1) fill($('#book-status'), text); // neutral, no check mark: not known to have all arrived
  else bookStatus(text);
  // in parts: not known to have all arrived, so no "Sicherung gestartet" time
  if (texts.length === 1) await updateOp(state.op, { backupAt: now });
  renderBackupChip();
}

// How current the last backup (JSON) of the open operation is: messages
// saved or changed since then. A click downloads a new one.
function renderBackupChip() {
  const chip = $('#st-backup');
  if (!state.op || $('#view-ops').hidden === false) { chip.hidden = true; return; }
  const at = state.op.backupAt;
  const since = state.msgs.filter(m => !at || m.updated > at).length;
  chip.hidden = !at && !since;
  // no green "ok": a started download is not a verified backup
  chip.className = `chip chip-btn${since ? ' warn' : ''}`;
  setText(chip, at
    ? `Sicherung gestartet ${viennaTime(at)}${since ? ` · ${since} ${since === 1 ? 'Meldung' : 'Meldungen'} ungesichert` : ' · nichts ungesichert'}`
    : `Noch keine Sicherung · ${since} ${since === 1 ? 'Meldung' : 'Meldungen'}`);
}

function showImportMsg(cls, ...content) {
  const box = $('#import-msg');
  box.className = `banner ${cls}`;
  fill(box, ...content, el('button', { type: 'button', onclick: () => { box.hidden = true; } }, 'ausblenden'));
  box.hidden = false;
}

// One or more selected files: single backups as before, the parts of a backup
// written in parts only all together, each set in ONE atomic write (a file or
// set with a problem writes nothing).
async function importFiles(files) {
  const loaded = [];
  const results = [];
  const bad = (...msg) => results.push({ cls: 'err', content: [el('strong', {}, 'Nicht importiert: '), ...msg] });
  const tooBig = partsTooLarge(files.reduce((n, f) => n + f.size, 0));
  if (tooBig) { showImportMsg('err', el('strong', {}, 'Nicht importiert: '), tooBig); return; }
  for (const file of files) {
    if (file.size > BACKUP_MAX_BYTES) {
      bad(`„${file.name}“ ist ${Math.round(file.size / 1048576)} MB groß; mehr als ${BACKUP_MAX_BYTES / 1048576} MB werden nicht importiert (zu groß für diesen Browser) – es wurde nichts geändert.`);
      continue;
    }
    try {
      loaded.push({ name: file.name, data: JSON.parse(await file.text()) });
    } catch {
      bad(`„${file.name}“: Keine gültige JSON-Datei.`);
    }
  }
  const { singles, sets, errors } = groupParts(loaded);
  for (const m of errors) bad(m);
  for (const f of singles) {
    let backup;
    try {
      backup = checkBackup(f.data);
    } catch (e) {
      bad(`„${f.name}“: ${e.message}.`);
      continue;
    }
    results.push(await restore(backup));
  }
  for (const set of sets) {
    let backup;
    try {
      backup = combineBackupParts(set.files.map(f => f.data));
    } catch (e) {
      bad(`${set.files.length} Teile (${set.files[0].name} …): ${e.message}.`);
      continue;
    }
    results.push(await restore(backup));
  }
  if (results.length === 1) showImportMsg(results[0].cls, ...results[0].content);
  else if (results.length) showImportMsg(results.some(r => r.cls === 'err') ? 'err' : results.some(r => r.cls === 'warn') ? 'warn' : 'ok', el('ul', {}, results.map(r => el('li', {}, ...r.content))));
  renderOps();
}

async function restore(backup) {
  let r;
  try {
    // the merge decision and its writes in one transaction, on what is stored now
    r = await applyBackup(state.store, backup);
  } catch (e) {
    showSaveError(e);
    return { cls: 'err', content: [el('strong', {}, 'Nicht importiert: '), 'Beim Speichern ist ein Fehler aufgetreten – es wurde nichts verändert.'] };
  }
  broadcast({ type: 'ops' });
  broadcast({ type: 'msgs', opId: backup.operation.id });
  const left = backup.dropped || [];
  return {
    cls: r.conflicts.length || r.unlinked.length || left.length ? 'warn' : 'ok',
    content: [`„${backup.operation.name}“: ${r.added} Meldungen neu, ${r.updated} aktualisiert. `,
      r.conflicts.length ? el('strong', {}, `Nicht übernommen (Nummer oder ID schon mit anderer Meldung belegt): ${r.conflicts.join(', ')}. `) : null,
      r.unlinked.length ? el('strong', {}, `Nicht übernommen (Bezug auf eine Meldung, die fehlt oder nicht übernommen wurde): ${r.unlinked.join(', ')}. `) : null,
      left.length ? el('strong', {}, `Aus der Datei ausgelassen (${left.length}): ${left.map(x => `${x.what} (${x.why})`).join('; ')}. `) : null],
  };
}

/* ---------------------------------------------------------------- tabs, data, footer */

function broadcast(msg) {
  try { state.channel?.postMessage(msg); } catch { /* channel closed */ }
}

function initChannel() {
  if (typeof BroadcastChannel !== 'function') return;
  state.channel = new BroadcastChannel('oe1ebg-notfunk');
  state.channel.onmessage = ev => {
    const d = ev.data || {};
    if (d.type === 'ops' && !$('#view-ops').hidden) renderOps();
    if (d.type === 'msgs' && d.opId === state.op?.id) reloadMsgs();
  };
}

async function initPersistence() {
  const r = await requestPersistence();
  if (r === 'persisted') setChip('#st-storage', 'Speicher dauerhaft ✓', 'ok');
  else if (r === 'denied') setChip('#st-storage', 'Speicher nicht dauerhaft – regelmäßig sichern!', 'warn');
  else setChip('#st-storage', 'Speicher: Browser-Standard', 'warn');
}

async function loadCallbook() {
  state.callbook = buildCallbook(await loadDataFile('callsigns-oe.json'));
  fill($('#st-callbook'), state.callbook
    ? sourceItem('callsigns', `Stand ${standDate(state.callbook.stand)}, ${state.callbook.calls.length} OE-Rufzeichen`)
    : 'Rufzeichenliste nicht verfügbar');
  // info lines that need the list
  if (state.op) { renderOpPanel(); renderFormState(); }
  if (!$('#new-op').hidden) renderPartyInfo('#n-operator', '#n-operator-info');
}

async function loadRepeaterFooter() {
  const idx = await loadRepeaterIndex();
  fill($('#st-repeaters'), idx
    ? sourceItem('repeaters', `Stand ${standDate(idx.retrieved)}, ${idx.list.length} Sprach-Relais`)
    : 'Relaisliste nicht verfügbar');
}

function wire() {
  // the "Entwurf" note: hidden for this page view, back on the next load
  $('#btn-draft-banner').addEventListener('click', () => { $('#draft-banner').hidden = true; });
  $('#btn-new-op').addEventListener('click', () => ($('#new-op').hidden ? openNewOpForm() : ($('#new-op').hidden = true)));
  // one way to write a frequency: 145,500
  for (const sel of ['#n-freq', '#e-freq']) $(sel).addEventListener('change', () => { $(sel).value = fmtFreq($(sel).value); });
  trackExpanded($('#btn-new-op'), $('#new-op'));
  $('#btn-cancel-op').addEventListener('click', () => { $('#new-op').hidden = true; });
  state.newOpRpt = attachOpLookups('n', () => {});
  $('#new-op').addEventListener('submit', ev => { ev.preventDefault(); createOp(); });
  $('#new-op').addEventListener('keydown', ev => {
    if (ev.key === 'Enter' && ev.shiftKey && !isComposing(ev)) { ev.preventDefault(); submitForm($('#new-op')); }
    else if (ev.key === 'Enter' && !isComposing(ev) && ev.target.tagName === 'INPUT') { ev.preventDefault(); if (!focusNext($('#new-op'), ev.target)) submitForm($('#new-op')); }
    else if (ev.key === 'Escape') { $('#new-op').hidden = true; }
  });
  for (const b of document.querySelectorAll('#view-ops [data-tab]')) {
    b.addEventListener('click', () => {
      state.tab = b.dataset.tab;
      for (const x of document.querySelectorAll('#view-ops [data-tab]')) x.setAttribute('aria-pressed', String(x === b));
      renderOps();
    });
  }
  $('#btn-import').addEventListener('click', () => $('#import-file').click());
  $('#import-file').addEventListener('change', ev => {
    const files = [...ev.target.files];
    ev.target.value = '';
    if (files.length) importFiles(files);
  });
  $('#btn-back').addEventListener('click', () => { location.hash = '#/'; });
  $('#btn-msg-back').addEventListener('click', () => { location.hash = `#/e/${state.op.id}`; });
  initOpPanel();
  for (const b of document.querySelectorAll('#view-book [data-filter]')) {
    b.addEventListener('click', () => {
      state.filter = b.dataset.filter;
      for (const x of document.querySelectorAll('#view-book [data-filter]')) x.setAttribute('aria-pressed', String(x === b));
      renderBook();
    });
  }
  let searchTimer = null;
  $('#book-search').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.query = $('#book-search').value; renderBook(); }, 150);
  });
  $('#btn-csv').addEventListener('click', () => {
    const csvStats = { guarded: 0 };
    download(toGeschaeftsbuchCSV(state.msgs, ';', csvStats), `${fileStem()}.csv`, 'text/csv');
    // Cells that started like a formula got a leading ' (../shared/js/csv.js).
    bookStatus('Geschäftsbuch (CSV) heruntergeladen', csvStats.guarded
      ? ` · ${csvStats.guarded} ${csvStats.guarded === 1 ? 'Wert' : 'Werte'} mit vorangestelltem ' (Anfang =, +, -, @ oder Steuerzeichen: Schutz vor Formeln im Tabellenprogramm; die JSON-Sicherung bleibt unverändert)`
      : '');
  });
  $('#btn-backup').addEventListener('click', exportBackup);
  $('#st-backup').addEventListener('click', exportBackup);
  trackExpanded($('#btn-print-book'), $('#print-range'));
  $('#btn-print-book').addEventListener('click', () => { $('#print-range').hidden = !$('#print-range').hidden; if (!$('#print-range').hidden) $('#pr-from-date').focus(); });
  $('#btn-print-cancel').addEventListener('click', () => { $('#print-range').hidden = true; });
  $('#print-range').addEventListener('submit', ev => { ev.preventDefault(); printBook(); });
  $('#btn-blank-form').addEventListener('click', printBlankForm);
  $('#btn-blank-form-book').addEventListener('click', printBlankForm);
  globalThis.addEventListener('hashchange', route);
  globalThis.addEventListener('pagehide', flushDraft);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushDraft(); });
}

async function main() {
  globalThis.NOTFUNK_STARTED = true;
  state.store = await openStorageWithNotices(openNotfunkStorage, $('#banner'));
  if (!state.store) {
    showFatal('Dieser Browser erlaubt keine lokale Speicherung (privater Modus?). Ohne Speicher kann nichts sicher aufgezeichnet werden.');
    return;
  }
  $('#st-backend').textContent = state.store.kind === 'indexeddb' ? 'IndexedDB' : 'localStorage (Ersatzspeicher)';
  if (state.store.kind !== 'indexeddb') {
    showFatal('Achtung: IndexedDB ist nicht verfügbar, die Daten liegen im kleineren Ersatzspeicher (localStorage). Häufig sichern.');
    $('#banner').className = 'banner warn no-print';
  } else {
    offerFallbackMigration(state.store, $('#banner'));
  }
  wire();
  trackSiteHeaderHeight();
  tableRoles($('table.book')); // cards on phones (style.css)
  $('#btn-map').addEventListener('click', toggleMap);
  initForm();
  trackOnline();
  tick();
  setInterval(tick, 1000);
  initChannel();
  initPersistence();
  initOffline({
    build: globalThis.NOTFUNK_BUILD,
    // the update flow asks for the draft; only then is a notice shown again
    beforeReload: () => {
      state.forUpdate = true;
      return flushDraft().finally(() => { state.forUpdate = false; });
    },
    fileHidden: ['#offline-file-link', '#offline-card', '#data-sources-link', '#home-link', '#manual-link', '#help-manual'],
  });
  fill($('#st-source'), ' · ', repoLink('Quellcode', 'tools/notfunk'));
  loadCallbook();
  loadRepeaterFooter();
  // "📍 Standort": the offline location search (as in Confirm); it also
  // builds the big location index in the background, after the page is up
  initLocationPanel();
  trackExpanded($('#btn-loc'), $('#loc-panel'));
  await route();
  // Everything is wired: the tests (and nothing else) wait for this.
  globalThis.NOTFUNK_READY = true;
}

main();
