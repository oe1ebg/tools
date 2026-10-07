// SOTA alerts: normalising the feed, the date window, grouping by summit,
// band/mode facets and own-callsign matching. Pure (no DOM, no fetch), so
// the node tests can import it (tests/sota-alerts.test.mjs).

export const DEFAULT_RANGE_DAYS = 14; // default window width; see capDefaultToDate()

export function normalizeAlert(raw){
  return {
    id: raw.id,
    dateActivated: raw.dateActivated || '',
    associationCode: raw.associationCode || '',
    summitCode: raw.summitCode || '',
    summitDetails: raw.summitDetails || '',
    frequency: raw.frequency || '',
    comments: raw.comments || '',
    activatingCallsign: raw.activatingCallsign || '',
    activatorName: raw.activatorName || '',
    posterCallsign: raw.posterCallsign || '',
  };
}

// "ASSOC/CODE", the key used for summits everywhere (map, pins, links).
export const alertSummitKey = a => `${a.associationCode}/${a.summitCode}`;

export function computeDataBounds(alerts){
  if (!alerts.length) return null;
  let min = alerts[0].dateActivated.slice(0, 10);
  let max = min;
  for (const a of alerts){
    const d = a.dateActivated.slice(0, 10);
    if (d < min) min = d;
    if (d > max) max = d;
  }
  return { min, max };
}

export function filterAlertsByRange(alerts, from, to){
  return alerts.filter(a => {
    const d = a.dateActivated.slice(0, 10);
    return (!from || d >= from) && (!to || d <= to);
  });
}

// Default "to" date: DEFAULT_RANGE_DAYS after `min`, clamped so it never
// exceeds the data's actual max (which would otherwise widen the default
// window on a quiet week with few near-term alerts).
export function capDefaultToDate(min, max){
  const d = new Date(min + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + (DEFAULT_RANGE_DAYS - 1));
  const capped = d.toISOString().slice(0, 10);
  return capped < max ? capped : max;
}

export function groupAlertsBySummit(alerts){
  const groups = new Map();
  for (const a of alerts){
    const key = alertSummitKey(a);
    if (!groups.has(key)){
      groups.set(key, { key, associationCode: a.associationCode, summitCode: a.summitCode, alerts: [] });
    }
    groups.get(key).alerts.push(a);
  }
  return groups;
}

/* ---------- band/mode parsing ----------
   SOTA's `frequency` field is free text typed by the alerting operator,
   not a structured format — real samples range from clean
   ("145-fm, 14-ssb, 7-ssb") to genuinely messy ("7-14-28 SSB 144.200 SSB
   144 FM", "146,52-FM" with a European comma-as-decimal-point, bare "Hf,
   cw, vhf"). There's no parser that gets 100% of this right; the
   approach below is deliberately "best effort, never silently hide an
   alert" rather than "strict, might misfile or drop odd entries":
   mode keywords are found anywhere in the string (robust to missing
   separators like "146.520FM"), and bands come from three independent
   signals (explicit "20m"/"70cm" names, bare "HF"/"VHF"/"UHF", and any
   number treated as a literal MHz frequency looked up against standard
   band edges) — an alert with nothing recognizable at all still gets
   bucketed under "other" so it stays visible rather than disappearing
   under a band/mode filter. */

export const HAM_BANDS = [
  { name: '2200m', min: 0.1357, max: 0.1378 },
  { name: '630m', min: 0.472, max: 0.479 },
  { name: '160m', min: 1.8, max: 2.0 },
  { name: '80m', min: 3.5, max: 4.0 },
  { name: '60m', min: 5.06, max: 5.45 },
  { name: '40m', min: 7.0, max: 7.3 },
  { name: '30m', min: 10.1, max: 10.15 },
  { name: '20m', min: 14.0, max: 14.35 },
  { name: '17m', min: 18.068, max: 18.168 },
  { name: '15m', min: 21.0, max: 21.45 },
  { name: '12m', min: 24.89, max: 24.99 },
  { name: '10m', min: 28.0, max: 29.7 },
  { name: '6m', min: 50, max: 54 },
  { name: '4m', min: 70, max: 71 },
  { name: '2m', min: 144, max: 148 },
  { name: '1.25m', min: 222, max: 225 },
  { name: '70cm', min: 420, max: 450 },
  { name: '33cm', min: 902, max: 928 },
  { name: '23cm', min: 1240, max: 1300 },
  { name: '13cm', min: 2300, max: 2450 },
];
// Display/sort order for the facet checkboxes: low frequency to high,
// then the generic HF/VHF/UHF buckets, then "other" last.
export const BAND_SORT_ORDER = [...HAM_BANDS.map(b => b.name), 'HF', 'VHF', 'UHF', 'other'];
export const MODE_KEYWORDS = ['CW', 'SSB', 'FM', 'AM', 'DV', 'DMR', 'DSTAR', 'C4FM', 'DATA', 'FT8', 'FT4', 'RTTY', 'PSK'];
export const MODE_SORT_ORDER = [...MODE_KEYWORDS, 'other'];

