// Notfunk integrity (issue #11): validated backups, merge decisions and
// writes in one transaction, compare-and-set edits, a save whose parts stay
// together and can be retried, drafts of several tabs. On the real shared
// storage layer (Node has no IndexedDB: its localStorage fallback, the
// weaker backend; the IndexedDB path is covered by tests/e2e/notfunk.spec.mjs).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openToolStorage, ConflictError } from '../tools/shared/js/storage.js';
import { NOTFUNK_STORES } from '../tools/notfunk/js/db.js';
import { newMessage, editMessage, setStatus, currentStatus, softDelete, messageFields } from '../tools/notfunk/js/model.js';
import { toBackup, parseBackup, mergeBackup, MAX_SEQ } from '../tools/notfunk/js/export.js';
import { formatNumber, counterKey, numberGaps } from '../tools/notfunk/js/numbering.js';
import { saveNewMessage, updateMessage, applyBackup, changedFields, editBaseOf, editTarget, draftEditState, patchOperation, writeDraft, clearDraft } from '../tools/notfunk/js/ops.js';

class MemoryStorage {
  #m = new Map();
  get length() { return this.#m.size; }
  key(i) { return [...this.#m.keys()][i] ?? null; }
  getItem(k) { return this.#m.has(k) ? this.#m.get(k) : null; }
  setItem(k, v) { this.#m.set(k, String(v)); }
  removeItem(k) { this.#m.delete(k); }
}

const SCHEMA = { name: 'test', version: 1, lsPrefix: 'test:', stores: NOTFUNK_STORES, upgrade() {} };
let store;
beforeEach(async () => {
  globalThis.localStorage = new MemoryStorage();
  store = await openToolStorage(SCHEMA);
});

const T0 = '2026-10-05T12:07:00.000Z';
const T1 = '2026-10-05T12:30:00.000Z';
const OP = { id: 'op1', name: 'Übung', prefix: 'W1', created: T0, updated: T0 };
const fields = (extra = {}) => messageFields({
  direction: 'in', ts: T0, channel: 'funk', radio: { freq: '145.500' }, peer: 'OE1ABC',
  from: { name: 'Lichtinsel 3' }, to: { name: 'Stab' }, subject: 'Wasser', text: 'Kein Wasser.', ...extra,
});
const META = { operator: 'OE1EBG', stationCall: 'OE1XKS', now: T0 };
let n = 0;
const create = (op = OP, extra = {}) => saveNewMessage(store, { op, fields: fields(extra), messageId: `m${++n}`, meta: META });

// ---------------------------------------------------------------- backups

function backupOf(messages, extra = {}) {
  const counters = [...new Set(messages.map(m => m.prefix))].map(p => ({
    id: counterKey('op1', p), eventId: 'op1', prefix: p, last: Math.max(...messages.filter(m => m.prefix === p).map(m => m.seq)),
  }));
  return { format: 'oe1ebg-notfunk-backup', version: 1, exported: T0, operation: OP, messages, revisions: [], counters, ...extra };
}
const mk = (seq, extra = {}) => ({
  ...newMessage(fields(), { prefix: 'W1', seq, number: formatNumber('W1', seq) }, { id: `b${seq}`, opId: 'op1', ...META }), ...extra,
});
const parse = b => parseBackup(JSON.stringify(b));

test('parseBackup accepts a complete backup and its round trip', () => {
  const m = mk(1), m2 = mk(2, { replyTo: 'b1', refKind: 'antwort' });
  const rev = { id: 'r1', eventId: 'op1', messageId: 'b1', at: T1, by: 'X', old: m };
  const d = parse(backupOf([m, m2], { revisions: [rev] }));
  assert.equal(d.messages.length, 2);
  assert.equal(parseBackup(toBackup(d, T0)).revisions.length, 1);
});

test('parseBackup refuses a file with identity or ownership problems', () => {
  const ok = mk(1);
  const bads = {
    'bad prefix': { ...ok, prefix: 'w 1' },
    'seq 0': { ...ok, seq: 0, number: 'W1-000' },
    'seq not an integer': { ...ok, seq: 1.5 },
    'seq as text': { ...ok, seq: '1' },
    'seq too large': { ...ok, seq: MAX_SEQ + 1, number: `W1-${MAX_SEQ + 1}` },
    'number disagrees with seq': { ...ok, number: 'W1-002' },
    'other operation': { ...ok, eventId: 'op2' },
    'bad id': { ...ok, id: '../x' },
  };
  for (const [what, m] of Object.entries(bads)) assert.throws(() => parse(backupOf([m])), /Sicherung fehlerhaft/, what);
  assert.throws(() => parse(backupOf([ok, { ...mk(2), id: ok.id }])), /ID doppelt/);
  assert.throws(() => parse(backupOf([ok, { ...mk(2), id: 'b9', seq: 1, number: 'W1-001' }])), /Nummer doppelt/);
  for (const version of [0, '1', 1.5, undefined, 2]) assert.throws(() => parse({ ...backupOf([ok]), version }), /version|neueren/, String(version));
  const rev = { id: 'r1', eventId: 'op1', messageId: 'b1', at: T1, old: ok };
  assert.throws(() => parse(backupOf([ok], { revisions: [{ ...rev, eventId: 'op2' }] })), /anderen Einsatz/);
  assert.throws(() => parse({ ...backupOf([ok]), operation: { id: 'op1' } }), /Name/);
  assert.throws(() => parse({ ...backupOf([ok]), operation: { ...OP, id: 'a/b' } }), /operation/);
});

test('parseBackup leaves out records with semantic problems and restores the rest', () => {
  const ok = mk(1);
  const soft = {
    'no text': { ...mk(2), text: undefined },
    'no sender object': { ...mk(3), from: undefined },
    'no status': { ...mk(4), status: [] },
    'unknown status': { ...mk(5), status: [{ state: 'x', at: T0 }] },
    'no origin': { ...mk(6), origin: null },
    'bad ts': { ...mk(7), ts: '5.10.2026' },
    'impossible updated': { ...mk(8), updated: '2026-13-45T99:00:00Z' },
    'no sender and recipient': { ...mk(9), from: {}, to: {} },
  };
  const d = parse(backupOf([ok, ...Object.values(soft)]));
  assert.deepEqual(d.messages.map(m => m.id), ['b1']);
  assert.equal(d.dropped.length, Object.keys(soft).length);
  assert.deepEqual(d.droppedSeqs.map(x => x.seq), [2, 3, 4, 5, 6, 7, 8, 9], 'their numbers still count for the counters');
  // a message that is only a dangling reply stays (the target may be stored already)
  assert.equal(parse(backupOf([{ ...ok, replyTo: 'nowhere' }])).messages.length, 1);
  // revisions
  const rev = { id: 'r1', eventId: 'op1', messageId: 'b1', at: T1, old: ok };
  for (const bad of [{ messageId: 'zzz' }, { at: 'x' }, { old: null }]) {
    const r = parse(backupOf([ok], { revisions: [{ ...rev, ...bad }] }));
    assert.deepEqual([r.revisions.length, r.dropped.length], [0, 1], JSON.stringify(bad));
  }
  assert.equal(parse(backupOf([ok], { revisions: [rev, rev] })).revisions.length, 1);
  // counters
  const c = { id: 'op1:W1', eventId: 'op1', prefix: 'W1', last: 1 };
  for (const bad of [{ last: -1 }, { last: MAX_SEQ + 1 }, { last: 1e300 }, { last: '5' }, { last: NaN }, { prefix: 'a b' }, { eventId: 'op2' }, { id: 'op1:W2' }]) {
    const r = parse(backupOf([ok], { counters: [{ ...c, ...bad }] }));
    assert.deepEqual([r.counters.length, r.dropped.length], [0, 1], JSON.stringify(bad));
  }
  assert.equal(parse(backupOf([ok], { counters: [c, c] })).counters.length, 1);
});

test('mergeBackup: a reply whose target was not taken is not imported', () => {
  const target = mk(1), reply = { ...mk(2), replyTo: 'b1', refKind: 'antwort' };
  const clash = { ...target, id: 'stored' }; // W1-001 is taken by another id
  const r = mergeBackup(backupOf([target, reply]), { operation: OP, messages: [clash], revisions: [], counters: [] });
  assert.equal(r.added, 0);
  assert.deepEqual(r.conflicts, ['W1-001']);
  assert.deepEqual(r.unlinked, ['W1-002']);
  assert.ok(!r.ops.some(o => o.store === 'messages'));
  assert.equal(r.ops.find(o => o.store === 'counters').put.last, 2, 'the number is still spent');
});

test('mergeBackup: two incoming records with one number: only the first is taken', () => {
  const a = mk(1), b = { ...mk(2), id: 'b-other', seq: 1, number: 'W1-001' };
  const r = mergeBackup(backupOf([a, b]), { operation: null, messages: [], revisions: [], counters: [] });
  assert.equal(r.added, 1);
  assert.deepEqual(r.conflicts, ['W1-001']);
  assert.deepEqual(r.ops.filter(o => o.store === 'messages').map(o => o.put.id), ['b1']);
  // the same id twice
  const r2 = mergeBackup(backupOf([a, { ...a, subject: 'zweite' }]), { operation: null, messages: [], revisions: [], counters: [] });
  assert.equal(r2.added, 1);
  assert.equal(r2.conflicts.length, 1);
});

test('mergeBackup: an id that belongs to another operation is not taken', () => {
  const a = mk(1);
  const foreign = { ...a, eventId: 'op2', prefix: 'W2', number: 'W2-001' };
  const rev = { id: 'r1', eventId: 'op1', messageId: 'b1', at: T1, old: a };
  const r = mergeBackup(backupOf([a], { revisions: [rev] }), { operation: OP, messages: [], revisions: [], counters: [], allMessages: [foreign], allRevisions: [] });
  assert.equal(r.added, 0);
  assert.deepEqual(r.conflicts, ['W1-001']);
  assert.ok(!r.ops.some(o => o.store === 'messages'));
  assert.ok(!r.ops.some(o => o.store === 'revisions'), 'a revision of a message that was not taken is dropped too');
});

test('applyBackup: decides and writes in one transaction, ids are global, counters never go down', async () => {
  await store.tx([{ store: 'operations', put: { ...OP, id: 'op2', name: 'Andere' } }]);
  const foreign = { ...mk(1), eventId: 'op2', prefix: 'W2', number: 'W2-001', id: 'b1', subject: 'bleibt' };
  await store.tx([{ store: 'messages', put: foreign }]);
  const r = await applyBackup(store, parse(backupOf([mk(1), mk(2)])));
  assert.deepEqual([r.added, r.conflicts], [1, ['W1-001']]);
  assert.equal((await store.get('messages', 'b1')).subject, 'bleibt', 'another operation\'s record is not overwritten');
  assert.equal((await store.get('messages', 'b1')).eventId, 'op2');
  assert.equal((await store.get('messages', 'b2')).eventId, 'op1');
  assert.equal((await store.get('operations', 'op1')).name, 'Übung');

  // a counter that went on after the backup stays
  await store.tx([{ store: 'counters', put: { id: 'op1:W1', eventId: 'op1', prefix: 'W1', last: 40 } }]);
  await applyBackup(store, parse(backupOf([mk(2)])));
  assert.equal((await store.get('counters', 'op1:W1')).last, 40);
});

test('applyBackup concurrently with a save: no number twice, counter at the highest', async () => {
  await store.tx([{ store: 'operations', put: OP }]);
  const incoming = parse(backupOf([mk(1), mk(2), mk(3)]));
  const results = await Promise.all([applyBackup(store, incoming), create(), create(), create()]);
  assert.ok(results.length);
  const all = await store.getByEvent('messages', 'op1');
  assert.deepEqual(numberGaps(all), []);
  assert.equal(new Set(all.map(m => m.number)).size, all.length, 'no number twice');
  assert.equal((await store.get('counters', 'op1:W1')).last, Math.max(...all.map(m => m.seq)));
});

// ---------------------------------------------------------------- compare-and-set

test('two tabs: a stale edit does not undo a handover, and nothing is written', async () => {
  const a = await create();
  const staleInTabA = a; // tab A starts editing
  const handed = await updateMessage(store, a, cur => ({ next: setStatus(cur, 'forwarded', { operator: 'OE1EBG', now: T1, to: 'Meldesammelstelle' }) }));
  const err = await updateMessage(store, staleInTabA, cur => editMessage(cur, { subject: 'Wasser dringend' }, { revisionId: 'rev1', operator: 'X', now: T1 }))
    .catch(e => e);
  assert.ok(err instanceof ConflictError);
  assert.equal(err.current.updated, handed.updated, 'the conflict carries the current record');
  const stored = await store.get('messages', a.id);
  assert.equal(currentStatus(stored), 'forwarded');
  assert.equal(stored.subject, 'Wasser');
  assert.deepEqual(await store.getByEvent('revisions', 'op1'), [], 'no revision of a refused edit');
});

test('after a conflict only the fields the user changed are applied to the current version', async () => {
  const a = await create();
  const opened = messageFields(a); // tab A opened this version
  // tab B changes the remarks
  const bEdit = await updateMessage(store, a, cur => editMessage(cur, { remarks: 'von B' }, { revisionId: 'rb', operator: 'B', now: T1 }));
  // tab A changed the subject only; the form holds the old remarks
  const form = { ...opened, subject: 'Wasser dringend' };
  const changes = changedFields(form, opened);
  assert.deepEqual(Object.keys(changes), ['subject']);
  await assert.rejects(updateMessage(store, a, cur => editMessage(cur, changes, { revisionId: 'ra', operator: 'A', now: T1 })), ConflictError);
  const saved = await updateMessage(store, bEdit, cur => editMessage(cur, changes, { revisionId: 'ra', operator: 'A', now: '2026-10-05T13:00:00.000Z' }));
  assert.equal(saved.subject, 'Wasser dringend');
  assert.equal(saved.remarks, 'von B', 'the other tab\'s change is kept');
  const revs = await store.getByEvent('revisions', 'op1');
  assert.equal(revs.find(r => r.id === 'ra').old.remarks, 'von B');
});

test('an edit stores the record it actually replaced as the revision', async () => {
  const a = await create();
  const handed = await updateMessage(store, a, cur => ({ next: setStatus(cur, 'forwarded', { operator: 'X', now: T1 }) }));
  const edited = await updateMessage(store, handed, cur => editMessage(cur, { subject: 'neu' }, { revisionId: 'rev1', operator: 'X', now: '2026-10-05T13:00:00.000Z' }));
  const [rev] = await store.getByEvent('revisions', 'op1');
  assert.deepEqual(rev.old, handed, 'the stored version before the edit, with the handover');
  assert.equal(currentStatus(edited), 'forwarded');
});

test('status, attempt, delete and restore are all compare-and-set', async () => {
  const a = await create();
  await updateMessage(store, a, cur => ({ next: setStatus(cur, 'forwarded', { operator: 'X', now: T1 }) }));
  for (const change of [
    cur => ({ next: setStatus(cur, 'acknowledged', { operator: 'X', now: T1 }) }),
    cur => ({ next: softDelete(cur, { operator: 'X', now: T1 }) }),
  ]) {
    await assert.rejects(updateMessage(store, a, change), ConflictError);
  }
  const stored = await store.get('messages', a.id);
  assert.equal(stored.deleted, null);
  assert.equal(currentStatus(stored), 'forwarded');
});

test('a record without `updated` (older data) can be changed once, then it has one', async () => {
  const a = await create();
  const { updated: _u, ...old } = a;
  await store.tx([{ store: 'messages', put: old }]);
  await updateMessage(store, old, cur => ({ next: setStatus(cur, 'forwarded', { operator: 'X', now: T1 }) }));
  await assert.rejects(updateMessage(store, old, cur => ({ next: setStatus(cur, 'acknowledged', { operator: 'X', now: T1 }) })), ConflictError);
});

test('patchOperation keeps the other fields another tab changed', async () => {
  await store.tx([{ store: 'operations', put: OP }]);
  await store.tx([{ store: 'operations', put: { ...OP, name: 'Umbenannt' } }]);
  await patchOperation(store, 'op1', { backupAt: T1 }, T1);
  const op = await store.get('operations', 'op1');
  assert.deepEqual([op.name, op.backupAt], ['Umbenannt', T1]);
});

// ---------------------------------------------------------------- the save

test('a reply and the "answered" status of its original are one transaction', async () => {
  const orig = await create();
  const faulty = {
    ...store,
    atomic: (names, fn) => store.atomic(names, api => fn({
      ...api,
      put: (s, v) => { if (s === 'messages' && v.status?.some(x => x.state === 'answered')) throw new Error('boom'); api.put(s, v); },
    })),
  };
  const reply = { op: OP, fields: fields({ replyTo: orig.id, refKind: 'antwort', refNumber: orig.number }), messageId: 'reply1', meta: META };
  await assert.rejects(saveNewMessage(faulty, reply), /boom/);
  assert.equal((await store.getByEvent('messages', 'op1')).length, 1, 'no reply');
  assert.equal((await store.get('counters', 'op1:W1')).last, 1, 'no number consumed');
  const saved = await saveNewMessage(store, reply);
  assert.equal(saved.number, 'W1-002');
  assert.equal(currentStatus(await store.get('messages', orig.id)), 'answered');
});

test('a retry after a partial success returns the committed message, not a new number', async () => {
  const first = await saveNewMessage(store, { op: OP, fields: fields(), messageId: 'draft-1', meta: META });
  // the later step (station completion) fails; the message is committed and the book shows it
  const stationsFail = { ...store, tx: ops => (ops.some(o => o.store === 'stations') ? Promise.reject(new Error('stations')) : store.tx(ops)) };
  await assert.rejects(stationsFail.tx([{ store: 'stations', put: { id: 'op1:OE1ABC', eventId: 'op1' } }]), /stations/);
  assert.deepEqual((await store.getByEvent('messages', 'op1')).map(m => m.number), ['W1-001']);
  // the retry with the same id
  const again = await saveNewMessage(store, { op: OP, fields: fields(), messageId: 'draft-1', meta: { ...META, now: T1 } });
  assert.deepEqual(again, first);
  assert.equal((await store.getByEvent('messages', 'op1')).length, 1);
  assert.equal((await store.get('counters', 'op1:W1')).last, 1);
  // another entry (another id) is numbered on
  assert.equal((await saveNewMessage(store, { op: OP, fields: fields(), messageId: 'draft-2', meta: META })).number, 'W1-002');
});

test('an id of another operation is never answered with its record', async () => {
  await create({ ...OP, id: 'op9', prefix: 'X1' });
  const id = (await store.getByEvent('messages', 'op9'))[0].id;
  await assert.rejects(saveNewMessage(store, { op: OP, fields: fields(), messageId: id, meta: META }), /anderen Einsatz/);
});

// ---------------------------------------------------------------- drafts

test('drafts: a second tab does not silently overwrite the first one\'s draft', async () => {
  const d = (text, saved) => ({ form: { text }, editingId: null, saved });
  const a1 = await writeDraft(store, 'op1', d('A', '2026-10-05T12:00:00.000Z'), undefined);
  // tab B read no draft earlier and starts typing
  const err = await writeDraft(store, 'op1', d('B', '2026-10-05T12:00:05.000Z'), undefined).catch(e => e);
  assert.ok(err instanceof ConflictError);
  assert.equal(err.current.form.text, 'A');
  assert.equal((await store.get('drafts', 'op1')).form.text, 'A');
  // A goes on with its own token
  const a2 = await writeDraft(store, 'op1', d('A2', '2026-10-05T12:00:10.000Z'), a1);
  assert.equal((await store.get('drafts', 'op1')).form.text, 'A2');
  // B's empty form doesn't remove A's draft
  assert.equal(await clearDraft(store, 'op1', undefined), false);
  assert.ok(await store.get('drafts', 'op1'));
  // B chooses to take over: with the token of the draft it is shown then (A's latest)
  await assert.rejects(writeDraft(store, 'op1', d('B', '2026-10-05T12:00:20.000Z'), err.actual), ConflictError, 'A has written since');
  await writeDraft(store, 'op1', d('B', '2026-10-05T12:00:20.000Z'), a2);
  assert.equal((await store.get('drafts', 'op1')).form.text, 'B');
  // A's token is stale now
  await assert.rejects(writeDraft(store, 'op1', d('A3', '2026-10-05T12:00:30.000Z'), a2), ConflictError);
  assert.equal(await clearDraft(store, 'op1', '2026-10-05T12:00:20.000Z'), true);
  assert.equal(await store.get('drafts', 'op1'), undefined);
});

test('drafts: one written before drafts carried `updated` is matched by null', async () => {
  await store.tx([{ store: 'drafts', put: { eventId: 'op1', form: { text: 'alt' }, editingId: null, saved: T0 } }]);
  await assert.rejects(writeDraft(store, 'op1', { form: {}, saved: T1 }, undefined), ConflictError);
  await writeDraft(store, 'op1', { form: { text: 'neu' }, saved: T1 }, null);
  assert.equal((await store.get('drafts', 'op1')).form.text, 'neu');
});

// ---------------------------------------------------------------- review follow-up

test('mergeBackup: a newer version with a missing, foreign or dropped reply target is not written', () => {
  const stored = mk(1), target = mk(2);
  const later = '2026-10-06T00:00:00.000Z';
  const existing = { operation: OP, messages: [stored, target], revisions: [], counters: [], allMessages: [stored, target, { ...mk(3), id: 'foreign', eventId: 'op2' }] };
  for (const replyTo of ['missing', 'foreign']) {
    const r = mergeBackup(backupOf([{ ...stored, subject: 'neu', updated: later, replyTo }]), existing);
    assert.deepEqual([r.updated, r.unlinked], [0, ['W1-001']], replyTo);
    assert.ok(!r.ops.some(o => o.store === 'messages'), 'the stored record stays');
  }
  // a target that is in the store is fine
  assert.equal(mergeBackup(backupOf([{ ...stored, subject: 'neu', updated: later, replyTo: 'b2' }]), existing).updated, 1);
  // a target that is rejected in this very import
  const clash = { ...mk(5), id: 'other-5', seq: 5, number: 'W1-005' };
  const r = mergeBackup(backupOf([{ ...mk(5), replyTo: 'b1' }, { ...stored, updated: later, replyTo: 'b5' }]), { ...existing, messages: [stored, target, clash], allMessages: [stored, target, clash] });
  assert.deepEqual([r.updated, r.unlinked.sort()], [0, ['W1-001']]);
});

test('every write of a record changes its token, also with an identical clock', async () => {
  const a = await create(); // updated = T0
  // two edits from the same version in the same millisecond: the second is stale
  const mk2 = subject => cur => editMessage(cur, { subject }, { revisionId: `r-${subject}`, operator: 'X', now: a.updated });
  const first = await updateMessage(store, a, mk2('eins'));
  assert.notEqual(first.updated, a.updated);
  await assert.rejects(updateMessage(store, a, mk2('zwei')), ConflictError);
  assert.equal((await store.get('messages', a.id)).subject, 'eins');
  // status steps with the same clock too
  const s1 = await updateMessage(store, first, cur => ({ next: setStatus(cur, 'forwarded', { operator: 'X', now: a.updated }) }));
  assert.ok(s1.updated > first.updated);
  await assert.rejects(updateMessage(store, first, cur => ({ next: softDelete(cur, { operator: 'X', now: a.updated }) })), ConflictError);
  // a clock set back
  const s2 = await updateMessage(store, s1, cur => ({ next: setStatus(cur, 'acknowledged', { operator: 'X', now: '2020-01-01T00:00:00.000Z' }) }));
  assert.ok(s2.updated > s1.updated);
});

test('drafts: tokens differ for writes in the same millisecond', async () => {
  const saved = T0;
  const t1 = await writeDraft(store, 'op1', { form: { text: 'A' }, saved }, undefined);
  await assert.rejects(writeDraft(store, 'op1', { form: { text: 'B' }, saved }, undefined), ConflictError);
  const t2 = await writeDraft(store, 'op1', { form: { text: 'A2' }, saved }, t1);
  assert.notEqual(t1, t2);
  await assert.rejects(writeDraft(store, 'op1', { form: { text: 'stale' }, saved }, t1), ConflictError, 'a writer with the old token is refused');
});

test('an edit draft keeps the version it was opened on: a change made meanwhile is a conflict, not reverted', async () => {
  const a = await create(OP, { text: 'old text' });
  // tab A opens the edit and changes the subject; its draft carries the base
  const base = editBaseOf(a);
  const formFields = { ...messageFields(a), subject: 'Neuer Betreff' };
  const token = await writeDraft(store, 'op1', { form: {}, editingId: a.id, base, saved: T1 }, undefined);
  // another tab changes the stored text
  const b = await updateMessage(store, a, cur => editMessage(cur, { text: 'new text from tab B' }, { revisionId: 'rb', operator: 'B', now: T1 }));
  // reload / draft transfer: the draft is read back, the message comes from the storage now
  const draft = await store.get('drafts', 'op1');
  assert.equal(draft.updated, token);
  const restored = editBaseOf(b, draft.base);
  assert.equal(restored.fields.text, 'old text');
  assert.equal(restored.updated, a.updated);
  const changes = changedFields(formFields, restored.fields);
  assert.deepEqual(Object.keys(changes), ['subject'], 'the form\'s old text is not an edit');
  let n2 = 0;
  const edit = (target, ch) => updateMessage(store, target, cur => editMessage(cur, ch, { revisionId: `rx${++n2}`, operator: 'A', now: '2026-10-05T14:00:00.000Z' }));
  const err = await edit(editTarget(b, restored), changes).catch(e => e);
  assert.ok(err instanceof ConflictError, 'stale baseline: refused');
  assert.equal((await store.get('messages', a.id)).subject, 'Wasser');
  // after the notice the token moves on, the baseline fields stay: only the subject goes in
  const rebased = { ...restored, updated: err.current.updated };
  const saved = await edit(editTarget(err.current, rebased), changes);
  assert.equal(saved.subject, 'Neuer Betreff');
  assert.equal(saved.text, 'new text from tab B');
  // without a saved base (older draft) the base is the message as stored
  assert.equal(editBaseOf(b, null).updated, b.updated);
  // a base of another message is not used
  assert.equal(editBaseOf(b, { ...base, id: 'other' }).id, b.id);
});

test('draftEditState: a draft without a base is never trusted, whatever the timestamps say', async () => {
  const a = await create();
  const draft = (saved, extra = {}) => ({ eventId: 'op1', form: {}, editingId: a.id, saved, ...extra });
  // opened 12:00, changed by another tab 12:01, the stale form autosaved 12:02: the message is OLDER than the draft
  const b = await updateMessage(store, a, cur => editMessage(cur, { text: 'von B' }, { revisionId: 'rb', operator: 'B', now: '2026-10-05T12:01:00.000Z' }));
  for (const saved of ['2026-10-05T12:02:00.000Z', b.updated, '2026-10-05T11:00:00.000Z', 'gestern', undefined]) {
    const st = draftEditState(b, draft(saved));
    assert.deepEqual([st.stale, st.gone, st.base.updated], [true, false, b.updated], String(saved));
  }
  // the message is gone
  const gone = draftEditState(undefined, draft('2026-10-05T13:00:00.000Z'));
  assert.deepEqual([gone.editing, gone.gone, gone.stale], [null, true, false]);
  // a draft with its base is not "stale" (a change since is a conflict at save); a base of another message isn't used
  const base = editBaseOf(a);
  assert.equal(draftEditState(b, draft('2026-10-05T13:00:00.000Z', { base })).base, base);
  assert.equal(draftEditState(b, draft('2026-10-05T13:00:00.000Z', { base })).stale, false);
  assert.equal(draftEditState(b, draft('2026-10-05T13:00:00.000Z', { base: { ...base, id: 'x' } })).stale, true);
  // not an edit draft
  assert.deepEqual(draftEditState(a, { form: {}, saved: T0 }), { editing: null, base: null, stale: false, gone: false });
  // the stale form (old text, new subject) differs from the current message in both fields: shown before anything is applied
  const mine = { ...messageFields(a), subject: 'Wasser dringend' };
  assert.deepEqual(Object.keys(changedFields(mine, messageFields(b))).sort(), ['subject', 'text']);
});

test('clearDraft: a newer draft written at the same time as the clear survives', async () => {
  const t1 = await writeDraft(store, 'op1', { form: { text: 'A' }, saved: T0 }, undefined);
  // both start with A's token; the writer goes first, the clear (check + delete in one transaction) sees the newer draft
  const [t2, cleared] = await Promise.all([
    writeDraft(store, 'op1', { form: { text: 'A2' }, saved: T0 }, t1),
    clearDraft(store, 'op1', t1),
  ]);
  assert.equal(cleared, false);
  assert.equal((await store.get('drafts', 'op1')).updated, t2);
  // the clear first: the draft is gone, the writer with the old token is refused, never recreating it silently
  const t3 = t2;
  const [c, w] = await Promise.all([clearDraft(store, 'op1', t3), writeDraft(store, 'op1', { form: { text: 'late' }, saved: T0 }, t3).catch(e => e)]);
  assert.equal(c, true);
  assert.ok(w instanceof ConflictError);
  assert.equal(await store.get('drafts', 'op1'), undefined);
});
