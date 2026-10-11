// JSON backup of the confirmation log: validation and import planning.
// Pure (no DOM, no storage): imported by app.js and the node
// tests, inlined into confirm-offline.html by scripts/build_confirm.py, so
// every top-level name here must be unique across all js/ modules.
//
// Backup format (written by app.js eventBackup()/export):
//   { format, version: 1, exported, events: [{ event, entries, revisions }] }
// A line without `kind` is a check-in (needs `call` and `seq`), `kind:
// 'comment'` an operator comment (no seq).
//
// A user must always be able to restore their own old data: only what
// breaks identity or ownership is rejected (wrong version, records that
// aren't objects, missing/duplicate/mistyped ids, a line or revision of
// another log). Everything else that old data can contain (two lines with
// the same number from the two-tab race, a revision of a line that is not
// in the file, a line without a readable time) is imported as written and
// reported as a warning.

import { splitToFit, partsTooManyRecords, backupTooLargeMessage } from '../../shared/js/backup-parts.js';

export const BACKUP_FORMAT = 'oe1ebg-confirm-backup';
export const BACKUP_VERSIONS = [1];

// Resource limits (issue #15): a file or log beyond these is refused as a
// whole, with a message, before anything is written. 50 MB is about 10x a
// 5000-line log with all its revisions; 200000 records (lines + versions)
// about 20x. There is no limit on the text of a line: a note longer than
// anything sensible may already be stored. A backup the tool itself writes
// must always be restorable, so an export beyond these limits is written in
// parts (backupTexts()) that the import takes together (combineBackupParts());
// the limits apply per file.
export const BACKUP_MAX_BYTES = 50 * 1024 * 1024;
export const BACKUP_MAX_RECORDS = 200000;

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isId = v => typeof v === 'string' && v.length > 0 && v.length <= 200;
const isTime = v => typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v));
// Line numbers and the counter: bounded safe integers, so n + 1 never equals n.
export const SEQ_LIMIT = 1e9;
const isSeq = v => Number.isInteger(v) && v > 0 && v < SEQ_LIMIT;
// Optional timestamp: absent or null is fine, anything else must parse.
const timeOk = v => v === undefined || v === null || isTime(v);

