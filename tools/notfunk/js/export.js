// Exports of the emergency traffic log. Pure functions, unit-tested.
//
// - toGeschaeftsbuchCSV(): one row per message, columns of the SKKM
//   Geschäftsbuch kept by S6 / the Meldesammelstelle (ÖBFV E-31 annex: GZ,
//   Datum, Uhrzeit, Ein/Aus, eingegangen von / weitergeleitet an, Betreff,
//   Anmerkungen) plus the Notfunk fields. The first column is the Notfunk
//   number; the Meldesammelstelle's own number (Geschäftszahl) is the
//   separate column "Referenz Meldesammelstelle". Semicolon-separated
//   with a BOM, so Excel in a German locale opens it directly.
//   Datum/Uhrzeit are Austrian local time; "Zeitstempel (ISO 8601)" has
//   the offset (2026-10-05T14:07:00+02:00), unambiguous for programs.
// - toBackup() / parseBackup() / mergeBackup(): the full JSON backup of an
//   operation (messages incl. deleted ones, revisions, counters). A restore
//   only adds or updates records and never lowers a counter, so no message
//   number is ever handed out twice (numbering.counterAfterImport()).

import { DIRECTIONS, CHANNELS, MESSAGE_TYPES, PRIORITIES, REF_KINDS, STATUS_FLOW, validateMessage, messageFields, statusLabel, statusEntry, currentStatus, liveMessages, fmtVienna, viennaDate, viennaTime, isoVienna, fmtFreq } from './model.js';
import { counterAfterImport, counterKey, PREFIX_RE, formatNumber } from './numbering.js';
import { csvSafeRows } from '../../shared/js/csv.js';
import { splitToFit, partsTooManyRecords, backupTooLargeMessage, chunkRecord, applyChunks } from '../../shared/js/backup-parts.js';

export const BACKUP_FORMAT = 'oe1ebg-notfunk-backup';
export const BACKUP_VERSION = 1;

// Resource limits (issue #15): a file beyond these is refused as a whole
// (message, nothing written). 50 MB is ~10x a 5000-message operation with its
// revisions, 200000 records ~20x. A backup the tool writes beyond them is
// written in parts (toBackupTexts()) that are restored together
// (combineBackupParts()); the limits apply per file.
export const BACKUP_MAX_BYTES = 50 * 1024 * 1024;
export const BACKUP_MAX_RECORDS = 200000;

function partyLabel(p) {
  return [p.name, p.call && p.call !== p.name ? p.call : ''].filter(Boolean).join(' / ');
}

export const GB_COLUMNS = [
  'Notfunk-Nr.', 'Referenz Meldesammelstelle', 'Datum', 'Uhrzeit', 'Zeitstempel (ISO 8601)', 'Ein/Aus', 'eingegangen von / weitergeleitet an', 'Betreff', 'Inhalt',
  'Art', 'Dringlichkeit', 'Übermittlung', 'Funkstelle', 'Frequenz/Relais', 'Absender', 'Adressat', 'Verteiler',
  'Rücklesen bestätigt', 'Status', 'Übergeben / übertragen an', 'Übergeben / übertragen um', 'Übernommen / Empfang bestätigt durch',
  'Bezug', 'Ort', 'Aufgenommen von', 'Stationsrufzeichen', 'Erfasst', 'Anmerkungen',
  // exact instants with offset (the cells above are Vienna wall-clock time only)
  'Übergeben / übertragen um (ISO 8601)', 'Empfang bestätigt um (ISO 8601)', 'Erfasst (ISO 8601)',
];

