// Notfunk-Meldebuch: the page. Operations (Einsätze), the message book with
// its entry form, one message in detail, exports and printouts. Design,
// sources and open questions: ../README.md; rules: ../AGENTS.md.
//
// Persistence rules: a message number is taken only by saveNumbered()
// (numbering.js), in the same storage transaction as the message, so a
// failed save consumes no number and two tabs never get the same one.
// Every write goes to storage before the UI reports it; edits keep the
// previous version as a revision; deletes are soft and keep the number;
// the half-typed message is kept as a draft. Nothing here talks to the
// network.

import { openNotfunkStorage } from './db.js';
import { requestPersistence } from '../../shared/js/storage.js';
import { $, el, fill, focusNext, submitForm, isComposing, trackExpanded } from '../../shared/js/dom.js';
import { prefGet, prefSet } from '../../shared/js/prefs.js';
import { loadDataFile } from '../../shared/js/data.js';
import { buildCallbook, lookupCall, normalizeCall } from '../../shared/js/callbook.js';
import { formatMHz } from '../../shared/js/repeaters.js';
import { newId, nowIso } from '../../shared/js/time.js';
import { attachCallSearch } from '../../shared/js/callsearch.js';
import { attachRepeaterSearch, loadRepeaterIndex } from '../../shared/js/repeaterui.js';
import { createLocationField, describeLocation } from '../../shared/js/locfield.js';
import { loadLocationIndex, fillLocationSources } from '../../shared/js/locationui.js';
import { sourceItem, standDate, trackOnline, mapLinks, repoLink } from '../../shared/js/sources.js';
import { initOffline, setChip } from '../../shared/js/offline.js';
import {
  DIRECTIONS, CHANNELS, MESSAGE_TYPES, PRIORITIES, REF_KINDS, STATUS_FLOW, statusLabel, statusEntry, timeLabel, readBackLabel,
  newMessage, editMessage, softDelete, restoreDeleted, setStatus, addAttempt, currentStatus, filterMessages,
  repliesTo, fmtVienna, viennaTime, zoneHint, normFreq, fmtFreq,
} from './model.js';
import { saveNumbered, normalizePrefix, PREFIX_RE, nextSeq, formatNumber, counterKey } from './numbering.js';
import { toGeschaeftsbuchCSV, toBackup, parseBackup, mergeBackup } from './export.js';
import {
  emptyForm, setDirection, formToFields, formIsBlank, messageToForm, replyForm, nextStep, statusSteps, bookSummary, partyText,
  readDateTime, readClock, readBound, normDate, normTime, dateText, clockText, needsZone, upgradeForm, normalizeRef,
} from './form.js';
import { formSheet, blankFormSheet, bookSheet } from './print.js';
import { renderFormSheet, fittedFormSheet, renderBookSheet, printSheet } from './printview.js';

const LAST_OP_KEY = 'oe1ebg-notfunk-last-op';
const PRINT_HINT_KEY = 'oe1ebg-notfunk-print-hint-off';

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
    'SPEICHERN FEHLGESCHLAGEN – die Eingabe ist noch im Formular. Bitte sofort eine Sicherung (JSON) exportieren. ',
    el('small', {}, `(${err && (err.name || err.message) || err})`),
    el('button', { type: 'button', onclick: () => { b.hidden = true; } }, 'ausblenden'));
  b.hidden = false;
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
      el('div', { class: 'meta' }, `${fmtVienna(op.created).split(' ')[0]} · Station ${op.prefix}${op.station ? ` ${op.station}` : ''} · ${counts.get(op.id) || 0} Meldungen`),
      el('div', { class: 'meta' }, [op.operator && `Op ${op.operator}`, op.home && `Eigene Stelle ${op.home}`, op.freq && `${fmtFreq(op.freq)} MHz`, op.via && `via ${op.via}`].filter(Boolean).join(' · '))),
    el('div', { class: 'actions' }, actions));
  }));
}

