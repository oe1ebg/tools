// ADIF editor: state, table rendering, file loading and the toolbar.
// Everything runs in the browser; nothing is uploaded.
//
// The log, the view and the per-record validation issues live in
// state.js (the view contract is documented there); the table body is
// virtualized (table.js): only the rows around the visible part exist.

import { ADIF_FIELDS, ADIF_FIELD_MAP } from './fields.js';
import { serializeADIF, serializeADIFSteps, serializeCSV, serializeSotaCsv, adifChangedValues, ADI_MIME, emptyFieldDefs, mergeFieldDefs, forgetFieldDefs } from './export.js';
import { el, fill, isComposing, trackExpanded } from '../../shared/js/dom.js';
import { validateAdifSteps } from '../../shared/js/adif-validate.js';
import { ChunkedSlot, chunkedIsAbort } from '../../shared/js/chunked.js';
import { loadLogFiles, ADIF_LIMITS, adifFormatCount } from './load.js';
import { ADIF_SPEC_VERSION } from '../../shared/js/adif-spec-data.js';
import { renderCompliance } from './compliance.js';
import { records, recordFile, issuesByIndex, view, setView, scrollToRecord, bindViewHooks, replaceView, viewLength, viewIndexAt } from './state.js';
import { computeView, isFilterActive, invalidateRecord, invalidateAllRecords, revealRecordFilter } from './filter.js';
import { initFilterUI } from './filter-ui.js';
import { VirtualBody } from './table.js';

function populateFieldDatalist(){
  const dl = document.getElementById('adif-field-list');
  // Commonly-used fields first, and visibly marked — the <option>'s `value`
  // (what actually fills the input on selection) stays the plain field name;
  // only the displayed label carries the "★ commonly used" marking.
  const ordered = [...ADIF_FIELDS].sort((a, b) => (b.common ? 1 : 0) - (a.common ? 1 : 0));
  for (const f of ordered){
    const opt = document.createElement('option');
    opt.value = f.name;
    if (f.common) opt.textContent = `★ ${f.name} — commonly used`;
    dl.appendChild(opt);
  }
}

/* ---------- state ---------- */

let columns = [];   // ordered field names
let colIndex = new Map(); // field name -> position in columns
let fileMeta = [];  // [{name, adifVer, programId, programVersion}], one per loaded file
// USERDEF declarations and type indicators of the loaded files, merged
// (export.js, mergeFieldDefs): the ADI export writes them back.
const fieldDefs = emptyFieldDefs();
let dirty = false;  // edits since the last export (asked about before leaving the page)

function markDirty(){ dirty = true; scheduleRevalidate(); }

function rebuildColumns(){
  const seen = new Set(columns);
  for (const rec of records){
    for (const k in rec){
      if (!seen.has(k)){ seen.add(k); columns.push(k); }
    }
  }
}

function hasAnyValue(rec){
  for (const k in rec) if (rec[k] !== undefined && rec[k] !== null && rec[k] !== '') return true;
  return false;
}

function addWarning(msg){
  const box = document.getElementById('warnings');
  const div = document.createElement('div');
  div.textContent = '⚠ ' + msg;
  box.appendChild(div);
  box.classList.add('show');
}

function clearWarnings(){
  const box = document.getElementById('warnings');
  box.replaceChildren();
  box.classList.remove('show');
}

/* ---------- validation (../../shared/js/adif-validate.js) ---------- */

// What the validation panel shows: the check of each loaded file's text
// (until the first edit), then the current log as it would be exported.
// results: [{ label, result, recs }], recs[i] = the table record of the
// validator's record i (null when the two parsers disagree on the count).
let validationView = null;
let fileValidations = [];
let revalidateTimer = 0;
// The file results in fileValidations describe the files as they were
// loaded: an edit (scheduleRevalidate) makes them obsolete, also when its
// check has finished meanwhile, so adding a file must check the log again.
let fileResultsObsolete = false;
// record object -> { worst, issues, byField } of the current validation
// view; issuesByIndex (state.js) is the same by current record index.
let issuesByRec = new Map();
const SEVERITY_RANK = { error: 3, warning: 2, info: 1 };
const SEVERITY_GLYPH = { error: '✕', warning: '⚠', info: 'ⓘ' };
const MAX_LISTED_ISSUES = 500;
const MAX_SHOWN_WARNINGS = 50; // per file, in the warnings box

function showFileValidations(){
  const scope = fileValidations.length === 1 ? fileValidations[0].label : `${fileValidations.length} files`;
  validationView = { scope, results: fileValidations };
  indexValidation();
}

// "checking…" (with its progress) while an edit waits for its re-check.
function setChecking(on, pct){
  const box = document.getElementById('validation');
  let note = document.getElementById('validation-checking');
  if (!note){
    note = el('span', { id: 'validation-checking', class: 'v-checking', hidden: true }, 'checking…');
    document.getElementById('validation-summary').after(note);
  }
  note.hidden = !on;
  const text = on && pct ? `checking… ${pct} %` : 'checking…';
  if (note.textContent !== text) note.textContent = text;
  box.classList.toggle('is-checking', on);
  if (on) document.getElementById('validation-summary').setAttribute('aria-busy', 'true');
  else document.getElementById('validation-summary').removeAttribute('aria-busy');
}

// After an edit: check the log as the ADI export would write it (records
// in table order, so result record i is the i-th record with a value).
// Debounced, then run in slices (chunked.js) so typing and scrolling stay
// responsive; a newer edit cancels a running check and starts over, so a
// result is only ever applied if nothing changed while it ran.
const recheckSlot = new ChunkedSlot();
let recheckSeq = 0;

function scheduleRevalidate(){
  fileResultsObsolete = true;
  clearTimeout(revalidateTimer);
  recheckSlot.cancel();
  recheckSeq++;
  if (records.length) setChecking(true);
  revalidateTimer = setTimeout(revalidate, 150);
}

