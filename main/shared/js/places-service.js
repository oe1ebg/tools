// The named places of the user (issue #181) for a tool: opens the shared
// place store, keeps the places of the active lists in memory and answers
// the location field synchronously. No DOM (the dialog that manages the
// lists is placelists.js, on top of this). Before init() finishes, or
// without IndexedDB, there are no places and the lookups answer nothing.
//
//   const places = createPlacesService({ onChange });
//   await places.init();          // opens the store (not fatal)
//   places.watchFocus();          // pick up changes made in another tab/tool
//   places.search('Lichtinsel', 5)  // location results (places.js placesResult())
//   places.resolve('LI 12')       // the place named exactly so, or null
//
// Top-level names start with "places" (single-file bundles).

import { placesIndex, placesSearch, placesResolve } from './places.js';
import { openPlacesStorage, loadPlacesStore, placesActive } from './places-store.js';

const placesSignature = lists => lists.map(l => `${l.id}:${l.updated}:${l.gen}:${l.deleted}`).sort().join('|');

export function createPlacesService({ onChange = null, openStore = openPlacesStorage } = {}) {
  let store = null;
  let lists = [];
  let all = [];
  let active = [];
  let index = [];
  let signature = '';
  let version = 0;
  const listeners = new Set(onChange ? [onChange] : []);

  function rebuild() {
    active = placesActive(lists, all);
    index = placesIndex(active);
    version++;
    for (const fn of listeners) {
      try { fn(); } catch (e) { console.warn(e); }
    }
  }

  async function load() {
    ({ lists, places: all } = await loadPlacesStore(store));
    signature = placesSignature(lists);
  }

  async function init() {
    try {
      const s = await openStore();
      if (!s) throw new Error('no IndexedDB');
      store = s;
      await load();
    } catch (e) {
      console.warn('Ortslisten nicht verfügbar', e);
      store = null;
    }
    rebuild();
  }

  async function reload() {
    if (!store) return;
    await load();
    rebuild();
  }

  // A change made elsewhere: read again only if the lists differ.
  async function refresh() {
    if (!store) return false;
    try {
      if (placesSignature(await store.getAll('lists')) === signature) return false;
      await reload();
      return true;
    } catch (e) {
      console.warn('Ortslisten nicht aktualisiert', e);
      return false;
    }
  }

  function watchFocus() {
    const onVisible = () => { if (document.visibilityState === 'visible') refresh(); };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }

  return {
    init, reload, refresh, watchFocus,
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    store: () => store,
    available: () => !!store,
    version: () => version,
    lists: () => lists,
    // the places of a list as it is now (also of a deleted one)
    placesOf(id) {
      const l = lists.find(x => x.id === id);
      return l ? all.filter(p => p.list === id && p.gen === l.gen) : [];
    },
    active: () => active,
    search: (text, max = 5) => placesSearch(index, text, max),
    resolve: text => placesResolve(index, text),
    summary() {
      const live = lists.filter(l => !l.deleted);
      return { available: !!store, lists: live.length, places: active.length };
    },
  };
}
