// The Leaflet map (global L, ../shared/vendor/leaflet/): base layers, the
// summit markers with their hover/click popups, the distance line to the
// reference, and the "all summits" overlay.

import { alertPopup, allSummitPopup } from './view.js';
import { isOwnAlert } from './alerts.js';
import { sotlasPointsColor, sotlasMapUrl, splitSummitKey } from './summits.js';
import { loadMapView, saveMapView, loadBaseLayer, saveBaseLayer } from './store.js';

export const USER_LOCATION_ZOOM = 9; // regional view, not street-level — shared by every "center on me" case (initial geolocation, empty-state fallback, the "locate me" button) so they stay consistent
const ALL_SUMMITS_MIN_ZOOM = 9; // below this, a viewport can contain tens of thousands of summits — ask to zoom in rather than choke the renderer
const ALL_SUMMITS_MAX_MARKERS = 800;

const PIN_SVG = '<svg viewBox="0 0 26 34" xmlns="http://www.w3.org/2000/svg">' +
  '<path d="M13 0C5.8 0 0 5.8 0 13c0 9 13 21 13 21s13-12 13-21C26 5.8 20.2 0 13 0z" stroke="#fff" stroke-width="1.5"/>' +
  '<circle cx="13" cy="13" r="5"/></svg>';

const SOTA_CREDIT = 'alert &amp; summit data via SOTA (unofficial)';

