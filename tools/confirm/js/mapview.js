// Offline map of the open log: vector outline basemap (data/vienna-map.json,
// built by scripts/build_map_data.py) drawn by the vendored Leaflet
// (../shared/vendor/leaflet, a classic script defining globalThis.L), one pin per
// station, the own position highlighted, log details on hover/tap.
// No tile layers, no image icons — nothing is ever requested.

import { el, fill } from './dom.js';
import { loadDataFile } from './data.js';
import { stationsForMap, ownPosition, maidenheadGridLines } from './mapdata.js';
import { mapLinks } from './sources.js';

const MAP_ATTRIBUTION = 'Bezirke: Stadt Wien (CC BY 4.0) · Straßen, Gewässer: © OpenStreetMap-Mitwirkende (ODbL) · Leaflet';
const ROAD_WEIGHT = { motorway: 3, trunk: 2.5, primary: 1.8, secondary: 1.1 };
// Touch screens have no hover: popups only (a tooltip would open as well).
const canHover = () => globalThis.matchMedia?.('(hover: hover)').matches ?? true;
const narrow = () => globalThis.matchMedia?.('(max-width: 640px)').matches ?? false;

let mapInst = null;
let baseData = null;
let pinGroup = null;
let ownGroup = null;
let baseGroups = null;
let lastCtx = null;
let fittedFor = null;
let lastOwnKey = null;

function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function palette() {
  return {
    line: cssVar('--text-dim', '#888'),
    text: cssVar('--text', '#222'),
    fill: cssVar('--bg-raised', '#f5f5f5'),
    bg: cssVar('--bg', '#fff'),
    accent: cssVar('--accent', '#526cfe'),
    warn: cssVar('--warn', '#9a6700'),
    water: '#4a90d9',
  };
}

function drawBase() {
  const L = globalThis.L;
  const c = palette();
  baseGroups?.forEach(g => g.remove());
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
    L.polyline(r.p, { color: c.line, weight: ROAD_WEIGHT[r.c] || 1, opacity: 0.45, interactive: false }).addTo(roads);
  }
  const grid = L.layerGroup();
  const g = maidenheadGridLines(baseData.bounds, 6);
  for (const line of g.lines) L.polyline(line, { color: c.accent, weight: 0.8, opacity: 0.5, dashArray: '4 4', interactive: false }).addTo(grid);
  for (const lab of g.labels) {
    L.tooltip({ permanent: true, direction: 'center', className: 'map-grid-label', interactive: false })
      .setLatLng([lab.lat, lab.lon]).setContent(lab.loc).addTo(grid);
  }
  baseGroups = [districts, water, roads, grid];
  water.addTo(mapInst);
  roads.addTo(mapInst);
  districts.addTo(mapInst);
  mapInst._layersCtl?.remove();
  // Expanded on wide screens; collapsed on phones, where the toggle shows the
  // text "Ebenen" (CSS) instead of Leaflet's PNG icon.
  mapInst._layersCtl = L.control.layers(null, { Bezirke: districts, Gewässer: water, Straßen: roads, 'Maidenhead-Raster': grid },
    { collapsed: narrow(), position: 'topright' }).addTo(mapInst);
}

const TIP_CHECKINS = 3; // newest check-ins listed on a card

// Short card: call and name, where, and the latest check-ins in one line
// each (the table has the full details). withLinks: Google Maps / OSM links
// (popup only — the hover tooltip can't be clicked).
function stationTip(s, ctx, withLinks = false) {
  const loc = s.loc;
  const name = ctx.callInfo(s.call);
  const n = s.checkins.length;
  const shown = s.checkins.slice(-TIP_CHECKINS);
  return el('div', { class: 'pin-tip-body' },
    el('div', { class: 'pin-tip-head' }, el('b', {}, s.call), n > 1 ? ` ${n}×` : null, name ? ` – ${name}` : null),
    el('div', { class: 'pin-tip-loc' }, `${loc.label}${loc.postcode && !loc.label.includes(loc.postcode) ? ', ' + loc.postcode : ''} · ${loc.maidenhead}`,
      loc.confidence === 'low' || loc.confidence === 'ambiguous' ? el('span', { class: 'pin-tip-warn' }, ' (unsicher)') : null),
    el('ul', {}, n > shown.length ? el('li', { class: 'pin-tip-more' }, `+ ${n - shown.length} frühere`) : null,
      shown.map(e => el('li', {}, ctx.describe(e)))),
    withLinks ? mapLinks(loc) : null);
}