// Checks a parsed backup file. Returns { ok, errors, warnings } (German
// messages); nothing is written here. `errors` reject the file, `warnings`
// are reported after the import. Stops listing at `limit` per kind.
// opts.fileOnly: only what is checked per FILE (format, version, size limit),
// for the parts of a set; opts.combined: the parts put together, the record
// limit was checked per part.
export function validateBackup(data, limit = 20, opts = {}) {
  const errors = [];
  const warnings = [];
  const bad = msg => { if (errors.length < limit) errors.push(msg); };
  const warn = msg => { if (warnings.length < limit) warnings.push(msg); };
  if (!isObj(data) || data.format !== BACKUP_FORMAT || !Array.isArray(data.events)) {
    return { ok: false, notBackup: true, errors: ['keine Sicherung des Bestätigungsverkehrs'], warnings };
  }
  if (!BACKUP_VERSIONS.includes(data.version)) {
    const v = data.version === undefined ? '(fehlt)' : JSON.stringify(data.version);
    return { ok: false, errors: [`Version ${v} wird nicht unterstützt (unterstützt: ${BACKUP_VERSIONS.join(', ')})`], warnings };
  }
  let records = 0;
  for (const item of data.events) {
    if (isObj(item)) records += (Array.isArray(item.entries) ? item.entries.length : 0) + (Array.isArray(item.revisions) ? item.revisions.length : 0);
  }
  if (records > BACKUP_MAX_RECORDS && !opts.combined) {
    return { ok: false, errors: [`Die Datei enthält ${records} Zeilen und Versionen; mehr als ${BACKUP_MAX_RECORDS} werden in einer Datei nicht importiert (zu groß für diesen Browser).`], warnings };
  }
  if (opts.fileOnly) return { ok: true, errors, warnings };
  data.events.forEach((item, i) => {
    const where = `Log ${i + 1}`;
    if (!isObj(item) || !isObj(item.event)) return bad(`${where}: Log-Daten fehlen`);
    const ev = item.event;
    if (!isId(ev.id)) return bad(`${where}: Kennung fehlt oder ist ungültig`);
    const w = `Log „${typeof ev.title === 'string' ? ev.title : ev.id}“`;
    if (ev.title !== undefined && typeof ev.title !== 'string') warn(`${w}: Titel ist kein Text (wird „Log“)`);
    if (ev.header !== undefined && ev.header !== null && !isObj(ev.header)) bad(`${w}: Kopfdaten ungültig`);
    if (ev.nextSeq !== undefined && ev.nextSeq !== null && !isSeq(ev.nextSeq)) warn(`${w}: nächste Nummer ungültig (${String(ev.nextSeq).slice(0, 30)}; wird neu berechnet)`);
    for (const k of ['created', 'updated', 'deleted']) if (!timeOk(ev[k])) warn(`${w}: Zeitstempel „${k}“ ungültig`);
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
      if (!isTime(e.ts)) warn(`${ew}: Zeit fehlt oder ist ungültig (Erstellungszeit wird verwendet)`);
      for (const k of ['created', 'updated', 'deleted']) if (!timeOk(e[k])) warn(`${ew}: Zeitstempel „${k}“ ungültig`);
      if (e.kind === 'comment') {
        if (e.text !== undefined && typeof e.text !== 'string') warn(`${ew}: Kommentartext ungültig`);
      } else if (e.kind !== undefined && e.kind !== null) {
        warn(`${ew}: unbekannte Art „${String(e.kind).slice(0, 20)}“`);
      } else {
        if (typeof e.call !== 'string' || !e.call) warn(`${ew}: Rufzeichen fehlt`);
        if (!isSeq(e.seq)) warn(`${ew}: Nummer fehlt oder ist ungültig`);
        else if (seqs.has(e.seq)) warn(`${ew}: Nummer ${e.seq} kommt mehrfach vor (bleibt wie gespeichert)`);
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
      if (!isId(r.entryId)) bad(`${rw}: Zeilenkennung fehlt oder ist ungültig`);
      else if (!ids.has(r.entryId)) warn(`${rw}: die zugehörige Zeile ist nicht in der Datei (Version bleibt in diesem Log)`);
      if (!timeOk(r.savedAt)) warn(`${rw}: Zeitstempel ungültig`);
      if (r.data !== undefined && r.data !== null && !isObj(r.data)) warn(`${rw}: gesicherte Zeile ungültig`);
    });
  });
  return { ok: errors.length === 0, errors, warnings };
}

