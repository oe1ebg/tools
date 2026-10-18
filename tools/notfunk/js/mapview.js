// The Notfunk map ("Karte" in the message book): the messages of the
// book's current list at their Ort, on the shared offline base map of
// Vienna (../../shared/js/basemap.js; nothing is ever requested). A pin's
// colour is the most pressing priority of its messages (Notfall red,
// Dringend amber), its number how many messages share the place; a card
// (hover, or a tap) lists them with a link to each. The own station
// (Standort der Station) is the star. Which messages, and where:
// mapdata.js.

import { el, fill } from '../../shared/js/dom.js';
import { mapLinks } from '../../shared/js/sources.js';
import { createBasemap, loadBasemapData, basemapCanHover } from '../../shared/js/basemap.js';
import { messagesForMap, placeTextsToResolve, groupByPlace, pinPriority } from './mapdata.js';

const NF_CARD_ITEMS = 4; // messages listed on a card; the rest counted

let nfMap = null;
let nfBase = null;
let nfPins = null;
let nfOwn = null;
let nfLastCtx = null;
let nfFittedFor = null;
const nfResolved = new Map(); // place text -> location or null (looked up once)

const nfWeak = loc => loc.confidence === 'low' || loc.confidence === 'ambiguous';

// The card of one pin. withLinks: the links to the messages and the map
// links (popup only: a hover tooltip can't be clicked).
function nfCard(group, ctx, withLinks) {
  const { loc, items } = group;
  const shown = items.slice(0, NF_CARD_ITEMS);
  const fromText = items.some(i => i.fromText);
  return el('div', { class: 'pin-tip-body' },
    el('div', { class: 'pin-tip-loc' }, `${loc.label}${loc.maidenhead ? ' · ' + loc.maidenhead : ''}`,
      nfWeak(loc) ? el('span', { class: 'pin-tip-warn' }, ' (unsicher)') : null,
      fromText ? el('span', { class: 'pin-tip-more' }, ' (aus dem Text des Orts ermittelt)') : null),
    el('ul', {}, shown.map(({ msg }) => {
      const d = ctx.describe(msg);
      const line = [el('b', {}, msg.number), ` ${d.time} ${d.dir} · ${d.subject}`, d.status ? el('span', { class: 'pin-tip-more' }, ` · ${d.status}`) : null];
      return el('li', { class: msg.priority === 'emergency' ? 'pin-tip-warn' : null },
        withLinks ? el('a', { href: ctx.hrefOf(msg) }, line) : line);
    }),
    items.length > shown.length ? el('li', { class: 'pin-tip-more' }, `+ ${items.length - shown.length} weitere`) : null),
    withLinks ? mapLinks(loc) : null);
}

function nfDrawPins(ctx) {
  const L = globalThis.L;
  const { placed, unplaced, noPlace } = messagesForMap(ctx.msgs, nfResolved);
  nfPins.clearLayers();
  const pts = [];
  for (const group of groupByPlace(placed)) {
    const n = group.items.length;
    const icon = L.divIcon({
      className: `map-pin prio-${pinPriority(group.items)}${nfWeak(group.loc) ? ' weak' : ''}`,
      html: n > 1 ? `<span>${n}</span>` : '',
      iconSize: [18, 18],
      iconAnchor: [9, 9],
    });
    const title = group.items.map(i => i.msg.number).join(', ');
    const m = L.marker([group.loc.lat, group.loc.lon], { icon, title, keyboard: true, riseOnHover: true });
    if (basemapCanHover()) m.bindTooltip(() => nfCard(group, ctx, false), { sticky: true, direction: 'top', className: 'pin-tip', offset: [0, -8] });
    m.bindPopup(() => nfCard(group, ctx, true), { className: 'pin-tip', maxWidth: 300, autoPanPadding: [24, 24] });
    m.addTo(nfPins);
    pts.push([group.loc.lat, group.loc.lon]);
  }
  const notes = [];
  if (unplaced.length) notes.push(`${unplaced.length} Meldung${unplaced.length > 1 ? 'en' : ''} mit nicht zugeordnetem Ort: ${unplaced.map(x => x.number).join(', ')}`);
  if (noPlace) notes.push(`${noPlace} ohne Ort`);
  if (!placed.length && !unplaced.length) notes.unshift('Keine Meldung mit Ort in dieser Auswahl.');
  fill(document.getElementById('map-unplaced'), notes.join(' · '));
  return pts;
}

