// Export formats of the ADIF editor: ADI, plain CSV and the SOTA database's
// V2 CSV. Pure functions over (records, columns) — no DOM — so they're
// unit-tested in oe1ebg/tests/.

import { adifAscii, adifAsciiField } from '../../shared/js/adif.js';
import { ADIF_SPEC_FIELDS } from '../../shared/js/adif-spec-data.js';
import { csvSafeRows } from '../../shared/js/csv.js';

// No registered MIME type for ADIF; text/plain makes Safari save ".adi.txt".
export const ADI_MIME = 'application/octet-stream';

/* ---------- field definitions (USERDEF, type indicators) ---------- */

// What the loaded files say about fields ADIF doesn't define, kept so the
// ADI export can write it back (parseADIF()'s `defs`, merged per file):
//   userdefs: [{ name, type, spec, file }] — the header's USERDEFn
//     declarations in order: name upper-cased, type its indicator letter
//     ('' if it had none), spec the declaration as written (NAME,
//     NAME,{A,B} or NAME,{min:max}), file where it came from;
//   types: { NAME: 'N' } — the data type indicator a field had in the
//     records (first one seen), typeFiles: { NAME: file }.
export function emptyFieldDefs(){
  return { userdefs: [], types: {}, typeFiles: {} };
}

// NAME,{A,B} / NAME,{min:max} / NAME -> { name, values | null, range | null }.
function userdefParts(spec){
  const m = /^([^,{}]*?)\s*(?:,\s*\{(.*)\})?\s*$/.exec(spec || '');
  if (!m) return { name: String(spec || '').trim(), values: null, range: null, odd: true };
  const name = m[1].trim();
  if (m[2] === undefined) return { name, values: null, range: null };
  const range = /^\s*(-?\d+(?:\.\d+)?)\s*:\s*(-?\d+(?:\.\d+)?)\s*$/.exec(m[2]);
  if (range) return { name, values: null, range: [parseFloat(range[1]), parseFloat(range[2])] };
  return { name, values: m[2].split(',').map(s => s.trim()).filter(Boolean), range: null };
}

const userdefKey = spec => String(spec || '').replace(/\s+/g, '').toUpperCase();

// Two declarations of the same name and type as one that accepts the
// values of both: the union of two enumerations, the hull of two ranges,
// otherwise no restriction.
function widenUserdef(a, b){
  const pa = userdefParts(a), pb = userdefParts(b);
  if (pa.odd || pb.odd) return a;
  if (pa.values && pb.values){
    const seen = new Set(pa.values.map(v => v.toUpperCase()));
    const values = [...pa.values, ...pb.values.filter(v => !seen.has(v.toUpperCase()) && seen.add(v.toUpperCase()))];
    return `${pa.name},{${values.join(',')}}`;
  }
  if (pa.range && pb.range){
    return `${pa.name},{${Math.min(pa.range[0], pb.range[0])}:${Math.max(pa.range[1], pb.range[1])}}`;
  }
  return pa.name;
}

