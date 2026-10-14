// Date and time fields of the ADIF editor. Shown and typed as ISO 8601
// (2026-09-01; 12:00 or 12:00:30, 24-hour UTC), as every tool shows dates
// (AGENTS.md); stored as ADIF (20260901; 1200 or 120030). A stored value
// that is no ADIF date or time is shown as it is, so the validator's
// finding stays visible. Pure apart from dtOpenPicker: unit-tested in
// oe1ebg/tests/adif-datetime.test.mjs.
//
// Top-level names start with "dt" (one scope in the single-file bundle).

import { ADIF_SPEC_FIELDS } from '../../shared/js/adif-spec-data.js';
import { el } from '../../shared/js/dom.js';

export const DT_DATE = Object.freeze({ kind: 'date' });
export const DT_TIME = Object.freeze({ kind: 'time' });

// A column's date/time kind, or null: ADIF's Date and Time fields (QSO_DATE,
// QSLRDATE, …, TIME_ON, TIME_OFF), and a USERDEF or APP_ field declared
// with type D or T. fieldDefs: the log's declarations (export.js).
export function dtColumnKind(col, fieldDefs){
  const def = ADIF_SPEC_FIELDS[col];
  if (def){
    if (def.header) return null;
    return def.type === 'Date' ? DT_DATE : def.type === 'Time' ? DT_TIME : null;
  }
  const type = fieldDefs?.userdefs?.find(u => u.name === col)?.type || fieldDefs?.types?.[col] || '';
  const t = String(type).toUpperCase();
  return t === 'D' ? DT_DATE : t === 'T' ? DT_TIME : null;
}

// The shown form of a stored value: 20260901 -> 2026-09-01, 1200 -> 12:00,
// 120030 -> 12:00:30; anything else unchanged.
export function dtShow(kind, value){
  const s = String(value ?? '');
  if (kind.kind === 'date') return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}` : s;
  if (/^\d{4}$/.test(s)) return `${s.slice(0, 2)}:${s.slice(2)}`;
  if (/^\d{6}$/.test(s)) return `${s.slice(0, 2)}:${s.slice(2, 4)}:${s.slice(4)}`;
  return s;
}

// The stored form of a typed value. Dates: 2026-09-01, 2026-9-1 (also
// with . or /) or 20260901 -> 20260901. Times: 12:00, 9:05, 12:00:30, 1200
// or 120030 -> 1200, 0905, 120030 (seconds only when typed). Anything else
// is kept as typed (trimmed): the validator reports it.
export function dtParse(kind, text){
  const s = String(text ?? '').trim();
  if (kind.kind === 'date'){
    const m = /^(\d{4})[-./](\d{1,2})[-./](\d{1,2})$/.exec(s);
    return m ? m[1] + m[2].padStart(2, '0') + m[3].padStart(2, '0') : s;
  }
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  return m ? m[1].padStart(2, '0') + m[2] + (m[3] ?? '') : s;
}

// A typed date as ADIF YYYYMMDD, '' when it is none (the filter's range).
export function dtAdifDate(text){
  const d = dtParse(DT_DATE, text);
  return /^\d{8}$/.test(d) ? d : '';
}

// A stored or typed date as YYYY-MM-DD when it is a real calendar date
// (the value an <input type="date"> takes), else ''.
export function dtIsoDate(value){
  const d = dtAdifDate(value);
  if (!d) return '';
  const y = Number(d.slice(0, 4)), mo = Number(d.slice(4, 6)), da = Number(d.slice(6));
  const t = new Date(Date.UTC(y, mo - 1, da));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== da) return '';
  return dtShow(DT_DATE, d);
}

// The browser's own calendar, opened under `anchor` from a hidden
// <input type="date">. Only its value is used, always YYYY-MM-DD; its
// locale-formatted field never shows. Without showPicker (Safari < 16)
// there is no calendar: typing works everywhere.
export const dtPickerSupported = typeof HTMLInputElement !== 'undefined' && 'showPicker' in HTMLInputElement.prototype;

export function dtOpenPicker(anchor, value, onPick){
  if (!dtPickerSupported) return false;
  let input = document.getElementById('dt-picker');
  if (!input){
    input = el('input', { type: 'date', id: 'dt-picker', tabindex: '-1', 'aria-hidden': 'true' });
    document.body.append(input);
  }
  const r = anchor.getBoundingClientRect();
  input.style.left = `${Math.round(r.left)}px`;
  input.style.top = `${Math.round(r.bottom)}px`;
  input.value = dtIsoDate(value);
  input.onchange = () => { if (input.value) onPick(input.value); };
  try {
    input.showPicker();
    return true;
  } catch {
    return false; // e.g. without a user gesture
  }
}
