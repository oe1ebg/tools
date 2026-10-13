// Backups in parts (issue #15). An import refuses a file beyond a size / record
// limit (a browser can't parse arbitrarily large files), so an export that
// would exceed it is written as several files, each within the limit and
// each a valid backup file of the tool with an extra `part: { set, n, of }`.
// The import takes all parts together (one multi-file selection), checks that
// the set is complete and restores everything in ONE atomic write, with ids,
// revisions and counters as exported. A backup within the limits is written
// as before, one file without `part`.
// Pure (no DOM, no storage): used by the confirmation log and the Notfunk
// Meldebuch, node-tested (tests/backup-parts.test.mjs).

// Per part: well below the import limits (50 MB / 200000 records), the rest
// is room for the part header and the indentation of the final text.
export const PART_MAX_BYTES = 40 * 1024 * 1024;
export const PART_MAX_RECORDS = 80000; // x PARTS_MAX_COUNT stays within PARTS_MAX_TOTAL_RECORDS

// A set of parts is restored in one piece in memory, so the set is bounded too:
// at most 12 parts, 480 MB and 1000000 records in total (all parts together).
// Beyond that the import refuses the set (nothing is written); such a backup
// can only be split by hand (e.g. one log or operation at a time).
export const PARTS_MAX_COUNT = 12;
export const PARTS_MAX_TOTAL_BYTES = 480 * 1024 * 1024;
export const PARTS_MAX_TOTAL_RECORDS = 1000000;

// German refusal for a selection of files totalling `bytes`, or ''.
export function partsTooLarge(bytes) {
  return bytes > PARTS_MAX_TOTAL_BYTES
    ? `Die gewählten Dateien sind zusammen ${Math.round(bytes / 1048576)} MB groß; mehr als ${PARTS_MAX_TOTAL_BYTES / 1048576} MB werden nicht gemeinsam importiert (zu groß für diesen Browser) – es wurde nichts importiert.`
    : '';
}

// German refusal for a set with `records` records in total, or ''.
export function partsTooManyRecords(records) {
  return records > PARTS_MAX_TOTAL_RECORDS
    ? `Die Teile enthalten zusammen ${records} Datensätze; mehr als ${PARTS_MAX_TOTAL_RECORDS} werden nicht gemeinsam importiert (zu groß für diesen Browser) – es wurde nichts importiert.`
    : '';
}

// The refusal of an export that cannot be restored as one set; advice: what to do instead.
export function backupTooLargeMessage(advice) {
  return `Zu groß für eine einzige Sicherung (mehr als ${PARTS_MAX_COUNT} Dateien, ${PARTS_MAX_TOTAL_BYTES / 1048576} MB oder ${PARTS_MAX_TOTAL_RECORDS} Datensätze): sie ließe sich nicht wieder einspielen. Es wurde nichts heruntergeladen. ${advice}`;
}

// A string longer than this (characters) in a record is cut out of it for a
// split export and written as chunks of this size (see chunkRecord()): a
// record with a huge note or text then never has to fit in one part.
export const CHUNK_CHARS = 1 << 20;

// A record with its long strings cut out. rec: the record (not changed);
// kind: which list it belongs to ('entries', 'revisions', 'messages'); rid: its id.
// Returns { rec, chunks }: rec is rec itself when nothing is long, else a copy
// with '' in place of every string longer than maxChars (at any depth);
// chunks: [{ kind, rid, path, n, of, data }], n = 1..of, data = a piece of the
// string, path = where it belongs in the record (keys and array indexes).
export function chunkRecord(rec, kind, rid, maxChars = CHUNK_CHARS) {
  const found = [];
  const walk = (v, path) => {
    if (typeof v === 'string') {
      if (v.length <= maxChars) return v;
      found.push({ path, data: v });
      return '';
    }
    if (v === null || typeof v !== 'object') return v;
    let out = null;
    for (const k of Object.keys(v)) {
      const y = walk(v[k], [...path, Array.isArray(v) ? Number(k) : k]);
      if (y !== v[k]) {
        if (!out) out = Array.isArray(v) ? v.slice() : { ...v };
        out[k] = y;
      }
    }
    return out || v;
  };
  const stripped = walk(rec, []);
  const chunks = [];
  for (const f of found) {
    const of = Math.ceil(f.data.length / maxChars);
    for (let n = 1; n <= of; n++) chunks.push({ kind, rid, path: f.path, n, of, data: f.data.slice((n - 1) * maxChars, n * maxChars) });
  }
  return { rec: stripped, chunks };
}

