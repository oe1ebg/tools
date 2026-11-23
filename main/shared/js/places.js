// Named places of the user (issue #181): Lichtinseln, K-Vorsorgestandorte,
// Verbindungsstationen … by name and aliases, with address and
// coordinates. The list is private to the user: nothing of it is bundled,
// it is imported from a CSV file into the shared place store
// (places-store.js) and offered by the location field next to the address
// lookup (locfield.js). Pure functions, no DOM, no storage: CSV reading
// and writing, the search, and the location result of a place.
//
// CSV (tools/shared/README.md, "Named places"): UTF-8 (with or without
// BOM; Windows-1252 as Excel writes it is accepted too), separator ; or ,
// (or a tab), by the header line, which is required:
//   Name;Typ;Adresse;Breite;Länge;Aliase
// Name, Breite (latitude) and Länge (longitude) are required, the others
// optional, in any order. Coordinates in decimal degrees, decimal point or
// comma ("48,2563" needs quotes when the separator is a comma). Aliases
// are separated by |. Rows without a name or valid coordinates are skipped
// and reported by line.
//
// Top-level names start with "places"/"PLACES_": the single-file bundles
// share one scope with the tools' own modules.

import { foldName } from './location/normalize.js';
import { csvSafeRows, csvIsFormula } from './csv.js';
import { latLonToMaidenhead } from './maidenhead.js';

// Resource limits (README): checked before anything is written.
export const PLACES_MAX_BYTES = 2 * 1024 * 1024;
export const PLACES_MAX_ROWS = 10000;
export const PLACES_MAX_TOTAL = 50000;      // all lists together
export const PLACES_MAX_ALIASES = 20;
export const PLACES_MAX_TEXT = 300;         // one name, alias, type or address

const PLACES_HEADS = {
  name: ['name', 'bezeichnung', 'ort'],
  type: ['typ', 'type', 'art', 'kategorie'],
  address: ['adresse', 'address', 'anschrift'],
  lat: ['breite', 'breitengrad', 'lat', 'latitude'],
  lon: ['laenge', 'langengrad', 'laengengrad', 'lange', 'lon', 'lng', 'longitude'],
  aliases: ['aliase', 'alias', 'aliases', 'andere namen'],
};

// The bytes of a file as text: UTF-8 (a BOM is dropped), else Windows-1252.
export function placesDecode(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, '');
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

// CSV records with the line each starts on; quotes may hold the separator,
// doubled quotes and line breaks.
function placesCsvRecords(text, sep) {
  const out = [];
  let row = [];
  let cell = '';
  let quoted = false;
  let line = 1;
  let start = 1;
  const s = String(text).replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else {
        if (c === '\n') line++;
        cell += c;
      }
    } else if (c === '"' && cell.trim() === '') { quoted = true; cell = ''; }
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some(v => v.trim() !== '')) out.push({ line: start, cells: row });
      row = [];
      line++;
      start = line;
      if (out.length > PLACES_MAX_ROWS + 1) return out;
    } else cell += c;
  }
  row.push(cell);
  if (row.some(v => v.trim() !== '')) out.push({ line: start, cells: row });
  return out;
}

const placesHeadKey = s => foldName(s, true);

// A cell as text; a leading ' that a CSV export put before a formula-like
// text (csv.js) is taken off again.
function placesCell(v) {
  const s = String(v ?? '').trim();
  return s.startsWith("'") && csvIsFormula(s.slice(1)) ? s.slice(1) : s;
}

// "48,2563", "+48.2563", "48.2563°" -> 48.2563; NaN when not a number.
export function placesNumber(v) {
  const s = String(v ?? '').trim().replace(/°$/, '').replace(',', '.');
  return /^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(s) ? Number(s) : NaN;
}

function placesTooBig(text) {
  const s = String(text ?? '');
  if (s.length * 3 <= PLACES_MAX_BYTES) return false;
  return new TextEncoder().encode(s).length > PLACES_MAX_BYTES;
}

