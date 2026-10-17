// The table's column order (#108 B4): core fields first, or the file's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adifDisplayColumns, ADIF_CORE_COLUMNS } from '../tools/adif/js/columns.js';

test('core fields first, in their order; the rest in file order', () => {
  const file = ['REMOTE_STATION_LAT', 'MODE', 'QSO_TRANSCRIPT', 'CALL', 'MY_AMP', 'QSO_DATE', 'BAND', 'TIME_ON', 'APP_X_Y'];
  assert.deepEqual(adifDisplayColumns(file), ['CALL', 'QSO_DATE', 'TIME_ON', 'BAND', 'MODE', 'REMOTE_STATION_LAT', 'QSO_TRANSCRIPT', 'MY_AMP', 'APP_X_Y']);
  assert.deepEqual(adifDisplayColumns(file, 'core'), adifDisplayColumns(file));
});

test('file order is the file order; the input is never changed', () => {
  const file = ['NOTES', 'CALL', 'BAND'];
  const copy = file.slice();
  assert.deepEqual(adifDisplayColumns(file, 'file'), file);
  assert.notEqual(adifDisplayColumns(file, 'file'), file);
  adifDisplayColumns(file, 'core');
  assert.deepEqual(file, copy);
});

test('only the fields the log has; empty and core-only logs', () => {
  assert.deepEqual(adifDisplayColumns([]), []);
  assert.deepEqual(adifDisplayColumns(['NOTES']), ['NOTES']);
  assert.deepEqual(adifDisplayColumns(ADIF_CORE_COLUMNS.slice().reverse()), ADIF_CORE_COLUMNS);
});
