// UI for the offline location lookup: the standalone "Standortsuche" panel,
// and renderCandidates() which the log's location field reuses. All lookups
// run locally on data/vienna-locations.json (Vienna addresses/landmarks) and
// data/austria-areas.json (PLZ and Bezirke of all of Austria).

import { prefGet, prefSet } from '../../shared/js/prefs.js';
import { $, el, fill, copyToClipboard } from '../../shared/js/dom.js';
import { loadDataFile } from '../../shared/js/data.js';
import { buildLocationIndex, locate } from '../../shared/js/location/index.js';
import { latLonToMaidenhead } from '../../shared/js/maidenhead.js';
import { sourceItem, standDate, mapLinks } from './sources.js';

const LOC_PREC_KEY = 'oe1ebg-confirm-locator-precision';
const LOC_AUTO_KEY = 'oe1ebg-confirm-location-autoselect';
const CONF_LABEL = { exact: 'exakt', high: 'hoch', likely: 'wahrscheinlich', ambiguous: 'mehrdeutig', low: 'unsicher' };
const TYPE_LABEL = { address: 'Adresse', street: 'Straße', intersection: 'Kreuzung', between: 'Bereich', poi: 'Ort', coordinate: 'Koordinate', maidenhead: 'Locator', district: 'Bezirk', bezirk: 'Bezirk', postcode: 'PLZ' };
// How a result was named when not by its own name (index.js NAME_TYPES).
const NAME_TYPE_LABEL = { alias: 'anderer Name', colloquial: 'umgangssprachlich', historical: 'früherer Name', generated: 'Kurzform' };
const SOURCE_LABEL = { 'vienna-ogd': 'Stadt Wien', osm: 'OpenStreetMap', gip: 'Stadt Wien (GIP-Namen)', wl: 'Wiener Linien', computed: 'berechnet', alias: 'kuratiert', bev: 'Adressregister' };
const EXAMPLES = ['Währinger Straße 42', '1100 Quellenstr', 'Donauturm', 'Donauinsel JN88ge', '48.2083, 16.3731', 'JN88ee', '2340', 'Bezirk Liezen'];

let indexPromise = null;
let locIndex = null;

// Loads and indexes the data once (memoized); null if it isn't available.
export function loadLocationIndex() {
  if (!indexPromise) {
    indexPromise = (async () => {
      const [data, areas] = await Promise.all([loadDataFile('vienna-locations.json'), loadDataFile('austria-areas.json')]);
      if (!data) return null;
      // Yield once so the UI can paint "wird geladen" before the ~0.2–1 s build.
      await new Promise(r => setTimeout(r, 0));
      const t = performance.now();
      locIndex = buildLocationIndex(data, areas);
      locIndex.buildMs = Math.round(performance.now() - t);
      return locIndex;
    })();
  }
  return indexPromise;
}

export function locatorPrecision() {
  const v = parseInt(prefGet(LOC_PREC_KEY) || '6', 10);
  return [4, 6, 8, 10].includes(v) ? v : 6;
}

// Minimum confidence at which the log's location field takes the best
// candidate automatically: 'exact' | 'high' (default) | 'likely' | 'never'.
export function autoSelectLevel() {
  const v = prefGet(LOC_AUTO_KEY) || 'high';
  return ['exact', 'high', 'likely', 'never'].includes(v) ? v : 'high';
}

export function locatorFor(r, precision = locatorPrecision()) {
  return r.type === 'maidenhead' ? r.maidenhead : latLonToMaidenhead(r.lat, r.lon, precision);
}

export function addressText(r) {
  if (r.type === 'address') return `${r.street} ${r.houseNumber}, ${r.postcode} Wien`;
  if (r.type === 'street') return `${r.street}, ${r.postcode} Wien`;
  if (r.postcode && (r.type === 'poi' || r.type === 'intersection' || r.type === 'between')) return `${r.label}, ${r.postcode} ${r.city || 'Wien'}`;
  return r.label;
}

// "1100 Wien" for the meta line; area results already carry it in the label.
function plzText(r) {
  return r.postcode && r.type !== 'postcode' ? `${r.postcode} ${r.city || 'Wien'}` : null;
}

// "JN88db 53 % · JN88dc 47 %" (share of the area's addresses per square)
function locatorShares(list) {
  return list.map(([loc, share]) => `${loc} ${share} %`).join(' · ');
}

