// The offline base map of Vienna for Confirm and Notfunk: a vector outline
// (tools/shared/data/vienna-map.json, built by scripts/build_map_data.py)
// drawn by the vendored Leaflet (../vendor/leaflet, a classic script that
// defines globalThis.L): districts, water, main roads, the Maidenhead and
// UTM grids (mapgrid.js), switchable in a layer control. No tile layers, no
// image icons: nothing is ever requested. Each tool draws its own pins on
// top (confirm/js/mapview.js, notfunk/js/mapview.js).

import { loadDataFile } from './data.js';
import { maidenheadGridLines, utmGridLines } from './mapgrid.js';

const BASEMAP_ATTRIBUTION = 'Bezirke: Stadt Wien (CC BY 4.0) · Straßen, Gewässer: © OpenStreetMap-Mitwirkende (ODbL) · Leaflet';
const BASEMAP_ROAD_WEIGHT = { motorway: 3, trunk: 2.5, primary: 1.8, secondary: 1.1 };

// Touch screens have no hover: popups only (a tooltip would open as well).
export const basemapCanHover = () => globalThis.matchMedia?.('(hover: hover)').matches ?? true;
const basemapNarrow = () => globalThis.matchMedia?.('(max-width: 640px)').matches ?? false;

function basemapCssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

// The colours of the current theme (light/dark) for the map's lines.
export function basemapPalette() {
  return {
    line: basemapCssVar('--text-dim', '#888'),
    text: basemapCssVar('--text', '#222'),
    fill: basemapCssVar('--bg-raised', '#f5f5f5'),
    bg: basemapCssVar('--bg', '#fff'),
    accent: basemapCssVar('--accent', '#4560f0'),
    warn: basemapCssVar('--warn', '#9a6700'),
    err: basemapCssVar('--err', '#c62828'),
    water: '#4a90d9',
  };
}

// The base data (null: not built, or not readable).
export function loadBasemapData() {
  return loadDataFile('vienna-map.json');
}

// A Leaflet map in `container` (an element id) with the base layers.
// onTheme(): called after the light/dark theme changed and the base was
// re-coloured, for the tool to re-colour its pins. -> the L.map.
export function createBasemap(container, baseData, onTheme) {
  const L = globalThis.L;
  const map = L.map(container, { zoomSnap: 0.25, minZoom: 9, maxZoom: 18, attributionControl: true, maxBounds: L.latLngBounds(baseData.bounds).pad(0.6) });
  map.attributionControl.setPrefix(false);
  map.attributionControl.addAttribution(BASEMAP_ATTRIBUTION);
  let groups = null;
  let control = null;
  const draw = () => {
    const c = basemapPalette();
    groups?.forEach(g => g.remove());
    const districts = L.layerGroup();
    for (const d of baseData.districts) {
      L.polygon(d.rings, { color: c.line, weight: 1.2, opacity: 0.7, fillColor: c.fill, fillOpacity: 0.35, interactive: false }).addTo(districts);
      L.tooltip({ permanent: true, direction: 'center', className: 'map-district', interactive: false })
        .setLatLng(d.label).setContent(`${d.nr}`).addTo(districts);
    }
    const water = L.layerGroup();
    for (const w of baseData.water) {
      L.polygon(w.rings, { stroke: false, fillColor: c.water, fillOpacity: 0.45, interactive: false }).addTo(water);
    }
    const roads = L.layerGroup();
    for (const r of baseData.roads) {
      // quiet enough for the pins to stand out
      L.polyline(r.p, { color: c.line, weight: BASEMAP_ROAD_WEIGHT[r.c] || 1, opacity: 0.35, interactive: false }).addTo(roads);
    }
    const grid = L.layerGroup();
    const g = maidenheadGridLines(baseData.bounds, 6);
    for (const line of g.lines) L.polyline(line, { color: c.accent, weight: 0.8, opacity: 0.5, dashArray: '4 4', interactive: false }).addTo(grid);
    for (const lab of g.labels) {
      L.tooltip({ permanent: true, direction: 'center', className: 'map-grid-label', interactive: false })
        .setLatLng([lab.lat, lab.lon]).setContent(lab.loc).addTo(grid);
    }
    // UTM grid (1 km, 10 km lines stronger and labelled with their square).
    const utm = L.layerGroup();
    const u = utmGridLines(baseData.bounds, 1000);
    for (const line of u.lines) {
      L.polyline(line.p, { color: c.warn, weight: line.major ? 1.2 : 0.6, opacity: line.major ? 0.7 : 0.4, interactive: false }).addTo(utm);
    }
    for (const lab of u.labels) {
      L.tooltip({ permanent: true, direction: 'center', className: 'map-grid-label', interactive: false })
        .setLatLng([lab.lat, lab.lon]).setContent(lab.text).addTo(utm);
    }
    groups = [districts, water, roads, grid, utm];
    water.addTo(map);
    roads.addTo(map);
    districts.addTo(map);
    control?.remove();
    // Expanded on wide screens; collapsed on phones, where the toggle shows
    // the text "Ebenen" (CSS) instead of Leaflet's PNG icon.
    control = L.control.layers(null, { Bezirke: districts, Gewässer: water, Straßen: roads, 'Maidenhead-Raster': grid, 'UTM-Raster (1 km)': utm },
      { collapsed: basemapNarrow(), position: 'topright' }).addTo(map);
  };
  draw();
  // Re-colour the basemap when the light/dark theme changes.
  new MutationObserver(() => { draw(); onTheme?.(); })
    .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return map;
}
