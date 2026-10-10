// Persistent storage for the offline tools. IndexedDB normally; a
// localStorage fallback for browsers that refuse IndexedDB (e.g. some
// file:// setups of the single-file bundles). Both expose the same small API:
//
//   getAll(store) / getByEvent(store, eventId) / get(store, key)
//   tx([{ store, put: value } | { store, del: key }, ...])  — one atomic write
//   atomic(stores, async ({ get, getAll, getByEvent, getUnchanged, put }) => result)
//       — read-modify-write in ONE transaction (e.g. take the next message
//         number and store the message): nothing is written unless all of
//         it is, and no other writer can interleave. Inside fn only await
//         the get/getAll/getByEvent/getUnchanged it is given (any other await lets
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

// The localStorage fallback can't write now: without Web Locks another tab
// keeps writing (its undo journal changed while we waited, see lsCore()).
export class StorageBusyError extends Error {
  constructor(journal) {
    super('Speicher wird gerade von einem anderen Tab benutzt – bitte gleich noch einmal versuchen');
    this.name = 'StorageBusyError';
    Object.defineProperty(this, 'journal', { value: journal });
  }
}

// Marks this page's own undo journals (see lsCore()).
const STORAGE_PAGE_ID = Math.random().toString(36).slice(2) + Date.now().toString(36);

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
          getAll: store => reqPromise(t.objectStore(store).getAll()),
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
    // without IndexedDB), or null when there are none:
    //   { total, pending, conflicts, unreadable, conflictsSeen, stores, journal }
    // pending: what migrateFallback() would resolve (copy, merge, or drop
    // as already identical); conflicts: records that differ from IndexedDB
    // and have no merge, unreadable: not JSON or without their key (both
    // kept by migrateFallback()); conflictsSeen: the app called
    // dismissConflicts() for exactly these kept records.
    async fallbackData() {
      const ls = storageLocal();
      if (!ls) return null;
      const core = lsCore(schema, ls, hooks);
      const sum = core.summary();
      if (!sum) return null;
      const plan = await planFallback(schema, core, (store, key) => backend.get(store, key), store => backend.getAll(store));
      const count = (...actions) => plan.filter(p => actions.includes(p.action)).length;
      const kept = count('conflict', 'unreadable');
      return {
        ...sum,
        pending: count('copy', 'merge', 'identical'),
        conflicts: count('conflict'),
        unreadable: count('unreadable'),
        // kept records by reason: { conflict, duplicate, parent, unreadable }
        reasons: plan.reduce((acc, p) => (p.reason ? { ...acc, [p.reason]: (acc[p.reason] || 0) + 1 } : acc), {}),
        conflictsSeen: kept > 0 && core.conflictsSeen() === conflictSignature(plan, core.ls),
      };
    },
    // Everything in the fallback, for a download: { stores: { name:
    // [records] }, unreadable: [{ key, raw }] } (raw: the stored string of
    // entries that aren't JSON).
    async exportFallback() {
      const ls = storageLocal();
      const out = { stores: {}, unreadable: [] };
      if (!ls) return out;
      const core = lsCore(schema, ls, hooks);
      for (const store of Object.keys(schema.stores)) {
        for (const e of core.entries(store)) {
          if (e.error) out.unreadable.push({ key: e.lsKey, raw: ls.getItem(e.lsKey) });
          else (out.stores[store] ||= []).push(e.value);
        }
      }
      return out;
    },
    // Remembers that the user has seen the current kept records (they
    // stay in localStorage; nothing is deleted).
    async dismissConflicts() {
      const ls = storageLocal();
      if (!ls) return;
      const core = lsCore(schema, ls, hooks);
      core.setConflictsSeen(conflictSignature(await planFallback(schema, core, (store, key) => backend.get(store, key), store => backend.getAll(store)), ls));
    },
    // Those records of one store (e.g. to export them before deciding).
    async readFallback(store) {
      const ls = storageLocal();
      return ls ? lsCore(schema, ls, hooks).all(store) : [];
    },
    // Copies the fallback records into IndexedDB, see migrateFallback().
    migrateFallback() {
      const ls = storageLocal();
      if (!ls) return Promise.resolve({ copied: 0, merged: 0, identical: 0, kept: [] });
      return migrateFallbackRecords(backend, schema, lsCore(schema, ls, hooks));
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

// Structural equality of two JSON-like records (key order doesn't matter).
function sameRecord(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a).filter(k => a[k] !== undefined);
  const kb = Object.keys(b).filter(k => b[k] !== undefined);
  if (ka.length !== kb.length) return false;
  return ka.every(k => Object.prototype.hasOwnProperty.call(b, k) && sameRecord(a[k], b[k]));
}

