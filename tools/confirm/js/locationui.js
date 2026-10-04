// UI for the offline Vienna location lookup: the standalone
// "Standortsuche" panel, and renderCandidates() which the log's location
// field reuses. All lookups run locally on data/vienna-locations.json.

import { $, el, fill, copyToClipboard } from './dom.js';
import { loadDataFile } from './data.js';
import { buildLocationIndex, locate } from './location/index.js';
import { latLonToMaidenhead } from './location/maidenhead.js';
import { sourceItem, standDate } from './sources.js';

const LOC_PREC_KEY = 'oe1ebg-confirm-locator-precision';
const LOC_AUTO_KEY = 'oe1ebg-confirm-location-autoselect';
const CONF_LABEL = { exact: 'exakt', high: 'hoch', likely: 'wahrscheinlich', ambiguous: 'mehrdeutig', low: 'unsicher' };
const TYPE_LABEL = { address: 'Adresse', street: 'Straße', poi: 'Ort', coordinate: 'Koordinate', maidenhead: 'Locator', district: 'Bezirk', postcode: 'PLZ' };
const SOURCE_LABEL = { 'vienna-ogd': 'Stadt Wien', osm: 'OpenStreetMap', computed: 'berechnet', alias: 'kuratiert' };
const EXAMPLES = ['Währinger Straße 42', '1100 Quellenstr', 'Donauturm', 'Donauinsel JN88ge', '48.2083, 16.3731', 'JN88ee'];

let indexPromise = null;
let locIndex = null;

// Loads and indexes the data once (memoized); null if it isn't available.
export function loadLocationIndex() {
  if (!indexPromise) {
    indexPromise = (async () => {
      const data = await loadDataFile('vienna-locations.json');
      if (!data) return null;
      // Yield once so the UI can paint "wird geladen" before the ~0.2–1 s build.
      await new Promise(r => setTimeout(r, 0));
      const t = performance.now();
      locIndex = buildLocationIndex(data);
      locIndex.buildMs = Math.round(performance.now() - t);
      return locIndex;
    })();
  }
  return indexPromise;
}

export function locatorPrecision() {
  const v = parseInt(localStorage.getItem(LOC_PREC_KEY) || '6', 10);
  return [4, 6, 8].includes(v) ? v : 6;
}

// Minimum confidence at which the log's location field takes the best
// candidate automatically: 'exact' | 'high' (default) | 'likely' | 'never'.
export function autoSelectLevel() {
  const v = localStorage.getItem(LOC_AUTO_KEY) || 'high';
  return ['exact', 'high', 'likely', 'never'].includes(v) ? v : 'high';
}

export function locatorFor(r, precision = locatorPrecision()) {
  return r.type === 'maidenhead' ? r.maidenhead : latLonToMaidenhead(r.lat, r.lon, precision);
}

