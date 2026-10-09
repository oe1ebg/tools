// ADIF editor: search and filter (pure, node-tested in
// tests/adif-filter.test.mjs). Filters only change which QSOs the table
// shows; `records` stays the source of truth and every export writes the
// whole log.
//
// Filter state (all parts optional, ANDed; an empty part filters nothing):
//   text       free-text search, case-insensitive substring
//   textField  '' = any field's value, else only that field's value
//   status     'any' | 'errors' | 'warnings' | 'info' | 'clean'
//              (errors/warnings/info: the QSO has at least one issue of that
//              severity; clean: it has no issue at all)
//   conditions [{ field, op, value }], op: 'eq' | 'starts' | 'contains' |
//              'empty' | 'notempty' (value compared case-insensitively;
//              a condition without field, or eq/starts/contains without
//              value, is still being typed and filters nothing)
//   file       source file name ('' = all)
//   dateFrom, dateTo  QSO_DATE range, inclusive, YYYYMMDD or YYYY-MM-DD
//              (a QSO without a valid QSO_DATE is outside any range)

export const FILTER_OPS = ['eq', 'starts', 'contains', 'empty', 'notempty'];
export const FILTER_STATUSES = ['any', 'errors', 'warnings', 'info', 'clean'];

export function emptyFilter(){
  return { text: '', textField: '', status: 'any', conditions: [], file: '', dateFrom: '', dateTo: '' };
}

function filterDate(v){
  const d = String(v || '').replace(/-/g, '');
  return /^\d{8}$/.test(d) ? d : '';
}

function filterConditionActive(c){
  if (!c || !c.field) return false;
  if (c.op === 'empty' || c.op === 'notempty') return true;
  return FILTER_OPS.includes(c.op) && String(c.value ?? '').trim() !== '';
}

// The parts of `state` that actually filter, normalized (lowercase needles,
// dates as YYYYMMDD); null when nothing filters.
function filterParts(state){
  const s = { ...emptyFilter(), ...(state || {}) };
  const p = {};
  if (s.text.trim()) p.text = { needle: s.text.trim().toLowerCase(), field: s.textField || '' };
  if (s.status && s.status !== 'any' && FILTER_STATUSES.includes(s.status)) p.status = s.status;
  const conds = (s.conditions || []).filter(filterConditionActive)
    .map(c => ({ field: c.field.trim().toUpperCase(), op: c.op, needle: String(c.value ?? '').trim().toLowerCase() }));
  if (conds.length) p.conditions = conds;
  if (s.file) p.file = s.file;
  const from = filterDate(s.dateFrom), to = filterDate(s.dateTo);
  if (from || to) p.date = { from, to };
  return Object.keys(p).length ? p : null;
}

export function isFilterActive(state){ return filterParts(state) !== null; }

/* ---------- search haystack: lowercased values, cached per record ---------- */

// Keyed by the record object, so it survives sorting and deleting; the app
// drops a record's entry when it is edited (invalidateRecord) or when many
// records change at once (invalidateAllRecords).
let filterHaystacks = new WeakMap();

// '\n' between values: a search can't match across two values (ADIF values
// have no line breaks, and the search box has none either).
function filterHaystack(rec){
  let h = filterHaystacks.get(rec);
  if (h === undefined){
    h = Object.values(rec).map(v => String(v ?? '').toLowerCase()).join('\n');
    filterHaystacks.set(rec, h);
  }
  return h;
}

export function invalidateRecord(rec){ if (rec) filterHaystacks.delete(rec); }
export function invalidateAllRecords(){ filterHaystacks = new WeakMap(); }

/* ---------- matching ---------- */

// The issues of one QSO: the editor's { worst, issues, byField } entry
// (state.js issuesByIndex), or a plain array of issues, or a
// Map(field -> [issue]). Returns the severities present.
function filterSeverities(entry){
  const sev = new Set();
  if (!entry) return sev;
  const lists = entry instanceof Map ? [...entry.values()]
    : Array.isArray(entry) ? [entry] : [entry.issues || []];
  for (const list of lists) for (const i of list) if (i && i.severity) sev.add(i.severity);
  return sev;
}

