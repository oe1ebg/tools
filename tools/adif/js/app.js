// ADIF editor: state, table rendering, file loading and the toolbar.
// Everything runs in the browser; nothing is uploaded.

import { ADIF_FIELDS, ADIF_FIELD_MAP } from './fields.js';
import { parseADIFAuto } from '../../shared/js/adif.js';
import { serializeADIF, serializeCSV, serializeSotaCsv, adifChangedValues, ADI_MIME } from './export.js';
import { el, fill, isComposing, trackExpanded } from '../../shared/js/dom.js';
import { validateAdif } from '../../shared/js/adif-validate.js';
import { ADIF_SPEC_VERSION } from '../../shared/js/adif-spec-data.js';
import { renderCompliance } from './compliance.js';

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

let records = [];   // array of {FIELD: value}
let columns = [];   // ordered field names
let fileMeta = [];  // [{name, adifVer, programId, programVersion}], one per loaded file
let dirty = false;  // edits since the last export (asked about before leaving the page)

function markDirty(){ dirty = true; scheduleRevalidate(); }

function rebuildColumns(){
  const seen = new Set(columns);
  for (const rec of records){
    for (const k of Object.keys(rec)){
      if (!seen.has(k)){ seen.add(k); columns.push(k); }
    }
  }
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
const SEVERITY_RANK = { error: 3, warning: 2, info: 1 };
const SEVERITY_GLYPH = { error: '✕', warning: '⚠', info: 'ⓘ' };
const MAX_LISTED_ISSUES = 500;

function validateFile(name, text, parsed){
  let result;
  try { result = validateAdif(text); }
  catch (e){ // a bug in the validator must not break loading the file
    console.error(e);
    return { label: name, result: null, recs: [] };
  }
  const recs = result.records.length === parsed.length ? parsed : result.records.map(() => null);
  return { label: name, result, recs };
}

function showFileValidations(){
  const scope = fileValidations.length === 1 ? fileValidations[0].label : `${fileValidations.length} files`;
  validationView = { scope, results: fileValidations };
}

// After an edit: check the log as the ADI export would write it (records
// in table order, so result record i is records[i]).
function scheduleRevalidate(){
  clearTimeout(revalidateTimer);
  revalidateTimer = setTimeout(() => {
    if (!records.length){ validationView = null; renderValidation(); return; }
    // rows without any value (e.g. just added) are not checked
    const filled = records.filter(rec => columns.some(c => rec[c] !== undefined && rec[c] !== null && rec[c] !== ''));
    let result;
    try { result = validateAdif(serializeADIF(filled, columns)); }
    catch (e){ console.error(e); return; }
    validationView = { scope: 'current log, as it would be exported', results: [{ label: 'current log', result, recs: filled }] };
    flagCells();
    renderValidation();
  }, 150);
}

// record -> Map(field -> [issue]); issues without a field under ''.
function issuesByRecord(){
  const map = new Map();
  for (const { result, recs } of validationView?.results || []){
    if (!result) continue;
    for (const issue of result.issues){
      const rec = issue.recordType === 'qso' ? recs[issue.recordIndex] : null;
      if (!rec) continue;
      if (!map.has(rec)) map.set(rec, new Map());
      const byField = map.get(rec);
      // BAND/FREQ, MODE/SUBMODE: flag both cells
      for (const f of (issue.field || '').split('/')){
        if (!byField.has(f)) byField.set(f, []);
        byField.get(f).push(issue);
      }
    }
  }
  return map;
}

function worstSeverity(issues){
  return issues.reduce((w, i) => (SEVERITY_RANK[i.severity] > SEVERITY_RANK[w] ? i.severity : w), 'info');
}

function issueTitle(issues){
  return issues.map(i => `${SEVERITY_GLYPH[i.severity]} ${i.message} (${i.code})`).join('\n');
}

// Problem cells: class cell-error|warning|info and the messages as title;
// the row number shows the worst severity of its QSO.
function flagCells(){
  const tbody = dropEl.querySelector('tbody');
  if (!tbody) return;
  const map = issuesByRecord();
  [...tbody.rows].forEach((tr, ri) => {
    const byField = map.get(records[ri]);
    const numTd = tr.cells[0];
    numTd.classList.remove('row-error', 'row-warning');
    numTd.removeAttribute('title');
    if (byField){
      const all = [...new Set([...byField.values()].flat())];
      const sev = worstSeverity(all);
      if (sev !== 'info') numTd.classList.add(`row-${sev}`);
      numTd.title = issueTitle(all);
    }
    columns.forEach((col, ci) => {
      const td = tr.cells[ci + 1];
      if (!td) return;
      td.classList.remove('cell-error', 'cell-warning', 'cell-info');
      const list = byField?.get(col);
      if (list){
        td.classList.add(`cell-${worstSeverity(list)}`);
        td.title = issueTitle(list);
      } else td.removeAttribute('title');
    });
  });
}

function updateIssuesButton(){
  const panel = document.getElementById('validation-issues');
  fill(document.getElementById('btn-issues'), panel.hidden ? 'show issues ' : 'hide issues ',
    el('span', { 'aria-hidden': 'true' }, panel.hidden ? '▾' : '▴'));
}

function plural(n, word){ return `${n} ${word}${n === 1 ? '' : 's'}`; }

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
    el('span', { class: 'v-scope' }, `${validationView.scope}${perFile} · checked against ADIF ${ADIF_SPEC_VERSION}`));
  // a status region: only rewritten when its text changes
  const status = document.getElementById('validation-summary');
  if (summary.textContent !== status.textContent) fill(status, [...summary.childNodes]);
  const total = n.errors + n.warnings + n.infos;
  document.getElementById('btn-issues').hidden = total === 0;
  if (total === 0) panel.hidden = true;
  fill(panel, issueGroups(results));
  updateIssuesButton();
}

