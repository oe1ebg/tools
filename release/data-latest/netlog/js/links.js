// Station lookup links the user may open (they need internet): QRZ.com,
// HamQTH, QRZCQ, APRS.fi and the user's own Wavelog. Links only: Netlog
// never fetches anything from them, never sends a query by itself and
// never overwrites a station with what they show. Only verified URL forms
// (the station page of each site, checked 2026-10 with a real callsign);
// for Wavelog only the instance's address (no deep link), set on the
// Wavelog import page (tools/wavelog-import/, the same stored key).
// The callsign goes in URL-encoded. The only Netlog module with external
// URLs (tests/netlog-offline.test.mjs).

import { prefGet } from '../../shared/js/prefs.js';
import { callBase, isUnresolved } from './model.js';

export const WAVELOG_PREF = 'oe1ebg-netlog-wavelog';

const LOOKUPS = [
  ['QRZ.com', call => `https://www.qrz.com/db/${encodeURIComponent(call)}`],
  ['HamQTH', call => `https://www.hamqth.com/${encodeURIComponent(call)}`],
  ['QRZCQ', call => `https://www.qrzcq.com/call/${encodeURIComponent(call)}`],
  ['APRS.fi', call => `https://aprs.fi/info/a/${encodeURIComponent(call)}`],
];

// A Wavelog address the user typed: http(s) only, no user/password part,
// normalised with a trailing slash; '' when it is none.
export function wavelogUrl(text) {
  const s = String(text || '').trim();
  if (!s) return '';
  let u;
  try { u = new URL(s); } catch { return ''; }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password) return '';
  u.search = '';
  u.hash = '';
  return u.href.endsWith('/') ? u.href : `${u.href}/`;
}

export function getWavelog() {
  return wavelogUrl(prefGet(WAVELOG_PREF, ''));
}

// [{ label, href }] for a participant's callsign; none for an unresolved
// one (no lookup of a guess).
export function stationLinks(call, wavelog = getWavelog()) {
  if (!call || isUnresolved(call)) return wavelog ? [{ label: 'Wavelog', href: wavelog }] : [];
  const base = callBase(call);
  const out = LOOKUPS.map(([label, url]) => ({ label, href: url(base) }));
  if (wavelog) out.push({ label: 'Wavelog', href: wavelog });
  return out;
}
