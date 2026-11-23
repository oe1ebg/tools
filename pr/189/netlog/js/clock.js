// How Netlog shows times: UTC (the default for radio data) or local time,
// switched in the header (pref oe1ebg-netlog-time). Storage is always ISO
// 8601 UTC; the mode only changes what is shown and how a typed time
// (a handover correction) is read. Every shown time carries its zone
// ("19:42 UTC", "21:42 MESZ" / "21:42 CEST" in the interface language),
// ISO order and 24 hours in both modes.

import { prefGet, prefSet } from '../../shared/js/prefs.js';
import { splitTime, parseTimeInput, zoneAbbr, localZoneAbbrText } from '../../shared/js/time.js';
import { lang } from './i18n.js';

export const TIME_PREF = 'oe1ebg-netlog-time';
let shownMode = prefGet(TIME_PREF, 'utc') === 'local' ? 'local' : 'utc';

export function timeMode() {
  return shownMode;
}

export function setTimeMode(m) {
  shownMode = m === 'local' ? 'local' : 'utc';
  prefSet(TIME_PREF, shownMode);
  return shownMode;
}

// The local choice of the switch: "Europe/Vienna (MESZ)".
export function localChoiceText(fallback, iso = null) {
  return localZoneAbbrText(fallback, iso, lang());
}

// "HH:MM" of an instant in the current mode ('' for none).
export function hm(iso) {
  return iso ? splitTime(iso, shownMode).time.slice(0, 5) : '';
}

// "HH:MM:SS"
export function hms(iso) {
  return iso ? splitTime(iso, shownMode).time : '';
}

// The zone of an instant in the current mode: "UTC", or the local zone's
// short name at that instant in the interface language ("MESZ"/"MEZ",
// "CEST"/"CET"; "UTC+3" where a zone has no name). Per instant, so a time
// before a DST change keeps its own name.
export function zone(iso = null) {
  return shownMode === 'local' ? zoneAbbr(iso || new Date().toISOString(), lang()) : 'UTC';
}

// "HH:MM UTC" / "HH:MM MESZ"
export function hmz(iso) {
  return iso ? `${hm(iso)} ${zone(iso)}` : '';
}

// A typed "HH:MM" on the date of `baseIso` in the current mode, as ISO UTC
// (null when it is no time).
export function parseHm(text, baseIso) {
  return parseTimeInput(text, shownMode, baseIso);
}
