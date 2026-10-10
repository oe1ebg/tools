// Time and id helpers shared by the offline tools (confirm, notfunk): ids,
// "now", and display/input of ISO 8601 UTC timestamps in UTC or local time.
// Storage is ALWAYS an ISO 8601 UTC timestamp; the mode only changes what is
// shown and how a typed correction is interpreted. Local time is the
// device's zone, or a named one (`tz`, e.g. 'Europe/Vienna') where a tool
// passes it. Pure, node-tested.

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
  return isoInZone(iso);
}

// Typed time correction in the given mode: "HH:MM[:SS]" (date taken from
// baseIso in that mode) or "YYYY-MM-DD HH:MM[:SS]". Returns ISO UTC or null
// (impossible date, local time skipped by DST). A local time in the hour
// that repeats when the clocks go back is the occurrence nearest baseIso.
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
  const date = `${y}-${pad2(mo)}-${pad2(d)}`, time = `${pad2(h)}:${pad2(mi)}:${pad2(sec)}`;
  if (mode === 'local') return closestTo(wallToInstants(date, time), baseIso);
  const dt = new Date(Date.UTC(y, mo - 1, d, h, mi, sec));
  // Reject impossible dates (Feb 30).
  return isNaN(dt) || splitUtc(dt.toISOString()).date !== date ? null : dt.toISOString();
}

// Wall clock in a time zone (undefined = the device's) via Intl, so a
// named zone works on any device. h23: no "24:00" (old Chrome).
const WALL_FMTS = new Map();
function wallFmt(tz) {
  const key = tz || '';
  if (!WALL_FMTS.has(key)) {
    WALL_FMTS.set(key, new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }));
  }
  return WALL_FMTS.get(key);
}

// The wall clock of an instant: { date: 'YYYY-MM-DD', time: 'HH:MM:SS' }.
export function wallClock(iso, tz) {
  const d = new Date(iso);
  if (isNaN(d)) return { date: '', time: '' };
  const p = Object.fromEntries(wallFmt(tz).formatToParts(d).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}:${p.second}` };
}

// UTC offset of the zone at that instant, in minutes (Vienna: 60 / 120).
export function zoneOffset(iso, tz) {
  const ms = Date.parse(iso);
  const { date, time } = wallClock(iso, tz);
  if (!date) return 0;
  const [y, mo, d] = date.split('-').map(Number), [h, mi, s] = time.split(':').map(Number);
  return Math.round((Date.UTC(y, mo - 1, d, h, mi, s) - Math.floor(ms / 1000) * 1000) / 60000);
}

// Every instant (ISO UTC, oldest first) whose wall clock in the zone is
// date + time ('YYYY-MM-DD', 'HH:MM[:SS]'): none for an impossible date or
// a time skipped when the clocks go forward, two in the hour that repeats
// when they go back (Vienna, last Sunday of October: 02:00–02:59 MESZ,
// then again MEZ).
export function wallToInstants(date, time, tz) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || '');
  const t = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(time || '');
  if (!m || !t || +t[1] > 23 || +t[2] > 59 || +(t[3] || 0) > 59) return [];
  const want = { date, time: `${pad2(t[1])}:${t[2]}:${t[3] || '00'}` };
  const asUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +t[1], +t[2], +(t[3] || 0));
  if (isNaN(asUtc)) return [];
  // the offsets in force half a day either side cover any DST change
  const offsets = new Set([-12, 12].map(h => zoneOffset(new Date(asUtc + h * 3600e3).toISOString(), tz)));
  const out = [];
  for (const off of offsets) {
    const iso = new Date(asUtc - off * 60e3).toISOString();
    const w = wallClock(iso, tz);
    if (w.date === want.date && w.time === want.time && !out.includes(iso)) out.push(iso);
  }
  return out.sort();
}

// Does the wall clock of this instant occur twice (the repeated hour)?
export function isRepeatedWall(iso, tz) {
  const { date, time } = wallClock(iso, tz);
  return wallToInstants(date, time, tz).length > 1;
}

// Of the candidates, the one nearest to refIso (the first one without a
// reference); null when there is none.
export function closestTo(candidates, refIso) {
  if (!candidates.length) return null;
  const ref = Date.parse(refIso);
  if (isNaN(ref)) return candidates[0];
  return candidates.reduce((a, b) => (Math.abs(Date.parse(b) - ref) < Math.abs(Date.parse(a) - ref) ? b : a));
}

// ISO 8601 in a zone's local time with its offset: "2026-10-05T14:07:00+02:00".
export function isoInZone(iso, tz) {
  const { date, time } = wallClock(iso, tz);
  if (!date) return '';
  const off = zoneOffset(iso, tz);
  return `${date}T${time}${off < 0 ? '-' : '+'}${pad2(Math.trunc(Math.abs(off) / 60))}:${pad2(Math.abs(off) % 60)}`;
}