// Serialize + validate, one generator for the slices.
function* recheckSteps(filled, cols, defs){
  const text = yield* serializeADIFSteps(filled, cols, undefined, defs);
  return yield* validateAdifSteps(text, { lean: true, maxIssues: ADIF_LIMITS.maxIssues });
}

// Share of the check done (0-99): the export is about a third of the work.
function recheckPct(p){
  const part = p.total ? (p.pos ?? p.done ?? 0) / p.total : 0;
  const frac = p.phase === 'export' ? 0.3 * part
    : p.phase === 'scan' ? 0.3 + 0.2 * part
    : p.phase === 'records' ? 0.5 + 0.05 * part
    : p.phase === 'check' ? 0.55 + 0.45 * part : 0;
  return Math.min(99, Math.floor(100 * frac));
}

async function revalidate(){
  revalidateTimer = 0;
  if (!records.length){ validationView = null; indexValidation(); setChecking(false); renderValidation(); return; }
  // rows without any value (e.g. just added) are not checked; the copy is
  // what the check reads, so a sort in between can't change what it sees
  const filled = records.filter(hasAnyValue);
  const seq = recheckSeq;
  let result;
  try {
    result = await recheckSlot.start(recheckSteps(filled, columns.slice(), fieldDefs), { budget: 10, onProgress: p => setChecking(true, recheckPct(p)) });
  } catch (e){
    if (!chunkedIsAbort(e)){ console.error(e); if (seq === recheckSeq) setChecking(false); }
    return; // cancelled: the edit that did it has scheduled the next check
  }
  if (seq !== recheckSeq) return;
  validationView = { scope: 'current log, as it would be exported', results: [{ label: 'current log', result, recs: filled }] };
  indexValidation();
  body?.forEachRow((tr, ri) => applyFlags(tr, ri));
  setChecking(false);
  renderValidation();
  if (filterUI.getState().status !== 'any') applyFilter();
}

// issuesByRec from the validation view, then issuesByIndex.
function indexValidation(){
  issuesByRec = new Map();
  for (const { result, recs } of validationView?.results || []){
    if (!result) continue;
    for (const issue of result.issues){
      const rec = issue.recordType === 'qso' ? recs[issue.recordIndex] : null;
      if (!rec) continue;
      let entry = issuesByRec.get(rec);
      if (!entry){ entry = { worst: 'info', issues: [], byField: new Map() }; issuesByRec.set(rec, entry); }
      entry.issues.push(issue);
      if (SEVERITY_RANK[issue.severity] > SEVERITY_RANK[entry.worst]) entry.worst = issue.severity;
      // BAND/FREQ, MODE/SUBMODE: flag both cells
      for (const f of (issue.field || '').split('/')){
        let list = entry.byField.get(f);
        if (!list) entry.byField.set(f, list = []);
        list.push(issue);
      }
    }
  }
  reindexIssues();
}

// issuesByIndex after the records moved (load, sort, add, delete).
function reindexIssues(){
  issuesByIndex.clear();
  if (!issuesByRec.size) return;
  for (let i = 0; i < records.length; i++){
    const entry = issuesByRec.get(records[i]);
    if (entry) issuesByIndex.set(i, entry);
  }
}

function worstSeverity(issues){
  return issues.reduce((w, i) => (SEVERITY_RANK[i.severity] > SEVERITY_RANK[w] ? i.severity : w), 'info');
}

function issueTitle(issues){
  return issues.map(i => `${SEVERITY_GLYPH[i.severity]} ${i.message} (${i.code})`).join('\n');
}

// Problem cells of one rendered row: class cell-error|warning|info and the
// messages as title; the row number shows the worst severity of its QSO.
function applyFlags(tr, ri){
  const num = tr.firstChild;
  if (tr.classList.contains('flagged')){
    tr.classList.remove('flagged');
    num.classList.remove('row-error', 'row-warning');
    num.removeAttribute('title');
    for (const td of tr.querySelectorAll('.cell-error, .cell-warning, .cell-info')){
      td.classList.remove('cell-error', 'cell-warning', 'cell-info');
      td.removeAttribute('title');
    }
  }
  const entry = issuesByIndex.get(ri);
  if (!entry) return;
  tr.classList.add('flagged');
  if (entry.worst !== 'info') num.classList.add(`row-${entry.worst}`);
  num.title = issueTitle(entry.issues);
  for (const [field, list] of entry.byField){
    const ci = colIndex.get(field);
    if (ci === undefined) continue;
    const td = tr.children[ci + 1];
    td.classList.add(`cell-${worstSeverity(list)}`);
    td.title = issueTitle(list);
  }
}

function updateIssuesButton(){
  const panel = document.getElementById('validation-issues');
  fill(document.getElementById('btn-issues'), panel.hidden ? 'show issues ' : 'hide issues ',
    el('span', { 'aria-hidden': 'true' }, panel.hidden ? '▾' : '▴'));
}

function plural(n, word){ return `${n} ${word}${n === 1 ? '' : 's'}`; }

let issuesStale = true; // the issue list needs a rebuild before it's shown

