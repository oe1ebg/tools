// SOTA Alerts Map: state, rendering order, the toolbar and start-up.
// A live client of SOTA's public API: read AGENTS.md (API call inventory)
// before adding requests.

import { copyToClipboard } from '../../shared/js/dom.js';
import { fetchAlerts, fetchSummit, searchSummits, searchOsmSummitsInView, fetchJson, SUMMIT_LOOKUP_URL, ALL_SUMMITS_URL } from './api.js';
import {
  normalizeAlert, computeDataBounds, filterAlertsByRange, capDefaultToDate, groupAlertsBySummit, alertSummitKey,
  matchesBandModeFilter, facetsPresent, BAND_SORT_ORDER, MODE_SORT_ORDER, parseOwnCallsigns, isOwnAlert,
} from './alerts.js';
import { formatAlertsBrief } from './format.js';
import { splitSummitKey, candidateFromSearchResult, candidateFromOsmElement, lookupFromRows } from './summits.js';
import { createSummitResolver, lazy } from './lookup.js';
import { shareSearch, parseShareSearch } from './share.js';
import * as store from './store.js';
import { createWarnings } from './warnings.js';
import { createMap, USER_LOCATION_ZOOM } from './map.js';
import {
  renderAlertList, renderCandidatesList, renderSearchResults, setSearchHint, renderFacetGroup, renderStats, renderRefIndicator,
} from './view.js';

const $id = id => document.getElementById(id);

const AREA_SEARCH_MAX_SPAN_DEG = 4; // keep Overpass queries small/fast and fair-use-friendly

const state = {
  rawAlerts: [],
  bounds: null,
  summitMap: new Map(),
  referenceKey: null, // "ASSOC/CODE" of the summit chosen as the distance/elevation reference point, if any
  candidates: store.loadCandidates(), // pinned summits (searched by name/code), independent of whether they currently have an alert
  userLocation: null, // {lat, lon} from the browser's geolocation API, or null if unavailable/denied
  selectedBands: store.loadBands(), // empty set = no band filter (show all)
  selectedModes: store.loadModes(), // empty set = no mode filter (show all)
  timeDisplay: 'utc', // 'utc' | 'local' — set for real by initTimeDisplay() during init(), before anything renders
  currentGroups: new Map(), // this render's summit key -> {alerts, ...}, used by the pinned-summits list to show "alert: ..." without a separate lookup
};

const warnings = createWarnings($id('warnings'));

// Event warnings for the saves the user should hear about.
function warnUnless(ok, key, msg){
  if (ok) warnings.drop(key);
  else warnings.add(msg, key);
}
const saveCandidates = () => warnUnless(store.saveCandidates(state.candidates), 'store-pins',
  'could not save your pinned summits locally (storage full or blocked).');

/* ---------- summit lookup (lookup.js; the order is in AGENTS.md) ---------- */

const loadSummitLookup = lazy(async () => lookupFromRows(await fetchJson(SUMMIT_LOOKUP_URL)), err => {
  console.error('summit lookup data failed to load, falling back to the live API for every summit:', err);
  return new Map(); // empty, not null — don't retry the failing fetch on every resolveSummits() call
});
const loadAllSummits = lazy(() => fetchJson(ALL_SUMMITS_URL));

const resolveSummits = createSummitResolver({
  loadCache: store.loadSummitCache,
  saveCache: cache => warnUnless(store.saveSummitCache(cache), 'store-cache',
    'summit coordinate cache could not be saved locally (storage full or blocked); it will be re-fetched every visit.'),
  loadLookup: loadSummitLookup,
  fetchSummit,
});

/* ---------- actions ---------- */

function setReference(key){
  state.referenceKey = key;
  renderAll();
}

// asReference: also select it as the distance/elevation reference point.
// Setting a reference implies pinning it too — the reference needs its
// own marker on the map (distance/elevation math needs its coordinates
// from state.summitMap, and visually a line to nowhere would be
// confusing), and pinning is what puts an unalerted summit on the map.
function pinCandidate(cand, { asReference = false } = {}){
  if (cand.lat == null || cand.lon == null) return;
  state.candidates.set(cand.key, cand);
  saveCandidates();
  if (asReference) state.referenceKey = cand.key;
  renderAll();
}
function unpinCandidate(key){
  state.candidates.delete(key);
  saveCandidates();
  renderAll();
}

