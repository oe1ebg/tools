// Spreadsheet-safe CSV cells, shared by every CSV writer of the tools
// (confirmation log, Notfunk Geschäftsbuch, ADIF editor). Pure, no DOM.
//
// Policy (tools/shared/README.md, "CSV exports"): a cell whose text starts
// with = + - @, a Tab or a CR, also after leading blanks or control
// characters, would be read as a formula by Excel / LibreOffice / Google
// Sheets ("CSV injection"). Such a cell gets a leading ' (shown as text,
// the value stays readable), except a plain number like -10, +5 or -3,5,
// which stays as it is. Header cells go through the same rule (the ADIF
// editor's come from imported field names). Then the usual quoting for the
// writer's separator. Raw interchange formats (ADI, JSON backup) are not
// touched by this.
//
// Top-level names start with "csv"/"CSV_": the single-file bundles share
// one scope with the tools' own modules.

// A plain number: optional sign, digits, optional decimal point or comma.
const CSV_PLAIN_NUMBER_RE = /^[+-]?(?:\d+(?:[.,]\d+)?|[.,]\d+)$/;
// Formula start, after any leading blanks / control characters; or a
// cell that starts with Tab or CR itself.
const CSV_FORMULA_RE = /^[\x00-\x20]*[=+\-@]|^[\t\r]/;

// Would a spreadsheet read this text as a formula?
export function csvIsFormula(text) {
  const s = String(text ?? '');
  return CSV_FORMULA_RE.test(s) && !CSV_PLAIN_NUMBER_RE.test(s);
}

// The text as a spreadsheet shows it safely: a leading ' when needed.
export function csvGuard(text) {
  const s = String(text ?? '');
  return csvIsFormula(s) ? "'" + s : s;
}

// One CSV cell: guarded, then quoted when it contains the separator, a
// quote or a line break. stats (optional): stats.guarded counts the cells
// that got a leading '.
export function csvSafeCell(value, sep, stats) {
  let s = value === undefined || value === null ? '' : String(value);
  if (csvIsFormula(s)) {
    s = "'" + s;
    if (stats) stats.guarded = (stats.guarded || 0) + 1;
  }
  return s.includes(sep) || /["\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// Rows (arrays of values) as CSV lines joined by CR LF (no BOM, no final
// line break: the writer adds what its format wants).
export function csvSafeRows(rows, sep, stats) {
  return rows.map(r => r.map(v => csvSafeCell(v, sep, stats)).join(sep)).join('\r\n');
}
