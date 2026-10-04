// Pure helpers for the confirmation log: callsigns, time, bands, check-in
// numbering. No DOM, no storage — imported by app.js and by the node tests
// (oe1ebg/tests/), and inlined into confirm-offline.html by
// scripts/build_confirm.py, so every top-level name here must be unique
// across all js/ modules.

export function normalizeCall(raw) {
  return String(raw ?? '').toUpperCase().replace(/\s+/g, '').replace(/[^A-Z0-9/]/g, '');
}

// Loose amateur callsign check (optional prefix/ and /suffix). Only used for a
// soft warning — logging is never blocked by it.
const CALL_RE = /^(?:[A-Z0-9]{1,4}\/)?[A-Z0-9]{1,3}[0-9][A-Z0-9]{0,4}[A-Z](?:\/[A-Z0-9]{1,4})?$/;

export function isPlausibleCall(call) {
  return CALL_RE.test(call);
}

export function newId() {
  if (globalThis.crypto && typeof crypto.randomUUID === 'function') {
    try { return crypto.randomUUID(); } catch { /* not a secure context (file://) */ }
  }
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

export function nowIso() {
  return new Date().toISOString();
}

// "2026-10-04T19:42:07.123Z" -> { date: "2026-10-04", time: "19:42:07" }
export function splitUtc(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return { date: '', time: '' };
  const s = d.toISOString();
  return { date: s.slice(0, 10), time: s.slice(11, 19) };
}

// Parse a user-corrected "YYYY-MM-DD HH:MM[:SS]" (always UTC) back to ISO.
export function parseUtcInput(text) {
  const m = String(text).trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s = '0'] = m;
  const t = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  const dt = new Date(t);
  if (isNaN(dt) || dt.getUTCHours() !== +h || dt.getUTCDate() !== +d) return null;
  return dt.toISOString();
}

// Display/input time mode: 'utc' or 'local'. Storage is ALWAYS an ISO 8601
// UTC timestamp (entry.ts); the mode only changes what is shown and how a
// typed correction is interpreted.
function pad2(n) {
  return String(n).padStart(2, '0');
}

export function splitTime(iso, mode = 'utc') {
  if (mode !== 'local') return splitUtc(iso);
  const d = new Date(iso);
  if (isNaN(d)) return { date: '', time: '' };
  return {
    date: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`,
    time: `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`,
  };
}

// "UTC" or the local offset at that instant, e.g. "UTC+2" (summer) / "UTC+1".
export function zoneLabel(iso, mode = 'utc') {
  if (mode !== 'local') return 'UTC';
  const off = -new Date(iso || Date.now()).getTimezoneOffset();
  const h = Math.trunc(Math.abs(off) / 60), m = Math.abs(off) % 60;
  return `UTC${off < 0 ? '−' : '+'}${h}${m ? ':' + pad2(m) : ''}`;
}

// ISO 8601 without milliseconds: "2026-10-04T10:00:05Z".
export function isoUtc(iso) {
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// ISO 8601 in local time with explicit offset: "2026-10-04T12:00:05+02:00".
export function isoWithOffset(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const { date, time } = splitTime(iso, 'local');
  const off = -d.getTimezoneOffset();
  const sign = off < 0 ? '-' : '+';
  return `${date}T${time}${sign}${pad2(Math.trunc(Math.abs(off) / 60))}:${pad2(Math.abs(off) % 60)}`;
}

// Typed time correction in the given mode: "HH:MM[:SS]" (date taken from
// baseIso in that mode) or "YYYY-MM-DD HH:MM[:SS]". Returns ISO UTC or null.
export function parseTimeInput(text, mode, baseIso) {
  const t = String(text ?? '').trim();
  let m = t.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  let y, mo, d, h, mi, sec;
  if (m) {
    [y, mo, d] = splitTime(baseIso, mode).date.split('-').map(Number);
    [h, mi, sec] = [+m[1], +m[2], +(m[3] || 0)];
  } else {
    m = t.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (!m) return null;
    [y, mo, d, h, mi, sec] = [+m[1], +m[2], +m[3], +m[4], +m[5], +(m[6] || 0)];
  }
  if (h > 23 || mi > 59 || sec > 59) return null;
  const dt = mode === 'local' ? new Date(y, mo - 1, d, h, mi, sec) : new Date(Date.UTC(y, mo - 1, d, h, mi, sec));
  const back = splitTime(dt.toISOString(), mode);
  // Reject impossible dates (Feb 30) and local times skipped by DST.
  if (isNaN(dt) || back.date !== `${y}-${pad2(mo)}-${pad2(d)}` || back.time !== `${pad2(h)}:${pad2(mi)}:${pad2(sec)}`) return null;
  return dt.toISOString();
}

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

// Modes offered in the log header, with their ADIF MODE/SUBMODE mapping.
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

// Header fields copied onto every line at save time, so later header edits
// (operator change, switching repeater) never rewrite history.
export const SNAPSHOT_KEYS = [
  'operator', 'station', 'freq', 'mode', 'myGrid', 'myQth',
  'repeaterCall', 'repeaterFreq', 'repeaterShift', 'repeaterTone',
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
  };
}

// Frequencies for one line: via repeater the station transmits on
// output+shift and listens on the output; direct it's the header frequency.
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

// Live (non-deleted) entries in log order: by timestamp, then sequence number.
export function liveSorted(entries) {
  return entries
    .filter(e => !e.deleted)
    .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.seq - b.seq));
}

// Map entry id -> check-in number for its callsign (1 = first check-in).
// Computed, not stored, so deleting or re-timing a line renumbers correctly.
export function checkinNumbers(entries) {
  const counts = new Map();
  const out = new Map();
  for (const e of liveSorted(entries)) {
    const n = (counts.get(e.call) || 0) + 1;
    counts.set(e.call, n);
    out.set(e.id, n);
  }
  return out;
}

export function previousCheckins(entries, call, excludeId) {
  if (!call) return [];
  return liveSorted(entries).filter(e => e.call === call && e.id !== excludeId);
}

export function stats(entries) {
  const live = entries.filter(e => !e.deleted);
  return { total: live.length, unique: new Set(live.map(e => e.call)).size };
}
