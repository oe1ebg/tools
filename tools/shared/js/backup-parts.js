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
export const PART_MAX_RECORDS = 150000;

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

const utf8 = new TextEncoder();
export const utf8Length = s => utf8.encode(s).length;

// Splits `items` (in order) into slices whose built text fits the limits.
//   build(slice, part)  slice -> the complete file text (part: the marker, or
//                       undefined when everything fits in one file)
//   weight(item)        how many records the item counts for the record limit
// Returns [slice, ...]; one slice when the whole thing fits. Slices are
// halved until they fit, so the parts are about equal; a single item that is
// alone beyond the limit stays one slice (nothing is ever dropped).
export function splitToFit(items, build, weight, { maxBytes = PART_MAX_BYTES, maxRecords = PART_MAX_RECORDS } = {}) {
  const probe = { set: '0'.repeat(36), n: 9999, of: 9999 };
  const fits = (slice, part) => slice.reduce((n, x) => n + weight(x), 0) <= maxRecords && utf8Length(build(slice, part)) <= maxBytes;
  const cut = slice => (slice.length < 2 || fits(slice, probe) ? [slice] : [...cut(slice.slice(0, slice.length >> 1)), ...cut(slice.slice(slice.length >> 1))]);
  if (fits(items, undefined)) return [items];
  return cut(items);
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