// What migrateFallbackRecords() does with each fallback record, given
// current(store, key) and all(store) from IndexedDB:
// [{ store, lsKey, key, value, action, reason }], action 'copy' |
// 'identical' | 'merge' (with `merged`) | 'conflict' | 'unreadable'.
// reason of a conflict: 'conflict' (differs from IndexedDB's record with
// that key, no merge), 'duplicate' (a unique value of schema.migration
// .unique is taken by another record) or 'parent' (the record it belongs
// to, schema.migration.parents, is neither in IndexedDB nor migrated).
async function planFallback(schema, core, current, all) {
  const plan = [];
  for (const store of Object.keys(schema.stores)) {
    for (const { lsKey, value, error } of core.entries(store)) {
      const key = error ? undefined : value?.[schema.stores[store].keyPath];
      if (key === undefined || key === null) {
        plan.push({ store, lsKey, key: lsKey, action: 'unreadable', reason: 'unreadable' });
        continue;
      }
      const cur = await current(store, key);
      if (cur === undefined) plan.push({ store, lsKey, key, value, action: 'copy' });
      else if (sameRecord(cur, value)) plan.push({ store, lsKey, key, value, action: 'identical' });
      else {
        const merged = schema.merge ? schema.merge(store, cur, value) : undefined;
        if (merged === undefined) plan.push({ store, lsKey, key, value, action: 'conflict', reason: 'conflict' });
        else plan.push({ store, lsKey, key, value, merged, action: 'merge' });
      }
    }
  }
  const rules = schema.migration || {};
  const uniques = Object.entries(rules.unique || {});
  const parents = rules.parents || {};
  const candidates = plan.filter(p => p.action === 'copy' || p.action === 'merge');
  if (!candidates.length || (!uniques.length && !Object.keys(parents).length)) return plan;
  const recOf = p => (p.action === 'merge' ? p.merged : p.value);
  // IndexedDB's unique values and parent lookups, read once.
  const stored = new Map();
  for (const [store, uniq] of uniques) {
    const keyPath = schema.stores[store].keyPath;
    const taken = new Map();
    for (const rec of await all(store)) for (const v of migrationUniqueValues(uniq, rec)) taken.set(v, rec[keyPath]);
    stored.set(store, taken);
  }
  const inDb = new Map();
  const existsInDb = async (store, key) => {
    const k = `${store}\u0000${key}`;
    if (!inDb.has(k)) inDb.set(k, (await current(store, key)) !== undefined);
    return inDb.get(k);
  };
  // Records of `set` whose unique value is already taken (IndexedDB first,
  // then the set in plan order).
  const duplicates = set => {
    const out = new Set();
    for (const [store, uniq] of uniques) {
      const taken = new Map(stored.get(store));
      for (const p of set) {
        if (p.store !== store) continue;
        const vals = migrationUniqueValues(uniq, recOf(p));
        if (vals.some(v => taken.has(v) && taken.get(v) !== p.key)) { out.add(p); continue; }
        for (const v of vals) taken.set(v, p.key);
      }
    }
    return out;
  };
  // Records of `set` whose parent is neither in IndexedDB nor in the set
  // (cascading: a dropped parent drops its children).
  const orphans = async set => {
    const out = new Set();
    for (let changed = true; changed;) {
      changed = false;
      for (const p of set) {
        if (out.has(p)) continue;
        for (const { store, key } of parents[p.store] || []) {
          const pk = key(recOf(p));
          if (pk === undefined || pk === null) continue;
          if (set.some(q => q.store === store && q.key === pk && !out.has(q))) continue;
          if (await existsInDb(store, pk)) continue;
          out.add(p);
          changed = true;
          break;
        }
      }
    }
    return out;
  };
  // Unique and parent checks depend on each other (a record dropped for
  // its parent frees its number for another one): iterate to a fixpoint,
  // then one final pass over what is left, so the result always holds.
  let parentKept = new Set();
  let dup = new Set();
  for (let i = 0; i < 20; i++) {
    dup = duplicates(candidates.filter(p => !parentKept.has(p)));
    const next = await orphans(candidates.filter(p => !dup.has(p)));
    const same = next.size === parentKept.size && [...next].every(p => parentKept.has(p));
    parentKept = next;
    if (same) break;
  }
  let writes = candidates.filter(p => !dup.has(p) && !parentKept.has(p));
  const lateDup = duplicates(writes);
  writes = writes.filter(p => !lateDup.has(p));
  const lateOrphans = await orphans(writes);
  for (const p of candidates) {
    if (dup.has(p) || lateDup.has(p)) keepFallbackRecord(p, 'duplicate');
    else if (parentKept.has(p) || lateOrphans.has(p)) keepFallbackRecord(p, 'parent');
  }
  return plan;
}

