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
import { newId, nowIso, zoneLabel } from '../../shared/js/time.js';
import { attachCallSearch } from '../../shared/js/callsearch.js';
import { attachRepeaterSearch, loadRepeaterIndex } from '../../shared/js/repeaterui.js';
import { createLocationField, describeLocation } from '../../shared/js/locfield.js';
import { loadLocationIndex, fillLocationSources } from '../../shared/js/locationui.js';
import { sourceItem, standDate, trackOnline, mapLinks } from '../../shared/js/sources.js';
import { initOffline, setChip } from '../../shared/js/offline.js';
import {
  DIRECTIONS, CHANNELS, MESSAGE_TYPES, PRIORITIES, STATUS_FLOW, STATUS_LABELS, newMessage, editMessage, softDelete,
  restoreDeleted, setStatus, currentStatus, filterMessages, repliesTo, fmtVienna, fmtUtc,
} from './model.js';
import { saveNumbered, normalizePrefix, PREFIX_RE, nextSeq, formatNumber, counterKey } from './numbering.js';
import { toGeschaeftsbuchCSV, toBackup, parseBackup, mergeBackup } from './export.js';
import {
  emptyForm, setDirection, formToFields, messageToForm, replyForm, nextStep, statusSteps, bookSummary, partyText, readTime,
} from './form.js';
import { formSheet, blankFormSheet, bookSheet } from './print.js';
import { renderFormSheet, renderBookSheet, printSheet } from './printview.js';

const LAST_OP_KEY = 'oe1ebg-notfunk-last-op';
const MODE = 'local'; // times are typed and shown in the device's local time (Vienna)

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
  rptSearch: null,
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

// "14:53" and "MESZ" (the zone as on the staff forms) plus UTC.
function viennaClock(iso) {
  const [, time = '', zone = ''] = fmtVienna(iso).split(' ');
  return { time, zone };
}

function tick() {
  const now = nowIso();
  const v = viennaClock(now);
  setText($('#clock-local'), v.time);
  setText($('#clock-zone'), v.zone);
  setText($('#clock-utc'), fmtUtc(now).split(' ').slice(1).join(' '));
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
      el('div', { class: 'meta' }, [op.operator && `Op ${op.operator}`, op.home && `Eigene Stelle ${op.home}`, op.freq && `${op.freq} MHz`, op.via && `via ${op.via}`].filter(Boolean).join(' · '))),
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
  $('#n-freq').value = last.freq || '';
  $('#n-via').value = last.via || '';
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
    home: v('#n-home'), freq: v('#n-freq'), via: normalizeCall(v('#n-via')), created: now, updated: now, archived: false, deleted: null,
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

/* ---------------------------------------------------------------- views */

function showView(id) {
  for (const v of ['#view-ops', '#view-book', '#view-msg']) $(v).hidden = v !== id;
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
  $('#book-meta').textContent = `Station ${state.op.prefix}${state.op.station ? ` ${state.op.station}` : ''}${state.op.home ? ` · Eigene Stelle ${state.op.home}` : ''}`;
  $('#book-operator').value = state.op.operator || '';
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
    direction: radioValue('m-dir'), time: v('#m-time'), channel: radioValue('m-channel'),
    freq: v('#m-freq'), via: v('#m-via'), type: v('#m-type'), priority: radioValue('m-prio'), alarm: $('#m-alarm').checked,
    from: v('#m-from'), to: v('#m-to'), subject: v('#m-subject'), text: v('#m-text'), readBack: $('#m-readback').checked,
    stichzeit: v('#m-stichzeit'), distribution: v('#m-distribution'), remarks: v('#m-remarks'),
    origStation: v('#m-orig-station'), origPlace: v('#m-orig-place'), origFiled: v('#m-orig-filed'),
    replyTo: $('#msg-form').dataset.replyTo || null,
    ts: $('#msg-form').dataset.ts || null,
    location: state.locField?.get() || null, locationText: v('#m-loc'),
  };
}