// Locator plus "+N" for the area's other main squares at this precision
// (the listed ones, like the log chip; the card shows the total).
function locatorWithMore(r, prec) {
  const loc = locatorFor(r, prec);
  const a = r.areaInfo;
  if (!a) return loc;
  const more = prec === 4 ? a.locators4.length - 1 : prec === 6 ? a.locators.length - 1 : 0;
  return more > 0 ? `${loc} +${more}` : loc;
}

function fmtCoord(v) {
  return v.toFixed(5);
}

function copyButton(label, text) {
  const b = el('button', { type: 'button', class: 'mini' }, label);
  b.addEventListener('click', async () => {
    const ok = await copyToClipboard(text);
    b.textContent = ok ? `${label} ✓` : `${label} ✗`;
    setTimeout(() => { b.textContent = label; }, 1200);
  });
  return b;
}

function typeLabel(r) {
  return r.type === 'poi' && r.role === 'stop' ? 'Haltestelle' : TYPE_LABEL[r.type] || r.type;
}

// "gefunden als „Rudolfstiftung“ [früherer Name]", "„Gürtel“ = Lerchenfelder
// Gürtel", "Lage „beim“ …": how the input was understood (neutral, not a warning).
function nameLine(r, res) {
  const bits = [];
  if (r.matchedName) {
    bits.push(['gefunden als ', el('q', {}, r.matchedName), ' ', el('span', { class: `nt${r.nameType === 'historical' ? ' hist' : ''}` }, NAME_TYPE_LABEL[r.nameType] || 'anderer Name')]);
  }
  if (r.resolved) bits.push(r.resolved.join(' · '));
  if (res.evidence?.relation) bits.push(['Lage ', el('q', {}, res.evidence.relation), ` – Punkt ist ${r.label}, nicht der genaue Standort`]);
  return bits.length ? el('div', { class: 'lc-name' }, bits.flatMap((b, i) => (i ? [' · ', b] : [b])).flat(Infinity)) : null;
}

function sourceText(r) {
  const s = (r.sources || [r.source]).map(k => SOURCE_LABEL[k === 'curated' ? 'alias' : k] || k).join(' + ');
  return `Quelle: ${s}${r.umland && r.postcode ? ' · PLZ geschätzt' : ''}`;
}

// One-line candidate rows for a completion dropdown (the log's location
// field): click/Enter = opts.onPick(result).
function renderCompact(container, res, opts) {
  const prec = locatorPrecision();
  if (!res.results.length) {
    fill(container, el('div', { class: 'ac-head' }, 'Kein Treffer – wird als Text gespeichert.'));
    return;
  }
  fill(container,
    el('div', { class: 'ac-head' }, res.autoSelect ? 'Automatisch zugeordnet – oder anderen Ort wählen:' : 'Ort wählen (↓, Enter):'),
    res.results.map(r => el('button', {
      type: 'button', class: `ac-item conf-${r.confidence}`, title: `passt weil: ${r.reasons.join(', ')}${r.note ? ' · ' + r.note : ''}`,
      onclick: () => opts.onPick(r),
    },
    el('b', {}, r.label),
    el('small', {},
      r.matchedName ? [el('i', { class: 'alt' }, `„${r.matchedName}“${r.nameType === 'historical' ? ', früher' : r.nameType === 'colloquial' ? ', umgangssprachlich' : ''}`), ' · '] : null,
      [plzText(r), r.district ? `${r.district}. Bez.` : null, locatorWithMore(r, prec), typeLabel(r), r.umland ? 'außerhalb Wiens' : null].filter(Boolean).join(' · ')),
    el('span', { class: 'lc-conf' }, CONF_LABEL[r.confidence] || r.confidence))));
}

