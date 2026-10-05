// Exports of the emergency traffic log. Pure functions, unit-tested.
//
// - toGeschaeftsbuchCSV(): one row per message, columns of the SKKM
//   Geschäftsbuch kept by S6 / the Meldesammelstelle (ÖBFV E-31 annex: GZ,
//   Datum, Uhrzeit, Ein/Aus, eingegangen von / weitergeleitet an, Betreff,
//   Anmerkungen) plus the Notfunk fields. Semicolon-separated with a BOM, so
//   Excel in a German locale opens it directly.
// - toBackup() / parseBackup() / mergeBackup(): the full JSON backup of an
//   operation (messages incl. deleted ones, revisions, counters). A restore
//   only adds or updates records and never lowers a counter, so no message
//   number is ever handed out twice (numbering.counterAfterImport()).

import { DIRECTIONS, CHANNELS, MESSAGE_TYPES, PRIORITIES, STATUS_LABELS, currentStatus, liveMessages, fmtVienna, fmtUtc } from './model.js';
import { counterAfterImport } from './numbering.js';

export const BACKUP_FORMAT = 'oe1ebg-notfunk-backup';
export const BACKUP_VERSION = 1;

function csvField(v, sep) {
  const s = String(v ?? '');
  return s.includes(sep) || /["\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function partyLabel(p) {
  return [p.name, p.call && p.call !== p.name ? p.call : ''].filter(Boolean).join(' / ');
}

// Datum/Uhrzeit in Vienna local time as on the staff forms; utc column too.
function splitVienna(iso) {
  const s = fmtVienna(iso); // "05.10.2026 14:07 MESZ"
  const [date, time, zone] = s.split(' ');
  return { date, time: `${time} ${zone}` };
}

export const GB_COLUMNS = [
  'GZ', 'Datum', 'Uhrzeit', 'UTC', 'Ein/Aus', 'eingegangen von / weitergeleitet an', 'Betreff', 'Inhalt',
  'Art', 'Priorität', 'Alarm', 'Übermittlung', 'Frequenz/Relais', 'Absender', 'Empfänger', 'Verteiler',
  'Status', 'Antwort auf', 'Standort', 'Bearbeiter', 'Anmerkungen',
];

export function toGeschaeftsbuchCSV(msgs, sep = ';') {
  const byId = new Map(msgs.map(m => [m.id, m]));
  const rows = [GB_COLUMNS];
  for (const m of liveMessages(msgs)) {
    const { date, time } = splitVienna(m.ts);
    rows.push([
      m.number, date, time, fmtUtc(m.ts), DIRECTIONS[m.direction],
      partyLabel(m.direction === 'in' ? m.from : m.to), m.subject, m.text,
      MESSAGE_TYPES[m.type], PRIORITIES[m.priority], m.alarm ? 'Stab herhören!' : '', CHANNELS[m.channel],
      [m.radio.freq, m.radio.via].filter(Boolean).join(' via '), partyLabel(m.from), partyLabel(m.to), m.distribution.join(', '),
      STATUS_LABELS[currentStatus(m)], m.replyTo ? byId.get(m.replyTo)?.number || '' : '',
      m.location ? m.location.label || `${m.location.lat}, ${m.location.lon}` : '', m.operator, m.remarks,
    ]);
  }
  return '﻿' + rows.map(r => r.map(v => csvField(v, sep)).join(sep)).join('\r\n') + '\r\n';
}

export function toBackup({ operation, messages, revisions, counters }, now) {
  return JSON.stringify({
    format: BACKUP_FORMAT, version: BACKUP_VERSION, exported: now,
    operation, messages, revisions, counters,
  }, null, 1);
}

// Parsed backup or an Error message (German) for the UI.
export function parseBackup(json) {
  let d;
  try {
    d = JSON.parse(json);
  } catch {
    throw new Error('Keine gültige JSON-Datei');
  }
  if (d?.format !== BACKUP_FORMAT) throw new Error('Keine Notfunk-Sicherung');
  if (d.version > BACKUP_VERSION) throw new Error('Sicherung stammt von einer neueren Version des Werkzeugs');
  for (const k of ['messages', 'revisions', 'counters']) if (!Array.isArray(d[k])) throw new Error(`Sicherung unvollständig (${k})`);
  if (!d.operation?.id) throw new Error('Sicherung unvollständig (operation)');
  return d;
}

// Writes for restoring a backup into an existing database. Records are
// matched by id; an existing record is only replaced by a newer one
// (`updated`), so restoring an old backup never undoes later edits or
// deletes. Counters never go down. Messages that clash with a stored
// message's number but have another id are reported, not written.
// Returns { ops: [{ store, put }], added, updated, conflicts: [number] }.
export function mergeBackup(backup, existing) {
  const opId = backup.operation.id;
  const ops = [];
  const have = new Map(existing.messages.map(m => [m.id, m]));
  const byNumber = new Map(existing.messages.map(m => [m.number, m]));
  let added = 0, updated = 0;
  const conflicts = [];
  const taken = [];
  if (!existing.operation) ops.push({ store: 'operations', put: backup.operation });
  for (const m of backup.messages) {
    if (m.eventId !== opId) continue;
    const old = have.get(m.id);
    if (!old) {
      const clash = byNumber.get(m.number);
      if (clash) { conflicts.push(m.number); continue; }
      ops.push({ store: 'messages', put: m });
      taken.push(m);
      added++;
    } else if ((m.updated || '') > (old.updated || '')) {
      ops.push({ store: 'messages', put: { ...m, prefix: old.prefix, seq: old.seq, number: old.number } });
      updated++;
    }
  }
  const haveRev = new Set(existing.revisions.map(r => r.id));
  for (const r of backup.revisions) if (r.eventId === opId && !haveRev.has(r.id)) ops.push({ store: 'revisions', put: r });
  const counters = counterAfterImport(existing.counters, [...existing.messages, ...taken], opId);
  for (const c of counterAfterImport(counters, backup.counters.map(c => ({ eventId: c.eventId, prefix: c.prefix, seq: c.last })), opId)) {
    ops.push({ store: 'counters', put: c });
  }
  return { ops, added, updated, conflicts };
}
