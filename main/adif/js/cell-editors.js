// The ADIF editor's enumeration cells (a native <select>) and the shared
// suggestion list of the open-list text cells (CONTEST_ID, SUBMODE). What
// they offer comes from enum-options.js; app.js decides which cell gets
// what and commits the values.
//
// A rendered select holds only its current value (cheap for the virtual
// table); the full list is filled in when the select is about to be used
// (pointer down or over it, focus), once per select. The select's value is
// always the stored value: rendering never changes the log.
//
// Top-level names start with "ce" (one scope in the single-file bundle).

import { el, isComposing } from '../../shared/js/dom.js';
import { tx } from '../../shared/js/i18n.js';
import { eoOptionList, eoCurrent } from './enum-options.js';

// A text cell of the prototype row becomes a select cell.
export function ceSelectCell(td){
  td.removeAttribute('contenteditable');
  td.removeAttribute('spellcheck');
  td.classList.add('enum-cell');
  td.replaceChildren(el('select', { class: 'cell-select' }));
}

// … and back (a STATE cell whose DXCC no longer has a list).
export function ceTextCell(td, editable){
  td.classList.remove('enum-cell');
  td.replaceChildren();
  td.setAttribute('contenteditable', editable);
  td.spellcheck = false;
}

const ceFilled = new WeakSet();   // selects holding their full list
const ceFragments = new Map();    // list key -> <option>s (empty one first)

// Only the current value, labelled for screen readers ("MODE, row 3").
export function ceSetCurrent(sel, raw, label, ariaLabel){
  ceFilled.delete(sel);
  sel.replaceChildren(new Option(label, raw, true, true));
  if (sel.getAttribute('aria-label') !== ariaLabel) sel.setAttribute('aria-label', ariaLabel);
}

// The full list, the stored value (raw) selected: its option keeps raw's
// spelling, or raw gets its own marked option after the empty one.
export function ceFill(sel, key, raw, ctx){
  if (ceFilled.has(sel)) return;
  let frag = ceFragments.get(key);
  if (!frag){
    frag = document.createDocumentFragment();
    frag.append(new Option('', ''), ...eoOptionList(key).options.map(o => new Option(o.label, o.value)));
    ceFragments.set(key, frag);
  }
  const copy = frag.cloneNode(true);
  const cur = eoCurrent(key, raw, ctx);
  if (cur.value !== ''){
    if (cur.pos >= 0){
      const opt = copy.children[cur.pos + 1];
      opt.value = cur.value;
      opt.text = cur.label;
    } else {
      copy.insertBefore(new Option(cur.label, cur.value), copy.children[1] || null);
    }
  }
  sel.replaceChildren(copy);
  sel.value = cur.value;
  // never show another value than the stored one
  if (sel.value !== cur.value){
    sel.prepend(new Option(cur.label || cur.value, cur.value));
    sel.value = cur.value;
  }
  ceFilled.add(sel);
}

// The option lists of the USERDEF fields may change with the next file.
export function ceClearCache(){
  ceFragments.clear();
}

/* ---------- suggestion list ---------- */

// One listbox (#cell-suggest) for the focused text cell, next to it; the
// focus stays in the cell. While it is open: ↑/↓ move the highlight
// (announced in #cell-suggest-status), Enter takes the highlighted item
// (or keeps the typed text) and the editor commits as usual, the first Esc
// closes it, Tab closes it. A click on an item takes it.
// dropEl: the table's scroll container; onPick(td, value): an item clicked.
export function initCellSuggest({ dropEl, onPick }){
  const list = document.getElementById('cell-suggest');
  const status = document.getElementById('cell-suggest-status');
  let td = null, items = [], active = -1;

  const say = text => { if (status.textContent !== text) status.textContent = text; };

  function place(){
    const r = td.getBoundingClientRect();
    list.style.minWidth = `${Math.round(r.width)}px`;
    list.style.left = `${Math.round(Math.max(0, Math.min(r.left, window.innerWidth - list.offsetWidth)))}px`;
    const below = window.innerHeight - r.bottom;
    const h = list.offsetHeight;
    list.style.top = `${Math.round(h > below && r.top > below ? Math.max(0, r.top - h) : r.bottom)}px`;
  }

  function highlight(i){
    const opts = list.querySelectorAll('[role=option]:not([aria-disabled])');
    if (opts[active]) opts[active].setAttribute('aria-selected', 'false');
    active = i;
    const o = opts[i];
    if (!o) return;
    o.setAttribute('aria-selected', 'true');
    o.scrollIntoView({ block: 'nearest' });
    say(tx(`${items[i]}, ${i + 1} of ${items.length}`, `${items[i]}, ${i + 1} von ${items.length}`));
  }

  function hide(){
    if (list.hidden) return;
    list.hidden = true;
    list.replaceChildren();
    td = null; items = []; active = -1;
    say('');
  }

  // Shows result ({ items, total } of eoSuggestions) for the cell; first:
  // highlight the first item at once.
  function show(cell, result, first = false){
    if (!result.items.length){ hide(); return; }
    td = cell;
    items = result.items;
    active = -1;
    const more = result.total - items.length;
    list.replaceChildren(...items.map((v, i) => el('li', { role: 'option', id: `cell-suggest-${i}`, 'aria-selected': 'false', 'data-i': String(i) }, v)),
      more > 0 ? el('li', { role: 'option', class: 'more', 'aria-disabled': 'true' }, tx(`… ${more} more`, `… ${more} weitere`)) : null);
    list.hidden = false;
    place();
    say(tx(`${result.total} suggestion${result.total === 1 ? '' : 's'}`, `${result.total} Vorschl${result.total === 1 ? 'ag' : 'äge'}`));
    if (first) highlight(0);
  }

  // A key in the cell; true: handled here (the editor does nothing more).
  function handleKey(e){
    if (list.hidden) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp'){
      e.preventDefault();
      const n = items.length;
      highlight(e.key === 'ArrowDown' ? (active + 1) % n : (active <= 0 ? n - 1 : active - 1));
      return true;
    }
    if (e.key === 'Escape'){
      e.preventDefault();
      hide();
      return true;
    }
    if (e.key === 'Enter' && !isComposing(e)){
      if (active >= 0 && td) td.textContent = items[active];
      hide();
      return false; // the editor commits and moves on
    }
    if (e.key === 'Tab') hide();
    return false;
  }

  // a click keeps the focus in the cell
  list.addEventListener('pointerdown', e => e.preventDefault());
  list.addEventListener('mousedown', e => e.preventDefault());
  list.addEventListener('click', e => {
    const li = e.target.closest('li[data-i]');
    if (!li || !td) return;
    const cell = td;
    const v = items[Number(li.dataset.i)];
    hide();
    onPick(cell, v);
  });
  // follows its cell (the table scrolls, the window or keyboard resizes)
  const follow = () => {
    if (list.hidden) return;
    if (td?.isConnected) place(); else hide();
  };
  dropEl.addEventListener('scroll', follow, { passive: true });
  window.addEventListener('resize', follow);

  return { show, hide, handleKey, isOpen: () => !list.hidden, cell: () => td };
}