function renderValidation(){
  const box = document.getElementById('validation');
  const panel = document.getElementById('validation-issues');
  const results = (validationView?.results || []).filter(r => r.result);
  if (!records.length || !results.length){
    box.hidden = true;
    panel.hidden = true;
    return;
  }
  const n = { errors: 0, warnings: 0, infos: 0 };
  for (const { result } of results) for (const k of Object.keys(n)) n[k] += result[k];
  const dropped = results.reduce((sum, r) => sum + (r.result.issuesDropped || 0), 0);
  const state = n.errors ? 'invalid' : n.warnings ? 'warn' : 'valid';
  const [glyph, verdict] = { valid: ['✓', 'ADIF valid'], warn: ['⚠', 'ADIF valid with warnings'], invalid: ['✕', 'Invalid ADIF'] }[state];
  box.classList.remove('is-valid', 'is-warn', 'is-invalid');
  box.classList.add(`is-${state}`);
  box.hidden = false;
  const perFile = results.length > 1
    ? `: ${results.map(r => `${r.label} ${r.result.errors ? '✕' : r.result.warnings ? '⚠' : '✓'}`).join(', ')}` : '';
  const summary = el('span', {},
    el('span', { class: 'verdict' }, el('span', { 'aria-hidden': 'true' }, glyph), ' ', verdict),
    el('span', { class: 'v-counts' },
      el('span', { class: n.errors ? 'n-error' : null }, plural(n.errors, 'error')),
      el('span', { class: n.warnings ? 'n-warning' : null }, plural(n.warnings, 'warning')),
      el('span', { class: n.infos ? 'n-info' : null }, plural(n.infos, 'info'))),
    el('span', { class: 'v-scope' }, `${validationView.scope}${perFile} · checked against ADIF ${ADIF_SPEC_VERSION}`),
    dropped ? el('span', { class: 'v-scope' }, `${adifFormatCount(dropped)} issue(s) are counted but not listed or flagged (the first ${adifFormatCount(ADIF_LIMITS.maxIssues)} per file are kept)`) : null);
  // a status region: only rewritten when its text changes
  const status = document.getElementById('validation-summary');
  if (summary.textContent !== status.textContent) fill(status, [...summary.childNodes]);
  const total = n.errors + n.warnings + n.infos;
  document.getElementById('btn-issues').hidden = total === 0;
  if (total === 0) panel.hidden = true;
  // the list is built when it's open (or opened)
  issuesStale = true;
  if (!panel.hidden) renderIssueList();
  updateIssuesButton();
}

function renderIssueList(){
  const results = (validationView?.results || []).filter(r => r.result);
  fill(document.getElementById('validation-issues'), issueGroups(results));
  issuesStale = false;
}

// The issue list: general issues per file, then one group per QSO (with
// its current row in the table). Only the first MAX_LISTED_ISSUES are
// built; the rest is counted.
function issueGroups(results){
  const groups = [];
  let listed = 0, total = 0;
  for (const { result } of results) total += result.issues.length;
  const full = () => listed >= MAX_LISTED_ISSUES;
  // current table row of a record object (only the flagged ones are needed)
  const rowOf = new Map();
  for (const ri of issuesByIndex.keys()) rowOf.set(records[ri], ri);
  const fieldLabel = i => (i.field ? i.field.replace('/', ' / ') : i.recordType === 'qso' ? '(QSO)' : `(${i.recordType})`);
  const items = issues => {
    const out = [];
    for (const issue of issues){
      if (full()) break;
      listed++;
      out.push(el('li', {},
        el('span', { class: `sev-${issue.severity}`, role: 'img', 'aria-label': issue.severity }, SEVERITY_GLYPH[issue.severity]),
        el('span', { class: 'v-field' }, fieldLabel(issue)),
        el('span', {}, issue.message, el('span', { class: 'v-code' }, issue.code),
          issue.line ? el('span', { class: 'v-loc' }, `line ${issue.line}:${issue.column}`) : null)));
    }
    return out;
  };
  for (const { label, result, recs } of results){
    if (full()) break;
    const prefix = results.length > 1 ? `${label} · ` : '';
    const byRec = new Map();
    const general = [];
    for (const i of result.issues){
      const rec = i.recordType === 'qso' ? recs[i.recordIndex] : null;
      if (!rec){ general.push(i); continue; }
      let list = byRec.get(rec);
      if (!list) byRec.set(rec, list = []);
      list.push(i);
    }
    if (general.length) groups.push(el('div', { class: 'v-group' }, el('h2', {}, `${prefix}File`), el('ul', {}, items(general))));
    for (const [rec, issues] of byRec){
      if (full()) break;
      const ri = rowOf.get(rec);
      const where = [rec.CALL, ri !== undefined ? null : 'removed from the table'].filter(Boolean).join(' · ');
      // "row N" shows the QSO: clears the filters that hide it, scrolls to it
      const goto = ri !== undefined ? el('button', { type: 'button', class: 'v-goto', 'aria-label': `show row ${ri + 1} in the table`,
        onclick: () => revealRecord(rec) }, `row ${ri + 1}`) : null;
      groups.push(el('div', { class: 'v-group' },
        el('h2', {}, `${prefix}QSO #${issues[0].recordIndex + 1} `, el('span', { class: 'dim' }, where, where && goto ? ' · ' : ''), goto),
        el('ul', {}, items(issues))));
    }
  }
  const skipped = total - listed;
  if (skipped > 0) groups.push(el('p', { class: 'v-more' }, `… and ${skipped} more (the first ${MAX_LISTED_ISSUES} are listed).`));
  return groups;
}

/* ---------- rendering ---------- */

// contenteditable="plaintext-only" where supported (pasted text brings no
// markup), else "true"; decided once.
const EDITABLE = (() => {
  try { document.createElement('td').contentEditable = 'plaintext-only'; return 'plaintext-only'; }
  catch { return 'true'; }
})();

const dropEl = document.getElementById('drop');
let body = null;     // VirtualBody of the current table
let protoRow = null; // an empty row of the current columns, cloned per row
let colEls = [];     // <col> per field, widened when a longer value is typed
let colChars = [];   // their width in characters
let tableEl = null;  // the <table>, its width = the sum of the columns (table-layout: fixed)
let rownumCss = '';  // width of the row number column
let colsPx = 0;      // sum of the fields' column widths