async function updateOp(op, patch) {
  const next = { ...op, ...patch, updated: nowIso() };
  try {
    await state.store.tx([{ store: 'operations', put: next }]);
    broadcast({ type: 'ops' });
  } catch (e) {
    showSaveError(e);
  }
  if (state.op?.id === op.id) state.op = next;
  renderOps();
}

function openNewOpForm() {
  const form = $('#new-op');
  form.hidden = false;
  const last = JSON.parse(prefGet(LAST_OP_KEY) || '{}');
  $('#n-prefix').value = last.prefix || '';
  $('#n-station').value = last.station || '';
  $('#n-operator').value = last.operator || '';
  $('#n-home').value = last.home || 'Stab';
  $('#n-freq').value = fmtFreq(last.freq || '');
  $('#n-via').value = last.via || '';
  renderPartyInfo('#n-operator', '#n-operator-info');
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
    id: newId(), name: v('#n-name'), prefix, station: v('#n-station'), operator: normalizeCall(v('#n-operator')),
    home: v('#n-home'), freq: normFreq(v('#n-freq')), via: normalizeCall(v('#n-via')), created: now, updated: now, archived: false, deleted: null,
  };
  try {
    await state.store.tx([{ store: 'operations', put: op }]);
  } catch (e) {
    showSaveError(e);
    return;
  }
  prefSet(LAST_OP_KEY, JSON.stringify({ prefix, station: op.station, operator: op.operator, home: op.home, freq: op.freq, via: op.via }));
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
const OP_FIELDS = { name: '#e-name', prefix: '#e-prefix', station: '#e-station', operator: '#e-operator', home: '#e-home', freq: '#e-freq', via: '#e-via' };
const OP_PANEL_KEY = 'oe1ebg-notfunk-op-open';

function renderOpPanel() {
  const op = state.op;
  for (const [k, sel] of Object.entries(OP_FIELDS)) if (document.activeElement !== $(sel)) $(sel).value = k === 'freq' ? fmtFreq(op[k] || '') : op[k] || '';
  $('#e-prefix').readOnly = state.msgs.length > 0;
  renderPartyInfo('#e-operator', '#e-operator-info');
  state.opRpt?.refresh();
  $('#book-title').textContent = op.name;
  setText($('#op-sum'), [
    `${op.prefix}${op.station ? ` ${op.station}` : ''}`,
    op.operator ? `Op ${op.operator}` : 'Operator fehlt',
    op.home && `Eigene Stelle ${op.home}`,
    op.freq && `${fmtFreq(op.freq)} MHz`,
    op.via && `via ${op.via}`,
  ].filter(Boolean).join(' · '));
  renderBackupChip();
  $('#op-sum').classList.toggle('warn-text', !op.operator);
}

