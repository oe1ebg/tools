// Netlog's JSON backup: everything (or one session with its series and
// the station profiles it uses), plaintext, restorable as a whole. Pure:
// building, checking and planning an import; ops.js importBackup() applies
// the plan in one transaction. Format and limits: ../README.md, "Backup".
//
//   { format: 'oe1ebg-netlog-backup', version: 1, schema: 1, exported,
//     scope: 'all' | 'session', sessionId?, stores: { <store>: [records] } }
//
// The leases (meta) are not part of a backup. Deleted records are (soft
// deletes stay restorable).

import { NETLOG_STORES, SESSION_STORES, NETLOG_SCHEMA } from './db.js';

export const BACKUP_FORMAT = 'oe1ebg-netlog-backup';
export const BACKUP_VERSION = 1;
export const BACKUP_STORES = Object.keys(NETLOG_STORES).filter(s => s !== 'meta');
// A backup larger than this is refused (export and import alike): it would
// not restore in every supported browser in one go. Export per session.
export const BACKUP_MAX_BYTES = 50 * 1024 * 1024;
export const BACKUP_MAX_RECORDS = 200000;
const ID_RE = /^[A-Za-z0-9_.:|-]{1,200}$/;

export function utf8Bytes(text) {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; } else n += 3;
  }
  return n;
}

// all: { store: [records] } as read from storage. sessionId: only that
// session (with its series and the profiles its participants link to).
export function toBackup(all, { sessionId = null, now = new Date().toISOString() } = {}) {
  const stores = {};
  if (sessionId) {
    const session = (all.sessions || []).find(s => s.id === sessionId);
    if (!session) throw new Error('session not found');
    stores.sessions = [session];
    stores.series = (all.series || []).filter(s => s.id === session.seriesId);
    for (const s of SESSION_STORES) stores[s] = (all[s] || []).filter(r => r.eventId === sessionId);
    const profileIds = new Set(stores.participants.map(p => p.profileId).filter(Boolean));
    stores.profiles = (all.profiles || []).filter(p => profileIds.has(p.id));
  } else {
    for (const s of BACKUP_STORES) stores[s] = [...(all[s] || [])];
    // series edits have their own undo history (eventId '')
  }
  return { format: BACKUP_FORMAT, version: BACKUP_VERSION, schema: NETLOG_SCHEMA.version, exported: now, scope: sessionId ? 'session' : 'all', ...(sessionId ? { sessionId } : {}), stores };
}

export function countRecords(data) {
  return Object.values(data.stores || {}).reduce((n, list) => n + (Array.isArray(list) ? list.length : 0), 0);
}

// The text to download, or { error } when it could not be restored
// (beyond the limits): nothing is downloaded then.
export function backupText(data) {
  if (countRecords(data) > BACKUP_MAX_RECORDS) return { error: 'tooManyRecords' };
  const text = JSON.stringify(data, null, 1);
  if (utf8Bytes(text) > BACKUP_MAX_BYTES) return { error: 'tooLarge' };
  return { text };
}

