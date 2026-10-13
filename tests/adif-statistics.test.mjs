import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseADIF } from '../tools/shared/js/adif.js';
import { calculateLogStatistics } from '../tools/adif/js/statistics.js';
import { ADIF_SPEC_ENUMS } from '../tools/shared/js/adif-spec-data.js';

const bucket = (stats, distribution, key) => stats[distribution].find(r => r.value === key)?.count || 0;
test('statistics canonicalize groups without changing source values', () => {
  const log = [
    { CALL: ' oe1ab/p ', BAND: '20M', MODE: 'ssb', QSO_DATE: '20240229', DXCC: '206' },
    { CALL: 'OE1AB/P', BAND: '20m', MODE: 'SSB', QSO_DATE: '20260230', DXCC: '0' },
    { CALL: 'OE1AB', BAND: ' 20m', MODE: 'MFSK', SUBMODE: 'ft2', QSO_DATE: '20990101', DXCC: '2' },
    { CALL: ' ', BAND: ' ', MODE: 'bad', SUBMODE: 'FT2', FREQ: '14.1', TIME_ON: '2400', QSO_DATE: 'bad', DXCC: 'bad' },
    {},
  ];
  const before = JSON.stringify(log);
  const s = calculateLogStatistics(log, { fileCount: 2 });
  assert.equal(s.count, 5); assert.equal(s.fileCount, 2);
  assert.equal(s.calls, 2); assert.equal(s.missingCalls, 2);
  assert.equal(s.bandCount, 1); assert.equal(s.modeCount, 2);
  assert.equal(s.firstDate, '20240229'); assert.equal(s.lastDate, '20990101');
  assert.equal(bucket(s, 'bands', '20m'), 2);
  assert.equal(bucket(s, 'bands', '(invalid)'), 1);
  assert.equal(bucket(s, 'bands', '(missing)'), 2);
  assert.equal(bucket(s, 'submodes', 'MFSK: FT2'), 1);
  assert.equal(bucket(s, 'submodes', '(invalid): FT2'), 1);
  assert.equal(s.dxccCount, 2); // code 0 excluded, deleted code 2 included
  assert.deepEqual(s.completeness['QSO_DATE'], { missing: 1, invalid: 2 });
  assert.deepEqual(s.completeness['BAND/FREQ'], { missing: 1, invalid: 1 });
  assert.deepEqual(s.completeness.MODE, { missing: 1, invalid: 1 });
  for (const name of ['bands', 'modes', 'submodes', 'dxcc']) {
    assert.equal(s[name].reduce((sum, r) => sum + r.count, 0), s.count);
  }
  assert.equal(JSON.stringify(log), before);
});

test('empty scopes, incomplete rows, stable ties and filtered indices', () => {
  const log = [{ BAND: '40m', CALL: 'A' }, { BAND: '20m', CALL: 'B' }, {}];
  const s = calculateLogStatistics(log, { indices: [2, 0], fileCount: 3 });
  assert.equal(s.count, 2); assert.equal(s.calls, 1); assert.equal(s.fileCount, 3);
  assert.equal(s.bands[0].value, '(missing)');
  const empty = calculateLogStatistics(log, { indices: [] });
  assert.equal(empty.count, 0); assert.equal(empty.firstDate, null); assert.deepEqual(empty.bands, []);
  const full = calculateLogStatistics(log);
  assert.deepEqual(calculateLogStatistics([...log].reverse()), full);
});

for (const [file, count, calls, lastDate] of [['test-qsos-317.adi', 6197, 6006, '20260215'], ['test-qsos.adi', 6202, 6008, '20260905']]) {
  test(`pinned official aggregates: ${file}`, () => {
    const log = parseADIF(readFileSync(new URL(`./fixtures/adif-spec/${file}`, import.meta.url), 'utf8'));
    const s = calculateLogStatistics(log, { fileCount: 1 });
    assert.deepEqual([s.count, s.calls, s.firstDate, s.lastDate, s.bandCount, s.modeCount, s.fieldCount, s.dxccCount],
      [count, calls, '19700101', lastDate, 33, 49, 180, 340]);
    assert.equal(s.bands.filter(b => b.value.toUpperCase() === '20M').length, 1);
    assert.ok(ADIF_SPEC_ENUMS.DXCC_Entity_Code.labels['206']);
    assert.ok(ADIF_SPEC_ENUMS.DXCC_Entity_Code.deleted.includes('2'));
  });
}