async function saveOpPanel() {
  const op = state.op;
  const v = sel => $(sel).value.trim();
  const status = $('#op-status');
  const patch = {
    name: v('#e-name') || op.name, station: v('#e-station'), operator: normalizeCall(v('#e-operator')),
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
  // An untouched form follows the new defaults (frequency, relay, own post).
  const f = readForm();
  const follow = {};
  if (normFreq(f.freq) === normFreq(op.freq || '')) follow.freq = patch.freq;
  if (f.via === (op.via || '')) follow.via = patch.via;
  if (f.to === (op.home || '') && f.direction === 'in') follow.to = patch.home;
  if (f.from === (op.home || '') && f.direction === 'out') follow.from = patch.home;
  await updateOp(op, patch);
  if (patch.prefix) state.counter = await state.store.get('counters', counterKey(op.id, patch.prefix));
  if (Object.keys(follow).length && !state.editing) writeForm({ ...readForm(), ...follow });
  renderOpPanel();
  renderFormState();
  bookStatus(`Einsatz geändert: ${Object.keys(patch).filter(k => (op[k] || '') !== patch[k]).map(k => OP_LABELS[k]).join(', ')}`);
}

const OP_LABELS = { name: 'Name', prefix: 'Stationskürzel', station: 'Station', operator: 'Operator', home: 'Eigene Stelle', freq: 'Frequenz', via: 'Relais' };

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
  panel.addEventListener('toggle', () => prefSet(OP_PANEL_KEY, panel.open ? '1' : ''));
  const form = $('#op-form');
  form.addEventListener('change', saveOpPanel);
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
  renderBackupChip();
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
  state.editing = null;
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
    direction: radioValue('m-dir'), date: v('#m-date'), time: v('#m-time'), zone: $('#m-zone').hidden ? '' : v('#m-zone'), channel: radioValue('m-channel'),
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
  set('#m-date', f.date); set('#m-time', f.time); set('#m-freq', fmtFreq(f.freq)); set('#m-via', f.via); set('#m-type', f.type);
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
  return formToFields(f, { now: nowIso(), byNumber: new Map(state.msgs.filter(m => !m.deleted).map(m => [m.number, m])), editing: !!state.editing });
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
  // The time is prefilled when a new message is begun (the first keystroke
  // in any other field), with the date, and can be corrected.
  const d = $('#m-date'), t = $('#m-time');
  if (!state.editing && !d.value && !t.value && ev?.target && ev.target !== t && ev.target !== d && !formIsBlank(readForm(), state.op)) {
    const now = nowIso();
    d.value = dateText(now);
    t.value = clockText(now);
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

async function flushDraft() {
  clearTimeout(state.draftTimer);
  if (!state.op || $('#view-book').hidden && $('#view-msg').hidden) return;
  const f = readForm();
  const empty = formIsEmpty(f) && !state.editing;
  try {
    if (empty) await state.store.tx([{ store: 'drafts', del: state.op.id }]);
    else await state.store.tx([{ store: 'drafts', put: { eventId: state.op.id, form: f, editingId: state.editing?.id || null, saved: nowIso() } }]);
    setText($('#draft-status'), empty ? '' : `✓ Entwurf gesichert ${viennaTime(nowIso())}`);
  } catch (e) {
    console.warn('Entwurf nicht gespeichert', e);
    setText($('#draft-status'), 'Entwurf nicht gesichert!');
  }
}

async function restoreDraft() {
  const d = await state.store.get('drafts', state.op.id);
  state.editing = d?.editingId ? state.msgs.find(m => m.id === d.editingId) || null : null;
  writeForm(d?.form || emptyForm(state.op));
  setText($('#draft-status'), d ? `✓ Entwurf gesichert ${viennaTime(d.saved)}` : '');
}

function resetForm(keep = true) {
  const prev = readForm();
  const next = emptyForm(state.op);
  // Direction, channel and frequency usually stay the same for the next message.
  if (keep) Object.assign(next, setDirection(next, prev.direction, state.op), { channel: prev.channel, freq: prev.freq, via: prev.via });
  state.editing = null;
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
  const { fields, errors, fieldErrors, warnings } = check(form);
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
    status.textContent = '';
    return;
  }
  const operator = state.op.operator || '';
  const op = state.op;
  let saved;
  try {
    if (state.editing) {
      // The staff reference is kept with the message, not in the form.
      const { staffRef: _ref, ...changes } = fields;
      const { next, revision } = editMessage(state.editing, changes, { revisionId: newId(), operator, now });
      await state.store.tx([{ store: 'messages', put: next }, { store: 'revisions', put: revision }]);
      saved = next;
    } else {
      saved = await saveNumbered(state.store, { opId: op.id, prefix: op.prefix, recordStore: 'messages' },
        numbered => newMessage(fields, numbered, { id: newId(), opId: op.id, operator, now }));
      // A reply marks the message it answers as answered.
      const orig = saved.refKind === 'antwort' && saved.replyTo && state.msgs.find(m => m.id === saved.replyTo);
      if (orig && STATUS_FLOW.indexOf(currentStatus(orig)) < STATUS_FLOW.indexOf('answered')) {
        await state.store.tx([{ store: 'messages', put: setStatus(orig, 'answered', { operator, now, note: saved.number }) }]);
      }
    }
    await rememberStations(fields);
  } catch (e) {
    showSaveError(e);
    return;
  }
  const wasEdit = !!state.editing;
  status.className = 'form-status';
  status.textContent = '';
  await loadOp();
  resetForm();
  await flushDraft();
  renderBook();
  bookStatus(`${saved.number} ${wasEdit ? 'geändert (vorige Fassung gespeichert)' : 'gespeichert'}: ${saved.subject || saved.text.slice(0, 60)}`);
  renderBackupChip();
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
  $('#discard-bar').hidden = true;
  if (formIsEmpty(before) && !editing) return;
  resetForm();
  flushDraft();
  const status = $('#form-status');
  status.className = 'form-status';
  fill(status, editing ? 'Bearbeitung abgebrochen. ' : 'Eingabe verworfen. ',
    el('button', {
      type: 'button', class: 'link',
      onclick: () => { state.editing = editing; writeForm(before); fill(status); onFormChange(); $('#m-from').focus(); },
    }, 'Rückgängig'));
  $('#m-from').focus();
}

function startEdit(msg) {
  state.editing = msg;
  writeForm(messageToForm(msg));
  location.hash = `#/e/${state.op.id}`;
  setTimeout(() => $('#m-subject').focus(), 0);
}

function startReply(msg) {
  state.editing = null;
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
  $('#btn-form-op').addEventListener('click', () => { $('#op-panel').open = true; $('#e-operator').focus(); });

  // Typed dates and times are shown in the one format on leaving the field
  // ("1405" -> "14:05", "20261008" -> "2026-10-08"); unreadable ones stay
  // as typed for the error at the field.
  document.addEventListener('focusout', ev => {
    const t = ev.target;
    if (!(t instanceof HTMLInputElement) || !t.matches('input.dt-date, input.dt-time')) return;
    const norm = t.matches('.dt-date') ? normDate(t.value) : normTime(t.value);
    if (norm && norm !== t.value) { t.value = norm; t.dispatchEvent(new Event('input', { bubbles: true })); }
  });

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
  initHelp();
}

/* ---------------------------------------------------------------- help */

// The help dialog: "? Hilfe", F1, or ? outside text fields. Closing it
// (Esc, "Schließen") puts the focus back where it was; the form is
// untouched.
function initHelp() {
  const dlg = $('#help-dlg');
  let back = null;
  const open = () => {
    if (dlg.open) return;
    back = document.activeElement;
    dlg.showModal();
    $('#help-close').focus();
  };
  dlg.addEventListener('close', () => { if (back?.isConnected) back.focus(); back = null; });
  $('#help-close').addEventListener('click', () => dlg.close());
  $('#btn-help').addEventListener('click', open);
  // the section links scroll inside the dialog, without changing the route
  for (const a of dlg.querySelectorAll('.help-nav a')) {
    a.addEventListener('click', ev => {
      ev.preventDefault();
      dlg.querySelector(a.getAttribute('href'))?.scrollIntoView({ block: 'start' });
    });
  }
  document.addEventListener('keydown', ev => {
    if (ev.ctrlKey || ev.metaKey || ev.altKey || isComposing(ev) || $('#view-book').hidden) return;
    const typing = ev.target.closest?.('input, textarea, select, [contenteditable]');
    if (ev.key === 'F1' || (ev.key === '?' && !typing)) {
      ev.preventDefault();
      open();
    }
  });
}

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
async function storeMsg(next, text) {
  try {
    await state.store.tx([{ store: 'messages', put: next }]);
  } catch (e) {
    showSaveError(e);
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
  let next;
  try {
    next = setStatus(msg, state_, { operator: state.op.operator || '', now: nowIso(), ...details });
  } catch (e) {
    return e.message;
  }
  await storeMsg(next, `${msg.number}: ${statusLabel(state_, msg.direction)}`);
  return '';
}

function renderSummary() {
  const s = bookSummary(state.msgs);
  fill($('#book-summary'),
    s.emergencyOpen ? el('span', { class: 'sum sum-err' }, el('b', {}, String(s.emergencyOpen)), ' Notfall offen') : null,
    s.unacknowledged ? el('span', { class: 'sum sum-warn' }, el('b', {}, String(s.unacknowledged)), ' noch nicht bestätigt') : null,
    el('span', { class: 'sum' }, el('b', {}, String(s.total)), ` Meldungen${s.range.length ? ` · ${s.range.join(', ')}` : ''}${s.gaps.length ? '' : s.total ? ', lückenlos' : ''}`),
    s.gaps.length ? el('span', { class: 'sum sum-err' }, `Lücke: ${s.gaps.join(', ')}`) : null);
}

function renderBook() {
  if (!state.op) return;
  renderFormState();
  renderSummary();
  const f = FILTERS[state.filter];
  let list = filterMessages(state.msgs, { ...f, urgent: undefined, query: state.query });
  if (f.urgent) list = list.filter(m => m.priority !== 'routine');
  list.reverse(); // newest first
  const body = $('#book-body');
  if (!list.length) {
    fill(body, el('tr', {}, el('td', { colspan: '8', class: 'empty' }, state.msgs.some(m => !m.deleted) ? 'Keine Meldung passt zum Filter.' : 'Noch keine Meldungen. Die erste oben eintragen.')));
  } else {
    fill(body, list.map(m => {
      const step = nextStep(m);
      const last = m.status[m.status.length - 1];
      return el('tr', { 'data-id': m.id, class: m.priority === 'emergency' ? 'urgent' : null },
        el('td', { class: 'num' }, el('a', { href: `#/e/${state.op.id}/m/${m.id}` }, m.number),
          m.staffRef ? el('div', { class: 'sub', title: 'Referenz der Meldesammelstelle' }, `Ref. ${m.staffRef}`) : null),
        el('td', { class: 'mono' }, viennaTime(m.ts)),
        el('td', { class: 'nowrap' }, m.direction === 'in' ? '↓ Ein' : '↑ Aus'),
        el('td', { class: 'parties' }, partyText(m.from), el('span', { class: 'dim' }, ' → '), partyText(m.to),
          el('div', { class: 'sub' }, [CHANNELS[m.channel], m.peer, fmtFreq(m.radio.freq), m.radio.via && `via ${m.radio.via}`, m.stichzeit && `Stichzeit ${viennaTime(m.stichzeit)}`].filter(Boolean).join(' · '))),
        el('td', { class: 'content' }, el('b', {}, m.subject || ''), el('div', { class: 'sub clamp' }, m.text)),
        el('td', { class: 'nowrap' }, MESSAGE_TYPES[m.type], el('div', {}, prioPill(m))),
        el('td', { class: 'nowrap' }, statusPill(m), el('div', { class: 'sub mono' }, `${viennaTime(last.at)} ${last.by}`)),
        el('td', { class: 'act' },
          step ? el('button', { type: 'button', class: 'mini', onclick: () => advance(m, step.state), 'aria-label': `${m.number} ${step.label}` }, step.label) : null,
          el('button', { type: 'button', class: 'mini', onclick: () => printForm(m), 'aria-label': `Ausdruck ${m.number} (Meldeaufnahmeformular)` }, 'Ausdruck')));
    }));
  }
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
  try {
    await state.store.tx([{ store: 'messages', put: softDelete(m, { operator, now: nowIso() }) }]);
  } catch (e) {
    showSaveError(e);
    return;
  }
  await reloadMsgs();
  bookStatus(`${m.number} gelöscht (Nummer bleibt vergeben)`);
  broadcast({ type: 'msgs', opId: state.op.id });
}

async function restoreMsg(m) {
  try {
    await state.store.tx([{ store: 'messages', put: restoreDeleted(m, { now: nowIso() }) }]);
  } catch (e) {
    showSaveError(e);
    return;
  }
  await reloadMsgs();
  bookStatus(`${m.number} wiederhergestellt`);
  broadcast({ type: 'msgs', opId: state.op.id });
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
    return el('label', { class: 'field', for: id }, el('span', {}, f.label, f.time ? el('span', { class: 'dim' }, ' (leer = jetzt)') : null), inputs[f.key]);
  });
  const form = el('form', { class: 'inline-form', autocomplete: 'off', novalidate: '' },
    el('div', { class: 'inline-fields' }, ...rows.filter(r => r.classList.contains('field'))),
    ...rows.filter(r => !r.classList.contains('field')),
    el('div', { class: 'inline-foot' }, el('button', { type: 'submit' }, button), err));
  form.addEventListener('submit', async ev => {
    ev.preventDefault();
    const values = Object.fromEntries(Object.entries(inputs).map(([k, i]) => [k, i.type === 'checkbox' ? i.checked : i.value.trim()]));
    err.textContent = await onSubmit(values) || '';
  });
  return form;
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
    const fields = state_ === 'forwarded'
      ? [{ key: 'to', label: out ? 'Übertragen an' : 'Übergeben an', value: out ? m.peer : '', placeholder: out ? 'Funkstation' : 'Meldesammelstelle' },
        { key: 'at', label: out ? 'Übertragungszeitpunkt' : 'Übergabezeitpunkt', time: true },
        ...(out ? [{ key: 'readBack', label: readBackLabel('out'), check: true }] : [])]
      : [{ key: 'who', label: out ? 'Empfang bestätigt durch' : 'Übernommen durch', value: out ? m.peer : '', placeholder: out ? 'Funkstation' : 'Name / Funktion' },
        { key: 'at', label: 'Zeitpunkt', time: true }];
    const button = state_ === 'forwarded' ? (out ? 'Übertragung eintragen' : 'Übergabe eintragen') : (out ? 'Empfang eintragen' : 'Übernahme eintragen');
    return inlineForm(fields, button, async v => {
      const t = stepTime(v.at);
      if (t.error) return t.error;
      return advance(m, state_, { at: t.at, to: v.to || '', who: v.who || '', readBack: !!v.readBack });
    });
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
          await storeMsg(addAttempt(m, { operator: state.op.operator || '', now: nowIso(), at: t.at, note: v.note }), `${m.number}: Fehlversuch / Rückfrage vermerkt`);
          return '';
        })) : null,
    el('p', { class: 'hint' }, out
      ? '„Übertragen“ heißt: gesendet. Erst „Empfang bestätigt“ heißt, die Funkstelle hat sie.'
      : '„Übergeben“ heißt: die Meldung liegt bei der Meldesammelstelle. Es heißt nicht, dass ein Auftrag im Inhalt erledigt ist.'));
}