// The issue list: general issues per file, then one group per QSO (with
// its current row in the table).
function issueGroups(results){
  const groups = [];
  let listed = 0, skipped = 0;
  const fieldLabel = i => (i.field ? i.field.replace('/', ' / ') : i.recordType === 'qso' ? '(QSO)' : `(${i.recordType})`);
  const item = issue => {
    if (listed >= MAX_LISTED_ISSUES){ skipped++; return null; }
    listed++;
    return el('li', {},
      el('span', { class: `sev-${issue.severity}`, role: 'img', 'aria-label': issue.severity }, SEVERITY_GLYPH[issue.severity]),
      el('span', { class: 'v-field' }, fieldLabel(issue)),
      el('span', {}, issue.message, el('span', { class: 'v-code' }, issue.code),
        issue.line ? el('span', { class: 'v-loc' }, `line ${issue.line}:${issue.column}`) : null));
  };
  for (const { label, result, recs } of results){
    const prefix = results.length > 1 ? `${label} · ` : '';
    const byRec = new Map();
    const general = [];
    for (const i of result.issues){
      const rec = i.recordType === 'qso' ? recs[i.recordIndex] : null;
      if (!rec){ general.push(i); continue; }
      if (!byRec.has(rec)) byRec.set(rec, []);
      byRec.get(rec).push(i);
    }
    if (general.length) groups.push(el('div', { class: 'v-group' }, el('h2', {}, `${prefix}File`), el('ul', {}, general.map(item))));
    for (const [rec, issues] of byRec){
      const row = records.indexOf(rec) + 1;
      const where = [rec.CALL, row ? `row ${row}` : 'removed from the table'].filter(Boolean).join(' · ');
      groups.push(el('div', { class: 'v-group' },
        el('h2', {}, `${prefix}QSO #${issues[0].recordIndex + 1} `, el('span', { class: 'dim' }, where)),
        el('ul', {}, issues.map(item))));
    }
  }
  if (skipped) groups.push(el('p', { class: 'v-more' }, `… and ${skipped} more (the first ${MAX_LISTED_ISSUES} are listed).`));
  return groups;
}

