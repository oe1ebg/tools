// UI for the offline confirmation-traffic log (Bestätigungsverkehr).
// Persistence rules (see oe1ebg/confirm-README.md): every saved line is
// written to storage before the UI reports it as saved; edits keep the old
// version in `revisions`; deletes are soft; the half-typed line is kept as a
// draft. Nothing here ever talks to the network.

import { openStorage, requestPersistence } from './db.js';
import {
  normalizeCall, isPlausibleCall, newId, nowIso, splitUtc, splitTime, zoneLabel, parseTimeInput, isoUtc,
  MODES, modeInfo, headerSnapshot, emptyHeader, checkinNumbers, previousCheckins,
  liveSorted, stats,
} from './model.js';
import { TEMPLATES, templateFor, fieldVisible, fieldDisplay, fieldOptions, currentOptions } from './templates.js';
import { toCSV, toADIF, toSummary } from './export.js';
import { loadDataFile } from './data.js';
import { buildCallbook, lookupCall, suggestCalls } from './callbook.js';
import { $, el, fill, popover } from './dom.js';
import { initLocationPanel } from './locationui.js';
import { createLocationField, describeLocation } from './locfield.js';
import { repeaterSearchWidget, loadRepeaterIndex } from './repeaterui.js';
import { sourceItem } from './sources.js';
import { createLineRepeater } from './linerepeater.js';
import { headerFromRepeater, formatShift } from './repeaters.js';

const THEME_KEY = 'oe1ebg-confirm-theme';
const TIME_MODE_KEY = 'oe1ebg-confirm-time-mode';
const CSV_SEP_KEY = 'oe1ebg-confirm-csv-sep';
const SNAPSHOT_EVERY = 10;   // full JSON snapshot of an event every N saved lines
const SNAPSHOT_KEEP = 5;     // ... keeping the newest N per event
const EXPORT_NUDGE_AFTER = 25;
const BACKUP_FORMAT = 'oe1ebg-confirm-backup';

const state = {
  store: null,
  tab: 'active',
  event: null,        // currently open event
  entries: [],        // all entries (incl. soft-deleted) of the open event
  editingId: null,
  readOnly: false,
  releaseLock: null,
  draftTimer: null,
  headerTimer: null,
  channel: null,
  callbook: null,     // Austrian callsign list (data/callsigns-oe.json), null until loaded
  stations: new Map(), // call -> { call, loc, at, eventTitle }: last known location per station
  locField: null,     // controller of the template's location field, if any
  lineRpt: null,      // per-line repeater override (entry form)
};

/* ---------------------------------------------------------------- errors */

function showFatal(msg) {
  const b = $('#banner');
  fill(b, msg);
  b.hidden = false;
}

function showSaveError(err) {
  console.error(err);
  const b = $('#banner');
  fill(b, 
    'SPEICHERN FEHLGESCHLAGEN – die Eingabe ist noch im Formular. Bitte sofort als CSV/JSON exportieren. ',
    el('small', {}, `(${err && (err.name || err.message) || err})`),
    el('button', { type: 'button', onclick: () => { b.hidden = true; } }, 'ausblenden'),
  );
  b.hidden = false;
}

/* ---------------------------------------------------------------- theme */

function applyTheme(mode) {
  if (mode === 'light' || mode === 'dark') document.documentElement.setAttribute('data-theme', mode);
  else document.documentElement.removeAttribute('data-theme');
  document.querySelectorAll('#theme-toggle button').forEach(b => {
    b.classList.toggle('active', b.dataset.themeChoice === mode);
  });
}

function initTheme() {
  applyTheme(localStorage.getItem(THEME_KEY) || 'auto');
  document.querySelectorAll('#theme-toggle button').forEach(b => {
    b.addEventListener('click', () => {
      localStorage.setItem(THEME_KEY, b.dataset.themeChoice);
      applyTheme(b.dataset.themeChoice);
    });
  });
}

/* ---------------------------------------------------------------- time display (UTC / local) */

// Display and input only — entries always store an ISO 8601 UTC timestamp.
function timeMode() {
  return localStorage.getItem(TIME_MODE_KEY) === 'local' ? 'local' : 'utc';
}

// "19:42:07 UTC" / "21:42:07 UTC+2"
function fmtTime(iso, withSeconds = true) {
  const t = splitTime(iso, timeMode()).time;
  return `${withSeconds ? t : t.slice(0, 5)} ${zoneLabel(iso, timeMode())}`;
}

function fmtDateTime(iso) {
  const { date, time } = splitTime(iso, timeMode());
  return `${date} ${time} ${zoneLabel(iso, timeMode())}`;
}

function applyTimeMode() {
  const mode = timeMode();
  document.querySelectorAll('#time-toggle button').forEach(b => b.classList.toggle('active', b.dataset.timeMode === mode));
  $('#time-label').textContent = mode === 'local' ? `Zeit lokal (${zoneLabel(nowIso(), 'local')})` : 'Zeit UTC';
  $('#f-time').title = `Leer lassen = Zeitpunkt des Speicherns. Korrektur: HH:MM oder JJJJ-MM-TT HH:MM (${mode === 'local' ? 'Lokalzeit' : 'UTC'}). Gespeichert wird immer ein ISO-Zeitstempel.`;
  tickClock();
  if (state.event) {
    renderLog();
    renderTrash();
    updateCallFeedback();
  }
}

function tickClock() {
  $('#clock').textContent = splitTime(nowIso(), timeMode()).time;
}

function initTimeMode() {
  document.querySelectorAll('#time-toggle button').forEach(b => b.addEventListener('click', () => {
    // A half-typed time correction is converted, not reinterpreted.
    const input = $('#f-time');
    const old = timeMode();
    const iso = input.value ? parseTimeInput(input.value, old, nowIso()) : null;
    localStorage.setItem(TIME_MODE_KEY, b.dataset.timeMode);
    if (iso) {
      const { date, time } = splitTime(iso, timeMode());
      input.value = `${date} ${time}`;
    }
    applyTimeMode();
  }));
  applyTimeMode();
}

/* ---------------------------------------------------------------- offline / service worker */

function setChip(id, text, cls) {
  const c = $(id);
  c.textContent = text;
  c.className = 'chip' + (cls ? ' ' + cls : '');
}

async function initOffline() {
  if (location.protocol === 'file:') {
    setChip('#st-offline', 'Offline-Datei', 'ok');
    $('#offline-file-link').hidden = true;
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
    setChip('#st-offline', 'nicht offline-fähig', 'err');
    return;
  }
  let updating = false;
  const offerUpdate = () => {
    if (!reg.waiting || !navigator.serviceWorker.controller) return;
    const btn = $('#btn-update');
    btn.hidden = false;
    btn.onclick = async () => {
      updating = true;
      await flushDraft();
      reg.waiting.postMessage('skipWaiting');
    };
  };
  reg.addEventListener('updatefound', () => {
    const w = reg.installing;
    w?.addEventListener('statechange', () => {
      if (w.state === 'installed') offerUpdate();
      if (w.state === 'activated') reportOfflineVersion();
    });
  });
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (updating) location.reload();
    else reportOfflineVersion();
  });
  offerUpdate();
  reportOfflineVersion();
  // Look for a new version whenever we (re)gain connectivity — never required.
  const check = () => reg.update().catch(() => {});
  window.addEventListener('online', check);
  if (navigator.onLine) check();
}