// #all-summits-note is a live region: only write it when the text
// changes, so panning doesn't re-announce the same note on every move.
function setAllSummitsNote(text){
  const note = $id('all-summits-note');
  if (note.textContent !== text) note.textContent = text;
}

let mapView = null; // createMap(), in init()

/* ---------- shareable link ---------- */

function buildShareUrl(){
  const url = new URL(location.href);
  url.search = shareSearch({
    from: $id('range-from').value,
    to: $id('range-to').value,
    ref: state.referenceKey,
    pins: [...state.candidates.keys()],
    bands: [...state.selectedBands],
    modes: [...state.selectedModes],
  });
  url.hash = '';
  return url.toString();
}

// Applies from/ref/pins/bands/modes found in the URL's query string, if
// any, at startup. Pins are *merged* into whatever's already pinned
// locally, never replacing it — opening someone else's shared link
// shouldn't wipe out summits you'd already pinned yourself. Returns
// whether anything was actually applied, so init() knows to force-frame
// the view to it (overriding the "restore my last view" default).
async function applySharedStateFromUrl(){
  const shared = parseShareSearch(location.search);
  if (!shared) return false;

  if (shared.from) $id('range-from').value = shared.from;
  if (shared.to) $id('range-to').value = shared.to;
  if (shared.bands){
    state.selectedBands = new Set(shared.bands);
    store.saveBands(state.selectedBands);
  }
  if (shared.modes){
    state.selectedModes = new Set(shared.modes);
    store.saveModes(state.selectedModes);
  }

  const refKey = shared.ref;
  const pinKeys = new Set(shared.pins);
  // The reference always needs its own marker to mean anything (distance/
  // elevation math needs its coordinates), so make sure it gets resolved
  // as a pin too, same as clicking "set as reference" in a search result.
  if (refKey) pinKeys.add(refKey);

  // Routed through resolveSummits() (static-lookup-first, live API as
  // fallback, concurrency-capped) rather than a raw per-key fetchSummit()
  // loop — a shared link with many pins shouldn't fire an unbounded
  // Promise.all of live requests any more than loading alerts should.
  const toFetch = [...pinKeys].filter(k => !state.candidates.has(k)).map(key => ({ key, ...splitSummitKey(key) }));
  const resolvedMap = await resolveSummits(toFetch, false);
  let anyMissing = false;
  for (const e of toFetch){
    const summit = resolvedMap.get(e.key);
    if (summit) state.candidates.set(e.key, { key: e.key, assoc: e.assoc, code: e.code, ...summit });
    else anyMissing = true;
  }
  if (toFetch.length) saveCandidates();
  if (anyMissing) warnings.add("some summits from the shared link couldn't be found and were skipped.", 'shared-link');

  if (refKey && state.candidates.has(refKey)) state.referenceKey = refKey;
  else if (refKey) warnings.add(`the shared link's reference summit (${refKey}) couldn't be found.`, 'shared-ref');

  // Strip the query string once applied — otherwise it'd linger and go
  // stale the moment anything changes locally; "share" always builds a
  // fresh link from current state rather than treating the URL as live.
  history.replaceState(null, '', location.pathname + location.hash);
  return true;
}

/* ---------- loading ---------- */

async function loadAlerts(){
  try {
    const raw = await fetchAlerts();
    state.rawAlerts = raw.map(normalizeAlert);
    warnings.drop('alerts');
  } catch (err) {
    state.rawAlerts = [];
    warnings.add(`could not load SOTA alerts (${err.message}). If this persists it may be a CORS/network problem — check the browser console.`, 'alerts');
    console.error(err);
  }
  state.bounds = computeDataBounds(state.rawAlerts);
  if (state.bounds){
    const fromEl = $id('range-from');
    const toEl = $id('range-to');
    // SOTA's feed isn't a strict rolling window — most alerts cluster in
    // the next few days, but a handful get posted far in advance (seen
    // live: one alert dated ~2 years out among ~350 mostly-near-term
    // ones). Using the literal max as the default "to" date would make
    // the initial view absurdly wide, so default to a 14-day window from
    // the earliest available date and expose the true bounds via
    // min/max on the inputs so users can still reach further-out alerts.
    fromEl.min = toEl.min = state.bounds.min;
    fromEl.max = toEl.max = state.bounds.max;
    if (!fromEl.value) fromEl.value = state.bounds.min;
    if (!toEl.value) toEl.value = capDefaultToDate(state.bounds.min, state.bounds.max);
  }
}

