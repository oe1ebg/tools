import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { buildCallbook, baseCall, isOECall, lookupCall, withinOneEdit, suggestCalls } from '../docs/confirm/js/callbook.js';

const book = buildCallbook({
  stand: '2026-09-10',
  calls: [
    ['OE1EBG', 'Erich Birngruber', '1030 Wien'],
    ['OE1XKS', 'Klubstation', '1200 Wien'],
    ['OE1AAA', '', ''],
    ['OE1EBH', 'Test Person', '1010 Wien'],
    ['OE3ABC', 'Anna Beispiel', '3100 St. Pölten'],
  ],
});

test('baseCall strips portable prefixes/suffixes', () => {
  assert.equal(baseCall('OE1EBG/P'), 'OE1EBG');
  assert.equal(baseCall('HB9/OE1EBG'), 'OE1EBG');
  assert.equal(baseCall('DL/OE1EBG/M'), 'OE1EBG');
  assert.equal(baseCall('DL1ABC/P'), 'DL1ABC');
  assert.equal(baseCall('OE/DL1ABC'), 'DL1ABC');
});

test('isOECall', () => {
  assert.ok(isOECall('OE1EBG'));
  assert.ok(isOECall('OE1EBG/P'));
  assert.ok(!isOECall('DL1ABC'));
  assert.ok(!isOECall('OE/DL1ABC'));
});

test('lookupCall', () => {
  assert.deepEqual(lookupCall(book, 'OE1EBG/P').entry, ['OE1EBG', 'Erich Birngruber', '1030 Wien']);
  assert.deepEqual(lookupCall(book, 'OE1AAA').entry, ['OE1AAA', '', '']);
  assert.equal(lookupCall(book, 'OE1ZZZ').entry, null);
  assert.equal(lookupCall(null, 'OE1EBG').entry, null);
});

test('withinOneEdit', () => {
  assert.ok(withinOneEdit('OE1EBG', 'OE1EBG'));
  assert.ok(withinOneEdit('OE1EBF', 'OE1EBG'));   // substitution
  assert.ok(withinOneEdit('OE1BEG', 'OE1EBG'));   // transposition
  assert.ok(withinOneEdit('OE1EB', 'OE1EBG'));    // deletion
  assert.ok(withinOneEdit('OE1EBGG', 'OE1EBG'));  // insertion
  assert.ok(!withinOneEdit('OE1XYZ', 'OE1EBG'));
  assert.ok(!withinOneEdit('OE1E', 'OE1EBG'));
});

test('suggestCalls: prefix first, then typos, no exact match', () => {
  assert.deepEqual(suggestCalls(book, 'OE1EB').map(c => c[0]), ['OE1EBG', 'OE1EBH']);
  assert.deepEqual(suggestCalls(book, 'OE1BEG').map(c => c[0]), ['OE1EBG']);
  assert.deepEqual(suggestCalls(book, 'OE1EBG').map(c => c[0]), ['OE1EBH']);
  assert.deepEqual(suggestCalls(book, 'OE'), []);
});

// Sanity check of the real generated list, when it has been built.
const real = new URL('../docs/confirm/data/callsigns-oe.json', import.meta.url);
test('generated callsign list is plausible', { skip: !existsSync(real) && 'run `just fetch-callsigns` first' }, () => {
  const data = JSON.parse(readFileSync(real, 'utf8'));
  assert.match(data.stand, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(data.calls.length > 5000, `${data.calls.length} calls`);
  for (const c of data.calls) {
    assert.equal(c.length, 3);
    assert.match(c[0], /^OE\d[A-Z0-9]+$/);
    assert.ok(!c[1].includes('*-*-*') && !c[2].includes('*-*-*'));
  }
  const b = buildCallbook(data);
  assert.ok(b.byCall.has('OE1XA'), 'ÖVSV Landesverband Wien club call present');
});
