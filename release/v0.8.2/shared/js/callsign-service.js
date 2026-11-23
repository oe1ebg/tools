// The one callsign lookup of every tool: the bundled Austrian list and the
// user's own lists (shared callsign store) as one merged directory, with
// everything a tool asks of it. No DOM (the dialog that manages the lists
// is callsignlists.js, on top of this). Lookups are synchronous on an
// in-memory index; before init() finishes, or without IndexedDB, they
// answer from the Austrian list alone, so a tool never waits for it.
//
//   const calls = createCallsignService({ getLang, onChange });
//   await calls.init();           // loads the list, opens the store (not fatal)
//   calls.watchFocus();           // pick up changes made in another tab/tool
//   calls.entry('OE1EBG')         // merged: { call, source, name, qth, grid, note, notes, from,
//                                 //   fromKind, qthOfficial, official, entries } or null
//   calls.search('OE1AB', 8)      // the callsign field's search: [{ call, name, qth, from }]
//   calls.official('OE1EBG')      // the Austrian list alone: { entry: [call, name, qth] | null,
//                                 //   base, isOE, enabled, stand }  (typo warnings)
//   calls.label('OE1EBG')         // "Name, QTH" for printouts, '' when unknown
//
// Rules the tools rely on: "listed" for the typo warning means the Austrian
// list only (official()); the merged answer comes from every list that is
// switched on, in the order of the lists. `version()` changes with every
// rebuild (cache key for rendered rows); `onChange` fires after each one.
//
// Top-level names start with "callsign" (the single-file bundles share one
// scope with the tools' own modules).

import { buildCallbook, lookupCall } from './callbook.js';
import { loadDataFile } from './data.js';
import { tx, setUiLang } from './i18n.js';
import { buildCallsignDirectory, CALLSIGN_BUILTIN_ID } from './callsign-merge.js';
import { openCallsignStorage, ensureBuiltinSource, loadCallsignStore } from './callsign-store.js';

export const callsignBuiltinName = () => tx('Austrian callsign list (Fernmeldebüro)', 'Österreichische Rufzeichenliste (Fernmeldebüro)');

// A change anywhere shows in this: which lists exist, their order, switches
// and generations.
const callsignSignature = sources => sources
  .map(s => `${s.id}:${s.updated}:${s.gen}:${s.rank}:${s.enabled}:${s.deleted}`).sort().join('|');

export function createCallsignService({
  getLang = () => 'de', onChange = null,
  openStore = openCallsignStorage,
  loadBook = () => loadDataFile('callsigns-oe.json'),
} = {}) {
  let store = null;
  let sources = [];
  let records = [];
  let book = null;
  let dir = null;
  let version = 0;
  let signature = '';
  const listeners = new Set(onChange ? [onChange] : []);

  const lang = () => setUiLang(getLang());

  // notify: false for the first build, made while the tool's own state may
  // not exist yet (nothing has changed for anyone to hear about).
  function rebuild(notify = true) {
    lang();
    const srcs = store
      ? sources.map(s => (s.id === CALLSIGN_BUILTIN_ID ? { ...s, name: callsignBuiltinName() } : s))
      : [{ id: CALLSIGN_BUILTIN_ID, kind: 'builtin', name: callsignBuiltinName(), enabled: true, rank: 1000, gen: 1 }];
    dir = buildCallsignDirectory({ sources: srcs, records: store ? records : [], callbook: book });
    version++;
    if (!notify) return;
    for (const fn of listeners) {
      try { fn(); } catch (e) { console.warn(e); }
    }
  }

  // The directory exists from the start: the Austrian list alone, empty
  // until the list is loaded.
  rebuild(false);

  async function load() {
    ({ sources, records } = await loadCallsignStore(store));
    signature = callsignSignature(sources);
  }

  async function init() {
    try {
      const data = await loadBook();
      book = data ? buildCallbook(data) : null;
    } catch (e) {
      console.warn('Rufzeichenliste nicht geladen', e);
      book = null;
    }
    try {
      const s = await openStore();
      if (!s) throw new Error('no IndexedDB');
      lang();
      await ensureBuiltinSource(s, callsignBuiltinName());
      store = s;
      await load();
    } catch (e) {
      console.warn('Eigene Rufzeichenlisten nicht verfügbar', e);
      store = null;
    }
    rebuild();
  }

  // After a change made here (the dialog): read everything again.
  async function reload() {
    if (!store) return;
    await load();
    rebuild();
  }

  // A change made elsewhere (another tab, tool or the Wavelog import): read
  // again only if the lists differ from what this service has.
  async function refresh() {
    if (!store) return false;
    try {
      const now = await store.getAll('sources');
      if (callsignSignature(now) === signature) return false;
      await reload();
      return true;
    } catch (e) {
      console.warn('Rufzeichenlisten nicht aktualisiert', e);
      return false;
    }
  }

  // Refresh when the window or tab is looked at again.
  function watchFocus() {
    const onVisible = () => { if (document.visibilityState === 'visible') refresh(); };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }

  function entry(call) {
    const m = dir.lookup(call);
    if (!m) return null;
    // the list to name next to the value: only when it is not the Austrian one
    const main = m.name ? 'name' : m.qth ? 'qth' : null;
    const source = main ? (m.fromKind[main] === 'builtin' ? '' : m.from[main]) : (m.notes.length ? m.notes[0].source : '');
    return {
      call: m.base, source, name: m.name, qth: m.qth, grid: m.grid,
      note: m.notes.length ? m.notes[0].text : '', notes: m.notes,
      from: m.from, fromKind: m.fromKind,
      qthOfficial: m.fromKind.qth === 'builtin',
      official: m.official, entries: m.entries,
    };
  }

  // The Austrian list alone, whatever other lists say: what the typo
  // warning is about. enabled is false when the list is switched off or
  // not loaded; then nothing may be concluded from `entry: null`.
  function official(call) {
    const enabled = dir.official.enabled;
    const r = lookupCall(book, call);
    return { entry: enabled ? r.entry : null, base: r.base, isOE: r.isOE, enabled, stand: enabled ? book.stand : '' };
  }

  return {
    init, reload, refresh, watchFocus,
    // After a language change: the built-in list's name
    relabel: () => rebuild(),
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    store: () => store,
    sources: () => sources,
    records: () => records,
    callbook: () => book,
    available: () => !!store,
    directory: () => dir,
    version: () => version,
    lookup: call => dir.lookup(call),
    entry,
    has: call => dir.has(call),
    search: (text, max = 8) => dir.search(text, max),
    official,
    stand: () => dir.official.stand,
    label(call) {
      const m = dir.lookup(call);
      return m ? [m.name, m.qth].filter(Boolean).join(', ') : '';
    },
    // How many lists exist and are switched on (without the store: the
    // Austrian list alone).
    summary() {
      if (!store) return { available: false, active: 1, total: 1 };
      const visible = sources.filter(s => !s.deleted);
      return { available: true, active: visible.filter(s => s.enabled !== false).length, total: visible.length };
    },
  };
}