// The Meldesammelstelle's own number, to match the two lists. Changing it
// keeps the previous version, like any edit.
function staffRefCard(m) {
  return el('section', { class: 'staff-card', 'aria-label': 'Referenz der Meldesammelstelle' },
    el('h3', { class: 'cap' }, 'Referenz der Meldesammelstelle'),
    m.deleted ? el('p', {}, m.staffRef || '–') : inlineForm([{ key: 'ref', label: 'Referenz / Geschäftsbuch-Nr.', value: m.staffRef || '', mono: true }],
      m.staffRef ? 'Referenz ändern' : 'Referenz eintragen', async v => {
        if (v.ref === (m.staffRef || '')) return '';
        const { next, revision } = editMessage(m, { staffRef: v.ref }, { revisionId: newId(), operator: state.op.operator || '', now: nowIso() });
        try {
          await state.store.tx([{ store: 'messages', put: next }, { store: 'revisions', put: revision }]);
        } catch (e) {
          showSaveError(e);
          return 'nicht gespeichert';
        }
        await reloadMsgs();
        bookStatus(`${m.number}: Referenz der Meldesammelstelle ${v.ref || 'entfernt'}`);
        broadcast({ type: 'msgs', opId: state.op.id });
        return '';
      }),
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
  const kv = (k, ...v) => [el('dt', {}, k), el('dd', {}, ...v)];
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
        el('span', { class: 'dim' }, `${m.direction === 'in' ? '↓' : '↑'} ${DIRECTIONS[m.direction]} · ${MESSAGE_TYPES[m.type]}`),
        m.staffRef ? el('span', { class: 'chip' }, `Ref. ${m.staffRef}`) : null),
      el('h3', { class: 'detail-subject' }, m.subject || '(ohne Betreff)'),
      el('section', { class: 'verbatim', 'aria-label': 'Inhalt, wörtlich' },
        el('div', { class: 'cap' }, 'Inhalt – wörtlich'),
        el('p', {}, m.text || '–'),
        el('div', { class: m.readBack ? 'sub ok' : 'sub' }, m.readBack ? `✓ ${readBackLabel(m.direction)}` : 'Rücklesen nicht vermerkt')),
      el('dl', { class: 'kv' },
        ...kv(timeLabel(m.direction), el('span', { class: 'mono' }, fmtVienna(m.ts))),
        ...kv('Erfasst am', el('span', { class: 'mono' }, `${fmtVienna(m.created)} · ${m.operator || '–'}`)),
        ...kv('Von (Absender)', partyText(m.from)),
        ...kv('An (Adressat)', partyText(m.to)),
        ...(m.peer ? kv('Funkstelle', el('span', { class: 'mono' }, m.peer), el('span', { class: 'dim' }, m.direction === 'out' ? ' (empfangende Funkstation)' : ' (übermittelnde Funkstation)')) : []),
        ...(m.distribution.length ? kv('Verteiler', m.distribution.join(', ')) : []),
        ...kv('Übermittlung', [CHANNELS[m.channel], m.radio.freq && `${fmtFreq(m.radio.freq)} MHz`, m.radio.via && `via ${m.radio.via}`].filter(Boolean).join(' · ')),
        ...(m.location ? kv('Ort / Einsatzstelle', describeLocation(m.location), ' ', mapLinks(m.location)) : []),
        ...(m.stichzeit ? kv('Stichzeit', fmtVienna(m.stichzeit)) : []),
        ...(m.origin.station || m.origin.place || m.origin.filed ? kv('Ursprung', [m.origin.station, m.origin.placeLoc ? describeLocation(m.origin.placeLoc) : m.origin.place, m.origin.filed && `aufgegeben ${fmtVienna(m.origin.filed)}`].filter(Boolean).join(' · ')) : []),
        ...(ref ? kv('Bezug', `${refKind} `, link(ref), ` ${ref.subject}`) : m.refNumber ? kv('Bezug', `${refKind} ${m.refNumber}`) : []),
        ...(m.remarks ? kv('Anmerkungen', m.remarks) : [])),
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

// One message on one A4 page. Before printing, a dialog says how to set up
// the print dialog (header and footer lines off, A4, 100 %; can be turned
// off) and, when the text is too long for one page, how many pages it takes.
function printForm(m) {
  const revisions = state.revisions.filter(r => r.messageId === m.id).length;
  const { node, fit } = fittedFormSheet(formSheet(m, state.op, { now: nowIso(), revisions, byId: new Map(state.msgs.map(x => [x.id, x])) }));
  const long = fit.pages > 1;
  const hint = prefGet(PRINT_HINT_KEY) !== '1';
  const kind = long ? 'book' : 'form';
  if (!long && !hint) { printSheet(node, kind); return; }
  const dlg = $('#print-dlg');
  $('#print-dlg-long').hidden = !long;
  setText($('#print-dlg-long'), long
    ? `${m.number} ist zu lang für eine Seite: der Ausdruck hat ${fit.pages} Seiten, jede mit der Nummer oben. Nichts wird abgeschnitten.`
    : '');
  $('#print-dlg-hint').hidden = !hint;
  $('#print-dlg-off').checked = false;
  dlg.returnValue = '';
  dlg.showModal();
  dlg.addEventListener('close', () => {
    if ($('#print-dlg-off').checked) prefSet(PRINT_HINT_KEY, '1');
    if (dlg.returnValue === 'print') printSheet(node, kind);
  }, { once: true });
}

// An empty form (for a stack of paper forms): with the operation's name
// when one is open. The number of copies is chosen in the print dialog.
function printBlankForm() {
  printSheet(renderFormSheet(blankFormSheet(state.op, { now: nowIso() })), 'form');
}

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
  printSheet(renderBookSheet(bookSheet(state.msgs, state.op, { now, fromIso, toIso })), 'book');
}

