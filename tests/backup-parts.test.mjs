// Backups beyond the import limits (issue #15 review): the tools' own export
// must always be restorable, so it is written in parts that are imported
// together, losslessly and in one atomic write.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupParts, partFileName, utf8Length } from '../tools/shared/js/backup-parts.js';
import { BACKUP_FORMAT, BACKUP_MAX_BYTES, BACKUP_MAX_RECORDS, validateBackup, planBackupImport, backupTexts, combineBackupParts } from '../tools/confirm/js/backup.js';
import { toBackup, toBackupTexts, parseBackup, combineBackupParts as nfCombine, mergeBackup, BACKUP_MAX_BYTES as NF_BYTES, BACKUP_MAX_RECORDS as NF_RECORDS } from '../tools/notfunk/js/export.js';
import { newMessage, editMessage, MESSAGE_TEXT_MAX, messageFields } from '../tools/notfunk/js/model.js';
import { formatNumber, counterKey } from '../tools/notfunk/js/numbering.js';

const T = '2026-10-04T16:00:00.000Z';
const named = texts => texts.map((text, i) => ({ name: partFileName('x', i + 1, texts.length), data: JSON.parse(text) }));

test('part files: names, grouping, missing and mixed parts', () => {
  assert.equal(partFileName('a_sicherung', 2, 3), 'a_sicherung_teil-2-von-3.json');
  const f = (set, n, of) => ({ name: `f${set}${n}`, data: { part: { set, n, of } } });
  const single = { name: 's', data: { format: 'x' } };
  const g = groupParts([f('A', 2, 2), single, f('A', 1, 2)]);
  assert.deepEqual(g.sets.map(s => s.files.map(x => x.part.n)), [[1, 2]]);
  assert.equal(g.singles.length, 1);
  assert.deepEqual(g.errors, []);
  const miss = groupParts([f('A', 2, 3), f('A', 1, 3)]);
  assert.equal(miss.sets.length, 0);
  assert.match(miss.errors[0], /fehlen die Teile 3/);
  assert.match(groupParts([f('A', 1, 2), f('A', 1, 2)]).errors[0], /mehrfach/);
  assert.match(groupParts([{ name: 'k', data: { part: { set: 'A', n: 5, of: 2 } } }]).errors[0], /ungültige Teil-Angabe/);
});

// ---- Notfunk: 1100 messages of 50000 characters (a valid, normally saved log) = ~56 MB
const OP = { id: 'op1', name: 'Übung', prefix: 'W1', created: T, updated: T };
const fields = text => messageFields({
  direction: 'in', ts: T, channel: 'funk', radio: { freq: '145.500' }, peer: 'OE1ABC',
  from: { name: 'Lichtinsel 3' }, to: { name: 'Stab' }, subject: 'Wasser', text,
});
const msg = (i, text) => newMessage(fields(text), { prefix: 'W1', seq: i, number: formatNumber('W1', i) }, { id: `b${i}`, opId: 'op1', operator: 'OE1EBG', stationCall: 'OE1XKS', now: T });

test('notfunk: a backup of 1100 messages x 50000 characters is exported in parts and restores completely', () => {
  const messages = [];
  const revisions = [];
  for (let i = 1; i <= 1100; i++) {
    let m = msg(i, 'x'.repeat(MESSAGE_TEXT_MAX));
    if (i % 100 === 0) {
      const e = editMessage(m, { staffRef: `GZ ${i}` }, { revisionId: `r${i}`, operator: 'OE1EBG', now: '2026-10-04T17:00:00.000Z' });
      m = e.next;
      revisions.push(e.revision);
    }
    messages.push(m);
  }
  const data = { operation: OP, messages, revisions, counters: [{ id: counterKey('op1', 'W1'), eventId: 'op1', prefix: 'W1', last: 1100 }] };
  assert.ok(utf8Length(toBackup(data, T)) > NF_BYTES, 'the single file is beyond the import limit');
  const texts = toBackupTexts(data, T, 'set-1');
  assert.ok(texts.length >= 2);
  for (const t of texts) {
    assert.ok(utf8Length(t) <= NF_BYTES);
    assert.doesNotThrow(() => parseBackup(t)); // each part is a valid file of its own
  }
  const g = groupParts(named(texts));
  assert.deepEqual(g.errors, []);
  assert.equal(g.sets.length, 1);
  const back = nfCombine(g.sets[0].files.map(f => f.data));
  assert.equal(back.messages.length, 1100);
  assert.equal(back.revisions.length, 11);
  assert.deepEqual(back.dropped, []);
  assert.deepEqual(back.counters.map(c => c.last), [1100]);
  const r = mergeBackup(back, { operation: null, messages: [], revisions: [], counters: [] });
  assert.equal(r.added, 1100);
  assert.deepEqual(r.conflicts.concat(r.unlinked), []);
  assert.equal(r.ops.filter(o => o.store === 'revisions').length, 11);
  assert.equal(r.ops.find(o => o.store === 'counters').put.last, 1100);
  // ids and content are exactly the exported ones
  const put = new Map(r.ops.filter(o => o.store === 'messages').map(o => [o.put.id, o.put]));
  assert.deepEqual(messages.map(m => put.get(m.id)), messages);
  // a missing part is an error, nothing is combined
  assert.match(groupParts(named(texts).slice(1)).errors[0], /fehlen die Teile 1/);
  // a small backup stays one file without `part`
  const small = toBackupTexts({ ...data, messages: messages.slice(0, 3), revisions: [] }, T, 's');
  assert.equal(small.length, 1);
  assert.equal(JSON.parse(small[0]).part, undefined);
});

