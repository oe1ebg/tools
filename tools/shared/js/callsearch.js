// Completion on the log header's Operator / Station fields, like the
// repeater search: type part of a callsign, a name or a place and pick from
// the dropdown (↓, Enter). Callsigns used in earlier logs come first; the
// rest is the offline Austrian callsign list. Free input stays possible:
// Enter only takes a suggestion that completes what was typed
// (enterTakes), so a complete callsign that isn't in the list (a guest, a
// new licence) is never swapped for a similar one (OE3XYZ -> OE3XYL); a
// correction needs ↓.

import { el, fill, popover } from './dom.js';
import { searchCallbook, normalizeCall, isPlausibleCall } from './callbook.js';

// Enter in the field takes the first suggestion `call` only if it completes
// the typed text, or if that text isn't a callsign (a name or a place).
export function enterTakes(typed, call) {
  const q = normalizeCall(typed);
  return !isPlausibleCall(q) || call.startsWith(q);
}

// getCalls(): the tool's callsign service (callsign-service.js; null: no
// suggestions from the lists); the older getBook(): the plain callbook; recent(): [{ call,
// title }] from earlier logs, newest first; onPick(call): after the field
// got the callsign.
export function attachCallSearch({ input, pop, getBook, getCalls, recent, onPick }) {
  const dd = popover(input, pop, {
    label: 'Rufzeichen-Vorschläge',
    enterPicksFirst: first => enterTakes(input.value, first.dataset.call),
  });
  let timer = null;

  function suggest() {
    const q = input.value.trim();
    const calls = getCalls ? getCalls() : null;
    const book = getCalls ? null : getBook();
    const qCall = normalizeCall(q);
    // one shape for both: [call, name, qth, listName] (listName: only for lists other than the Austrian one)
    const has = c => (calls ? calls.has(c) : book?.byCall.has(c));
    const find = (text, n) => (calls
      ? calls.search(text, n).map(m => [m.call, m.name, m.qth, m.fromKind === 'builtin' ? '' : m.from])
      : searchCallbook(book, text, n));
    const stand = calls ? calls.stand() : book?.stand;
    const used = recent().filter(r => !q || r.call.startsWith(qCall)).slice(0, q ? 3 : 5);
    // the field already holds a complete callsign: nothing to offer
    const done = qCall && (used.some(r => r.call === qCall) || has(qCall)) && !used.some(r => r.call !== qCall);
    const fromBook = q && !done ? find(q, 8).filter(c => !used.some(r => r.call === c[0])) : [];
    const item = (call, detail) => el('button', {
      type: 'button', class: 'ac-item', 'data-call': call,
      onclick: () => {
        input.value = call;
        fill(pop);
        dd.hide();
        onPick(call);
        input.focus();
      },
    }, el('b', {}, call), detail ? el('small', {}, detail) : null);
    const lookup = call => {
      if (!calls) return book?.byCall.get(call);
      const e = calls.entry(call);
      return e ? [e.call, e.name, e.qth] : null;
    };
    const usedItems = done ? [] : used.map(r => {
      const c = lookup(r.call);
      return item(r.call, [c?.[1], c?.[2], `zuletzt in „${r.title}“`].filter(Boolean).join(' · '));
    });
    fill(pop,
      usedItems.length ? [el('div', { class: 'ac-head' }, 'Zuletzt verwendet:'), usedItems] : null,
      fromBook.length ? [el('div', { class: 'ac-head' }, `${calls ? 'Rufzeichenlisten' : 'Rufzeichenliste'}${stand ? ` (Stand ${stand.replace(/^(\d{4})-(\d{2})-(\d{2})$/, '$3.$2.$1')})` : ''}; ↓, Enter:`),
        fromBook.map(c => item(c[0], [c[1], c[2], c[3] ? `aus „${c[3]}“` : ''].filter(Boolean).join(' · ')))] : null);
    dd.update();
  }

  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(suggest, 100);
  });
  input.addEventListener('focus', suggest);
}