function reportOfflineVersion() {
  const ctl = navigator.serviceWorker && navigator.serviceWorker.controller;
  if (!ctl) {
    setChip('#st-offline', 'offline: wird eingerichtet…', 'warn');
    return;
  }
  const ch = new MessageChannel();
  ch.port1.onmessage = ev => {
    const v = ev.data && ev.data.version;
    setChip('#st-offline', v ? 'offline bereit ✓' : 'offline bereit (dev)', v ? 'ok' : 'warn');
    $('#st-version').textContent = v || 'dev';
  };
  ctl.postMessage('version', [ch.port2]);
}

async function initPersistence() {
  const r = await requestPersistence();
  if (r === 'persisted') setChip('#st-storage', 'Speicher dauerhaft ✓', 'ok');
  else if (r === 'denied') setChip('#st-storage', 'Speicher nicht dauerhaft – regelmäßig exportieren!', 'warn');
  else setChip('#st-storage', 'Speicher: Browser-Standard', 'warn');
}

/* ---------------------------------------------------------------- header form */

const HEADER_FIELDS = [
  { sub: 'Station' },
  { key: 'operator', label: 'Operator', call: true, size: 9 },
  { key: 'station', label: 'Station (für)', call: true, size: 9 },
  { key: 'myGrid', label: 'Eigener Locator', size: 7 },
  { key: 'myQth', label: 'Eigener QTH', size: 14 },
  { sub: 'Frequenz' },
  { key: 'freq', label: 'Frequenz MHz', size: 9, inputmode: 'decimal' },
  { key: 'mode', label: 'Betriebsart', select: MODES.map(m => [m.key, m.label]) },
  { sub: 'Relais' },
  { key: 'viaRepeater', label: 'Standard: über Relais', check: true },
  { key: 'repeaterCall', label: 'Relais-Rufzeichen', call: true, size: 9 },
  { key: 'repeaterFreq', label: 'Relais-Ausgabe MHz', size: 9, inputmode: 'decimal' },
  { key: 'repeaterShift', label: 'Shift MHz (z. B. -0.6)', size: 6, inputmode: 'decimal' },
  { key: 'repeaterTone', label: 'CTCSS Hz', size: 6, inputmode: 'decimal' },
];

function buildHeaderForm(container, header, onChange) {
  container.replaceChildren();
  for (const f of HEADER_FIELDS) {
    if (f.sub) {
      container.append(el('div', { class: 'sub' }, f.sub));
      if (f.sub === 'Relais') {
        container.append(repeaterSearchWidget(() => readHeaderForm(container), r => {
          const next = headerFromRepeater(r, readHeaderForm(container));
          writeHeaderForm(container, next);
          onChange(next);
        }));
      }
      continue;
    }
    let input;
    if (f.check) {
      input = el('input', { type: 'checkbox', name: f.key, checked: !!header[f.key] });
      container.append(el('label', { class: 'check' }, input, f.label));
    } else {
      if (f.select) {
        input = el('select', { name: f.key }, f.select.map(([v, l]) => el('option', { value: v, selected: header[f.key] === v }, l)));
      } else {
        input = el('input', { name: f.key, value: header[f.key] || '', size: f.size, inputmode: f.inputmode, spellcheck: 'false' });
        if (f.call) input.style.textTransform = 'uppercase';
      }
      container.append(el('label', { class: 'field' }, el('span', {}, f.label), input));
    }
    input.addEventListener(f.check || f.select ? 'change' : 'input', () => onChange(readHeaderForm(container)));
  }
}

function writeHeaderForm(container, h) {
  for (const f of HEADER_FIELDS) {
    if (f.sub) continue;
    const input = container.querySelector(`[name="${f.key}"]`);
    if (!input) continue;
    if (f.check) input.checked = !!h[f.key];
    else input.value = h[f.key] ?? '';
  }
}

function readHeaderForm(container) {
  const h = emptyHeader();
  for (const f of HEADER_FIELDS) {
    if (f.sub) continue;
    const input = container.querySelector(`[name="${f.key}"]`);
    if (!input) continue;
    if (f.check) h[f.key] = input.checked;
    else h[f.key] = f.call ? normalizeCall(input.value) : input.value.trim();
  }
  return h;
}

function headerSummary(h) {
  const parts = [];
  if (h.operator) parts.push(`Op ${h.operator}`);
  if (h.station && h.station !== h.operator) parts.push(`für ${h.station}`);
  const f = [h.freq && `${h.freq} MHz`, modeInfo(h.mode)?.label].filter(Boolean).join(' ');
  if (f) parts.push(f);
  if (h.viaRepeater || h.repeaterCall) {
    const shift = h.repeaterShift !== '' && h.repeaterShift !== undefined ? formatShift(parseFloat(h.repeaterShift)) : '';
    parts.push(`${h.viaRepeater ? 'via' : 'Relais'} ${h.repeaterCall || 'Relais'}${h.repeaterFreq ? ' ' + h.repeaterFreq : ''}`
      + `${shift ? ' ' + shift : ''}${h.repeaterTone ? ', CTCSS ' + h.repeaterTone : ''}`);
  }
  return parts.join(' · ') || '(noch leer – Operator und Station eintragen)';
}

/* ---------------------------------------------------------------- events view */

async function showEvents() {
  await leaveEvent();
  $('#view-log').hidden = true;
  $('#view-events').hidden = false;
  document.title = 'Bestätigungsverkehr';
  await renderEventList();
}

async function renderEventList() {
  const [events, entries] = await Promise.all([
    state.store.getAll('events'),
    state.store.getAll('entries'),
  ]);
  const counts = new Map();
  for (const e of entries) {
    if (!counts.has(e.eventId)) counts.set(e.eventId, []);
    counts.get(e.eventId).push(e);
  }
  const visible = events
    .filter(ev => state.tab === 'deleted' ? ev.deleted : !ev.deleted && (state.tab === 'archived' ? ev.archived : !ev.archived))
    .sort((a, b) => (a.created < b.created ? 1 : -1));
  const list = $('#event-list');
  list.replaceChildren();
  if (!visible.length) {
    list.append(el('li', { class: 'empty' },
      state.tab === 'active' ? 'Noch keine Ereignisse. „+ Neues Ereignis“ legt eines an.' : 'Leer.'));
    return;
  }
  for (const ev of visible) {
    const st = stats(counts.get(ev.id) || []);
    const actions = [];
    if (!ev.deleted) {
      actions.push(el('button', { type: 'button', class: 'primary', onclick: () => { location.hash = `#/e/${ev.id}`; } }, 'Öffnen'));
      actions.push(el('button', { type: 'button', onclick: () => duplicateEvent(ev) }, 'Duplizieren'));
      actions.push(el('button', { type: 'button', onclick: () => updateEvent(ev, { archived: !ev.archived }) }, ev.archived ? 'Reaktivieren' : 'Archivieren'));
      actions.push(el('button', { type: 'button', class: 'danger', onclick: () => {
        if (confirm(`„${ev.title}“ in den Papierkorb verschieben? (Kann wiederhergestellt werden.)`)) updateEvent(ev, { deleted: nowIso() });
      } }, 'Löschen'));
    } else {
      actions.push(el('button', { type: 'button', onclick: () => updateEvent(ev, { deleted: null }) }, 'Wiederherstellen'));
    }
    list.append(el('li', { class: 'event-card' },
      el('div', { class: 'info' },
        el('div', { class: 't' }, ev.title),
        el('div', { class: 'meta' },
          `${splitTime(ev.created, timeMode()).date} · ${templateFor(ev.template).label} · ${st.unique} Stationen / ${st.total} Check-ins`),
        el('div', { class: 'meta' }, headerSummary(ev.header || {})),
      ),
      el('div', { class: 'actions' }, actions),
    ));
  }
}

