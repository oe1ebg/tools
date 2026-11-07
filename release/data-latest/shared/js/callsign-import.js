// Parsers for the callsign lists a user imports (shared callsign store):
// the Ham2K PoLo "callsign notes" text format and CSV. Pure functions, no
// DOM, no storage. Results carry codes, never texts: the page translates.
//
// PoLo notes (the "Callsign Notes" page of the Ham2K PoLo docs;
// there is no formal specification): UTF-8 text, one callsign per line
// followed by free text (usually an emoji, a name, a role, sometimes
// markdown links). Blank lines and lines starting with # are ignored; a
// "# TITLE: x" line names the list. The first token is the callsign (it may
// be prefixed or suffixed, PA/DJ2CK, and special-event calls exist), the
// rest is kept verbatim as a note: it is not split into name and QTH. The
// same callsign may appear several times (different roles); every line is
// kept. PoLo's ".." expansion shorthand is not supported: such lines are
// skipped and counted.
//
// Top-level names start with "callsign"/"CALLSIGN_": the single-file
// bundles share one scope with the tools' own modules.

import { baseCall, normalizeCall } from './callbook.js';

export const CALLSIGN_IMPORT_MAX_BYTES = 8 * 1024 * 1024;
export const CALLSIGN_IMPORT_MAX_ROWS = 200000;

// A callsign-like first token: letters, digits and slashes, at least one
// digit and one letter ("NKQ4", "PA/DJ2CK", "OE1EBG/P").
const CALLSIGN_TOKEN_RE = /^(?=.*[0-9])(?=.*[A-Z])[A-Z0-9]{1,8}(?:\/[A-Z0-9]{1,8}){0,2}$/;

export function callsignTokenOk(token) {
  return CALLSIGN_TOKEN_RE.test(token);
}

function callsignSplitLines(text) {
  return String(text ?? '').replace(/^﻿/, '').split(/\r\n|\r|\n/);
}

function callsignTooBig(text) {
  // UTF-16 length is a lower bound of the bytes; 3 bytes per unit is the
  // upper bound: decide on the cheap bound first.
  const s = String(text ?? '');
  if (s.length * 3 <= CALLSIGN_IMPORT_MAX_BYTES) return false;
  return new TextEncoder().encode(s).length > CALLSIGN_IMPORT_MAX_BYTES;
}

// { title, rows: [{ call, base, note }], skipped: { invalid, expansion, blank } }
// or { error: 'too-large' | 'too-many' }.
export function parsePoloNotes(text) {
  if (callsignTooBig(text)) return { error: 'too-large' };
  const rows = [];
  const skipped = { invalid: 0, expansion: 0 };
  let title = '';
  for (const raw of callsignSplitLines(text)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      const m = /^#\s*TITLE\s*:\s*(.+)$/i.exec(line);
      if (m && !title) title = m[1].trim();
      continue;
    }
    const m = /^(\S+)(?:\s+([\s\S]*))?$/.exec(line);
    const token = m[1].toUpperCase();
    if (/^[./]{2,}/.test(token)) { skipped.expansion++; continue; }
    if (!callsignTokenOk(token)) { skipped.invalid++; continue; }
    if (rows.length >= CALLSIGN_IMPORT_MAX_ROWS) return { error: 'too-many' };
    rows.push({ call: token, base: baseCall(token), note: (m[2] || '').trim() });
  }
  return { title, rows, skipped };
}

// Separator of a delimited line: the first of ; tab , that occurs.
function callsignSeparator(line) {
  for (const sep of [';', '\t', ',']) if (line.includes(sep)) return sep;
  return ';';
}

// RFC 4180 style records: quotes may hold the separator, doubled quotes
// and line breaks.
function callsignCsvRecords(text, sep) {
  const out = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const s = String(text).replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += c;
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some(v => v.trim() !== '')) out.push(row);
      row = [];
      if (out.length > CALLSIGN_IMPORT_MAX_ROWS + 1) return out;
    } else cell += c;
  }
  row.push(cell);
  if (row.some(v => v.trim() !== '')) out.push(row);
  return out;
}

const CALLSIGN_HEAD_CALL = /^(call|callsign|rufzeichen)$/i;
const CALLSIGN_HEAD_NAME = /^(name)$/i;
const CALLSIGN_HEAD_QTH = /^(qth|ort|location|city)$/i;

// call[,name[,qth]] with an optional header row (call/callsign/rufzeichen,
// name, qth/ort in any order). Separator ; tab or , by the first line.
// { rows: [{ call, base, name, qth }], skipped: { invalid }, header } or
// { error: 'too-large' | 'too-many' }.
export function parseCallsignCsv(text) {
  if (callsignTooBig(text)) return { error: 'too-large' };
  const first = callsignSplitLines(text).find(l => l.trim() !== '') || '';
  const records = callsignCsvRecords(text, callsignSeparator(first));
  let idx = { call: 0, name: 1, qth: 2 };
  let header = false;
  if (records.length && records[0].some(c => CALLSIGN_HEAD_CALL.test(c.trim()))) {
    header = true;
    const h = records.shift().map(c => c.trim());
    idx = {
      call: h.findIndex(c => CALLSIGN_HEAD_CALL.test(c)),
      name: h.findIndex(c => CALLSIGN_HEAD_NAME.test(c)),
      qth: h.findIndex(c => CALLSIGN_HEAD_QTH.test(c)),
    };
  }
  if (records.length > CALLSIGN_IMPORT_MAX_ROWS) return { error: 'too-many' };
  const rows = [];
  const skipped = { invalid: 0 };
  for (const r of records) {
    const call = normalizeCall(r[idx.call] ?? '');
    if (!callsignTokenOk(call)) { skipped.invalid++; continue; }
    rows.push({
      call,
      base: baseCall(call),
      name: idx.name >= 0 ? String(r[idx.name] ?? '').trim() : '',
      qth: idx.qth >= 0 ? String(r[idx.qth] ?? '').trim() : '',
    });
  }
  return { rows, skipped, header };
}

// By file name and content: .csv, or a first data line with ; or a tab, is
// CSV; anything else is PoLo notes. { kind: 'csv' | 'polo', ...parsed }.
export function parseCallsignFile(fileName, text) {
  const first = callsignSplitLines(text).find(l => l.trim() !== '' && !l.trim().startsWith('#')) || '';
  const csv = /\.csv$/i.test(fileName || '') || /[;\t]/.test(first);
  return csv ? { kind: 'csv', ...parseCallsignCsv(text) } : { kind: 'polo', ...parsePoloNotes(text) };
}