async function exportBackup() {
  const [counters] = await Promise.all([state.store.getByEvent('counters', state.op.id)]);
  const now = nowIso();
  download(toBackup({ operation: state.op, messages: state.msgs, revisions: state.revisions, counters }, now), `${fileStem()}-sicherung.json`, 'application/json');
  bookStatus('Sicherung (JSON) heruntergeladen');
  await updateOp(state.op, { backupAt: now });
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
  chip.className = `chip chip-btn ${since ? 'warn' : 'ok'}`;
  setText(chip, at
    ? `Letzte Sicherung ${viennaTime(at)}${since ? ` · ${since} ${since === 1 ? 'Meldung' : 'Meldungen'} ungesichert` : ' ✓'}`
    : `Noch keine Sicherung · ${since} ${since === 1 ? 'Meldung' : 'Meldungen'}`);
}

function showImportMsg(cls, ...content) {
  const box = $('#import-msg');
  box.className = `banner ${cls}`;
  fill(box, ...content, el('button', { type: 'button', onclick: () => { box.hidden = true; } }, 'ausblenden'));
  box.hidden = false;
}

async function importBackup(file) {
  let backup;
  try {
    backup = parseBackup(await file.text());
  } catch (e) {
    showImportMsg('err', el('strong', {}, 'Nicht importiert: '), `„${file.name}“: ${e.message}.`);
    return;
  }
  const opId = backup.operation.id;
  const existing = {
    operation: await state.store.get('operations', opId),
    messages: await state.store.getByEvent('messages', opId),
    revisions: await state.store.getByEvent('revisions', opId),
    counters: await state.store.getByEvent('counters', opId),
  };
  const r = mergeBackup(backup, existing);
  try {
    await state.store.tx(r.ops);
  } catch (e) {
    showSaveError(e);
    return;
  }
  broadcast({ type: 'ops' });
  showImportMsg(r.conflicts.length ? 'warn' : 'ok',
    `„${backup.operation.name}“: ${r.added} Meldungen neu, ${r.updated} aktualisiert. `,
    r.conflicts.length ? el('strong', {}, `Nicht übernommen (Nummer schon mit anderer Meldung belegt): ${r.conflicts.join(', ')}. `) : null);
  renderOps();
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
    const f = ev.target.files[0];
    ev.target.value = '';
    if (f) importBackup(f);
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
    download(toGeschaeftsbuchCSV(state.msgs), `${fileStem()}.csv`, 'text/csv');
    bookStatus('Geschäftsbuch (CSV) heruntergeladen');
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
  state.store = await openNotfunkStorage();
  if (!state.store) {
    showFatal('Dieser Browser erlaubt keine lokale Speicherung (privater Modus?). Ohne Speicher kann nichts sicher aufgezeichnet werden.');
    return;
  }
  $('#st-backend').textContent = state.store.kind === 'indexeddb' ? 'IndexedDB' : 'localStorage (Ersatzspeicher)';
  if (state.store.kind !== 'indexeddb') {
    showFatal('Achtung: IndexedDB ist nicht verfügbar, die Daten liegen im kleineren Ersatzspeicher (localStorage). Häufig sichern.');
    $('#banner').className = 'banner warn no-print';
  }
  wire();
  initForm();
  trackOnline();
  tick();
  setInterval(tick, 1000);
  initChannel();
  initPersistence();
  initOffline({
    build: globalThis.NOTFUNK_BUILD,
    beforeReload: flushDraft,
    fileHidden: ['#offline-file-link', '#offline-card', '#data-sources-link', '#home-link', '#manual-link', '#help-manual'],
  });
  fill($('#st-source'), ' · ', repoLink('Quellcode', 'tools/notfunk'));
  loadCallbook();
  loadRepeaterFooter();
  // The location index is big: build it in the background, after the page is up.
  setTimeout(() => { loadLocationIndex(); fillLocationSources(); }, 800);
  await route();
  // Everything is wired: the tests (and nothing else) wait for this.
  globalThis.NOTFUNK_READY = true;
}

main();