async function loadSummits(force){
  const groups = groupAlertsBySummit(state.rawAlerts);
  const entries = [...groups.values()].map(g => ({ key: g.key, assoc: g.associationCode, code: g.summitCode }));
  state.summitMap = await resolveSummits(entries, force);
}

/* ---------- rendering ---------- */

// Search-result cards aren't built from the date-filtered alert set
// computed inside renderAll() (they're independent, on-demand lookups),
// so re-derive it the same way, directly from the date inputs on screen.
function alertsForSummitInRange(key){
  return filterAlertsByRange(state.rawAlerts, $id('range-from').value, $id('range-to').value)
    .filter(a => alertSummitKey(a) === key);
}

function checkRangeWarning(from, to, bounds){
  if (!bounds) return;
  if (from < bounds.min || to > bounds.max){
    warnings.add(`SOTA's public alerts feed currently only covers ${bounds.min} – ${bounds.max}; there's no data outside that window (it's a rolling near-term feed, not a historical archive).`);
  }
}

function checkMissingSummits(groups, summitMap){
  const missing = [...groups.values()].filter(g => !summitMap.has(g.key));
  if (missing.length){
    warnings.add(`${missing.length} alert${missing.length === 1 ? '' : 's'} couldn't be placed on the map (summit lookup failed for: ${missing.map(g => g.key).join(', ')}).`);
  }
}

function checkPastRangeNote(to){
  const todayUtc = new Date().toISOString().slice(0, 10);
  if (to && to < todayUtc){
    warnings.add(`You're viewing a fully past date range — SOTA's alerts feed only shows planned activations, not confirmed ones (and this tool doesn't have a historical archive). For a summit's actual activation history, open its popup and use the "sotadata ↗" or "sotl.as ↗" link.`);
  }
}

function renderBandModeFacets(alerts){
  const { bands, modes } = facetsPresent(alerts);
  renderFacetGroup($id('band-checks'), bands, BAND_SORT_ORDER, state.selectedBands);
  renderFacetGroup($id('mode-checks'), modes, MODE_SORT_ORDER, state.selectedModes);
  const active = state.selectedBands.size + state.selectedModes.size;
  $id('btn-toggle-bandmode').textContent = active ? `bands/modes (${active}) ▾` : 'bands/modes ▾';
}

function updateStats(visible, groups, ownSet){
  renderStats($id('stats'), {
    alerts: visible.length,
    onMap: [...groups.values()].filter(g => state.summitMap.has(g.key)).length,
    mine: visible.filter(a => isOwnAlert(a, ownSet)).length,
  });
  const ref = state.referenceKey ? state.summitMap.get(state.referenceKey) : null;
  renderRefIndicator($id('ref-indicator'),
    state.referenceKey ? { name: ref ? ref.name : state.referenceKey, key: state.referenceKey } : null,
    () => setReference(null));
}