function cssVar(name){
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function markerIcon(isOwn, isRef, isCandidate){
  const cls = ['sota-pin', isOwn ? 'own' : 'default', isRef ? 'reference' : '', isCandidate ? 'candidate' : ''].filter(Boolean).join(' ');
  // Reference and candidate pins are drawn larger than a plain default
  // one (see the CSS .sota-pin.reference/.candidate rules; reference
  // wins if a summit is both) — iconSize/iconAnchor/popupAnchor must
  // match whichever size actually applies or Leaflet's positioning math
  // (which anchor point sits on the real lat/lon) will be based on the
  // wrong box and the pin will look slightly offset from where it's
  // actually pointing. Only fixed class names and the fixed SVG here.
  const [w, h] = isRef ? [32, 42] : isCandidate ? [28, 37] : [26, 34];
  return L.divIcon({
    className: '',
    html: `<div class="${cls}">${PIN_SVG}</div>`,
    iconSize: [w, h],
    iconAnchor: [w / 2, h],
    popupAnchor: [0, -Math.round(h * 30 / 34)],
  });
}

// app: { state, setReference(key|null), pin(cand, opts), unpin(key),
//        setAllSummitsNote(text), allSummits() (the loaded overlay data or null) }
export function createMap(container, app){
  const { state } = app;
  let distanceLine = null;   // the polyline+label currently shown between the reference and a hovered/opened summit
  let hoveredKey = null;     // summit key currently under the mouse (map marker or list item), if any
  let pinnedPopupKey = null; // summit key whose popup was explicitly clicked open — stays open on mouseout regardless of hover, until closed via the popup's own control or by opening a different one
  let openPopupKey = null;   // summit key whose popup is currently open, if any
  let popupCloseTimer = null; // debounce for hover-close, so moving from a marker into its own popup content doesn't slam it shut first
  let allSummitsEnabled = false;

  const savedView = loadMapView();
  const map = L.map(container, { worldCopyJump: true })
    .setView(savedView ? [savedView.lat, savedView.lng] : [47, 10], savedView ? savedView.zoom : 4);
  map.on('moveend', () => { const c = map.getCenter(); saveMapView(c.lat, c.lng, map.getZoom()); });

  // OpenTopoMap is the default: a community OSM+SRTM-derived render with
  // contour lines and trails, much more useful for summit/hiking context
  // than plain OSM streets-and-buildings tiles (sotl.as itself uses a
  // similar "outdoor" style, via a keyed commercial vector provider —
  // OpenTopoMap gets a comparable look from free, key-less raster tiles).
  // OpenTopoMap's required credit: the OSM data, SRTM elevation data and
  // the map style (CC-BY-SA), see opentopomap.org/about.
  const topo = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
    maxZoom: 17,
    subdomains: 'abc',
    attribution: 'Map data: &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors, SRTM · ' +
      'map style: &copy; <a href="https://opentopomap.org/" target="_blank" rel="noopener">OpenTopoMap</a> (<a href="https://creativecommons.org/licenses/by-sa/3.0/" target="_blank" rel="noopener">CC-BY-SA</a>) · ' + SOTA_CREDIT,
  });
  // OSM serves its tiles from one host; the a/b/c subdomains are deprecated.
  const streets = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors · ' + SOTA_CREDIT,
  });
  // basemap.at: Austria's official survey basemap (BEV/geoland), free,
  // key-less, CORS-open — but Austria-only, so it's an alternate choice
  // rather than the global default. Its tile path order is z/y/x (not
  // the usual z/x/y), hence the swapped placeholders below.
  // Host + URL confirmed against the service's own live WMTS
  // GetCapabilities document (mapsneu.wien.gv.at/basemapneu/1.0.0/
  // WMTSCapabilities.xml), which declares this exact template with no
  // subdomain scheme — the "maps1"–"maps4" load-balancing subdomains
  // from older third-party examples no longer even resolve (verified via
  // DNS lookup: NXDOMAIN). `bounds` keeps Leaflet from even trying to
  // fetch tiles outside Austria's rough extent, since alerts are shown
  // worldwide but this layer only covers one country.
  const basemapAt = L.tileLayer('https://mapsneu.wien.gv.at/basemap/geolandbasemap/normal/google3857/{z}/{y}/{x}.png', {
    maxZoom: 19,
    bounds: L.latLngBounds([46.3, 9.4], [49.1, 17.3]),
    attribution: 'Grundkarte: <a href="https://basemap.at/" target="_blank" rel="noopener">basemap.at</a> · ' + SOTA_CREDIT,
  });

  const baseLayers = { 'Outdoor (OpenTopoMap)': topo, 'Streets (OpenStreetMap)': streets, 'Austria (basemap.at)': basemapAt };
  const savedLayerName = loadBaseLayer();
  (Object.hasOwn(baseLayers, savedLayerName) ? baseLayers[savedLayerName] : topo).addTo(map);
  L.control.layers(baseLayers, null, { position: 'topright' }).addTo(map);
  map.on('baselayerchange', e => saveBaseLayer(e.name));

  const markerLayer = L.layerGroup().addTo(map);

  // A single shared canvas renderer for the "all summits" overlay —
  // Leaflet's default per-marker SVG rendering visibly lags once you're
  // placing hundreds of circle markers; routing them through one canvas
  // element instead keeps it smooth.
  const allSummitsRenderer = L.canvas();
  const allSummitsLayer = L.layerGroup();
  map.on('moveend', () => { if (allSummitsEnabled) renderAllSummitsOverlay(); });

  // Draws (or removes) the reference→other distance line. Hover takes
  // priority over an open popup so mousing over a different summit while
  // another's popup is open previews that one instead; moving away falls
  // back to the open popup's line, if any. Distance/elevation/activator
  // details live in the summit's own popup (which opens on hover too)
  // rather than a separate floating label.
  function updateDistanceLine(){
    if (distanceLine){ map.removeLayer(distanceLine); distanceLine = null; }
    const otherKey = hoveredKey || openPopupKey;
    if (!state.referenceKey || !otherKey || otherKey === state.referenceKey) return;
    const ref = state.summitMap.get(state.referenceKey);
    const other = state.summitMap.get(otherKey);
    if (!ref || !other) return;
    const latlngs = [[ref.lat, ref.lon], [other.lat, other.lon]];
    // A single --warn line (matching the reference marker) blends into
    // OpenTopoMap's browns/greens/contours. Use a dedicated --route color
    // instead, plus a wider white "halo" line underneath (the standard
    // GPS-track trick) so it stays legible over any basemap.
    const halo = L.polyline(latlngs, { color: '#fff', weight: 6, opacity: 0.85, interactive: false });
    const line = L.polyline(latlngs, { color: cssVar('--route'), weight: 3, dashArray: '6 4', interactive: false });
    distanceLine = L.layerGroup([halo, line]).addTo(map);
  }

  // A list row or marker under the mouse (on) or left (off).
  function hover(key, on){
    if (on) hoveredKey = key;
    else if (hoveredKey === key) hoveredKey = null;
    updateDistanceLine();
  }

  // Hover-to-open popups need a debounced close: mousing from the marker
  // icon onto the popup box itself (to click a link/button in it) fires
  // the marker's mouseout immediately, which would otherwise slam the
  // popup shut before the click can land.
  function scheduleClosePopup(marker){
    clearTimeout(popupCloseTimer);
    popupCloseTimer = setTimeout(() => marker.closePopup(), 200);
  }
  function cancelClosePopup(){
    clearTimeout(popupCloseTimer);
  }

  // ctx: { ownSet, fitView }
  function renderMarkers(groups, { ownSet, fitView }){
    const { summitMap, referenceKey, candidates } = state;
    if (distanceLine){ map.removeLayer(distanceLine); distanceLine = null; }
    hoveredKey = null;
    openPopupKey = null;
    pinnedPopupKey = null;
    markerLayer.clearLayers();
    const bounds = [];
    for (const group of groups.values()){
      const summit = summitMap.get(group.key);
      if (!summit) continue;
      const isOwn = group.alerts.some(a => isOwnAlert(a, ownSet));
      const isCandidate = candidates.has(group.key);
      const on = {
        setRef: () => app.setReference(group.key),
        clearRef: () => app.setReference(null),
        pin: () => {
          const s = state.summitMap.get(group.key);
          if (s) app.pin({ key: group.key, ...splitSummitKey(group.key), ...s });
        },
        unpin: () => app.unpin(group.key),
      };
      // autoPan:false — Leaflet's default popup behavior pans the map to
      // keep it in view when opened, which is fine for a deliberate click
      // but would otherwise yank the view around as you casually hover
      // markers near the edge of the screen.
      const marker = L.marker([summit.lat, summit.lon], { icon: markerIcon(isOwn, group.key === referenceKey, isCandidate) })
        .bindPopup(() => alertPopup(group, summit,
          { ownSet, referenceKey, summitMap, isCandidate, timeDisplay: state.timeDisplay }, on), { autoPan: false })
        .addTo(markerLayer);
      // Leaflet makes the marker a focusable button (keyboard: true); give
      // it a name, since the pin itself is only an SVG.
      marker.getElement()?.setAttribute('aria-label',
        `${group.key}: ${group.alerts.length} alert${group.alerts.length === 1 ? '' : 's'} — Enter shows details`);
      // Hovering shows the full info card, not just a click — opens on
      // mouseover, closes (debounced) on mouseout so moving the cursor
      // from the marker into the popup itself to click a link/button
      // doesn't slam it shut first (see scheduleClosePopup()). A click
      // *pins* it open regardless of hover (pinnedPopupKey) — closing then
      // only happens via the popup's own close button, clicking elsewhere
      // on the map, or clicking a different marker (Leaflet's default
      // one-popup-at-a-time behavior), never just from the mouse leaving.
      // The hover/pin also previews the distance/elevation line to the
      // reference, if one is set (see updateDistanceLine()).
      marker.on('click', () => {
        pinnedPopupKey = group.key;
        marker.openPopup();
      });
      marker.on('mouseover', () => {
        hoveredKey = group.key;
        cancelClosePopup();
        marker.openPopup();
        updateDistanceLine();
      });
      marker.on('mouseout', () => {
        if (hoveredKey === group.key) hoveredKey = null;
        if (pinnedPopupKey !== group.key) scheduleClosePopup(marker);
        updateDistanceLine();
      });
      marker.on('popupopen', (e) => {
        openPopupKey = group.key;
        updateDistanceLine();
        const el = e.popup.getElement();
        if (el){
          el.addEventListener('mouseenter', cancelClosePopup);
          el.addEventListener('mouseleave', () => { if (pinnedPopupKey !== group.key) scheduleClosePopup(marker); });
          // Opened from the keyboard (Enter on the focused marker): move
          // focus into the popup, or its buttons would only come after
          // every other marker in the Tab order.
          if (document.activeElement === marker.getElement()) el.querySelector('button, a[href]')?.focus();
        }
      });
      marker.on('popupclose', (e) => {
        // closed (Esc, ✕, an action) while focus was inside: back to the marker
        const el = e.popup.getElement();
        if (el && el.contains(document.activeElement)) marker.getElement()?.focus();
        if (openPopupKey === group.key) openPopupKey = null;
        if (pinnedPopupKey === group.key) pinnedPopupKey = null;
        updateDistanceLine();
      });
      bounds.push([summit.lat, summit.lon]);
    }
    // Only re-frame the view on triggers that actually changed *what
    // should be in view* (initial load, alerts refresh, date range
    // change) — not on every render, or incidental UI actions (setting a
    // reference, toggling a band/mode filter, pinning a candidate) would
    // keep yanking the zoom/pan around.
    if (!fitView) return;
    if (bounds.length){
      map.fitBounds(bounds, { padding: [30, 30], maxZoom: 11 });
    } else if (state.userLocation){
      // Nothing to fit bounds to (e.g. an empty date range, or candidates-
      // only with none pinned yet) — fall back to the visitor's own
      // location rather than leaving the map wherever it happened to be.
      map.setView([state.userLocation.lat, state.userLocation.lon], USER_LOCATION_ZOOM);
    }
  }

  /* "all summits" overlay: built at site build time (data/summits.json,
     see api.js and AGENTS.md), never SOTA's API. */

  function renderAllSummitsOverlay(){
    allSummitsLayer.clearLayers();
    const data = app.allSummits();
    if (!allSummitsEnabled || !data){ app.setAllSummitsNote(''); return; }
    if (map.getZoom() < ALL_SUMMITS_MIN_ZOOM){
      app.setAllSummitsNote('zoom in further to show all summits here');
      return;
    }
    const bounds = map.getBounds();
    // Skip anything already shown as a "real" pin (alerted, pinned, or the
    // reference) — those already have their own, more prominent marker;
    // showing a second dim dot underneath would just be visual clutter.
    const inView = data.filter(s => bounds.contains([s.lat, s.lon]) && !state.summitMap.has(s.key));
    if (inView.length > ALL_SUMMITS_MAX_MARKERS){
      app.setAllSummitsNote(`${inView.length} summits in view — zoom in further to show them`);
      return;
    }
    app.setAllSummitsNote('');
    for (const entry of inView){
      const marker = L.circleMarker([entry.lat, entry.lon], {
        renderer: allSummitsRenderer,
        radius: 9,
        weight: 2,
        color: '#fff',
        fillColor: sotlasPointsColor(entry.points),
        fillOpacity: 0.8,
      });
      const cand = () => ({ ...entry, ...splitSummitKey(entry.key) });
      // a function, not a node: re-evaluated on each open so pin/reference state stays current
      marker.bindPopup(() => allSummitPopup(entry,
        { pinned: state.candidates.has(entry.key), isRef: entry.key === state.referenceKey }, {
          setRef: () => { app.pin(cand(), { asReference: true }); marker.closePopup(); },
          clearRef: () => { app.setReference(null); marker.closePopup(); },
          pin: () => { app.pin(cand()); marker.closePopup(); },
          unpin: () => { app.unpin(entry.key); marker.closePopup(); },
        }));
      marker.addTo(allSummitsLayer);
    }
  }

  // Switch the overlay on (the data must be loaded) or off.
  function setAllSummits(on){
    allSummitsEnabled = on;
    if (on){
      allSummitsLayer.addTo(map);
    } else {
      allSummitsLayer.clearLayers();
      map.removeLayer(allSummitsLayer);
    }
  }

  return {
    map,
    updateDistanceLine,
    hover,
    renderMarkers,
    renderAllSummitsOverlay,
    setAllSummits,
    hasMarkers: () => markerLayer.getLayers().length > 0,
    sotlasUrl: () => { const c = map.getCenter(); return sotlasMapUrl(c.lat, c.lng, map.getZoom()); },
  };
}
