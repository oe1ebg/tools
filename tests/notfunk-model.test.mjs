// Emergency traffic log: data model and exports (tools/notfunk/js/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  newMessage, editMessage, softDelete, setStatus, currentStatus, validateMessage, messageFields,
  filterMessages, repliesTo, fmtVienna, fmtUtc, statusEntry, statusLabel, addAttempt, announceAlarm,
} from '../tools/notfunk/js/model.js';
import { toGeschaeftsbuchCSV, toBackup, parseBackup, mergeBackup, GB_COLUMNS } from '../tools/notfunk/js/export.js';
import { formatNumber } from '../tools/notfunk/js/numbering.js';

const T0 = '2026-10-05T12:07:00.000Z';
const base = {
  direction: 'in', ts: T0, channel: 'funk', radio: { freq: '145.500', via: 'oe1xuu' },
  from: { name: 'Lichtinsel Floridsdorf', call: 'oe1abc' }, to: { name: 'Einsatzleitstelle' },
  subject: 'Stromausfall', text: 'Seit 13:50 Uhr kein Strom\nim Bereich Am Spitz.  Bitte um Info.',
};
let k = 0;
function msg(fields = {}, seq = ++k, operator = 'oe1xyz') {
  return newMessage({ ...base, ...fields }, { prefix: 'W1', seq, number: formatNumber('W1', seq) }, { id: `m${seq}`, opId: 'op1', operator, now: T0 });
}

test('newMessage: normalised, verbatim text, initial status', () => {
  const m = msg({}, 1);
  assert.equal(m.number, 'W1-001');
  assert.equal(m.eventId, 'op1');
  assert.equal(m.from.call, 'OE1ABC');
  assert.equal(m.radio.via, 'OE1XUU');
  assert.equal(m.text, 'Seit 13:50 Uhr kein Strom\nim Bereich Am Spitz.  Bitte um Info.');
  assert.equal(m.operator, 'OE1XYZ');
  assert.equal(currentStatus(m), 'logged');
  assert.equal(m.priority, 'routine');
  assert.equal(m.deleted, null);
});

test('validation: essentials only', () => {
  assert.deepEqual(validateMessage(messageFields(base)), []);
  const errs = validateMessage(messageFields({ ...base, direction: 'x', ts: '5.10.', from: {}, to: {}, subject: '', text: ' ', priority: 'blitz' }));
  assert.equal(errs.length, 6);
  assert.throws(() => msg({ to: {} }), /Adressat fehlt/);
});

test('edit keeps the number and stores the old version', () => {
  const m = msg({}, 2);
  const { next, revision } = editMessage(m, { subject: 'Stromausfall Am Spitz', number: 'W1-999', seq: 999 }, { revisionId: 'r1', operator: 'oe1def', now: '2026-10-05T12:30:00.000Z' });
  assert.equal(next.number, 'W1-002');
  assert.equal(next.seq, 2);
  assert.equal(next.subject, 'Stromausfall Am Spitz');
  assert.equal(next.editedBy, 'OE1DEF');
  assert.equal(revision.old.subject, 'Stromausfall');
  assert.equal(revision.messageId, m.id);
});

test('status: each step once, the handover never goes back', () => {
  let m = msg({}, 3);
  m = setStatus(m, 'forwarded', { operator: 'a', now: T0 });
  m = setStatus(m, 'answered', { operator: 'a', now: T0, note: 'siehe W1-004' });
  assert.equal(currentStatus(m), 'answered');
  assert.equal(m.status.length, 3);
  assert.throws(() => setStatus(m, 'forwarded', { operator: 'a', now: T0 }), /zurückgesetzt/);
  assert.throws(() => setStatus(m, 'answered', { operator: 'a', now: T0 }), /zurückgesetzt/);
  // the takeover can still be recorded after a reply; handing over after it can't
  const ack = setStatus(m, 'acknowledged', { operator: 'a', now: T0 });
  assert.equal(currentStatus(ack), 'answered');
  assert.throws(() => setStatus(setStatus(msg({}, 9), 'acknowledged', { operator: 'a', now: T0 }), 'forwarded', { operator: 'a', now: T0 }), /zurückgesetzt/);
  assert.throws(() => setStatus(m, 'nope', { operator: 'a', now: T0 }), /unbekannt/);
});

