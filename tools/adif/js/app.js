// ADIF editor: state, table rendering, file loading and the toolbar.
// Everything runs in the browser; nothing is uploaded.

import { ADIF_FIELDS, ADIF_FIELD_MAP } from './fields.js';
import { parseADIF } from '../../shared/js/adif.js';
import { serializeADIF, serializeCSV, serializeSotaCsv } from './export.js';

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
  box.innerHTML = '';
  box.classList.remove('show');
}

/* ---------- rendering ---------- */

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
    dropEl.innerHTML = '<div id="empty-msg">drag &amp; drop .adi / .adx file(s) here<br>' +
      '<span class="hint">or click "add file(s)…" — files are added to the current log; nothing leaves the browser</span></div>';
    updateStats();
    updateFileInfo();
    setExportButtonsDisabled(true);
    return;
  }
  setExportButtonsDisabled(false);

  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const htr = document.createElement('tr');
  const rowNumTh = document.createElement('th');
  rowNumTh.className = 'rownum-col';
  rowNumTh.textContent = '#';
  htr.appendChild(rowNumTh);
  columns.forEach((col, ci) => {
    const th = document.createElement('th');
    const wrap = document.createElement('span');
    wrap.className = 'colhead';
    const label = document.createElement('span');
    label.textContent = col;
    label.style.cursor = 'pointer';
    const fieldDef = ADIF_FIELD_MAP.get(col);
    label.title = 'click to sort' + (fieldDef
      ? ` — ${fieldDef.type}: ${fieldDef.desc}`
      : ' — no ADIF definition (custom/application field)');
    label.addEventListener('click', () => sortByColumn(col));
    const rm = document.createElement('span');
    rm.className = 'rmcol';
    rm.textContent = '×';
    rm.title = 'remove column';
    rm.addEventListener('click', (e) => { e.stopPropagation(); removeColumn(col); });
    wrap.appendChild(label);
    wrap.appendChild(rm);
    th.appendChild(wrap);
    htr.appendChild(th);
  });
  thead.appendChild(htr);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  records.forEach((rec, ri) => {
    const tr = document.createElement('tr');
    const numTd = document.createElement('td');
    numTd.className = 'rownum';
    numTd.innerHTML = (ri+1) + '<span class="del" title="delete row">×</span>';
    numTd.querySelector('.del').addEventListener('click', () => deleteRow(ri));
    tr.appendChild(numTd);
    columns.forEach(col => {
      const td = document.createElement('td');
      td.contentEditable = 'true';
      td.spellcheck = false;
      td.textContent = rec[col] !== undefined ? rec[col] : '';
      td.addEventListener('blur', () => {
        const v = td.textContent;
        if (v === '') delete rec[col];
        else rec[col] = v;
        updateStats();
      });
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);

  dropEl.innerHTML = '';
  dropEl.appendChild(table);

  const addRowDiv = document.createElement('div');
  addRowDiv.style.padding = '.6em .8em';
  const addRowBtn = document.createElement('button');
  addRowBtn.textContent = '+ row';
  addRowBtn.addEventListener('click', addRow);
  addRowDiv.appendChild(addRowBtn);

  const newFieldInput = document.createElement('input');
  newFieldInput.type = 'text';
  newFieldInput.setAttribute('list', 'adif-field-list');
  newFieldInput.placeholder = 'field name…';
  newFieldInput.style.marginLeft = '.6em';
  newFieldInput.style.width = '14em';
  addRowDiv.appendChild(newFieldInput);

  const addColBtn = document.createElement('button');
  addColBtn.textContent = '+ field';
  addColBtn.style.marginLeft = '.4em';
  addColBtn.addEventListener('click', () => {
    const name = newFieldInput.value.trim().toUpperCase();
    if (name) addColumn(name);
    newFieldInput.value = '';
  });
  newFieldInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addColBtn.click();
  });
  addRowDiv.appendChild(addColBtn);

  dropEl.appendChild(addRowDiv);

  updateStats();
  updateFileInfo();
}

