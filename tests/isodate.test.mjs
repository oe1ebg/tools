// Shared ISO date fields (tools/shared/js/isodate.js), used by the ADIF
// editor and the SOTA Alerts Map.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isoDateFromText, isoPickerSupported } from '../tools/shared/js/isodate.js';

test('typed dates become YYYY-MM-DD when complete and real', () => {
  for (const [typed, iso] of [
    ['2026-09-01', '2026-09-01'], [' 2026-9-1 ', '2026-09-01'], ['2026.09.01', '2026-09-01'], ['2026/9/1', '2026-09-01'],
    ['20260901', '2026-09-01'], ['2024-02-29', '2024-02-29'], ['19300101', '1930-01-01'],
  ]) assert.equal(isoDateFromText(typed), iso, typed);
  for (const typed of ['', '2026-1', '2026-09', '01.09.2026', '09/01/2026', '2026-02-30', '2025-02-29', '2026-13-01', '2026-00-10', '2026091', '202609011', 'x', null, undefined]) {
    assert.equal(isoDateFromText(typed), '', String(typed));
  }
});

test('no calendar outside a browser, and nothing runs on import', () => {
  assert.equal(isoPickerSupported, false);
});