// stats (optional object): .guarded = number of cells that got a leading '
// because they started like a spreadsheet formula (../../shared/js/csv.js).
export function toGeschaeftsbuchCSV(msgs, sep = ';', stats) {
  const byId = new Map(msgs.map(m => [m.id, m]));
  const rows = [GB_COLUMNS];
  for (const m of liveMessages(msgs)) {
    const fwd = statusEntry(m, 'forwarded');
    const ack = statusEntry(m, 'acknowledged');
    const ref = m.replyTo ? byId.get(m.replyTo)?.number || m.refNumber || '' : m.refNumber || '';
    rows.push([
      m.number, m.staffRef || '', viennaDate(m.ts), viennaTime(m.ts), isoVienna(m.ts), DIRECTIONS[m.direction],
      partyLabel(m.direction === 'in' ? m.from : m.to), m.subject, m.text,
      MESSAGE_TYPES[m.type], PRIORITIES[m.priority],
      CHANNELS[m.channel],
      m.peer || '', [fmtFreq(m.radio.freq), m.radio.via].filter(Boolean).join(' via '), partyLabel(m.from), partyLabel(m.to), m.distribution.join(', '),
      m.readBack ? 'ja' : '', statusLabel(currentStatus(m), m.direction),
      fwd?.to || '', fwd ? viennaTime(fwd.at) : '', ack ? [ack.who, viennaTime(ack.at)].filter(Boolean).join(' ') : '',
      ref ? `${REF_KINDS[m.refKind] || REF_KINDS.antwort} ${ref}` : '',
      m.location ? m.location.label || `${m.location.lat}, ${m.location.lon}` : m.locationText || '', m.operator, m.stationCall || '', fmtVienna(m.created), m.remarks,
      fwd ? isoVienna(fwd.at) : '', ack ? isoVienna(ack.at) : '', isoVienna(m.created),
    ]);
  }
  return '\ufeff' + csvSafeRows(rows, sep, stats) + '\r\n';
}

export function toBackup({ operation, messages, revisions, counters, chunks }, now, part) {
  return JSON.stringify({
    format: BACKUP_FORMAT, version: BACKUP_VERSION, exported: now, ...(part ? { part } : {}),
    operation, messages, revisions, counters, ...(chunks?.length ? { chunks } : {}),
  }, null, 1);
}

// The texts of the files of a backup: one (as toBackup(), no `part`) when it
// fits the import limits, else several parts with `part: { set, n, of }`, each
// within them: messages first, then the revisions, every part with the
// operation and the counters. The parts restore only together.
export function toBackupTexts({ operation, messages, revisions, counters }, now, setId, limits) {
  const items = [...messages.map(m => ({ m })), ...revisions.map(r => ({ r }))];
  const build = (slice, part) => toBackup({ operation, messages: slice.filter(x => x.m).map(x => x.m), revisions: slice.filter(x => x.r).map(x => x.r), counters, chunks: slice.filter(x => x.chunk).map(x => x.chunk) }, now, part);
  // a text beyond the chunk size is written as chunks (chunkRecord) in the parts
  // and put together again by combineBackupParts()
  const expand = list => list.flatMap(it => {
    const kind = it.m ? 'messages' : 'revisions';
    const rec = it.m || it.r;
    const cut = chunkRecord(rec, kind, rec.id, limits?.chunkChars);
    return cut.chunks.length ? [it.m ? { m: cut.rec } : { r: cut.rec }, ...cut.chunks.map(chunk => ({ chunk }))] : [it];
  });
  const tooLarge = backupTooLargeMessage('Bitte das Geschäftsbuch (CSV) exportieren und für weitere Meldungen einen neuen Einsatz anlegen.');
  const slices = splitToFit(items, build, () => 1, { tooLarge, expand, ...limits });
  return slices.map((slice, i) => build(slice, slices.length > 1 ? { set: setId, n: i + 1, of: slices.length } : undefined));
}

const ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
// A running number is at most six digits (numbering.parseNumber()); a
// counter is bounded the same way, so a damaged backup can't push the
// numbering to absurd values.
export const MAX_SEQ = 999999;

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const isIso = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(v) && !Number.isNaN(Date.parse(v));
const isSeq = v => Number.isSafeInteger(v) && v >= 1 && v <= MAX_SEQ;
const seqKey = m => `${m.prefix}:${m.seq}`;

// Identity problems of a stored message (German), or '': what a restore can't
// work around (id, owner, number). A file with one is refused as a whole.
function identityProblem(m, opId) {
  if (!isObj(m)) return 'kein Objekt';
  if (typeof m.id !== 'string' || !ID_RE.test(m.id)) return 'ungültige ID';
  if (m.eventId !== opId) return 'gehört zu einem anderen Einsatz';
  if (typeof m.prefix !== 'string' || !PREFIX_RE.test(m.prefix)) return 'ungültiges Stationskürzel';
  if (!isSeq(m.seq)) return 'ungültige laufende Nummer';
  if (m.number !== formatNumber(m.prefix, m.seq)) return 'Nummer passt nicht zu Kürzel und laufender Nummer';
  return '';
}

