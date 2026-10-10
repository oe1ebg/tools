// Persistent storage for the offline tools. IndexedDB normally; a
// localStorage fallback for browsers that refuse IndexedDB (e.g. some
// file:// setups of the single-file bundles). Both expose the same small API:
//
//   getAll(store) / getByEvent(store, eventId) / get(store, key)
//   tx([{ store, put: value } | { store, del: key }, ...])  — one atomic write
//   atomic(stores, async ({ get, getByEvent, getUnchanged, put }) => result)
//       — read-modify-write in ONE transaction (e.g. take the next message
//         number and store the message): nothing is written unless all of
//         it is, and no other writer can interleave. Inside fn only await
//         the get/getByEvent/getUnchanged it is given (any other await lets
//         IndexedDB auto-commit; the next put then fails and the whole call
//         rejects).
//   getUnchanged(store, key, expectedUpdated) — compare-and-set: the record
//         as stored, or a ConflictError when its `updated` is no longer
//         expectedUpdated (see assertUnchanged()).
//
// Guarantees per backend, the open hooks (blocked, versionchange) and the
// migration of fallback records are documented in ../README.md
// ("Storage contract"). Each tool passes its own schema (database name,
// version, stores and the migration steps), see openToolStorage(). "Event"
// is whatever the tool's records belong to (a net, an operation); stores
// with `byEvent: true` get an `eventId` index.

// A record changed since the caller read it (compare-and-set failed).
// `expected` is the `updated` the caller saw (undefined: "must not exist"),
// `actual` the stored one (undefined: no record), `current` the record.
export class ConflictError extends Error {
  constructor(store, key, expected, current) {
    super(`Datensatz wurde inzwischen geändert (${store} ${key})`);
    this.name = 'ConflictError';
    this.store = store;
    this.key = key;
    this.expected = expected;
    this.actual = current === undefined ? undefined : (current.updated ?? null);
    this.current = current;
  }
}

// The connection is gone (another tab upgraded the database, or the
// browser closed it): nothing can be saved until the page is reloaded.
export class StorageClosedError extends Error {
  constructor(reason) {
    super('Datenbank geschlossen (anderer Tab mit neuerer Version?) – bitte Seite neu laden');
    this.name = 'StorageClosedError';
    this.reason = reason;
  }
}

// Compare-and-set check: throws a ConflictError unless current (the record
// as just read, or undefined) still has the `updated` the caller saw.
// expectedUpdated undefined means "the record must not exist yet".
export function assertUnchanged(store, key, current, expectedUpdated) {
  const actual = current === undefined ? undefined : (current.updated ?? null);
  if (actual !== expectedUpdated) throw new ConflictError(store, key, expectedUpdated, current);
  return current;
}

function storageApiWithCas(api) {
  api.getUnchanged = async (store, key, expectedUpdated) =>
    assertUnchanged(store, key, await api.get(store, key), expectedUpdated);
  return api;
}

function reqPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function storageDataError(message) {
  return typeof DOMException === 'function' ? new DOMException(message, 'DataError')
    : Object.assign(new Error(message), { name: 'DataError' });
}

// No answer at all (neither success, error, upgrade nor blocked) within
// this time: IndexedDB counts as unavailable (old Safari could hang on the
// first open). A blocked open waits instead, however long it takes.
const IDB_OPEN_TIMEOUT_MS = 10000;