export function addressText(r) {
  if (r.type === 'address') return `${r.street} ${r.houseNumber}, ${r.postcode} Wien`;
  if (r.type === 'street') return `${r.street}, ${r.postcode} Wien`;
  if (r.postcode && r.type === 'poi') return `${r.label}, ${r.postcode} Wien`;
  return r.label;
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

// One-line candidate rows for a completion dropdown (the log's location
// field): click/Enter = opts.onPick(result).
function renderCompact(container, res, opts) {
  const prec = locatorPrecision();
  if (!res.results.length) {
    fill(container, el('div', { class: 'ac-head' }, 'Kein Treffer in Wien – wird als Text gespeichert.'));
    return;
  }
  fill(container,
    el('div', { class: 'ac-head' }, res.autoSelect ? 'Automatisch zugeordnet – oder anderen Ort wählen:' : 'Ort wählen (↓, Enter):'),
    res.results.map(r => el('button', {
      type: 'button', class: `ac-item conf-${r.confidence}`, title: `passt weil: ${r.reasons.join(', ')}${r.note ? ' · ' + r.note : ''}`,
      onclick: () => opts.onPick(r),
    },
    el('b', {}, r.label),
    el('small', {}, [r.postcode ? `${r.postcode} Wien` : null, r.district ? `${r.district}. Bez.` : null, locatorFor(r, prec), TYPE_LABEL[r.type]].filter(Boolean).join(' · ')),
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
    container.append(el('div', { class: 'hint' }, 'Nichts gefunden. Tipp: Straßenname ohne Abkürzung, PLZ oder Locator ergänzen.'));
    return;
  }
  if (res.results.length > 1 && !res.autoSelect) {
    container.append(el('div', { class: 'hint' }, 'Mehrere Möglichkeiten – bitte den richtigen Ort wählen:'));
  }
  res.results.forEach((r, n) => {
    const loc = locatorFor(r, prec);
    const meta = [
      r.postcode ? `${r.postcode} Wien` : null,
      r.district ? `${r.district}. Bezirk` : null,
      loc,
      `${fmtCoord(r.lat)}, ${fmtCoord(r.lon)}`,
    ].filter(Boolean).join(' · ');
    const card = el('div', { class: `loc-cand conf-${r.confidence}${n === 0 && res.autoSelect ? ' auto' : ''}` },
      el('div', { class: 'lc-head' },
        el('b', {}, r.label),
        el('span', { class: 'lc-type' }, TYPE_LABEL[r.type] || r.type),
        el('span', { class: 'lc-conf' }, CONF_LABEL[r.confidence] || r.confidence)),
      el('div', { class: 'lc-meta' }, meta),
      el('div', { class: 'lc-why' }, `passt weil: ${r.reasons.join(', ')} · Quelle: ${SOURCE_LABEL[r.source] || r.source}`),
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
          : 'Keine Wiener Adressen in diesem Feld.'));
    }
    if (r.coordinate && r.coordinate.alternatives?.length) {
      card.append(el('div', { class: 'lc-detail' },
        `Weitere PLZ in der Nähe: ${r.coordinate.alternatives.map(a => `${a.postcode} (${Math.round(a.share * 100)} %)`).join(', ')}`));
    }
    const actions = el('div', { class: 'lc-actions' });
    if (opts.onPick) {
      actions.append(el('button', { type: 'button', class: n === 0 ? 'primary mini' : 'mini', onclick: () => opts.onPick(r) }, 'Übernehmen'));
    } else {
      actions.append(
        copyButton('Adresse', addressText(r)),
        copyButton('Koordinaten', `${fmtCoord(r.lat)}, ${fmtCoord(r.lon)}`),
        r.postcode ? copyButton('PLZ', r.postcode) : null,
        copyButton('Locator', loc));
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
  return `${n.format(idx.counts.addresses)} Adressen · ${n.format(idx.counts.places)} Orte · offline (Stand ${idx.meta.addresses_retrieved.slice(0, 10)})`;
}

export function initLocationPanel() {
  const panel = $('#loc-panel');
  const input = $('#loc-q');
  const results = $('#loc-results');
  const prec = $('#loc-prec');
  prec.value = String(locatorPrecision());
  const auto = $('#loc-auto');
  auto.value = autoSelectLevel();
  auto.addEventListener('change', () => localStorage.setItem(LOC_AUTO_KEY, auto.value));
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
  prec.addEventListener('change', () => { localStorage.setItem(LOC_PREC_KEY, prec.value); run(); });

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
    const foot = $('#st-location');
    if (!foot) return;
    if (!idx) {
      foot.textContent = 'Wien-Daten nicht verfügbar';
      return;
    }
    const n = new Intl.NumberFormat('de-AT');
    fill(foot,
      sourceItem('addresses', `${n.format(idx.counts.addresses)} Adressen, Stand ${standDate(idx.meta.addresses_retrieved)}`),
      ' · ',
      sourceItem('osm', `${n.format(idx.counts.places)} Orte, Stand ${standDate(idx.meta.places_retrieved)}`));
  }, 800);
}
