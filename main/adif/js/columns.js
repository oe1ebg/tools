// The order of the table's columns (#108 B4). A log keeps its fields in
// the order of the file (`columns` in app.js); exports always write that
// order. The table shows the core fields of a QSO first by default, so
// CALL, date, time, band and mode are not hidden behind rarely used
// fields; "file order" shows the file's order. Pure.

// The core fields, in the order shown (only those the log has).
export const ADIF_CORE_COLUMNS = ['CALL', 'QSO_DATE', 'TIME_ON', 'TIME_OFF', 'BAND', 'FREQ', 'MODE', 'SUBMODE', 'RST_SENT', 'RST_RCVD', 'NAME', 'QTH', 'GRIDSQUARE'];
export const ADIF_COLUMN_ORDERS = ['core', 'file'];

// columns: the log's field names in file order; order: 'core' | 'file'.
export function adifDisplayColumns(columns, order = 'core') {
  if (order === 'file') return columns.slice();
  const have = new Set(columns);
  const core = ADIF_CORE_COLUMNS.filter(c => have.has(c));
  const coreSet = new Set(core);
  return core.concat(columns.filter(c => !coreSet.has(c)));
}
