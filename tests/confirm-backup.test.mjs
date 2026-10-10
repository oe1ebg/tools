// Backup validation and import planning of the confirmation log (issue #10).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BACKUP_FORMAT, validateBackup, planBackupImport } from '../tools/confirm/js/backup.js';

const T = '2026-10-04T16:00:00.000Z';
const entry = (id, eventId, seq, extra = {}) => ({ id, eventId, seq, call: `OE1A${seq}`, ts: T, created: T, updated: T, deleted: null, ...extra });
const item = (id, entries = [], revisions = [], extra = {}) => ({
  event: { id, title: `Log ${id}`, created: T, updated: T, nextSeq: entries.length + 1, ...extra }, entries, revisions,
});
const backup = (...events) => ({ format: BACKUP_FORMAT, version: 1, exported: T, events });
const rev = (id, eventId, entryId, data) => ({ id, eventId, entryId, savedAt: T, reason: 'edit', data });

// has() as the app provides it, over sets of stored ids.
function fakeStore(initial = {}) {
  const m = { events: new Set(initial.events || []), entries: new Set(initial.entries || []), revisions: new Set(initial.revisions || []) };
  return async (store, id) => m[store].has(id);
}
let n = 0;
const fresh = () => `new-${++n}`;

test('a well-formed backup, also an old one without optional fields, validates', () => {
  const ok = backup(item('e1', [entry('a', 'e1', 1), { id: 'k', kind: 'comment', ts: T, text: 'x' }], [rev('r', 'e1', 'a', entry('a', 'e1', 1))]));
  assert.deepEqual(validateBackup(ok), { ok: true, errors: [] });
  // no eventId on lines, no revisions, no nextSeq
  const old = backup({ event: { id: 'e', title: 't' }, entries: [{ id: 'a', seq: 1, call: 'OE1X', ts: T }] });
  assert.equal(validateBackup(old).ok, true);
});

test('not a backup / unsupported version', () => {
  assert.equal(validateBackup(null).notBackup, true);
  assert.equal(validateBackup({ format: 'other', events: [] }).notBackup, true);
  assert.equal(validateBackup({ format: BACKUP_FORMAT, events: {} }).notBackup, true);
  const v = validateBackup({ format: BACKUP_FORMAT, version: 2, events: [] });
  assert.equal(v.ok, false);
  assert.match(v.errors[0], /Version 2 wird nicht unterstützt/);
  assert.equal(validateBackup({ format: BACKUP_FORMAT, events: [] }).ok, false);
});

test('malformed events, lines and revisions are reported', () => {
  const cases = [
    [backup({}), /Log-Daten fehlen/],
    [backup({ event: { title: 'x' } }), /Kennung/],
    [backup({ event: { id: 5 } }), /Kennung/],
    [backup(item('e', [], [], { title: 7 })), /Titel/],
    [backup(item('e', [], [], { nextSeq: 0 })), /nächste Nummer/],
    [backup(item('e', [], [], { created: 'gestern' })), /Zeitstempel/],
    [backup(item('e', [entry('a', 'e', 1, { ts: 'nope' })])), /Zeit fehlt oder ist ungültig/],
    [backup(item('e', [entry('a', 'e', 1, { ts: undefined })])), /Zeit fehlt/],
    [backup(item('e', [entry('a', 'e', 1), entry('a', 'e', 2)])), /doppelt/],
    [backup(item('e', [entry('a', 'e', 1), entry('b', 'e', 1)])), /Nummer 1 kommt doppelt/],
    [backup(item('e', [entry('a', 'e', 'x')])), /Nummer/],
    [backup(item('e', [entry('a', 'e', 1, { call: '' })])), /Rufzeichen/],
    [backup(item('e', [entry('a', 'other', 1)])), /anderen Log/],
    [backup(item('e', [entry(7, 'e', 1)])), /Kennung/],
    [backup(item('e', [entry('a', 'e', 1, { kind: 'weird' })])), /unbekannte Art/],
    [backup(item('e', [entry('a', 'e', 1)], [rev('r', 'e', 'missing')])), /nicht in diesem Log/],
    [backup(item('e', [entry('a', 'e', 1)], [rev('r', 'other', 'a')])), /anderen Log/],
    [backup(item('e', [entry('a', 'e', 1)], [rev('r', 'e', 'a'), rev('r', 'e', 'a')])), /doppelt/],
    [backup(item('e', [entry('a', 'e', 1)], [{ ...rev('r', 'e', 'a'), savedAt: 'x' }])), /Zeitstempel/],
  ];
  for (const [data, re] of cases) {
    const r = validateBackup(data);
    assert.equal(r.ok, false, String(re));
    assert.ok(r.errors.some(m => re.test(m)), `${re} in ${JSON.stringify(r.errors)}`);
  }
});