async function nfDrawOwn(ctx) {
  const L = globalThis.L;
  nfOwn.clearLayers();
  const text = String(ctx.station || '').trim();
  const own = text ? await ctx.resolve(text) : null;
  if (!own || !Number.isFinite(own.lat)) return null;
  const label = `Eigene Station${ctx.call ? ' ' + ctx.call : ''}: ${own.label}`;
  const m = L.marker([own.lat, own.lon], {
    icon: L.divIcon({ className: 'map-own', html: '<span>★</span>', iconSize: [28, 28], iconAnchor: [14, 14] }),
    title: 'Eigene Station', zIndexOffset: 1000, keyboard: true,
  });
  // DOM nodes, not strings: Leaflet puts a string in as HTML.
  if (basemapCanHover()) m.bindTooltip(el('div', {}, label), { direction: 'top', className: 'pin-tip', offset: [0, -12] });
  m.bindPopup(el('div', {}, label), { className: 'pin-tip' });
  m.addTo(nfOwn);
  return [own.lat, own.lon];
}

async function nfRender(ctx, refit) {
  nfLastCtx = ctx;
  // texts of an Ort without a stored place: looked up once each
  for (const text of placeTextsToResolve(ctx.msgs, nfResolved)) nfResolved.set(text, await ctx.resolve(text));
  if (nfLastCtx !== ctx) return; // a newer render took over meanwhile
  const pts = nfDrawPins(ctx);
  const own = await nfDrawOwn(ctx);
  if (own) pts.push(own);
  if (refit || nfFittedFor !== ctx.opId) {
    nfFittedFor = ctx.opId;
    if (pts.length > 1) nfMap.fitBounds(pts, { padding: [48, 48], maxZoom: 15 });
    else if (pts.length === 1) nfMap.setView(pts[0], 14);
    else nfMap.fitBounds(nfBase.bounds);
  }
}

export function notfunkMapVisible() {
  const panel = document.getElementById('map-panel');
  return !!panel && !panel.hidden;
}

// ctx: { opId, msgs (the book's current list), station (text), call,
// describe(msg) -> { time, dir, subject, status }, hrefOf(msg),
// resolve(text) -> location | null (confident only) }
export async function notfunkOpenMap(ctx) {
  const panel = document.getElementById('map-panel');
  panel.hidden = false;
  if (!globalThis.L) {
    fill(document.getElementById('map-unplaced'), 'Kartenbibliothek nicht geladen.');
    return;
  }
  if (!nfBase) nfBase = await loadBasemapData();
  if (!nfBase) {
    fill(document.getElementById('map-unplaced'), 'Kartendaten nicht verfügbar (nicht gebaut?).');
    return;
  }
  if (!nfMap) {
    const L = globalThis.L;
    nfMap = createBasemap('map', nfBase, () => { if (nfLastCtx) nfRender(nfLastCtx, false); });
    nfPins = L.layerGroup().addTo(nfMap);
    nfOwn = L.layerGroup().addTo(nfMap);
  }
  nfMap.invalidateSize();
  await nfRender(ctx, true);
}

export function notfunkCloseMap() {
  document.getElementById('map-panel').hidden = true;
}

// After every change of the list (new message, filter, search); a no-op
// while the map is closed.
export function notfunkRefreshMap(ctx) {
  if (nfMap && notfunkMapVisible()) nfRender(ctx, false);
}

