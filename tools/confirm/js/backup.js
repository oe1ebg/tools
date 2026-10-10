// JSON backup of the confirmation log: validation and import planning.
// Pure (no DOM, no storage, no imports): imported by app.js and the node
// tests, inlined into confirm-offline.html by scripts/build_confirm.py, so
// every top-level name here must be unique across all js/ modules.
//
// Backup format (written by app.js eventBackup()/export):
//   { format, version: 1, exported, events: [{ event, entries, revisions }] }
// A line without `kind` is a check-in (needs `call` and `seq`), `kind:
// 'comment'` an operator comment (no seq).

export const BACKUP_FORMAT = 'oe1ebg-confirm-backup';
export const BACKUP_VERSIONS = [1];

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isId = v => typeof v === 'string' && v.length > 0 && v.length <= 200;
const isTime = v => typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v));
const isSeq = v => Number.isInteger(v) && v > 0;
// Optional timestamp: absent or null is fine, anything else must parse.
const timeOk = v => v === undefined || v === null || isTime(v);

// Checks a parsed backup file. Returns { ok, errors: [German messages] };
// nothing is written here. Stops listing at `limit` problems.
export function validateBackup(data, limit = 20) {
  const errors = [];
  const bad = msg => { if (errors.length < limit) errors.push(msg); };
  if (!isObj(data) || data.format !== BACKUP_FORMAT || !Array.isArray(data.events)) {
    return { ok: false, notBackup: true, errors: ['keine Sicherung des Bestätigungsverkehrs'] };
  }
  if (!BACKUP_VERSIONS.includes(data.version)) {
    const v = data.version === undefined ? '(fehlt)' : JSON.stringify(data.version);
    return { ok: false, errors: [`Version ${v} wird nicht unterstützt (unterstützt: ${BACKUP_VERSIONS.join(', ')})`] };
  }
  data.events.forEach((item, i) => {
    const where = `Log ${i + 1}`;
    if (!isObj(item) || !isObj(item.event)) return bad(`${where}: Log-Daten fehlen`);
    const ev = item.event;
    if (!isId(ev.id)) return bad(`${where}: Kennung fehlt oder ist ungültig`);
    const w = `Log „${typeof ev.title === 'string' ? ev.title : ev.id}“`;
    if (ev.title !== undefined && typeof ev.title !== 'string') bad(`${w}: Titel ist kein Text`);
    if (ev.header !== undefined && ev.header !== null && !isObj(ev.header)) bad(`${w}: Kopfdaten ungültig`);
    if (ev.nextSeq !== undefined && ev.nextSeq !== null && !isSeq(ev.nextSeq)) bad(`${w}: nächste Nummer ungültig`);
    for (const k of ['created', 'updated', 'deleted']) if (!timeOk(ev[k])) bad(`${w}: Zeitstempel „${k}“ ungültig`);
    for (const k of ['entries', 'revisions']) {
      if (item[k] !== undefined && !Array.isArray(item[k])) bad(`${w}: „${k}“ ist keine Liste`);
    }
    const entries = Array.isArray(item.entries) ? item.entries : [];
    const revisions = Array.isArray(item.revisions) ? item.revisions : [];
    const ids = new Set();
    const seqs = new Set();
    entries.forEach((e, j) => {
      const ew = `${w}, Zeile ${j + 1}`;
      if (!isObj(e)) return bad(`${ew}: ungültig`);
      if (!isId(e.id)) return bad(`${ew}: Kennung fehlt oder ist ungültig`);
      if (ids.has(e.id)) bad(`${ew}: Kennung kommt doppelt vor`);
      ids.add(e.id);
      if (e.eventId !== undefined && e.eventId !== ev.id) bad(`${ew}: gehört zu einem anderen Log`);
      if (!isTime(e.ts)) bad(`${ew}: Zeit fehlt oder ist ungültig`);
      for (const k of ['created', 'updated', 'deleted']) if (!timeOk(e[k])) bad(`${ew}: Zeitstempel „${k}“ ungültig`);
      if (e.kind === 'comment') {
        if (e.text !== undefined && typeof e.text !== 'string') bad(`${ew}: Kommentartext ungültig`);
      } else if (e.kind !== undefined && e.kind !== null) {
        bad(`${ew}: unbekannte Art „${String(e.kind).slice(0, 20)}“`);
      } else {
        if (typeof e.call !== 'string' || !e.call) bad(`${ew}: Rufzeichen fehlt`);
        if (!isSeq(e.seq)) bad(`${ew}: Nummer fehlt oder ist ungültig`);
        else if (seqs.has(e.seq)) bad(`${ew}: Nummer ${e.seq} kommt doppelt vor`);
        else seqs.add(e.seq);
      }
    });
    const rids = new Set();
    revisions.forEach((r, j) => {
      const rw = `${w}, Version ${j + 1}`;
      if (!isObj(r)) return bad(`${rw}: ungültig`);
      if (!isId(r.id)) return bad(`${rw}: Kennung fehlt oder ist ungültig`);
      if (rids.has(r.id)) bad(`${rw}: Kennung kommt doppelt vor`);
      rids.add(r.id);
      if (r.eventId !== undefined && r.eventId !== ev.id) bad(`${rw}: gehört zu einem anderen Log`);
      if (!isId(r.entryId) || !ids.has(r.entryId)) bad(`${rw}: verweist auf eine Zeile, die nicht in diesem Log ist`);
      if (!timeOk(r.savedAt)) bad(`${rw}: Zeitstempel ungültig`);
      if (r.data !== undefined && r.data !== null && !isObj(r.data)) bad(`${rw}: gesicherte Zeile ungültig`);
    });
  });
  return { ok: errors.length === 0, errors };
}

