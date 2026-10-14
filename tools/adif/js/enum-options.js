// Which ADIF editor cells get a dropdown or suggestions, and their options.
// Pure (no DOM): unit-tested in oe1ebg/tests/adif-enum-options.test.mjs;
// cell-editors.js turns the lists into <select>s and the suggestion list.
//
// ADIF 3.1.8 has two kinds of enumerated fields, and the editor follows the
// validator (../../shared/js/adif-validate.js) for both:
// - strict: type Enumeration (BAND, MODE, QSL_RCVD, DXCC, …), any other
//   value is an error -> a <select> ('select'); STATE and CNTY only have a
//   list for some DXCC entities -> a <select> where the row's (MY_)DXCC has
//   one, else free text ('scoped');
// - open: a String field that recommends an enumeration (CONTEST_ID,
//   SUBMODE by MODE), other values are allowed -> free text with
//   suggestions ('suggest').
// A value in the log is never changed by showing it: the option of the
// stored value has exactly the stored value (its own spelling, e.g. "20M"
// or DXCC "001"), and a value the list doesn't offer stays in it, marked.
//
// Top-level names start with "eo" (one scope in the single-file bundle).

import { ADIF_SPEC_FIELDS, ADIF_SPEC_ENUMS, ADIF_SPEC_VERSION } from '../../shared/js/adif-spec-data.js';
import { userdefParts } from './export.js';

const EO_DXCC = 'DXCC_Entity_Code';
const EO_USERDEF = 'userdef:';

// A column's cell kind, or null for plain text. fieldDefs: the log's
// USERDEF declarations (export.js, emptyFieldDefs()); ADIF's own fields
// come first, as in the validator.
// select: { kind, key }; scoped: { kind, enumName, scope };
// suggest: { kind, enumName, scope | null }.
export function eoColumnKind(col, fieldDefs){
  const def = ADIF_SPEC_FIELDS[col];
  if (def){
    if (def.header || !def.enum || !ADIF_SPEC_ENUMS[def.enum]) return null;
    if (def.type === 'Enumeration'){
      return def.enumScope ? { kind: 'scoped', enumName: def.enum, scope: def.enumScope } : { kind: 'select', key: def.enum };
    }
    if (def.type === 'String') return { kind: 'suggest', enumName: def.enum, scope: def.enumScope || null };
    return null; // CreditList, SponsoredAwardList, …: lists of values
  }
  const u = fieldDefs?.userdefs?.find(x => x.name === col);
  if (!u || u.type !== 'E') return null;
  const parts = userdefParts(u.spec);
  return parts.values?.length ? { kind: 'select', key: EO_USERDEF + u.spec } : null;
}

// The validator's comparison key (avCheckEnum): DXCC codes as numbers
// ("001" = "1"), everything else without letter case.
export function eoNormKey(enumName, v){
  const s = String(v);
  return enumName === EO_DXCC && /^\d+$/.test(s) ? String(parseInt(s, 10)) : s.toUpperCase();
}

// Option lists by key: an enumeration name ('Band'), a scoped list
// ('Primary_Administrative_Subdivision@291') or a USERDEF ('userdef:' +
// its declaration). { enumName, options: [{ value, label }] (offered,
// without the empty option), pos: Map(norm key -> index in options),
// importOnly: Set(norm key), note(ctx): why a value is not offered }.
const eoLists = new Map();

function eoDxccLabel(code, shown){
  const e = ADIF_SPEC_ENUMS[EO_DXCC];
  const name = e.labels?.[code];
  const deleted = (e.deleted || []).includes(code) ? ' (deleted)' : '';
  return name ? `${shown} – ${name}${deleted}` : `${shown}${deleted}`;
}

function eoBuildList(key){
  let enumName = null, values = [], importOnly = [], note;
  if (key.startsWith(EO_USERDEF)){
    values = userdefParts(key.slice(EO_USERDEF.length)).values || [];
    note = () => 'not declared in USERDEF';
  } else if (key.includes('@')){
    const at = key.indexOf('@');
    enumName = key.slice(0, at);
    values = ADIF_SPEC_ENUMS[enumName]?.byScope?.[key.slice(at + 1)] || [];
    // the spec's import-only list of these values doesn't say for which
    // entity it holds (BC and NL: valid for Canada, import-only for Mexico)
    note = ctx => `not listed for ${ctx?.scopeField || 'DXCC'}=${ctx?.scopeValue ?? ''}`;
  } else {
    enumName = key;
    const e = ADIF_SPEC_ENUMS[key];
    values = e?.values || [];
    importOnly = e?.importOnly || [];
    note = () => `not in ADIF ${ADIF_SPEC_VERSION}`;
  }
  const io = new Set(importOnly.map(v => eoNormKey(enumName, v)));
  const options = [], pos = new Map();
  for (const v of values){
    const k = eoNormKey(enumName, v);
    if (io.has(k) || pos.has(k)) continue; // import-only: not offered; REGION lists KO three times
    pos.set(k, options.length);
    options.push({ value: v, label: enumName === EO_DXCC ? eoDxccLabel(v, v) : v });
  }
  return { enumName, options, pos, importOnly: io, note };
}

