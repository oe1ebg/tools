// "Relais suchen" in the log header: search all Austrian voice repeaters
// (offline list) and fill callsign, output frequency, shift, CTCSS and mode.

import { el } from './dom.js';
import { loadDataFile } from './data.js';
import { buildRepeaterIndex, searchRepeaters, positionFromLocator, formatShift, formatMHz } from './repeaters.js';

let repeaterIndexPromise = null;

export function loadRepeaterIndex() {
  if (!repeaterIndexPromise) {
    repeaterIndexPromise = loadDataFile('repeaters-at.json').then(buildRepeaterIndex).catch(() => null);
  }
  return repeaterIndexPromise;
}

export function describeRepeater(r, distKm) {
  return [
    r.call,
    `${r.site}${r.city && r.city !== r.site ? ` (${r.city})` : ''}`,
    `${formatMHz(r.out)} ${formatShift(r.shift)}`.trim(),
    r.ctcss ? `CTCSS ${r.ctcss}` : null,
    r.modes.join('/') || null,
    r.ch || null,
    distKm !== null && distKm !== undefined ? `${distKm < 10 ? distKm.toFixed(1) : Math.round(distKm)} km` : null,
    r.status !== 'active' ? r.status : null,
  ].filter(Boolean).join(' · ');
}

// getHeader(): current header values; onPick(repeater): apply it.
export function repeaterSearchWidget(getHeader, onPick) {
  const input = el('input', {
    class: 'rpt-q', size: 30, autocomplete: 'off', spellcheck: 'false',
    placeholder: 'Rufzeichen, Ort, Frequenz, Band, DMR/FM …',
  });
  const results = el('div', { class: 'rpt-results' });
  const status = el('span', { class: 'hint' });
  let timer = null;

  async function run() {
    const idx = await loadRepeaterIndex();
    if (!idx) {
      status.textContent = 'Relaisliste nicht verfügbar – Felder manuell ausfüllen.';
      return;
    }
    const h = getHeader();
    const position = positionFromLocator(h.myGrid);
    const q = input.value.trim();
    status.textContent = `${idx.list.length} österreichische Sprach-Relais (ÖVSV, Stand ${idx.retrieved.slice(0, 10)})${position ? ', sortiert nach Entfernung zu ' + h.myGrid : ''}`;
    results.replaceChildren();
    if (!q && !position) {
      results.append(el('div', { class: 'hint' }, 'Tipp: eigenen Locator eintragen, dann werden die nächsten Relais angezeigt.'));
      return;
    }
    const hits = searchRepeaters(idx, q, { position, limit: 8 });
    if (!hits.length) results.append(el('div', { class: 'hint' }, 'Kein Relais gefunden.'));
    for (const { r, distKm } of hits) {
      results.append(el('button', {
        type: 'button', class: `rpt-hit${r.status !== 'active' ? ' inactive' : ''}`,
        title: [r.comment, r.echolink ? `EchoLink ${r.echolink}` : null, r.cc ? `Colorcode ${r.cc}` : null, r.locator].filter(Boolean).join(' · '),
        onclick: () => {
          onPick(r);
          input.value = '';
          results.replaceChildren(el('div', { class: 'hint ok' }, `✓ ${describeRepeater(r, distKm)} übernommen`));
        },
      }, describeRepeater(r, distKm)));
    }
  }
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 120); });
  input.addEventListener('focus', run);
  // Enter takes the first hit instead of submitting the surrounding form.
  input.addEventListener('keydown', ev => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      results.querySelector('button.rpt-hit')?.click();
    }
  });

  return el('div', { class: 'rpt-search' },
    el('label', { class: 'field', style: 'flex:1;min-width:16em' }, el('span', {}, 'Relais suchen (alle österreichischen Relais)'), input),
    status, results);
}
