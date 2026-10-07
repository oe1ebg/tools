// UI for the offline confirmation-traffic log (Bestätigungsverkehr).
// Persistence rules (see oe1ebg/tools/confirm/README.md): every saved line is
// written to storage before the UI reports it as saved; edits keep the old
// version in `revisions`; deletes are soft; the half-typed line is kept as a
// draft. Nothing here ever talks to the network.

import { openStorage } from './db.js';
import { requestPersistence } from '../../shared/js/storage.js';
import {
  normalizeCall, isPlausibleCall, newId, nowIso, splitUtc, splitTime, zoneLabel, parseTimeInput, isoUtc,
  MODES, modeInfo, headerSnapshot, emptyHeader, checkinNumbers, previousCheckins, adifModeText, SIGNALLING, signallingText,
  REPEATER_KEYS, parseMHz, LOC_ORIGINS, locOrigin, locHints,
  liveSorted, stats, isComment, COMMENT_CATEGORIES, newComment, headerChangeMarkers, headerFromRepeater,
} from './model.js';
import { TEMPLATES, templateFor, fieldVisible, fieldDisplay, fieldOptions, currentOptions, shortSummary, exampleValues } from './templates.js';
import { toCSV, toADIF, adifIssues, ADIF_MIME, toKML, KML_MIME, toSummary, adifFieldTargets } from './export.js';
import { loadDataFile } from '../../shared/js/data.js';
import { buildCallbook, lookupCall, suggestCalls } from '../../shared/js/callbook.js';
import { $, el, fill, popover, focusNext, submitForm, isComposing, trackExpanded } from '../../shared/js/dom.js';
import { prefGet, prefSet } from '../../shared/js/prefs.js';
import { initLocationPanel, loadLocationIndex, setUtmReference, logUtmDigits } from './locationui.js';
import { locate } from '../../shared/js/location/index.js';
import { isValidLocator, isLocatorPrefix, locatorPrecisionName, maidenheadToBounds } from '../../shared/js/maidenhead.js';
import { utmReference, UTM_DEFAULT_REF } from '../../shared/js/utm.js';
import { openMap, closeMap, refreshMap, mapVisible } from './mapview.js';
import { createLocationField, describeLocation, locationOptions } from './locfield.js';
import { attachRepeaterSearch, loadRepeaterIndex } from './repeaterui.js';
import { attachCallSearch } from './callsearch.js';
import { sourceItem, versionItems, trackOnline } from './sources.js';
import { createLineRepeater } from './linerepeater.js';
import { formatShift, formatMHz } from '../../shared/js/repeaters.js';

const TIME_MODE_KEY = 'oe1ebg-confirm-time-mode';
const CSV_SEP_KEY = 'oe1ebg-confirm-csv-sep';
const CSV_COMMENTS_KEY = 'oe1ebg-confirm-csv-comments';
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
  commentMode: false, // entry form holds an operator comment instead of a check-in
  markerBase: null,   // header as of the last automatic-marker check (headerChangeMarkers)
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

/* ---------------------------------------------------------------- time display (UTC / local) */

