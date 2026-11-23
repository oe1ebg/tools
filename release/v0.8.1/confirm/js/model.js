// Pure helpers for the confirmation log: bands, modes, header, check-in
// numbering (callsign, time and location-origin helpers are shared:
// shared/js/callbook.js, time.js, locmeta.js). No DOM, no storage — imported by app.js and by the node tests
// (oe1ebg/tests/), and inlined into confirm-offline.html by
// scripts/build_confirm.py, so every top-level name here must be unique
// across all js/ modules.

import { formatMHz } from '../../shared/js/repeaters.js';
import { newId, nowIso } from '../../shared/js/time.js';

// ADIF band plan (MHz), restricted to amateur bands plausible for nets.
const BANDS = [
  ['160m', 1.8, 2.0], ['80m', 3.5, 4.0], ['60m', 5.06, 5.45], ['40m', 7.0, 7.3],
  ['30m', 10.1, 10.15], ['20m', 14.0, 14.35], ['17m', 18.068, 18.168],
  ['15m', 21.0, 21.45], ['12m', 24.89, 24.99], ['10m', 28.0, 29.7],
  ['6m', 50, 54], ['4m', 70, 71], ['2m', 144, 148], ['1.25m', 222, 225],
  ['70cm', 420, 450], ['23cm', 1240, 1300], ['13cm', 2300, 2450],
];

export function parseMHz(text) {
  if (text === undefined || text === null) return null;
  const v = parseFloat(String(text).replace(',', '.'));
  return Number.isFinite(v) ? v : null;
}

export function bandForMHz(mhz) {
  if (mhz === null || mhz === undefined) return '';
  for (const [name, lo, hi] of BANDS) if (mhz >= lo && mhz <= hi) return name;
  return '';
}

// Modes offered in the log header, with their ADIF MODE/SUBMODE mapping
// (ADIF 3.1.7: DIGITALVOICE has the submodes C4FM, DMR, DSTAR, FREEDV,
// M17; TETRA has none).
export const MODES = [
  { key: 'FM', label: 'FM', mode: 'FM' },
  { key: 'SSB', label: 'SSB', mode: 'SSB' },
  { key: 'USB', label: 'SSB (USB)', mode: 'SSB', submode: 'USB' },
  { key: 'LSB', label: 'SSB (LSB)', mode: 'SSB', submode: 'LSB' },
  { key: 'AM', label: 'AM', mode: 'AM' },
  { key: 'CW', label: 'CW', mode: 'CW' },
  { key: 'DMR', label: 'DMR', mode: 'DIGITALVOICE', submode: 'DMR' },
  { key: 'C4FM', label: 'C4FM', mode: 'DIGITALVOICE', submode: 'C4FM' },
  { key: 'DSTAR', label: 'D-STAR', mode: 'DIGITALVOICE', submode: 'DSTAR' },
  { key: 'M17', label: 'M17', mode: 'DIGITALVOICE', submode: 'M17' },
  { key: 'TETRA', label: 'TETRA (DMO)', mode: 'DIGITALVOICE' },
];

export function modeInfo(key) {
  return MODES.find(m => m.key === key) || (key ? { key, label: key, mode: key } : null);
}

// "ADIF: MODE=DIGITALVOICE · SUBMODE=DMR"
export function adifModeText(key) {
  const m = modeInfo(key);
  if (!m) return '';
  return `ADIF: MODE=${m.mode}${m.submode ? ` · SUBMODE=${m.submode}` : m.mode === 'DIGITALVOICE' ? ' (kein Submode in ADIF)' : ''}`;
}

// Signalling per mode, the same for simplex and repeater operation:
// [key, label, placeholder]. `repeaterTone` is the CTCSS tone (the name
// predates simplex signalling; kept so old logs and backups stay valid).
export const SIGNALLING = {
  FM: [['repeaterTone', 'CTCSS Hz', '88.5'], ['dcs', 'DCS', '023N']],
  DMR: [['colorCode', 'Color Code', '0–15'], ['timeslot', 'Zeitschlitz', '1/2'], ['talkgroup', 'Sprechgruppe', '232']],
  C4FM: [['dgid', 'DG-ID', '0–99']],
  DSTAR: [['dstarModule', 'Modul', 'A/B/C']],
  M17: [['can', 'CAN', '0–15']],
};
const SIGNAL_TEXT = { repeaterTone: 'CTCSS', dcs: 'DCS', colorCode: 'CC', timeslot: 'TS', talkgroup: 'TG', dgid: 'DG-ID', dstarModule: 'Modul', can: 'CAN' };