function writeForm(f) {
  setRadio('m-dir', f.direction);
  setRadio('m-channel', f.channel);
  setRadio('m-prio', f.priority);
  const set = (id, val) => { $(id).value = val ?? ''; };
  set('#m-time', f.time); set('#m-freq', f.freq); set('#m-via', f.via); set('#m-type', f.type);
  set('#m-from', f.from); set('#m-to', f.to); set('#m-subject', f.subject); set('#m-text', f.text);
  set('#m-stichzeit', f.stichzeit); set('#m-distribution', f.distribution); set('#m-remarks', f.remarks);
  set('#m-orig-station', f.origStation); set('#m-orig-place', f.origPlace); set('#m-orig-filed', f.origFiled);
  $('#m-alarm').checked = !!f.alarm;
  $('#m-readback').checked = !!f.readBack;
  if (f.replyTo) $('#msg-form').dataset.replyTo = f.replyTo;
  else delete $('#msg-form').dataset.replyTo;
  if (f.ts) $('#msg-form').dataset.ts = f.ts;
  else delete $('#msg-form').dataset.ts;
  if (state.locField) {
    // A stored resolution is restored as it was (edit, draft), not resolved again.
    $('#m-loc').value = f.locationText || '';
    if (f.location) state.locField.set(f.location);
    else { state.locField.clear(); if (f.locationText) state.locField.refresh(); }
  }
  $('#m-more').open = !!(f.location || f.locationText || f.distribution || f.remarks || f.origStation || f.origPlace || f.origFiled);
  state.rptSearch?.refresh();
  renderFormState();
}

// Number preview, edit/reply state, the fields that depend on others.
function renderFormState() {
  const f = readForm();
  const editing = state.editing;
  setText($('#form-title'), editing ? 'Meldung bearbeiten' : 'Neue Meldung');
  setText($('#form-number'), editing ? editing.number : `→ ${previewNumber()}`);
  $('#form-number-help').hidden = !!editing;
  const reply = f.replyTo && state.msgs.find(m => m.id === f.replyTo);
  const chip = $('#form-reply');
  chip.hidden = !reply;
  if (reply) {
    fill(chip, `Antwort auf ${reply.number} `,
      el('button', { type: 'button', class: 'link', 'aria-label': `Bezug auf ${reply.number} entfernen`, onclick: () => { delete $('#msg-form').dataset.replyTo; onFormChange(); } }, '✕'));
  }
  setText($('#btn-save'), editing ? `Änderung speichern ⇧⏎` : `Speichern als ${previewNumber()} ⇧⏎`);
  for (const n of document.querySelectorAll('#msg-form .lage-only')) n.hidden = f.type !== 'lagemeldung';
  for (const n of document.querySelectorAll('#msg-form .radio-only')) n.hidden = f.channel !== 'funk';
  $('#msg-form').classList.toggle('urgent', f.priority === 'emergency' || f.alarm);
  $('#msg-form').classList.toggle('editing', !!editing);
  $('#m-time-zone').textContent = `(${zoneLabel(nowIso(), MODE)})`;
  renderPartyInfo('#m-from', '#m-from-info');
  renderPartyInfo('#m-to', '#m-to-info');
}

// The info line under Von/An: the callbook entry of a callsign in it.
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

function onFormChange() {
  renderFormState();
  clearTimeout(state.draftTimer);
  state.draftTimer = setTimeout(flushDraft, 600);
}

function formIsEmpty(f) {
  const blank = emptyForm(state.op);
  return ['from', 'subject', 'text', 'time', 'remarks', 'distribution', 'locationText'].every(k => !String(f[k] ?? '').trim() || f[k] === blank[k]) && !f.replyTo;
}

async function flushDraft() {
  clearTimeout(state.draftTimer);
  if (!state.op || $('#view-book').hidden && $('#view-msg').hidden) return;
  const f = readForm();
  try {
    if (formIsEmpty(f) && !state.editing) await state.store.tx([{ store: 'drafts', del: state.op.id }]);
    else await state.store.tx([{ store: 'drafts', put: { eventId: state.op.id, form: f, editingId: state.editing?.id || null, saved: nowIso() } }]);
  } catch (e) {
    console.warn('Entwurf nicht gespeichert', e);
  }
}

async function restoreDraft() {
  const d = await state.store.get('drafts', state.op.id);
  state.editing = d?.editingId ? state.msgs.find(m => m.id === d.editingId) || null : null;
  writeForm(d?.form || emptyForm(state.op));
}