// Display and input only — entries always store an ISO 8601 UTC timestamp.
function timeMode() {
  // Local time by default: what local nets go by. UTC once chosen (remembered).
  return prefGet(TIME_MODE_KEY) === 'utc' ? 'utc' : 'local';
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
  document.querySelectorAll('#time-toggle button').forEach(b => {
    b.classList.toggle('active', b.dataset.timeMode === mode);
    b.setAttribute('aria-pressed', String(b.dataset.timeMode === mode));
  });
  $('#time-label').textContent = mode === 'local' ? `Zeit lokal (${zoneLabel(nowIso(), 'local')})` : 'Zeit UTC';
  $('#f-time').title = `Leer lassen = Zeitpunkt des Speicherns. Korrektur: HH:MM oder JJJJ-MM-TT HH:MM (${mode === 'local' ? 'Lokalzeit' : 'UTC'}). Gespeichert wird immer ein ISO-Zeitstempel.`;
  $('#time-help').textContent = $('#f-time').title;
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
    prefSet(TIME_MODE_KEY, b.dataset.timeMode);
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

// Footer version from build-info.js (or inlined in the offline file); the
// active service worker's content hash overrides the data part, since that
// is the version actually served from the cache.
function showVersion(swVersion) {
  fill($('#st-version'), versionItems(globalThis.CONFIRM_BUILD, swVersion));
}

async function initOffline() {
  showVersion();
  if (location.protocol === 'file:') {
    setChip('#st-offline', 'Offline-Datei', 'ok');
    $('#offline-file-link').hidden = true;
    $('#offline-card').hidden = true;
    $('#data-sources-link').hidden = true;
    $('#home-link').hidden = true; // ../ is the folder the file sits in
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
    showVersion(v);
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

// `route` fields show only for that route (direct / via repeater; the
// other route's values are kept), `modes` fields only for those modes
// (signalling, see SIGNALLING in js/model.js). `bool` is a two-option
// radio group for a boolean header value: [falseValue, trueValue].
const ROUTES = [['direct', 'direkt (Simplex)'], ['rpt', 'über Relais']];
const HEADER_FIELDS = [
  { sub: 'Station' },
  { key: 'operator', label: 'Operator', call: true, size: 9 },
  { key: 'station', label: 'Station (für)', call: true, size: 9 },
  { key: 'myQth', label: 'Eigener QTH', qth: true, size: 18 },
  { key: 'myGrid', label: 'Eigener Locator', grid: true, size: 12 },
  { sub: 'Betriebsart' },
  { key: 'mode', label: 'Betriebsart', radio: MODES.map(m => [m.key, m.label]), adif: true },
  { sub: 'Verbindung', note: 'Standard für neue Zeilen, pro Zeile umschaltbar' },
  { key: 'viaRepeater', label: 'Weg', radio: ROUTES, bool: ['direct', 'rpt'] },
  { key: 'freq', label: 'Frequenz MHz', size: 9, inputmode: 'decimal', route: 'direct' },
  { key: 'repeaterCall', label: 'Relais (Rufzeichen, Ort, Frequenz)', call: true, repeater: true, size: 11, route: 'rpt' },
  { key: 'repeaterFreq', label: 'Ausgabe MHz', size: 9, inputmode: 'decimal', route: 'rpt' },
  { key: 'repeaterShift', label: 'Shift MHz', size: 6, inputmode: 'decimal', route: 'rpt', txHint: true },
  ...Object.entries(SIGNALLING).flatMap(([mode, list]) => list.map(([key, label, placeholder]) => ({
    key, label, placeholder, size: 6, modes: [mode],
  }))),
];

// The header form (log view and "Neues Log") works like the entry form:
// info lines in fixed-height slots under the fields, completion dropdowns
// (QTH: offline location lookup, Relais: ÖVSV list), Betriebsart as chips.
// onChange(header) is called only when a value actually changed.
function buildHeaderForm(container, header, onChange) {
  fill(container);
  const id = k => `${container.id}-${k}`;
  const hints = {};
  let rptSearch = null;
  let qthField = null;
  let qthTouched = false;
  let last = null; // set after building: opening a log never counts as a change
  const emit = () => {
    renderHeaderHints(container);
    const h = readHeaderForm(container);
    const sig = JSON.stringify(h);
    if (sig === last) return;
    last = sig;
    onChange(h);
  };

  // Visibility by route/mode is set in renderHeaderHints().
  const place = (f, node) => {
    if (f.route) node.dataset.route = f.route;
    if (f.modes) node.dataset.modes = f.modes.join(' ');
    container.append(node);
  };
  for (const f of HEADER_FIELDS) {
    if (f.sub) {
      container.append(el('div', { class: 'sub' }, f.sub, f.note ? el('span', { class: 'sub-note' }, ` · ${f.note}`) : null));
      continue;
    }
    if (f.radio) {
      const name = id(f.key);
      const cur = f.bool ? f.bool[header[f.key] ? 1 : 0] : header[f.key];
      // A stored mode that is no longer in the list stays selectable.
      const opts = cur && !f.radio.some(o => o[0] === cur) ? [...f.radio, [cur, cur]] : f.radio;
      const group = el('div', { class: 'radio-group', role: 'radiogroup', 'aria-label': f.label },
        opts.map(([v, l]) => {
          const r = el('input', { type: 'radio', name, value: v, 'data-hkey': f.key, checked: cur === v });
          r.addEventListener('change', emit);
          r.addEventListener('keydown', ev => radioKey(ev, [...group.querySelectorAll('input')], emit, false));
          const m = f.adif ? adifModeText(v) : '';
          return el('label', { 'data-value': v, title: m || null }, r, el('span', {}, l));
        }));
      // The mode has its own section heading: no second label (aria-label on the group).
      place(f, el('div', { class: f.adif ? 'field wide' : 'field' }, f.adif ? null : el('span', {}, f.label), group));
      continue;
    }
    const input = el('input', {
      id: id(f.key), 'data-hkey': f.key, value: header[f.key] || '', size: f.size, inputmode: f.inputmode,
      spellcheck: 'false', autocomplete: 'off', class: f.call ? 'call-input' : f.grid ? 'grid-input' : null, placeholder: f.placeholder,
      autocapitalize: f.call || f.grid ? 'characters' : null, autocorrect: f.call || f.grid ? 'off' : null,
      enterkeyhint: 'next',
    });
    input.addEventListener('input', emit);
    const hasPop = f.qth || f.repeater || f.call;
    const hasHint = hasPop || f.call || f.grid || f.txHint;
    const pop = hasPop ? el('div', { class: 'ac-pop' }) : null;
    const info = hasHint ? el('div', { class: 'ac-info', 'aria-live': 'polite' }) : null;
    if (info) hints[f.key] = info;
    if (info) {
      info.id = `${id(f.key)}-info`;
      input.setAttribute('aria-describedby', info.id);
    }
    place(f, el('div', { class: f.txHint ? 'field ac-field tx-hint' : 'field ac-field' },
      el('label', { for: input.id }, f.label),
      hasPop ? el('div', { class: 'ac-wrap' }, input, pop) : input,
      info ? el('div', { class: 'ac-hints' }, info) : null));
    if (f.repeater) {
      rptSearch = attachRepeaterSearch({
        input, pop, info,
        getHeader: () => readHeaderForm(container),
        onPick: r => {
          writeHeaderForm(container, headerFromRepeater(r, readHeaderForm(container)));
          emit();
          // A pick is a finished edit, like leaving the field (log marker).
          input.dispatchEvent(new Event('change', { bubbles: true }));
        },
      });
    }
    if (f.call) {
      attachCallSearch({
        input, pop,
        getBook: () => state.callbook,
        recent: () => cachedHeaderCalls,
        onPick: () => {
          emit();
          // A pick is a finished edit, like leaving the field (log marker).
          input.dispatchEvent(new Event('change', { bubbles: true }));
        },
      });
    }
    if (f.qth) {
      input.addEventListener('input', () => { qthTouched = true; });
      qthField = createLocationField({
        input, results: pop, chip: info,
        // A resolved QTH fills an empty (or earlier auto-filled) locator —
        // only after editing the QTH, never just by opening a log.
        onChange: () => {
          if (qthTouched) fillGridFromQth(container, qthField.get());
          emit();
        },
      });
    }
  }
  container._hdr = { hints, rptSearch, qthField };
  last = JSON.stringify(readHeaderForm(container));
  renderHeaderHints(container);
  rptSearch?.refresh();
  if (header.myQth) qthField?.refresh();
}

// Locator from the resolved own QTH: subsquare, or only the square for
// areas (PLZ, Bezirk) that span several subsquares.
function fillGridFromQth(container, loc) {
  const grid = container.querySelector('[data-hkey="myGrid"]');
  if (!(grid.value === '' || grid.dataset.autofill === grid.value)) return;
  const v = loc ? (loc.areaLocators?.length > 1 ? loc.maidenhead.slice(0, 4) : loc.maidenhead) : '';
  grid.value = v;
  grid.dataset.autofill = v;
}

// Info lines under the header's callsign and locator fields (QTH and
// Relais keep their own, from the location field and repeater search),
// the ADIF mapping of the mode, the repeater input frequency, and which
// fields the chosen route and mode show.
// The last action ("gespeichert", "gelöscht", …) in the status line above
// the log: always the same place, outside the form (nothing in the form
// moves), read out without moving focus; stays until the next action.
// Form errors and the "Bearbeite …" note stay in #form-status.
function logStatus(...content) {
  fill($('#log-status'), el('span', { class: 'ok-mark', 'aria-hidden': 'true' }, '✓'), ...content);
}

// Mark a log row for a moment (just saved or restored).
function flashRow(id) {
  const tr = $('#log-body')?.querySelector(`tr[data-id="${id}"]`);
  if (!tr) return;
  tr.classList.add('fresh');
  setTimeout(() => tr.classList.remove('fresh'), 2500);
}

// "Speichern ⇧⏎": the glyphs are for the eye, aria-keyshortcuts says it.
function setSaveLabel(text) {
  fill($('#btn-save'), text, ' ', el('span', { 'aria-hidden': 'true' }, '⇧⏎'));
}

// Column header cell.
function th(text) {
  return el('th', { scope: 'col' }, text);
}

// aria-live lines are read out on every write: only write real changes.
function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

function renderHeaderHints(container) {
  const hints = container._hdr?.hints;
  if (!hints) return;
  const h = readHeaderForm(container);
  const route = h.viaRepeater ? 'rpt' : 'direct';
  container.querySelectorAll('[data-route]').forEach(n => { n.hidden = n.dataset.route !== route; });
  container.querySelectorAll('[data-modes]').forEach(n => { n.hidden = !n.dataset.modes.split(' ').includes(h.mode); });
  const out = parseMHz(h.repeaterFreq), shift = parseMHz(h.repeaterShift);
  setText(hints.repeaterShift, out !== null && shift !== null ? `Eingabe ${formatMHz(Math.round((out + shift) * 1e6) / 1e6)} MHz` : '');
  for (const key of ['operator', 'station']) {
    const call = normalizeCall(container.querySelector(`[data-hkey="${key}"]`).value);
    const line = callbookLine(call);
    const info = hints[key];
    if (call && !isPlausibleCall(call)) {
      info.className = 'ac-info warn';
      setText(info, 'Ungewöhnliches Rufzeichen');
    } else {
      info.className = `ac-info ${line.cls}`.trim();
      setText(info, line.text);
    }
    info.title = line.title || info.textContent;
  }
  const grid = container.querySelector('[data-hkey="myGrid"]');
  const g = grid.value.trim();
  const info = hints.myGrid;
  info.className = 'ac-info';
  if (!g) {
    setText(info, '');
  } else if (isValidLocator(g)) {
    info.classList.add('known');
    setText(info, `✓ ${locatorPrecisionName(g.length)}${grid.dataset.autofill === grid.value ? ' (aus QTH)' : ''}`);
  } else {
    info.classList.add('warn');
    setText(info, isLocatorPrefix(g) ? 'unvollständig (z. B. JN88ee)' : 'kein gültiger Locator (z. B. JN88ee)');
  }
  info.title = info.textContent;
}

function writeHeaderForm(container, h) {
  for (const f of HEADER_FIELDS) {
    if (f.sub) continue;
    if (f.radio) {
      const v = f.bool ? f.bool[h[f.key] ? 1 : 0] : h[f.key];
      container.querySelectorAll(`[data-hkey="${f.key}"]`).forEach(r => { r.checked = r.value === v; });
      continue;
    }
    const input = container.querySelector(`[data-hkey="${f.key}"]`);
    if (input) input.value = h[f.key] ?? '';
  }
  container._hdr?.rptSearch?.refresh();
}

function readHeaderForm(container) {
  const h = emptyHeader();
  for (const f of HEADER_FIELDS) {
    if (f.sub) continue;
    if (f.radio) {
      const c = container.querySelector(`[data-hkey="${f.key}"]:checked`);
      if (c) h[f.key] = f.bool ? c.value === f.bool[1] : c.value;
      continue;
    }
    const input = container.querySelector(`[data-hkey="${f.key}"]`);
    if (!input) continue;
    h[f.key] = f.call ? normalizeCall(input.value) : input.value.trim();
  }
  return h;
}

// Enter moves to the next field (as in the entry form); `last` is called
// when Enter is pressed in the last field.
function headerKeys(container, last) {
  container.addEventListener('keydown', ev => {
    if (ev.key !== 'Enter' || ev.shiftKey || isComposing(ev) || ev.target.tagName !== 'INPUT') return;
    ev.preventDefault();
    if (!focusNext(container, ev.target)) last?.();
  });
}

function headerSummary(h) {
  const parts = [];
  if (h.operator) parts.push(`Op ${h.operator}`);
  if (h.station && h.station !== h.operator) parts.push(`für ${h.station}`);
  const sig = signallingText(h);
  if (h.viaRepeater) {
    const shift = h.repeaterShift !== '' && h.repeaterShift !== undefined ? formatShift(parseMHz(h.repeaterShift)) : '';
    parts.push(`${modeInfo(h.mode)?.label || ''} via ${h.repeaterCall || 'Relais'}${h.repeaterFreq ? ' ' + h.repeaterFreq : ''}`
      + `${shift ? ' ' + shift : ''}${sig ? ', ' + sig : ''}`);
  } else {
    const f = [h.freq && `${h.freq} MHz`, modeInfo(h.mode)?.label, 'direkt'].filter(Boolean).join(' ');
    parts.push(`${f}${sig ? ', ' + sig : ''}`);
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
      state.tab === 'active' ? 'Noch keine Logs. „+ Neues Log“ legt eines an.' : 'Leer.'));
    return;
  }
  for (const ev of visible) {
    const st = stats(counts.get(ev.id) || []);
    const actions = [];
    if (!ev.deleted) {
      actions.push(el('button', { type: 'button', class: 'primary', 'aria-label': `„${ev.title}“ öffnen`, onclick: () => { location.hash = `#/e/${ev.id}`; } }, 'Öffnen'));
      actions.push(el('button', { type: 'button', onclick: () => duplicateEvent(ev) }, 'Duplizieren'));
      actions.push(el('button', { type: 'button', onclick: () => updateEvent(ev, { archived: !ev.archived }) }, ev.archived ? 'Reaktivieren' : 'Archivieren'));
      actions.push(el('button', { type: 'button', class: 'danger', onclick: () => {
        if (confirm(`„${ev.title}“ in den Papierkorb verschieben? (Kann wiederhergestellt werden.)`)) updateEvent(ev, { deleted: nowIso() });
      } }, 'Löschen'));
    } else {
      actions.push(el('button', { type: 'button', onclick: () => updateEvent(ev, { deleted: null }) }, 'Wiederherstellen'));
    }
    // A click anywhere on the card opens the log (buttons keep their own
    // action). Keyboard and screen readers use the "Öffnen" button: a
    // focusable card around buttons would nest interactive controls.
    const openLog = () => { location.hash = `#/e/${ev.id}`; };
    const clickable = !ev.deleted;
    list.append(el('li', {
      class: clickable ? 'event-card clickable' : 'event-card',
      title: clickable ? 'Log öffnen' : null,
      onclick: clickable ? e => { if (!e.target.closest('button')) openLog(); } : null,
    },
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
  sel.onchange = () => renderTemplatePreview(sel.value);
  renderTemplatePreview(sel.value);
  const header = prefill?.header || lastHeader() || emptyHeader();
  buildHeaderForm($('#new-header'), header, () => {});
  form.title.focus();
}

// What the chosen template changes: a sample log line with the log's
// columns (the template's own ones highlighted) and their ADIF fields.
function renderTemplatePreview(key) {
  const tpl = templateFor(key);
  const values = exampleValues(tpl);
  const fields = tpl.fields.filter(f => fieldVisible(f, values, tpl));
  // The <summary> is static in index.html (a <details> without one is invalid).
  fill($('#new-template-sample'),
    el('div', { class: 'scroll' }, el('table', {},
      el('tr', {}, ['Zeit UTC', 'Nr', 'Rufzeichen Gegenstation'].map(t => el('th', {}, t)),
        fields.map(f => el('th', { class: 'tpl' }, f.label)), ['Relais', 'Notiz'].map(t => el('th', {}, t))),
      el('tr', {}, ['18:42Z', '1', 'OE1ABC'].map(t => el('td', {}, t)),
        fields.map(f => el('td', { class: 'tpl' }, fieldDisplay(f, values[f.key]))), ['OE1XUU', ''].map(t => el('td', {}, t))))),
    el('div', { class: 'adif' }, 'ADIF: ', adifFieldTargets(tpl).map(([l, t]) => `${l} → ${t}`).join(' · ')));
}

// Pre-fill a new event with the header of the most recently created one —
// usually the same operator/station/repeater.
let cachedLastHeader = null;
// Operator/Station callsigns of earlier logs, newest first: [{ call, title }]
// (offered first by the header's callsign search).
let cachedHeaderCalls = [];
function lastHeader() {
  return cachedLastHeader ? { ...cachedLastHeader } : null;
}

async function refreshLastHeader() {
  const events = (await state.store.getAll('events')).filter(e => !e.deleted);
  events.sort((a, b) => (a.created < b.created ? 1 : -1));
  cachedLastHeader = events[0]?.header || null;
  const seen = new Set();
  cachedHeaderCalls = [];
  for (const ev of events) {
    for (const key of ['operator', 'station']) {
      const call = normalizeCall(ev.header?.[key]);
      if (call && !seen.has(call)) { seen.add(call); cachedHeaderCalls.push({ call, title: ev.title }); }
    }
  }
}

async function createEvent(title, template, header) {
  const ev = {
    id: newId(), title: title.trim() || 'Log', template, header,
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
  $('#export-msg').hidden = true;
  $('#log-status').replaceChildren(); // messages belong to the log they were about
  const ev = await state.store.get('events', id);
  if (!ev) {
    location.hash = '#/';
    return;
  }
  state.event = ev;
  state.entries = await state.store.getByEvent('entries', id);
  state.editingId = null;
  state.markerBase = { ...(ev.header || emptyHeader()) };
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
  focusEntryStart();
}

// First field of the entry form: the callsign, or the comment text.
function focusEntryStart() {
  const input = state.commentMode ? $('#f-ctext') : $('#f-call');
  input.focus();
  if (state.commentMode) input.setSelectionRange(input.value.length, input.value.length);
}

async function leaveEvent() {
  if (!state.event) return;
  closeMap();
  $('#btn-map').classList.remove('active');
  $('#btn-map').setAttribute('aria-pressed', 'false');
  await flushMarkers({ openForEdit: false });
  await flushDraft();
  await flushHeader();
  if (!state.readOnly && state.entries.some(e => !e.deleted)) await takeSnapshot('beim Verlassen');
  if (state.releaseLock) state.releaseLock();
  state.releaseLock = null;
  state.event = null;
  state.entries = [];
  state.editingId = null;
}

/* --- single-writer lock across tabs (Web Locks API) --- */

function acquireLock(steal) {
  const ev = state.event;
  // Without Web Locks (plain http:// on a LAN, Safari < 15.4) two tabs
  // could both write: the #st-tabs chip says so (main()).
  if (!navigator.locks) { setReadOnly(false); return Promise.resolve(); }
  return new Promise(resolve => {
    navigator.locks.request(`oe1ebg-confirm-event-${ev.id}`, steal ? { steal: true } : { ifAvailable: true }, lock => {
      if (!lock) {
        setReadOnly(true, 'Dieses Log ist in einem anderen Tab/Fenster geöffnet – hier nur Ansicht, damit nichts überschrieben wird.');
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
  maybeRefreshMap(); // own position follows "Eigener QTH" / "Eigener Locator"
  clearTimeout(state.headerTimer);
  state.headerTimer = setTimeout(flushHeader, 400);
}

// Automatic log markers (decision on issue #32, option c): every finished
// change of operator or repeater in the header writes an operator comment
// at that moment ("Schichtwechsel / Übergabe" / "Frequenzwechsel"). Runs on
// the header's `change` event (field left, Enter, checkbox, repeater pick),
// before a line is saved and when the log is left; headerChangeMarkers()
// in js/model.js decides. With an empty entry form the new marker is
// opened for editing, so the operator can add text (Enter from the header
// lands in it; Shift+Enter saves, Esc keeps it as it is).
async function flushMarkers({ openForEdit = true } = {}) {
  const ev = state.event;
  if (!ev || state.readOnly || !state.markerBase) return;
  const prevBase = state.markerBase;
  const { markers, base } = headerChangeMarkers(prevBase, ev.header || emptyHeader(), state.entries.some(e => !e.deleted));
  state.markerBase = base;
  if (!markers.length) return;
  const ts = nowIso();
  const made = markers.map(m => newComment({ eventId: ev.id, ts, text: m.text, category: m.category, header: ev.header, auto: m.auto }));
  try {
    await state.store.tx(made.map(c => ({ store: 'entries', put: c })));
  } catch (e) {
    if (state.markerBase === base) state.markerBase = prevBase; // retried on the next change
    showSaveError(e);
    return;
  }
  if (state.event?.id !== ev.id) return;
  state.entries.push(...made);
  renderLog();
  broadcast({ type: 'entries', eventId: ev.id });
  const what = made.map(c => `${c.category}: ${c.text}`).join(' · ');
  const status = $('#form-status');
  status.className = 'ok';
  // Open it for editing only while the operator is still in the header
  // (focus stays there): never switch the form under someone who already
  // moved on to the entry form to log a station.
  const inHeader = $('#log-header').contains(document.activeElement) || document.activeElement === document.body;
  if (openForEdit && inHeader && !state.editingId && !state.commentMode && formIsEmpty(readForm())) {
    startEdit(made[made.length - 1].id, { focus: false, scroll: false });
    fill(status, el('span', { class: 'edit-tag' }, `✓ Marker gespeichert (${fmtTime(ts, false)}) – ${what}. Text ergänzen, Shift+Enter; Esc lässt ihn so.`));
  } else {
    logStatus(`Marker gespeichert (${fmtTime(ts, false)}) – ${what} `,
      el('button', { type: 'button', class: 'link', onclick: () => startEdit(made[made.length - 1].id) }, 'Text ergänzen'));
    flashRow(made[made.length - 1].id);
  }
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
      const hintId = f.hint ? `f_${f.key}-hint` : null;
      control = el('div', { class: f.grade ? 'radio-group grade' : 'radio-group', role: 'radiogroup', 'aria-label': f.label, title: f.hint,
        'aria-describedby': hintId },
        hintId ? el('span', { id: hintId, class: 'sr-only' }, f.hint) : null,
        fieldOptions(f).map(([v, l]) => {
          const r = el('input', { type: 'radio', name: `f_${f.key}`, value: v });
          // Clicking the selected option again clears it (radios can't otherwise be unset).
          r.addEventListener('click', () => {
            if (r.dataset.was === '1') { r.checked = false; r.dataset.was = ''; }
            else box.querySelectorAll(`input[name="f_${f.key}"]`).forEach(o => { o.dataset.was = o === r ? '1' : ''; });
            onFormInput();
          });
          r.addEventListener('keydown', ev => radioKey(ev,
            [...box.querySelectorAll(`input[name="f_${f.key}"]`)].filter(x => !x.closest('label').hidden), onFormInput));
          return el('label', { 'data-value': v }, r, el('span', {}, l));
        }));
    } else {
      control = el('input', {
        name: `f_${f.key}`, size: f.type === 'rst' ? 3 : f.size || 12,
        inputmode: f.type === 'rst' ? 'numeric' : f.inputmode, spellcheck: 'false',
        class: f.type === 'location' ? 'loc-input' : null, autocomplete: 'off', enterkeyhint: 'next',
      });
    }
    // Radio groups get a <div>, not a <label>: nested labels would make a
    // click on the caption select the first option.
    if (f.type === 'location') {
      // Completion dropdown right under the input; the status line below it
      // has a fixed height, so nothing in the form moves when it changes.
      control.id = `f_${f.key}`;
      box.append(el('div', { class: 'field ac-field', 'data-field': f.key },
        el('label', { for: control.id }, f.label),
        el('div', { class: 'ac-wrap' }, control, el('div', { class: 'ac-pop loc-pop' })),
        el('div', { class: 'ac-hints' }, el('div', { class: 'ac-info loc-chip', id: `${control.id}-info`, 'aria-live': 'polite' }))));
      control.setAttribute('aria-describedby', `${control.id}-info`);
      continue;
    }
    box.append(el(f.type === 'radio' ? 'div' : 'label', { class: 'field', 'data-field': f.key }, el('span', {}, f.label), control,
      el('span', { class: 'ac-hints', 'aria-hidden': 'true' })));
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

// Keyboard on a radio group (its visible radios): digits pick the n-th
// option (grades 1-5 map directly), Backspace/Delete clears the group
// (unless clearable is false).
function radioKey(ev, radios, after, clearable = true) {
  let pick;
  if (/^[1-9]$/.test(ev.key) && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
    pick = radios[Number(ev.key) - 1];
    if (!pick) return;
  } else if (!clearable || (ev.key !== 'Backspace' && ev.key !== 'Delete')) {
    return;
  }
  ev.preventDefault();
  for (const r of radios) {
    r.checked = r === pick;
    r.dataset.was = r.checked ? '1' : '';
  }
  (pick || ev.target).focus();
  after();
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
  const cat = document.querySelector('#c-cat input:checked');
  return {
    kind: state.commentMode ? 'comment' : 'checkin',
    text: state.commentMode ? $('#f-ctext').value.trim() : '',
    category: state.commentMode && cat ? cat.value : '',
    call: normalizeCall($('#f-call').value),
    fields: readFields(),
    viaRepeater: $('#f-rpt').checked,
    rptOverride: state.lineRpt ? state.lineRpt.get() : null,
    note: $('#f-note').value.trim(),
    time: $('#f-time').value.trim(),
    loc: state.locField ? state.locField.get() : null,
  };
}

// Operator comment mode of the entry form: typing "!" in the empty
// callsign field switches to it (the rest of the typed text becomes the
// comment); the check-in fields are hidden (CSS .ci-only / .c-only), the
// comment text and a category chip group (digits 1–5) are shown. Backspace
// in the empty comment text or Esc goes back.
function setCommentMode(on) {
  state.commentMode = on;
  $('#entry-form').classList.toggle('comment-mode', on);
  if (!on) {
    $('#f-ctext').value = '';
    writeCategory('');
  }
  if (!state.editingId) setSaveLabel(on ? 'Kommentar speichern' : 'Speichern');
}

function writeCategory(v) {
  document.querySelectorAll('#c-cat input').forEach(r => {
    r.checked = r.value === v;
    r.dataset.was = r.checked ? '1' : '';
  });
}

function buildCategoryChips() {
  const box = $('#c-cat');
  fill(box, COMMENT_CATEGORIES.map((c, i) => {
    const r = el('input', { type: 'radio', name: 'c_cat', value: c });
    r.addEventListener('click', () => {
      if (r.dataset.was === '1') { r.checked = false; r.dataset.was = ''; }
      else box.querySelectorAll('input').forEach(o => { o.dataset.was = o === r ? '1' : ''; });
      onFormInput();
    });
    r.addEventListener('keydown', ev => radioKey(ev, [...box.querySelectorAll('input')], onFormInput));
    return el('label', { 'data-value': c }, r, el('span', {}, `${i + 1} ${c}`));
  }));
}

// "!" typed into the empty callsign field: switch to comment mode.
function onCallInput() {
  const input = $('#f-call');
  if (!input.value.startsWith('!') || state.editingId || state.commentMode) return;
  const rest = input.value.slice(1);
  const f = readForm();
  if (f.note || Object.values(f.fields).some(v => v) || f.loc || f.rptOverride) {
    input.value = rest;
    $('#call-warn').textContent = 'Für einen Kommentar erst diese Zeile speichern oder verwerfen (Esc).';
    return;
  }
  input.value = '';
  setCommentMode(true);
  $('#f-ctext').value = rest.replace(/^\s+/, '');
  focusEntryStart();
}

function clearForm() {
  setCommentMode(false);
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
  setSaveLabel('Speichern');
  if ($('#form-status .edit-tag')) $('#form-status').replaceChildren();
  updateRepeaterDefault();
  updateCallFeedback();
}

function formIsEmpty(f) {
  return !f.call && !f.note && !f.time && !f.text && !f.category && Object.values(f.fields).every(v => !v);
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
  updateLocationOptions(call);
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

// The callsign list's line for a call: { cls, text, title }.
function callbookLine(call) {
  const book = state.callbook;
  if (!book || !call) return { cls: '', text: '' };
  const { entry, base, isOE } = lookupCall(book, call);
  if (entry) {
    return {
      cls: 'known',
      text: entry[1] || entry[2]
        ? `${entry[0]} · ${[entry[1], entry[2]].filter(Boolean).join(' · ')}`
        : `${entry[0]} · in der Rufzeichenliste (Angaben nicht veröffentlicht)`,
    };
  }
  if (isOE && base.length >= 4) {
    return {
      cls: 'unknown',
      text: `nicht in Rufzeichenliste (${fmtStand(book.stand)}) – Tippfehler?`,
      title: `${base} ist nicht in der Rufzeichenliste (Stand ${fmtStand(book.stand)}) – Tippfehler? Speichern ist trotzdem möglich.`,
    };
  }
  return { cls: '', text: '' };
}

// Name/location from the callsign list under the call field, typo
// suggestions, and auto-fill of empty Name/QTH template fields.
function renderCallbookInfo(call) {
  const info = $('#call-info');
  const sug = $('#call-suggest');
  info.className = 'ac-info';
  info.title = '';
  sug.replaceChildren();
  state.callPop?.update();
  const book = state.callbook;
  if (!book || !call) {
    info.textContent = '';
    autofillFromCallbook(null);
    return;
  }
  const { entry } = lookupCall(book, call);
  const line = callbookLine(call);
  info.className = `ac-info ${line.cls}`.trim();
  info.textContent = line.text;
  info.title = line.title || line.text;
  autofillFromCallbook(entry);
  if (!entry && !state.readOnly) {
    const list = suggestCalls(book, call, 8);
    if (list.length) {
      fill(sug, el('div', { class: 'ac-head' }, 'Meinten Sie (↓, Enter):'),
        list.map(c => el('button', { type: 'button', class: 'ac-item', onclick: () => {
          $('#f-call').value = c[0];
          onFormInput();
          prefillLocation();
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
    // address — offered in its dropdown instead (updateLocationOptions).
    if (!input || input.classList.contains('loc-input')) continue;
    if (input.value === '' || input.dataset.autofill === input.value) {
      input.value = value || '';
      input.dataset.autofill = value || '';
    }
  }
}

// Location suggestions for this station in the location field's dropdown:
// its last known location (from any earlier event) and the callsign-list city.
function updateLocationOptions(call) {
  const lf = state.locField;
  if (!lf) return; // template without a location field
  const rec = call && !state.readOnly ? state.stations.get(call) : null;
  const listed = call && !state.readOnly && state.callbook && lookupCall(state.callbook, call).entry;
  lf.setOptions(locationOptions(rec, listed ? listed[2] : ''));
}

// When the callsign field is left: put the station's last location into an
// empty location field (marked as a suggestion; typing replaces it). Not
// while typing the call, and never on save, so nothing unseen is logged.
function prefillLocation() {
  const lf = state.locField;
  if (!lf || state.readOnly || state.editingId) return;
  const rec = state.stations.get(normalizeCall($('#f-call').value));
  if (rec?.loc) lf.prefill(rec.loc, rec.at);
  else lf.clearPrefill();
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

// The time field's prefill when editing a line (seconds precision).
function editTimeText(iso) {
  const { date, time } = splitTime(iso, timeMode());
  return `${date} ${time}`;
}

// Time for a saved line: an unchanged edit prefill keeps the exact stored
// timestamp (re-parsing it would drop the milliseconds and could reorder
// lines logged within the same second).
function lineTime(text, editing) {
  if (editing && text === editTimeText(editing.ts)) return { iso: editing.ts };
  return resolveTime(text, editing ? editing.ts : nowIso());
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
    for (const k of REPEATER_KEYS) snap[k] = h[k];
  }
  delete snap.repeaterOverride;
  return snap;
}

function overrideOf(snap) {
  if (!snap?.repeaterOverride) return null;
  return Object.fromEntries(REPEATER_KEYS.map(k => [k, snap[k] ?? '']));
}

/* --- map view --- */

function mapContext() {
  const tpl = templateFor(state.event.template);
  return {
    event: state.event,
    header: state.event.header || {},
    entries: state.entries,
    describe: e => [`Nr. ${e.seq}`, fmtTime(e.ts, false), shortSummary(tpl, e.fields)].filter(Boolean).join(' · '),
    callInfo: call => callbookName(call),
    // The own QTH counts only if it resolves confidently.
    resolve: async text => {
      const idx = await loadLocationIndex();
      return idx ? locate(idx, text, { autoSelect: 'high' }).autoSelect : null;
    },
    // Tap/click on a pin: highlight that station's rows in the table.
    onPick: call => {
      renderLog(call);
      document.querySelector('#log-body tr.match')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    },
  };
}

async function toggleMap() {
  const btn = $('#btn-map');
  if (mapVisible()) {
    closeMap();
    btn.classList.remove('active');
    btn.setAttribute('aria-pressed', 'false');
  } else {
    btn.classList.add('active');
    btn.setAttribute('aria-pressed', 'true');
    // openMap draws the current state; don't redraw (and close a just-opened
    // popup) on the next renderLog().
    mapSig = currentMapSig();
    await openMap(mapContext());
  }
}

// Short label of a line for status messages and the recycle bin.
function lineLabel(e) {
  if (!isComment(e)) return `Nr. ${e.seq} ${e.call}`;
  const t = e.text && e.text.length > 40 ? e.text.slice(0, 39) + '…' : e.text;
  return `Kommentar${e.category ? ` [${e.category}]` : ''}${t ? ` „${t}“` : ''}`;
}

async function saveComment(f) {
  const status = $('#form-status');
  if (!f.text && !f.category) {
    status.className = 'err';
    status.textContent = 'Kommentartext fehlt.';
    focusEntryStart();
    return;
  }
  const ev = state.event;
  const editing = state.editingId ? state.entries.find(e => e.id === state.editingId) : null;
  const t = lineTime(f.time, editing);
  if (t.error) {
    status.className = 'err';
    status.textContent = `Zeit nicht lesbar – HH:MM oder JJJJ-MM-TT HH:MM (${timeMode() === 'local' ? 'Lokalzeit' : 'UTC'}), oder leer lassen.`;
    $('#f-time').focus();
    return;
  }
  const ops = [];
  let entry;
  if (editing) {
    // The header snapshot stays the one from when the comment was made.
    entry = { ...editing, text: f.text, category: f.category, ts: t.iso, updated: nowIso() };
    ops.push({ store: 'revisions', put: { id: newId(), eventId: ev.id, entryId: editing.id, savedAt: nowIso(), reason: 'edit', data: editing } });
  } else {
    entry = newComment({ eventId: ev.id, ts: t.iso, text: f.text, category: f.category, header: ev.header });
  }
  ops.push({ store: 'entries', put: entry });
  ops.push({ store: 'drafts', del: ev.id });
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
  const i = state.entries.findIndex(e => e.id === entry.id);
  if (i >= 0) state.entries[i] = entry; else state.entries.push(entry);
  status.replaceChildren();
  logStatus(`${lineLabel(entry)} gespeichert – ${fmtTime(entry.ts)}`);
  clearForm();
  renderLog();
  flashRow(entry.id);
  broadcast({ type: 'entries', eventId: ev.id });
  $('#f-call').focus();
}

async function saveEntry() {
  if (state.readOnly) return;
  // A finished header change gets its marker before the next line.
  await flushMarkers({ openForEdit: false });
  const f = readForm();
  if (f.kind === 'comment') return saveComment(f);
  const status = $('#form-status');
  if (!f.call) {
    status.className = 'err';
    status.textContent = 'Rufzeichen fehlt.';
    $('#f-call').focus();
    return;
  }
  const ev = state.event;
  const editing = state.editingId ? state.entries.find(e => e.id === state.editingId) : null;
  const t = lineTime(f.time, editing);
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
  status.replaceChildren();
  logStatus(`Nr. ${entry.seq} ${entry.call}${n > 1 ? ` (Check-in Nr. ${n})` : ''} gespeichert – ${fmtTime(entry.ts)}`);
  clearForm();
  renderLog();
  flashRow(entry.id);
  updateExportNudge();
  broadcast({ type: 'entries', eventId: ev.id });
  if (!editing && stats(state.entries).total % SNAPSHOT_EVERY === 0) takeSnapshot('automatisch');
  $('#f-call').focus();
}

function startEdit(id, { focus = true, scroll = true } = {}) {
  if (state.readOnly) return;
  const e = state.entries.find(x => x.id === id);
  if (!e) return;
  if (isComment(e)) {
    clearForm();
    state.editingId = id;
    setCommentMode(true);
    $('#f-ctext').value = e.text || '';
    writeCategory(e.category || '');
    const { date, time } = splitTime(e.ts, timeMode());
    $('#f-time').value = `${date} ${time}`;
    $('#entry-form').classList.add('editing');
    $('#btn-discard').textContent = 'Bearbeitung abbrechen (Esc)';
    setSaveLabel('Kommentar speichern');
    $('#form-status').className = '';
    fill($('#form-status'), el('span', { class: 'edit-tag' }, `Bearbeite ${lineLabel(e)} – die alte Fassung wird aufbewahrt.`));
    renderLog();
    scheduleDraft();
    if (focus) focusEntryStart();
    if (scroll) window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  if (state.commentMode) setCommentMode(false);
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
  setSaveLabel(`Nr. ${e.seq} speichern`);
  $('#form-status').className = '';
  fill($('#form-status'), el('span', { class: 'edit-tag' }, `Bearbeite Nr. ${e.seq} – die alte Fassung wird aufbewahrt.`));
  updateCallFeedback();
  scheduleDraft();
  if (focus) $('#f-call').focus();
  if (scroll) window.scrollTo({ top: 0, behavior: 'smooth' });
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
  logStatus(
    deleted ? `${lineLabel(e)} gelöscht. ` : `${lineLabel(e)} wiederhergestellt.`,
    deleted ? el('button', { type: 'button', class: 'link', onclick: () => setDeleted(id, false) }, 'Rückgängig') : null,
  );
  renderLog();
  if (!deleted) flashRow(id);
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
  if (form.kind === 'comment') {
    if (editingId && state.entries.some(e => e.id === editingId)) startEdit(editingId, { focus: false, scroll: false });
    else setCommentMode(true);
    $('#f-ctext').value = form.text || '';
    writeCategory(form.category || '');
    $('#f-time').value = form.time || '';
    return;
  }
  if (editingId && state.entries.some(e => e.id === editingId)) startEdit(editingId);
  else if (state.commentMode) setCommentMode(false);
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
    if (state.commentMode) setCommentMode(false); // empty comment: back to check-in
    $('#f-call').focus();
    return;
  }
  const edited = editingId ? state.entries.find(e => e.id === editingId) : null;
  clearForm();
  scheduleDraft(); // empty form -> the stored draft is removed
  $('#form-status').replaceChildren();
  logStatus(
    edited ? `Bearbeitung von ${isComment(edited) ? lineLabel(edited) : `Nr. ${edited.seq}`} abgebrochen – die Zeile bleibt unverändert. ` : 'Eingaben verworfen. ',
    el('button', { type: 'button', class: 'link', onclick: () => {
      applyFormState(form, editingId);
      scheduleDraft();
      $('#log-status').replaceChildren();
      focusEntryStart();
    } }, 'Rückgängig'));
  $('#f-call').focus();
}

async function restoreDraft() {
  if (state.readOnly || !state.event) return;
  const d = await state.store.get('drafts', state.event.id);
  if (!d || !d.form) return;
  applyFormState(d.form, d.editingId);
  logStatus(`Nicht gespeicherte Eingabe von ${fmtTime(d.savedAt)} wiederhergestellt (steht im Formular).`);
}

/* --- log table --- */

// Redraw the map only when entries or the header actually changed —
// renderLog() also runs on every keystroke in the callsign field.
let mapSig = '';
function currentMapSig() {
  const h = state.event.header || {};
  return [state.event.id, state.entries.length, h.myQth, h.myGrid, h.station, h.operator,
    ...state.entries.map(e => `${e.updated}${e.deleted || ''}`)].join('|');
}

function maybeRefreshMap() {
  if (!mapVisible()) return;
  const sig = currentMapSig();
  if (sig === mapSig) return;
  mapSig = sig;
  refreshMap(mapContext());
}

function renderLog(highlightCall) {
  if (!state.event) return;
  maybeRefreshMap();
  const tpl = templateFor(state.event.template);
  const nums = checkinNumbers(state.entries);
  const live = liveSorted(state.entries).reverse();
  const st = stats(state.entries);
  $('#st-unique').textContent = st.unique;
  $('#st-total').textContent = st.total;
  const call = highlightCall ?? normalizeCall($('#f-call').value);

  fill($('#log-head'), el('tr', {},
    th(timeMode() === 'local' ? `Zeit (${zoneLabel(nowIso(), 'local')})` : 'Zeit UTC'), th('Nr'), th('Rufzeichen Gegenstation'),
    tpl.fields.flatMap(f => [f.type === 'location'
      ? el('th', { scope: 'col', class: 'origin', title: 'Herkunft des Standorts' }, el('abbr', { title: 'Herkunft des Standorts' }, 'Herk.'))
      : null, th(f.label)]),
    th('Relais'), th('Notiz'), th('Op'), el('th', { scope: 'col', class: 'act' }, el('span', { class: 'sr-only' }, 'Aktionen'))));

  const body = $('#log-body');
  body.replaceChildren();
  const cols = tpl.fields.length + 7 + tpl.fields.filter(f => f.type === 'location').length;
  if (!live.length) {
    body.append(el('tr', {}, el('td', { colspan: String(cols), class: 'empty' }, 'Noch keine Einträge. Rufzeichen eingeben und Shift+Enter drücken.')));
    return;
  }
  for (const e of live) {
    const n = nums.get(e.id);
    const { date, time } = splitTime(e.ts, timeMode());
    const s = e.snap || {};
    // Date only when it differs from the newest line (nets past midnight).
    const showDate = date !== splitTime(live[0].ts, timeMode()).date;
    const timeBits = [showDate ? el('span', { class: 'date' }, date + ' ') : null, time,
      timeMode() === 'utc' ? 'Z' : null, // ISO/military notation for UTC; local times keep the column's offset
      timeMode() === 'local' && zoneLabel(e.ts, 'local') !== zoneLabel(nowIso(), 'local') ? el('span', { class: 'date' }, ' ' + zoneLabel(e.ts, 'local')) : null];
    const what = isComment(e) ? `Kommentar ${time}` : `Nr. ${e.seq} ${e.call}`;
    const actions = [
      el('button', { type: 'button', disabled: state.readOnly, 'aria-label': `${what} bearbeiten`, onclick: () => startEdit(e.id) }, 'Bearb.'),
      ' ',
      el('button', { type: 'button', class: 'danger', disabled: state.readOnly, 'aria-label': `${what} löschen`, title: 'Löschen',
        onclick: () => setDeleted(e.id, true) }, '✕'),
    ];
    if (isComment(e)) {
      // Operator comment / marker: one full-width banner row.
      body.append(el('tr', { 'data-id': e.id, class: ['marker', e.auto ? 'auto' : '', e.id === state.editingId ? 'editing' : ''].join(' ').trim() },
        el('td', { colspan: String(cols) },
          el('div', { class: 'marker-row' },
            el('span', { class: 'mono marker-time', title: `${isoUtc(e.ts)} (gespeichert, UTC)` }, timeBits),
            el('span', { class: 'marker-cat' }, e.category || 'Kommentar'),
            el('span', { class: 'marker-text' }, e.text || ''),
            el('span', { class: 'marker-op mono', title: 'Operator zu diesem Zeitpunkt' },
              s.operator && s.station && s.operator !== s.station ? `Op ${s.operator}/${s.station}` : s.operator ? `Op ${s.operator}` : ''),
            el('span', { class: 'act' }, actions)))));
      continue;
    }
    body.append(el('tr', { 'data-id': e.id, class: [e.call === call && call ? 'match' : '', e.id === state.editingId ? 'editing' : ''].join(' ').trim() || null },
      el('td', { class: 'mono', title: `${isoUtc(e.ts)} (gespeichert, UTC)` }, timeBits),
      el('td', { class: 'mono' }, String(e.seq)),
      el('td', { class: 'call' }, e.call, n > 1 ? el('span', { class: 'badge', title: `Check-in Nr. ${n}` }, `${n}×`) : null,
        callbookName(e.call) ? el('div', { class: 'cb-name' }, callbookName(e.call)) : null),
      tpl.fields.flatMap(f => [f.type === 'location' ? originCell(e.loc, e.fields?.[f.key]) : null,
        el('td', {}, fieldVisible(f, e.fields, tpl) ? fieldDisplay(f, e.fields?.[f.key]) : '',
        f.type === 'location' && e.loc ? el('div', { class: 'loc-sub' }, [`→ ${describeLocation(e.loc, logUtmDigits())}`, ...locHints(e.loc)].join(' · ')) : null,
        f.type === 'location' && !e.loc && e.fields?.[f.key] ? el('div', { class: 'loc-sub unresolved' }, 'nicht zugeordnet') : null)]),
      el('td', {}, e.viaRepeater
        ? el('span', {
          class: s.repeaterOverride ? 'rpt override' : 'rpt',
          title: [s.repeaterOverride ? 'anderes Relais als im Header' : 'Relais aus dem Header', s.repeaterFreq && `${s.repeaterFreq} MHz`, s.repeaterShift && `Shift ${s.repeaterShift}`, signallingText(s)].filter(Boolean).join(' · '),
        }, s.repeaterCall || 'ja')
        : '–'),
      el('td', {}, e.note || ''),
      el('td', { class: 'mono' }, s.operator && s.station && s.operator !== s.station ? `${s.operator}/${s.station}` : s.operator || s.station || ''),
      el('td', { class: 'act' }, actions),
    ));
  }
}

// "Herk." cell before a location column: where the location came from
// (LOC_ORIGINS; a source without a label leaves the cell empty).
function originCell(loc, text) {
  const k = locOrigin(loc, text);
  const o = LOC_ORIGINS[k];
  return el('td', { class: 'origin' }, o?.label ? el('span', { class: `src src-${k}`, title: o.title }, o.label) : '');
}

async function renderTrash() {
  const list = $('#trash-list');
  const deleted = state.entries.filter(e => e.deleted);
  fill(list, 
    el('li', {}, el('b', {}, `Gelöschte Zeilen (${deleted.length})`)),
    deleted.map(e => el('li', {},
      `${lineLabel(e)} ${fmtTime(e.ts)} – gelöscht ${fmtDateTime(e.deleted)} `,
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

// Result of an import, in the banner above the list (not alert(): it
// blocks the page and is suppressed in some browsers/embeddings).
function showImportMsg(kind, ...content) {
  const box = $('#import-msg');
  const ok = el('button', { type: 'button', onclick: () => { box.hidden = true; } }, 'OK');
  box.className = `banner ${kind}`;
  fill(box, ...content, ' ', ok);
  box.hidden = false;
  ok.focus();
}

async function importBackup(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    showImportMsg('err', el('strong', {}, 'Nicht importiert: '), `„${file.name}“ ist keine gültige JSON-Datei.`);
    return;
  }
  if (data?.format !== BACKUP_FORMAT || !Array.isArray(data.events)) {
    showImportMsg('err', el('strong', {}, 'Nicht importiert: '), `„${file.name}“ ist keine Sicherung des Bestätigungsverkehrs (Datei „Sicherung (JSON)“ / „Alle sichern (JSON)“).`);
    return;
  }
  const existing = new Set((await state.store.getAll('events')).map(e => e.id));
  let imported = 0, copies = 0;
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
      if (clash) copies++;
    } catch (e) {
      showSaveError(e);
      return;
    }
  }
  broadcast({ type: 'events' });
  showImportMsg('warn', el('strong', {}, `${imported} ${imported === 1 ? 'Log' : 'Logs'} importiert.`),
    copies ? ` ${copies} davon als Kopie („(Import)“), weil ${copies === 1 ? 'es' : 'sie'} schon vorhanden ${copies === 1 ? 'war' : 'waren'}; nichts wurde überschrieben.` : '');
  renderEventList();
}

/* --- exports --- */

function fileBase(ev, iso) {
  const slug = ev.title.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/ß/g, 'ss')
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

/* --- help under the entry form: "? Hilfe" or the ? key (outside text fields) --- */

const HELP_KEY = 'oe1ebg-confirm-help-open';

function initEntryHelp() {
  const btn = $('#btn-help');
  const panel = $('#entry-help');
  trackExpanded(btn, panel);
  const show = open => {
    panel.hidden = !open;
    prefSet(HELP_KEY, open ? '1' : '');
  };
  show(prefGet(HELP_KEY) === '1');
  btn.addEventListener('click', () => show(panel.hidden));
  document.addEventListener('keydown', ev => {
    if (ev.key !== '?' || ev.ctrlKey || ev.metaKey || ev.altKey || isComposing(ev)) return;
    const t = ev.target;
    if (t.closest?.('input, textarea, select, [contenteditable]') || $('#view-log').hidden) return;
    ev.preventDefault();
    show(panel.hidden);
  });
}

/* --- "Exportieren" menu (disclosure: a button and a list of buttons) --- */

function closeExportMenu(focusButton = false) {
  $('#export-list').hidden = true;
  if (focusButton) $('#btn-export-menu').focus();
}

function initExportMenu() {
  const btn = $('#btn-export-menu');
  const list = $('#export-list');
  trackExpanded(btn, list);
  btn.addEventListener('click', () => {
    list.hidden = !list.hidden;
    if (!list.hidden) list.querySelector('button').focus();
  });
  list.addEventListener('keydown', ev => {
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); closeExportMenu(true); }
  });
  // a click or focus anywhere else closes it
  document.addEventListener('pointerdown', ev => { if (!$('#export-menu').contains(ev.target)) closeExportMenu(); });
  $('#export-menu').addEventListener('focusout', ev => {
    if (ev.relatedTarget && !$('#export-menu').contains(ev.relatedTarget)) closeExportMenu();
  });
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

function showEmptyAdif(entries) {
  const box = $('#export-msg');
  const comments = entries.some(e => !e.deleted && isComment(e));
  const ok = el('button', { type: 'button', onclick: () => { box.hidden = true; } }, 'OK');
  fill(box, el('b', {}, 'Kein ADIF erstellt. '),
    'Das Log hat noch keine Check-ins. Operator-Kommentare (Zeilen mit !) und gelöschte Zeilen kommen nicht ins ADIF.',
    ok,
    comments ? el('button', { type: 'button', onclick: () => {
      box.hidden = true;
      $('#csv-comments').checked = true;
      $('#csv-comments').dispatchEvent(new Event('change'));
      doExport('csv');
    } }, 'Als CSV mit Kommentaren exportieren') : null);
  box.hidden = false;
  ok.focus();
}

// Lines a logbook program would reject or misfile (no frequency, no mode,
// header values that aren't a callsign/locator): say so before exporting.
function showAdifIssues(issues) {
  const box = $('#export-msg');
  const shown = issues.slice(0, 8);
  const go = el('button', { type: 'button', onclick: () => { box.hidden = true; doExport('adif', true); } }, 'Trotzdem exportieren');
  fill(box, el('strong', {}, `ADIF: ${issues.length} Zeile(n) unvollständig. `),
    'Logbuchprogramme brauchen Frequenz und Betriebsart; Werte, die kein Rufzeichen oder Locator sind, landen im Kommentar.',
    el('ul', {}, shown.map(i => el('li', {}, `Nr. ${i.nr} ${i.call}: ${i.problems.join(', ')}`)),
      issues.length > shown.length ? el('li', {}, `… und ${issues.length - shown.length} weitere`) : null),
    go,
    el('button', { type: 'button', onclick: () => { box.hidden = true; $('#hdr-panel').open = true; } }, 'Header bearbeiten'));
  box.hidden = false;
  go.focus();
}

// The own QTH texts of the log (header and line snapshots), resolved like
// the map does, for the exports' own UTMREF: text -> result | null.
async function qthResolver(ev, entries) {
  const texts = new Set([ev.header?.myQth, ...entries.map(e => e.snap?.myQth)].filter(Boolean));
  const ctx = mapContext();
  const found = new Map();
  for (const t of texts) found.set(t, await ctx.resolve(t));
  return t => found.get(t) || null;
}

// Zone for a UTMREF typed without zone: the open log's own QTH (resolved in
// the header), else its locator, else 33U.
function utmRefFromHeader() {
  if (!state.event) return { ...UTM_DEFAULT_REF, source: 'Standard' };
  const qth = $('#log-header')?._hdr?.qthField?.get();
  if (qth && Number.isFinite(qth.lat)) return { ...utmReference(qth.lat, qth.lon), source: 'Zone des eigenen QTH' };
  const g = String(state.event.header?.myGrid || '').trim();
  if (isValidLocator(g)) {
    const b = maidenheadToBounds(g);
    return { ...utmReference(b.centerLat, b.centerLon), source: 'Zone des eigenen Locators' };
  }
  return { ...UTM_DEFAULT_REF, source: 'Standard' };
}

async function doExport(kind, force = false) {
  $('#export-msg').hidden = true;
  await flushMarkers({ openForEdit: false });
  await flushHeader();
  const ev = state.event;
  const entries = state.entries;
  const qth = ['csv', 'adif', 'kml', 'summary'].includes(kind) ? await qthResolver(ev, entries) : null;
  if (kind === 'csv') {
    const sep = prefGet(CSV_SEP_KEY, ';');
    download(toCSV(ev, entries, sep, { comments: $('#csv-comments').checked, qth }), fileBase(ev) + '.csv', 'text/csv');
    markExported();
  } else if (kind === 'adif') {
    // ADIF only holds QSOs: an empty file (header only) looks like a
    // broken export in a logbook program, so say why there is none.
    if (!stats(entries).total) {
      showEmptyAdif(entries);
      return;
    }
    const issues = adifIssues(ev, entries);
    if (issues.length && !force) {
      showAdifIssues(issues);
      return;
    }
    const commit = globalThis.CONFIRM_BUILD?.commit;
    download(toADIF(ev, entries, undefined, { programVersion: commit && commit !== 'dev' ? commit : '', qth }),
      fileBase(ev) + '.adi', ADIF_MIME);
    markExported();
  } else if (kind === 'kml') {
    // Not a full backup (only stations with a location): no markExported().
    download(toKML(ev, entries, { qth }), fileBase(ev) + '.kml', KML_MIME);
  } else if (kind === 'json') {
    const backup = { format: BACKUP_FORMAT, version: 1, exported: nowIso(), events: [await eventBackup(ev)] };
    download(JSON.stringify(backup, null, 1), fileBase(ev) + '_sicherung.json', 'application/json');
    markExported();
  } else if (kind === 'summary') {
    showText('Zusammenfassung', toSummary(ev, entries, timeMode(), { qth }));
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
      // The writing tab made the markers for its header changes.
      state.markerBase = { ...(state.event.header || emptyHeader()) };
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
    document.querySelectorAll('#event-tabs button').forEach(x => {
      x.classList.toggle('active', x === b);
      x.setAttribute('aria-pressed', String(x === b));
    });
    renderEventList();
  }));
  $('#btn-new-event').addEventListener('click', () => openNewEventForm());
  trackExpanded($('#btn-new-event'), $('#new-event'));
  trackExpanded($('#btn-loc'), $('#loc-panel'));
  $('#btn-cancel-new').addEventListener('click', () => { $('#new-event').hidden = true; });
  // Same keys as the entry form: Enter = next field, Shift+Enter = create,
  // Esc = cancel (open dropdowns take Enter/Esc first).
  headerKeys($('#new-event'));
  $('#new-event').addEventListener('keydown', ev => {
    if (ev.key === 'Enter' && ev.shiftKey && !isComposing(ev)) {
      ev.preventDefault();
      submitForm($('#new-event'));
    } else if (ev.key === 'Escape') {
      $('#new-event').hidden = true;
      $('#btn-new-event').focus();
    }
  });
  // Log header: Enter in the last field goes on to the callsign.
  headerKeys($('#log-header'), focusEntryStart);
  // A finished header edit (field left, Enter, checkbox, repeater pick)
  // writes the automatic operator/repeater marker.
  $('#log-header').addEventListener('change', () => { flushMarkers(); });
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
  document.querySelectorAll('[data-export]').forEach(b => b.addEventListener('click', () => {
    closeExportMenu();
    doExport(b.dataset.export);
  }));
  initExportMenu();
  initEntryHelp();
  $('#btn-map').addEventListener('click', toggleMap);
  const sep = $('#csv-sep');
  sep.value = prefGet(CSV_SEP_KEY, ';');
  sep.addEventListener('change', () => prefSet(CSV_SEP_KEY, sep.value));
  const csvCmt = $('#csv-comments');
  csvCmt.checked = prefGet(CSV_COMMENTS_KEY) === '1';
  csvCmt.addEventListener('change', () => prefSet(CSV_COMMENTS_KEY, csvCmt.checked ? '1' : ''));

  const form = $('#entry-form');
  form.addEventListener('submit', ev => { ev.preventDefault(); saveEntry(); });
  form.addEventListener('input', onFormInput);
  // Keyboard-only logging (one hand is on the microphone):
  // Shift+Enter saves from any control, including dropdown items and radios;
  // Enter in a field moves to the next one (an open dropdown takes Enter
  // first and picks a suggestion); Esc discards.
  form.addEventListener('keydown', ev => {
    if (ev.key === 'Enter' && !isComposing(ev) && ev.shiftKey) {
      ev.preventDefault();
      saveEntry();
    } else if (ev.key === 'Enter' && !isComposing(ev) && ev.target.tagName === 'INPUT') {
      ev.preventDefault();
      focusNext(form, ev.target);
    } else if (ev.key === 'Escape' && !ev.defaultPrevented) {
      // (Open completion dropdowns handle Esc themselves and stop it here.)
      discardForm();
    }
  });
  $('#f-call').addEventListener('change', prefillLocation);
  // "!" in the empty callsign field = operator comment (before onFormInput).
  $('#f-call').addEventListener('input', onCallInput);
  buildCategoryChips();
  // Backspace in the empty comment text goes back to a check-in.
  $('#f-ctext').addEventListener('keydown', ev => {
    if (ev.key === 'Backspace' && !ev.target.value && !state.editingId && !readForm().category) {
      ev.preventDefault();
      setCommentMode(false);
      scheduleDraft();
      $('#f-call').focus();
    }
  });
  $('#f-rpt').addEventListener('change', () => { $('#f-rpt').dataset.touched = '1'; });
  // Typo suggestions are guesses: Enter takes one only after ↓.
  state.callPop = popover($('#f-call'), $('#call-suggest'), { enterPicksFirst: false });
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
  window.addEventListener('pagehide', () => { flushMarkers({ openForEdit: false }); flushDraft(); flushHeader(); });

  setInterval(tickClock, 1000);
  window.addEventListener('hashchange', route);
}

async function loadCallbook() {
  const data = await loadDataFile('callsigns-oe.json');
  state.callbook = buildCallbook(data);
  fill($('#st-callbook'), state.callbook
    ? sourceItem('callsigns', `Stand ${fmtStand(state.callbook.stand)}, ${state.callbook.calls.length} OE-Rufzeichen`)
    : 'Rufzeichenliste nicht verfügbar');
  renderHeaderHints($('#new-header'));
  renderHeaderHints($('#log-header'));
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
  $('#st-tabs').hidden = !!navigator.locks;
  trackOnline();
  initTimeMode();
  initLocationPanel();
  setUtmReference(utmRefFromHeader);
  // "UTMREF im Log zeigen" / its precision changed: redraw the info lines.
  document.addEventListener('confirm:utm-prefs', () => {
    if (!state.event) return;
    renderLog();
    state.locField?.redraw();
    $('#log-header')?._hdr?.qthField?.redraw();
  });
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
  fill($('#st-map-wien'), sourceItem('districts', 'Karte'));
  fill($('#st-map-lib'), sourceItem('leaflet', 'Kartenbibliothek'));
  route();
}

main();
