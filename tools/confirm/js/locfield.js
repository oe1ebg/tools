// The log's `location` field: free text (what the operator heard) that is
// resolved with the offline Vienna lookup while typing. The text is always
// kept as entered; the chosen resolution is stored next to it on the line
// (`loc`). Logging is never blocked: an unresolved location is saved as text.

import { $, el } from './dom.js';
import { loadLocationIndex, renderCandidates, autoSelectLevel } from './locationui.js';
import { locate } from './location/index.js';
import { latLonToMaidenhead } from './location/maidenhead.js';

const LOC_CONF_TEXT = { exact: 'exakt', high: 'hoch', likely: 'wahrscheinlich', ambiguous: 'mehrdeutig', low: 'unsicher' };

// Compact, stable copy of a lookup result for storage on a log line.
export function snapshotLocation(r, input, manual) {
  return {
    type: r.type, label: r.label,
    street: r.street || '', houseNumber: r.houseNumber || '',
    postcode: r.postcode || '', district: r.district || null,
    lat: Math.round(r.lat * 1e5) / 1e5, lon: Math.round(r.lon * 1e5) / 1e5,
    maidenhead: r.type === 'maidenhead' ? r.maidenhead : latLonToMaidenhead(r.lat, r.lon, 6),
    source: r.source, confidence: r.confidence, manual: !!manual, input,
  };
}

export function describeLocation(loc) {
  if (!loc) return '';
  return `${loc.label}${loc.postcode && !loc.label.includes(loc.postcode) ? ', ' + loc.postcode : ''} · ${loc.maidenhead}`;
}

// input: the text field; plzInput: optional PLZ field to auto-fill;
// onChange: called whenever the resolution changes (for draft saving).
export function createLocationField({ input, plzInput, onChange }) {
  const box = $('#loc-field');
  const chip = $('#loc-field-chip');
  const results = $('#loc-field-results');
  let loc = null;
  let timer = null;
  let seq = 0;
  box.hidden = false;

  function renderChip() {
    const text = input.value.trim();
    chip.className = '';
    if (loc) {
      chip.className = `conf-${loc.confidence}`;
      chip.replaceChildren(
        el('b', {}, '✓ '), describeLocation(loc),
        ` (${loc.manual ? 'gewählt' : 'automatisch'}, ${LOC_CONF_TEXT[loc.confidence] || loc.confidence}) `,
        el('button', { type: 'button', class: 'link', onclick: () => { setLoc(null); results.hidden = false; resolve(); } }, 'ändern'));
    } else if (text) {
      chip.className = 'unresolved';
      chip.textContent = 'Standort nicht zugeordnet – wird als Text gespeichert (oder unten wählen).';
    } else {
      chip.textContent = '';
    }
  }

  function fillPlz() {
    if (!plzInput) return;
    const v = loc?.postcode || '';
    if (plzInput.value === '' || plzInput.dataset.autofill === plzInput.value) {
      plzInput.value = v;
      plzInput.dataset.autofill = v;
    }
  }

  function setLoc(next) {
    loc = next;
    fillPlz();
    renderChip();
    onChange();
  }

  async function resolve() {
    const text = input.value.trim();
    const my = ++seq;
    if (!text) {
      results.replaceChildren();
      setLoc(null);
      return;
    }
    const idx = await loadLocationIndex();
    if (my !== seq) return; // a newer keystroke superseded this one
    if (!idx) {
      results.replaceChildren(el('div', { class: 'hint' }, 'Standortdaten nicht verfügbar – Eingabe wird als Text gespeichert.'));
      return;
    }
    const level = autoSelectLevel();
    const res = locate(idx, text, { autoSelect: level === 'never' ? 'none' : level, limit: 5 });
    renderCandidates(results, res, {
      onPick: r => {
        setLoc(snapshotLocation(r, text, true));
        results.hidden = true;
        input.focus();
      },
    });
    results.hidden = false;
    setLoc(res.autoSelect ? snapshotLocation(res.autoSelect, text, false) : null);
  }

  input.addEventListener('input', () => {
    loc = null;
    renderChip();
    clearTimeout(timer);
    timer = setTimeout(resolve, 200);
  });
  // Arrow down jumps from the field into the candidate list.
  input.addEventListener('keydown', ev => {
    if (ev.key === 'ArrowDown') {
      const first = results.querySelector('button');
      if (first) { ev.preventDefault(); first.focus(); }
    }
  });

  return {
    get: () => loc,
    // Restore a stored resolution (edit / draft) without re-resolving.
    set(value) {
      clearTimeout(timer);
      loc = value || null;
      results.replaceChildren();
      if (plzInput && loc) plzInput.dataset.autofill = plzInput.value === loc.postcode ? loc.postcode : '';
      renderChip();
    },
    clear() {
      clearTimeout(timer);
      seq++;
      loc = null;
      results.replaceChildren();
      results.hidden = false;
      if (plzInput) plzInput.dataset.autofill = '';
      renderChip();
    },
    // Take over a stored location (e.g. the station's last known one).
    adopt(value) {
      input.value = value.input || value.label;
      setLoc({ ...value, manual: true });
      results.replaceChildren();
    },
    destroy() {
      clearTimeout(timer);
      box.hidden = true;
      results.replaceChildren();
      chip.textContent = '';
    },
  };
}
