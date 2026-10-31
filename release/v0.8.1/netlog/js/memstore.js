// An in-memory backend with the storage API of ../../shared/js/storage.js
// (getAll, getByEvent, get, tx, atomic): used when the browser offers no
// IndexedDB (the page then says that nothing is stored durably and offers
// an export), and by the node tests. atomic() works on a copy and applies
// it only when fn succeeds, so a failing op changes nothing. No DOM.

const copy = v => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

export function memoryStore(stores, { failWrites = null } = {}) {
  const data = new Map(Object.keys(stores).map(s => [s, new Map()]));
  const keyOf = (store, value) => value[stores[store].keyPath];
  const byEvent = (m, eventId) => [...m.values()].filter(v => v.eventId === eventId).map(copy);
  let queue = Promise.resolve();
  const backend = {
    kind: 'memory',
    // tests: a function (store, value) => error to throw on a put, or null
    failWrites,
    async getAll(store) { return [...data.get(store).values()].map(copy); },
    async getByEvent(store, eventId) { return byEvent(data.get(store), eventId); },
    async get(store, key) { return copy(data.get(store).get(key)); },
    tx(ops) {
      return backend.atomic([...new Set(ops.map(o => o.store))], api => {
        for (const o of ops) ('put' in o ? api.put(o.store, o.put) : api.del(o.store, o.del));
      });
    },
    // Writers are serialised like IndexedDB transactions.
    atomic(names, fn) {
      const run = async () => {
        const work = new Map(names.map(s => [s, new Map(data.get(s))]));
        const need = s => {
          if (!work.has(s)) throw new Error(`store ${s} not in this transaction`);
          return work.get(s);
        };
        const api = {
          get: async (s, k) => copy(need(s).get(k)),
          getAll: async s => [...need(s).values()].map(copy),
          getByEvent: async (s, e) => byEvent(need(s), e),
          put(s, v) {
            const err = backend.failWrites && backend.failWrites(s, v);
            if (err) throw err;
            const k = keyOf(s, v);
            if (k === undefined || k === null) throw Object.assign(new Error('no key'), { name: 'DataError' });
            need(s).set(k, copy(v));
          },
          del(s, k) { need(s).delete(k); },
        };
        const result = await fn(api);
        for (const [s, m] of work) data.set(s, m);
        return result;
      };
      const p = queue.then(run, run);
      queue = p.catch(() => {});
      return p;
    },
  };
  return backend;
}