test('status steps keep who and when; the words depend on the direction', () => {
  let m = msg({}, 4);
  m = setStatus(m, 'forwarded', { operator: 'oe1ebg', now: T0, at: '2026-10-05T12:00:00.000Z', to: 'Meldesammelstelle' });
  assert.deepEqual(statusEntry(m, 'forwarded'), { state: 'forwarded', at: '2026-10-05T12:00:00.000Z', recorded: T0, by: 'OE1EBG', to: 'Meldesammelstelle', who: '', note: '' });
  assert.throws(() => setStatus(m, 'acknowledged', { operator: 'a', now: T0, at: '14:00' }), /Zeitpunkt/);
  assert.equal(statusLabel('acknowledged', 'in'), 'übernommen');
  assert.equal(statusLabel('logged', 'out'), 'zur Übertragung');
  assert.equal(statusLabel('acknowledged', 'out'), 'Empfang bestätigt');
  // an outgoing message read back at the transmission
  const out = setStatus(msg({ direction: 'out' }, 5), 'forwarded', { operator: 'a', now: T0, readBack: true });
  assert.equal(out.readBack, true);
  assert.equal(statusEntry(out, 'forwarded').readBack, true);
});

test('failed attempts and the announcement are logged, the status stays', () => {
  const m = addAttempt(msg({ direction: 'out' }, 6), { operator: 'a', now: T0, note: 'keine Antwort' });
  assert.equal(currentStatus(m), 'logged');
  assert.deepEqual(m.attempts.map(a => a.note), ['keine Antwort']);
  assert.throws(() => announceAlarm(m, { operator: 'a', now: T0 }), /nicht angefordert/);
  const al = announceAlarm(msg({ alarm: true }, 7), { operator: 'a', now: T0, note: 'LdS' });
  assert.deepEqual([al.alarm, al.alarmDone.at, al.alarmDone.note], [true, T0, 'LdS']);
});

test('the staff reference is kept apart from the number, an edit keeps the old one', () => {
  const m = msg({}, 8);
  assert.equal(m.staffRef, '');
  const { next, revision } = editMessage(m, { staffRef: ' GZ 0412 ' }, { revisionId: 'r', operator: 'a', now: T0 });
  assert.deepEqual([next.staffRef, next.number, revision.old.staffRef], ['GZ 0412', 'W1-008', '']);
  assert.deepEqual(filterMessages([next], { query: 'gz 0412' }).map(x => x.number), ['W1-008']);
});

test('filters, replies, deleted messages hidden', () => {
  const a = msg({ priority: 'emergency' }, 10);
  const b = msg({ direction: 'out', from: { name: 'ELS' }, to: { name: 'LI Floridsdorf' }, replyTo: 'm10', ts: '2026-10-05T12:20:00.000Z' }, 11);
  const c = softDelete(msg({}, 12), { operator: 'x', now: T0 });
  const all = [b, a, c];
  assert.deepEqual(filterMessages(all).map(m => m.number), ['W1-010', 'W1-011']);
  assert.deepEqual(filterMessages(all, { priority: 'emergency' }).map(m => m.number), ['W1-010']);
  assert.deepEqual(filterMessages(all, { direction: 'out' }).map(m => m.number), ['W1-011']);
  assert.deepEqual(filterMessages(all, { query: 'am spitz' }).map(m => m.number), ['W1-010', 'W1-011']);
  assert.deepEqual(filterMessages([setStatus(a, 'acknowledged', { operator: 'x', now: T0 }), b], { open: true }).map(m => m.number), ['W1-011']);
  assert.deepEqual(repliesTo(all, 'm10').map(m => m.number), ['W1-011']);
});

