// Resource limits of the backup imports and the message text (issue #15):
// refused as a whole, with a German message, before anything is written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BACKUP_FORMAT, BACKUP_MAX_RECORDS, validateBackup } from '../tools/confirm/js/backup.js';
import { parseBackup, BACKUP_MAX_RECORDS as NF_MAX_RECORDS } from '../tools/notfunk/js/export.js';
import { MESSAGE_TEXT_MAX, validateMessage, newMessage, messageFields, editMessage } from '../tools/notfunk/js/model.js';
import { formatNumber, counterKey } from '../tools/notfunk/js/numbering.js';

const T = '2026-10-04T16:00:00.000Z';
const entry = (id, seq, extra = {}) => ({ id, eventId: 'e1', seq, call: `OE1A${seq}`, ts: T, created: T, updated: T, deleted: null, ...extra });
const confirmBackup = entries => ({ format: BACKUP_FORMAT, version: 1, exported: T, events: [{ event: { id: 'e1', title: 'L', created: T, updated: T }, entries, revisions: [] }] });

test('confirm: too many records refuse the whole file, long texts import', () => {
  const many = validateBackup(confirmBackup(Array.from({ length: BACKUP_MAX_RECORDS + 1 }, (_, i) => entry(`a${i}`, i + 1))));
  assert.equal(many.ok, false);
  assert.match(many.errors[0], /nicht importiert/);
  assert.equal(validateBackup(confirmBackup(Array.from({ length: 50 }, (_, i) => entry(`a${i}`, i + 1)))).ok, true);
  // no limit on a line's text: what was stored and exported imports again
  assert.equal(validateBackup(confirmBackup([entry('a', 1, { note: 'x'.repeat(300000), text: 'y'.repeat(300000) })])).ok, true);
});

const OP = { id: 'op1', name: 'Übung', prefix: 'W1', created: T, updated: T };
const fields = extra => messageFields({
  direction: 'in', ts: T, channel: 'funk', radio: { freq: '145.500' }, peer: 'OE1ABC',
  from: { name: 'Lichtinsel 3' }, to: { name: 'Stab' }, subject: 'Wasser', text: 'Kein Wasser.', ...extra,
});
const msg = (seq, extra = {}) => ({
  ...newMessage(fields(), { prefix: 'W1', seq, number: formatNumber('W1', seq) }, { id: `b${seq}`, opId: 'op1', operator: 'OE1EBG', stationCall: 'OE1XKS', now: T }), ...extra,
});
const nfBackup = (messages, extra = {}) => JSON.stringify({
  format: 'oe1ebg-notfunk-backup', version: 1, exported: T, operation: OP, messages, revisions: [],
  counters: [{ id: counterKey('op1', 'W1'), eventId: 'op1', prefix: 'W1', last: 1 }], ...extra,
});

test('notfunk: too many records are refused, a long stored Inhalt round-trips', () => {
  assert.equal(NF_MAX_RECORDS, BACKUP_MAX_RECORDS);
  assert.throws(() => parseBackup(nfBackup([msg(1)], { revisions: new Array(NF_MAX_RECORDS + 1).fill(null) })), /nicht importiert/);
  // a long Inhalt (stored before the limit), also in a revision, still imports
  const long = msg(1, { text: 'x'.repeat(MESSAGE_TEXT_MAX + 1) });
  const rev = { id: 'r1', eventId: 'op1', messageId: long.id, at: T, by: 'X', old: long };
  const d = parseBackup(nfBackup([long], { revisions: [rev] }));
  assert.equal(d.messages.length, 1);
  assert.equal(d.revisions.length, 1);
  assert.deepEqual(d.dropped, []);
});

test('notfunk: the form refuses an Inhalt beyond the limit', () => {
  assert.match(validateMessage(fields({ text: 'x'.repeat(MESSAGE_TEXT_MAX + 1) })).join(), /zu lang/);
  assert.deepEqual(validateMessage(fields({ text: 'x'.repeat(MESSAGE_TEXT_MAX) })), []);
});