function openIdb(schema, hooks) {
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = indexedDB.open(schema.name, schema.version);
    } catch (e) {
      reject(e);
      return;
    }
    let settled = false;
    let timer = 0;
    const settle = (fn, value) => {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      fn(value);
      return true;
    };
    const timeout = hooks.openTimeout ?? IDB_OPEN_TIMEOUT_MS;
    if (timeout > 0) {
      timer = setTimeout(() => {
        const e = new Error('IndexedDB antwortet nicht');
        e.name = 'TimeoutError';
        settle(reject, e);
      }, timeout);
    }
    // Schema migrations: schema.upgrade() adds a branch per version and
    // must never drop user data.
    req.onupgradeneeded = ev => {
      clearTimeout(timer); // upgrading: it answers, give it the time it needs
      const db = req.result;
      const create = name => {
        const def = schema.stores[name];
        const os = db.createObjectStore(name, { keyPath: def.keyPath });
        if (def.byEvent) os.createIndex('eventId', 'eventId');
      };
      schema.upgrade(ev.oldVersion, create);
    };
    // A success after the timeout (we already went on without IndexedDB)
    // closes the connection again, so it never blocks a later upgrade.
    req.onsuccess = () => {
      const db = req.result;
      if (!settle(resolve, db)) db.close();
    };
    req.onerror = () => settle(reject, req.error);
    // Another tab still holds an older version open: wait for it (the open
    // goes on by itself once that tab closes or reloads), tell the app why.
    req.onblocked = ev => {
      clearTimeout(timer);
      if (settled) return;
      if (!hooks.onBlocked) console.warn('IndexedDB: wartet auf einen anderen Tab mit älterer Version');
      try {
        hooks.onBlocked?.({ oldVersion: ev.oldVersion, newVersion: ev.newVersion });
      } catch (e) {
        console.error(e);
      }
    };
  });
}

function idbBackend(db, schema, hooks) {
  let closed = null;
  const close = reason => {
    if (closed) return;
    closed = reason;
    try {
      hooks.onClosed?.({ reason });
    } catch (e) {
      console.error(e);
    }
  };
  // Another tab wants to upgrade the database: let it (an open connection
  // would block it), and tell the app that this page must be reloaded.
  db.onversionchange = () => {
    db.close();
    close('versionchange');
  };
  db.onclose = () => close('closed');
  const trans = (names, mode, opts) => {
    if (closed) throw new StorageClosedError(closed);
    return db.transaction(names, mode, opts);
  };
  const ro = store => trans(store).objectStore(store);
  const backend = {
    kind: 'indexeddb',
    async getAll(store) {
      return reqPromise(ro(store).getAll());
    },
    async getByEvent(store, eventId) {
      return reqPromise(ro(store).index('eventId').getAll(eventId));
    },
    async get(store, key) {
      return reqPromise(ro(store).get(key));
    },
    tx(ops) {
      if (!ops.length) return Promise.resolve();
      const names = [...new Set(ops.map(o => o.store))];
      return new Promise((resolve, reject) => {
        let t;
        try {
          // "strict": the promise only resolves once the data is flushed to
          // disk, so "gespeichert" in the UI really means saved.
          t = trans(names, 'readwrite', { durability: 'strict' });
        } catch (e) {
          reject(e);
          return;
        }
        let failed = null;
        // Outcome handlers first, then the requests. A request that can't
        // even be created (e.g. a record without its key: DataError) aborts
        // the whole transaction, so the earlier puts are not committed, and
        // the caller gets that error, not the AbortError.
        t.oncomplete = () => resolve();
        t.onabort = () => reject(failed || t.error || new Error('Transaktion abgebrochen'));
        try {
          for (const o of ops) {
            const os = t.objectStore(o.store);
            if ('put' in o) os.put(o.put);
            else os.delete(o.del);
          }
        } catch (e) {
          failed = e;
          try { t.abort(); } catch { /* already finished */ }
        }
      });
    },
    atomic(names, fn) {
      return new Promise((resolve, reject) => {
        let t;
        try {
          t = trans(names, 'readwrite', { durability: 'strict' });
        } catch (e) {
          reject(e);
          return;
        }
        let result;
        let failed = null;
        let fnDone = false;
        let committed = false;
        const fail = e => {
          if (!failed) failed = e;
          try { t.abort(); } catch { /* already finished */ }
        };
        // Resolves only when fn has finished AND the transaction committed.
        t.oncomplete = () => {
          committed = true;
          if (fnDone) (failed ? reject(failed) : resolve(result));
        };
        t.onabort = () => reject(failed || t.error || new Error('Transaktion abgebrochen'));
        const api = storageApiWithCas({
          get: (store, key) => reqPromise(t.objectStore(store).get(key)),
          getByEvent: (store, eventId) => reqPromise(t.objectStore(store).index('eventId').getAll(eventId)),
          put: (store, value) => {
            try {
              t.objectStore(store).put(value);
            } catch (e) {
              fail(e);
              throw e;
            }
          },
        });
        Promise.resolve().then(() => fn(api)).then(r => {
          result = r;
          fnDone = true;
          if (committed) (failed ? reject(failed) : resolve(result));
        }, e => {
          fnDone = true;
          fail(e);
          // fn awaited something else and IndexedDB committed meanwhile:
          // the call still fails (the contract above was broken).
          if (committed) reject(failed);
        });
      });
    },
    // Records left in the localStorage fallback (a session that ran
    // without IndexedDB): { total, stores: { name: count }, journal } or
    // null when there are none.
    async fallbackData() {
      const ls = storageLocal();
      return ls ? lsCore(schema, ls, hooks.locks).summary() : null;
    },
    // Those records of one store (e.g. to export them before deciding).
    async readFallback(store) {
      const ls = storageLocal();
      return ls ? lsCore(schema, ls, hooks.locks).all(store) : [];
    },
    // Copies the fallback records into IndexedDB, see migrateFallback().
    migrateFallback() {
      const ls = storageLocal();
      if (!ls) return Promise.resolve({ copied: 0, merged: 0, identical: 0, kept: [] });
      return migrateFallbackRecords(backend, schema, lsCore(schema, ls, hooks.locks));
    },
  };
  return backend;
}