test('import: a fresh log keeps its ids', async () => {
  const data = backup(item('e1', [entry('a', 'e1', 1)], [rev('r', 'e1', 'a', entry('a', 'e1', 1))]));
  const plan = await planBackupImport(data, fakeStore(), fresh);
  assert.equal(plan.copies, 0);
  assert.deepEqual(plan.puts.map(p => [p.store, p.value.id]), [['events', 'e1'], ['entries', 'a'], ['revisions', 'r']]);
});

test('import: a line id that exists in another log makes a copy; the other log is untouched', async () => {
  // fresh event id, but the entry id is taken (the reproduced overwrite)
  const data = backup(item('evNew', [entry('a', 'evNew', 1)], [rev('r', 'evNew', 'a', entry('a', 'evNew', 1))]));
  const plan = await planBackupImport(data, fakeStore({ entries: ['a'] }), fresh);
  assert.equal(plan.copies, 1);
  const ev = plan.puts[0].value;
  assert.notEqual(ev.id, 'evNew');
  assert.match(ev.title, /\(Import\)$/);
  const [, e, r] = plan.puts.map(p => p.value);
  assert.notEqual(e.id, 'a');
  assert.equal(e.eventId, ev.id);
  assert.equal(r.entryId, e.id, 'revision follows its line');
  assert.equal(r.eventId, ev.id);
  assert.equal(r.data.id, e.id, 'saved old version points to the new line');
  assert.equal(r.data.eventId, ev.id);
  assert.equal(r.data.call, 'OE1A1', 'revision content is preserved');
  assert.ok(!plan.puts.some(p => p.store === 'entries' && p.value.id === 'a'));
});

test('import: a revision id that exists makes a copy', async () => {
  const data = backup(item('evNew', [entry('a', 'evNew', 1)], [rev('r', 'evNew', 'a')]));
  const plan = await planBackupImport(data, fakeStore({ revisions: ['r'] }), fresh);
  assert.equal(plan.copies, 1);
  assert.ok(plan.puts.every(p => p.store !== 'revisions' || p.value.id !== 'r'));
});

test('import: duplicate events within one file do not overwrite each other', async () => {
  const data = backup(item('e1', [entry('a', 'e1', 1)]), item('e1', [entry('b', 'e1', 1)]));
  const plan = await planBackupImport(data, fakeStore(), fresh);
  assert.equal(plan.imported, 2);
  assert.equal(plan.copies, 1);
  const ids = plan.puts.filter(p => p.store === 'events').map(p => p.value.id);
  assert.equal(new Set(ids).size, 2);
});

test('import: entry ids reused across events of one file', async () => {
  const data = backup(item('e1', [entry('a', 'e1', 1)]), item('e2', [entry('a', 'e2', 1)]));
  const plan = await planBackupImport(data, fakeStore(), fresh);
  assert.equal(plan.copies, 1);
  const eids = plan.puts.filter(p => p.store === 'entries').map(p => p.value.id);
  assert.equal(new Set(eids).size, 2);
  const [, , , e2] = plan.puts.map(p => p.value);
  assert.equal(e2.eventId, plan.puts[2].value.id);
});

test('import: copies keep soft deletes, comments and a nextSeq above every line', async () => {
  const lines = [entry('a', 'e1', 1, { deleted: T }), entry('b', 'e1', 5), { id: 'k', eventId: 'e1', kind: 'comment', ts: T, text: 'hi' }];
  const data = backup(item('e1', lines, [], { nextSeq: 2 }));
  const plan = await planBackupImport(data, fakeStore({ events: ['e1'] }), fresh);
  const out = plan.puts.map(p => p.value);
  assert.equal(out[0].nextSeq, 6, 'repaired');
  assert.equal(out[1].deleted, T);
  assert.equal(out[2].seq, 5);
  assert.equal(out[3].kind, 'comment');
});
