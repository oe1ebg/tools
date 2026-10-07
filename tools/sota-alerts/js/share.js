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

// location.search -> what a shared link asks for, or null without a query.
// bands/modes are null when the link doesn't set them (keep the stored
// filter), an array when it does.
export function parseShareSearch(search){
  const params = new URLSearchParams(search);
  if (![...params.keys()].length) return null;
  return {
    from: params.get('from') || null,
    to: params.get('to') || null,
    ref: params.get('ref') || null,
    pins: list(params.get('pins')),
    bands: params.has('bands') ? list(params.get('bands')) : null,
    modes: params.has('modes') ? list(params.get('modes')) : null,
  };
}