// Puts the chunks of a set back into the records (changed in place).
//   chunks   every chunk of all parts, in any order
//   lookup   (kind, rid) -> the record, or undefined
// Every string must be complete: n = 1..of exactly once each, the same `of`,
// a record that is there, a path (own keys, no __proto__/constructor/prototype)
// that leads to the '' left in its place. lookup must not fail for an unknown
// kind (use a Map).
// Returns a German error text, or '' when all strings are whole again.
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const UNSAFE_KEYS = ['__proto__', 'constructor', 'prototype'];
const pathOk = path => Array.isArray(path) && path.length > 0 && path.length <= 20
  && path.every(k => (typeof k === 'string' && !UNSAFE_KEYS.includes(k)) || (Number.isSafeInteger(k) && k >= 0));

export function applyChunks(chunks, lookup) {
  const groups = new Map();
  for (const c of chunks) {
    const ok = c && typeof c === 'object' && typeof c.kind === 'string' && typeof c.rid === 'string' && pathOk(c.path)
      && Number.isSafeInteger(c.n) && Number.isSafeInteger(c.of) && c.of >= 1 && c.of <= 100000 && c.n >= 1 && c.n <= c.of && typeof c.data === 'string';
    if (!ok) return 'Textblock ungültig – die Teile sind beschädigt; es wurde nichts importiert.';
    const key = JSON.stringify([c.kind, c.rid, c.path]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  const todo = [];
  for (const list of groups.values()) {
    const { kind, rid, path, of } = list[0];
    if (list.some(c => c.of !== of)) return `Textblock von ${rid}: die Stücke passen nicht zusammen (verschiedene Anzahl); es wurde nichts importiert.`;
    const byN = new Map();
    for (const c of list) {
      if (byN.has(c.n)) return `Textblock von ${rid}: Stück ${c.n} doppelt; es wurde nichts importiert.`;
      byN.set(c.n, c.data);
    }
    for (let n = 1; n <= of; n++) if (!byN.has(n)) return `Textblock von ${rid}: Stück ${n} von ${of} fehlt; es wurde nichts importiert.`;
    const rec = lookup(kind, rid);
    if (!rec) return `Textblock von ${rid}: der Datensatz fehlt in den Teilen; es wurde nichts importiert.`;
    let holder = rec;
    for (const k of path.slice(0, -1)) holder = holder && typeof holder === 'object' && hasOwn(holder, k) ? holder[k] : undefined;
    const last = path[path.length - 1];
    // only the '' that the export left in place of the string may be filled
    if (!holder || typeof holder !== 'object' || !hasOwn(holder, last) || holder[last] !== '') return `Textblock von ${rid}: die Stelle im Datensatz passt nicht (nicht leer oder nicht vorhanden); es wurde nichts importiert.`;
    todo.push({ holder, last, text: Array.from({ length: of }, (_, i) => byN.get(i + 1)).join('') });
  }
  for (const t of todo) t.holder[t.last] = t.text; // all checked: now write
  return '';
}

const utf8 = new TextEncoder();
export const utf8Length = s => utf8.encode(s).length;

// Splits `items` (in order) into slices whose built text fits the limits.
//   build(slice, part)  slice -> the complete file text (part: the marker, or
//                       undefined when everything fits in one file)
//   weight(item)        how many records the item counts for the record limit
//   limits.expand       items -> items, applied once when the whole thing does not fit in
//                       one file (the tools cut long strings out into chunk items)
//   limits.tooLarge     German text of the refusal (the tool names what to do)
// Returns [slice, ...]; one slice when the whole thing fits. Slices are
// filled one after the other as far as they fit, so there are no more parts
// than needed. A set that cannot be
// restored (more than PARTS_MAX_COUNT parts, PARTS_MAX_TOTAL_BYTES or
// PARTS_MAX_TOTAL_RECORDS in total) is refused here with an Error: the caller
// must show it BEFORE anything is downloaded. Never a partial set, never data
// left out. A single item that is alone beyond the file limit (after the
// chunking) cannot be split: the export is refused.
export function splitToFit(allItems, build, weight, limits = {}) {
  let items = allItems;
  const { maxBytes = PART_MAX_BYTES, maxRecords = PART_MAX_RECORDS, maxParts = PARTS_MAX_COUNT,
    maxTotalBytes = PARTS_MAX_TOTAL_BYTES, maxTotalRecords = PARTS_MAX_TOTAL_RECORDS,
    tooLarge = 'Die Sicherung ist zu groß für eine einzige Sicherung. Es wurde nichts heruntergeladen.', expand } = limits;
  const probe = { set: '0'.repeat(36), n: 9999, of: 9999 };
  const records = slice => slice.reduce((n, x) => n + weight(x), 0);
  const fits = (slice, part) => records(slice) <= maxRecords && utf8Length(build(slice, part)) <= maxBytes;
  if (fits(items, undefined)) return [items];
  if (expand) items = expand(items);
  // greedy: each part takes as many items as fit (by records first, then by
  // the exact size), so there are no more parts than needed. The longest
  // prefix within maxBytes is searched with the exact size of its built text.
  // That size grows with the prefix, so each try is interpolated from the
  // sizes measured at both ends (regula falsi, Illinois variant: an end kept
  // twice in a row counts half, so the tries do not creep up from one side;
  // a few builds instead of one per halving of the span, which cost seconds
  // for the largest sets). After two tries in a row that did not halve the
  // span the next one halves it, so it never takes more than three times the
  // halvings. The prefix found is the same.
  const slices = [];
  const tooMany = () => Object.assign(new Error(tooLarge), { tooLarge: true });
  const size = (i, end) => utf8Length(build(items.slice(i, end), probe));
  for (let i = 0; i < items.length;) {
    let hi = i + 1, n = weight(items[i]);
    while (hi < items.length && n + weight(items[hi]) <= maxRecords) n += weight(items[hi++]);
    const hiBytes = hi - i > 1 ? size(i, hi) : 0;
    if (hiBytes > maxBytes) {
      // lo fits (or is the single first item, not measured), hi does not
      // below / above: how far the size at lo / hi is from maxBytes
      let lo = i + 1, below = maxBytes, above = hiBytes - maxBytes, kept = '', slow = 0;
      while (lo + 1 < hi) {
        const span = hi - lo;
        const guess = slow >= 2 ? (lo + hi) >> 1 : lo + Math.floor(span * below / (below + above));
        const mid = Math.min(hi - 1, Math.max(lo + 1, guess));
        const bytes = size(i, mid);
        if (bytes <= maxBytes) {
          lo = mid; below = maxBytes - bytes;
          if (kept === 'hi') above /= 2;
          kept = 'hi';
        } else {
          hi = mid; above = bytes - maxBytes;
          if (kept === 'lo') below /= 2;
          kept = 'lo';
        }
        slow = hi - lo > span / 2 ? slow + 1 : 0;
      }
      hi = lo;
    }
    if (hi === i + 1 && !fits([items[i]], probe)) throw tooMany(); // one record that cannot be split
    slices.push(items.slice(i, hi));
    if (slices.length > maxParts) throw tooMany();
    i = hi;
  }
  const total = records(items);
  let bytes = 0;
  for (const sl of slices) bytes += utf8Length(build(sl, probe));
  if (total > maxTotalRecords || bytes > maxTotalBytes) throw tooMany();
  return slices;
}

// The file name of part n of `of`: "<base>_teil-2-von-3.json".
export function partFileName(base, n, of) {
  return `${base}_teil-${n}-von-${of}.json`;
}

// The marker of a parsed file, or null (a single file) or false (invalid).
export function partOf(data) {
  const p = data?.part;
  if (p === undefined || p === null) return null;
  const ok = p && typeof p === 'object' && typeof p.set === 'string' && p.set.length > 0 && p.set.length <= 100
    && Number.isInteger(p.n) && Number.isInteger(p.of) && p.of >= 2 && p.of <= PARTS_MAX_COUNT && p.n >= 1 && p.n <= p.of;
  return ok ? { set: p.set, n: p.n, of: p.of } : false;
}

// Sorts selected files into complete part sets and single files.
//   files: [{ name, data }] (parsed JSON)
// Returns { singles: [file], sets: [{ set, files: [file in order] }], errors: [German] }.
// An incomplete or inconsistent set is an error (nothing of it is imported).
export function groupParts(files) {
  const singles = [];
  const bySet = new Map();
  const errors = [];
  for (const f of files) {
    const p = partOf(f.data);
    if (p === null) singles.push(f);
    else if (p === false) errors.push(`„${f.name}“: ungültige Teil-Angabe`);
    else {
      if (!bySet.has(p.set)) bySet.set(p.set, []);
      bySet.get(p.set).push({ ...f, part: p });
    }
  }
  const sets = [];
  for (const [set, list] of bySet) {
    const of = list[0].part.of;
    const names = list.map(f => `„${f.name}“`).join(', ');
    const seen = new Set(list.map(f => f.part.n));
    const missing = [];
    for (let n = 1; n <= of; n++) if (!seen.has(n)) missing.push(n);
    if (list.some(f => f.part.of !== of)) errors.push(`${names}: die Teile gehören nicht zusammen (verschiedene Anzahl)`);
    else if (seen.size !== list.length) errors.push(`${names}: ein Teil ist mehrfach gewählt`);
    else if (missing.length) errors.push(`${names}: Teil ${list[0].part.n} von ${of} – es fehlen die Teile ${missing.join(', ')}. Bitte alle ${of} Teile gemeinsam auswählen; es wurde nichts importiert.`);
    else sets.push({ set, files: list.sort((a, b) => a.part.n - b.part.n) });
  }
  return { singles, sets, errors };
}