// opts.onPick(result): show a "Übernehmen" button (log field); otherwise copy buttons.
// opts.compact: one-line rows for a dropdown.
export function renderCandidates(container, res, opts = {}) {
  container.replaceChildren();
  if (!res) return;
  if (opts.compact) {
    renderCompact(container, res, opts);
    return;
  }
  const prec = locatorPrecision();
  if (!res.results.length) {
    container.append(el('div', { class: 'hint' }, 'Nichts gefunden. Tipp: Straßenname ohne Abkürzung, PLZ oder Locator ergänzen (Straßen nur für Wien, Orte für Wien und Umgebung; PLZ und Bezirke für ganz Österreich).'));
    return;
  }
  if (res.results.length > 1 && !res.autoSelect) {
    container.append(el('div', { class: 'hint' }, 'Mehrere Möglichkeiten – bitte den richtigen Ort wählen:'));
  }
  res.results.forEach((r, n) => {
    const loc = locatorFor(r, prec);
    const meta = [
      plzText(r),
      r.district ? `${r.district}. Bezirk` : null,
      r.areaInfo?.state && r.type === 'postcode' ? r.areaInfo.state : null,
      loc,
      `${fmtCoord(r.lat)}, ${fmtCoord(r.lon)}`,
    ].filter(Boolean).join(' · ');
    const card = el('div', { class: `loc-cand conf-${r.confidence}${n === 0 && res.autoSelect ? ' auto' : ''}` },
      el('div', { class: 'lc-head' },
        el('b', {}, r.label),
        el('span', { class: 'lc-type' }, typeLabel(r)),
        r.umland ? el('span', { class: 'lc-outside' }, 'außerhalb Wiens') : null,
        el('span', { class: 'lc-conf' }, CONF_LABEL[r.confidence] || r.confidence)),
      nameLine(r, res),
      el('div', { class: 'lc-meta' }, meta),
      el('div', { class: 'lc-why' }, `passt weil: ${r.reasons.join(', ')} · ${sourceText(r)}`),
      r.note ? el('div', { class: 'lc-note' }, r.note) : null,
    );
    if (r.maidenheadInfo) {
      const m = r.maidenheadInfo;
      const b = m.bounds;
      card.append(el('div', { class: 'lc-detail' },
        `Locator ${m.locator}, Genauigkeit: ${m.precision} Zeichen (${m.precisionName}). `,
        `Mitte ${fmtCoord(m.center.lat)}, ${fmtCoord(m.center.lon)} · Gebiet N ${fmtCoord(b.north)} S ${fmtCoord(b.south)} W ${fmtCoord(b.west)} O ${fmtCoord(b.east)}`,
        el('br'),
        m.postalCodes.length
          ? `PLZ in diesem Feld (Adressen): ${m.postalCodes.slice(0, 12).map(p => `${p.postcode} (${p.addressCount})`).join(', ')}${m.postalCodes.length > 12 ? ' …' : ''}`
          : m.areaPostcodes?.length
            ? `PLZ in diesem Feld (Hauptanteil, ca. Adressen): ${m.areaPostcodes.slice(0, 12).map(p => `${p.postcode} ${p.name} (${p.addressCount})`).join(', ')}${m.areaPostcodes.length > 12 ? ' …' : ''}`
            : 'Keine Adressen in diesem Feld.'));
    }
    if (r.areaInfo) {
      const a = r.areaInfo;
      const shown = a.locators.length;
      card.append(el('div', { class: 'lc-detail' },
        `Locatoren (Anteil der Adressen): ${locatorShares(a.locators)}${a.locatorCount > shown ? ` · … (${a.locatorCount} Kleinfelder insgesamt)` : ''}`,
        a.locators4.length > 1 ? [el('br'), `Großfelder: ${locatorShares(a.locators4)}`] : null,
        a.kind === 'postcode' && a.gemeinden.length > 1 ? [el('br'), `Gemeinden: ${a.gemeinden.join(', ')}`] : null,
        a.kind === 'bezirk' && a.postcodes?.length ? [el('br'), `PLZ (größte): ${a.postcodes.join(', ')}`] : null));
    }
    if (r.coordinate && r.coordinate.alternatives?.length) {
      card.append(el('div', { class: 'lc-detail' },
        `Weitere PLZ in der Nähe: ${r.coordinate.alternatives.map(a => `${a.postcode} (${Math.round(a.share * 100)} %)`).join(', ')}`));
    }
    const actions = el('div', { class: 'lc-actions' });
    if (opts.onPick) {
      actions.append(el('button', { type: 'button', class: n === 0 ? 'primary mini' : 'mini', onclick: () => opts.onPick(r) }, 'Übernehmen'));
    } else {
      fill(actions,
        copyButton('Adresse', addressText(r)),
        copyButton('Koordinaten', `${fmtCoord(r.lat)}, ${fmtCoord(r.lon)}`),
        r.postcode ? copyButton('PLZ', r.postcode) : null,
        copyButton('Locator', loc),
        r.areaInfo && r.areaInfo.locators.length > 1 ? copyButton('Alle Locatoren', r.areaInfo.locators.map(l => l[0]).join(' ')) : null,
        mapLinks(r));
    }
    card.append(actions);
    container.append(card);
  });
}