const FILTER_STATUS_SEVERITY = { errors: 'error', warnings: 'warning', info: 'info' };

function filterFieldValue(rec, field){
  const v = rec[field];
  return v === undefined || v === null ? '' : String(v);
}

// Which active parts reject record `i`: [] when it matches.
// Keys: 'text', 'status', 'conditions', 'file', 'date'.
function filterFailing(p, rec, i, issuesByIndex, recordFile){
  const fail = [];
  if (p.text){
    const hay = p.text.field ? filterFieldValue(rec, p.text.field).toLowerCase() : filterHaystack(rec);
    if (!hay.includes(p.text.needle)) fail.push('text');
  }
  if (p.status){
    const sev = filterSeverities(issuesByIndex && issuesByIndex.get(i));
    const ok = p.status === 'clean' ? sev.size === 0 : sev.has(FILTER_STATUS_SEVERITY[p.status]);
    if (!ok) fail.push('status');
  }
  if (p.conditions){
    for (const c of p.conditions){
      const v = filterFieldValue(rec, c.field);
      const lv = v.toLowerCase();
      const ok = c.op === 'empty' ? v.trim() === ''
        : c.op === 'notempty' ? v.trim() !== ''
          : c.op === 'eq' ? lv.trim() === c.needle
            : c.op === 'starts' ? lv.trimStart().startsWith(c.needle)
              : lv.includes(c.needle);
      if (!ok){ fail.push('conditions'); break; }
    }
  }
  if (p.file && ((recordFile && recordFile[i]) || '') !== p.file) fail.push('file');
  if (p.date){
    const d = filterDate(rec.QSO_DATE);
    if (!d || (p.date.from && d < p.date.from) || (p.date.to && d > p.date.to)) fail.push('date');
  }
  return fail;
}

// The record indices to show, in display order; null when no filter is
// active (show all).
// ctx: issuesByIndex  Map(record index -> { worst, issues, byField }), for
//                     the status filter (state.js)
//      recordFile     source file name per record index
//      order          record indices in display order (default 0..N-1)
//      keep           record indices shown even if they don't match (the
//                     row being edited must not disappear under the cursor)
export function computeView(records, state, ctx = {}){
  const p = filterParts(state);
  if (!p) return null;
  const { issuesByIndex = null, recordFile = null, order = null, keep = null } = ctx;
  const keepSet = keep ? new Set(keep) : null;
  const out = [];
  const n = order ? order.length : records.length;
  for (let k = 0; k < n; k++){
    const i = order ? order[k] : k;
    const rec = records[i];
    if (!rec) continue;
    if ((keepSet && keepSet.has(i)) || filterFailing(p, rec, i, issuesByIndex, recordFile).length === 0) out.push(i);
  }
  return out;
}

// The filter state with every part cleared that hides record `i` (for
// "show this QSO" from the issue list). Conditions are dropped one by one,
// only those the record fails; other parts are reset whole.
export function revealRecordFilter(records, state, i, ctx = {}){
  const s = { ...emptyFilter(), ...(state || {}) };
  const p = filterParts(s);
  const rec = records[i];
  if (!p || !rec) return s;
  const fail = filterFailing(p, rec, i, ctx.issuesByIndex || null, ctx.recordFile || null);
  const next = { ...s, conditions: [...(s.conditions || [])] };
  if (fail.includes('text')) next.text = '';
  if (fail.includes('status')) next.status = 'any';
  if (fail.includes('file')) next.file = '';
  if (fail.includes('date')){ next.dateFrom = ''; next.dateTo = ''; }
  if (fail.includes('conditions')){
    next.conditions = next.conditions.filter(c => {
      if (!filterConditionActive(c)) return true;
      const one = filterParts({ conditions: [c] });
      return filterFailing(one, rec, i, null, null).length === 0;
    });
  }
  return next;
}