async function updateEvent(ev, patch) {
  const next = { ...ev, ...patch, updated: nowIso() };
  try {
    await state.store.tx([{ store: 'events', put: next }]);
    broadcast({ type: 'events' });
  } catch (e) {
    showSaveError(e);
  }
  await renderEventList();
}

function openNewEventForm(prefill) {
  const form = $('#new-event');
  form.hidden = false;
  form.title.value = prefill?.title || '';
  const sel = $('#new-template');
  fill(sel, ...TEMPLATES.map(t => el('option', { value: t.key }, `${t.label} – ${t.hint}`)));
  sel.value = prefill?.template || TEMPLATES[0].key;
  const header = prefill?.header || lastHeader() || emptyHeader();
  buildHeaderForm($('#new-header'), header, () => {});
  form.title.focus();
}

// Pre-fill a new event with the header of the most recently created one —
// usually the same operator/station/repeater.
let cachedLastHeader = null;
function lastHeader() {
  return cachedLastHeader ? { ...cachedLastHeader } : null;
}

async function refreshLastHeader() {
  const events = (await state.store.getAll('events')).filter(e => !e.deleted);
  events.sort((a, b) => (a.created < b.created ? 1 : -1));
  cachedLastHeader = events[0]?.header || null;
}

async function createEvent(title, template, header) {
  const ev = {
    id: newId(), title: title.trim() || 'Ereignis', template, header,
    created: nowIso(), updated: nowIso(), nextSeq: 1, archived: false, deleted: null,
    exportedTotal: 0,
  };
  try {
    await state.store.tx([{ store: 'events', put: ev }]);
  } catch (e) {
    showSaveError(e);
    return;
  }
  broadcast({ type: 'events' });
  cachedLastHeader = header;
  location.hash = `#/e/${ev.id}`;
}

async function duplicateEvent(ev) {
  openNewEventForm({ title: ev.title, template: ev.template, header: { ...ev.header } });
  window.scrollTo(0, 0);
}

/* ---------------------------------------------------------------- log view */

async function openEvent(id) {
  await leaveEvent();
  const ev = await state.store.get('events', id);
  if (!ev) {
    location.hash = '#/';
    return;
  }
  state.event = ev;
  state.entries = await state.store.getByEvent('entries', id);
  state.editingId = null;
  $('#view-events').hidden = true;
  $('#view-log').hidden = false;
  document.title = `${ev.title} – Bestätigungsverkehr`;
  $('#log-title').value = ev.title;
  $('#hdr-panel').open = !(ev.header?.operator);
  buildHeaderForm($('#log-header'), ev.header || emptyHeader(), onHeaderChange);
  $('#hdr-sum').textContent = headerSummary(ev.header || {});
  buildEntryFields();
  renderLog();
  renderTrash();
  updateExportNudge();
  await acquireLock(false);
  await restoreDraft();
  $('#f-call').focus();
}

async function leaveEvent() {
  if (!state.event) return;
  await flushDraft();
  await flushHeader();
  if (!state.readOnly && stats(state.entries).total) await takeSnapshot('beim Verlassen');
  if (state.releaseLock) state.releaseLock();
  state.releaseLock = null;
  state.event = null;
  state.entries = [];
  state.editingId = null;
}

/* --- single-writer lock across tabs (Web Locks API) --- */

function acquireLock(steal) {
  const ev = state.event;
  if (!navigator.locks) { setReadOnly(false); return Promise.resolve(); }
  return new Promise(resolve => {
    navigator.locks.request(`oe1ebg-confirm-event-${ev.id}`, steal ? { steal: true } : { ifAvailable: true }, lock => {
      if (!lock) {
        setReadOnly(true, 'Dieses Ereignis ist in einem anderen Tab/Fenster geöffnet – hier nur Ansicht, damit nichts überschrieben wird.');
        resolve();
        return undefined;
      }
      setReadOnly(false);
      resolve();
      return new Promise(release => { state.releaseLock = release; });
    }).catch(() => {
      // Lock was stolen by another tab.
      if (state.event && state.event.id === ev.id) {
        state.releaseLock = null;
        flushDraft();
        setReadOnly(true, 'Ein anderer Tab hat die Bearbeitung übernommen – hier nur Ansicht.');
      }
    });
  });
}

function setReadOnly(ro, msg) {
  state.readOnly = ro;
  const b = $('#lock-banner');
  if (ro) {
    fill(b, msg, el('button', { type: 'button', onclick: () => acquireLock(true).then(restoreDraft) }, 'Hier bearbeiten'));
    b.hidden = false;
  } else {
    b.hidden = true;
  }
  for (const n of document.querySelectorAll('#entry-form input, #entry-form button, #log-header input, #log-header select, #log-title')) {
    n.disabled = ro;
  }
  renderLog();
}

/* --- header / title edits --- */

function onHeaderChange(h) {
  if (state.readOnly) return;
  state.event.header = h;
  $('#hdr-sum').textContent = headerSummary(h);
  updateRepeaterDefault();
  clearTimeout(state.headerTimer);
  state.headerTimer = setTimeout(flushHeader, 400);
}

async function flushHeader() {
  if (!state.headerTimer || !state.event) return;
  clearTimeout(state.headerTimer);
  state.headerTimer = null;
  const ev = { ...state.event, updated: nowIso() };
  try {
    await state.store.tx([{ store: 'events', put: ev }]);
    cachedLastHeader = ev.header;
    broadcast({ type: 'events' });
  } catch (e) {
    showSaveError(e);
  }
}

/* --- entry form --- */

