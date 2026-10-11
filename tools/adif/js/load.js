// Loading .adi files for the ADIF editor, in slices, cancellable, with
// progress, and without touching the editor's state: loadLogFiles() only
// returns what it read and checked, and the editor applies that in one go
// when it is complete (app.js). A cancelled or failed load therefore
// leaves the log that was there exactly as it was.
//
// Pure apart from the timers (no DOM): node-tested in tests/adif-load.test.mjs.
// The limits (ADIF_LIMITS) keep a file that is too big for a browser tab
// from freezing or crashing it: such a file is refused with a message
// before the memory is spent, see "Resource limits" in tools/adif/README.md.

import { parseADIFAutoSteps, AdifLimitError } from '../../shared/js/adif.js';
import { validateAdifSteps } from '../../shared/js/adif-validate.js';
import { chunkedRun, chunkedAbortError } from '../../shared/js/chunked.js';

const ADIF_MB = 1024 * 1024;

// What the editor takes (all files of the log together where it says so).
// Measured (node, one parse + check, tools/adif/README.md): about 20 MB of
// peak memory per MB of file, i.e. 244 MB for 50 000 QSOs (7 MB), 1.4 GB
// for 500 000 QSOs (73 MB, 4.4 M fields); the limits keep the worst case
// near 1.5 GB, what a desktop tab survives, and refuse the rest with a
// message instead of freezing or crashing the tab.
export const ADIF_LIMITS = {
  maxFileBytes: 50 * ADIF_MB,   // one file
  maxRecords: 500000,           // QSOs in the log
  maxFields: 5000000,           // field values in the log (QSOs x fields per QSO)
  maxValueChars: 100000,        // one value
  maxFieldsPerRecord: 5000,     // one QSO
  maxColumns: 1000,             // different field names (a table column each)
  maxIssues: 100000,            // validation issues kept per file (counted beyond)
  maxWarnings: 200,             // parser warnings kept per file (the rest is counted and said once)
};

export function adifFormatCount(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function adifFormatMb(bytes) {
  return `${Math.round(bytes / ADIF_MB * 10) / 10} MB`;
}

// The message for a file the editor refuses (an AdifLimitError, or a
// read/size problem): says what it is, what the limit is, and that the
// log is as it was.
export function adifLimitMessage(name, e) {
  const n = adifFormatCount;
  const where = e.at ? ` (at QSO ${n(e.at)})` : '';
  const tail = ' The log is unchanged; split the file or remove what is not needed and add it again.';
  switch (e.code) {
    case 'FILE': return `${name}: not loaded, the file is ${adifFormatMb(e.size)}, the editor takes up to ${adifFormatMb(e.limit)} per file.${tail}`;
    case 'RECORDS': return `${name}: not loaded, the log would have more than ${n(e.limit)} QSOs${where}, the most the editor takes.${tail}`;
    case 'FIELDS_TOTAL': return `${name}: not loaded, the log would have more than ${n(e.limit)} field values (QSOs times fields per QSO)${where}, the most the editor takes.${tail}`;
    case 'VALUE': return `${name}: not loaded, ${e.field} in QSO ${n(e.at)} has ${n(e.length)} characters, the editor takes values up to ${n(e.limit)}.${tail}`;
    case 'FIELDS': return `${name}: not loaded, QSO ${n(e.at)} has more than ${n(e.limit)} fields.${tail}`;
    case 'COLUMNS': return `${name}: not loaded, it has more than ${n(e.limit)} different field names${where}.${tail}`;
    default: return `${name}: not loaded, ${e.message}.${tail}`;
  }
}

// .adi files are meant to be ASCII; in practice they're UTF-8 or, from
// many Windows loggers, Windows-1252. Strict UTF-8 first, else 1252.
export function decodeLog(buffer, name, warnings) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    warnings.push(`${name}: not UTF-8, read as Windows-1252.`);
    return new TextDecoder('windows-1252').decode(buffer);
  }
}

// One file's text: read, then checked. Yields progress objects
// ({ phase, pos|done, total, records }) and returns { parsed, warnings,
// headerInfo, defs, result }; result is the validation (null if the
// validator itself failed: a bug in it must not break loading the file).
export function* loadFileSteps(name, text, warnings, limits = ADIF_LIMITS) {
  const headerInfo = {};
  const defs = {};
  const parsed = yield* parseADIFAutoSteps(text, warnings, name, headerInfo, defs, limits);
  yield { phase: 'parsed', records: parsed.length };
  let result = null;
  try {
    result = yield* validateAdifSteps(text, { lean: true, maxIssues: limits.maxIssues, bytesMode: limits.countsBytes });
  } catch (e) {
    console.error(e);
  }
  return { parsed, headerInfo, defs, result };
}