// Everything that must hold before anything is written. Returns
// { ok, error, detail } with error a translation key suffix.
export function checkBackup(data) {
  const bad = (error, detail = '') => ({ ok: false, error, detail });
  if (!data || typeof data !== 'object' || Array.isArray(data)) return bad('notBackup');
  if (data.format !== BACKUP_FORMAT) return bad('notBackup');
  if (data.version !== BACKUP_VERSION) return bad('version', String(data.version));
  if (!Number.isInteger(data.schema) || data.schema > NETLOG_SCHEMA.version) return bad('newer', String(data.schema));
  if (!data.stores || typeof data.stores !== 'object') return bad('malformed', 'stores');
  for (const s of Object.keys(data.stores)) if (!BACKUP_STORES.includes(s)) return bad('malformed', s);
  if (countRecords(data) > BACKUP_MAX_RECORDS) return bad('tooManyRecords');
  const ids = {};
  for (const s of BACKUP_STORES) {
    const list = data.stores[s] || [];
    if (!Array.isArray(list)) return bad('malformed', s);
    ids[s] = new Set();
    for (const r of list) {
      if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !ID_RE.test(r.id)) return bad('malformed', `${s}: id`);
      if (ids[s].has(r.id)) return bad('malformed', `${s}: ${r.id} twice`);
      ids[s].add(r.id);
    }
  }
  // every session-owned record belongs to a session of the file, and its
  // references point inside the file
  const has = (s, id) => id == null || ids[s].has(id);
  for (const s of SESSION_STORES) {
    for (const r of data.stores[s] || []) {
      if (s === 'undo' && r.eventId === '') continue; // series history
      if (!has('sessions', r.eventId) || r.eventId == null) return bad('malformed', `${s}: ${r.id} without its session`);
    }
  }
  for (const s of data.stores.sessions || []) {
    if (!has('series', s.seriesId)) return bad('malformed', `session ${s.id}: series`);
    if (!has('rounds', s.currentRoundId)) return bad('malformed', `session ${s.id}: round`);
    if (!has('participants', s.ncsId)) return bad('malformed', `session ${s.id}: net control`);
  }
  for (const p of data.stores.participants || []) if (!has('profiles', p.profileId)) return bad('malformed', `participant ${p.id}: profile`);
  for (const n of data.stores.notes || []) {
    if (!has('participants', n.participantId) || !has('rounds', n.roundId) || !has('contributions', n.contributionId)) return bad('malformed', `note ${n.id}`);
    if (typeof n.text !== 'string') return bad('malformed', `note ${n.id}: text`);
  }
  for (const c of data.stores.contributions || []) if (!has('participants', c.participantId) || !has('rounds', c.roundId)) return bad('malformed', `contribution ${c.id}`);
  for (const i of data.stores.items || []) {
    if (!['response', 'point', 'task'].includes(i.kind)) return bad('malformed', `item ${i.id}: kind`);
    if (!has('notes', i.noteId)) return bad('malformed', `item ${i.id}: note`);
  }
  return { ok: true };
}

// ---------- import plan ----------

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// The fields of a record that hold ids of other records: store -> field.
const REFS = {
  sessions: { seriesId: 'series', currentRoundId: 'rounds', ncsId: 'participants' },
  participants: { profileId: 'profiles', checkinRoundId: 'rounds', mergedInto: 'participants' },
  contributions: { participantId: 'participants', roundId: 'rounds' },
  notes: { participantId: 'participants', roundId: 'rounds', contributionId: 'contributions' },
  items: { noteId: 'notes', doneTurnId: 'turns' },
  events: { participantId: 'participants', roundId: 'rounds' },
};
// event from/to: participants (ncs, status: no) or rounds (round)
const EVENT_FT = { ncs: 'participants', round: 'rounds' };

// Replace ids through map (store -> Map old -> new).
export function remapRecord(store, rec, map) {
  const m = (s, id) => (id != null && map[s] && map[s].has(id) ? map[s].get(id) : id);
  const r = JSON.parse(JSON.stringify(rec));
  r.id = m(store, r.id);
  if (r.eventId) r.eventId = m('sessions', r.eventId);
  for (const [f, s] of Object.entries(REFS[store] || {})) if (f in r) r[f] = m(s, r[f]);
  if (store === 'events' && EVENT_FT[r.type]) { r.from = m(EVENT_FT[r.type], r.from); r.to = m(EVENT_FT[r.type], r.to); }
  if (store === 'items' && Array.isArray(r.history)) r.history = r.history.map(h => ({ ...h, turnId: m('turns', h.turnId) }));
  // "not the same station" decisions: participants of other sessions
  if (store === 'participants' && Array.isArray(r.notSame)) r.notSame = r.notSame.map(id => m('participants', id));
  if (store === 'revisions') {
    r.recordId = m(r.store, r.recordId);
    if (r.record) r.record = remapRecord(r.store, r.record, map);
  }
  if (store === 'drafts') {
    // id `<session>|<key>`, key `new:<participant>` / `note:<id>` / `item:<id>`
    const [kind, ref] = String(r.key || '').split(':');
    const target = { new: 'participants', note: 'notes', item: 'items' }[kind];
    if (target) r.key = `${kind}:${m(target, ref)}`;
    r.id = `${r.eventId}|${r.key}`;
  }
  return r;
}