// fitView: only true for triggers that legitimately change what should
// be in view (initial load, alerts refresh, date range change) — see
// map.js renderMarkers() for why this matters.
function renderAll(fitView = false){
  warnings.begin();
  try { renderAllParts(fitView); }
  finally { warnings.flush(); }
}
function renderAllParts(fitView){
  const from = $id('range-from').value;
  const to = $id('range-to').value;
  const ownSet = parseOwnCallsigns($id('callsigns-input').value);
  checkPastRangeNote(to);
  const dateFiltered = filterAlertsByRange(state.rawAlerts, from, to);
  checkRangeWarning(from, to, state.bounds);
  // Facet checkboxes are built from the date-filtered set (not yet
  // band/mode-filtered) so all currently-relevant options stay offered
  // regardless of which ones are checked right now.
  renderBandModeFacets(dateFiltered);
  const visible = dateFiltered.filter(a => matchesBandModeFilter(a, state.selectedBands, state.selectedModes));
  const groups = groupAlertsBySummit(visible);
  // Fold in pinned candidate summits that don't already have an alert in
  // this window — search results already carry lat/lon, so no separate
  // per-summit fetch is needed to place them on the map.
  for (const [key, cand] of state.candidates){
    if (!groups.has(key)) groups.set(key, { key, associationCode: cand.assoc, summitCode: cand.code, alerts: [] });
    if (!state.summitMap.has(key)) state.summitMap.set(key, cand);
  }
  checkMissingSummits(groups, state.summitMap);
  state.currentGroups = groups;
  mapView.renderMarkers(groups, { ownSet, fitView });
  const ctx = { ownSet, summitMap: state.summitMap, referenceKey: state.referenceKey, timeDisplay: state.timeDisplay, groups };
  renderAlertList($id('list-items'), visible, ctx, mapView.hover);
  renderCandidatesList($id('candidates-items'), state.candidates, ctx, { hover: mapView.hover, unpin: unpinCandidate });
  mapView.renderAllSummitsOverlay(); // re-exclude/-include summits that just became (un)pinned or the reference
  updateStats(visible, groups, ownSet);
}

/* ---------- summit search / pin panel ---------- */

// Session-only, case-insensitive memoization of search results — retyping/
// backspacing to a term already searched (common while narrowing a query)
// shouldn't re-hit the API for the exact same string.
const summitSearchCache = new Map();
let summitSearchAbortController = null; // cancels a still-in-flight search when a newer one supersedes it, so a slow response to an earlier keystroke can't overwrite a later one's results
let summitSearchDebounceTimer = null; // debounce for auto-search-as-you-type in the "pin a summit" box

const searchPanel = () => $id('search-panel');
const searchStatus = () => $id('search-status');
const hint = text => setSearchHint(searchPanel(), searchStatus(), text);

function clearSearchPanel(){
  const panel = searchPanel();
  panel.replaceChildren();
  panel.classList.remove('show');
  searchStatus().textContent = '';
}

function showCandidates(cands, emptyMsg){
  renderSearchResults(searchPanel(), searchStatus(), cands, emptyMsg, {
    isPinned: key => state.candidates.has(key),
    referenceKey: () => state.referenceKey,
    alertBrief: key => formatAlertsBrief(alertsForSummitInRange(key), state.timeDisplay),
  }, {
    pin: cand => pinCandidate(cand),
    setRef: cand => pinCandidate(cand, { asReference: true }),
  });
}

async function doSummitSearch(term){
  const trimmed = term.trim();
  if (!trimmed){ clearSearchPanel(); return; }

  const cacheKey = trimmed.toLowerCase();
  const cached = summitSearchCache.get(cacheKey);
  if (cached){
    showCandidates(cached.map(candidateFromSearchResult).filter(c => c.lat != null), 'no summits found.');
    return;
  }

  if (summitSearchAbortController) summitSearchAbortController.abort();
  const controller = new AbortController();
  summitSearchAbortController = controller;

  hint('searching…');
  searchPanel().classList.add('show');
  let results;
  try { results = await searchSummits(trimmed, controller.signal); }
  catch (err) {
    if (err.name === 'AbortError') return; // superseded by a newer search
    hint(`search failed (${err.message}).`);
    return;
  }
  summitSearchCache.set(cacheKey, results);
  showCandidates(results.map(candidateFromSearchResult).filter(c => c.lat != null), 'no summits found.');
}

async function doAreaSearch(){
  const bounds = mapView.map.getBounds();
  if (bounds.getNorth() - bounds.getSouth() > AREA_SEARCH_MAX_SPAN_DEG || bounds.getEast() - bounds.getWest() > AREA_SEARCH_MAX_SPAN_DEG){
    hint('zoom in further before searching this area (keeps the query small and fast).');
    searchPanel().classList.add('show');
    return;
  }
  hint('searching OpenStreetMap for tagged summits in view…');
  searchPanel().classList.add('show');
  let elements;
  try { elements = await searchOsmSummitsInView(bounds); }
  catch (err) { hint(`OSM search failed (${err.message}).`); return; }
  const cands = elements.map(candidateFromOsmElement).filter(c => c && c.lat != null);
  showCandidates(cands, 'no OSM-tagged SOTA summits found in this view (coverage is partial — most summits aren\'t tagged in OSM yet).');
}