// Adds one loaded file's definitions (parseADIF()'s defs) to the log's
// (target, changed in place) and returns what didn't fit, as messages:
// - a USERDEF of a new name is appended;
// - the same name and type with other enumeration values or another range:
//   widened so the values of both files stay valid (widenUserdef);
// - the same name with another type: the first declaration stays, the
//   later file's values are checked against it (the issue list says which
//   don't fit);
// - another type indicator for a field: the first one stays.
export function mergeFieldDefs(target, defs, file){
  const msgs = [];
  for (const u of defs?.userdefs || []){
    const have = target.userdefs.find(x => x.name === u.name);
    if (!have){ target.userdefs.push({ name: u.name, type: u.type || '', spec: u.spec, file }); continue; }
    if ((have.type || '') !== (u.type || '')){
      msgs.push(`${file}: USERDEF ${u.name} has type ${u.type || '(none)'} here, but ${have.type || '(none)'} in ${have.file}; ` +
        `the export keeps ${have.type || '(none)'}, so values from ${file} that don't fit it show up as issues.`);
    } else if (userdefKey(have.spec) !== userdefKey(u.spec)){
      const wide = widenUserdef(have.spec, u.spec);
      msgs.push(`${file}: USERDEF ${u.name} is declared as "${u.spec}" here, but "${have.spec}" in ${have.file}; ` +
        `the export declares "${wide}", which accepts the values of both.`);
      have.spec = wide;
    }
  }
  for (const [name, t] of Object.entries(defs?.types || {})){
    if (!(name in target.types)){ target.types[name] = t; target.typeFiles[name] = file; }
    else if (target.types[name] !== t && !ADIF_SPEC_FIELDS[name] && !target.userdefs.some(u => u.name === name)){
      msgs.push(`${file}: ${name} has data type ${t} here, but ${target.types[name]} in ${target.typeFiles[name]}; ` +
        `the export writes ${target.types[name]}, so values that don't fit it show up as issues.`);
    }
  }
  return msgs;
}

// A field's definitions are dropped with its column.
export function forgetFieldDefs(target, name){
  target.userdefs = target.userdefs.filter(u => u.name !== name);
  delete target.types[name];
  delete target.typeFiles[name];
}

/* ---------- ADI ---------- */

// Values may keep < and > (legal inside a length-delimited value), and
// MultilineString fields (ADDRESS, NOTES, ...) their line breaks. So may
// user-defined fields declared M (MultilineString) and application-defined
// fields with the indicator M, or none: ADIF reads those as MultilineString
// (IV.A.4). Fields with another type get line breaks as blanks.
const ASCII_OPTS = { keepBrackets: true };
const MULTILINE_OPTS = { keepBrackets: true, multiline: true };
const MULTILINE_INDICATORS = new Set(['M', 'G']);

// Per column: [ascii options, type indicator to write ('' for none)].
function columnFormats(columns, defs){
  const userdefs = new Map((defs?.userdefs || []).map(u => [u.name, u.type]));
  const types = defs?.types || {};
  return columns.map(col => {
    const spec = ADIF_SPEC_FIELDS[col];
    if (spec) return [spec.type === 'MultilineString' ? MULTILINE_OPTS : ASCII_OPTS, ''];
    // USERDEF fields: the type is in the header, the tags carry none
    if (userdefs.has(col)) return [MULTILINE_INDICATORS.has(userdefs.get(col)) ? MULTILINE_OPTS : ASCII_OPTS, ''];
    const t = types[col];
    if (t) return [MULTILINE_INDICATORS.has(t) ? MULTILINE_OPTS : ASCII_OPTS, t];
    return [col.startsWith('APP_') ? MULTILINE_OPTS : ASCII_OPTS, ''];
  });
}

// ADI is an ASCII format (ADIF 3.1.7: String = ASCII 32-126, the length
// counts characters): values are transliterated like in the confirmation
// log's export (adifAscii in shared/js/adif.js). defs (optional, see
// emptyFieldDefs()): the USERDEF declarations go into the header, type
// indicators onto the fields ADIF doesn't define.
export function serializeADIF(records, columns, createdIso = new Date().toISOString(), defs = null){
  const ts = createdIso.replace(/[-:]/g, '').replace('T', ' ').slice(0, 15);
  const out = ["Generated by ADIF Editor (client-side, no server round-trip)\n",
    `<PROGRAMID:10>ADIFEditor\n<ADIF_VER:5>3.1.7\n<CREATED_TIMESTAMP:15>${ts}\n`];
  (defs?.userdefs || []).forEach((u, i) => {
    const spec = adifAscii(u.spec, ASCII_OPTS);
    out.push(`<USERDEF${i + 1}:${spec.length}${u.type ? ':' + u.type : ''}>${spec}\n`);
  });
  out.push('<EOH>\n\n');
  const formats = columnFormats(columns, defs);
  const n = columns.length;
  for (const rec of records){
    for (let c = 0; c < n; c++){
      const v = rec[columns[c]];
      if (v === undefined || v === null || v === '') continue; // ADIF has no empty fields
      out.push(adifAsciiField(columns[c], v, formats[c][0], formats[c][1]));
    }
    out.push("<EOR>\n");
  }
  return out.join('');
}

