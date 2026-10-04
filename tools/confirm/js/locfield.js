// The log's `location` field: free text (what the operator heard) that is
// resolved with the offline Vienna lookup while typing. Candidates appear in
// a dropdown under the field; choosing one fills in the full address and
// the PLZ (the originally typed text is kept in `loc.input`). An automatic
// match keeps the typed text. Logging is never blocked: an unresolved
// location is saved as text. Once the callsign is known, the field can be
// prefilled with the station's last location, and other suggestions (e.g.
// the licence-list city) are offered in the dropdown while it is empty.

import { el, fill, popover } from './dom.js';
import { loadLocationIndex, renderCandidates, autoSelectLevel } from './locationui.js';
import { locate } from './location/index.js';
import { latLonToMaidenhead } from './location/maidenhead.js';

const LOC_CONF_TEXT = { exact: 'exakt', high: 'hoch', likely: 'wahrscheinlich', ambiguous: 'mehrdeutig', low: 'unsicher' };

// Compact, stable copy of a lookup result for storage on a log line. Area
// results (PLZ, Bezirk) also keep the locators they cover, biggest first;
// `maidenhead` is always the centre (that is what CSV/ADIF export).
export function snapshotLocation(r, input, manual) {
  const snap = {
    type: r.type, label: r.label,
    street: r.street || '', houseNumber: r.houseNumber || '',
    postcode: r.postcode || '', district: r.district || null,
    lat: Math.round(r.lat * 1e5) / 1e5, lon: Math.round(r.lon * 1e5) / 1e5,
    maidenhead: r.type === 'maidenhead' ? r.maidenhead : latLonToMaidenhead(r.lat, r.lon, 6),
    source: r.source, confidence: r.confidence, manual: !!manual, input,
  };
  if (r.bezirk) snap.bezirk = r.bezirk;
  if (r.areaInfo) snap.areaLocators = r.areaInfo.locators.map(l => l[0]);
  return snap;
}

export function describeLocation(loc) {
  if (!loc) return '';
  const more = loc.areaLocators?.length > 1 ? ` (+${loc.areaLocators.length - 1})` : '';
  return `${loc.label}${loc.postcode && !loc.label.includes(loc.postcode) ? ', ' + loc.postcode : ''} · ${loc.maidenhead}${more}`;
}

// The text to put into the field for a chosen location: the full official
// address ("Währinger Straße 40-42"), street, landmark name, ...
export function locationFieldText(r) {
  if (r.type === 'address') return `${r.street} ${r.houseNumber}`;
  if (r.type === 'street') return r.street;
  if (r.type === 'maidenhead') return r.maidenhead;
  return r.label;
}

// "2026-09-27T19:42:07Z" -> "27.09.2026"
function fmtDay(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  return m ? `${m[3]}.${m[2]}.${m[1]}` : '';
}

