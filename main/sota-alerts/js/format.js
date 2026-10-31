// Alert times (UTC or local, the header's toggle) and the one-line alert
// summaries. Pure; `mode` is 'utc' or 'local'.

// ISO 8601 and 24-hour in both zones (root AGENTS.md): built from the
// date's parts, never from a locale-dependent formatter.
import { tx } from '../../shared/js/i18n.js';

const pad2 = n => String(n).padStart(2, '0');
export function formatTimeUTC(t){ return t.toISOString().slice(11, 16) + 'Z'; }
export function formatTimeLocal(t){ return `${pad2(t.getHours())}:${pad2(t.getMinutes())}`; }
export function formatDateTimeUTC(t){ return t.toISOString().slice(0, 16).replace('T', ' ') + 'Z'; }
export function formatDateTimeLocal(t){ return `${t.getFullYear()}-${pad2(t.getMonth() + 1)}-${pad2(t.getDate())} ${formatTimeLocal(t)}`; }

// Every alert-time display in the app goes through this, so the header's
// UTC/local toggle changes them all consistently instead of each place
// picking its own format. `primary` is whichever zone the toggle currently
// selects; `secondary` (the other one, labeled) is available for places
// that show both, like the marker popup.
export function timeDisplayPair(dateActivated, withDate, mode){
  const t = new Date(dateActivated);
  if (isNaN(t)) return { primary: dateActivated, secondary: '' };
  const utc = withDate ? formatDateTimeUTC(t) : formatTimeUTC(t);
  const local = withDate ? formatDateTimeLocal(t) : formatTimeLocal(t);
  return mode === 'local'
    ? { primary: local, secondary: `UTC ${utc}` }
    : { primary: utc, secondary: tx(`local ${local}`, `lokal ${local}`) };
}

// One-line "when · who" summary for a single alert, shared by search-result
// cards and the pinned-summits list — anywhere a summit needs to show
// "there's an alert here" without the full popup.
export function formatAlertBrief(a, mode){
  const when = timeDisplayPair(a.dateActivated, true, mode).primary;
  const who = a.activatorName ? `${a.activatingCallsign} (${a.activatorName})` : a.activatingCallsign;
  return `${when} · ${who}`;
}

export function formatAlertsBrief(alerts, mode, cap = 3){
  if (!alerts.length) return null;
  return alerts.slice(0, cap).map(a => formatAlertBrief(a, mode)).join('; ') + (alerts.length > cap ? tx(` +${alerts.length - cap} more`, ` +${alerts.length - cap} weitere`) : '');
}