// Cells are one line high (the virtual table needs a fixed row height):
// line breaks show as ¶ until the cell is edited.
function displayValue(v){
  return /[\r\n]/.test(v) ? v.replace(/\r\n|\r|\n/g, '¶') : v;
}

// Width of a displayed value in characters.
function displayWidth(v){
  return /[\r\n]/.test(v) ? displayValue(v).length : v.length;
}

// Column widths from the longest value of each field, in pixels of the
// table's monospace font (measured: `ch` of a <col> differs between
// browsers), so they don't change as rows scroll in and out. A value
// longer than MAX_COL_CHARS is cut (…) by the cells' max-width anyway.
const MAX_COL_CHARS = 44;
let charPx = 7.8, cellPadPx = 16.6;

function measureFont(){
  const probe = el('span', { class: 'char-probe', 'aria-hidden': 'true' }, '0'.repeat(50));
  dropEl.appendChild(probe);
  const w = probe.getBoundingClientRect().width / 50;
  const fs = parseFloat(getComputedStyle(probe).fontSize);
  probe.remove();
  if (w > 0) charPx = w;
  if (fs > 0) cellPadPx = 1.2 * fs + 1; // padding .6em on both sides + border
}

function colPxOf(chars){ return Math.ceil(chars * charPx + cellPadPx); }
function colWidth(chars){ return `${colPxOf(chars)}px`; }

// The table is laid out with fixed column widths (table-layout: fixed, see
// style.css): the browser needs no measuring of the cells' contents, which
// for ~180 columns x 100 rendered rows was most of the cost of every
// scroll. That needs a definite table width: the columns' sum.
function setTableWidth(){
  if (tableEl) tableEl.style.width = `calc(${rownumCss} + ${colsPx}px)`;
}

function buildColgroup(){
  const longest = new Map();
  for (const rec of records){
    for (const k in rec){
      const len = displayWidth(String(rec[k]));
      if (len > (longest.get(k) || 0)) longest.set(k, len);
    }
  }
  colEls = [];
  colChars = [];
  // the row number column fits the largest number (+ the delete button)
  const numCol = el('col', { class: 'rownum-col' });
  rownumCss = `${String(records.length).length + 1}ch + 2.6em`;
  numCol.style.width = `calc(${rownumCss})`;
  colsPx = 0;
  const group = el('colgroup', {}, numCol);
  for (const col of columns){
    // wide enough for the values (up to MAX_COL_CHARS) and for the header:
    // the name (a proportional bold font) and the sort/remove buttons
    const headChars = Math.ceil(col.length * 1.15) + 4;
    const chars = Math.max(headChars, Math.min(MAX_COL_CHARS, Math.max(4, longest.get(col) || 0)));
    const c = document.createElement('col');
    c.style.width = colWidth(chars);
    colsPx += colPxOf(chars);
    colEls.push(c);
    colChars.push(chars);
    group.appendChild(c);
  }
  return group;
}

function widenColumn(col, value){
  const ci = colIndex.get(col);
  if (ci === undefined) return;
  const chars = Math.min(MAX_COL_CHARS, displayWidth(String(value)));
  if (chars > colChars[ci]){
    colsPx += colPxOf(chars) - colPxOf(colChars[ci]);
    colChars[ci] = chars;
    colEls[ci].style.width = colWidth(chars);
    setTableWidth();
  }
}

function buildProtoRow(){
  const tr = document.createElement('tr');
  tr.appendChild(el('td', { class: 'rownum' }, '', el('button', { type: 'button', class: 'del', title: 'delete row' }, '×')));
  for (const col of columns){
    const td = document.createElement('td');
    td.setAttribute('contenteditable', EDITABLE);
    td.spellcheck = false;
    td.dataset.col = col;
    tr.appendChild(td);
  }
  return tr;
}

function renderRow(ri){
  const tr = protoRow.cloneNode(true);
  tr.dataset.ri = String(ri);
  const num = tr.firstChild;
  num.firstChild.data = String(ri + 1);
  num.lastChild.setAttribute('aria-label', `delete row ${ri + 1}`);
  const rec = records[ri];
  let td = num.nextSibling;
  for (const col of columns){
    const v = rec[col];
    if (v !== undefined && v !== null && v !== '') td.textContent = displayValue(String(v));
    td = td.nextSibling;
  }
  applyFlags(tr, ri);
  return tr;
}

function setExportButtonsDisabled(disabled){
  document.getElementById('btn-export').disabled = disabled;
  document.getElementById('btn-export-csv').disabled = disabled;
  document.getElementById('btn-export-sota').disabled = disabled;
}

function sortLabel(col){
  return sortState.col === col ? (sortState.asc ? 'ascending' : 'descending') : null;
}

