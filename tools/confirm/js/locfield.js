// The log's `location` field: free text (what the operator heard) that is
// resolved with the offline Vienna lookup while typing. Candidates appear in
// a dropdown under the field; choosing one fills in the full address and
// the PLZ (the originally typed text is kept in `loc.input`, '' if nothing
// was typed). An automatic match keeps the typed text. `loc.origin` says
// where the location came from (LOC_ORIGINS in js/model.js): the search,
// the callsign list, or an earlier check-in (`originAt` = its time). Logging is never blocked: an unresolved
// location is saved as text. Once the callsign is known, the field can be
// prefilled with the station's last location, and other suggestions (e.g.
// the licence-list city) are offered in the dropdown while it is empty.

import { el, fill, popover } from '../../shared/js/dom.js';
import { loadLocationIndex, renderCandidates, autoSelectLevel } from './locationui.js';
import { locate } from '../../shared/js/location/index.js';
import { latLonToMaidenhead } from '../../shared/js/maidenhead.js';
import { LOC_ORIGINS, LOC_NAME_TYPES } from './model.js';

const LOC_CONF_TEXT = { exact: 'exakt', high: 'hoch', likely: 'wahrscheinlich', ambiguous: 'mehrdeutig', low: 'unsicher' };

// Compact, stable copy of a lookup result for storage on a log line. Area
// results (PLZ, Bezirk) also keep the locators they cover, biggest first;
// `maidenhead` is always the centre (that is what CSV/ADIF export).
export function snapshotLocation(r, input, manual, origin = 'search') {
  const snap = {
    type: r.type, label: r.label,
    street: r.street || '', houseNumber: r.houseNumber || '',
    postcode: r.postcode || '', district: r.district || null,
    lat: Math.round(r.lat * 1e5) / 1e5, lon: Math.round(r.lon * 1e5) / 1e5,
    maidenhead: r.type === 'maidenhead' ? r.maidenhead : latLonToMaidenhead(r.lat, r.lon, 6),
    source: r.source, confidence: r.confidence, manual: !!manual, input, origin,
  };
  if (r.bezirk) snap.bezirk = r.bezirk;
  // Found by another name ("Rudolfstiftung" -> Klinik Landstraße), outside Vienna.
  if (r.matchedName) snap.matched = r.matchedName;
  if (r.nameType) snap.nameType = r.nameType;
  if (r.city) snap.city = r.city;
  if (r.umland) snap.umland = true;
  if (r.areaInfo) snap.areaLocators = r.areaInfo.locators.map(l => l[0]);
  return snap;
}

export function describeLocation(loc) {
  if (!loc) return '';
  const more = loc.areaLocators?.length > 1 ? ` (+${loc.areaLocators.length - 1})` : '';
  const plz = loc.postcode && !loc.label.includes(loc.postcode) ? `, ${loc.postcode}${loc.city ? ' ' + loc.city : ''}` : '';
  return `${loc.label}${plz} · ${loc.maidenhead}${more}`;
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

// Location taken over from an earlier check-in: nothing typed now, origin
// 'previous' with the time of that check-in.
export function previousLocation(loc, at) {
  const { originAt, ...rest } = loc;
  return { ...rest, manual: true, input: '', origin: 'previous', originAt: at || originAt || '' };
}

// Dropdown suggestions for a station: its last logged location (stations
// store) and the city from the callsign list, unless that is the same text.
export function locationOptions(rec, listedCity) {
  const out = [];
  if (rec?.loc) {
    out.push({ label: `zuletzt: ${locationFieldText(rec.loc)}`, detail: [fmtDay(rec.at), describeLocation(rec.loc)].filter(Boolean).join(' · '), loc: rec.loc, at: rec.at });
  }
  const city = (listedCity || '').trim();
  const same = t => (t || '').trim().toLowerCase() === city.toLowerCase();
  if (city && !(rec?.loc && (same(locationFieldText(rec.loc)) || same(rec.loc.input)))) {
    out.push({ label: `laut Rufzeichenliste: ${city}`, detail: 'Wohnort laut Lizenz', text: city, origin: 'callbook' });
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
  let textOrigin = null; // origin of text put into the field by a suggestion (not typed)

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
      const from = loc.origin && loc.origin !== 'search' ? `, ${LOC_ORIGINS[loc.origin]?.text || loc.origin}` : '';
      const as = loc.matched ? ` – eingegeben als „${loc.matched}“${LOC_NAME_TYPES[loc.nameType] && loc.nameType !== 'alias' ? ` (${LOC_NAME_TYPES[loc.nameType]})` : ''}` : '';
      const t = `✓ ${describeLocation(loc)}${as} (${loc.manual ? 'gewählt' : 'automatisch'}, ${LOC_CONF_TEXT[loc.confidence] || loc.confidence}${from}) `;
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
      ctl.adopt(o.loc, o.at);
      pop.hide();
      input.focus();
    } else {
      ctl.setText(o.text, o.origin);
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
    const snap = snapshotLocation(r, textOrigin ? '' : typed, true, textOrigin || 'search');
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
    // The callsign-list city was picked on purpose: take its best match
    // down to "likely" (Vienna PLZ like "1220 Wien" are never "high").
    const level = textOrigin ? 'likely' : autoSelectLevel();
    const res = locate(idx, text, { autoSelect: level === 'never' ? 'none' : level, limit: 6 });
    renderCandidates(results, res, { compact: true, onPick: r => choose(r, text) });
    pop.update();
    setLoc(res.autoSelect ? snapshotLocation(res.autoSelect, textOrigin ? '' : text, !!textOrigin, textOrigin || 'search') : null);
  }

  input.addEventListener('input', () => {
    loc = null;
    prefilled = null;
    textOrigin = null;
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
      textOrigin = null;
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
      textOrigin = null;
      results.replaceChildren();
      pop.hide();
      if (plzInput) plzInput.dataset.autofill = '';
      renderChip();
    },
    isEmpty: () => !loc && !input.value.trim(),
    // Take over the station's location from an earlier check-in at `at`.
    adopt(value, at) {
      clearTimeout(timer);
      seq++;
      prefilled = null;
      textOrigin = null;
      input.value = locationFieldText(value);
      setLoc(previousLocation(value, at), true);
      results.replaceChildren();
      pop.hide();
    },
    // Put text into the field and resolve it like typed input; `origin`
    // marks text that wasn't typed (the callsign-list city).
    setText(text, origin) {
      input.value = text;
      loc = null;
      prefilled = null;
      textOrigin = origin || null;
      input.focus();
      resolve();
    },
    // Suggest a stored location (the station's last one) — only into an
    // empty field or over an earlier, untouched suggestion.
    prefill(value, at) {
      if (!(ctl.isEmpty() || prefilled)) return;
      ctl.adopt(value, at);
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
