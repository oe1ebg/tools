// Austrian voice repeaters (data/repeaters-at.json, built by
// scripts/fetch_repeaters.py from the ÖVSV repeater database) — search by
// callsign, site/town, frequency, band, mode or locator, nearest first when
// the own position is known. Pure functions, unit-tested in oe1ebg/tests/.

import { foldName, compactKey } from './location/normalize.js';
import { maidenheadToBounds, isValidLocator } from './location/maidenhead.js';
import { distanceMeters } from './location/spatial.js';

const RPT_MODE_WORDS = { fm: 'FM', dmr: 'DMR', c4fm: 'C4FM', ysf: 'C4FM', fusion: 'C4FM', dstar: 'DSTAR', 'd-star': 'DSTAR', tetra: 'TETRA' };
const RPT_BAND_WORDS = { '2m': '2m', '70cm': '70cm', '23cm': '23cm', '6m': '6m', '10m': '10m', '13cm': '13cm' };

export function buildRepeaterIndex(data) {
  if (!data || !Array.isArray(data.repeaters)) return null;
  const list = data.repeaters.map(r => ({
    ...r,
    key: compactKey(foldName(`${r.site} ${r.city}`)),
    callKey: r.call.toLowerCase(),
  }));
  return { list, retrieved: data.retrieved || '', source: data.source || '' };
}

// Own position from a locator ("JN88ef") as the locator's center.
export function positionFromLocator(loc) {
  if (!loc || !isValidLocator(loc)) return null;
  const b = maidenheadToBounds(loc);
  return { lat: b.centerLat, lon: b.centerLon };
}

export function formatShift(shift) {
  if (shift === null || shift === undefined) return '';
  if (shift === 0) return 'simplex';
  return `${shift < 0 ? '−' : '+'}${Math.abs(shift)}`;
}

export function formatMHz(v) {
  // 438.95 -> "438.950", 145.6125 -> "145.6125"
  return v === null || v === undefined ? '' : v.toFixed(4).replace(/0$/, '');
}

// Query tokens: callsign fragments, frequency (MHz), band, mode, locator,
// anything else = site/town text. Returns ranked [{ r, score, distKm }].
export function searchRepeaters(idx, query, opts = {}) {
  if (!idx) return [];
  const limit = opts.limit || 8;
  const here = opts.position || null;
  const toks = String(query || '').trim().split(/\s+/).filter(Boolean);
  let freq = null, band = null, mode = null, loc = null;
  const text = [];
  for (const raw of toks) {
    const t = raw.toLowerCase().replace(/,/g, '.');
    if (/^\d{2,5}(\.\d+)?$/.test(t) && +t >= 28 && +t <= 10500) freq = +t;
    else if (RPT_BAND_WORDS[t]) band = RPT_BAND_WORDS[t];
    else if (RPT_MODE_WORDS[t]) mode = RPT_MODE_WORDS[t];
    else if (raw.length >= 4 && isValidLocator(raw)) loc = positionFromLocator(raw);
    else text.push(raw);
  }
  const center = loc || here;
  const q = text.join(' ');
  const qCall = q.toLowerCase().replace(/[^a-z0-9]/g, '');
  const qKey = compactKey(foldName(q));

  const out = [];
  for (const r of idx.list) {
    if (band && r.band !== band) continue;
    if (mode && !r.modes.includes(mode)) continue;
    let score = 0;
    if (freq !== null) {
      // "438.95" matches output or input; "438" matches the whole MHz.
      const tol = Number.isInteger(freq) && !/\./.test(String(query)) ? 0.9999 : 0.00625;
      const hitOut = Math.abs(r.out - freq) <= tol || (Number.isInteger(freq) && Math.floor(r.out) === freq);
      const hitIn = r.in !== null && Math.abs(r.in - freq) <= tol;
      if (!hitOut && !hitIn) continue;
      score += hitOut ? 50 : 35;
    }
    if (qCall) {
      let s = 0;
      if (r.callKey === qCall) s = 100;
      else if (r.callKey.startsWith(qCall)) s = 80;
      else if (qCall.length >= 2 && r.callKey.slice(3).startsWith(qCall)) s = 75; // "xuu" -> OE1XUU
      else if (qCall.length >= 3 && r.callKey.includes(qCall)) s = 60;
      if (qKey.length >= 3 && r.key.includes(qKey)) s = Math.max(s, r.key.startsWith(qKey) ? 70 : 55);
      if (!s) continue;
      score += s;
    }
    if (r.status !== 'active') score -= 15;
    let distKm = null;
    if (center && r.lat !== null) {
      distKm = distanceMeters(center.lat, center.lon, r.lat, r.lon) / 1000;
      score -= Math.min(30, distKm / 10); // nearer first, but text matches dominate
    }
    out.push({ r, score, distKm });
  }
  out.sort((a, b) => b.score - a.score || (a.distKm ?? 1e9) - (b.distKm ?? 1e9) || a.r.call.localeCompare(b.r.call));
  return out.slice(0, limit);
}

// Header values to set when a repeater is chosen.
export function headerFromRepeater(r, header) {
  const next = {
    ...header,
    viaRepeater: true,
    repeaterCall: r.call,
    repeaterFreq: formatMHz(r.out),
    repeaterShift: r.shift === null || r.shift === undefined ? '' : String(r.shift),
    repeaterTone: r.ctcss ? String(r.ctcss) : '',
  };
  // Mode: keep the current one if the repeater supports it, else its first mode.
  if (r.modes.length && !r.modes.includes(header.mode)) next.mode = r.modes[0];
  if (!header.freq) next.freq = formatMHz(r.out);
  return next;
}
