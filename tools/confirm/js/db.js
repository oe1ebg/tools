// Persistent storage for the confirmation log. IndexedDB normally; a
// localStorage fallback for browsers that refuse IndexedDB (e.g. some
// file:// setups of confirm-offline.html). Both expose the same small API:
//
//   getAll(store) / getByEvent(store, eventId) / get(store, key)
//   tx([{ store, put: value } | { store, del: key }, ...])  — one atomic write
//
// Stores: events, entries, revisions (old versions of edited lines),
// drafts (keyed by eventId: the half-typed line), snapshots (periodic full
// backups of an event). Nothing user-entered is ever hard-deleted: lines and
// events are soft-deleted via a `deleted` timestamp; only drafts and
// rotated-out snapshots are actually removed.

const DB_NAME = 'oe1ebg-confirm';
const DB_VERSION = 1;
const LS_PREFIX = 'oe1ebg-confirm:v1:';

export const STORES = {
  events: { keyPath: 'id', byEvent: false },
  entries: { keyPath: 'id', byEvent: true },
  revisions: { keyPath: 'id', byEvent: true },
  drafts: { keyPath: 'eventId', byEvent: false },
  snapshots: { keyPath: 'id', byEvent: true },
};

function reqPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function openIdb() {
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (e) {
      reject(e);
      return;
    }
    // Schema migrations: add a branch per version, never drop user data.
    req.onupgradeneeded = ev => {
      const db = req.result;
      if (ev.oldVersion < 1) {
        for (const [name, def] of Object.entries(STORES)) {
          const os = db.createObjectStore(name, { keyPath: def.keyPath });
          if (def.byEvent) os.createIndex('eventId', 'eventId');
        }
      }
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

function lsBackend() {
  const key = (store, k) => `${LS_PREFIX}${store}:${k}`;
  function all(store) {
    const out = [];
    const prefix = `${LS_PREFIX}${store}:`;
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(prefix)) out.push(JSON.parse(localStorage.getItem(k)));
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
        const kp = STORES[o.store].keyPath;
        if ('put' in o) localStorage.setItem(key(o.store, o.put[kp]), JSON.stringify(o.put));
        else localStorage.removeItem(key(o.store, o.del));
      }
    },
  };
}

export async function openStorage() {
  if (globalThis.indexedDB) {
    try {
      const db = await openIdb();
      return idbBackend(db);
    } catch (e) {
      console.warn('IndexedDB nicht verfügbar, verwende localStorage', e);
    }
  }
  try {
    localStorage.setItem(LS_PREFIX + 'probe', '1');
    localStorage.removeItem(LS_PREFIX + 'probe');
    return lsBackend();
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