// Other problems of a stored message (shapes the book and the exports rely
// on; validateMessage() may have been tightened since the backup was made),
// or ''. Such a message is left out and counted, the rest is restored.
function messageProblem(m) {
  for (const k of ['subject', 'text']) if (typeof m[k] !== 'string') return `${k === 'text' ? 'Inhalt' : 'Betreff'} fehlt`;
  for (const k of ['from', 'to', 'radio', 'origin']) if (!isObj(m[k])) return `Feld ${k} fehlt`;
  if (!Array.isArray(m.distribution) || m.distribution.some(x => typeof x !== 'string')) return 'ungültiger Verteiler';
  if (!isIso(m.created) || !isIso(m.updated)) return 'ungültiger Zeitstempel (erfasst/geändert)';
  if (m.deleted != null && !isIso(m.deleted)) return 'ungültiger Zeitstempel (gelöscht)';
  if (!Array.isArray(m.status) || !m.status.length) return 'Status fehlt';
  for (const s of m.status) if (!isObj(s) || !STATUS_FLOW.includes(s.state) || !isIso(s.at)) return 'ungültiger Status';
  if (m.attempts != null && (!Array.isArray(m.attempts) || m.attempts.some(a => !isObj(a) || !isIso(a.at)))) return 'ungültiger Fehlversuch';
  if (m.replyTo != null && (typeof m.replyTo !== 'string' || !ID_RE.test(m.replyTo))) return 'ungültiger Bezug';
  if (m.stichzeit != null && !isIso(m.stichzeit)) return 'ungültige Stichzeit';
  if (m.origin.filed != null && !isIso(m.origin.filed)) return 'ungültige Aufgabezeit';
  let errs;
  try {
    errs = validateMessage(messageFields(m), { lenient: true });
  } catch {
    return 'ungültige Felder';
  }
  return errs.length ? errs.join(', ') : '';
}

// Parsed backup or an Error message (German) for the UI. Identity and
// ownership are checked hard, the file is refused as a whole: format,
// version, operation, a record of another operation, an id or a number
// twice, number = prefix + running number. A record with only a semantic
// problem (shape, timestamp, a revision without its message, a counter that
// doesn't fit) is left out, never the whole backup: `dropped` lists them
// ({ what, why }); `droppedSeqs` are the numbers of left-out messages (they
// still count for the counters).
export function parseBackup(json) {
  let d;
  try {
    d = JSON.parse(json);
  } catch {
    throw new Error('Keine gültige JSON-Datei');
  }
  return checkBackup(d);
}

// What is checked per FILE (format, version, lists, size limit); `opts.combined`
// skips the record limit (parts put together, each checked on its own).
function checkFile(d, opts = {}) {
  if (d?.format !== BACKUP_FORMAT) throw new Error('Keine Notfunk-Sicherung');
  if (!Number.isInteger(d.version) || d.version < 1) throw new Error('Sicherung unvollständig (version)');
  if (d.version > BACKUP_VERSION) throw new Error('Sicherung stammt von einer neueren Version des Werkzeugs');
  for (const k of ['messages', 'revisions', 'counters']) if (!Array.isArray(d[k])) throw new Error(`Sicherung unvollständig (${k})`);
  const op = d.operation;
  if (!isObj(op) || typeof op.id !== 'string' || !ID_RE.test(op.id)) throw new Error('Sicherung unvollständig (operation)');
  if (typeof op.name !== 'string' || !op.name.trim()) throw new Error('Sicherung unvollständig (Name des Einsatzes)');
  if (op.prefix != null && !PREFIX_RE.test(op.prefix)) throw new Error('Sicherung fehlerhaft: Stationskürzel des Einsatzes');
  const records = d.messages.length + d.revisions.length;
  if (records > BACKUP_MAX_RECORDS && !opts.combined) throw new Error(`Die Sicherung enthält ${records} Meldungen und Fassungen; mehr als ${BACKUP_MAX_RECORDS} werden in einer Datei nicht importiert (zu groß für diesen Browser)`);
  return op;
}