/* ---------- geolocation ---------- */

// Resolves to {lat, lon} or null — never rejects, so callers don't need
// try/catch for the (expected, non-error) cases of no API, denial, or
// timeout. A short timeout keeps this from blocking the UI noticeably if
// the browser is slow to get a fix or the permission prompt is ignored.
function tryGeolocate(){
  return new Promise(resolve => {
    if (!('geolocation' in navigator)){ resolve(null); return; }
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      () => resolve(null),
      { timeout: 6000, maximumAge: 300000 }
    );
  });
}

// True when the visitor already allowed geolocation for this site, so
// asking for the position shows no prompt. Without the Permissions API
// (Safari < 16) false: then only the "locate me" button asks.
async function geolocationAllowed(){
  try {
    const status = await navigator.permissions.query({ name: 'geolocation' });
    return status.state === 'granted';
  } catch { return false; }
}

/* ---------- theme and time display ----------
   The theme toggle, the stored choice and <html data-theme> are all
   handled by the shared ../shared/js/theme.js (loaded first in <head>).
   Pins, popups and controls follow the theme through CSS variables on
   their own; only the distance line reads a colour (--route) from JS, so
   redraw it when the theme flips (also when the OS theme changes while on
   "auto"). */

function watchTheme(){
  new MutationObserver(() => { if (mapView) mapView.updateDistanceLine(); })
    .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
}

// UTC/local time display — same toggle-group look as the theme switch,
// except changing it needs a re-render (every alert time on screen goes
// through timeDisplayPair(), keyed off state.timeDisplay).
function applyTimeDisplayButtons(){
  document.querySelectorAll('#time-toggle button').forEach(b => {
    const on = b.dataset.timeChoice === state.timeDisplay;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  });
}
function initTimeDisplay(){
  state.timeDisplay = store.loadTimeDisplay();
  applyTimeDisplayButtons();
  document.querySelectorAll('#time-toggle button').forEach(b => {
    b.addEventListener('click', () => {
      state.timeDisplay = b.dataset.timeChoice;
      store.saveTimeDisplay(state.timeDisplay);
      applyTimeDisplayButtons();
      renderAll();
    });
  });
}

/* ---------- event wiring ---------- */

// Enter/Space on a focused alert row (role=button) acts like a click.
// A click without a pointer (detail 0: keyboard, or a screen reader's
// activate) re-renders the list, so focus is put back on the same row
// (or the same row's hidden reference button) afterwards.
function onListRowKeydown(e){
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const item = e.target;
  if (!item.classList || !item.classList.contains('list-item') || item.getAttribute('role') !== 'button') return;
  e.preventDefault(); // Space would scroll the list
  item.click();
}
function refocusListRow(container, item, fromKeyboard){
  if (!fromKeyboard) return;
  const key = item.dataset.summitKey;
  const alertId = item.dataset.alertId;
  const sel = alertId != null
    ? `.list-item[data-alert-id="${CSS.escape(alertId)}"]`
    : `.list-item[data-summit-key="${CSS.escape(key)}"] [data-toggle-ref]`;
  const target = container.querySelector(sel);
  if (target) target.focus();
}

// A row click toggles that summit as the reference. Event delegation:
// the rows are rebuilt on every renderAll(). Candidates have their own
// "remove pin" button, which stops propagation (see view.js) so it doesn't
// also toggle the reference here; their hidden [data-toggle-ref] button
// (keyboard/screen readers) just lets its click bubble up to this.
function wireListToggle(container){
  container.addEventListener('click', e => {
    const item = e.target.closest('.list-item');
    if (!item) return;
    const key = item.dataset.summitKey;
    setReference(state.referenceKey === key ? null : key);
    refocusListRow(container, item, e.detail === 0);
  });
}