function buildEntryFields() {
  const tpl = templateFor(state.event.template);
  const box = $('#f-fields');
  box.replaceChildren();
  for (const f of tpl.fields) {
    let control;
    if (f.type === 'radio') {
      control = el('div', { class: f.grade ? 'radio-group grade' : 'radio-group', role: 'radiogroup', 'aria-label': f.label, title: f.hint },
        fieldOptions(f).map(([v, l]) => {
          const r = el('input', { type: 'radio', name: `f_${f.key}`, value: v });
          // Clicking the selected option again clears it (radios can't otherwise be unset).
          r.addEventListener('click', () => {
            if (r.dataset.was === '1') { r.checked = false; r.dataset.was = ''; }
            else box.querySelectorAll(`input[name="f_${f.key}"]`).forEach(o => { o.dataset.was = o === r ? '1' : ''; });
            onFormInput();
          });
          return el('label', { 'data-value': v }, r, el('span', {}, l));
        }));
    } else {
      control = el('input', {
        name: `f_${f.key}`, size: f.type === 'rst' ? 3 : f.size || 12,
        inputmode: f.type === 'rst' ? 'numeric' : f.inputmode, spellcheck: 'false',
        class: f.type === 'location' ? 'loc-input' : null, autocomplete: 'off',
      });
    }
    // Radio groups get a <div>, not a <label>: nested labels would make a
    // click on the caption select the first option.
    if (f.type === 'location') {
      // Completion dropdown right under the input; status + memory below it.
      control.id = `f_${f.key}`;
      box.append(el('div', { class: 'field ac-field', 'data-field': f.key },
        el('label', { for: control.id }, f.label),
        el('div', { class: 'ac-wrap' }, control, el('div', { class: 'ac-pop loc-pop' })),
        el('div', { class: 'ac-info loc-chip' }),
        el('div', { class: 'ac-info', id: 'call-station' })));
      continue;
    }
    box.append(el(f.type === 'radio' ? 'div' : 'label', { class: 'field', 'data-field': f.key }, el('span', {}, f.label), control));
  }
  state.locField = null;
  const lf = tpl.fields.find(f => f.type === 'location');
  if (lf) {
    const wrap = box.querySelector(`[data-field="${lf.key}"]`);
    state.locField = createLocationField({
      input: wrap.querySelector('input'),
      results: wrap.querySelector('.loc-pop'),
      chip: wrap.querySelector('.loc-chip'),
      plzInput: lf.plzKey ? box.querySelector(`input[name="f_${lf.plzKey}"]`) : null,
      onChange: scheduleDraft,
    });
  }
  updateFieldVisibility();
  updateRepeaterDefault();
}

function readFields() {
  const tpl = templateFor(state.event.template);
  const out = {};
  for (const f of tpl.fields) {
    if (f.type === 'radio') {
      const c = document.querySelector(`#f-fields input[name="f_${f.key}"]:checked`);
      out[f.key] = c ? c.value : '';
    } else {
      out[f.key] = document.querySelector(`#f-fields input[name="f_${f.key}"]`).value.trim();
    }
  }
  return out;
}

function writeFields(values) {
  const tpl = templateFor(state.event.template);
  for (const f of tpl.fields) {
    const v = values?.[f.key] ?? '';
    if (f.type === 'radio') {
      document.querySelectorAll(`#f-fields input[name="f_${f.key}"]`).forEach(r => {
        r.checked = r.value === v;
        r.dataset.was = r.checked ? '1' : '';
      });
    } else {
      const input = document.querySelector(`#f-fields input[name="f_${f.key}"]`);
      input.value = v;
      input.dataset.autofill = ''; // explicitly set values are never auto-replaced
    }
  }
  updateFieldVisibility();
}

function updateFieldVisibility() {
  const tpl = templateFor(state.event.template);
  const vals = readFields();
  for (const f of tpl.fields) {
    const lab = document.querySelector(`#f-fields [data-field="${f.key}"]`);
    if (lab) lab.hidden = !fieldVisible(f, vals, tpl);
    if (f.optionsBy && lab) {
      // Offer only the options for the current choice (e.g. iOS versions);
      // a selection that no longer fits is cleared.
      const allowed = new Set(currentOptions(f, vals).map(o => o[0]));
      lab.querySelectorAll('label[data-value]').forEach(l => {
        const ok = allowed.has(l.dataset.value);
        l.hidden = !ok;
        const r = l.querySelector('input');
        if (!ok && r.checked) { r.checked = false; r.dataset.was = ''; }
      });
    }
  }
}

function updateRepeaterDefault() {
  const h = state.event.header || {};
  state.lineRpt?.refreshDefault();
  if (!state.editingId && !$('#f-rpt').dataset.touched) $('#f-rpt').checked = !!h.viaRepeater;
}

function readForm() {
  return {
    call: normalizeCall($('#f-call').value),
    fields: readFields(),
    viaRepeater: $('#f-rpt').checked,
    rptOverride: state.lineRpt ? state.lineRpt.get() : null,
    note: $('#f-note').value.trim(),
    time: $('#f-time').value.trim(),
    loc: state.locField ? state.locField.get() : null,
  };
}

function clearForm() {
  $('#f-call').value = '';
  $('#f-note').value = '';
  $('#f-time').value = '';
  writeFields({});
  state.locField?.clear();
  delete $('#f-rpt').dataset.touched;
  state.lineRpt?.reset();
  state.editingId = null;
  $('#entry-form').classList.remove('editing');
  $('#btn-discard').textContent = 'Verwerfen (Esc)';
  $('#btn-save').textContent = 'Speichern ⏎';
  if ($('#form-status .edit-tag')) $('#form-status').replaceChildren();
  updateRepeaterDefault();
  updateCallFeedback();
}

function formIsEmpty(f) {
  return !f.call && !f.note && !f.time && Object.values(f.fields).every(v => !v);
}

function onFormInput() {
  updateFieldVisibility();
  updateCallFeedback();
  scheduleDraft();
}

function updateCallFeedback() {
  const call = normalizeCall($('#f-call').value);
  $('#call-warn').textContent = call && !isPlausibleCall(call) ? 'Ungewöhnliches Rufzeichen – trotzdem speicherbar.' : '';
  renderCallbookInfo(call);
  renderStationMemory(call);
  const prev = previousCheckins(state.entries, call, state.editingId);
  const box = $('#repeat-box');
  if (!prev.length) {
    box.hidden = true;
  } else {
    const tpl = templateFor(state.event.template);
    const n = state.editingId ? checkinNumbers(state.entries).get(state.editingId) : prev.length + 1;
    fill(box, 
      el('div', { class: 'head' },
        state.editingId ? `${call}: Check-in Nr. ${n} – weitere Check-ins dieser Station:` : `Weiterer Check-in von ${call} (Nr. ${n}) – zuvor erfasst:`),
      el('ul', {}, prev.map(e => el('li', {}, describeEntry(e, tpl)))),
      state.editingId ? null : el('button', { type: 'button', onclick: () => {
        const last = prev[prev.length - 1];
        writeFields(last.fields);
        if (!$('#f-note').value) $('#f-note').value = last.note || '';
        onFormInput();
      } }, 'Werte vom letzten Check-in übernehmen'),
    );
    box.hidden = false;
  }
  renderLog(call);
}

function fmtStand(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  return m ? `${m[3]}.${m[2]}.${m[1]}` : iso || '?';
}

// Name/location from the callsign list under the call field, typo
// suggestions, and auto-fill of empty Name/QTH template fields.
function renderCallbookInfo(call) {
  const info = $('#call-info');
  const sug = $('#call-suggest');
  info.className = 'ac-info';
  sug.replaceChildren();
  state.callPop?.update();
  const book = state.callbook;
  if (!book || !call) {
    info.textContent = '';
    autofillFromCallbook(null);
    return;
  }
  const { entry, base, isOE } = lookupCall(book, call);
  if (entry) {
    info.className = 'ac-info known';
    info.textContent = entry[1] || entry[2]
      ? `${entry[0]} · ${[entry[1], entry[2]].filter(Boolean).join(' · ')}`
      : `${entry[0]} · in der Rufzeichenliste (Angaben nicht veröffentlicht)`;
  } else if (isOE && base.length >= 4) {
    info.className = 'ac-info unknown';
    info.textContent = `${base} ist nicht in der Rufzeichenliste (Stand ${fmtStand(book.stand)}) – Tippfehler? Speichern ist trotzdem möglich.`;
  } else {
    info.textContent = '';
  }
  autofillFromCallbook(entry);
  if (!entry && !state.readOnly) {
    const list = suggestCalls(book, call, 8);
    if (list.length) {
      fill(sug, el('div', { class: 'ac-head' }, 'Meinten Sie (↓, Enter):'),
        list.map(c => el('button', { type: 'button', class: 'ac-item', onclick: () => {
          $('#f-call').value = c[0];
          onFormInput();
          state.callPop.hide();
          $('#f-call').focus();
        } }, el('b', {}, c[0]), el('small', {}, [c[1], c[2]].filter(Boolean).join(' · ') || 'Angaben nicht veröffentlicht'))));
    }
    state.callPop?.update();
  }
}