test('time formats: Vienna local with zone, and UTC', () => {
  assert.equal(fmtVienna(T0), '05.10.2026 14:07 MESZ');
  assert.equal(fmtVienna('2026-01-05T12:07:00Z'), '05.01.2026 13:07 MEZ');
  assert.equal(fmtUtc(T0), '05.10.2026 12:07 UTC');
  assert.equal(fmtVienna('x'), '');
});

test('Geschäftsbuch CSV', () => {
  const a = msg({ alarm: true, priority: 'priority' }, 20);
  const b = msg({ direction: 'out', from: { name: 'ELS' }, to: { name: 'LI Floridsdorf', call: 'OE1ABC' }, replyTo: 'm20', subject: 'Re; Strom' }, 21);
  const csv = toGeschaeftsbuchCSV([b, a, softDelete(msg({}, 22), { operator: 'x', now: T0 })]);
  assert.ok(csv.startsWith('﻿Notfunk-Nr.;Referenz Meldesammelstelle;Datum;Uhrzeit;UTC;Ein/Aus;'));
  const lines = csv.slice(1).trimEnd().split('\r\n');
  assert.equal(lines[0].split(';').length, GB_COLUMNS.length);
  assert.match(lines[1], /^W1-020;;05\.10\.2026;14:07 MESZ;05\.10\.2026 12:07 UTC;Eingang;Lichtinsel Floridsdorf \/ OE1ABC;Stromausfall;"Seit 13:50 Uhr kein Strom\nim Bereich Am Spitz\.  Bitte um Info\.";Meldung;Dringend;angefordert;Funk;;145,500 via OE1XUU;/);
  assert.match(lines.slice(2).join('\n'), /^W1-021;;.*;Ausgang;LI Floridsdorf \/ OE1ABC;"Re; Strom";/m);
  assert.match(lines.slice(2).join('\n'), /;zur Übertragung;;;;Antwort auf W1-020;;OE1XYZ;05\.10\.2026 14:07 MESZ;$/m);
  assert.ok(!csv.includes('W1-022'), 'deleted messages are not in the Geschäftsbuch');
});

test('backup round trip and merge: no lost edits, counters never go down', () => {
  const op = { id: 'op1', name: 'Blackout-Übung' };
  const m1 = msg({}, 30), m2 = msg({}, 31);
  const json = toBackup({ operation: op, messages: [m1, m2], revisions: [], counters: [{ id: 'op1:W1', eventId: 'op1', prefix: 'W1', last: 31 }] }, T0);
  const b = parseBackup(json);
  assert.equal(b.messages.length, 2);
  for (const bad of ['{', '{"format":"x"}', JSON.stringify({ format: 'oe1ebg-notfunk-backup', version: 99 })]) assert.throws(() => parseBackup(bad));

  // into an empty database: everything added
  const empty = mergeBackup(b, { operation: null, messages: [], revisions: [], counters: [] });
  assert.equal(empty.added, 2);
  assert.deepEqual(empty.ops.find(o => o.store === 'counters').put, { id: 'op1:W1', eventId: 'op1', prefix: 'W1', last: 31 });

  // into a database that went on: m1 edited later, W1 at 40, a clash on W1-031
  const m1later = { ...m1, subject: 'neuer', updated: '2026-10-05T13:00:00.000Z' };
  const other = { ...m2, id: 'other-device' };
  const r = mergeBackup(b, { operation: op, messages: [m1later, other], revisions: [], counters: [{ id: 'op1:W1', eventId: 'op1', prefix: 'W1', last: 40 }] });
  assert.equal(r.added, 0);
  assert.equal(r.updated, 0, 'older backup never overwrites a later edit');
  assert.deepEqual(r.conflicts, ['W1-031']);
  assert.deepEqual(r.ops.filter(o => o.store === 'counters').map(o => o.put.last), [40]);
  assert.ok(!r.ops.some(o => o.store === 'operations'));
});