// Checkbox groups are rebuilt every render (facet options can change as
// the date range changes), so delegate on the stable container rather
// than binding per-checkbox.
function wireFacetGroup(containerId, selected, save){
  $id(containerId).addEventListener('change', e => {
    if (e.target.type !== 'checkbox') return;
    const set = selected();
    if (e.target.checked) set.add(e.target.value);
    else set.delete(e.target.value);
    save(set);
    renderAll();
  });
}

async function toggleAllSummits(){
  const btn = $id('btn-toggle-all-summits');
  const setPressed = on => { btn.classList.toggle('active', on); btn.setAttribute('aria-pressed', String(on)); };
  const on = btn.getAttribute('aria-pressed') !== 'true';
  setPressed(on);
  mapView.setAllSummits(on);
  if (!on){
    $id('all-summits-note').textContent = '';
    return;
  }
  if (!loadAllSummits.loaded()){
    btn.disabled = true;
    $id('all-summits-note').textContent = 'loading…';
    try { await loadAllSummits(); warnings.drop('all-summits'); }
    catch (err) {
      setPressed(false);
      mapView.setAllSummits(false);
      warnings.add(`could not load the all-summits data (${err.message}). It's a build-time-generated file — if you're running this locally without having run "just fetch", it won't exist yet.`, 'all-summits');
      $id('all-summits-note').textContent = '';
      btn.disabled = false;
      return;
    }
    btn.disabled = false;
  }
  mapView.renderAllSummitsOverlay();
}

function wireEvents(){
  // A changed date range is a deliberate re-scope, so re-frame the view
  // (unlike most other listeners below, which pass no argument and so
  // leave the current pan/zoom alone — see renderAll()'s fitView param).
  $id('range-from').addEventListener('change', () => renderAll(true));
  $id('range-to').addEventListener('change', () => renderAll(true));
  $id('btn-today').addEventListener('click', () => {
    const todayUtc = new Date().toISOString().slice(0, 10);
    $id('range-from').value = todayUtc;
    $id('range-to').value = todayUtc;
    renderAll(true); // date range change: re-frame the view, same as editing the fields directly
  });
  $id('callsigns-input').addEventListener('change', e => {
    warnUnless(store.saveOwnCallsigns(e.target.value), 'store-callsigns',
      'could not save your callsign(s) locally (storage full or blocked) — you\'ll need to re-enter them next visit.');
    renderAll();
  });
  $id('btn-share').addEventListener('click', async () => {
    const btn = $id('btn-share');
    const url = buildShareUrl();
    const original = btn.textContent;
    // Clipboard API, else the shared execCommand fallback (non-secure
    // contexts); if both are blocked, a manually-copyable prompt.
    const copied = await copyToClipboard(url);
    if (!copied) window.prompt('copy this share link:', url);
    btn.textContent = copied ? 'link copied ✓' : 'link ready ✓';
    // the button's text change isn't announced by screen readers; this is
    const status = $id('share-status');
    status.textContent = copied ? 'share link copied to the clipboard' : '';
    setTimeout(() => { btn.textContent = original; status.textContent = ''; }, 2000);
  });
  $id('btn-open-sotlas').addEventListener('click', () => {
    window.open(mapView.sotlasUrl(), '_blank', 'noopener');
  });
  $id('btn-locate').addEventListener('click', async () => {
    const btn = $id('btn-locate');
    btn.disabled = true;
    const loc = await tryGeolocate();
    btn.disabled = false;
    if (loc){ state.userLocation = loc; mapView.map.setView([loc.lat, loc.lon], USER_LOCATION_ZOOM); warnings.drop('locate'); }
    else warnings.add('could not determine your location (denied, unavailable, or timed out).', 'locate');
  });
  $id('btn-refresh-alerts').addEventListener('click', async () => {
    await loadAlerts();
    await loadSummits(false);
    renderAll(true); // whole alert set just changed, re-frame to it
  });
  $id('btn-refresh-summits').addEventListener('click', async () => {
    await loadSummits(true);
    renderAll();
  });
  $id('btn-toggle-toolbar').addEventListener('click', () => {
    const btn = $id('btn-toggle-toolbar');
    const shown = $id('toolbar-controls').classList.toggle('show');
    btn.setAttribute('aria-expanded', String(shown));
    btn.textContent = shown ? 'filters ▴' : 'filters ▾';
  });
  $id('btn-toggle-list').addEventListener('click', e => {
    const shown = $id('list-panel').classList.toggle('show');
    e.currentTarget.setAttribute('aria-expanded', String(shown));
  });
  $id('btn-toggle-bandmode').addEventListener('click', e => {
    const shown = $id('bandmode-panel').classList.toggle('show');
    e.currentTarget.setAttribute('aria-expanded', String(shown));
  });
  $id('btn-toggle-all-summits').addEventListener('click', toggleAllSummits);
  $id('btn-clear-bandmode').addEventListener('click', () => {
    state.selectedBands.clear();
    state.selectedModes.clear();
    store.saveBands(state.selectedBands);
    store.saveModes(state.selectedModes);
    renderAll();
  });
  wireFacetGroup('band-checks', () => state.selectedBands, store.saveBands);
  wireFacetGroup('mode-checks', () => state.selectedModes, store.saveModes);
  wireListToggle($id('list-items'));
  $id('list-items').addEventListener('keydown', onListRowKeydown);
  wireListToggle($id('candidates-items'));
  $id('btn-summit-search').addEventListener('click', () => {
    clearTimeout(summitSearchDebounceTimer);
    doSummitSearch($id('summit-search').value);
  });
  $id('summit-search').addEventListener('keydown', e => {
    if (e.key === 'Enter'){ clearTimeout(summitSearchDebounceTimer); doSummitSearch(e.target.value); }
  });
  // Auto-search once there's enough to search for, debounced so it fires
  // after typing pauses rather than on every keystroke (polite to the
  // API, and avoids a flash of "no summits found" for a term still being
  // typed). Below 3 characters, clear any stale results instead of
  // leaving an outdated list on screen — Enter/the button still work
  // regardless of length if you want to search a 1-2 character term.
  $id('summit-search').addEventListener('input', e => {
    clearTimeout(summitSearchDebounceTimer);
    const term = e.target.value.trim();
    if (term.length < 3){
      clearSearchPanel();
      return;
    }
    summitSearchDebounceTimer = setTimeout(() => doSummitSearch(term), 350);
  });
  $id('btn-area-search').addEventListener('click', doAreaSearch);
}