// Dropdown suggestions for a station: its last logged location (stations
// store) and the city from the callsign list, unless that is the same text.
export function locationOptions(rec, listedCity) {
  const out = [];
  if (rec?.loc) {
    out.push({ label: `zuletzt: ${locationFieldText(rec.loc)}`, detail: [fmtDay(rec.at), describeLocation(rec.loc)].filter(Boolean).join(' · '), loc: rec.loc });
  }
  const city = (listedCity || '').trim();
  const same = t => (t || '').trim().toLowerCase() === city.toLowerCase();
  if (city && !(rec?.loc && (same(locationFieldText(rec.loc)) || same(rec.loc.input)))) {
    out.push({ label: `laut Rufzeichenliste: ${city}`, detail: 'Wohnort laut Lizenz', text: city });
  }
  return out;
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
  let prefilled = null; // { at, src } while the field holds an untouched prefill
  let options = [];     // suggestions shown while the field is empty or prefilled

  function renderChip() {
    const text = input.value.trim();
    chip.className = chipBase;
    if (loc && prefilled) {
      chip.classList.add('prefilled');
      const t = `↺ vorgeschlagen (zuletzt ${fmtDay(prefilled.at)}): ${describeLocation(loc)} – Tippen ersetzt`;
      chip.textContent = t;
      chip.title = t;
    } else if (loc) {
      chip.classList.add(`conf-${loc.confidence}`);
      const t = `✓ ${describeLocation(loc)} (${loc.manual ? 'gewählt' : 'automatisch'}, ${LOC_CONF_TEXT[loc.confidence] || loc.confidence}) `;
      fill(chip, t,
        el('button', { type: 'button', class: 'link', tabindex: '-1', onclick: () => { setLoc(null); input.focus(); resolve(); } }, 'ändern'));
      chip.title = t;
    } else if (text) {
      chip.classList.add('unresolved');
      chip.textContent = 'nicht zugeordnet – wird als Text gespeichert';
      chip.title = '';
    } else {
      chip.textContent = '';
      chip.title = '';
    }
  }

  // The suggestions (if any) as the dropdown content; the one already
  // prefilled isn't repeated.
  function renderOptions() {
    const list = options.filter(o => !prefilled || o.loc !== prefilled.src);
    fill(results, list.length ? [
      el('div', { class: 'ac-head' }, prefilled ? 'Oder (↓, Enter):' : 'Vorschläge (↓, Enter):'),
      list.map(o => el('button', { type: 'button', class: 'ac-item', onclick: () => pickOption(o) },
        el('b', {}, o.label), o.detail ? el('small', {}, o.detail) : null)),
    ] : []);
    pop.update();
  }

  function pickOption(o) {
    if (o.loc) {
      ctl.adopt(o.loc);
      pop.hide();
      input.focus();
    } else {
      ctl.setText(o.text);
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
      renderOptions();
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
    prefilled = null;
    renderChip();
    clearTimeout(timer);
    timer = setTimeout(resolve, 200);
  });

  // A prefilled text is selected on focus: typing replaces it, Tab keeps it.
  input.addEventListener('focus', () => { if (prefilled) input.select(); });

  const ctl = {
    get: () => loc,
    // Restore a stored resolution (edit / draft) without re-resolving.
    set(value) {
      clearTimeout(timer);
      loc = value || null;
      prefilled = null;
      results.replaceChildren();
      pop.hide();
      if (plzInput && loc) plzInput.dataset.autofill = plzInput.value === loc.postcode ? loc.postcode : '';
      renderChip();
    },
    clear() {
      clearTimeout(timer);
      seq++;
      loc = null;
      prefilled = null;
      results.replaceChildren();
      pop.hide();
      if (plzInput) plzInput.dataset.autofill = '';
      renderChip();
    },
    isEmpty: () => !loc && !input.value.trim(),
    // Take over a stored location (e.g. the station's last known one).
    adopt(value) {
      clearTimeout(timer);
      seq++;
      prefilled = null;
      input.value = locationFieldText(value);
      setLoc({ ...value, manual: true }, true);
      results.replaceChildren();
      pop.hide();
    },
    // Put text into the field and resolve it like typed input.
    setText(text) {
      input.value = text;
      loc = null;
      prefilled = null;
      input.focus();
      resolve();
    },
    // Suggest a stored location (the station's last one) — only into an
    // empty field or over an earlier, untouched suggestion.
    prefill(value, at) {
      if (!(ctl.isEmpty() || prefilled)) return;
      ctl.adopt(value);
      prefilled = { at, src: value };
      renderChip();
      renderOptions();
      if (document.activeElement === input) input.select();
    },
    // Remove an untouched suggestion (the callsign changed).
    clearPrefill() {
      if (!prefilled) return;
      input.value = '';
      prefilled = null;
      setLoc(null);
      results.replaceChildren();
      pop.hide();
    },
    isPrefilled: () => !!prefilled,
    // Resolve the current text again (e.g. a value restored on opening).
    refresh() {
      resolve();
    },
    // Suggestions for the dropdown while the field is empty or prefilled.
    setOptions(list) {
      options = list || [];
      if (!input.value.trim() || prefilled) renderOptions();
    },
  };
  return ctl;
}