// Where a phase's progress lies in one file's share of the bar (0..1) and
// the text for it.
function progressOf(name, p) {
  const n = adifFormatCount;
  const part = p.total ? Math.min(1, (p.pos ?? p.done ?? 0) / p.total) : 0;
  switch (p.phase) {
    case 'detect': return { frac: 0.05 + 0.05 * part, text: `Reading ${name}: checking how the lengths are counted` };
    case 'parse': return { frac: 0.1 + 0.35 * part, text: `Reading ${name}: ${n(p.records)} QSOs read` };
    case 'decode': return { frac: 0.45, text: `Reading ${name}: converting the characters` };
    case 'parsed': return { frac: 0.45, text: `Read ${name}: ${n(p.records)} QSOs` };
    case 'scan': return { frac: 0.45 + 0.15 * part, text: `Checking ${name}: scanning` };
    case 'records': return { frac: 0.6 + 0.05 * part, text: `Checking ${name}: sorting the fields into QSOs` };
    case 'check': return { frac: 0.65 + 0.35 * part, text: `Checking ${name}: ${n(p.done)} of ${n(p.total)} QSOs` };
    default: return { frac: 0, text: name };
  }
}

// Reads, decodes, parses and checks the files one after the other, in
// slices. Returns { loaded, skipped }: loaded = [{ name, size, parsed,
// headerInfo, defs, result, warnings }] in the order given, skipped =
// [{ name, message }] for files over a limit or unreadable (those are left
// out, the others are loaded). Rejects with an AbortError when cancelled
// (opts.signal): then nothing at all is returned. Any other error (a bug)
// rejects the whole load. Nothing is applied anywhere.
//   opts.read(file) -> Promise<ArrayBuffer> (default: file.arrayBuffer())
//   opts.existing { records, fields, columns }: what the log already holds
//     (columns: the field names), counted against the limits
//   opts.onProgress({ pct (0..100), text, file (1-based), files })
export async function loadLogFiles(files, opts = {}) {
  const limits = { ...ADIF_LIMITS, ...opts.limits };
  const read = opts.read || (file => file.arrayBuffer());
  const { signal, onProgress } = opts;
  const loaded = [];
  const skipped = [];
  const totalBytes = files.reduce((sum, f) => sum + (f.size || 0), 0) || 1;
  let doneBytes = 0;
  let records = opts.existing?.records || 0;
  let fields = opts.existing?.fields || 0;
  const columns = new Set(opts.existing?.columns || []);
  let lastPct = 0;
  const report = (file, index, p) => {
    if (!onProgress) return;
    const { frac, text } = progressOf(file.name, p);
    const pct = Math.max(lastPct, Math.min(100, Math.floor(100 * (doneBytes + frac * (file.size || 0)) / totalBytes)));
    lastPct = pct;
    onProgress({ pct, text: files.length > 1 ? `File ${index + 1} of ${files.length}: ${text}` : text, file: index + 1, files: files.length });
  };
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (signal?.aborted) throw chunkedAbortError();
    report(file, i, { phase: 'detect', pos: 0, total: 1 });
    try {
      if (file.size > limits.maxFileBytes) throw new AdifLimitError('FILE', 'file too big', { size: file.size, limit: limits.maxFileBytes });
      let buffer;
      try { buffer = await read(file); }
      catch (e) { throw new AdifLimitError('READ', `could not be read${e && e.message ? ` (${e.message})` : ''}`); }
      if (signal?.aborted) throw chunkedAbortError();
      const warnings = [];
      const text = decodeLog(buffer, file.name, warnings);
      buffer = null;
      const fileLimits = { ...limits, fieldsRead: 0, columns, maxRecords: Math.max(0, limits.maxRecords - records), maxFields: Math.max(0, limits.maxFields - fields) };
      // the number of records/fields left is 0: the file may not hold any
      if (!fileLimits.maxRecords) fileLimits.maxRecords = -1;
      if (!fileLimits.maxFields) fileLimits.maxFields = -1;
      const r = await chunkedRun(loadFileSteps(file.name, text, warnings, fileLimits), {
        signal, budget: opts.budget, tick: opts.tick, onProgress: p => report(file, i, p),
      });
      // a cancel that was acknowledged must never apply, also in the last slice
      if (signal?.aborted) throw chunkedAbortError();
      fields += fileLimits.fieldsRead || 0;
      for (const c of fileLimits.columnsRead || []) columns.add(c);
      records += r.parsed.length;
      loaded.push({ name: file.name, size: file.size || 0, fields: fileLimits.fieldsRead || 0, parsed: r.parsed, headerInfo: r.headerInfo, defs: r.defs, result: r.result, warnings });
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;
      if (e instanceof AdifLimitError && e.code === 'RECORDS') e.limit = limits.maxRecords;
      if (e instanceof AdifLimitError && e.code === 'FIELDS_TOTAL') e.limit = limits.maxFields;
      if (e instanceof AdifLimitError) skipped.push({ name: file.name, message: e.code === 'READ' ? `${file.name}: ${e.message}.` : adifLimitMessage(file.name, e) });
      else throw e;
    }
    doneBytes += file.size || 0;
  }
  if (signal?.aborted) throw chunkedAbortError();
  return { loaded, skipped };
}