// Signalling of a snapshot/header as text for its mode: "CTCSS 88.5",
// "CC 1 TS 2 TG 232". Values of other modes are ignored.
export function signallingText(snap) {
  return (SIGNALLING[snap?.mode] || [])
    .filter(([k]) => snap[k])
    .map(([k]) => `${SIGNAL_TEXT[k]} ${snap[k]}`).join(' ');
}

// The fields that describe the repeater itself: replaced together when a
// line uses another repeater than the header (colour code included, it is
// a property of a DMR repeater).
export const REPEATER_KEYS = ['repeaterCall', 'repeaterFreq', 'repeaterShift', 'repeaterTone', 'colorCode'];

// Header fields copied onto every line at save time, so later header edits
// (operator change, switching repeater) never rewrite history.
export const SNAPSHOT_KEYS = [
  'operator', 'station', 'freq', 'mode', 'myGrid', 'myQth',
  'repeaterCall', 'repeaterFreq', 'repeaterShift', 'repeaterTone',
  'dcs', 'colorCode', 'timeslot', 'talkgroup', 'dgid', 'dstarModule', 'can',
];

export function headerSnapshot(header) {
  const snap = {};
  for (const k of SNAPSHOT_KEYS) snap[k] = header?.[k] ?? '';
  return snap;
}

export function emptyHeader() {
  return {
    operator: '', station: '', freq: '', mode: 'FM', myGrid: '', myQth: '',
    viaRepeater: false, repeaterCall: '', repeaterFreq: '', repeaterShift: '', repeaterTone: '',
    dcs: '', colorCode: '', timeslot: '', talkgroup: '', dgid: '', dstarModule: '', can: '',
  };
}

// Frequencies for one line: via repeater the station transmits on
// output+shift and listens on the output; direct it's the header's direct
// frequency (the last one entered; empty if there never was one).
export function lineFrequencies(entry) {
  const s = entry.snap || {};
  if (entry.viaRepeater) {
    const out = parseMHz(s.repeaterFreq) ?? parseMHz(s.freq);
    const shift = parseMHz(s.repeaterShift);
    const tx = out !== null && shift !== null ? Math.round((out + shift) * 1e6) / 1e6 : out;
    return { tx, rx: out };
  }
  const f = parseMHz(s.freq);
  return { tx: f, rx: null };
}

// Entry kinds. A line without `kind` is a check-in (all data from before
// operator comments existed, and every JSON backup of it); `kind:
// 'comment'` is an operator comment / log marker: no callsign, no seq, no
// check-in number, not counted in statistics, the map, KML or ADIF.
export const COMMENT_KIND = 'comment';
export const CAT_FREQ = 'Frequenzwechsel';
export const CAT_HANDOVER = 'Schichtwechsel / Übergabe';
export const COMMENT_CATEGORIES = [CAT_FREQ, CAT_HANDOVER, 'Unterbrechung', 'Technik', 'Sonstiges'];

export function isComment(e) {
  return e?.kind === COMMENT_KIND;
}

// Live (non-deleted) entries in log order: by timestamp, then sequence
// number (comments have none), then creation time.
export function liveSorted(entries) {
  return entries
    .filter(e => !e.deleted)
    .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1
      : ((a.seq ?? 0) - (b.seq ?? 0)) || String(a.created ?? '').localeCompare(String(b.created ?? ''))));
}

// Live check-ins only (no operator comments), in log order.
export function liveCheckins(entries) {
  return liveSorted(entries).filter(e => !isComment(e));
}

// Map entry id -> check-in number for its callsign (1 = first check-in).
// Computed, not stored, so deleting or re-timing a line renumbers correctly.
export function checkinNumbers(entries) {
  const counts = new Map();
  const out = new Map();
  for (const e of liveCheckins(entries)) {
    const n = (counts.get(e.call) || 0) + 1;
    counts.set(e.call, n);
    out.set(e.id, n);
  }
  return out;
}

export function previousCheckins(entries, call, excludeId) {
  if (!call) return [];
  return liveCheckins(entries).filter(e => e.call === call && e.id !== excludeId);
}

export function stats(entries) {
  const live = entries.filter(e => !e.deleted && !isComment(e));
  return { total: live.length, unique: new Set(live.map(e => e.call)).size };
}