test('notfunk: a restored long Inhalt can still be edited (metadata), only changed text is limited', async () => {
  const long = msg(1, { text: 'x'.repeat(MESSAGE_TEXT_MAX + 1) });
  const meta = { revisionId: 'r1', operator: 'OE1EBG', now: '2026-10-04T17:00:00.000Z' };
  const { next, revision } = editMessage(long, { staffRef: 'GZ 12' }, meta);
  assert.equal(next.staffRef, 'GZ 12');
  assert.equal(next.text.length, MESSAGE_TEXT_MAX + 1);
  assert.equal(revision.old, long);
  // changing the text to another long one is still refused, shortening is fine
  assert.throws(() => editMessage(long, { text: 'y'.repeat(MESSAGE_TEXT_MAX + 5) }, meta), /zu lang/);
  assert.equal(editMessage(long, { text: 'kurz' }, meta).next.text, 'kurz');
  // the form: unchanged long text passes, a changed long one does not
  const { formToFields, messageToForm } = await import('../tools/notfunk/js/form.js');
  const form = messageToForm(long);
  const opts = { now: T, editing: true };
  assert.deepEqual(formToFields({ ...form, staffRef: 'GZ 1' }, { ...opts, keepText: long.text }).errors, []);
  assert.match(formToFields({ ...form, text: form.text + 'z' }, { ...opts, keepText: long.text }).errors.join(), /zu lang/);
  assert.match(formToFields(form, opts).errors.join(), /zu lang/);
});

// Issue #15 review: row caches compare `updated`; a stalled clock must still
// give every change a new stamp.
test('a changed record always gets a later `updated` stamp', async () => {
  const { laterIso } = await import('../tools/shared/js/time.js');
  assert.equal(laterIso(T, T), '2026-10-04T16:00:00.001Z');
  assert.equal(laterIso(T, '2026-10-04T15:00:00.000Z'), '2026-10-04T16:00:00.001Z'); // clock set back
  assert.equal(laterIso(T, '2026-10-04T16:00:05.000Z'), '2026-10-04T16:00:05.000Z');
  assert.equal(laterIso(undefined, T), T);
  const { setStatus, addAttempt, softDelete, restoreDeleted } = await import('../tools/notfunk/js/model.js');
  const m = msg(1);
  const meta = { operator: 'OE1EBG', now: T }; // the clock stands still
  const e = editMessage(m, { staffRef: 'A' }, { ...meta, revisionId: 'r1' }).next;
  const stamps = [m.updated, e.updated];
  stamps.push(setStatus(e, 'forwarded', meta).updated);
  stamps.push(addAttempt(e, meta).updated);
  const d = softDelete(e, meta);
  stamps.push(d.updated, restoreDeleted(d, meta).updated);
  assert.ok(e.updated > m.updated);
  assert.ok(stamps[2] > e.updated && stamps[3] > e.updated);
  assert.ok(restoreDeleted(d, meta).updated > d.updated && d.updated > e.updated);
});

// Review: a stored text that is not normalised (imports keep it as written)
// still counts as unchanged.
test('notfunk: an unnormalised stored long Inhalt stays editable', async () => {
  const { formToFields, messageToForm } = await import('../tools/notfunk/js/form.js');
  const meta = { revisionId: 'r1', operator: 'OE1EBG', now: '2026-10-04T17:00:00.000Z' };
  for (const text of ['x'.repeat(MESSAGE_TEXT_MAX + 1) + '\n', ' ' + 'x'.repeat(MESSAGE_TEXT_MAX + 1), 'x'.repeat(MESSAGE_TEXT_MAX) + '\r\ny\r\n']) {
    const long = msg(1, 'kurz');
    long.text = text; // as a lenient import keeps it
    assert.equal(editMessage(long, { staffRef: 'A' }, meta).next.staffRef, 'A');
    const form = messageToForm(long);
    assert.deepEqual(formToFields({ ...form, staffRef: 'A' }, { now: T, editing: true, keepText: long.text }).errors, []);
  }
});
