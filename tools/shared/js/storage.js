// Persistent storage for the offline tools. IndexedDB normally; a
// localStorage fallback for browsers that refuse IndexedDB (e.g. some
// file:// setups of the single-file bundles). Both expose the same small API:
//
//   getAll(store) / getByEvent(store, eventId) / get(store, key)
//   tx([{ store, put: value } | { store, del: key }, ...])  — one atomic write
//
// Each tool passes its own schema (database name, version, stores and the
// migration steps), see openToolStorage(). "Event" is whatever the tool's
// records belong to (a net, an operation); stores with `byEvent: true` get
// an `eventId` index.

function reqPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function openIdb(schema) {
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = indexedDB.open(schema.name, schema.version);
    } catch (e) {
      reject(e);
      return;
    }
    // Schema migrations: schema.upgrade() adds a branch per version and
    // must never drop user data.
    req.onupgradeneeded = ev => {
      const db = req.result;
      const create = name => {
        const def = schema.stores[name];
        const os = db.createObjectStore(name, { keyPath: def.keyPath });
        if (def.byEvent) os.createIndex('eventId', 'eventId');
      };
      schema.upgrade(ev.oldVersion, create);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Datenbank ist in einem anderen Tab blockiert'));
  });
}

function idbBackend(db) {
  return {
    kind: 'indexeddb',
    async getAll(store) {
      return reqPromise(db.transaction(store).objectStore(store).getAll());
    },
    async getByEvent(store, eventId) {
      return reqPromise(db.transaction(store).objectStore(store).index('eventId').getAll(eventId));
    },
    async get(store, key) {
      return reqPromise(db.transaction(store).objectStore(store).get(key));
    },
    tx(ops) {
      const names = [...new Set(ops.map(o => o.store))];
      return new Promise((resolve, reject) => {
        // "strict": the promise only resolves once the data is flushed to
        // disk, so "gespeichert" in the UI really means saved.
        const t = db.transaction(names, 'readwrite', { durability: 'strict' });
        for (const o of ops) {
          const os = t.objectStore(o.store);
          if ('put' in o) os.put(o.put);
          else os.delete(o.del);
        }
        t.oncomplete = () => resolve();
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error || new Error('Transaktion abgebrochen'));
      });
    },
  };
}

function lsBackend(schema) {
  const prefix = schema.lsPrefix;
  const key = (store, k) => `${prefix}${store}:${k}`;
  function all(store) {
    const out = [];
    const p = `${prefix}${store}:`;
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(p)) out.push(JSON.parse(localStorage.getItem(k)));
    }
    return out;
  }
  return {
    kind: 'localstorage',
    async getAll(store) { return all(store); },
    async getByEvent(store, eventId) { return all(store).filter(r => r.eventId === eventId); },
    async get(store, k) {
      const v = localStorage.getItem(key(store, k));
      return v === null ? undefined : JSON.parse(v);
    },
    async tx(ops) {
      // Not atomic across ops, but each setItem is synchronous and durable;
      // a QuotaExceededError propagates to the caller like an IDB failure.
      for (const o of ops) {
        const kp = schema.stores[o.store].keyPath;
        if ('put' in o) localStorage.setItem(key(o.store, o.put[kp]), JSON.stringify(o.put));
        else localStorage.removeItem(key(o.store, o.del));
      }
    },
  };
}

// schema: {
//   name, version          IndexedDB database name and version
//   lsPrefix               key prefix of the localStorage fallback
//   stores: { name: { keyPath, byEvent } }
//   upgrade(oldVersion, create)   called on IndexedDB upgrades; create(name)
//                                 creates a store from `stores`
// }
// Resolves to the backend, or null when neither IndexedDB nor localStorage
// is usable.
export async function openToolStorage(schema) {
  if (globalThis.indexedDB) {
    try {
      const db = await openIdb(schema);
      return idbBackend(db);
    } catch (e) {
      console.warn('IndexedDB nicht verfügbar, verwende localStorage', e);
    }
  }
  try {
    localStorage.setItem(schema.lsPrefix + 'probe', '1');
    localStorage.removeItem(schema.lsPrefix + 'probe');
    return lsBackend(schema);
  } catch {
    return null;
  }
}

// Ask the browser not to evict our data under storage pressure.
export async function requestPersistence() {
  if (!navigator.storage || !navigator.storage.persist) return 'unsupported';
  try {
    if (await navigator.storage.persisted()) return 'persisted';
    return (await navigator.storage.persist()) ? 'persisted' : 'denied';
  } catch {
    return 'unsupported';
  }
}