// Fill template fields named "name"/"qth" from the list, but only while they
// are empty or still hold a previous auto-filled value — never overwrite
// what the operator typed.
function autofillFromCallbook(entry) {
  const map = { name: entry ? entry[1] : '', qth: entry ? entry[2] : '' };
  for (const [key, value] of Object.entries(map)) {
    const input = document.querySelector(`#f-fields input[name="f_${key}"]`);
    // A location field is the station's current QTH, not its licence
    // address — offered as an option instead (renderStationMemory).
    if (!input || input.classList.contains('loc-input')) continue;
    if (input.value === '' || input.dataset.autofill === input.value) {
      input.value = value || '';
      input.dataset.autofill = value || '';
    }
  }
}

// Last known location of this station (from any earlier event), with a
// button to take it over into an empty location field.
function renderStationMemory(call) {
  const box = $('#call-station');
  if (!box) return; // template without a location field
  const lf = state.locField;
  const rec = call && state.stations.get(call);
  const listed = call && state.callbook && lookupCall(state.callbook, call).entry;
  const canAdopt = lf && lf.isEmpty() && !state.readOnly;
  fill(box,
    rec ? el('div', {}, `zuletzt: ${describeLocation(rec.loc)} (${splitTime(rec.at, timeMode()).date}) `,
      canAdopt ? el('button', { type: 'button', class: 'link', onclick: () => { lf.adopt(rec.loc); renderStationMemory(call); } }, 'übernehmen') : null) : null,
    listed && listed[2] && canAdopt ? el('div', {}, `laut Rufzeichenliste: ${listed[2]} `,
      el('button', { type: 'button', class: 'link', onclick: () => { lf.setText(listed[2]); renderStationMemory(call); } }, 'übernehmen')) : null);
}

function callbookName(call) {
  const e = state.callbook && lookupCall(state.callbook, call).entry;
  return e ? [e[1], e[2]].filter(Boolean).join(', ') : '';
}

function describeEntry(e, tpl) {
  const bits = [`Nr. ${e.seq}`, fmtTime(e.ts, false)];
  for (const f of tpl.fields) {
    const v = fieldVisible(f, e.fields, tpl) ? fieldDisplay(f, e.fields?.[f.key]) : '';
    if (v) bits.push(`${f.label}: ${v}`);
  }
  if (e.loc) bits.push(`→ ${describeLocation(e.loc)}`);
  bits.push(e.viaRepeater ? `via ${e.snap?.repeaterCall || 'Relais'}` : 'direkt');
  if (e.note) bits.push(`„${e.note}“`);
  return bits.join(' · ');
}

// Typed correction in the current display mode -> ISO UTC timestamp.
function resolveTime(text, fallbackIso) {
  if (!text) return { iso: fallbackIso };
  const iso = parseTimeInput(text, timeMode(), fallbackIso);
  return iso ? { iso } : { error: true };
}

// A line's header snapshot with its own repeater, if one was chosen.
// Clearing an override on edit falls back to the current header repeater.
function lineSnapshot(base, override, header) {
  const snap = { ...base };
  if (override) return { ...snap, ...override, repeaterOverride: true };
  if (snap.repeaterOverride) {
    const h = headerSnapshot(header);
    for (const k of ['repeaterCall', 'repeaterFreq', 'repeaterShift', 'repeaterTone']) snap[k] = h[k];
  }
  delete snap.repeaterOverride;
  return snap;
}

function overrideOf(snap) {
  if (!snap?.repeaterOverride) return null;
  const { repeaterCall, repeaterFreq, repeaterShift, repeaterTone } = snap;
  return { repeaterCall, repeaterFreq, repeaterShift, repeaterTone };
}

async function saveEntry() {
  if (state.readOnly) return;
  const f = readForm();
  const status = $('#form-status');
  if (!f.call) {
    status.className = 'err';
    status.textContent = 'Rufzeichen fehlt.';
    $('#f-call').focus();
    return;
  }
  const ev = state.event;
  const editing = state.editingId ? state.entries.find(e => e.id === state.editingId) : null;
  const t = resolveTime(f.time, editing ? editing.ts : nowIso());
  if (t.error) {
    status.className = 'err';
    status.textContent = `Zeit nicht lesbar – HH:MM oder JJJJ-MM-TT HH:MM (${timeMode() === 'local' ? 'Lokalzeit' : 'UTC'}), oder leer lassen.`;
    $('#f-time').focus();
    return;
  }

  const ops = [];
  let entry;
  let nextEvent = ev;
  if (editing) {
    entry = { ...editing, call: f.call, fields: f.fields, loc: f.loc, viaRepeater: f.viaRepeater, note: f.note, ts: t.iso, updated: nowIso(),
      snap: lineSnapshot(editing.snap, f.rptOverride, ev.header) };
    ops.push({ store: 'revisions', put: { id: newId(), eventId: ev.id, entryId: editing.id, savedAt: nowIso(), reason: 'edit', data: editing } });
  } else {
    entry = {
      id: newId(), eventId: ev.id, seq: ev.nextSeq || 1, ts: t.iso,
      call: f.call, fields: f.fields, loc: f.loc, viaRepeater: f.viaRepeater, note: f.note,
      snap: lineSnapshot(headerSnapshot(ev.header), f.rptOverride, ev.header), created: nowIso(), updated: nowIso(), deleted: null,
    };
    nextEvent = { ...ev, nextSeq: entry.seq + 1, updated: nowIso() };
    ops.push({ store: 'events', put: nextEvent });
  }
  ops.push({ store: 'entries', put: entry });
  ops.push({ store: 'drafts', del: ev.id });
  // Remember the station's location for future check-ins (any event).
  const stationRec = f.loc ? { call: f.call, loc: f.loc, at: t.iso, eventTitle: ev.title } : null;
  if (stationRec) ops.push({ store: 'stations', put: stationRec });

  $('#btn-save').disabled = true;
  clearTimeout(state.draftTimer);
  try {
    await state.store.tx(ops);
  } catch (e) {
    $('#btn-save').disabled = false;
    status.className = 'err';
    status.textContent = 'NICHT gespeichert!';
    showSaveError(e);
    return;
  }
  $('#btn-save').disabled = false;
  state.event = nextEvent;
  if (stationRec) state.stations.set(stationRec.call, stationRec);
  const i = state.entries.findIndex(e => e.id === entry.id);
  if (i >= 0) state.entries[i] = entry; else state.entries.push(entry);
  const n = checkinNumbers(state.entries).get(entry.id);
  status.className = 'ok';
  status.textContent = `✓ Nr. ${entry.seq} ${entry.call}${n > 1 ? ` (Check-in Nr. ${n})` : ''} gespeichert – ${fmtTime(entry.ts)}`;
  clearForm();
  renderLog();
  updateExportNudge();
  broadcast({ type: 'entries', eventId: ev.id });
  if (!editing && stats(state.entries).total % SNAPSHOT_EVERY === 0) takeSnapshot('automatisch');
  $('#f-call').focus();
}