function drawPins(ctx) {
  const L = globalThis.L;
  const { placed, unplaced } = stationsForMap(ctx.entries);
  pinGroup.clearLayers();
  const pts = [];
  for (const s of placed) {
    const n = s.checkins.length;
    const weak = s.loc.confidence === 'low' || s.loc.confidence === 'ambiguous';
    const icon = L.divIcon({
      className: `map-pin${weak ? ' weak' : ''}`,
      html: n > 1 ? `<span>${n}</span>` : '',
      iconSize: [18, 18],
      iconAnchor: [9, 9],
    });
    const m = L.marker([s.loc.lat, s.loc.lon], { icon, title: s.call, keyboard: true, riseOnHover: true });
    if (canHover()) m.bindTooltip(() => stationTip(s, ctx), { sticky: true, direction: 'top', className: 'pin-tip', offset: [0, -8] });
    m.bindPopup(() => stationTip(s, ctx, true), { className: 'pin-tip', maxWidth: 280, autoPanPadding: [24, 24] });
    m.on('click', () => ctx.onPick(s.call));
    m.addTo(pinGroup);
    pts.push([s.loc.lat, s.loc.lon]);
  }
  fill(document.getElementById('map-unplaced'), unplaced.length
    ? `${unplaced.length} Station${unplaced.length > 1 ? 'en' : ''} ohne zugeordneten Standort: ${unplaced.map(s => s.call).join(', ')}`
    : placed.length ? '' : 'Noch keine Stationen mit zugeordnetem Standort.');
  return pts;
}

async function drawOwn(ctx) {
  const L = globalThis.L;
  ownGroup.clearLayers();
  const qth = ctx.header?.myQth ? await ctx.resolve(ctx.header.myQth) : null;
  const own = ownPosition(ctx.header, qth);
  if (!own) return null;
  if (own.bounds) {
    const b = own.bounds;
    L.rectangle([[b.south, b.west], [b.north, b.east]], { color: palette().warn, weight: 1.5, dashArray: '5 4', fillOpacity: 0.06, interactive: false }).addTo(ownGroup);
  }
  const who = [ctx.header.station && `Station ${ctx.header.station}`, ctx.header.operator && `Op ${ctx.header.operator}`].filter(Boolean).join(', ');
  const text = `Eigener Standort${who ? ' – ' + who : ''}: ${own.label}${own.source === 'locator' ? ' (Locator-Mitte)' : ''}`;
  const m = L.marker([own.lat, own.lon], {
    icon: L.divIcon({ className: 'map-own', html: '<span>★</span>', iconSize: [28, 28], iconAnchor: [14, 14] }),
    title: 'Eigener Standort', zIndexOffset: 1000, keyboard: true,
  });
  if (canHover()) m.bindTooltip(text, { direction: 'top', className: 'pin-tip', offset: [0, -12] });
  m.bindPopup(text, { className: 'pin-tip' });
  m.addTo(ownGroup);
  return [own.lat, own.lon];
}

async function render(ctx, refit) {
  lastCtx = ctx;
  const pts = drawPins(ctx);
  const own = await drawOwn(ctx);
  if (own) pts.push(own);
  // Fit once per log, when explicitly asked, and when the own position
  // changes (so a newly entered QTH is in view) — not on every new entry.
  const ownKey = own ? own.join(',') : '';
  const ownMoved = lastOwnKey !== null && ownKey !== lastOwnKey;
  lastOwnKey = ownKey;
  if (refit || ownMoved || fittedFor !== ctx.event.id) {
    fittedFor = ctx.event.id;
    if (pts.length > 1) mapInst.fitBounds(pts, { padding: [48, 48], maxZoom: 15 });
    else if (pts.length === 1) mapInst.setView(pts[0], 14);
    else mapInst.fitBounds(baseData.bounds);
  }
}

export function mapVisible() {
  const panel = document.getElementById('map-panel');
  return !!panel && !panel.hidden;
}

// ctx: { event, header, entries, describe(e), callInfo(call), resolve(text) -> result|null, onPick(call) }
export async function openMap(ctx) {
  const panel = document.getElementById('map-panel');
  panel.hidden = false;
  if (!globalThis.L) {
    fill(document.getElementById('map-unplaced'), 'Kartenbibliothek nicht geladen.');
    return;
  }
  if (!baseData) baseData = await loadDataFile('vienna-map.json');
  if (!baseData) {
    fill(document.getElementById('map-unplaced'), 'Kartendaten nicht verfügbar (nicht gebaut?).');
    return;
  }
  if (!mapInst) {
    const L = globalThis.L;
    mapInst = L.map('map', { zoomSnap: 0.25, minZoom: 9, maxZoom: 18, attributionControl: true, maxBounds: L.latLngBounds(baseData.bounds).pad(0.6) });
    mapInst.attributionControl.setPrefix(false);
    mapInst.attributionControl.addAttribution(MAP_ATTRIBUTION);
    drawBase();
    pinGroup = L.layerGroup().addTo(mapInst);
    ownGroup = L.layerGroup().addTo(mapInst);
    // Re-colour the basemap when the light/dark theme changes.
    new MutationObserver(() => { drawBase(); if (lastCtx) render(lastCtx, false); })
      .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }
  mapInst.invalidateSize();
  await render(ctx, true);
}

export function closeMap() {
  document.getElementById('map-panel').hidden = true;
}

// Called after every log change; cheap no-op while the map is closed.
export function refreshMap(ctx) {
  if (mapInst && mapVisible()) render(ctx, false);
}