function updateStats(){
  const stats = document.getElementById('stats');
  if (records.length === 0){ stats.textContent = ''; return; }
  const bands = new Set(records.map(r => r.BAND).filter(Boolean));
  const modes = new Set(records.map(r => r.MODE).filter(Boolean));
  stats.innerHTML = `<b>${records.length}</b> QSOs` +
    (fileMeta.length > 1 ? ` from <b>${fileMeta.length}</b> files` : '') +
    ` · <b>${columns.length}</b> fields` +
    (bands.size ? ` · bands: ${[...bands].join(', ')}` : '') +
    (modes.size ? ` · modes: ${[...modes].join(', ')}` : '');
}

function updateFileInfo(){
  const el = document.getElementById('file-info');
  if (!fileMeta.length){ el.textContent = ''; return; }
  el.textContent = fileMeta.map(f => `${f.name}: ADIF ${f.adifVer || 'version not declared'}`).join(' · ');
}

/* ---------- editing ops ---------- */

function addRow(){
  records.push({});
  render();
}

function deleteRow(idx){
  records.splice(idx, 1);
  render();
}

function addColumn(name){
  if (!name || columns.includes(name)) return;
  columns.push(name);
  render();
}

function removeColumn(name){
  columns = columns.filter(c => c !== name);
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
  if (changed){ rebuildColumns(); render(); }
}

/* ---------- file loading ---------- */

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
      const parsed = parseADIF(reader.result, warnings, file.name, headerInfo);
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
      if (pending === 0) render();
    };
    reader.onerror = () => {
      addWarning(`${file.name}: could not be read.`);
      pending--;
      if (pending === 0) render();
    };
    reader.readAsText(file);
  });
  const fnInput = document.getElementById('filename-input');
  if (files.length === 1) fnInput.value = files[0].name.replace(/\.[^.]+$/, '') + '.adi';
}

/* ---------- drag & drop / open / export wiring ---------- */

['dragenter','dragover'].forEach(evt =>
  dropEl.addEventListener(evt, e => { e.preventDefault(); dropEl.classList.add('dragover'); }));
['dragleave','drop'].forEach(evt =>
  dropEl.addEventListener(evt, e => { e.preventDefault(); dropEl.classList.remove('dragover'); }));
dropEl.addEventListener('drop', e => {
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
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.getElementById('dl');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function swapExt(filename, ext){
  const base = (filename || 'export').replace(/\.[^.]+$/, '');
  return `${base}.${ext}`;
}

document.getElementById('btn-export').addEventListener('click', () => {
  const name = document.getElementById('filename-input').value.trim() || 'export.adi';
  downloadText(serializeADIF(records, columns), 'text/plain', name);
});

document.getElementById('btn-export-csv').addEventListener('click', () => {
  const name = swapExt(document.getElementById('filename-input').value, 'csv');
  downloadText(serializeCSV(records, columns), 'text/csv', name);
});

document.getElementById('btn-export-sota').addEventListener('click', () => {
  const mode = document.getElementById('sota-mode').value;
  downloadText(serializeSotaCsv(records, mode), 'text/csv', `sota-${mode}.csv`);
});

document.getElementById('btn-toggle-tools').addEventListener('click', () => {
  document.getElementById('tools-panel').classList.toggle('show');
});

document.getElementById('btn-apply-tpl').addEventListener('click', () => {
  applyCommentTemplate(document.getElementById('tpl-input').value);
});

/* ---------- theme (light / dark / auto) ---------- */

const THEME_KEY = 'adif-editor-theme';

function applyTheme(mode){
  if (mode === 'light' || mode === 'dark') {
    document.documentElement.setAttribute('data-theme', mode);
  } else {
    document.documentElement.removeAttribute('data-theme'); // "auto": follow prefers-color-scheme
  }
  document.querySelectorAll('#theme-toggle button').forEach(b => {
    b.classList.toggle('active', b.dataset.themeChoice === mode);
  });
}

function initTheme(){
  applyTheme(localStorage.getItem(THEME_KEY) || 'auto');
  document.querySelectorAll('#theme-toggle button').forEach(b => {
    b.addEventListener('click', () => {
      const mode = b.dataset.themeChoice;
      localStorage.setItem(THEME_KEY, mode);
      applyTheme(mode);
    });
  });
}

initTheme();
populateFieldDatalist();
render();