// Plans the import of a validated backup against what is stored. `has(store,
// id)` answers (async) whether a record with that key exists; the caller
// runs this and the writes in ONE storage transaction, so the answers hold
// until the writes. Returns { puts: [{ store, value }], imported, copies }.
// Never overwrites: a log whose event id, any line id or any revision id is
// already stored (or was already used by an earlier log of this file)
// is imported as a copy with fresh ids for the event, its lines and its
// revisions, all references remapped consistently. Other logs keep their ids.
export async function planBackupImport(data, has, newId) {
  const seen = { events: new Set(), entries: new Set(), revisions: new Set() };
  const taken = async (store, id) => seen[store].has(id) || has(store, id);
  const puts = [];
  let copies = 0;
  for (const item of data.events) {
    const ev = item.event;
    const entries = item.entries || [];
    const revisions = item.revisions || [];
    let clash = await taken('events', ev.id);
    for (const e of entries) if (!clash && await taken('entries', e.id)) clash = true;
    for (const r of revisions) if (!clash && await taken('revisions', r.id)) clash = true;
    const evId = clash ? newId() : ev.id;
    const idMap = new Map();
    const remap = id => {
      if (!clash) return id;
      if (!idMap.has(id)) idMap.set(id, newId());
      return idMap.get(id);
    };
    let top = 0;
    for (const e of entries) if (isSeq(e.seq) && e.seq > top) top = e.seq;
    const next = Math.max(isSeq(ev.nextSeq) ? ev.nextSeq : 1, top + 1);
    const title = ev.title || 'Log';
    puts.push({ store: 'events', value: { ...ev, id: evId, nextSeq: next, title: clash ? `${title} (Import)` : title } });
    seen.events.add(evId);
    for (const e of entries) {
      const id = remap(e.id);
      puts.push({ store: 'entries', value: { ...e, id, eventId: evId } });
      seen.entries.add(id);
    }
    for (const r of revisions) {
      const id = remap(r.id);
      const entryId = remap(r.entryId);
      const value = { ...r, id, entryId, eventId: evId };
      if (isObj(r.data)) value.data = { ...r.data, id: entryId, eventId: evId };
      puts.push({ store: 'revisions', value });
      seen.revisions.add(id);
    }
    if (clash) copies++;
  }
  return { puts, imported: data.events.length, copies };
}