// parseBackup() for an already parsed file.
export function checkBackup(d, opts = {}) {
  const op = checkFile(d, opts);
  const bad = (what, why) => new Error(`Sicherung fehlerhaft: ${what}: ${why}`);
  const dropped = [];
  const droppedSeqs = [];
  const ids = new Set(), seqs = new Set();
  for (const [i, m] of d.messages.entries()) {
    const what = `Meldung ${isObj(m) && typeof m.number === 'string' ? m.number : i + 1}`;
    const why = identityProblem(m, op.id);
    if (why) throw bad(what, why);
    if (ids.has(m.id)) throw bad(what, 'ID doppelt');
    if (seqs.has(seqKey(m))) throw bad(what, 'Nummer doppelt');
    ids.add(m.id);
    seqs.add(seqKey(m));
  }
  const messages = [];
  for (const m of d.messages) {
    const why = messageProblem(m);
    if (why) {
      dropped.push({ what: `Meldung ${m.number}`, why });
      droppedSeqs.push({ prefix: m.prefix, seq: m.seq });
    } else {
      messages.push(m);
    }
  }
  d.messages = messages;
  const kept = new Set(messages.map(m => m.id));
  const revIds = new Set();
  const revisions = [];
  for (const [i, r] of d.revisions.entries()) {
    const what = `Fassung ${i + 1}`;
    if (isObj(r) && r.eventId !== op.id) throw bad(what, 'gehört zu einem anderen Einsatz');
    const why = !isObj(r) || typeof r.id !== 'string' || !ID_RE.test(r.id) ? 'ungültige ID'
      : !kept.has(r.messageId) ? 'gehört zu einer Meldung, die nicht übernommen wird'
        : !isIso(r.at) ? 'ungültiger Zeitstempel'
          : !isObj(r.old) || r.old.id !== r.messageId ? 'frühere Fassung fehlt'
            : revIds.has(r.id) ? 'ID doppelt' : '';
    if (why) { dropped.push({ what, why }); continue; }
    revIds.add(r.id);
    revisions.push(r);
  }
  d.revisions = revisions;
  const cIds = new Set();
  const counters = [];
  for (const [i, c] of d.counters.entries()) {
    const what = `Zähler ${isObj(c) && c.prefix ? c.prefix : i + 1}`;
    const why = !isObj(c) || typeof c.prefix !== 'string' || !PREFIX_RE.test(c.prefix) ? 'ungültiges Stationskürzel'
      : c.eventId !== op.id || c.id !== counterKey(op.id, c.prefix) ? 'passt nicht zum Einsatz'
        : !Number.isSafeInteger(c.last) || c.last < 0 || c.last > MAX_SEQ ? 'ungültiger Stand'
          : cIds.has(c.id) ? 'doppelt' : '';
    if (why) { dropped.push({ what, why }); continue; }
    cIds.add(c.id);
    counters.push(c);
  }
  d.counters = counters;
  d.dropped = dropped;
  d.droppedSeqs = droppedSeqs;
  return d;
}