export function eoOptionList(key){
  let list = eoLists.get(key);
  if (!list){ list = eoBuildList(key); eoLists.set(key, list); }
  return list;
}

// Scope context of a scoped cell (for the "not listed for DXCC=…" note).
export function eoScopeCtx(kind, rec){
  return kind?.kind === 'scoped' ? { scopeField: kind.scope, scopeValue: rec?.[kind.scope] ?? '' } : null;
}

// The list key of a scoped cell from its row (null: the row's (MY_)DXCC
// has no list, the cell stays text; the validator checks nothing then).
export function eoScopedKey(kind, rec){
  const v = rec?.[kind.scope];
  if (v === undefined || v === null || v === '') return null;
  const s = /^\d+$/.test(String(v)) ? String(parseInt(v, 10)) : String(v).toUpperCase();
  return ADIF_SPEC_ENUMS[kind.enumName]?.byScope?.[s] ? `${kind.enumName}@${s}` : null;
}

// The stored value as an option: { value (= raw), label, pos } with pos
// its index in the list's options (-1: it isn't offered and gets its own,
// marked option).
export function eoCurrent(key, raw, ctx){
  const r = raw === undefined || raw === null ? '' : String(raw);
  if (r === '') return { value: '', label: '', pos: -1 };
  const list = eoOptionList(key);
  const k = eoNormKey(list.enumName, r);
  const pos = list.pos.get(k);
  if (pos !== undefined) return { value: r, label: list.enumName === EO_DXCC ? eoDxccLabel(list.options[pos].value, r) : r, pos };
  const why = list.importOnly.has(k) ? 'import-only' : list.note(ctx);
  return { value: r, label: `${r} (${why})`, pos: -1 };
}

// All options of a cell, the empty one ("no value") first, with the
// stored value's option holding exactly raw.
export function eoCellOptions(key, raw, ctx){
  const cur = eoCurrent(key, raw, ctx);
  const options = [{ value: '', label: '' }, ...eoOptionList(key).options];
  if (cur.value !== ''){
    if (cur.pos >= 0) options[cur.pos + 1] = { value: cur.value, label: cur.label };
    else options.splice(1, 0, { value: cur.value, label: cur.label });
  }
  return options;
}

/* ---------- suggestions (CONTEST_ID, SUBMODE) ---------- */

const eoSuggestLists = new Map();

function eoSuggestValues(source, rec){
  const e = ADIF_SPEC_ENUMS[source.enumName];
  if (!e) return [];
  // SUBMODE: the submodes of the row's MODE, all of them without one
  let id = source.enumName;
  let values;
  const scoped = source.scope && e.byScope;
  const scopeVal = scoped ? String(rec?.[source.scope] ?? '').toUpperCase() : '';
  if (scoped && e.byScope[scopeVal]){
    id += '@' + scopeVal;
    values = e.byScope[scopeVal];
  } else if (scoped){
    values = Object.values(e.byScope).flat();
  } else {
    values = e.values || [];
  }
  let list = eoSuggestLists.get(id);
  if (!list){
    const io = new Set((e.importOnly || []).map(v => v.toUpperCase()));
    const seen = new Set();
    list = values.filter(v => { const k = v.toUpperCase(); return !io.has(k) && !seen.has(k) && seen.add(k); });
    eoSuggestLists.set(id, list);
  }
  return list;
}

// The suggestions for what is typed (case-insensitive; values starting
// with it first, then those containing it): { items (at most limit), total }.
export function eoSuggestions(source, rec, query, limit = 30){
  const all = eoSuggestValues(source, rec);
  const q = String(query || '').trim().toUpperCase();
  const starts = [], contains = [];
  for (const v of all){
    const u = v.toUpperCase();
    if (!q || u.startsWith(q)) starts.push(v);
    else if (u.includes(q)) contains.push(v);
  }
  const hits = starts.concat(contains);
  return { items: hits.slice(0, limit), total: hits.length };
}

// Cells whose list depends on this column (DXCC -> STATE, CNTY; MY_DXCC
// -> MY_STATE, MY_CNTY): to be rendered again when it changes.
const eoDependentMap = new Map();
for (const [name, def] of Object.entries(ADIF_SPEC_FIELDS)){
  if (def.type !== 'Enumeration' || !def.enumScope) continue;
  if (!eoDependentMap.has(def.enumScope)) eoDependentMap.set(def.enumScope, []);
  eoDependentMap.get(def.enumScope).push(name);
}

export function eoDependents(col){
  return eoDependentMap.get(col) || [];
}
