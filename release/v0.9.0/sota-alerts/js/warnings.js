// The #warnings box (a live region). Two kinds of warnings share it:
// - render warnings, about what renderAll() shows (date range outside
//   the feed, alerts that couldn't be placed): rebuilt on every render,
//   collected between begin() and flush();
// - event warnings, from things that happened (loading alerts failed,
//   storage full, a shared link's summit missing): they stay until
//   drop(key) says the problem is gone.
// The box is only rewritten when the list changed, so a screen reader
// doesn't re-announce the same warnings on every click.

import { el, fill } from '../../shared/js/dom.js';

export function createWarnings(box){
  const eventWarnings = new Map(); // key -> text
  let renderWarnings = [];
  let pending = null;              // collecting during a render

  function show(){
    const next = [...eventWarnings.values(), ...renderWarnings];
    const current = [...box.children].map(d => d.textContent);
    if (current.length === next.length && current.every((t, i) => t === next[i])) return;
    fill(box, next.map(text => el('div', null, text)));
    box.classList.toggle('show', next.length > 0);
  }

  return {
    // Without a key during a render: a render warning; otherwise an event
    // warning under `key` (or its own text).
    add(msg, key){
      const text = '⚠ ' + msg;
      if (pending && !key){ pending.push(text); return; }
      eventWarnings.set(key || text, text);
      if (!pending) show();
    },
    drop(key){
      if (eventWarnings.delete(key) && !pending) show();
    },
    begin(){ pending = []; },
    flush(){
      renderWarnings = pending || [];
      pending = null;
      show();
    },
  };
}