function setStatus(text, cls) {
  const s = $('#loc-status');
  s.textContent = text;
  s.className = 'hint' + (cls ? ' ' + cls : '');
}

export async function locationStatusText() {
  const idx = await loadLocationIndex();
  if (!idx) return null;
  const n = new Intl.NumberFormat('de-AT');
  const areas = idx.counts.postcodes ? ` · ${n.format(idx.counts.postcodes)} PLZ, ${n.format(idx.counts.bezirke)} Bezirke (Österreich)` : '';
  return `${n.format(idx.counts.addresses)} Wiener Adressen · ${n.format(idx.counts.places)} Orte${areas} · offline (Stand ${idx.meta.addresses_retrieved.slice(0, 10)})`;
}

export function initLocationPanel() {
  const panel = $('#loc-panel');
  const input = $('#loc-q');
  const results = $('#loc-results');
  const prec = $('#loc-prec');
  prec.value = String(locatorPrecision());
  const auto = $('#loc-auto');
  auto.value = autoSelectLevel();
  auto.addEventListener('change', () => prefSet(LOC_AUTO_KEY, auto.value));
  fill($('#loc-examples'), ...EXAMPLES.map(q => el('button', { type: 'button', class: 'link', onclick: () => { input.value = q; run(); } }, q)));

  let timer = null;
  const run = async () => {
    const idx = await loadLocationIndex();
    if (!idx) return;
    const q = input.value.trim();
    if (!q) { results.replaceChildren(); return; }
    const t = performance.now();
    const res = locate(idx, q);
    renderCandidates(results, res);
    setStatus(`${await locationStatusText()} · Suche ${Math.round(performance.now() - t)} ms`, 'ok');
  };
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 150); });
  prec.addEventListener('change', () => { prefSet(LOC_PREC_KEY, prec.value); run(); });

  const open = async () => {
    panel.hidden = false;
    input.focus();
    setStatus('Wien-Daten werden geladen…');
    const idx = await loadLocationIndex();
    if (!idx) {
      setStatus('Wien-Daten nicht verfügbar (nicht gebaut?) – Standortsuche deaktiviert.', 'err');
      return;
    }
    setStatus(await locationStatusText(), 'ok');
    run();
  };
  $('#btn-loc').addEventListener('click', () => (panel.hidden ? open() : (panel.hidden = true)));
  $('#loc-close').addEventListener('click', () => { panel.hidden = true; });

  // Preload in the background so the index is ready (and cached) before it's needed.
  setTimeout(async () => {
    const idx = await loadLocationIndex();
    // Footer "Datenquellen", grouped by origin (index.html).
    const wien = $('#st-location-wien');
    if (!wien) return;
    if (!idx) {
      wien.textContent = 'Wien-Daten nicht verfügbar';
      return;
    }
    const n = new Intl.NumberFormat('de-AT');
    const list = items => items.filter(Boolean).flatMap((x, i) => (i ? [' · ', x] : [x]));
    fill(wien, list([
      sourceItem('addresses', `${n.format(idx.counts.addresses)} Adressen, Stand ${standDate(idx.meta.addresses_retrieved)}`),
      idx.meta.gip_names_retrieved ? sourceItem('gipNames', `${n.format(idx.counts.gip)} Ortsnamen, Stand ${standDate(idx.meta.gip_names_retrieved)}`) : null,
      idx.meta.stops_retrieved ? sourceItem('stops', `${n.format(idx.counts.stops)} Haltestellen, Stand ${standDate(idx.meta.stops_retrieved)}`) : null,
    ]));
    fill($('#st-location-at'), idx.areasMeta ? list([
      sourceItem('adressregister', `${n.format(idx.counts.postcodes)} PLZ, Stichtag ${standDate(idx.areasMeta.stichtag)}`),
      sourceItem('bezirke', `${n.format(idx.counts.bezirke)} Bezirke`),
    ]) : null);
    fill($('#st-location-osm'),
      sourceItem('osm', `${n.format(idx.counts.osm)} Orte (davon ${n.format(idx.counts.umland)} im Umland), Stand ${standDate(idx.meta.places_retrieved)}`));
  }, 800);
}
