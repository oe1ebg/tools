// Unfinished editor text (a new note, an edited note, a prepared reply,
// a talking point) kept as a draft: written shortly after typing stops,
// on every navigation and before an update or reload, restored with its
// selection. A draft is not a saved record; the save chip says which it
// is. Commits run through the same chain, so a late draft write never
// lands after the record that replaced it.

import { writeDraft } from './ops.js';

const DEBOUNCE_MS = 600;

export function createDrafts(app) {
  let stored = new Map(); // key -> draft record of the open session
  const pending = new Map(); // key -> { text, selStart, selEnd, base } not written yet
  const failed = new Set(); // keys whose last write failed
  let timer = null;
  let chain = Promise.resolve();
  let sessionId = null;

  const status = () => {
    if (failed.size) app.saveState.setDraft('unsaved');
    else if (pending.size) app.saveState.setDraft('saving');
    else app.saveState.setDraft([...stored.values()].length ? 'saved' : null);
  };

  const writeOne = async (key, d) => {
    if (app.readOnly || !sessionId) { failed.add(key); return false; }
    try {
      const r = await writeDraft(app.store, { sessionId, tab: app.tab }, key, d);
      if (r) stored.set(key, r); else stored.delete(key);
      failed.delete(key);
      return true;
    } catch (e) {
      failed.add(key);
      app.writeFailed(e, true);
      return false;
    }
  };

  // Write everything pending now; resolves true when nothing is unsaved.
  const flush = () => {
    clearTimeout(timer);
    timer = null;
    chain = chain.then(async () => {
      const work = [...pending.entries()];
      pending.clear();
      for (const [key, d] of work) {
        // typed again meanwhile: the newer text is pending and wins
        if (!(await writeOne(key, d)) && !pending.has(key)) pending.set(key, d);
      }
      status();
      return failed.size === 0 && pending.size === 0;
    });
    return chain;
  };

  return {
    async load(id) {
      sessionId = id;
      pending.clear();
      failed.clear();
      stored = new Map();
      if (!id) return;
      for (const d of await app.store.getByEvent('drafts', id)) stored.set(d.key, d);
      status();
    },
    // the text to show in an editor: unsaved typing, else the stored draft
    get(key) {
      return pending.get(key) || stored.get(key) || null;
    },
    // the user typed in an editor
    typed(key, field, base = null) {
      const d = { text: field.value, selStart: field.selectionStart, selEnd: field.selectionEnd, base };
      const prev = stored.get(key);
      if (!d.text && !prev) pending.delete(key);
      else pending.set(key, d);
      status();
      clearTimeout(timer);
      timer = setTimeout(flush, DEBOUNCE_MS);
    },
    // selection moved without typing: remembered with the next write
    selection(key, field) {
      const d = pending.get(key) || (stored.get(key) && { ...stored.get(key) });
      if (!d) return;
      d.selStart = field.selectionStart;
      d.selEnd = field.selectionEnd;
    },
    // Save the record that replaces the draft (op gets the draft key and
    // removes the draft in its own transaction). Resolves to op's result.
    commit(key, op) {
      clearTimeout(timer);
      const typed = pending.get(key);
      pending.delete(key);
      const p = chain.then(async () => {
        const r = await op(key);
        if (r !== undefined) { stored.delete(key); failed.delete(key); } else if (typed && !pending.has(key)) pending.set(key, typed);
        status();
        return r;
      });
      chain = p.then(() => true, () => true);
      return p;
    },
    // forget a draft (the editor was emptied or the edit given up)
    discard(key) {
      pending.delete(key);
      if (stored.has(key)) {
        pending.set(key, { text: '' });
        return flush();
      }
      status();
      return Promise.resolve(true);
    },
    flush,
    hasUnsaved: () => pending.size > 0 || failed.size > 0,
    keys: () => new Set([...stored.keys(), ...pending.keys()]),
  };
}
