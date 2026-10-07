// Completion on the log header's Operator / Station fields, like the
// repeater search: type part of a callsign, a name or a place and pick from
// the dropdown (↓, Enter). Callsigns used in earlier logs come first; the
// rest is the offline Austrian callsign list. Free input stays possible.

import { el, fill, popover } from './dom.js';
import { searchCallbook, normalizeCall } from './callbook.js';

// getBook(): the callbook (or null while loading); recent(): [{ call,
// title }] from earlier logs, newest first; onPick(call): after the field
// got the callsign.
export function attachCallSearch({ input, pop, getBook, recent, onPick }) {
  const dd = popover(input, pop, { label: 'Rufzeichen-Vorschläge' });
  let timer = null;

  function suggest() {
    const q = input.value.trim();
    const book = getBook();
    const qCall = normalizeCall(q);
    const used = recent().filter(r => !q || r.call.startsWith(qCall)).slice(0, q ? 3 : 5);
    // the field already holds a complete callsign: nothing to offer
    const done = qCall && (used.some(r => r.call === qCall) || book?.byCall.has(qCall)) && !used.some(r => r.call !== qCall);
    const fromBook = q && !done ? searchCallbook(book, q, 8).filter(c => !used.some(r => r.call === c[0])) : [];
    const item = (call, detail) => el('button', {
      type: 'button', class: 'ac-item',
      onclick: () => {
        input.value = call;
        fill(pop);
        dd.hide();
        onPick(call);
        input.focus();
      },
    }, el('b', {}, call), detail ? el('small', {}, detail) : null);
    const lookup = call => book?.byCall.get(call);
    const usedItems = done ? [] : used.map(r => {
      const c = lookup(r.call);
      return item(r.call, [c?.[1], c?.[2], `zuletzt in „${r.title}“`].filter(Boolean).join(' · '));
    });
    fill(pop,
      usedItems.length ? [el('div', { class: 'ac-head' }, 'Zuletzt verwendet:'), usedItems] : null,
      fromBook.length ? [el('div', { class: 'ac-head' }, `Rufzeichenliste${book.stand ? ` (Stand ${book.stand.replace(/^(\d{4})-(\d{2})-(\d{2})$/, '$3.$2.$1')})` : ''}; ↓, Enter:`),
        fromBook.map(c => item(c[0], [c[1], c[2]].filter(Boolean).join(' · ')))] : null);
    dd.update();
  }

  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(suggest, 100);
  });
  input.addEventListener('focus', suggest);
}
