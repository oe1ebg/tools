// What the tool keeps in localStorage (through ../shared/js/prefs.js,
// which survives blocked storage). The save functions that the user should
// hear about return false when the write didn't stick.

import { prefGet, prefSet } from '../../shared/js/prefs.js';

const KEY = {
  callsigns: 'sota-alerts-callsigns',
  summitCache: 'sota-alerts-summit-cache',
  candidates: 'sota-alerts-candidates',
  bands: 'sota-alerts-band-filter',
  modes: 'sota-alerts-mode-filter',
  timeDisplay: 'sota-alerts-time-display',
  baseLayer: 'sota-alerts-base-layer',
  mapView: 'sota-alerts-map-view',
};

// prefSet() swallows a failed write (storage full or blocked); where
// the user should hear about that, read the value back to tell.
function prefSetChecked(key, value){
  prefSet(key, value);
  return prefGet(key) === value;
}

function loadJson(key, fallback){
  try { return JSON.parse(prefGet(key, JSON.stringify(fallback))); }
  catch { return fallback; }
}

function loadStringSet(key){
  try { return new Set(JSON.parse(prefGet(key, '[]'))); }
  catch { return new Set(); }
}
// non-essential preference, fine to just not persist
const saveStringSet = (key, set) => prefSet(key, JSON.stringify([...set]));

export const loadBands = () => loadStringSet(KEY.bands);
export const loadModes = () => loadStringSet(KEY.modes);
export const saveBands = set => saveStringSet(KEY.bands, set);
export const saveModes = set => saveStringSet(KEY.modes, set);

export const loadOwnCallsigns = () => prefGet(KEY.callsigns, '');
export const saveOwnCallsigns = raw => prefSetChecked(KEY.callsigns, raw);

// Pinned candidate summits: Map<key, candidate>.
export function loadCandidates(){
  const raw = loadJson(KEY.candidates, []);
  try { return new Map(raw.map(c => [c.key, c])); }
  catch { return new Map(); }
}
export const saveCandidates = candidates => prefSetChecked(KEY.candidates, JSON.stringify([...candidates.values()]));

export const loadSummitCache = () => loadJson(KEY.summitCache, {});
export const saveSummitCache = cache => prefSetChecked(KEY.summitCache, JSON.stringify(cache));

export const loadTimeDisplay = () => (prefGet(KEY.timeDisplay, 'utc') === 'local' ? 'local' : 'utc');
export const saveTimeDisplay = mode => prefSet(KEY.timeDisplay, mode);

export const loadBaseLayer = () => prefGet(KEY.baseLayer);
export const saveBaseLayer = name => prefSet(KEY.baseLayer, name);

// Where you were last looking, across visits — so a returning visitor's
// manually-chosen view isn't overridden by auto-fitting to whatever alerts
// happen to exist this time (see app.js init()).
export function loadMapView(){
  const v = loadJson(KEY.mapView, null);
  if (v && typeof v.lat === 'number' && typeof v.lng === 'number' && typeof v.zoom === 'number') return v;
  return null;
}
export const saveMapView = (lat, lng, zoom) => prefSet(KEY.mapView, JSON.stringify({ lat, lng, zoom }));