// Plans the import of a validated backup. `existing` holds the ids already
// stored, { events, entries, revisions } as Sets, read by the caller inside
// the same storage transaction that then writes the result. Returns
// { puts: [{ store, value }], imported, copies, warnings }.
// Never overwrites: a log whose event id, any line id or any revision id is
// already stored (or was already used by an earlier log of this file)
// is imported as a copy with fresh ids for the event, its lines and its
// revisions, all references remapped consistently. Other logs keep their ids.
// Nothing is dropped; a line without a readable time gets its creation time.
export function planBackupImport(data, existing, newId) {
  const seen = { events: new Set(), entries: new Set(), revisions: new Set() };
  const taken = (store, id) => seen[store].has(id) || existing[store].has(id);
  const puts = [];
  const warnings = [];
  let copies = 0;
  for (const item of data.events) {
    const ev = item.event;
    const entries = item.entries || [];
    const revisions = item.revisions || [];
    let clash = taken('events', ev.id);
    for (const e of entries) if (!clash && taken('entries', e.id)) clash = true;
    for (const r of revisions) if (!clash && taken('revisions', r.id)) clash = true;
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
    const title = typeof ev.title === 'string' && ev.title ? ev.title : 'Log';
    puts.push({ store: 'events', value: { ...ev, id: evId, nextSeq: next, title: clash ? `${title} (Import)` : title } });
    seen.events.add(evId);
    let fixedTime = 0;
    for (const e of entries) {
      const id = remap(e.id);
      const value = { ...e, id, eventId: evId };
      if (!isTime(e.ts)) {
        value.ts = [e.created, e.updated, ev.created, data.exported].find(isTime) || '1970-01-01T00:00:00.000Z';
        fixedTime++;
      }
      puts.push({ store: 'entries', value });
      seen.entries.add(id);
    }
    if (fixedTime) warnings.push(`Log „${title}“: bei ${fixedTime} ${fixedTime === 1 ? 'Zeile' : 'Zeilen'} fehlte die Zeit; die Erstellungszeit wurde eingesetzt.`);
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
  return { puts, imported: data.events.length, copies, warnings };
}

// The texts of the files of a backup: one (as always, no `part`) when it fits
// the import limits, else several parts of `part: { set, n, of }`, each within
// them. events: [{ event, entries, revisions }]. setId names the set.
export function backupTexts(events, exported, setId, limits) {
  const items = [];
  for (const item of events) {
    items.push({ ev: item.event });
    for (const e of item.entries || []) items.push({ ev: item.event, entry: e });
    for (const r of item.revisions || []) items.push({ ev: item.event, rev: r });
  }
  const build = (slice, part) => {
    const out = [];
    for (const it of slice) {
      let last = out[out.length - 1];
      if (!last || last.event !== it.ev) out.push(last = { event: it.ev, entries: [], revisions: [] });
      if (it.entry) last.entries.push(it.entry);
      if (it.rev) last.revisions.push(it.rev);
    }
    return JSON.stringify({ format: BACKUP_FORMAT, version: 1, exported, ...(part ? { part } : {}), events: out }, null, 1);
  };
  const tooLarge = backupTooLargeMessage('Bitte die einzelnen Logs getrennt sichern (Sicherung (JSON) im jeweiligen Log).');
  const slices = splitToFit(items, build, it => (it.entry || it.rev ? 1 : 0), { tooLarge, ...limits });
  return slices.map((slice, i) => build(slice, slices.length > 1 ? { set: setId, n: i + 1, of: slices.length } : undefined));
}

// The parts of one set (parsed, in order) as one backup: the items of the same
// log are put together. Every part must itself be a valid file (format,
// version, limits per file); the result is checked with
// validateBackup(data, limit, { combined: true }). Returns { data } or { errors }.
export function combineBackupParts(parts) {
  for (const d of parts) {
    const c = validateBackup(d, 1, { fileOnly: true });
    if (!c.ok) return { errors: c.errors };
  }
  let total = 0;
  for (const d of parts) for (const item of d.events) if (isObj(item)) total += (Array.isArray(item.entries) ? item.entries.length : 0) + (Array.isArray(item.revisions) ? item.revisions.length : 0);
  const big = partsTooManyRecords(total);
  if (big) return { errors: [big] };
  const byId = new Map();
  const events = [];
  for (const d of parts) {
    for (const item of d.events) {
      const id = isObj(item) && isObj(item.event) ? item.event.id : undefined;
      const have = id !== undefined && byId.get(id);
      if (!have) {
        const copy = { ...item, entries: [...(item.entries || [])], revisions: [...(item.revisions || [])] };
        events.push(copy);
        if (id !== undefined) byId.set(id, copy);
      } else {
        // the log's own record is repeated in every part: the first one counts
        if (Array.isArray(item.entries)) have.entries.push(...item.entries);
        if (Array.isArray(item.revisions)) have.revisions.push(...item.revisions);
      }
    }
  }
  const { part, ...rest } = parts[0];
  return { data: { ...rest, events } };
}