function resetForm(keep = true) {
  const prev = readForm();
  const next = emptyForm(state.op);
  // Direction, channel and frequency usually stay the same for the next message.
  if (keep) Object.assign(next, setDirection(next, prev.direction, state.op), { channel: prev.channel, freq: prev.freq, via: prev.via });
  state.editing = null;
  writeForm(next);
}

async function saveMessage() {
  const status = $('#form-status');
  const form = readForm();
  const now = nowIso();
  const { fields, errors } = formToFields(form, { mode: MODE, now });
  if (errors.length) {
    status.className = 'form-status err';
    status.textContent = `Nicht gespeichert: ${errors.join(' · ')}`;
    return;
  }
  const operator = normalizeCall($('#book-operator').value) || state.op.operator || '';
  const op = state.op;
  let saved;
  try {
    if (state.editing) {
      const { next, revision } = editMessage(state.editing, fields, { revisionId: newId(), operator, now });
      await state.store.tx([{ store: 'messages', put: next }, { store: 'revisions', put: revision }]);
      saved = next;
    } else {
      saved = await saveNumbered(state.store, { opId: op.id, prefix: op.prefix, recordStore: 'messages' },
        numbered => newMessage(fields, numbered, { id: newId(), opId: op.id, operator, now }));
      // A reply marks the message it answers as answered.
      const orig = saved.replyTo && state.msgs.find(m => m.id === saved.replyTo);
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
  broadcast({ type: 'msgs', opId: op.id });
  flashRow(saved.id);
  $('#m-from').focus();
}

// Who was heard, per operation, for the Von/An completion.
async function rememberStations(fields) {
  const ops = [];
  for (const p of [fields.from, fields.to]) {
    const text = partyText(p);
    if (!text || text === state.op.home) continue;
    ops.push({ store: 'stations', put: { id: `${state.op.id}:${text}`, eventId: state.op.id, text, call: p.call, last: nowIso() } });
  }
  if (ops.length) await state.store.tx(ops);
}

async function recentStations() {
  const list = state.op ? await state.store.getByEvent('stations', state.op.id) : [];
  return list.sort((a, b) => (a.last < b.last ? 1 : -1));
}

function discardForm() {
  const before = readForm();
  const editing = state.editing;
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
}

function startEdit(msg) {
  state.editing = msg;
  writeForm(messageToForm(msg, MODE));
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
  form.addEventListener('submit', ev => { ev.preventDefault(); saveMessage(); });
  form.addEventListener('keydown', ev => {
    if (ev.key === 'Enter' && ev.shiftKey && !isComposing(ev)) {
      ev.preventDefault();
      saveMessage();
    } else if (ev.key === 'Enter' && !isComposing(ev) && ev.target.tagName === 'INPUT' && ev.target.type !== 'checkbox' && !ev.defaultPrevented) {
      ev.preventDefault();
      focusNext(form, ev.target);
    } else if (ev.key === 'Escape' && !ev.defaultPrevented) {
      ev.preventDefault();
      discardForm();
    }
  });
  $('#btn-discard').addEventListener('click', discardForm);

  // Completion: stations heard in this operation first, then the callbook.
  let recent = [];
  const refreshRecent = async () => { recent = (await recentStations()).filter(s => s.call).map(s => ({ call: s.call, title: s.text })); };
  for (const key of ['from', 'to']) {
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
    onPick: r => { $('#m-freq').value = r.out ? String(r.out) : $('#m-freq').value; onFormChange(); },
  });
  state.locField = createLocationField({
    input: $('#m-loc'), chip: $('#m-loc-info'), results: $('#m-loc-pop'), onChange: onFormChange,
  });
}

/* ---------------------------------------------------------------- the book */

const FILTERS = {
  all: {}, open: { open: true }, in: { direction: 'in' }, out: { direction: 'out' }, urgent: { urgent: true },
};

function viennaTime(iso) {
  return viennaClock(iso).time;
}

function pill(cls, text) {
  return el('span', { class: `pill ${cls}` }, text);
}

function statusPill(msg) {
  const s = currentStatus(msg);
  return pill(`st-${s}`, STATUS_LABELS[s]);
}

function prioPill(msg) {
  return msg.priority === 'routine' ? el('span', { class: 'dim' }, PRIORITIES.routine) : pill(`pr-${msg.priority}`, PRIORITIES[msg.priority]);
}

function alarmBadge(msg) {
  return msg.alarm ? el('span', { class: 'alarm-badge' }, 'STAB HERHÖREN!') : null;
}

async function advance(msg, state_) {
  const operator = normalizeCall($('#book-operator').value) || state.op.operator || '';
  try {
    await state.store.tx([{ store: 'messages', put: setStatus(msg, state_, { operator, now: nowIso() }) }]);
  } catch (e) {
    showSaveError(e);
    return;
  }
  await reloadMsgs();
  bookStatus(`${msg.number}: ${STATUS_LABELS[state_]}`);
  broadcast({ type: 'msgs', opId: state.op.id });
}

function renderSummary() {
  const s = bookSummary(state.msgs);
  fill($('#book-summary'),
    s.emergencyOpen ? el('span', { class: 'sum sum-err' }, el('b', {}, String(s.emergencyOpen)), ' Notfall offen') : null,
    s.unacknowledged ? el('span', { class: 'sum sum-warn' }, el('b', {}, String(s.unacknowledged)), ' nicht quittiert') : null,
    el('span', { class: 'sum' }, el('b', {}, String(s.total)), ` Meldungen${s.range.length ? ` · ${s.range.join(', ')}` : ''}${s.gaps.length ? '' : s.total ? ', lückenlos' : ''}`),
    s.gaps.length ? el('span', { class: 'sum sum-err' }, `Lücke: ${s.gaps.join(', ')}`) : null);
}

function renderBook() {
  if (!state.op) return;
  renderFormState();
  renderSummary();
  const f = FILTERS[state.filter];
  let list = filterMessages(state.msgs, { ...f, urgent: undefined, query: state.query });
  if (f.urgent) list = list.filter(m => m.priority !== 'routine' || m.alarm);
  list.reverse(); // newest first
  const body = $('#book-body');
  if (!list.length) {
    fill(body, el('tr', {}, el('td', { colspan: '8', class: 'empty' }, state.msgs.some(m => !m.deleted) ? 'Keine Meldung passt zum Filter.' : 'Noch keine Meldungen. Die erste oben eintragen.')));
  } else {
    fill(body, list.map(m => {
      const step = nextStep(m);
      const last = m.status[m.status.length - 1];
      return el('tr', { 'data-id': m.id, class: m.priority === 'emergency' || m.alarm ? 'urgent' : null },
        el('td', { class: 'num' }, el('a', { href: `#/e/${state.op.id}/m/${m.id}` }, m.number)),
        el('td', { class: 'mono' }, viennaTime(m.ts)),
        el('td', { class: 'nowrap' }, m.direction === 'in' ? '↓ Ein' : '↑ Aus'),
        el('td', { class: 'parties' }, partyText(m.from), el('span', { class: 'dim' }, ' → '), partyText(m.to),
          el('div', { class: 'sub' }, [CHANNELS[m.channel], m.radio.freq, m.radio.via && `via ${m.radio.via}`, m.stichzeit && `Stichzeit ${viennaTime(m.stichzeit)}`].filter(Boolean).join(' · '))),
        el('td', { class: 'content' }, alarmBadge(m), el('b', {}, m.subject || ''), el('div', { class: 'sub clamp' }, m.text)),
        el('td', { class: 'nowrap' }, MESSAGE_TYPES[m.type], el('div', {}, prioPill(m))),
        el('td', { class: 'nowrap' }, statusPill(m), el('div', { class: 'sub mono' }, `${viennaTime(last.at)} ${last.by}`)),
        el('td', { class: 'act' },
          step ? el('button', { type: 'button', class: 'mini', onclick: () => advance(m, step.state), 'aria-label': `${m.number} ${step.label}` }, step.label) : null,
          el('button', { type: 'button', class: 'mini', onclick: () => printForm(m), 'aria-label': `Meldeaufnahmeformular ${m.number} drucken` }, 'Formular')));
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
  const operator = normalizeCall($('#book-operator').value) || state.op.operator || '';
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
  const step = nextStep(m);
  const revs = state.revisions.filter(r => r.messageId === m.id).sort((a, b) => (a.at < b.at ? 1 : -1));
  const kv = (k, ...v) => [el('dt', {}, k), el('dd', {}, ...v)];
  const link = x => el('a', { href: `#/e/${state.op.id}/m/${x.id}`, class: 'mono' }, x.number);
  const replies = repliesTo(state.msgs, m.id);
  fill(box, el('div', { class: 'detail' },
    el('article', { class: 'detail-main' },
      el('div', { class: 'detail-tags' },
        m.deleted ? pill('st-deleted', 'gelöscht') : null,
        m.priority !== 'routine' ? pill(`pr-${m.priority}`, PRIORITIES[m.priority]) : null,
        alarmBadge(m),
        el('span', { class: 'dim' }, `${m.direction === 'in' ? '↓' : '↑'} ${DIRECTIONS[m.direction]} · ${MESSAGE_TYPES[m.type]}`)),
      el('h3', { class: 'detail-subject' }, m.subject || '(ohne Betreff)'),
      el('section', { class: 'verbatim', 'aria-label': 'Inhalt, wörtlich' },
        el('div', { class: 'cap' }, 'Inhalt – wörtlich', m.readBack ? el('span', { class: 'ok' }, ' ✓ rückgelesen') : null),
        el('p', {}, m.text || '–')),
      el('dl', { class: 'kv' },
        ...kv('Zeit', el('span', { class: 'mono' }, fmtVienna(m.ts)), el('span', { class: 'dim mono' }, ` · ${fmtUtc(m.ts)}`)),
        ...kv('Von', partyText(m.from)),
        ...kv('An', partyText(m.to)),
        ...(m.distribution.length ? kv('Verteiler', m.distribution.join(', ')) : []),
        ...kv('Übermittlung', [CHANNELS[m.channel], m.radio.freq && `${m.radio.freq} MHz`, m.radio.via && `via ${m.radio.via}`].filter(Boolean).join(' · ')),
        ...(m.stichzeit ? kv('Stichzeit', fmtVienna(m.stichzeit)) : []),
        ...(m.origin.station || m.origin.place || m.origin.filed ? kv('Ursprung', [m.origin.station, m.origin.place, m.origin.filed && fmtVienna(m.origin.filed)].filter(Boolean).join(' · ')) : []),
        ...(m.location ? kv('Standort', describeLocation(m.location), ' ', mapLinks(m.location)) : []),
        ...kv('Aufgenommen', el('span', { class: 'mono' }, m.operator || '–')),
        ...(m.remarks ? kv('Anmerkungen', m.remarks) : [])),
      el('div', { class: 'toolbar detail-actions' },
        step && !m.deleted ? el('button', { type: 'button', class: 'primary', onclick: () => advance(m, step.state) }, `Als ${step.done} markieren`) : null,
        m.deleted ? null : el('button', { type: 'button', onclick: () => startReply(m) }, 'Antwort erfassen'),
        m.deleted ? null : el('button', { type: 'button', onclick: () => startEdit(m) }, 'Bearbeiten'),
        el('button', { type: 'button', onclick: () => printForm(m) }, 'Meldeaufnahmeformular drucken / PDF'),
        m.deleted
          ? el('button', { type: 'button', onclick: () => restoreMsg(m) }, 'Wiederherstellen')
          : el('button', { type: 'button', class: 'danger', onclick: () => deleteMsg(m) }, 'Löschen'))),
    el('aside', { class: 'detail-side' },
      el('section', { 'aria-label': 'Bearbeitung' },
        el('h3', { class: 'cap' }, 'Bearbeitung'),
        el('ol', { class: 'steps' }, statusSteps(m).map(s => el('li', { class: s.done ? 'done' : s.next ? 'next' : s.skipped ? 'skipped' : '' },
          el('span', { class: 'dot', 'aria-hidden': 'true' }),
          el('div', {},
            el('div', { class: 'step-label' }, s.label, s.done ? el('span', { class: 'sr-only' }, ' (erledigt)') : s.skipped ? ' (übersprungen)' : ''),
            el('div', { class: 'sub mono' }, s.entry ? `${fmtVienna(s.entry.at)} · ${s.entry.by}${s.entry.note ? ` · ${s.entry.note}` : ''}` : s.state === 'answered' ? 'mit „Antwort erfassen“' : ''))))),
        el('p', { class: 'hint' }, 'Nur vorwärts: ein Schritt kann übersprungen, aber nicht zurückgenommen werden.')),
      el('section', { 'aria-label': 'Bezug' },
        el('h3', { class: 'cap' }, 'Bezug'),
        m.replyTo && byId.get(m.replyTo) ? el('p', {}, 'Antwort auf ', link(byId.get(m.replyTo)), ` ${byId.get(m.replyTo).subject}`) : null,
        el('p', {}, 'Antworten: ', replies.length ? replies.flatMap((r, i) => [i ? ', ' : '', link(r)]) : el('span', { class: 'dim' }, 'noch keine'))),
      el('section', { 'aria-label': 'Fassungen' },
        el('h3', { class: 'cap' }, 'Fassungen'),
        revs.length ? el('ul', { class: 'revs' }, revs.map(r => el('li', {},
          el('details', {},
            el('summary', {}, el('span', { class: 'mono' }, `${fmtVienna(r.at)} ${r.by || ''}`), ' geändert; vorher:'),
            el('div', { class: 'sub' }, el('b', {}, r.old.subject || ''), ' ', r.old.text))))) : null,
        el('p', { class: 'sub' }, el('span', { class: 'mono' }, `${fmtVienna(m.created)} ${m.operator || ''}`), ' erfasst'),
        el('p', { class: 'hint' }, 'Jede Änderung behält die vorige Fassung. Die Nummer bleibt immer gleich.')))));
}

/* ---------------------------------------------------------------- print, exports, backup */

function printForm(m) {
  const revisions = state.revisions.filter(r => r.messageId === m.id).length;
  printSheet(renderFormSheet(formSheet(m, state.op, { now: nowIso(), revisions, byId: new Map(state.msgs.map(x => [x.id, x])) })), 'form');
}

// An empty form (for a stack of paper forms): with the operation's name
// when one is open. The number of copies is chosen in the print dialog.
function printBlankForm() {
  printSheet(renderFormSheet(blankFormSheet(state.op, { now: nowIso() })), 'form');
}

function printBook() {
  const status = $('#pr-status');
  const now = nowIso();
  const from = $('#pr-from').value.trim(), to = $('#pr-to').value.trim();
  const fromIso = from ? readTime(from, MODE, now) : null;
  const toIso = to ? readTime(to, MODE, now) : null;
  if ((from && !fromIso) || (to && !toIso)) {
    status.textContent = 'Zeit als HH:MM oder JJJJ-MM-TT HH:MM.';
    return;
  }
  status.textContent = '';
  printSheet(renderBookSheet(bookSheet(state.msgs, state.op, { now, fromIso, toIso })), 'book');
}

async function exportBackup() {
  const [counters] = await Promise.all([state.store.getByEvent('counters', state.op.id)]);
  download(toBackup({ operation: state.op, messages: state.msgs, revisions: state.revisions, counters }, nowIso()), `${fileStem()}-sicherung.json`, 'application/json');
  bookStatus('Sicherung (JSON) heruntergeladen');
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
}

async function loadRepeaterFooter() {
  const idx = await loadRepeaterIndex();
  fill($('#st-repeaters'), idx
    ? sourceItem('repeaters', `Stand ${standDate(idx.retrieved)}, ${idx.list.length} Sprach-Relais`)
    : 'Relaisliste nicht verfügbar');
}

function wire() {
  $('#btn-new-op').addEventListener('click', () => ($('#new-op').hidden ? openNewOpForm() : ($('#new-op').hidden = true)));
  trackExpanded($('#btn-new-op'), $('#new-op'));
  $('#btn-cancel-op').addEventListener('click', () => { $('#new-op').hidden = true; });
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
  $('#book-operator').addEventListener('change', () => updateOp(state.op, { operator: normalizeCall($('#book-operator').value) }));
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
  trackExpanded($('#btn-print-book'), $('#print-range'));
  $('#btn-print-book').addEventListener('click', () => { $('#print-range').hidden = !$('#print-range').hidden; if (!$('#print-range').hidden) $('#pr-from').focus(); });
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
    fileHidden: ['#offline-file-link', '#offline-card', '#data-sources-link', '#home-link'],
  });
  loadCallbook();
  loadRepeaterFooter();
  // The location index is big: build it in the background, after the page is up.
  setTimeout(() => { loadLocationIndex(); fillLocationSources(); }, 800);
  await route();
}

main();