function migrationUniqueValues(uniq, rec) {
  return [].concat(uniq(rec) ?? []).filter(v => v !== null && v !== undefined).map(String);
}

function keepFallbackRecord(p, reason) {
  p.action = 'conflict';
  p.reason = reason;
}

// The plan of a migration without running it (tests, diagnostics): the
// fallback records in ls under schema.lsPrefix against IndexedDB given as
// current(store, key) / all(store). [{ store, key, action, reason }]
export async function planFallbackMigration(schema, ls, current, all) {
  const plan = await planFallback(schema, lsCore(schema, ls, { locks: null }), current, all);
  return plan.map(({ store, key, action, reason }) => ({ store, key, action, ...(reason ? { reason } : {}) }));
}

// A short hash of the kept records (conflicting or unreadable, FNV-1a), so
// a dismissal holds only for exactly those.
function conflictSignature(plan, ls) {
  const text = plan.filter(p => p.action === 'conflict' || p.action === 'unreadable')
    .map(p => `${p.lsKey}=${ls.getItem(p.lsKey)}`).sort().join('|');
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return `${text.length}:${h.toString(16)}`;
}

// Fallback -> IndexedDB, under the fallback's write lock (no tab on the
// fallback writes meanwhile) and in one IndexedDB transaction over all
// stores:
// - an unfinished fallback batch is rolled back first (or, while another
//   tab keeps writing without Web Locks, the call is refused);
// - a record IndexedDB doesn't have is copied, unless one of its unique
//   values is taken or its parent is missing (planFallback());
// - one it has with the same content (structurally) counts as identical;
// - a different one goes to schema.merge(store, current, incoming) if the
//   schema has it (its result is stored; undefined: no merge);
// - everything else is KEPT: IndexedDB is not overwritten, nothing is
//   renumbered, the record stays in localStorage and is reported in
//   `kept` ({ store, key, reason });
// - then schema.migration.fixup(api, migrated) may adjust IndexedDB in the
//   same transaction (e.g. counters never below a migrated number).
// Only after IndexedDB committed are the copied, merged and identical
// records removed from localStorage; kept or unreadable ones stay.
async function migrateFallbackRecords(backend, schema, core) {
  return core.exclusive(async () => {
    await core.settleJournalAsync();
    const stores = Object.keys(schema.stores);
    let plan = [];
    if (stores.some(st => core.entries(st).length)) {
      await backend.atomic(stores, async api => {
        plan = await planFallback(schema, core, api.get, api.getAll);
        const migrated = [];
        for (const p of plan) {
          if (p.action === 'copy') api.put(p.store, p.value);
          else if (p.action === 'merge') api.put(p.store, p.merged);
          else continue;
          migrated.push({ store: p.store, value: p.action === 'merge' ? p.merged : p.value });
        }
        if (migrated.length && schema.migration?.fixup) await schema.migration.fixup(api, migrated);
      });
    }
    const n = action => plan.filter(p => p.action === action).length;
    for (const p of plan) if (['copy', 'merge', 'identical'].includes(p.action)) core.ls.removeItem(p.lsKey);
    return {
      copied: n('copy'),
      merged: n('merge'),
      identical: n('identical'),
      kept: plan.filter(p => p.action === 'conflict' || p.action === 'unreadable')
        .map(p => ({ store: p.store, key: p.key, reason: p.reason })),
    };
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
// journal found later (the tab died mid-batch, or a rollback failed) is
// rolled back the same way, before the next write and when the storage is
// opened. A journal is never overwritten. Without Web Locks a journal of
// another tab may be live; another tab's batch is synchronous, so its
// journal lives for milliseconds: one that is still there, unchanged,
// after journalSettleMs (default 1.5 s) or is older than a minute is
// orphaned and rolled back (also after a crash and an immediate reload).
// Only a journal that keeps changing refuses the write (StorageBusyError).
const JOURNAL_SETTLE_MS = 1500;

function lsCore(schema, ls, opts = {}) {
  const locks = opts.locks;
  const settleMs = opts.journalSettleMs ?? JOURNAL_SETTLE_MS;
  const prefix = schema.lsPrefix;
  const journalKey = `${prefix}#journal`;
  const seenKey = `${prefix}#conflicts-seen`;
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
    // A journal of this page is never live (apply() is synchronous), so it
    // is a rollback that failed: roll it back now. Returns null (none),
    // { rolledBack } or { pending: true } (left alone: may be live).
    // stale: the journal as seen a while ago; still the same now: orphaned.
    recover(owned, stale) {
      const raw = ls.getItem(journalKey);
      if (raw === null) return null;
      let j = null;
      try { j = JSON.parse(raw); } catch { /* unreadable: nothing to undo */ }
      if (j && lockless && !owned && raw !== stale && j.page !== STORAGE_PAGE_ID
        && Date.now() - (j.at || 0) < 60000) return { pending: true, raw };
      const changes = j && Array.isArray(j.changes) ? j.changes.filter(c => typeof c.k === 'string' && c.k.startsWith(prefix)) : [];
      core.restore(changes);
      ls.removeItem(journalKey);
      return { rolledBack: changes.length };
    },
    // Before a write: no journal may be left, it would be overwritten and
    // its batch could never be undone. Returns what recover() did.
    settleJournal(stale) {
      const r = core.recover(!lockless, stale);
      if (r?.pending) throw new StorageBusyError(r.raw);
      return r;
    },
    // The same, waiting once for a journal that may be another tab's.
    async settleJournalAsync() {
      try {
        return core.settleJournal();
      } catch (e) {
        if (!(e instanceof StorageBusyError)) throw e;
        await new Promise(res => setTimeout(res, settleMs));
        return core.settleJournal(e.journal);
      }
    },
    conflictsSeen() {
      return ls.getItem(seenKey);
    },
    setConflictsSeen(signature) {
      ls.setItem(seenKey, signature);
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
      core.settleJournal();
      const journal = changes.map(c => ({ k: c.k, before: ls.getItem(c.k) }));
      ls.setItem(journalKey, JSON.stringify({ at: Date.now(), page: STORAGE_PAGE_ID, changes: journal }));
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

function lsBackend(schema, ls, opts) {
  const core = lsCore(schema, ls, opts);
  return {
    kind: 'localstorage',
    // false: the write lock is per instance only (no Web Locks), so other
    // tabs are not excluded.
    crossTabLock: !core.lockless,
    async getAll(store) { return core.all(store); },
    async getByEvent(store, eventId) { return core.all(store).filter(r => r.eventId === eventId); },
    async get(store, k) { return core.get(store, k); },
    tx(ops) {
      return core.exclusive(async () => {
        await core.settleJournalAsync();
        core.apply(ops);
      });
    },
    // Under the write lock: fn reads the current records, its puts are
    // buffered and written as one batch only if fn succeeds.
    atomic(names, fn) {
      return core.exclusive(async () => {
        await core.settleJournalAsync();
        const writes = [];
        const api = storageApiWithCas({
          get: async (store, k) => core.get(store, k),
          getAll: async store => core.all(store),
          getByEvent: async (store, eventId) => core.all(store).filter(r => r.eventId === eventId),
          put: (store, value) => { writes.push({ store, put: value }); },
        });
        const result = await fn(api);
        core.apply(writes);
        return result;
      });
    },
    recover() {
      return core.exclusive(async () => {
        try {
          return await core.settleJournalAsync();
        } catch (e) {
          if (e instanceof StorageBusyError) return { pending: true };
          throw e;
        }
      });
    },
    async fallbackData() { return null; },
    async dismissConflicts() {},
    async readFallback() { return []; },
    async exportFallback() { return { stores: {}, unreadable: [] }; },
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
//   migration: {           optional, for migrateFallback()
//     unique: { store: record => value | [values] }   values no two records
//                          of the store may share (null: none)
//     parents: { store: [{ store, key: record => parent key }] }   the
//                          record belongs to that one (null key: none)
//     fixup(api, migrated) async, in the migration transaction after the
//                          copies; api: get/getAll/put; migrated:
//                          [{ store, value }]
//   }
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
//   journalSettleMs        fallback without Web Locks: how long a foreign
//                          undo journal must stay unchanged to count as
//                          orphaned (default 1.5 s; tests)
// Resolves to the backend, or null when neither IndexedDB nor localStorage
// is usable. A localStorage backend carries `fallbackReason` (why
// IndexedDB was not used) and `recovery` (an unfinished batch rolled back
// on open: { rolledBack }; { pending: true }: another tab kept writing
// meanwhile, its journal was left alone; or null).
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
    backend = lsBackend(schema, ls, opts);
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
