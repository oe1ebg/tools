// The confirmation log's ADIF export against the ADIF 3.1.7 rules
// (tests/adif-spec.mjs): every template, ordinary and awkward input.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toADIF, adifIssues, adifGrid, adifFieldName, ADIF_FIXED_FIELDS, ADIF_MIME } from '../tools/confirm/js/export.js';
import { TEMPLATES, exampleValues } from '../tools/confirm/js/templates.js';
import { headerSnapshot, MODES } from '../tools/confirm/js/model.js';
import { readADI, isCompleteQSO, ADIF_MODES } from './adif-spec.mjs';

const header = {
  operator: 'OE1EBG', station: 'OE1XKS', freq: '145,500', mode: 'FM', myGrid: 'jn88ef', myQth: 'Wien Döbling',
  viaRepeater: false, repeaterCall: 'OE1XUU', repeaterFreq: '438,950', repeaterShift: '-7,6', repeaterTone: '88.5',
};
const loc = { lat: 48.2, lon: 16.37, maidenhead: 'JN88ee12', label: 'Straße <½>', confidence: 'high', input: 'x', origin: 'search' };

function entriesFor(tpl, h = header) {
  const fields = exampleValues(tpl);
  const base = { fields, note: 'Notiz\nmit <Zeilenumbruch> & "Zitat"' };
  return [
    { id: 'a', seq: 1, call: 'oe1aaa', ts: '2026-10-04T23:59:59.999Z', viaRepeater: true, snap: headerSnapshot(h), ...base, loc },
    { id: 'b', seq: 2, call: 'OE3XYZ/P', ts: '2026-10-05T00:00:00Z', viaRepeater: false, snap: headerSnapshot(h), ...base },
    { id: 'c', seq: 3, call: 'OE1AAA', ts: '2026-10-05T00:01:00Z', viaRepeater: true,
      snap: headerSnapshot({ ...h, repeaterShift: '', repeaterFreq: '' }), ...base },
  ];
}

test('every template exports spec-conformant ADIF', () => {
  for (const tpl of TEMPLATES) {
    const ev = { id: tpl.key, title: `Test <${tpl.key}> Ä`, template: tpl.key, header };
    const { header: h, records } = readADI(toADIF(ev, entriesFor(tpl), '2026-10-06T12:34:56.789Z', { programVersion: 'abc1234' }));
    assert.equal(h.ADIF_VER, '3.1.7');
    assert.equal(h.PROGRAMID, 'OE1EBG');
    assert.equal(h.PROGRAMVERSION, 'abc1234');
    assert.equal(h.CREATED_TIMESTAMP, '20261006 123456');
    assert.equal(records.length, 3, tpl.key);
    for (const r of records) assert.ok(isCompleteQSO(r), `${tpl.key}: ${JSON.stringify(r)}`);
  }
});

test('ADIF values are normalized: callsigns upper case, locators canonical, numbers with a dot', () => {
  const tpl = TEMPLATES[0];
  const { records: [a, b] } = readADI(toADIF({ id: 'x', title: 'T', template: tpl.key, header }, entriesFor(tpl)));
  assert.equal(a.CALL, 'OE1AAA');
  assert.equal(a.MY_GRIDSQUARE, 'JN88ef');
  assert.equal(a.GRIDSQUARE, 'JN88ee12');
  assert.equal(a.FREQ, '431.35', 'transmit = repeater input');
  assert.equal(a.FREQ_RX, '438.95', 'receive = repeater output');
  assert.equal(a.PROP_MODE, 'RPT');
  assert.match(a.COMMENT, /via Relais OE1XUU 438\.950 MHz Shift -7\.6/);
  assert.equal(b.FREQ, '145.5');
  assert.equal(b.BAND, '2m');
  assert.equal(b.MY_CITY, 'Wien Doebling');
});

test('header values that are no callsign/locator go into COMMENT, not into the callsign fields', () => {
  const tpl = TEMPLATES[0];
  const h = { ...header, operator: 'Erich', station: '', myGrid: 'Wien' };
  const adi = toADIF({ id: 'x', title: 'T', template: tpl.key, header: h }, entriesFor(tpl, h));
  const { records: [a] } = readADI(adi);
  assert.equal(a.OPERATOR, undefined);
  assert.equal(a.STATION_CALLSIGN, undefined);
  assert.equal(a.MY_GRIDSQUARE, undefined);
  assert.match(a.COMMENT, /Operator: Erich/);
  assert.match(a.COMMENT, /Eigener Locator: Wien/);
});

test('locators longer than 8 characters use the *_EXT fields', () => {
  assert.deepEqual(adifGrid('jn88ee12ab'), { grid: 'JN88ee12', ext: 'ab' });
  assert.deepEqual(adifGrid('JN88'), { grid: 'JN88', ext: '' });
  assert.equal(adifGrid('JN8'), null);
  assert.equal(adifGrid('Wien'), null);
  const tpl = TEMPLATES[0];
  const h = { ...header, myGrid: 'JN88EE12AB' };
  const { records: [a] } = readADI(toADIF({ id: 'x', title: 'T', template: tpl.key, header: h }, entriesFor(tpl, h)));
  assert.equal(a.MY_GRIDSQUARE, 'JN88ee12');
  assert.equal(a.MY_GRIDSQUARE_EXT, 'ab');
});

test('adifIssues lists what logbook programs would reject', () => {
  const tpl = TEMPLATES[0];
  const h = { ...header, freq: '', mode: '', operator: 'Erich' };
  const issues = adifIssues({ id: 'x', title: 'T', template: tpl.key, header: h }, entriesFor(tpl, h));
  const b = issues.find(i => i.nr === 2);
  assert.ok(b.problems.includes('keine Frequenz'));
  assert.ok(b.problems.includes('keine Betriebsart'));
  assert.ok(b.problems.some(p => p.startsWith('Operator')));
  assert.deepEqual(adifIssues({ id: 'x', title: 'T', template: tpl.key, header }, entriesFor(tpl).slice(0, 2)), []);
});

test('no template field maps onto a field the exporter writes itself (no field twice per record)', () => {
  for (const tpl of TEMPLATES) {
    const names = tpl.fields.map(adifFieldName);
    assert.equal(new Set(names).size, names.length, `${tpl.key}: two fields with one ADIF name`);
    for (const n of names) {
      assert.ok(!ADIF_FIXED_FIELDS.includes(n), `${tpl.key}: ${n} collides with a fixed field`);
      assert.match(n, /^[A-Z][A-Z0-9_]*$/, n);
    }
  }
});

test('every header mode maps to a MODE/SUBMODE pair from the ADIF enumeration', () => {
  for (const m of MODES) {
    assert.ok(m.mode in ADIF_MODES, m.key);
    if (m.submode) assert.ok(ADIF_MODES[m.mode].includes(m.submode), m.key);
  }
});

test('ADIF is offered as a download Safari keeps as .adi', () => {
  assert.equal(ADIF_MIME, 'application/octet-stream');
});
