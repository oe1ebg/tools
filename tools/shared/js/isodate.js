// ISO 8601 dates in every tool (root AGENTS.md): typed and shown as
// YYYY-MM-DD, never in the browser's locale format. A visible
// <input type="date"> would show that format, so a date field is a text
// field, and the browser's calendar only supplies its value: opened with
// showPicker() on a hidden <input type="date">, whose value is always
// YYYY-MM-DD. Without showPicker (Safari < 16) there is no calendar, and
// typing works everywhere.
//
// isoDateFromText is pure (node-tested in oe1ebg/tests/isodate.test.mjs);
// the rest needs the DOM, but nothing runs on import.
// Top-level names start with "iso" (one scope in the single-file bundles).

import { el } from './dom.js';

// A typed date as YYYY-MM-DD, or '' when it is none: 2026-09-01, 2026-9-1
// (also with . or /) or 20260901, and a real calendar date.
export function isoDateFromText(text){
  const s = String(text ?? '').trim();
  const m = /^(\d{4})[-./](\d{1,2})[-./](\d{1,2})$/.exec(s) || /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (!m) return '';
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return '';
  return `${m[1]}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export const isoPickerSupported = typeof HTMLInputElement !== 'undefined' && 'showPicker' in HTMLInputElement.prototype;

// Opens the browser's calendar under `anchor`, starting at `value` (any
// typed form), limited to opts.min/opts.max (YYYY-MM-DD); onPick(iso)
// gets the picked date. false: no calendar (unsupported, or no user
// gesture).
export function isoOpenPicker(anchor, value, onPick, opts = {}){
  if (!isoPickerSupported) return false;
  let input = document.getElementById('iso-date-picker');
  if (!input){
    input = el('input', { type: 'date', id: 'iso-date-picker', class: 'iso-date-picker', tabindex: '-1', 'aria-hidden': 'true' });
    document.body.append(input);
  }
  const r = anchor.getBoundingClientRect();
  input.style.left = `${Math.round(r.left)}px`;
  input.style.top = `${Math.round(r.bottom)}px`;
  input.min = opts.min || '';
  input.max = opts.max || '';
  input.value = isoDateFromText(value);
  input.onchange = () => { if (input.value) onPick(input.value); };
  try {
    input.showPicker();
    return true;
  } catch {
    return false;
  }
}

// A text field for one ISO date, with its calendar button (hidden without
// showPicker). A complete date is rewritten as YYYY-MM-DD when the field
// changes; anything else typed is marked aria-invalid. A picked date fires
// "change" on the field, as typing would. The calendar's range comes from
// data-min / data-max on the field (YYYY-MM-DD). Returns check(), which
// re-marks the field after its value was set from code.
export function isoBindDateField(input, button){
  const check = () => {
    const iso = isoDateFromText(input.value);
    if (iso && input.value !== iso) input.value = iso;
    if (input.value.trim() && !iso) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  };
  input.addEventListener('change', check);
  if (button){
    button.hidden = !isoPickerSupported;
    button.addEventListener('click', () => isoOpenPicker(input, input.value, iso => {
      input.value = iso;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.focus();
    }, { min: input.dataset.min, max: input.dataset.max }));
  }
  return check;
}