// Writes for restoring a backup into an existing database. Records are
// matched by id; an existing record is only replaced by a newer one
// (`updated`), so restoring an old backup never undoes later edits or
// deletes. Counters never go down. Messages that clash with a stored
// message's number but have another id, or whose id belongs to another
// operation (ids are global), are reported, not written; so is the second
// of two incoming records with the same id or number.
// existing: { operation, messages, revisions, counters } of the backup's
// operation; allMessages / allRevisions (optional): every record of the
// store, for the global ids. Decide and write in ONE atomic() (ops.js
// applyBackup()), or the stored state may have moved on.
// Returns { ops: [{ store, put }], added, updated, conflicts: [number], unlinked: [number] }.
export function mergeBackup(backup, existing) {
  const opId = backup.operation.id;
  const ops = [];
  const have = new Map(existing.messages.map(m => [m.id, m]));
  const owner = new Map((existing.allMessages || existing.messages).map(m => [m.id, m.eventId]));
  const taken = new Set(existing.messages.map(seqKey));
  const seen = new Set();
  const added_ = [];
  let added = 0, updated = 0;
  const upd = [];
  const conflicts = [];
  if (!existing.operation) ops.push({ store: 'operations', put: backup.operation });
  for (const m of backup.messages) {
    if (m.eventId !== opId) continue;
    if (seen.has(m.id)) { conflicts.push(m.number); continue; }
    seen.add(m.id);
    const old = have.get(m.id);
    if (!old) {
      if ((owner.has(m.id) && owner.get(m.id) !== opId) || taken.has(seqKey(m))) { conflicts.push(m.number); continue; }
      ops.push({ store: 'messages', put: m });
      added_.push(m);
      taken.add(seqKey(m));
      have.set(m.id, m);
      added++;
    } else if ((m.updated || '') > (old.updated || '')) {
      const op = { store: 'messages', put: { ...m, prefix: old.prefix, seq: old.seq, number: old.number } };
      ops.push(op);
      upd.push(op);
      updated++;
    }
  }
  // a reply whose target was not taken (clash, left out) is not imported
  // either: no dangling Bezug, nothing altered
  const unlinked = [];
  const lostMsgs = [];
  for (let again = true; again;) {
    again = false;
    for (const m of [...added_]) {
      if (!m.replyTo || have.has(m.replyTo)) continue;
      added_.splice(added_.indexOf(m), 1);
      ops.splice(ops.findIndex(o => o.store === 'messages' && o.put === m), 1);
      have.delete(m.id);
      taken.delete(seqKey(m));
      lostMsgs.push(m);
      unlinked.push(m.number);
      added--;
      again = true;
    }
  }
  // a newer version of a stored message is checked against the final graph
  // too: its Bezug must be a message of this operation that is there; else
  // the stored record stays as it is and the update is reported
  for (const op of upd) {
    const to = op.put.replyTo;
    if (!to || have.has(to)) continue;
    ops.splice(ops.indexOf(op), 1);
    updated--;
    unlinked.push(op.put.number);
  }
  const revOwner = new Map((existing.allRevisions || existing.revisions).map(r => [r.id, r.eventId]));
  for (const r of backup.revisions) {
    if (r.eventId !== opId || revOwner.has(r.id) || !have.has(r.messageId)) continue;
    revOwner.set(r.id, opId);
    ops.push({ store: 'revisions', put: r });
  }
  const counters = counterAfterImport(existing.counters, [...existing.messages, ...added_, ...lostMsgs, ...(backup.droppedSeqs || []).map(x => ({ ...x, eventId: opId }))], opId);
  const incoming = backup.counters.filter(c => c.eventId === opId && PREFIX_RE.test(c.prefix) && Number.isSafeInteger(c.last) && c.last >= 0 && c.last <= MAX_SEQ);
  for (const c of counterAfterImport(counters, incoming.map(c => ({ eventId: c.eventId, prefix: c.prefix, seq: c.last })), opId)) {
    ops.push({ store: 'counters', put: c });
  }
  return { ops, added, updated, conflicts, unlinked };
}

// The parts of one set (parsed JSON, in order) as one backup, checked like a
// single file (the record limit applied per part). Throws a German Error.
export function combineBackupParts(parts) {
  const ops = parts.map(d => checkFile(d));
  if (ops.some(o => o.id !== ops[0].id)) throw new Error('Die Teile gehören zu verschiedenen Einsätzen');
  if (parts.some(d => d.chunks !== undefined && !Array.isArray(d.chunks))) throw new Error('Textblöcke ungültig – die Teile sind beschädigt; es wurde nichts importiert');
  const big = partsTooManyRecords(parts.reduce((n, d) => n + d.messages.length + d.revisions.length + (d.chunks || []).length, 0));
  if (big) throw new Error(big.replace(/\.$/, ''));
  const last = new Map();
  for (const d of parts) for (const c of d.counters) if (isObj(c) && typeof c.id === 'string' && !(last.get(c.id)?.last >= c.last)) last.set(c.id, c);
  const { part, chunks, ...rest } = parts[0];
  const messages = parts.flatMap(d => d.messages);
  const revisions = parts.flatMap(d => d.revisions);
  const allChunks = parts.flatMap(d => d.chunks || []);
  if (allChunks.length) {
    const byKind = new Map([['messages', new Map()], ['revisions', new Map()]]); // Maps: a tampered kind like "__proto__" is simply unknown
    for (const [k, list] of [['messages', messages], ['revisions', revisions]]) for (const r of list) if (isObj(r) && typeof r.id === 'string') byKind.get(k).set(r.id, r);
    const why = applyChunks(allChunks, (kind, rid) => byKind.get(kind)?.get(rid));
    if (why) throw new Error(why.replace(/\.$/, ''));
  }
  return checkBackup({ ...rest, messages, revisions, counters: [...last.values()] }, { combined: true });
}