// How many values the ADI export has to change (non-ASCII characters,
// line breaks, surrounding blanks), so the editor can say so.
export function adifChangedValues(records, columns, defs = null){
  let n = 0;
  const formats = columnFormats(columns, defs);
  for (const rec of records) for (let c = 0; c < columns.length; c++) {
    const v = rec[columns[c]];
    if (v !== undefined && v !== null && v !== '' && adifAscii(v, formats[c][0]) !== String(v)) n++;
  }
  return n;
}

/* ---------- CSV ---------- */

// Every column, blank cells included, RFC 4180 quoting, spreadsheet-safe
// (../../shared/js/csv.js: a value or field name starting like a formula
// gets a leading '; stats.guarded counts them).
export function serializeCSV(records, columns, stats){
  // Unlike serializeADIF, every column must be emitted positionally (including
  // blank cells) or rows would misalign — don't reuse the ADIF skip-empty loop.
  const rows = [columns];
  for (const rec of records) rows.push(columns.map(c => rec[c] ?? ''));
  // BOM: Excel only reads the file as UTF-8 (umlauts) with it. Not for the
  // SOTA CSV below, whose importer expects plain text.
  return '﻿' + csvSafeRows(rows, ',', stats);
}

/* SOTA database V2 CSV format, verified against sotadata.org.uk's own
   ActivatorCSVInfo.htm and a working converter's source (not just blog posts):
   V2,<My Callsign>,<My Summit>,<Date DD/MM/YYYY>,<Time HHMM>,<Band>,<Mode>,
   <His Callsign>,<His Summit>,<Notes/Comments> */

// SOTA's CSV importer has no quoting support: a comma or a line break in a
// field would split it, so commas become ";" and line breaks / control
// characters a blank (one QSO = one line). Deliberately NOT the
// spreadsheet CSV (no quoting, no leading '): this file goes to SOTA's
// importer as is. stats.flattened counts the values changed.
function sotaSanitizeField(val, stats){
  const s = String(val ?? '');
  const t = s.replace(/,/g, ';').replace(/[\x00-\x1f\x7f]+/g, ' ');
  if (t !== s && stats) stats.flattened = (stats.flattened || 0) + 1;
  return t;
}

function sotaDate(qsoDate){
  return /^\d{8}$/.test(qsoDate || '') ? `${qsoDate.slice(6,8)}/${qsoDate.slice(4,6)}/${qsoDate.slice(0,4)}` : '';
}

function sotaTime(timeOn){
  const t = timeOn || '';
  return t.length >= 4 ? t.slice(0,4) : '';
}

function sotaRow(rec, stats){
  const myCall = rec.STATION_CALLSIGN || rec.OPERATOR || '';
  return [
    'V2', myCall, rec.MY_SOTA_REF || '', sotaDate(rec.QSO_DATE), sotaTime(rec.TIME_ON),
    rec.BAND || '', rec.MODE || '', rec.CALL || '', rec.SOTA_REF || '',
    rec.COMMENT || rec.NOTES || ''
  ].map(v => sotaSanitizeField(v, stats)).join(',');
}

export function serializeSotaCsv(records, mode, stats){
  const field = mode === 'chaser' ? 'SOTA_REF' : 'MY_SOTA_REF';
  const filtered = records.filter(r => (r[field] || '').trim() !== '');
  // SOTA requires chronological order; sort only this exported copy, never
  // the main table's row order.
  filtered.sort((a, b) => (a.QSO_DATE + a.TIME_ON).localeCompare(b.QSO_DATE + b.TIME_ON));
  return filtered.length ? filtered.map(r => sotaRow(r, stats)).join('\r\n') + '\r\n' : '';
}