// The whole table (after loading, and when the columns change); scrolling,
// sorting and view changes only re-render the body's window.
function render(){
  body?.destroy();
  body = null;
  dropEl.classList.remove('empty');
  if (records.length === 0){
    dropEl.classList.add('empty');
    fill(dropEl, el('div', { id: 'empty-msg' }, 'drag & drop .adi file(s) here', el('br'),
      el('span', { class: 'hint' }, 'or click "add file(s)…" — files are added to the current log; nothing leaves the browser')));
    updateStats();
    updateFileInfo();
    setExportButtonsDisabled(true);
    renderValidation();
    return;
  }
  setExportButtonsDisabled(false);
  colIndex = new Map(columns.map((c, i) => [c, i]));
  protoRow = buildProtoRow();

  const htr = el('tr', { 'aria-rowindex': '1' }, el('th', { class: 'rownum-col', scope: 'col' }, '#'));
  for (const col of columns){
    const fieldDef = ADIF_FIELD_MAP.get(col);
    const userdef = fieldDef ? null : fieldDefs.userdefs.find(u => u.name === col);
    const indicator = fieldDef ? '' : fieldDefs.types[col];
    htr.appendChild(el('th', { scope: 'col', 'data-col': col, 'aria-sort': sortLabel(col) },
      el('span', { class: 'colhead' },
        el('button', {
          type: 'button', class: 'sortcol',
          title: 'click to sort' + (fieldDef
            ? ` — ${fieldDef.type}: ${fieldDef.desc}`
            : userdef ? ` — user-defined field (USERDEF ${userdef.spec}, type ${userdef.type || 'none'})`
            : ` — no ADIF definition (custom/application field${indicator ? `, type ${indicator}` : ''})`),
        }, col),
        el('button', { type: 'button', class: 'rmcol', title: 'remove column', 'aria-label': `remove column ${col}` }, '×'))));
  }
  const thead = el('thead', {}, htr);
  thead.addEventListener('click', e => {
    const btn = e.target.closest('button');
    const col = btn?.closest('th')?.dataset.col;
    if (!col) return;
    if (btn.classList.contains('sortcol')) sortByColumn(col);
    else if (btn.classList.contains('rmcol')) removeColumn(col);
  });
  const tbody = document.createElement('tbody');
  bindBodyEvents(tbody);
  measureFont();
  const table = el('table', {}, buildColgroup(), thead, tbody);
  tableEl = table;
  setTableWidth();

  fill(dropEl, table);

  const addRowDiv = el('div', { class: 'add-row' });
  addRowDiv.appendChild(el('button', { type: 'button', onclick: addRow }, '+ row'));

  const newFieldInput = el('input', { type: 'text', list: 'adif-field-list', placeholder: 'field name…',
    'aria-label': 'new field name', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'characters', enterkeyhint: 'done' });
  addRowDiv.appendChild(newFieldInput);

  const addColBtn = el('button', { type: 'button', class: 'add-col' }, '+ field');
  addColBtn.addEventListener('click', () => {
    const name = newFieldInput.value.trim().toUpperCase();
    if (/^[A-Z][A-Z0-9_]*$/.test(name)) addColumn(name);
    else if (name) addWarning(`"${name}" is no valid ADIF field name (letters, digits and _ only).`);
    newFieldInput.value = '';
  });
  newFieldInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addColBtn.click();
  });
  addRowDiv.appendChild(addColBtn);

  dropEl.appendChild(addRowDiv);

  body = new VirtualBody(dropEl, table, {
    columns: columns.length + 1,
    rowCount: viewLength,
    rowKey: viewIndexAt,
    renderRow,
    beforeRemove: tr => { const td = tr.querySelector('td[data-col]:focus'); if (td) commitCell(td); },
  });
  body.update(true);

  updateStats();
  updateFileInfo();
  renderValidation();
}

// The body after the view, the order or the rows changed.
function refreshBody(){
  if (body) body.update(true);
  else render();
}

// The display position of a record in the view (-1: not shown).
function posOf(ri){
  return view ? view.indexOf(ri) : (ri < records.length ? ri : -1);
}

// Scroll a display position into the window and focus a cell of it
// (col: field name; omitted: the row's first field).
function focusCell(pos, col){
  if (!body || pos < 0 || pos >= viewLength()) return false;
  const tr = body.reveal(pos);
  if (!tr) return false;
  const ci = col === undefined ? 0 : colIndex.get(col);
  const td = tr.children[(ci ?? 0) + 1];
  if (!td) return false;
  td.focus({ preventScroll: true });
  td.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  return true;
}

/* ---------- editing (delegated on the table body) ---------- */

let editBefore = ''; // value of the focused cell when it got the focus

// Takes a cell's text into its record (on blur, Enter, or before its row
// scrolls out of the window).
function commitCell(td){
  const tr = td.parentNode;
  const ri = Number(tr?.dataset.ri);
  const col = td.dataset.col;
  const rec = records[ri];
  if (!rec || !col) return;
  const v = td.textContent;
  if (v !== (rec[col] ?? '')){
    if (v === '') delete rec[col];
    else { rec[col] = v; widenColumn(col, v); }
    invalidateRecord(rec);
    if (view) filterPinned.add(rec); // stays shown even if it no longer matches
    markDirty();
    if (col === 'BAND' || col === 'MODE') scheduleStats();
  }
  const shown = displayValue(rec[col] ?? '');
  if (td.textContent !== shown) td.textContent = shown;
}

function bindBodyEvents(tbody){
  tbody.addEventListener('focusin', e => {
    const td = e.target.closest('td[data-col]');
    if (!td) return;
    const rec = records[Number(td.parentNode.dataset.ri)];
    const raw = rec?.[td.dataset.col] ?? '';
    // the full value (with its line breaks) while editing
    if (td.textContent !== raw) td.textContent = raw;
    editBefore = raw;
  });
  tbody.addEventListener('focusout', e => {
    const td = e.target.closest('td[data-col]');
    if (td && td.isConnected) commitCell(td);
  });
  // Enter takes the value and moves one row down (ADIF values have no
  // line breaks), Esc restores the value from before the edit, Tab at
  // the end/start of a row goes on to the next/previous row (scrolled in).
  tbody.addEventListener('keydown', e => {
    const td = e.target.closest('td[data-col]');
    const tr = e.target.closest('tr');
    if (!tr?.dataset.ri) return;
    const pos = posOf(Number(tr.dataset.ri));
    if (td && e.key === 'Enter' && !isComposing(e)){
      e.preventDefault();
      if (!focusCell(pos + 1, td.dataset.col)) td.blur();
    } else if (td && e.key === 'Escape'){
      e.preventDefault();
      td.textContent = editBefore;
      td.blur();
    } else if (e.key === 'Tab' && !e.shiftKey && td && !td.nextElementSibling && pos + 1 < viewLength()){
      e.preventDefault();
      focusCell(pos + 1);
    } else if (e.key === 'Tab' && e.shiftKey && !td && e.target.classList.contains('del') && pos > 0){
      e.preventDefault();
      focusCell(pos - 1, columns[columns.length - 1]);
    }
  });
  tbody.addEventListener('click', e => {
    const del = e.target.closest('button.del');
    const tr = del?.closest('tr');
    if (tr?.dataset.ri) deleteRow(Number(tr.dataset.ri));
  });
}