function storageLocal() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

function sameRecord(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// Fallback -> IndexedDB, under the fallback's write lock (no tab on the
// fallback writes meanwhile) and in one IndexedDB transaction:
// - an unfinished fallback batch is rolled back first;
// - a record IndexedDB doesn't have is copied;
// - one it has with the same content counts as identical;
// - a different one goes to schema.merge(store, current, incoming) if the
//   schema has it (its result is stored; undefined: no merge), otherwise
//   it is KEPT: IndexedDB is not overwritten, the record stays in
//   localStorage and is reported in `kept` ({ store, key, reason }).
// Only after IndexedDB committed are the copied, merged and identical
// records removed from localStorage; kept or unreadable ones stay.
async function migrateFallbackRecords(backend, schema, core) {
  return core.exclusive(async () => {
    core.recover(!core.lockless);
    const kept = [];
    const plan = [];
    for (const store of Object.keys(schema.stores)) {
      for (const { lsKey, value, error } of core.entries(store)) {
        if (error) kept.push({ store, key: lsKey, reason: 'unreadable' });
        else plan.push({ store, lsKey, value });
      }
    }
    const stores = [...new Set(plan.map(p => p.store))];
    const done = { copied: [], merged: [], identical: [] };
    if (stores.length) {
      await backend.atomic(stores, async ({ get, put }) => {
        for (const p of plan) {
          const key = p.value[schema.stores[p.store].keyPath];
          const cur = await get(p.store, key);
          if (cur === undefined) {
            put(p.store, p.value);
            done.copied.push(p.lsKey);
          } else if (sameRecord(cur, p.value)) {
            done.identical.push(p.lsKey);
          } else {
            const merged = schema.merge ? schema.merge(p.store, cur, p.value) : undefined;
            if (merged === undefined) {
              kept.push({ store: p.store, key, reason: 'conflict' });
            } else {
              put(p.store, merged);
              done.merged.push(p.lsKey);
            }
          }
        }
      });
    }
    for (const k of [...done.copied, ...done.merged, ...done.identical]) core.ls.removeItem(k);
    return { copied: done.copied.length, merged: done.merged.length, identical: done.identical.length, kept };
  });
}

// localStorage fallback. Records are `<prefix><store>:<key>` = JSON.
//
// Writes go through one write lock per tool (Web Locks, name
// `<prefix>write`, shared by all tabs and instances of this origin), so
// tx() and atomic() never interleave with another writer. Without Web
// Locks (node, and browsers that lack them) the lock is a queue per
// instance only: other tabs are then not excluded.
//
// A batch is all-or-nothing through an undo journal (`<prefix>#journal`,
// one setItem): it records the old value of every key the batch touches,
// then the keys are written, then the journal is removed. A failing write
// (QuotaExceededError mid-way) restores the old values and rejects; a
// journal found later (the tab died mid-batch) is rolled back the same
// way, before the next write and when the storage is opened.
function lsCore(schema, ls, locks) {
  const prefix = schema.lsPrefix;
  const journalKey = `${prefix}#journal`;
  const lockName = `${prefix}write`;
  const key = (store, k) => `${prefix}${store}:${k}`;
  const lockless = !(locks && typeof locks.request === 'function');
  let queue = Promise.resolve();
  const core = {
    ls,
    lockless,
    exclusive(fn) {
      if (!lockless) return locks.request(lockName, () => fn());
      const p = queue.then(fn, fn);
      queue = p.catch(() => {});
      return p;
    },
    // [{ lsKey, value } | { lsKey, error }] of one store
    entries(store) {
      const out = [];
      const p = `${prefix}${store}:`;
      for (let i = 0; i < ls.length; i++) {
        const k = ls.key(i);
        if (!k || !k.startsWith(p)) continue;
        try {
          out.push({ lsKey: k, value: JSON.parse(ls.getItem(k)) });
        } catch (error) {
          out.push({ lsKey: k, error });
        }
      }
      return out;
    },
    all(store) {
      return core.entries(store).filter(e => !e.error).map(e => e.value);
    },
    get(store, k) {
      const v = ls.getItem(key(store, k));
      return v === null ? undefined : JSON.parse(v);
    },
    summary() {
      const stores = {};
      let total = 0;
      for (const store of Object.keys(schema.stores)) {
        const n = core.entries(store).length;
        if (n) stores[store] = n;
        total += n;
      }
      const journal = ls.getItem(journalKey) !== null;
      return total || journal ? { total, stores, journal } : null;
    },
    // Rolls an unfinished batch back. `owned`: we hold the write lock, so
    // any journal is orphaned. Without Web Locks another tab may be in the
    // middle of its batch: then only a journal older than a minute counts.
    recover(owned) {
      const raw = ls.getItem(journalKey);
      if (raw === null) return null;
      let j = null;
      try { j = JSON.parse(raw); } catch { /* unreadable: nothing to undo */ }
      if (j && lockless && !owned && Date.now() - (j.at || 0) < 60000) return null;
      const changes = j && Array.isArray(j.changes) ? j.changes.filter(c => typeof c.k === 'string' && c.k.startsWith(prefix)) : [];
      core.restore(changes);
      ls.removeItem(journalKey);
      return { rolledBack: changes.length };
    },
    restore(changes) {
      for (const c of [...changes].reverse()) {
        if (c.before === null) ls.removeItem(c.k);
        else ls.setItem(c.k, c.before);
      }
    },
    // Synchronous from the journal to its removal: nothing else of this
    // tab runs in between.
    apply(ops) {
      // Keys and values first: a record without its key or one that
      // can't be serialised fails before anything is written.
      const changes = ops.map(o => {
        const def = schema.stores[o.store];
        if (!def) throw new Error(`Unbekannter Speicherbereich: ${o.store}`);
        if ('put' in o) {
          const k = o.put?.[def.keyPath];
          if (k === undefined || k === null) throw storageDataError(`Datensatz ohne Schlüssel ${def.keyPath} (${o.store})`);
          return { k: key(o.store, k), after: JSON.stringify(o.put) };
        }
        return { k: key(o.store, o.del), after: null };
      });
      if (!changes.length) return;
      core.recover(!lockless);
      const journal = changes.map(c => ({ k: c.k, before: ls.getItem(c.k) }));
      ls.setItem(journalKey, JSON.stringify({ at: Date.now(), changes: journal }));
      try {
        for (const c of changes) {
          if (c.after === null) ls.removeItem(c.k);
          else ls.setItem(c.k, c.after);
        }
      } catch (e) {
        try {
          core.restore(journal);
          ls.removeItem(journalKey);
        } catch { /* the journal stays and is rolled back later */ }
        throw e;
      }
      ls.removeItem(journalKey);
    },
  };
  return core;
}

function lsBackend(schema, ls, locks) {
  const core = lsCore(schema, ls, locks);
  return {
    kind: 'localstorage',
    // false: the write lock is per instance only (no Web Locks), so other
    // tabs are not excluded.
    crossTabLock: !core.lockless,
    async getAll(store) { return core.all(store); },
    async getByEvent(store, eventId) { return core.all(store).filter(r => r.eventId === eventId); },
    async get(store, k) { return core.get(store, k); },
    tx(ops) {
      return core.exclusive(async () => core.apply(ops));
    },
    // Under the write lock: fn reads the current records, its puts are
    // buffered and written as one batch only if fn succeeds.
    atomic(names, fn) {
      return core.exclusive(async () => {
        const writes = [];
        const api = storageApiWithCas({
          get: async (store, k) => core.get(store, k),
          getByEvent: async (store, eventId) => core.all(store).filter(r => r.eventId === eventId),
          put: (store, value) => { writes.push({ store, put: value }); },
        });
        const result = await fn(api);
        core.apply(writes);
        return result;
      });
    },
    recover() {
      return core.exclusive(async () => core.recover(!core.lockless));
    },
    async fallbackData() { return null; },
    async readFallback() { return []; },
    async migrateFallback() { return { copied: 0, merged: 0, identical: 0, kept: [] }; },
  };
}

// schema: {
//   name, version          IndexedDB database name and version
//   lsPrefix               key prefix of the localStorage fallback
//   stores: { name: { keyPath, byEvent } }
//   upgrade(oldVersion, create)   called on IndexedDB upgrades; create(name)
//                                 creates a store from `stores`
//   merge(store, current, incoming)   optional, for migrateFallback()
// }
// hooks (all optional):
//   onBlocked({ oldVersion, newVersion })  the open waits for another tab
//                          that holds an older version open
//   onClosed({ reason })   'versionchange' (another tab upgrades; this
//                          connection was closed for it) or 'closed' (the
//                          browser closed it); every later call rejects with
//                          a StorageClosedError — the page must reload
//   openTimeout            ms without any answer before IndexedDB counts as
//                          unavailable (default 10 s; 0: wait forever)
//   locks                  a LockManager instead of navigator.locks (tests;
//                          null: none)
// Resolves to the backend, or null when neither IndexedDB nor localStorage
// is usable. A localStorage backend carries `fallbackReason` (why
// IndexedDB was not used) and `recovery` (an unfinished batch rolled back
// on open: { rolledBack }, or null).
export async function openToolStorage(schema, hooks = {}) {
  const opts = { ...hooks, locks: 'locks' in hooks ? hooks.locks : globalThis.navigator?.locks };
  let reason = new Error('IndexedDB wird nicht unterstützt');
  if (globalThis.indexedDB) {
    try {
      const db = await openIdb(schema, opts);
      return idbBackend(db, schema, opts);
    } catch (e) {
      console.warn('IndexedDB nicht verfügbar, verwende localStorage', e);
      reason = e;
    }
  }
  let backend;
  try {
    const ls = globalThis.localStorage;
    ls.setItem(schema.lsPrefix + 'probe', '1');
    ls.removeItem(schema.lsPrefix + 'probe');
    backend = lsBackend(schema, ls, opts.locks);
  } catch {
    return null;
  }
  backend.fallbackReason = reason;
  try {
    backend.recovery = await backend.recover();
  } catch (e) {
    // the journal stays; the next write tries again
    console.warn('Ersatzspeicher: unvollständige Speicherung nicht zurückgerollt', e);
    backend.recovery = { error: e };
  }
  return backend;
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