// -> { rows: [{ name, type, address, lat, lon, aliases }], skipped:
// [{ line, reason }], sep } or { error: 'too-large' | 'too-many' |
// 'no-header', missing?: ['name'|'lat'|'lon'] }. Reasons: 'name',
// 'coords', 'swapped', 'long', 'aliases'.
export function placesParseCsv(text) {
  if (placesTooBig(text)) return { error: 'too-large' };
  const s = String(text ?? '').replace(/^﻿/, '');
  const first = s.split(/\r\n|\r|\n/).find(l => l.trim() !== '') || '';
  const sep = first.includes(';') ? ';' : first.includes('\t') ? '\t' : ',';
  const records = placesCsvRecords(s, sep);
  if (!records.length) return { error: 'no-header', missing: ['name', 'lat', 'lon'] };
  const head = records.shift().cells.map(placesHeadKey);
  const idx = {};
  for (const [k, names] of Object.entries(PLACES_HEADS)) idx[k] = head.findIndex(h => names.includes(h));
  const missing = ['name', 'lat', 'lon'].filter(k => idx[k] < 0);
  if (missing.length) return { error: 'no-header', missing };
  if (records.length > PLACES_MAX_ROWS) return { error: 'too-many' };
  const rows = [];
  const skipped = [];
  const get = (r, k) => (idx[k] >= 0 ? placesCell(r.cells[idx[k]]) : '');
  for (const r of records) {
    const name = get(r, 'name');
    if (!name) { skipped.push({ line: r.line, reason: 'name' }); continue; }
    const lat = placesNumber(get(r, 'lat'));
    const lon = placesNumber(get(r, 'lon'));
    if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) { skipped.push({ line: r.line, reason: 'coords' }); continue; }
    // Austria lies at 46-49° N, 9-17° E: the other way round is a mix-up.
    if (lat >= 9 && lat <= 18 && lon >= 46 && lon <= 49.5) { skipped.push({ line: r.line, reason: 'swapped' }); continue; }
    const aliases = [...new Set(get(r, 'aliases').split('|').map(a => a.trim()).filter(a => a && a !== name))];
    if (aliases.length > PLACES_MAX_ALIASES) { skipped.push({ line: r.line, reason: 'aliases' }); continue; }
    const type = get(r, 'type');
    const address = get(r, 'address');
    if ([name, type, address, ...aliases].some(t => t.length > PLACES_MAX_TEXT)) { skipped.push({ line: r.line, reason: 'long' }); continue; }
    rows.push({ name, type, address, lat: Math.round(lat * 1e6) / 1e6, lon: Math.round(lon * 1e6) / 1e6, aliases });
  }
  return { rows, skipped, sep };
}

// The German text of a skip reason (dialog).
export const PLACES_SKIP_TEXT = {
  name: 'ohne Name',
  coords: 'ohne gültige Breite/Länge',
  swapped: 'Breite und Länge vertauscht?',
  long: `Text länger als ${PLACES_MAX_TEXT} Zeichen`,
  aliases: `mehr als ${PLACES_MAX_ALIASES} Aliase`,
};

// "3 Zeilen übersprungen: Zeile 4, 9 ohne Name; Zeile 7 ohne gültige
// Breite/Länge" ('' when none). At most `max` line numbers per reason.
export function placesSkippedText(skipped, max = 8) {
  if (!skipped || !skipped.length) return '';
  const by = new Map();
  for (const s of skipped) {
    if (!by.has(s.reason)) by.set(s.reason, []);
    by.get(s.reason).push(s.line);
  }
  const parts = [...by].map(([reason, lines]) => `Zeile ${lines.slice(0, max).join(', ')}${lines.length > max ? ` … (${lines.length})` : ''} ${PLACES_SKIP_TEXT[reason] || reason}`);
  return `${skipped.length} ${skipped.length === 1 ? 'Zeile' : 'Zeilen'} übersprungen: ${parts.join('; ')}`;
}

// A list's places as CSV (the import format, so it can be read again):
// ; separated, decimal comma, BOM, CRLF.
export function placesToCsv(places) {
  const num = v => String(v).replace('.', ',');
  const rows = [['Name', 'Typ', 'Adresse', 'Breite', 'Länge', 'Aliase'],
    ...places.map(p => [p.name, p.type || '', p.address || '', num(p.lat), num(p.lon), (p.aliases || []).join('|')])];
  return '﻿' + csvSafeRows(rows, ';') + '\r\n';
}

