// ADIF editor: the filter bar (#filter-bar in index.html). Turns the
// controls into a filter state (./filter.js) and back; it knows nothing
// about the table: app.js passes onChange and feeds it the columns, file
// names and the shown/total counts.

import { el, fill } from '../../shared/js/dom.js';
import { emptyFilter, isFilterActive } from './filter.js';

const FILTER_OP_LABELS = [
  ['eq', 'equals'], ['starts', 'starts with'], ['contains', 'contains'], ['empty', 'is empty'], ['notempty', 'is not empty'],
];
const FILTER_DEBOUNCE_MS = 150;

export function initFilterUI({ onChange }){
  const $f = id => document.getElementById(id);
  const bar = $f('filter-bar');
  const text = $f('flt-text');
  const textField = $f('flt-text-field');
  const status = $f('flt-status');
  const fileWrap = $f('flt-file-wrap');
  const file = $f('flt-file');
  const from = $f('flt-from');
  const to = $f('flt-to');
  const condBox = $f('flt-conds');
  const count = $f('flt-count');
  const note = $f('flt-note');
  let condSeq = 0;
  let timer = 0;
  let fieldsKey = null, filesKey = null; // what the options were built from

  const fire = () => { clearTimeout(timer); onChange(readState()); };
  const fireLater = () => { clearTimeout(timer); timer = setTimeout(fire, FILTER_DEBOUNCE_MS); };

  function readState(){
    return {
      text: text.value,
      textField: textField.value,
      status: status.value,
      file: fileWrap.hidden ? '' : file.value,
      dateFrom: from.value,
      dateTo: to.value,
      conditions: [...condBox.querySelectorAll('.flt-cond')].map(row => ({
        field: row.querySelector('.flt-cond-field').value.trim().toUpperCase(),
        op: row.querySelector('.flt-cond-op').value,
        value: row.querySelector('.flt-cond-value').value,
      })),
    };
  }

  function condRow(c = { field: '', op: 'eq', value: '' }){
    const n = ++condSeq;
    const value = el('input', { type: 'text', class: 'flt-cond-value', 'aria-label': `condition ${n} value`,
      placeholder: 'value…', autocomplete: 'off', spellcheck: 'false', oninput: fireLater });
    value.value = c.value || '';
    const op = el('select', { class: 'flt-cond-op', 'aria-label': `condition ${n} operator` },
      FILTER_OP_LABELS.map(([v, label]) => el('option', { value: v }, label)));
    op.value = c.op || 'eq';
    const syncValue = () => { value.hidden = op.value === 'empty' || op.value === 'notempty'; };
    syncValue();
    op.addEventListener('change', () => { syncValue(); fire(); });
    const field = el('input', { type: 'text', class: 'flt-cond-field', list: 'adif-field-list', 'aria-label': `condition ${n} field`,
      placeholder: 'field…', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'characters', oninput: fireLater });
    field.value = c.field || '';
    const row = el('div', { class: 'flt-cond' }, field, op, value);
    row.append(el('button', { type: 'button', class: 'flt-cond-rm', 'aria-label': `remove condition ${n}`, title: 'remove condition',
      onclick: () => { row.remove(); fire(); text.focus(); } }, '×'));
    return row;
  }

  function setState(s){
    s = { ...emptyFilter(), ...(s || {}) };
    clearTimeout(timer);
    text.value = s.text;
    if (s.textField && ![...textField.options].some(o => o.value === s.textField)) textField.append(el('option', { value: s.textField }, s.textField));
    textField.value = s.textField;
    status.value = s.status;
    file.value = s.file;
    from.value = s.dateFrom;
    to.value = s.dateTo;
    fill(condBox, s.conditions.map(c => condRow(c)));
  }

  text.addEventListener('input', fireLater);
  for (const c of [textField, status, file, from, to]) c.addEventListener('change', fire);
  $f('flt-add-cond').addEventListener('click', () => {
    const row = condRow();
    condBox.append(row);
    row.querySelector('.flt-cond-field').focus();
  });
  $f('flt-clear').addEventListener('click', () => { setState(emptyFilter()); fire(); });

  return {
    getState: readState,
    setState,
    // Show the bar only when there is a log to filter.
    show(on){ bar.hidden = !on; },
    // The present columns for "search in"; a field no longer present is kept
    // while it is selected.
    setFields(columns){
      const key = columns.join('\n');
      if (key === fieldsKey) return; // unchanged: keep the options
      fieldsKey = key;
      const cur = textField.value;
      const names = columns.includes(cur) || !cur ? columns : [cur, ...columns];
      fill(textField, el('option', { value: '' }, 'all fields'), names.map(c => el('option', { value: c }, c)));
      textField.value = cur;
    },
    // The source file filter, only with more than one file.
    setFiles(names){
      const key = names.join('\n');
      if (key === filesKey) return;
      filesKey = key;
      const cur = file.value;
      fill(file, el('option', { value: '' }, 'all files'), names.map(n => el('option', { value: n }, n)));
      file.value = names.includes(cur) ? cur : '';
      fileWrap.hidden = names.length < 2;
    },
    // "n of N QSOs shown" (a status region: only rewritten when it changes).
    setCount(shown, total){
      const active = isFilterActive(readState());
      const msg = active ? `${shown} of ${total} QSO${total === 1 ? '' : 's'} shown` : '';
      if (count.textContent !== msg) count.textContent = msg;
      note.hidden = !active;
    },
  };
}