/* ---------- toolbar status ---------- */

let statsFrame = 0;
function scheduleStats(){
  if (!statsFrame) statsFrame = requestAnimationFrame(() => { statsFrame = 0; updateStats(); });
}

function updateStats(){
  syncFilterBar();
  const stats = document.getElementById('stats');
  if (records.length === 0){ stats.textContent = ''; return; }
  const bands = new Set(), modes = new Set();
  for (const r of records){
    if (r.BAND) bands.add(r.BAND);
    if (r.MODE) modes.add(r.MODE);
  }
  // Built from nodes: BAND/MODE come straight from the loaded file.
  fill(stats, el('b', {}, records.length), ' QSOs',
    fileMeta.length > 1 ? [' from ', el('b', {}, fileMeta.length), ' files'] : null,
    ' · ', el('b', {}, columns.length), ' fields',
    bands.size ? ` · bands: ${[...bands].join(', ')}` : null,
    modes.size ? ` · modes: ${[...modes].join(', ')}` : null);
}

function updateFileInfo(){
  const el = document.getElementById('file-info');
  if (!fileMeta.length){ el.textContent = ''; return; }
  el.textContent = fileMeta.map(f => `${f.name}: ADIF ${f.adifVer || 'version not declared'}`).join(' · ');
}

/* ---------- editing ops ---------- */

function addRow(){
  records.push({});
  recordFile.push('');
  if (view) replaceView([...view, records.length - 1]);
  markDirty();
  updateStats();
  refreshBody();
  focusCell(viewLength() - 1);
}

function deleteRow(ri){
  records.splice(ri, 1);
  recordFile.splice(ri, 1);
  if (view){
    const next = [];
    for (const i of view) if (i !== ri) next.push(i > ri ? i - 1 : i);
    replaceView(next);
  }
  reindexIssues();
  markDirty();
  updateStats();
  if (!records.length) render();
  else refreshBody();
}

function addColumn(name){
  if (!name || columns.includes(name)) return;
  columns.push(name);
  markDirty();
  render();
}

function removeColumn(name){
  columns = columns.filter(c => c !== name);
  forgetFieldDefs(fieldDefs, name);
  markDirty();
  for (const rec of records) delete rec[name];
  invalidateAllRecords();
  replaceView(filterView());
  render();
}

let sortState = { col: null, asc: true };
const collator = new Intl.Collator();

// Sorts the log itself (exports follow the table order): keys computed
// once, an index array sorted (stable), records and recordFile permuted,
// an active view remapped.
function sortByColumn(col){
  if (sortState.col === col) sortState.asc = !sortState.asc;
  else { sortState = { col, asc: true }; }
  const n = records.length;
  const strs = new Array(n), nums = new Float64Array(n);
  for (let i = 0; i < n; i++){
    const v = records[i][col] ?? '';
    const s = String(v);
    const num = parseFloat(s);
    strs[i] = s;
    nums[i] = !isNaN(num) && String(num) === s.trim() ? num : NaN;
  }
  const sign = sortState.asc ? 1 : -1;
  const order = Array.from({ length: n }, (_, i) => i);
  order.sort((a, b) => {
    const an = nums[a], bn = nums[b];
    const cmp = an === an && bn === bn ? an - bn : collator.compare(strs[a], strs[b]);
    return sign * cmp;
  });
  const recs = records.slice(), files = recordFile.slice();
  const newPos = new Array(n);
  for (let i = 0; i < n; i++){
    records[i] = recs[order[i]];
    recordFile[i] = files[order[i]];
    newPos[order[i]] = i;
  }
  if (view) replaceView(view.map(i => newPos[i]).sort((a, b) => a - b));
  reindexIssues();
  for (const th of dropEl.querySelectorAll('thead th[data-col]')){
    const label = sortLabel(th.dataset.col);
    if (label) th.setAttribute('aria-sort', label);
    else th.removeAttribute('aria-sort');
  }
  refreshBody();
  renderValidation();
}

function applyCommentTemplate(template){
  const re = /\{([A-Za-z0-9_]+)\}/g;
  let changed = false;
  for (const rec of records){
    if (rec.COMMENT) continue; // only fill rows where COMMENT is currently blank/absent
    const filled = template.replace(re, (_, name) => rec[name.toUpperCase()] || '');
    if (filled !== ''){ rec.COMMENT = filled; changed = true; }
  }
  if (changed){ markDirty(); invalidateAllRecords(); rebuildColumns(); replaceView(filterView()); render(); }
}

/* ---------- search & filter (js/filter.js, js/filter-ui.js) ---------- */
// The filter sets the view (state.js) when the filter, the validation
// result (status filter), the loaded files or the columns change. After
// add/delete/sort the view is remapped by those operations above, not
// re-filtered. Exports always write the whole log.

const filterPinned = new Set(); // records edited while filtered: shown until the filter changes

// The view the filter bar asks for (null: all). Kept in it even if they no
// longer match: edited records and the record holding the focus (keyboard
// navigation needs its position in the view).
function filterView(){
  const state = filterUI.getState();
  if (!records.length || !isFilterActive(state)) return null;
  const keep = [];
  if (filterPinned.size) records.forEach((r, i) => { if (filterPinned.has(r)) keep.push(i); });
  const focused = document.activeElement?.closest?.('#drop tr[data-ri]');
  if (focused) keep.push(Number(focused.dataset.ri));
  return computeView(records, state, { issuesByIndex, recordFile, keep });
}

