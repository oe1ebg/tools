// Repeater lookup for the log header: search all Austrian voice repeaters
// (offline list) and fill callsign, output frequency, shift, CTCSS and mode.

import { el, fill, popover } from './dom.js';
import { normalizeCall } from './model.js';
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

// Completion on the header's "Relais" field, like the per-line repeater in
// the entry form: type a callsign, place or frequency (or focus the empty
// field with an own locator set: nearest first) and pick from the dropdown
// (↓, Enter). The line under the field describes the chosen repeater.
// getHeader(): current header values; onPick(repeater): apply it.
export function attachRepeaterSearch({ input, pop, info, getHeader, onPick }) {
  const dd = popover(input, pop);
  let timer = null;
  let seq = 0;

  async function renderInfo() {
    const call = normalizeCall(input.value);
    const idx = call ? await loadRepeaterIndex() : null;
    const r = idx?.list.find(x => x.call === call);
    info.className = 'ac-info';
    if (r) {
      info.classList.add('known');
      info.textContent = describeRepeater(r).split(' · ').slice(1).join(' · ');
    } else if (call) {
      info.classList.add('unknown');
      info.textContent = idx ? 'nicht in der ÖVSV-Liste – Frequenzen von Hand eintragen' : '';
    } else {
      info.textContent = '';
    }
    info.title = info.textContent;
  }

  async function suggest() {
    const my = ++seq;
    const idx = await loadRepeaterIndex();
    if (my !== seq) return;
    if (!idx) {
      fill(pop);
      dd.update();
      return;
    }
    const h = getHeader();
    const position = positionFromLocator(h.myGrid);
    const q = input.value.trim();
    // Nothing to offer while the field holds the repeater already applied
    // (Enter then simply moves on instead of picking another one).
    const applied = q && normalizeCall(q) === h.repeaterCall && h.repeaterFreq;
    const list = !applied && (q || position) ? searchRepeaters(idx, q, { position, limit: 8 }) : [];
    fill(pop, list.length ? [
      el('div', { class: 'ac-head' }, `${q ? 'Relais' : `Nächste Relais zu ${h.myGrid}`} (ÖVSV, Stand ${idx.retrieved.slice(0, 10)}; ↓, Enter):`),
      list.map(({ r, distKm }) => el('button', {
        type: 'button', class: 'ac-item',
        title: [r.comment, r.echolink ? `EchoLink ${r.echolink}` : null, r.cc ? `Colorcode ${r.cc}` : null, r.locator].filter(Boolean).join(' · '),
        onclick: () => {
          onPick(r);
          input.value = r.call;
          fill(pop);
          dd.hide();
          renderInfo();
          input.focus();
        },
      }, el('b', {}, r.call), el('small', {}, describeRepeater(r, distKm).split(' · ').slice(1).join(' · ')))),
    ] : []);
    dd.update();
  }

  input.addEventListener('input', () => {
    renderInfo();
    clearTimeout(timer);
    timer = setTimeout(suggest, 120);
  });
  input.addEventListener('focus', suggest);
  return { refresh: renderInfo };
}
