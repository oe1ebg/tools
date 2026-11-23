// The share link: date range, reference summit, pins and band/mode filter
// in the query string. Pure, both directions.
//
// Display preferences (theme, tile layer, time format, own callsigns)
// deliberately aren't included — those are about how *you* like to look
// at things, not what's being looked at, and a shared link silently
// overriding a recipient's own settings would be surprising.

// { from, to, ref, pins, bands, modes } -> query string (without "?")
export function shareSearch({ from, to, ref, pins = [], bands = [], modes = [] }){
  const params = new URLSearchParams();
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  if (ref) params.set('ref', ref);
  if (pins.length) params.set('pins', pins.join(','));
  if (bands.length) params.set('bands', bands.join(','));
  if (modes.length) params.set('modes', modes.join(','));
  return params.toString();
}

const list = v => (v || '').split(',').filter(Boolean);

// A shared link is input from anyone, and every pin that is in neither the
// local cache nor the static lookup becomes a live SOTA request. So:
// - only well-formed summit references are kept (ASSOC/RR-NNN, e.g.
//   OE/WI-001, W7A/AW-001, 3Y/BV-001; upper-cased, as in SOTA's data),
//   anything else is dropped;
// - a repeated pin counts once;
// - at most MAX_SHARED_PINS pins are taken (a link built by "share" from
//   a long pin list stays usable, a crafted one can't list thousands);
// - the live lookups for them are capped at MAX_SHARED_LIVE_LOOKUPS
//   (lookup.js `maxLive`, applied in app.js).
export const MAX_SHARED_PINS = 50;
export const MAX_SHARED_LIVE_LOOKUPS = 10;
// Every reference in SOTA's summit list matches ^[A-Z0-9]{1,3}/[A-Z0-9]{2}-[0-9]{3}$
// (checked against data/summit-lookup.json, 172k summits); a little slack
// for new associations.
export const SUMMIT_REF_RE = /^[A-Z0-9]{1,4}\/[A-Z0-9]{2,3}-[0-9]{3,4}$/;

// A summit reference as written in a link -> its canonical key, or null.
export function normalizeSummitRef(v){
  const ref = String(v || '').trim().toUpperCase();
  return SUMMIT_REF_RE.test(ref) ? ref : null;
}

// parseShareSearch() result -> the summit keys to resolve, the reference
// first (it needs its own marker, and must never be the one cut by the
// live-lookup cap), then the pins, each once.
export function sharedLinkKeys({ ref, pins }){
  return [...new Set(ref ? [ref, ...pins] : pins)];
}

// location.search -> what a shared link asks for, or null without a query.
// bands/modes are null when the link doesn't set them (keep the stored
// filter), an array when it does. `ref` and `pins` are validated (see
// above); `dropped` counts the pins that were malformed, repeated or over
// the limit, `badRef` is true when a reference was given but malformed.
export function parseShareSearch(search){
  const params = new URLSearchParams(search);
  if (![...params.keys()].length) return null;
  const rawRef = params.get('ref');
  const ref = rawRef ? normalizeSummitRef(rawRef) : null;
  const pins = [];
  let dropped = 0;
  for (const raw of list(params.get('pins'))){
    const key = normalizeSummitRef(raw);
    if (!key || pins.includes(key) || pins.length >= MAX_SHARED_PINS) dropped++;
    else pins.push(key);
  }
  return {
    from: params.get('from') || null,
    to: params.get('to') || null,
    ref,
    pins,
    bands: params.has('bands') ? list(params.get('bands')) : null,
    modes: params.has('modes') ? list(params.get('modes')) : null,
    dropped,
    badRef: !!rawRef && !ref,
  };
}