export function bandForFreqMHz(freq){
  const b = HAM_BANDS.find(b => freq >= b.min && freq <= b.max);
  return b ? b.name : null;
}

export function parseFrequencyFacets(freqStr){
  const s = freqStr || '';
  const lower = s.toLowerCase();
  const modes = new Set();
  for (const kw of MODE_KEYWORDS){
    // Boundary excludes letters but allows digits, since "146.520FM" (no
    // separator between frequency and mode) is a common real pattern.
    if (new RegExp(`(?:^|[^a-z])${kw.toLowerCase()}(?:[^a-z]|$)`).test(lower)) modes.add(kw);
  }
  const bands = new Set();
  let m;
  const nameRe = /(\d+(?:\.\d+)?)\s*(m|cm)\b/gi;
  while ((m = nameRe.exec(s))) bands.add(`${m[1]}${m[2].toLowerCase()}`);
  if (/\bhf\b/i.test(s)) bands.add('HF');
  if (/\bvhf\b/i.test(s)) bands.add('VHF');
  if (/\buhf\b/i.test(s)) bands.add('UHF');
  // Bare numbers, treated as literal MHz frequencies (comma-as-decimal
  // tolerated) — covers the common "7-cw" / "144.2-ssb" shorthand. Can
  // misfire for ambiguous single/double-digit VHF shorthand (e.g. a bare
  // "2" meaning "2m" gets read as 2 MHz, which lands in 160m instead) —
  // a known, accepted limitation of free-text input, not silently wrong
  // in a way that hides the alert (it still lands in *some* band).
  const numRe = /(\d+(?:[.,]\d+)?)/g;
  while ((m = numRe.exec(s))){
    const freq = parseFloat(m[1].replace(',', '.'));
    if (!isNaN(freq)){
      const band = bandForFreqMHz(freq);
      if (band) bands.add(band);
    }
  }
  return { bands, modes };
}

export function alertBandsModes(alert){
  const { bands, modes } = parseFrequencyFacets(alert.frequency);
  return {
    bands: bands.size ? bands : new Set(['other']),
    modes: modes.size ? modes : new Set(['other']),
  };
}

export function matchesBandModeFilter(alert, selectedBands, selectedModes){
  if (!selectedBands.size && !selectedModes.size) return true;
  const { bands, modes } = alertBandsModes(alert);
  const bandOk = !selectedBands.size || [...bands].some(b => selectedBands.has(b));
  const modeOk = !selectedModes.size || [...modes].some(m => selectedModes.has(m));
  return bandOk && modeOk;
}

// The bands and modes present in `alerts`, for the facet checkboxes.
export function facetsPresent(alerts){
  const bands = new Set(), modes = new Set();
  for (const a of alerts){
    const f = alertBandsModes(a);
    f.bands.forEach(b => bands.add(b));
    f.modes.forEach(m => modes.add(m));
  }
  return { bands, modes };
}

export function sortByOrder(values, order){
  return [...values].sort((a, b) => {
    const ia = order.indexOf(a), ib = order.indexOf(b);
    if (ia === -1 && ib === -1) return a.localeCompare(b);
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });
}

/* ---------- own-callsign matching ---------- */

export function normalizeCallsignBase(cs){
  // Portable/mobile suffixes (P, M, MM, QRP, ...) are short and can appear
  // either after the call ("OE1ABC/P") or, less commonly for activator
  // alerts, as a location prefix before it ("W4/OE1ABC"). Taking the
  // longest slash-separated segment handles both shapes without needing a
  // suffix dictionary; it's a heuristic, not a callsign-format validator.
  const parts = (cs || '').toUpperCase().trim().split('/').filter(Boolean);
  if (parts.length === 0) return '';
  return parts.reduce((a, b) => (b.length > a.length ? b : a));
}

export function parseOwnCallsigns(text){
  return new Set((text || '').split(',').map(normalizeCallsignBase).filter(Boolean));
}

export function isOwnAlert(alert, ownSet){
  return ownSet.has(normalizeCallsignBase(alert.activatingCallsign));
}