/* ---------- init ---------- */

async function init(){
  watchTheme();
  initTimeDisplay();
  mapView = createMap($id('map'), {
    state,
    setReference,
    pin: pinCandidate,
    unpin: unpinCandidate,
    setAllSummitsNote,
    allSummits: loadAllSummits.loaded,
  });
  $id('callsigns-input').value = store.loadOwnCallsigns();
  wireEvents();
  // A returning visitor's restored view (see map.js / store.loadMapView())
  // takes priority over both of these — geolocation and the initial
  // fit-to-alerts are both "we have nothing better to go on" fallbacks
  // for a first-time visitor, not something that should override a view
  // the visitor already chose and left behind last time.
  const hasSavedView = !!store.loadMapView();
  // A shared link (see applySharedStateFromUrl()) explicitly asks to look
  // at something specific, which should win over "restore my last view"
  // the same way it wins over "start from nothing" — reassigned below
  // once we know; read by the geolocation callback via closure, so it's
  // declared before that's registered.
  let appliedSharedState = false;
  // No permission prompt on page load (browsers advise against it, and
  // Safari remembers a reflexive "deny"): the position is only asked for
  // via the "locate me" button, or used here when the visitor allowed it
  // before. Not awaited: a fix can take a while and shouldn't block
  // loading alerts. If it resolves before there's anything else to show,
  // use it; if after, it's a no-op (real data already framed the view —
  // see renderMarkers()).
  geolocationAllowed().then(ok => (ok ? tryGeolocate() : null)).then(loc => {
    state.userLocation = loc;
    if (loc && !hasSavedView && !appliedSharedState && !mapView.hasMarkers()){
      mapView.map.setView([loc.lat, loc.lon], USER_LOCATION_ZOOM);
    }
  });
  appliedSharedState = await applySharedStateFromUrl();
  await loadAlerts();
  await loadSummits(false);
  // first-ever visit or a shared link: frame to whatever's there;
  // otherwise (returning visitor, no shared link) keep their restored view
  renderAll(appliedSharedState || !hasSavedView);
}

init();