function startEdit(id) {
  if (state.readOnly) return;
  const e = state.entries.find(x => x.id === id);
  if (!e) return;
  state.editingId = id;
  $('#f-call').value = e.call;
  writeFields(e.fields);
  state.locField?.set(e.loc);
  $('#f-rpt').checked = !!e.viaRepeater;
  $('#f-rpt').dataset.touched = '1';
  state.lineRpt?.set(overrideOf(e.snap));
  $('#f-note').value = e.note || '';
  const { date, time } = splitTime(e.ts, timeMode());
  $('#f-time').value = `${date} ${time}`;
  $('#entry-form').classList.add('editing');
  $('#btn-discard').textContent = 'Bearbeitung abbrechen (Esc)';
  $('#btn-save').textContent = `Nr. ${e.seq} speichern ⏎`;
  $('#form-status').className = '';
  fill($('#form-status'), el('span', { class: 'edit-tag' }, `Bearbeite Nr. ${e.seq} – die alte Fassung wird aufbewahrt.`));
  updateCallFeedback();
  scheduleDraft();
  $('#f-call').focus();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function setDeleted(id, deleted) {
  if (state.readOnly) return;
  const e = state.entries.find(x => x.id === id);
  if (!e) return;
  const next = { ...e, deleted: deleted ? nowIso() : null, updated: nowIso() };
  try {
    await state.store.tx([
      { store: 'revisions', put: { id: newId(), eventId: e.eventId, entryId: e.id, savedAt: nowIso(), reason: deleted ? 'delete' : 'restore', data: e } },
      { store: 'entries', put: next },
    ]);
  } catch (err) {
    showSaveError(err);
    return;
  }
  Object.assign(e, next);
  if (state.editingId === id) clearForm();
  const status = $('#form-status');
  status.className = 'ok';
  fill(status, 
    deleted ? `Nr. ${e.seq} ${e.call} gelöscht. ` : `Nr. ${e.seq} ${e.call} wiederhergestellt.`,
    deleted ? el('button', { type: 'button', class: 'link', onclick: () => setDeleted(id, false) }, 'Rückgängig') : null,
  );
  renderLog();
  renderTrash();
  broadcast({ type: 'entries', eventId: e.eventId });
}

/* --- drafts: the half-typed line survives reloads and crashes --- */

function scheduleDraft() {
  if (state.readOnly || !state.event) return;
  clearTimeout(state.draftTimer);
  state.draftTimer = setTimeout(flushDraft, 300);
}

async function flushDraft() {
  if (!state.draftTimer || !state.event || state.readOnly) return;
  clearTimeout(state.draftTimer);
  state.draftTimer = null;
  const f = readForm();
  const op = formIsEmpty(f) && !state.editingId
    ? { store: 'drafts', del: state.event.id }
    : { store: 'drafts', put: { eventId: state.event.id, form: f, editingId: state.editingId, savedAt: nowIso() } };
  try {
    await state.store.tx([op]);
  } catch (e) {
    showSaveError(e);
  }
}

// Put a saved form state (draft, or discarded input being undone) back.
function applyFormState(form, editingId) {
  if (editingId && state.entries.some(e => e.id === editingId)) startEdit(editingId);
  $('#f-call').value = form.call || '';
  writeFields(form.fields);
  state.locField?.set(form.loc);
  $('#f-rpt').checked = !!form.viaRepeater;
  $('#f-rpt').dataset.touched = '1';
  state.lineRpt?.set(form.rptOverride);
  $('#f-note').value = form.note || '';
  $('#f-time').value = form.time || '';
  updateFieldVisibility();
  updateCallFeedback();
}

// Throw away everything typed for the current line (or cancel an edit),
// with a one-click undo — an accidental Esc must not cost any input.
function discardForm() {
  if (state.readOnly) return;
  const form = readForm();
  const editingId = state.editingId;
  if (!editingId && formIsEmpty(form) && !form.loc && !form.rptOverride) {
    $('#f-call').focus();
    return;
  }
  const editedSeq = editingId ? state.entries.find(e => e.id === editingId)?.seq : null;
  clearForm();
  scheduleDraft(); // empty form -> the stored draft is removed
  const status = $('#form-status');
  status.className = 'ok';
  fill(status,
    editingId ? `Bearbeitung von Nr. ${editedSeq} abgebrochen – die Zeile bleibt unverändert. ` : 'Eingaben verworfen. ',
    el('button', { type: 'button', class: 'link', onclick: () => {
      applyFormState(form, editingId);
      scheduleDraft();
      status.replaceChildren();
      $('#f-call').focus();
    } }, 'Rückgängig'));
  $('#f-call').focus();
}

async function restoreDraft() {
  if (state.readOnly || !state.event) return;
  const d = await state.store.get('drafts', state.event.id);
  if (!d || !d.form) return;
  applyFormState(d.form, d.editingId);
  $('#form-status').className = 'ok';
  $('#form-status').textContent = `Nicht gespeicherte Eingabe von ${fmtTime(d.savedAt)} wiederhergestellt.`;
}

/* --- log table --- */

function renderLog(highlightCall) {
  if (!state.event) return;
  const tpl = templateFor(state.event.template);
  const nums = checkinNumbers(state.entries);
  const live = liveSorted(state.entries).reverse();
  const st = stats(state.entries);
  $('#st-unique').textContent = st.unique;
  $('#st-total').textContent = st.total;
  const call = highlightCall ?? normalizeCall($('#f-call').value);

  fill($('#log-head'), el('tr', {},
    el('th', {}, timeMode() === 'local' ? `Zeit (${zoneLabel(nowIso(), 'local')})` : 'Zeit UTC'), el('th', {}, 'Nr'), el('th', {}, 'Rufzeichen'),
    tpl.fields.map(f => el('th', {}, f.label)),
    el('th', {}, 'Relais'), el('th', {}, 'Notiz'), el('th', {}, 'Op'), el('th', { class: 'act' }, '')));

  const body = $('#log-body');
  body.replaceChildren();
  if (!live.length) {
    body.append(el('tr', {}, el('td', { colspan: String(tpl.fields.length + 7), class: 'empty' }, 'Noch keine Einträge. Rufzeichen eingeben und Enter drücken.')));
    return;
  }
  for (const e of live) {
    const n = nums.get(e.id);
    const { date, time } = splitTime(e.ts, timeMode());
    const s = e.snap || {};
    // Date only when it differs from the newest line (nets past midnight).
    const showDate = date !== splitTime(live[0].ts, timeMode()).date;
    body.append(el('tr', { class: [e.call === call && call ? 'match' : '', e.id === state.editingId ? 'editing' : ''].join(' ').trim() || null },
      el('td', { class: 'mono', title: `${isoUtc(e.ts)} (gespeichert, UTC)` }, showDate ? el('span', { class: 'date' }, date + ' ') : null, time,
        timeMode() === 'utc' ? 'Z' : null, // ISO/military notation for UTC; local times keep the column's offset
        timeMode() === 'local' && zoneLabel(e.ts, 'local') !== zoneLabel(nowIso(), 'local') ? el('span', { class: 'date' }, ' ' + zoneLabel(e.ts, 'local')) : null),
      el('td', { class: 'mono' }, String(e.seq)),
      el('td', { class: 'call' }, e.call, n > 1 ? el('span', { class: 'badge', title: `Check-in Nr. ${n}` }, `${n}×`) : null,
        callbookName(e.call) ? el('div', { class: 'cb-name' }, callbookName(e.call)) : null),
      tpl.fields.map(f => el('td', {}, fieldVisible(f, e.fields, tpl) ? fieldDisplay(f, e.fields?.[f.key]) : '',
        f.type === 'location' && e.loc ? el('div', { class: 'loc-sub' }, `→ ${describeLocation(e.loc)}`) : null,
        f.type === 'location' && !e.loc && e.fields?.[f.key] ? el('div', { class: 'loc-sub unresolved' }, 'nicht zugeordnet') : null)),
      el('td', {}, e.viaRepeater
        ? el('span', {
          class: s.repeaterOverride ? 'rpt override' : 'rpt',
          title: [s.repeaterOverride ? 'anderes Relais als im Header' : 'Relais aus dem Header', s.repeaterFreq && `${s.repeaterFreq} MHz`, s.repeaterShift && `Shift ${s.repeaterShift}`, s.repeaterTone && `CTCSS ${s.repeaterTone}`].filter(Boolean).join(' · '),
        }, s.repeaterCall || 'ja')
        : '–'),
      el('td', {}, e.note || ''),
      el('td', { class: 'mono' }, s.operator && s.station && s.operator !== s.station ? `${s.operator}/${s.station}` : s.operator || s.station || ''),
      el('td', { class: 'act' },
        el('button', { type: 'button', disabled: state.readOnly, onclick: () => startEdit(e.id) }, 'Bearb.'),
        ' ',
        el('button', { type: 'button', class: 'danger', disabled: state.readOnly, onclick: () => setDeleted(e.id, true) }, '✕'),
      ),
    ));
  }
}

async function renderTrash() {
  const list = $('#trash-list');
  const deleted = state.entries.filter(e => e.deleted);
  fill(list, 
    el('li', {}, el('b', {}, `Gelöschte Zeilen (${deleted.length})`)),
    deleted.map(e => el('li', {},
      `Nr. ${e.seq} ${e.call} ${fmtTime(e.ts)} – gelöscht ${fmtDateTime(e.deleted)} `,
      el('button', { type: 'button', class: 'link', disabled: state.readOnly, onclick: () => setDeleted(e.id, false) }, 'wiederherstellen'))),
  );
  const snaps = (await state.store.getByEvent('snapshots', state.event.id)).sort((a, b) => (a.at < b.at ? 1 : -1));
  fill($('#snapshot-list'), 
    el('li', {}, el('b', {}, `Automatische Sicherungen im Browser (${snaps.length})`)),
    snaps.map(s => el('li', {},
      `${fmtDateTime(s.at)} – ${s.count} Zeilen (${s.reason}) `,
      el('button', { type: 'button', class: 'link', onclick: () => download(JSON.stringify(s.backup, null, 1), fileBase(state.event, s.at) + '_sicherung.json', 'application/json') }, 'als JSON herunterladen'))),
  );
}

/* --- snapshots & backups --- */

async function eventBackup(ev) {
  const [entries, revisions] = await Promise.all([
    state.store.getByEvent('entries', ev.id),
    state.store.getByEvent('revisions', ev.id),
  ]);
  return { event: ev, entries, revisions };
}

async function takeSnapshot(reason) {
  const ev = state.event;
  if (!ev) return;
  try {
    const backup = { format: BACKUP_FORMAT, version: 1, exported: nowIso(), events: [await eventBackup(ev)] };
    const snaps = (await state.store.getByEvent('snapshots', ev.id)).sort((a, b) => (a.at < b.at ? 1 : -1));
    const ops = [{ store: 'snapshots', put: { id: newId(), eventId: ev.id, at: nowIso(), reason, count: stats(state.entries).total, backup } }];
    for (const old of snaps.slice(SNAPSHOT_KEEP - 1)) ops.push({ store: 'snapshots', del: old.id });
    await state.store.tx(ops);
    if (state.event && state.event.id === ev.id) renderTrash();
  } catch (e) {
    console.warn('Snapshot fehlgeschlagen', e);
  }
}

async function importBackup(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    alert('Datei ist kein gültiges JSON.');
    return;
  }
  if (data?.format !== BACKUP_FORMAT || !Array.isArray(data.events)) {
    alert('Keine Sicherung dieses Werkzeugs.');
    return;
  }
  const existing = new Set((await state.store.getAll('events')).map(e => e.id));
  let imported = 0;
  for (const item of data.events) {
    // Never overwrite: an event that already exists is imported as a copy
    // with fresh ids.
    const clash = existing.has(item.event.id);
    const evId = clash ? newId() : item.event.id;
    const idMap = new Map();
    const remap = id => {
      if (!clash) return id;
      if (!idMap.has(id)) idMap.set(id, newId());
      return idMap.get(id);
    };
    const ops = [{ store: 'events', put: { ...item.event, id: evId, title: clash ? `${item.event.title} (Import)` : item.event.title } }];
    for (const e of item.entries || []) ops.push({ store: 'entries', put: { ...e, id: remap(e.id), eventId: evId } });
    for (const r of item.revisions || []) ops.push({ store: 'revisions', put: { ...r, id: remap(r.id), entryId: remap(r.entryId), eventId: evId } });
    try {
      await state.store.tx(ops);
      imported++;
    } catch (e) {
      showSaveError(e);
      return;
    }
  }
  broadcast({ type: 'events' });
  alert(`${imported} Ereignis(se) importiert.`);
  renderEventList();
}

