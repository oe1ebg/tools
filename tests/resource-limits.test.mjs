// Resource limits of the backup imports and the message text (issue #15):
// refused as a whole, with a German message, before anything is written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BACKUP_FORMAT, BACKUP_MAX_RECORDS, BACKUP_MAX_TEXT, validateBackup } from '../tools/confirm/js/backup.js';
import { parseBackup, BACKUP_MAX_RECORDS as NF_MAX_RECORDS } from '../tools/notfunk/js/export.js';
import { MESSAGE_TEXT_MAX, validateMessage, newMessage, messageFields } from '../tools/notfunk/js/model.js';
import { formatNumber, counterKey } from '../tools/notfunk/js/numbering.js';

const T = '2026-10-04T16:00:00.000Z';
const entry = (id, seq, extra = {}) => ({ id, eventId: 'e1', seq, call: `OE1A${seq}`, ts: T, created: T, updated: T, deleted: null, ...extra });
const confirmBackup = entries => ({ format: BACKUP_FORMAT, version: 1, exported: T, events: [{ event: { id: 'e1', title: 'L', created: T, updated: T }, entries, revisions: [] }] });

test('confirm: too many records or a giant text refuse the whole file', () => {
  const many = validateBackup(confirmBackup(Array.from({ length: BACKUP_MAX_RECORDS + 1 }, (_, i) => entry(`a${i}`, i + 1))));
  assert.equal(many.ok, false);
  assert.match(many.errors[0], /nicht importiert/);
  assert.equal(validateBackup(confirmBackup(Array.from({ length: 50 }, (_, i) => entry(`a${i}`, i + 1)))).ok, true);
  const giant = validateBackup(confirmBackup([entry('a', 1, { note: 'x'.repeat(BACKUP_MAX_TEXT + 1) })]));
  assert.equal(giant.ok, false);
  assert.match(giant.errors[0], /länger als/);
  assert.equal(validateBackup(confirmBackup([entry('a', 1, { note: 'x'.repeat(BACKUP_MAX_TEXT) })])).ok, true);
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

test('notfunk: too many records, a giant Inhalt', () => {
  assert.equal(NF_MAX_RECORDS, BACKUP_MAX_RECORDS);
  assert.throws(() => parseBackup(nfBackup([msg(1)], { revisions: new Array(NF_MAX_RECORDS + 1).fill(null) })), /nicht importiert/);
  assert.throws(() => parseBackup(nfBackup([msg(1, { text: 'x'.repeat(MESSAGE_TEXT_MAX + 1) })])), /Inhalt länger/);
  assert.equal(parseBackup(nfBackup([msg(1, { text: 'x'.repeat(MESSAGE_TEXT_MAX) })])).messages.length, 1);
});

test('notfunk: the form refuses an Inhalt beyond the limit', () => {
  assert.match(validateMessage(fields({ text: 'x'.repeat(MESSAGE_TEXT_MAX + 1) })).join(), /zu lang/);
  assert.deepEqual(validateMessage(fields({ text: 'x'.repeat(MESSAGE_TEXT_MAX) })), []);
});