function sameView(a, b){
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Re-run the filter; the table is re-rendered only when the view changed
// (a focused cell stays as it is).
function applyFilter(){
  const v = filterView();
  if (!sameView(v, view)) setView(v);
  syncFilterBar();
}

// Bar visibility, its "search in" and file options (rebuilt only when they
// change) and the counter.
function syncFilterBar(){
  filterUI.show(records.length > 0);
  filterUI.setFields(columns);
  filterUI.setFiles([...new Set(fileMeta.map(f => f.name))]);
  filterUI.setCount(viewLength(), records.length);
}

// From the issue list: clear the filters that hide this QSO, then go to it.
function revealRecord(rec){
  const ri = records.indexOf(rec);
  if (ri < 0) return;
  filterUI.setState(revealRecordFilter(records, filterUI.getState(), ri, { issuesByIndex, recordFile }));
  filterPinned.clear();
  applyFilter();
  scrollToRecord(ri);
}

const filterUI = initFilterUI({ onChange: () => { filterPinned.clear(); applyFilter(); } });

// state.js: setView() re-renders the window, scrollToRecord() scrolls.
bindViewHooks(refreshBody, ri => { focusCell(posOf(ri)); });

/* ---------- file loading ---------- */

// FileReader (abortable reads are not needed: a local file reads in
// milliseconds, the work that takes time is chunked and cancellable).
function readBuffer(file){
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('read error'));
    reader.readAsArrayBuffer(file);
  });
}

// An import in progress: { signal: { aborted } }, null when none runs.
// Files are read, parsed and checked in slices (load.js) with progress and
// a Cancel button; nothing of the log changes until every file is done
// (applyLoaded), so a cancelled or failed import leaves the log as it was.
let importing = null;
// field values in the log now, counted against the limit
function countFields(){
  let n = 0;
  for (const rec of records) for (const k in rec) n++;
  return n;
}

function setImportProgress(p, announce){
  const bar = document.getElementById('import-bar');
  bar.value = p.pct;
  const text = `${p.text} (${p.pct} %)`;
  const line = document.getElementById('import-text');
  if (line.textContent !== text) line.textContent = text;
  // the live region speaks at most every 10 % and per file
  const key = `${p.file}:${Math.floor(p.pct / 10)}`;
  if (announce || key !== setImportProgress.lastKey){
    setImportProgress.lastKey = key;
    document.getElementById('import-live').textContent = `${p.text}, ${p.pct} percent`;
  }
}

function showImportProgress(on){
  const box = document.getElementById('import-progress');
  box.hidden = !on;
  document.getElementById('btn-open').disabled = on;
  const cancel = document.getElementById('btn-cancel-import');
  cancel.disabled = false;
  cancel.textContent = 'Cancel';
  if (on){
    setImportProgress.lastKey = '';
    setImportProgress({ pct: 0, text: 'Starting', file: 1, files: 1 }, true);
    cancel.focus();
  } else {
    document.getElementById('import-live').textContent = '';
    if (box.contains(document.activeElement) || document.activeElement === document.body) document.getElementById('btn-open').focus();
  }
}

function cancelImport(){
  if (!importing || importing.signal.aborted) return;
  importing.signal.aborted = true;
  const cancel = document.getElementById('btn-cancel-import');
  cancel.disabled = true;
  cancel.textContent = 'Cancelling…';
}

async function loadFiles(fileList){
  const files = Array.from(fileList);
  if (!files.length) return;
  if (importing){
    addWarning('An import is already running: wait for it, or cancel it, before adding more files.');
    return;
  }
  const signal = { aborted: false };
  importing = { signal };
  showImportProgress(true);
  let outcome = null;
  try {
    outcome = await loadLogFiles(files, {
      read: readBuffer,
      signal,
      limits: ADIF_LIMITS,
      existing: { records: records.length, fields: countFields(), columns },
      budget: 10,
      onProgress: p => setImportProgress(p),
    });
  } catch (e){
    if (chunkedIsAbort(e)) addWarning('Import cancelled; the log is unchanged.');
    else { console.error(e); addWarning(`Import failed (${e && e.message ? e.message : e}); the log is unchanged.`); }
  } finally {
    importing = null;
    showImportProgress(false);
  }
  if (outcome) applyLoaded(outcome.loaded, outcome.skipped, files);
}

// The whole import into the log, in one go: only called with files that
// are complete. A file over a limit or unreadable is reported and left out.
function applyLoaded(loaded, skipped, files){
  clearWarnings();
  skipped.forEach(s => addWarning(s.message));
  if (!loaded.length) return;
  // an edit's re-check (pending or running) belongs to the log as it was
  // (a finished one too: the file results shown again below are the old ones)
  const recheckWanted = revalidateTimer || recheckSlot.running || fileResultsObsolete;
  clearTimeout(revalidateTimer);
  recheckSlot.cancel();
  recheckSeq++;
  revalidateTimer = 0;
  let defConflicts = false;
  for (const f of loaded){
    const conflicts = mergeFieldDefs(fieldDefs, f.defs, f.name);
    if (conflicts.length) defConflicts = true;
    f.warnings.push(...conflicts);
    // result record i belongs to parsed record i, unless the two parsers disagree on the count
    const recs = !f.result ? [] : f.result.records.length === f.parsed.length ? f.parsed : f.result.records.map(() => null);
    fileValidations.push({ label: f.name, result: f.result, recs });
    for (const rec of f.parsed){ records.push(rec); recordFile.push(f.name); }
    fileMeta.push({
      name: f.name,
      adifVer: f.headerInfo.ADIF_VER || null,
      programId: f.headerInfo.PROGRAMID || null,
      programVersion: f.headerInfo.PROGRAMVERSION || null,
    });
    f.warnings.slice(0, MAX_SHOWN_WARNINGS).forEach(addWarning);
    if (f.warnings.length > MAX_SHOWN_WARNINGS) addWarning(`${f.name}: ${adifFormatCount(f.warnings.length - MAX_SHOWN_WARNINGS)} more warning(s) not shown.`);
    if (f.result?.issuesDropped) addWarning(`${f.name}: ${adifFormatCount(f.result.issuesDropped)} further issue(s) are counted in the summary but not listed or flagged (the first ${adifFormatCount(ADIF_LIMITS.maxIssues)} are kept).`);
  }
  if (files.length === 1) document.getElementById('filename-input').value = files[0].name.replace(/\.[^.]+$/, '') + '.adi';
  rebuildColumns();
  showFileValidations();
  fileResultsObsolete = false; // what is shown now is the check of the files as loaded
  replaceView(filterView()); // an active filter applies to the new records too
  render();
  // Declarations that didn't fit together: show the log as the export
  // would write it, so the values that no longer fit are in the issue list.
  if (defConflicts || recheckWanted) scheduleRevalidate();
}

