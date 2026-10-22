// What the save chip says: saving, saved (only after the commit), a draft
// kept or not kept, a failed save, read-only, or a store that is not
// durable at all. No DOM; app.js renders text() into #st-save.

import { hms, zone } from './clock.js';

const stampText = iso => (iso ? `${hms(iso)} ${zone(iso)}` : '');

export function createSaveState(onChange) {
  const st = {
    pending: 0,
    failed: null, // the error of the last failed save, until a save works
    savedAt: null,
    draft: null, // null | 'saved' | 'unsaved' | 'saving'
    draftAt: null,
    readOnly: false,
    durable: true,
  };
  return {
    state: st,
    // Wrap a write: resolves/rejects like it, and the chip follows.
    track(promise) {
      st.pending++;
      onChange();
      return promise.then(r => {
        st.pending--;
        st.failed = null;
        st.savedAt = new Date().toISOString();
        onChange();
        return r;
      }, e => {
        st.pending--;
        st.failed = e;
        onChange();
        throw e;
      });
    },
    setDraft(kind) {
      st.draft = kind;
      if (kind === 'saved') st.draftAt = new Date().toISOString();
      onChange();
    },
    set(field, value) {
      st[field] = value;
      onChange();
    },
    // [translation key, vars, css class]
    view() {
      if (!st.durable) return ['save.memory', {}, 'err'];
      if (st.failed) return ['save.failed', {}, 'err'];
      if (st.draft === 'unsaved') return ['save.draftUnsaved', {}, 'err'];
      if (st.readOnly) return ['save.readOnly', {}, 'warn'];
      if (st.pending || st.draft === 'saving') return ['save.saving', {}, ''];
      if (st.draft === 'saved') return ['save.draftSaved', { time: stampText(st.draftAt) }, 'ok'];
      if (st.savedAt) return ['save.saved', { time: stampText(st.savedAt) }, 'ok'];
      return ['save.idle', {}, ''];
    },
  };
}