/* ---------- rendering ---------- */

function setPlainEditable(node){
  try { node.contentEditable = 'plaintext-only'; } catch { node.contentEditable = 'true'; }
}

const dropEl = document.getElementById('drop');

function setExportButtonsDisabled(disabled){
  document.getElementById('btn-export').disabled = disabled;
  document.getElementById('btn-export-csv').disabled = disabled;
  document.getElementById('btn-export-sota').disabled = disabled;
}

function render(){
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

  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const htr = document.createElement('tr');
  const rowNumTh = document.createElement('th');
  rowNumTh.className = 'rownum-col';
  rowNumTh.scope = 'col';
  rowNumTh.textContent = '#';
  htr.appendChild(rowNumTh);
  columns.forEach((col, ci) => {
    const fieldDef = ADIF_FIELD_MAP.get(col);
    const sorted = sortState.col === col;
    htr.appendChild(el('th', { scope: 'col', 'aria-sort': sorted ? (sortState.asc ? 'ascending' : 'descending') : null },
      el('span', { class: 'colhead' },
        el('button', {
          type: 'button', class: 'sortcol',
          title: 'click to sort' + (fieldDef
            ? ` — ${fieldDef.type}: ${fieldDef.desc}`
            : ' — no ADIF definition (custom/application field)'),
          onclick: () => sortByColumn(col),
        }, col),
        el('button', { type: 'button', class: 'rmcol', title: 'remove column', 'aria-label': `remove column ${col}`,
          onclick: () => removeColumn(col) }, '×'))));
  });
  thead.appendChild(htr);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  records.forEach((rec, ri) => {
    const tr = document.createElement('tr');
    const numTd = document.createElement('td');
    numTd.className = 'rownum';
    numTd.append(String(ri + 1), el('button', { type: 'button', class: 'del', title: 'delete row',
      'aria-label': `delete row ${ri + 1}`, onclick: () => deleteRow(ri) }, '×'));
    tr.appendChild(numTd);
    columns.forEach((col, ci) => {
      const td = document.createElement('td');
      setPlainEditable(td);
      td.spellcheck = false;
      td.textContent = rec[col] !== undefined ? rec[col] : '';
      // Enter takes the value and moves one row down (ADIF values have no
      // line breaks), Esc restores the value from before the edit.
      let before = td.textContent;
      td.addEventListener('focus', () => { before = td.textContent; });
      td.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !isComposing(e)){
          e.preventDefault();
          const below = tr.nextElementSibling?.children[ci + 1];
          if (below) below.focus(); else td.blur();
        } else if (e.key === 'Escape'){
          e.preventDefault();
          td.textContent = before;
          td.blur();
        }
      });
      td.addEventListener('blur', () => {
        const v = td.textContent;
        if (v === (rec[col] ?? '')) return;
        if (v === '') delete rec[col];
        else rec[col] = v;
        markDirty();
        updateStats();
      });
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);

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

  updateStats();
  updateFileInfo();
  flagCells();
  renderValidation();
}

function updateStats(){
  const stats = document.getElementById('stats');
  if (records.length === 0){ stats.textContent = ''; return; }
  const bands = new Set(records.map(r => r.BAND).filter(Boolean));
  const modes = new Set(records.map(r => r.MODE).filter(Boolean));
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
  markDirty();
  render();
}

function deleteRow(idx){
  records.splice(idx, 1);
  markDirty();
  render();
}

function addColumn(name){
  if (!name || columns.includes(name)) return;
  columns.push(name);
  markDirty();
  render();
}

function removeColumn(name){
  columns = columns.filter(c => c !== name);
  markDirty();
  for (const rec of records) delete rec[name];
  render();
}