/* ---------------------------------------------------------------- search */

const placesKey = s => foldName(s, true).replace(/ /g, '');

// The search index of the places of the active lists: every name and alias
// as folded keys. places: [{ id, list, listName, name, type, address,
// lat, lon, aliases }].
export function placesIndex(places) {
  return places.map(p => ({
    p,
    names: [{ text: p.name, alias: false }, ...(p.aliases || []).map(a => ({ text: a, alias: true }))]
      .map(n => ({ ...n, key: placesKey(n.text), words: foldName(n.text, true).split(' ').filter(Boolean) })),
  }));
}

// How well a name matches the query: 0 exact, 1 starts with it, 2 every
// word starts a word of the name, 3 contains it (from 3 characters); -1 no.
function placesScore(n, qKey, qWords) {
  if (!qKey || !n.key) return -1;
  if (n.key === qKey) return 0;
  if (n.key.startsWith(qKey)) return 1;
  if (qWords.length && qWords.every(w => n.words.some(x => x.startsWith(w)))) return 2;
  if (qKey.length >= 3 && n.key.includes(qKey)) return 3;
  return -1;
}

const PLACES_CONF = ['exact', 'high', 'likely', 'likely'];

// The places matching a text, best first, as location results (see
// placesResult()). At least 2 characters.
export function placesSearch(index, text, max = 5) {
  const qKey = placesKey(text);
  if (qKey.length < 2) return [];
  const qWords = foldName(text, true).split(' ').filter(Boolean);
  const hits = [];
  for (const e of index) {
    let best = null;
    for (const n of e.names) {
      const s = placesScore(n, qKey, qWords);
      if (s >= 0 && (!best || s < best.s || (s === best.s && best.n.alias && !n.alias))) best = { s, n };
    }
    if (best) hits.push({ e, ...best });
  }
  hits.sort((a, b) => a.s - b.s || a.e.p.name.localeCompare(b.e.p.name, 'de'));
  return hits.slice(0, max).map(h => placesResult(h.e.p, h.s === 0 ? 'exact' : PLACES_CONF[h.s], h.n.alias ? h.n.text : null));
}

// The place of a text that names it exactly (name or alias), or null; the
// first list wins when several have it. For texts stored without a
// resolved place (the map).
export function placesResolve(index, text) {
  const hit = placesSearch(index, text, 1)[0];
  return hit && hit.confidence === 'exact' ? hit : null;
}

// A place as a result of the location lookup (location/index.js shape), so
// the location field lists, picks and stores it like an address:
// type 'place', the name as label, address, type of place and list kept.
export function placesResult(p, confidence = 'exact', alias = null) {
  const r = {
    type: 'place', label: p.name, placeType: p.type || '', address: p.address || '', list: p.listName || '',
    lat: p.lat, lon: p.lon, maidenhead: latLonToMaidenhead(p.lat, p.lon, 6),
    source: 'places', sources: ['places'], confidence,
    reasons: [alias ? `anderer Name in der Ortsliste „${p.listName || ''}“` : `Name in der Ortsliste „${p.listName || ''}“`],
  };
  if (alias) { r.matchedName = alias; r.nameType = 'alias'; }
  return r;
}

// The location lookup's answer with the matching places added: an exact
// name of a place wins (and is taken automatically unless that is
// switched off, level 'never'); otherwise the places come right after an
// automatic match, or first.
export function placesMerge(res, hits, { level = 'high', limit = 8 } = {}) {
  const base = res || { results: [], autoSelect: null };
  if (!hits.length) return base;
  const exact = hits.find(h => h.confidence === 'exact');
  const others = base.results || [];
  let results;
  let autoSelect = base.autoSelect || null;
  if (exact && level !== 'never') {
    results = [exact, ...hits.filter(h => h !== exact), ...others];
    autoSelect = exact;
  } else if (autoSelect) {
    results = [others[0], ...hits, ...others.slice(1)];
  } else {
    results = [...hits, ...others];
  }
  return { ...base, results: results.slice(0, limit), autoSelect };
}