// A new operator comment for the entries store. `snap` is the header at
// that moment (for an automatic marker: after the change), like a check-in.
export function newComment({ eventId, ts, text, category, header, auto }) {
  const now = nowIso();
  return {
    id: newId(), eventId, kind: COMMENT_KIND, ts: ts || now,
    text: String(text ?? '').trim(), category: category || '', auto: auto || null,
    snap: headerSnapshot(header), created: now, updated: now, deleted: null,
  };
}

// "OE1XUU (438.950 MHz)" / "direkt (145.500 MHz)"
function markerRepeaterLabel(h) {
  if (h.viaRepeater) return `${h.repeaterCall}${h.repeaterFreq ? ` (${h.repeaterFreq} MHz)` : ''}`;
  return `direkt${h.freq ? ` (${h.freq} MHz)` : ''}`;
}

// Automatic log markers for header changes. `base` is the header as of the
// last check (opening the log, or the previous check), `next` the header
// now. Returns the markers to write and the new base. Half-typed states are
// skipped and keep the old base: an empty operator, or "über Relais" ticked
// without a repeater callsign. No markers while the log has no lines yet
// (`hasEntries` false), so filling in a fresh log's header is no "change".
//   operator changed                -> Schichtwechsel / Übergabe
//   repeater changed / on / off     -> Frequenzwechsel
//   direct frequency changed (no repeater) -> Frequenzwechsel
export function headerChangeMarkers(base, next, hasEntries = true) {
  const b = { ...emptyHeader(), ...base };
  const n = { ...emptyHeader(), ...next };
  const out = { ...b };
  const markers = [];
  if (n.operator && n.operator !== b.operator) {
    out.operator = n.operator;
    markers.push({
      category: CAT_HANDOVER, auto: 'operator', from: b.operator, to: n.operator,
      text: b.operator ? `${n.operator} übernimmt von ${b.operator}` : `Operator ${n.operator}`,
    });
  }
  if (!n.viaRepeater || n.repeaterCall) {
    const effB = b.viaRepeater ? b.repeaterCall : '';
    const effN = n.viaRepeater ? n.repeaterCall : '';
    if (effB !== effN || (!effN && n.freq && n.freq !== b.freq)) {
      const from = markerRepeaterLabel(b), to = markerRepeaterLabel(n);
      markers.push({ category: CAT_FREQ, auto: 'repeater', from, to, text: `${from} → ${to}` });
    }
    for (const k of ['viaRepeater', ...REPEATER_KEYS]) out[k] = n[k];
    if (n.freq) out.freq = n.freq;
  }
  return { markers: hasEntries ? markers : [], base: out };
}

// Who operated when, from the per-line header snapshots (check-ins and
// comments; a handover marker carries the new operator): consecutive runs
// of the same operator as [{ operator, from, to }] (ISO timestamps; `from`
// = first line of the run, `to` = first line of the next run, or the last
// line of the log).
export function operatorShifts(entries) {
  const live = liveSorted(entries);
  const out = [];
  for (const e of live) {
    const op = e.snap?.operator || '';
    if (!op) continue;
    const cur = out[out.length - 1];
    if (cur && cur.operator === op) {
      cur.to = e.ts;
    } else {
      if (cur) cur.to = e.ts;
      out.push({ operator: op, from: e.ts, to: e.ts });
    }
  }
  return out;
}

// Snapshot fields for a repeater from the ÖVSV list.
export function repeaterFields(r) {
  return {
    repeaterCall: r.call,
    repeaterFreq: formatMHz(r.out),
    repeaterShift: r.shift === null || r.shift === undefined ? '' : String(r.shift),
    repeaterTone: r.ctcss ? String(r.ctcss) : '',
    colorCode: r.cc === null || r.cc === undefined ? '' : String(r.cc),
  };
}

// Header values to set when a repeater is chosen. The direct frequency is
// left alone: it is only used for lines that come in direct.
export function headerFromRepeater(r, header) {
  const next = { ...header, viaRepeater: true, ...repeaterFields(r) };
  // The list only knows CTCSS: a repeater with a CTCSS tone clears a DCS
  // code left from the previous one (without a tone, a typed DCS stays).
  if (r.ctcss) next.dcs = '';
  // Mode: keep the current one if the repeater supports it, else its first mode.
  if (r.modes.length && !r.modes.includes(header.mode)) next.mode = r.modes[0];
  return next;
}
