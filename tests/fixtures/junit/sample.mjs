// Input of junit-reporter.test.mjs (not a test of its own): one test of
// each kind the reporter has to handle.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

test('passes', () => {});
test('fails with <markup> & "quotes"', () => { assert.equal(1, 2, 'one is not <two>'); });
test('skips', { skip: 'tool not found' }, () => {});
test('todo', { todo: true }, () => {});
test('parent', async t => {
  await t.test('child passes', () => {});
  await t.test('child fails', () => { throw new TypeError('child broke'); });
});
describe('suite', () => { test('inner', () => {}); });
test('diagnostic', t => { t.diagnostic('tool v1.2.3'); });
