// Source lists in the tools' footers: dates as ISO 8601 (AGENTS.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { standDate } from '../tools/shared/js/sources.js';

test('standDate: the date part of an ISO stamp, never a locale format', () => {
  assert.equal(standDate('2026-10-18T15:58:49Z'), '2026-10-18');
  assert.equal(standDate('2026-09-10'), '2026-09-10');
  assert.equal(standDate(''), '?');
  assert.equal(standDate('Herbst 2026'), 'Herbst 2026');
});