test('notfunk: more records than one file accepts are split and restored', () => {
  const base = msg(1, 'Kein Wasser.');
  const revisions = Array.from({ length: NF_RECORDS + 1 }, (_, i) => ({ id: `r${i}`, eventId: 'op1', messageId: 'b1', at: T, by: 'X', old: base }));
  const data = { operation: OP, messages: [base], revisions, counters: [{ id: counterKey('op1', 'W1'), eventId: 'op1', prefix: 'W1', last: 1 }] };
  assert.throws(() => parseBackup(toBackup(data, T)), /nicht importiert/);
  const texts = toBackupTexts(data, T, 's');
  assert.ok(texts.length >= 2);
  const back = nfCombine(named(texts).map(f => f.data));
  assert.equal(back.revisions.length, NF_RECORDS + 1);
  assert.equal(back.messages.length, 1);
  assert.deepEqual(back.dropped, []);
});

// ---- Confirm
const entry = (id, seq, extra = {}) => ({ id, eventId: 'e1', seq, call: `OE1A${seq}`, ts: T, created: T, updated: T, deleted: null, ...extra });
const ev = { id: 'e1', title: 'Netz', created: T, updated: T, nextSeq: 0 };

test('confirm: a log beyond the record limit is exported in parts and restored with all ids and revisions', () => {
  const entries = Array.from({ length: BACKUP_MAX_RECORDS + 1 }, (_, i) => entry(`a${i}`, i + 1));
  const revisions = [{ id: 'r1', eventId: 'e1', entryId: 'a0', savedAt: T, reason: 'edit', data: entries[0] }];
  const ev2 = { event: { id: 'e2', title: 'Leer', created: T, updated: T }, entries: [], revisions: [] };
  const events = [{ event: { ...ev, nextSeq: entries.length + 1 }, entries, revisions }, ev2];
  const texts = backupTexts(events, T, 'set-2');
  assert.ok(texts.length >= 2);
  for (const t of texts) assert.ok(validateBackup(JSON.parse(t), 20, { fileOnly: true }).ok);
  const g = groupParts(named(texts));
  assert.deepEqual(g.errors, []);
  const c = combineBackupParts(g.sets[0].files.map(f => f.data));
  assert.equal(c.errors, undefined);
  assert.equal(c.data.part, undefined);
  assert.equal(c.data.events.length, 2);
  const check = validateBackup(c.data, 20, { combined: true });
  assert.equal(check.ok, true);
  assert.deepEqual(check.warnings, []);
  assert.equal(validateBackup(c.data).ok, false); // as one file it would still be refused
  let n = 0;
  const plan = planBackupImport(c.data, { events: new Set(), entries: new Set(), revisions: new Set() }, () => `n${n++}`);
  assert.equal(plan.puts.filter(p => p.store === 'entries').length, entries.length);
  assert.equal(plan.puts.filter(p => p.store === 'revisions').length, 1);
  assert.equal(plan.copies, 0); // same ids as exported
  assert.deepEqual(plan.puts.filter(p => p.store === 'entries').map(p => p.value.id), entries.map(e => e.id));
  assert.equal(plan.puts.find(p => p.store === 'events' && p.value.id === 'e1').value.nextSeq, entries.length + 1);
});

test('confirm: notes beyond the file size limit are split; a small backup stays one file', () => {
  const entries = Array.from({ length: 130 }, (_, i) => entry(`a${i}`, i + 1, { note: 'n'.repeat(400000) }));
  const texts = backupTexts([{ event: ev, entries, revisions: [] }], T, 'set-3');
  assert.ok(texts.length >= 2);
  for (const t of texts) assert.ok(utf8Length(t) <= BACKUP_MAX_BYTES);
  const c = combineBackupParts(named(texts).map(f => f.data));
  assert.deepEqual(c.data.events[0].entries.map(e => e.id), entries.map(e => e.id));
  assert.equal(c.data.events[0].entries[5].note, entries[5].note);
  const small = backupTexts([{ event: ev, entries: entries.slice(0, 2), revisions: [] }], T, 's');
  assert.equal(small.length, 1);
  assert.equal(JSON.parse(small[0]).format, BACKUP_FORMAT);
  assert.equal(JSON.parse(small[0]).part, undefined);
  // a part of another format is refused
  assert.ok(combineBackupParts([{ format: 'x', events: [] }, { format: 'x', events: [] }]).errors);
});