// existing: { store: Map id -> record } of what is stored now (sessions,
// series, profiles are enough to decide; session-owned stores are checked
// for id clashes too). newId: () => fresh id. Returns { puts: [{ store,
// value }], report }:
//   - a session not stored yet is imported as it is, with all its records;
//   - a session whose id exists: identical (with all its records; missing
//     ones are added) -> skipped; any difference -> a copy
//     with new ids for it and every record it owns (references remapped),
//     named "(import)"; its undo history is not copied (it refers to the
//     old ids' states), revisions and drafts are;
//   - series and profiles: new -> imported; identical -> skipped; different
//     -> a copy with a new id, the imported sessions refer to the copy.
// Nothing stored is ever overwritten.
export function planImport(data, existing, newId, copySuffix = ' (import)') {
  const map = Object.fromEntries(BACKUP_STORES.map(s => [s, new Map()]));
  const report = { sessions: 0, copies: 0, identical: 0, series: 0, profiles: 0, records: 0, undoDropped: 0 };
  const puts = [];
  const st = data.stores;
  for (const s of ['series', 'profiles']) {
    for (const r of st[s] || []) {
      const cur = existing[s].get(r.id);
      if (!cur) { puts.push({ store: s, value: r }); report[s]++; } else if (!same(cur, r)) {
        map[s].set(r.id, newId());
        puts.push({ store: s, value: remapRecord(s, s === 'series' ? { ...r, name: `${r.name || ''}${copySuffix}` } : r, map) });
        report[s]++;
      }
    }
  }
  const owned = sid => SESSION_STORES.flatMap(s => (st[s] || []).filter(r => r.eventId === sid).map(r => ({ store: s, r })));
  for (const sess of st.sessions || []) {
    const cur = existing.sessions.get(sess.id);
    const records = owned(sess.id);
    // the same session in the same state: every record it owns is either
    // stored identically or missing here (then it is added); any difference
    // makes the import a copy, so neither side is lost
    const unchanged = cur && same(cur, sess) && records.every(({ store, r }) => store === 'undo' || store === 'drafts' || !existing[store].has(r.id) || same(existing[store].get(r.id), r));
    if (unchanged) {
      report.identical++;
      for (const { store, r } of records) {
        if (store === 'undo' || existing[store].has(r.id)) continue;
        puts.push({ store, value: remapRecord(store, r, map) });
        report.records++;
      }
      continue;
    }
    // a clash on the session or on any record it owns: a copy
    const clash = !!cur || records.some(({ store, r }) => existing[store].has(r.id));
    if (clash) {
      map.sessions.set(sess.id, newId());
      for (const { store, r } of records) if (store !== 'drafts') map[store].set(r.id, newId());
      report.copies++;
    }
    puts.push({ store: 'sessions', value: remapRecord('sessions', clash ? { ...sess, name: `${sess.name || ''}${copySuffix}`.trim() } : sess, map) });
    report.sessions++;
    for (const { store, r } of records) {
      if (clash && store === 'undo') { report.undoDropped++; continue; }
      puts.push({ store, value: remapRecord(store, r, map) });
      report.records++;
    }
  }
  // series edits' own history: only when the series came over unchanged
  for (const u of (st.undo || []).filter(r => r.eventId === '')) {
    if (!existing.undo.has(u.id) && !(u.before || []).some(b => map[b.store] && map[b.store].has(b.id))) puts.push({ store: 'undo', value: u });
  }
  return { puts, report };
}
