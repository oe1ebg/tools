// Netlog's offline search (tools/netlog/js/search.js): every field kind,
// partial callsigns, accents and case, the session/history scope, field
// filters, deleted records left out, the current session first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { search, fold, findMatch } from '../tools/netlog/js/search.js';

const records = {
  sessions: [
    { id: 'S1', date: '2026-10-01', name: 'Old net' },
    { id: 'S2', date: '2026-10-15', name: 'Evening net' },
    { id: 'S3', date: '2026-10-16', deleted: '2026-10-16T00:00:00Z' },
  ],
  series: [],
  rounds: [{ id: 'r1', number: 1 }, { id: 'r9', number: 9 }],
  participants: [
    { id: 'p1', eventId: 'S2', call: 'OE0QXB', base: 'OE0QXB', name: 'Jonas', qth: 'Wien-Floridsdorf', locator: 'JN88EG' },
    { id: 'p2', eventId: 'S1', call: 'OE0QXB/P', base: 'OE0QXB', name: 'Jonas' },
    { id: 'p3', eventId: 'S2', call: 'OE0QX?', base: 'OE0QX?', name: '' },
    { id: 'p4', eventId: 'S3', call: 'OE0QXZ', base: 'OE0QXZ', name: 'gone' },
  ],
  notes: [
    { id: 'n1', eventId: 'S2', participantId: 'p1', roundId: 'r1', seq: 1, text: 'Interference persists after the antenna change.' },
    { id: 'n2', eventId: 'S1', participantId: 'p2', roundId: 'r9', seq: 4, text: 'Plans a portable test on the Kahlenberg.' },
    { id: 'n3', eventId: 'S2', participantId: 'p1', roundId: 'r1', seq: 2, text: 'deleted antenna note', deleted: 'x' },
  ],
  items: [
    { id: 'i1', eventId: 'S2', kind: 'response', noteId: 'n1', text: 'Ask about common-mode current.', active: true },
    { id: 'i2', eventId: 'S2', kind: 'point', text: 'Mention the Fieldday.', active: true },
    { id: 'i3', eventId: 'S2', kind: 'task', noteId: 'n1', text: '', active: true },
    { id: 'i4', eventId: 'S2', kind: 'response', noteId: 'n1', text: 'unflagged reply', active: false },
  ],
};

test('folding ignores case and accents; matches give positions in the text', () => {
  assert.equal(fold('Ölförderung Ä'), 'olforderung a');
  assert.deepEqual(findMatch('Wien-Floridsdorf', 'florids'), [5, 12]);
  assert.equal(findMatch('abc', ''), null);
});

test('all fields and sessions; the current session first, deleted ones out', () => {
  const r = search(records, { query: 'antenna', scope: 'all', sessionId: 'S2' });
  // the note, and its after-net task (no text of its own: found by the note)
  assert.deepEqual(r.map(x => [x.kind, x.noteId]), [['note', 'n1'], ['task', 'n1']]);
  assert.equal(r[0].round.number, 1);
  assert.equal(r[0].participant.call, 'OE0QXB');
  assert.equal(search(records, { query: 'gone', scope: 'all' }).length, 0, 'deleted session');
  const calls = search(records, { query: 'qxb', scope: 'all', sessionId: 'S2' });
  assert.deepEqual(calls.map(x => [x.sessionId, x.text]), [['S2', 'OE0QXB'], ['S1', 'OE0QXB/P']]);
  assert.deepEqual(search(records, { query: 'QX?', scope: 'all', sessionId: 'S2' }).map(x => x.participantId), ['p3']);
});

test('replies, points, tasks; unflagged replies out; scope and field filters', () => {
  assert.deepEqual(search(records, { query: 'common-mode', scope: 'all' }).map(x => [x.kind, x.field, x.noteId]), [['response', 'reply', 'n1']]);
  assert.deepEqual(search(records, { query: 'fieldday', scope: 'all' }).map(x => x.kind), ['point']);
  assert.deepEqual(search(records, { query: 'interference', scope: 'all', field: 'task' }).map(x => x.kind), ['task'], 'a task without text matches its note');
  assert.equal(search(records, { query: 'unflagged', scope: 'all' }).length, 0);
  assert.equal(search(records, { query: 'kahlenberg', scope: 'session', sessionId: 'S2' }).length, 0);
  assert.equal(search(records, { query: 'kahlenberg', scope: 'all', sessionId: 'S2' })[0].sessionId, 'S1');
  assert.deepEqual(search(records, { query: 'jn88', scope: 'all', field: 'place' }).map(x => x.field), ['locator']);
  assert.deepEqual(search(records, { query: 'jonas', scope: 'all', field: 'call' }), []);
  assert.deepEqual(search(records, { query: 'jonas', scope: 'all', field: 'name', sessionId: 'S2' }).map(x => x.sessionId), ['S2', 'S1']);
});
