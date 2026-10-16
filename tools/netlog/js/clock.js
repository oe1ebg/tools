// How Netlog shows times: UTC (the default for radio data) or local time,
// switched in the header (pref oe1ebg-netlog-time). Storage is always ISO
// 8601 UTC; the mode only changes what is shown and how a typed time
// (a handover correction) is read. Every shown time carries its zone
// ("19:42 UTC", "21:42 UTC+2"), ISO order and 24 hours in both modes.

import { prefGet, prefSet } from '../../shared/js/prefs.js';
import { splitTime, zoneLabel, parseTimeInput, localZoneText } from '../../shared/js/time.js';

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

// The local choice of the switch: "Europe/Vienna (UTC+2)".
export function localChoiceText(fallback, iso = null) {
  return localZoneText(fallback, iso);
}

// "HH:MM" of an instant in the current mode ('' for none).
export function hm(iso) {
  return iso ? splitTime(iso, shownMode).time.slice(0, 5) : '';
}

// "HH:MM:SS"
export function hms(iso) {
  return iso ? splitTime(iso, shownMode).time : '';
}

// The zone of an instant in the current mode: "UTC" or "UTC+2".
export function zone(iso = null) {
  return zoneLabel(iso || new Date().toISOString(), shownMode);
}

// "HH:MM UTC" / "HH:MM UTC+2"
export function hmz(iso) {
  return iso ? `${hm(iso)} ${zone(iso)}` : '';
}

// A typed "HH:MM" on the date of `baseIso` in the current mode, as ISO UTC
// (null when it is no time).
export function parseHm(text, baseIso) {
  return parseTimeInput(text, shownMode, baseIso);
}