let sortState = { col: null, asc: true };
function sortByColumn(col){
  if (sortState.col === col) sortState.asc = !sortState.asc;
  else { sortState = { col, asc: true }; }
  records.sort((a, b) => {
    const av = a[col] ?? '';
    const bv = b[col] ?? '';
    const an = parseFloat(av), bn = parseFloat(bv);
    let cmp;
    if (!isNaN(an) && !isNaN(bn) && String(an) === av.trim() && String(bn) === bv.trim()){
      cmp = an - bn;
    } else {
      cmp = av.localeCompare(bv);
    }
    return sortState.asc ? cmp : -cmp;
  });
  render();
}

function applyCommentTemplate(template){
  const re = /\{([A-Za-z0-9_]+)\}/g;
  let changed = false;
  for (const rec of records){
    if (rec.COMMENT) continue; // only fill rows where COMMENT is currently blank/absent
    const filled = template.replace(re, (_, name) => rec[name.toUpperCase()] || '');
    if (filled !== ''){ rec.COMMENT = filled; changed = true; }
  }
  if (changed){ markDirty(); rebuildColumns(); render(); }
}

/* ---------- file loading ---------- */

// .adi files are meant to be ASCII; in practice they're UTF-8 or, from
// many Windows loggers, Windows-1252. Strict UTF-8 first, else 1252.
function decodeLog(buffer, name, warnings){
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    warnings.push(`${name}: not UTF-8, read as Windows-1252.`);
    return new TextDecoder('windows-1252').decode(buffer);
  }
}

function loadFiles(fileList){
  clearWarnings();
  const files = Array.from(fileList);
  let pending = files.length;
  if (!pending) return;
  files.forEach(file => {
    const reader = new FileReader();
    reader.onload = () => {
      const warnings = [];
      const headerInfo = {};
      const text = decodeLog(reader.result, file.name, warnings);
      const parsed = parseADIFAuto(text, warnings, file.name, headerInfo);
      fileValidations.push(validateFile(file.name, text, parsed));
      records = records.concat(parsed);
      rebuildColumns();
      fileMeta.push({
        name: file.name,
        adifVer: headerInfo.ADIF_VER || null,
        programId: headerInfo.PROGRAMID || null,
        programVersion: headerInfo.PROGRAMVERSION || null,
      });
      warnings.forEach(addWarning);
      pending--;
      if (pending === 0){ showFileValidations(); render(); }
    };
    reader.onerror = () => {
      addWarning(`${file.name}: could not be read.`);
      pending--;
      if (pending === 0){ showFileValidations(); render(); }
    };
    reader.readAsArrayBuffer(file);
  });
  const fnInput = document.getElementById('filename-input');
  if (files.length === 1) fnInput.value = files[0].name.replace(/\.[^.]+$/, '') + '.adi';
}

/* ---------- drag & drop / open / export wiring ---------- */

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

document.getElementById('btn-export').addEventListener('click', () => {
  const name = document.getElementById('filename-input').value.trim() || 'export.adi';
  // .adi is ASCII: say which values had to be transliterated
  const changed = adifChangedValues(records, columns);
  if (changed) addWarning(`${changed} value(s) contained non-ASCII characters; transliterated in the export (ä → ae, é → e, other → ?).`);
  downloadText(serializeADIF(records, columns), ADI_MIME, name);
  dirty = false;
});

document.getElementById('btn-export-csv').addEventListener('click', () => {
  const name = swapExt(document.getElementById('filename-input').value, 'csv');
  downloadText(serializeCSV(records, columns), 'text/csv', name);
  dirty = false;
});

document.getElementById('btn-export-sota').addEventListener('click', () => {
  const mode = document.getElementById('sota-mode').value;
  downloadText(serializeSotaCsv(records, mode), 'text/csv', `sota-${mode}.csv`);
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
  updateIssuesButton();
});

populateFieldDatalist();
render();
