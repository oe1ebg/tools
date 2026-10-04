import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toCSV, toADIF, toSummary, adifAscii } from '../docs/confirm/js/export.js';
import { headerSnapshot } from '../docs/confirm/js/model.js';

const header = {
  operator: 'OE1EBG', station: 'OE1XKS', freq: '145.500', mode: 'FM', myGrid: 'JN88ef', myQth: 'Wien',
  viaRepeater: true, repeaterCall: 'OE1XUU', repeaterFreq: '438.950', repeaterShift: '-7.6',
};
const event = { id: 'ev', title: 'Probealarm Wien; Test', template: 'zivilschutz', header };
const snapA = headerSnapshot(header);
const snapB = headerSnapshot({ ...header, operator: 'OE1ABC' });
const entries = [
  { id: 'a', seq: 1, call: 'OE1AAA', ts: '2026-10-04T10:00:05Z', viaRepeater: true, snap: snapA,
    fields: { plz: '1030', address: 'Währinger Straße 1', siren: 'innen_zu', atalert: 'ja', platform: 'ios' }, note: '' },
  { id: 'b', seq: 2, call: 'OE1BBB', ts: '2026-10-04T10:01:00Z', viaRepeater: false, snap: snapB,
    fields: { plz: '1100', address: '', siren: 'nicht', atalert: 'nein', platform: 'android' }, note: 'Hinweis "laut"' },
  { id: 'c', seq: 3, call: 'OE1AAA', ts: '2026-10-04T10:02:00Z', viaRepeater: true, snap: snapA,
    fields: { plz: '1030', siren: 'aussen', atalert: 'ja' }, note: '' },
  { id: 'd', seq: 4, call: 'OE1DDD', ts: '2026-10-04T10:03:00Z', viaRepeater: false, snap: snapA, fields: {}, note: '', deleted: '2026-10-04T10:04:00Z' },
];

function parseADIF(text) {
  const body = text.slice(text.indexOf('<EOH>') + 5);
  return body.split(/<EOR>/i).map(chunk => {
    const rec = {};
    const re = /<([A-Z0-9_]+):(\d+)>/gi;
    let m;
    while ((m = re.exec(chunk))) {
      rec[m[1].toUpperCase()] = chunk.substr(re.lastIndex, +m[2]);
      re.lastIndex += +m[2];
    }
    return rec;
  }).filter(r => Object.keys(r).length);
}

test('CSV has BOM, header, check-in numbers, per-line snapshots, escaping', () => {
  const csv = toCSV(event, entries, ';');
  assert.ok(csv.startsWith('﻿'));
  const lines = csv.slice(1).trim().split('\r\n');
  const cols = lines[0].split(';');
  assert.deepEqual(cols.slice(0, 5), ['nr', 'checkin_nr', 'datum_utc', 'zeit_utc', 'rufzeichen']);
  assert.ok(cols.includes('siren') && cols.includes('ueber_relais') && cols.includes('relais'));
  assert.equal(lines.length, 4, 'deleted line excluded');
  const row = i => Object.fromEntries(cols.map((c, j) => [c, lines[i].split(';')[j]]));
  assert.equal(row(1).checkin_nr, '1');
  assert.equal(row(3).checkin_nr, '2');
  assert.equal(row(1).siren, 'innen, Fenster zu');
  assert.equal(row(1).platform, '', 'platform only shown when AT-Alert not received');
  assert.equal(row(1).relais, 'OE1XUU');
  assert.equal(row(1).freq_mhz, '431.35');
  assert.equal(row(2).operator, 'OE1ABC');
  assert.equal(row(2).relais, '');
  assert.ok(lines[2].includes('"Hinweis ""laut"""'));
  assert.ok(lines[1].endsWith('"Probealarm Wien; Test"'), 'separator in value is quoted');
});

test('ADIF: valid lengths, operator/station, repeater marking, APP fields', () => {
  const adi = toADIF(event, entries, '2026-10-04T12:00:00.000Z');
  assert.ok(adi.includes('<ADIF_VER:5>3.1.7'));
  assert.ok(adi.includes('<CREATED_TIMESTAMP:15>20261004 120000'));
  assert.ok(/^[\x09\x0a\x0d\x20-\x7e]*$/.test(adi), 'ASCII only');
  const recs = parseADIF(adi);
  assert.equal(recs.length, 3);
  const [a, b, c] = recs;
  assert.equal(a.CALL, 'OE1AAA');
  assert.equal(a.QSO_DATE, '20261004');
  assert.equal(a.TIME_ON, '100005');
  assert.equal(a.OPERATOR, 'OE1EBG');
  assert.equal(a.STATION_CALLSIGN, 'OE1XKS');
  assert.equal(a.PROP_MODE, 'RPT');
  assert.equal(a.APP_OE1EBG_REPEATER, 'OE1XUU');
  assert.equal(a.FREQ, '431.35');
  assert.equal(a.FREQ_RX, '438.95');
  assert.equal(a.BAND_RX, '70cm');
  assert.equal(a.MODE, 'FM');
  assert.equal(a.APP_OE1EBG_SIREN, 'innen_zu');
  assert.equal(a.APP_OE1EBG_PLZ, '1030');
  assert.equal(a.APP_OE1EBG_ADDRESS, 'Waehringer Strasse 1');
  assert.equal(a.APP_OE1EBG_PLATFORM, undefined);
  assert.equal(a.APP_OE1EBG_CHECKIN, '1');
  assert.match(a.COMMENT, /via Relais OE1XUU/);
  assert.equal(b.OPERATOR, 'OE1ABC');
  assert.equal(b.PROP_MODE, undefined);
  assert.equal(b.FREQ, '145.5');
  assert.equal(b.BAND, '2m');
  assert.equal(b.APP_OE1EBG_PLATFORM, 'android');
  assert.equal(c.APP_OE1EBG_CHECKIN, '2');
});

test('ADIF RST template uses standard fields', () => {
  const ev = { id: 'r', title: 'Runde', template: 'rst', header: { ...header, viaRepeater: false, mode: 'DMR' } };
  const recs = parseADIF(toADIF(ev, [{ id: 'x', seq: 1, call: 'OE3XYZ', ts: '2026-10-04T10:00:00Z', viaRepeater: false,
    snap: headerSnapshot(ev.header), fields: { rst_rcvd: '59', rst_sent: '57', name: 'Jörg', qth: '' }, note: '' }]));
  assert.equal(recs[0].RST_RCVD, '59');
  assert.equal(recs[0].RST_SENT, '57');
  assert.equal(recs[0].NAME, 'Joerg');
  assert.equal(recs[0].QTH, undefined);
  assert.equal(recs[0].MODE, 'DIGITALVOICE');
  assert.equal(recs[0].SUBMODE, 'DMR');
});

test('adifAscii', () => {
  assert.equal(adifAscii('Größe <x> Café\nneu'), 'Groesse x Cafe neu');
});

test('summary counts unique stations and latest answers per station', () => {
  const s = toSummary(event, entries);
  assert.match(s, /2 Stationen, 3 Check-ins/);
  assert.match(s, /OE1AAA, OE1BBB/);
  assert.match(s, /nur im Freien: 1/);
  assert.match(s, /1030: 1 Stn\., AT-Alert 1\/1/);
  assert.match(s, /Android: 1/);
});
