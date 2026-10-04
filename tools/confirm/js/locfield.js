// The log's `location` field: free text (what the operator heard) that is
// resolved with the offline Vienna lookup while typing. Candidates appear in
// a dropdown under the field; choosing one fills in the full address and
// the PLZ (the originally typed text is kept in `loc.input`). An automatic
// match keeps the typed text. Logging is never blocked: an unresolved
// location is saved as text.

import { el, fill, popover } from './dom.js';
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

// The text to put into the field for a chosen location: the full official
// address ("Währinger Straße 40-42"), street, landmark name, ...
export function locationFieldText(r) {
  if (r.type === 'address') return `${r.street} ${r.houseNumber}`;
  if (r.type === 'street') return r.street;
  if (r.type === 'maidenhead') return r.maidenhead;
  return r.label;
}

// Elements: input (the field), results (its dropdown), chip (status line
// under the field), plzInput (optional PLZ field to fill). onChange is
// called whenever the resolution changes (for draft saving).
export function createLocationField({ input, plzInput, chip, results, onChange }) {
  const pop = popover(input, results);
  const chipBase = chip.className;
  let loc = null;
  let timer = null;
  let seq = 0;

  function renderChip() {
    const text = input.value.trim();
    chip.className = chipBase;
    if (loc) {
      chip.classList.add(`conf-${loc.confidence}`);
      fill(chip,
        `✓ ${describeLocation(loc)} (${loc.manual ? 'gewählt' : 'automatisch'}, ${LOC_CONF_TEXT[loc.confidence] || loc.confidence}) `,
        el('button', { type: 'button', class: 'link', onclick: () => { setLoc(null); input.focus(); resolve(); } }, 'ändern'));
    } else if (text) {
      chip.classList.add('unresolved');
      chip.textContent = 'nicht zugeordnet – wird als Text gespeichert';
    } else {
      chip.textContent = '';
    }
  }

  // force: a deliberate choice overwrites the PLZ; otherwise only an empty
  // or previously auto-filled PLZ is changed.
  function fillPlz(force) {
    if (!plzInput) return;
    const v = loc?.postcode || '';
    if (force ? v : plzInput.value === '' || plzInput.dataset.autofill === plzInput.value) {
      plzInput.value = v;
      plzInput.dataset.autofill = v;
    }
  }

  function setLoc(next, force = false) {
    loc = next;
    fillPlz(force);
    renderChip();
    onChange();
  }

  // A deliberate choice fills the field with the full address and the PLZ.
  function choose(r, typed) {
    const snap = snapshotLocation(r, typed, true);
    input.value = locationFieldText(snap);
    setLoc(snap, true);
    results.replaceChildren();
    pop.hide();
    input.focus();
  }

  async function resolve() {
    const text = input.value.trim();
    const my = ++seq;
    if (!text) {
      results.replaceChildren();
      pop.update();
      setLoc(null);
      return;
    }
    const idx = await loadLocationIndex();
    if (my !== seq) return; // a newer keystroke superseded this one
    if (!idx) {
      fill(results, el('div', { class: 'ac-head' }, 'Standortdaten nicht verfügbar – Eingabe wird als Text gespeichert.'));
      pop.update();
      return;
    }
    const level = autoSelectLevel();
    const res = locate(idx, text, { autoSelect: level === 'never' ? 'none' : level, limit: 6 });
    renderCandidates(results, res, { compact: true, onPick: r => choose(r, text) });
    pop.update();
    setLoc(res.autoSelect ? snapshotLocation(res.autoSelect, text, false) : null);
  }

  input.addEventListener('input', () => {
    loc = null;
    renderChip();
    clearTimeout(timer);
    timer = setTimeout(resolve, 200);
  });

  return {
    get: () => loc,
    // Restore a stored resolution (edit / draft) without re-resolving.
    set(value) {
      clearTimeout(timer);
      loc = value || null;
      results.replaceChildren();
      pop.hide();
      if (plzInput && loc) plzInput.dataset.autofill = plzInput.value === loc.postcode ? loc.postcode : '';
      renderChip();
    },
    clear() {
      clearTimeout(timer);
      seq++;
      loc = null;
      results.replaceChildren();
      pop.hide();
      if (plzInput) plzInput.dataset.autofill = '';
      renderChip();
    },
    isEmpty: () => !loc && !input.value.trim(),
    // Take over a stored location (e.g. the station's last known one).
    adopt(value) {
      input.value = locationFieldText(value);
      setLoc({ ...value, manual: true }, true);
      results.replaceChildren();
      pop.hide();
    },
    // Put text into the field and resolve it like typed input.
    setText(text) {
      input.value = text;
      loc = null;
      input.focus();
      resolve();
    },
  };
}