/* --- exports --- */

function fileBase(ev, iso) {
  const slug = ev.title.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss')
    .replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'log';
  return `${splitUtc(iso || ev.created).date}_${slug}`;
}

function download(text, name, type) {
  const blob = new Blob([text], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function showText(title, text) {
  $('#dlg-title').textContent = title;
  $('#dlg-text').value = text;
  $('#dlg-status').textContent = '';
  $('#dlg').showModal();
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = $('#dlg-text');
    ta.focus();
    ta.select();
    try { return document.execCommand('copy'); } catch { return false; }
  }
}

async function markExported() {
  const ev = { ...state.event, exportedTotal: stats(state.entries).total, lastExport: nowIso() };
  try {
    await state.store.tx([{ store: 'events', put: ev }]);
    state.event = ev;
  } catch (e) {
    console.warn(e);
  }
  updateExportNudge();
}

function updateExportNudge() {
  const since = stats(state.entries).total - (state.event.exportedTotal || 0);
  const chip = $('#export-nudge');
  chip.hidden = since < EXPORT_NUDGE_AFTER;
  chip.textContent = `${since} Zeilen seit letztem Export – jetzt sichern`;
}

async function doExport(kind) {
  await flushHeader();
  const ev = state.event;
  const entries = state.entries;
  if (kind === 'csv') {
    const sep = localStorage.getItem(CSV_SEP_KEY) || ';';
    download(toCSV(ev, entries, sep), fileBase(ev) + '.csv', 'text/csv');
    markExported();
  } else if (kind === 'adif') {
    download(toADIF(ev, entries), fileBase(ev) + '.adi', 'text/plain');
    markExported();
  } else if (kind === 'json') {
    const backup = { format: BACKUP_FORMAT, version: 1, exported: nowIso(), events: [await eventBackup(ev)] };
    download(JSON.stringify(backup, null, 1), fileBase(ev) + '_sicherung.json', 'application/json');
    markExported();
  } else if (kind === 'summary') {
    showText('Zusammenfassung', toSummary(ev, entries, timeMode()));
  } else if (kind === 'print') {
    window.print();
  }
}

async function backupAll() {
  const events = await state.store.getAll('events');
  const backup = { format: BACKUP_FORMAT, version: 1, exported: nowIso(), events: [] };
  for (const ev of events) backup.events.push(await eventBackup(ev));
  download(JSON.stringify(backup, null, 1), `${splitUtc(nowIso()).date}_bestaetigungsverkehr_alle.json`, 'application/json');
}

/* ---------------------------------------------------------------- cross-tab sync */

function broadcast(msg) {
  try { state.channel?.postMessage(msg); } catch { /* ignore */ }
}

function initChannel() {
  if (!('BroadcastChannel' in window)) return;
  state.channel = new BroadcastChannel('oe1ebg-confirm');
  state.channel.onmessage = async ev => {
    const m = ev.data || {};
    if (m.type === 'entries' && state.event && m.eventId === state.event.id && state.readOnly) {
      state.entries = await state.store.getByEvent('entries', state.event.id);
      state.event = (await state.store.get('events', state.event.id)) || state.event;
      renderLog();
      renderTrash();
    } else if (m.type === 'events' && !$('#view-events').hidden) {
      renderEventList();
    }
  };
}

/* ---------------------------------------------------------------- wiring */

function route() {
  const m = location.hash.match(/^#\/e\/([\w-]+)/);
  if (m) openEvent(m[1]);
  else showEvents();
}

function wire() {
  // events view
  document.querySelectorAll('#event-tabs button').forEach(b => b.addEventListener('click', () => {
    state.tab = b.dataset.tab;
    document.querySelectorAll('#event-tabs button').forEach(x => x.classList.toggle('active', x === b));
    renderEventList();
  }));
  $('#btn-new-event').addEventListener('click', () => openNewEventForm());
  $('#btn-cancel-new').addEventListener('click', () => { $('#new-event').hidden = true; });
  $('#new-event').addEventListener('submit', ev => {
    ev.preventDefault();
    const form = ev.target;
    createEvent(form.title.value, form.template.value, readHeaderForm($('#new-header')));
    form.hidden = true;
  });
  $('#btn-import').addEventListener('click', () => $('#import-file').click());
  $('#import-file').addEventListener('change', ev => {
    const f = ev.target.files[0];
    ev.target.value = '';
    if (f) importBackup(f);
  });
  $('#btn-backup-all').addEventListener('click', backupAll);

  // log view
  $('#btn-back').addEventListener('click', () => { location.hash = '#/'; });
  $('#log-title').addEventListener('input', ev => {
    if (state.readOnly) return;
    state.event.title = ev.target.value;
    clearTimeout(state.headerTimer);
    state.headerTimer = setTimeout(flushHeader, 400);
  });
  document.querySelectorAll('[data-export]').forEach(b => b.addEventListener('click', () => doExport(b.dataset.export)));

  const form = $('#entry-form');
  form.addEventListener('submit', ev => { ev.preventDefault(); saveEntry(); });
  form.addEventListener('input', onFormInput);
  // Enter saves from any control (radios/checkboxes don't submit natively).
  form.addEventListener('keydown', ev => {
    if (ev.key === 'Enter' && !ev.isComposing && ev.target.tagName === 'INPUT') {
      ev.preventDefault();
      saveEntry();
    } else if (ev.key === 'Escape' && !ev.defaultPrevented) {
      // (Open completion dropdowns handle Esc themselves and stop it here.)
      discardForm();
    }
  });
  $('#f-rpt').addEventListener('change', () => { $('#f-rpt').dataset.touched = '1'; });
  state.callPop = popover($('#f-call'), $('#call-suggest'));
  state.lineRpt = createLineRepeater({
    checkbox: $('#f-rpt'), input: $('#f-rpt-q'), sug: $('#f-rpt-sug'),
    getHeader: () => state.event?.header || emptyHeader(),
    onChange: scheduleDraft,
  });
  $('#btn-discard').addEventListener('click', discardForm);

  $('#dlg-copy').addEventListener('click', async () => {
    $('#dlg-status').textContent = (await copyText($('#dlg-text').value)) ? 'kopiert ✓' : 'Kopieren nicht möglich – Text markieren und manuell kopieren.';
  });

  // Last-chance flush when the page is hidden or closed.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { flushDraft(); flushHeader(); }
  });
  window.addEventListener('pagehide', () => { flushDraft(); flushHeader(); });

  setInterval(tickClock, 1000);
  window.addEventListener('hashchange', route);
}