/* ---------- drag & drop / open / export wiring ---------- */

document.getElementById('btn-cancel-import').addEventListener('click', cancelImport);
// Escape cancels only with the focus on the progress box (the Cancel button
// has it from the start) or nowhere: elsewhere it belongs to what has the focus
// (a cell edit, a dialog).
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || !importing) return;
  const active = document.activeElement;
  if (active === document.body || !active || document.getElementById('import-progress').contains(active)) cancelImport();
});

let dragDepth = 0;
['dragover', 'drop'].forEach(evt => document.addEventListener(evt, e => e.preventDefault()));
dropEl.addEventListener('dragenter', e => { e.preventDefault(); dragDepth++; dropEl.classList.add('dragover'); });
dropEl.addEventListener('dragleave', () => { if (--dragDepth <= 0){ dragDepth = 0; dropEl.classList.remove('dragover'); } });
dropEl.addEventListener('drop', e => {
  e.preventDefault();
  dragDepth = 0;
  dropEl.classList.remove('dragover');
  if (e.dataTransfer.files && e.dataTransfer.files.length) loadFiles(e.dataTransfer.files);
});

document.getElementById('btn-open').addEventListener('click', () => {
  document.getElementById('file-input').click();
});
document.getElementById('file-input').addEventListener('change', e => {
  if (e.target.files.length) loadFiles(e.target.files);
  e.target.value = '';
});

function downloadText(text, mime, filename){
  const blob = new Blob([text], { type: mime.startsWith('text/') ? `${mime};charset=utf-8` : mime });
  const url = URL.createObjectURL(blob);
  // A temporary link (an <a download> without href in the page is invalid HTML).
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.hidden = true;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function swapExt(filename, ext){
  const base = (filename || 'export').replace(/\.[^.]+$/, '');
  return `${base}.${ext}`;
}

// A cell still being edited counts: take its value before exporting.
function commitFocusedCell(){
  const td = document.activeElement?.closest?.('#drop td[data-col]');
  if (td) commitCell(td);
}

document.getElementById('btn-export').addEventListener('click', () => {
  commitFocusedCell();
  const name = document.getElementById('filename-input').value.trim() || 'export.adi';
  // .adi is ASCII: say which values had to be transliterated
  const changed = adifChangedValues(records, columns, fieldDefs);
  if (changed) addWarning(`${changed} value(s) contained non-ASCII characters or line breaks their field can't hold; changed in the export (ä → ae, é → e, other → ?, line break → blank).`);
  downloadText(serializeADIF(records, columns, undefined, fieldDefs), ADI_MIME, name);
  dirty = false;
});

document.getElementById('btn-export-csv').addEventListener('click', () => {
  commitFocusedCell();
  const name = swapExt(document.getElementById('filename-input').value, 'csv');
  const stats = { guarded: 0 };
  downloadText(serializeCSV(records, columns, stats), 'text/csv', name);
  if (stats.guarded) addWarning(`CSV: ${stats.guarded} value(s) start with =, +, -, @ or a control character; written with a leading ' so spreadsheets don't run them as formulas (numbers like -10 stay as they are; the .adi export is unchanged).`);
  dirty = false;
});

document.getElementById('btn-export-sota').addEventListener('click', () => {
  commitFocusedCell();
  const mode = document.getElementById('sota-mode').value;
  const stats = { flattened: 0 };
  downloadText(serializeSotaCsv(records, mode, stats), 'text/csv', `sota-${mode}.csv`);
  if (stats.flattened) addWarning(`SOTA CSV: ${stats.flattened} value(s) changed for SOTA's importer, which has no quoting: comma → ";", line break → blank (one QSO per line).`);
});

document.getElementById('btn-toggle-tools').addEventListener('click', e => {
  const open = document.getElementById('tools-panel').classList.toggle('show');
  e.currentTarget.setAttribute('aria-expanded', String(open));
});

document.getElementById('btn-apply-tpl').addEventListener('click', () => {
  applyCommentTemplate(document.getElementById('tpl-input').value);
});

// Closing the tab or reloading would lose unexported edits: the browser asks.
window.addEventListener('beforeunload', e => {
  if (!dirty || !records.length) return;
  e.preventDefault();
  e.returnValue = ''; // older Chrome/Safari need it set
});

trackExpanded(document.getElementById('btn-issues'), document.getElementById('validation-issues'));
document.getElementById('btn-issues').addEventListener('click', () => {
  const panel = document.getElementById('validation-issues');
  panel.hidden = !panel.hidden;
  if (!panel.hidden && issuesStale) renderIssueList();
  updateIssuesButton();
});

populateFieldDatalist();
render();
