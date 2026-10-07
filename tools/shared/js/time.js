// Time and id helpers shared by the offline tools (confirm, notfunk): ids,
// "now", and display/input of ISO 8601 UTC timestamps in UTC or local time.
// Storage is ALWAYS an ISO 8601 UTC timestamp; the mode only changes what is
// shown and how a typed correction is interpreted. Pure, node-tested.

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