async function loadCallbook() {
  const data = await loadDataFile('callsigns-oe.json');
  state.callbook = buildCallbook(data);
  fill($('#st-callbook'), state.callbook
    ? sourceItem('callsigns', `Stand ${fmtStand(state.callbook.stand)}, ${state.callbook.calls.length} OE-Rufzeichen`)
    : 'Rufzeichenliste nicht verfügbar');
  if (state.event) {
    updateCallFeedback();
    renderLog();
  }
}

async function loadRepeaterFooter() {
  const idx = await loadRepeaterIndex();
  fill($('#st-repeaters'), idx
    ? sourceItem('repeaters', `Stand ${fmtStand(idx.retrieved.slice(0, 10))}, ${idx.list.length} Sprach-Relais`)
    : 'Relaisliste nicht verfügbar');
}

async function main() {
  globalThis.CONFIRM_STARTED = true;
  initTheme();
  state.store = await openStorage();
  if (!state.store) {
    showFatal('Dieser Browser erlaubt keine lokale Speicherung (privater Modus?). Ohne Speicher kann nichts sicher geloggt werden.');
    return;
  }
  $('#st-backend').textContent = state.store.kind === 'indexeddb' ? 'IndexedDB' : 'localStorage (Ersatzspeicher)';
  if (state.store.kind !== 'indexeddb') {
    const b = $('#banner');
    b.className = 'banner warn';
    b.textContent = 'IndexedDB nicht verfügbar – Daten liegen im kleineren localStorage. Häufig exportieren.';
    b.hidden = false;
  }
  wire();
  initTimeMode();
  initLocationPanel();
  initChannel();
  initPersistence();
  initOffline();
  await refreshLastHeader();
  try {
    state.stations = new Map((await state.store.getAll('stations')).map(r => [r.call, r]));
  } catch (e) {
    console.warn('stations', e);
  }
  loadCallbook();
  loadRepeaterFooter();
  route();
}

main();
