// Local-time expectations assume Vienna; set before any Date is created.
process.env.TZ = 'Europe/Vienna';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toCSV, toADIF, toSummary, toKML, xmlEscape, KML_MIME } from '../tools/confirm/js/export.js';
import { adifAscii } from '../tools/shared/js/adif.js';
import { stationsForMap } from '../tools/confirm/js/mapdata.js';
import { headerSnapshot } from '../tools/confirm/js/model.js';

const header = {
  operator: 'OE1EBG', station: 'OE1XKS', freq: '145.500', mode: 'FM', myGrid: 'JN88ef', myQth: 'Wien',
  viaRepeater: true, repeaterCall: 'OE1XUU', repeaterFreq: '438.950', repeaterShift: '-7.6',
};
const event = { id: 'ev', title: 'Probealarm Wien; Test', template: 'zivilschutz', header };
const snapA = headerSnapshot(header);
const snapB = headerSnapshot({ ...header, operator: 'OE1ABC' });
const entries = [
  { id: 'a', seq: 1, call: 'OE1AAA', ts: '2026-10-04T10:00:05Z', viaRepeater: true, snap: snapA,
    fields: { plz: '1030', address: 'Währinger Straße 1', siren_closed: '2', siren_open: '1', siren_outside: '1', atalert: 'ja', platform: 'ios', os_version: 'ios17' }, note: '' },
  { id: 'b', seq: 2, call: 'OE1BBB', ts: '2026-10-04T10:01:00Z', viaRepeater: false, snap: snapB,
    fields: { plz: '1100', address: '', siren_closed: '5', siren_open: '4', siren_outside: '3', atalert: 'nein', platform: 'android', os_version: 'android14' }, note: 'Hinweis "laut"' },
  { id: 'c', seq: 3, call: 'OE1AAA', ts: '2026-10-04T10:02:00Z', viaRepeater: true, snap: snapA,
    fields: { plz: '1030', siren_closed: '3', siren_outside: '1', atalert: 'ja' }, note: '' },
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
  assert.deepEqual(cols.slice(0, 4), ['zeitstempel_utc', 'nr', 'checkin_nr', 'rufzeichen'], 'one timestamp, first');
  assert.equal(cols.filter(c => /zeit|datum/.test(c)).length, 1, 'exactly one time column');
  for (const c of ['siren_closed', 'siren_open', 'siren_outside', 'os_version', 'ueber_relais', 'relais']) assert.ok(cols.includes(c), c);
  assert.equal(lines.length, 4, 'deleted line excluded');
  const row = i => Object.fromEntries(cols.map((c, j) => [c, lines[i].split(';')[j]]));
  assert.equal(row(1).zeitstempel_utc, '2026-10-04 10:00:05', 'ISO 8601 with space: Excel parses it as date/time');
  assert.equal(row(1).checkin_nr, '1');
  assert.equal(row(3).checkin_nr, '2');
  assert.equal(row(1).siren_closed, '2');
  assert.equal(row(1).siren_outside, '1');
  assert.equal(row(1).platform, '', 'platform only shown when AT-Alert not received');
  assert.equal(row(1).os_version, '', 'version hidden too: depends on the hidden platform (transitive)');
  assert.equal(row(2).platform, 'Android');
  assert.equal(row(2).os_version, 'Android 14');
  assert.equal(row(1).relais, 'OE1XUU');
  assert.equal(row(1).freq_mhz, '431.35');
  assert.equal(row(2).operator, 'OE1ABC');
  assert.equal(row(2).relais, '');
  assert.ok(lines[2].includes('"Hinweis ""laut"""'));
  assert.ok(lines[1].endsWith('"Probealarm Wien; Test"'), 'separator in value is quoted');
  assert.ok(cols.includes('log') && !cols.includes('ereignis'));
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
  assert.equal(a.APP_OE1EBG_SIREN_CLOSED, '2');
  assert.equal(a.APP_OE1EBG_SIREN_OUTSIDE, '1');
  assert.match(a.COMMENT, /Sirene innen, Fenster zu: 2/);
  assert.equal(a.APP_OE1EBG_OS_VERSION, undefined, 'hidden with platform');
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
  assert.equal(b.APP_OE1EBG_OS_VERSION, 'android14');
  assert.equal(c.APP_OE1EBG_CHECKIN, '2');
  assert.equal(c.APP_OE1EBG_LOG, 'Probealarm Wien; Test');
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
  assert.match(s, /2026-10-04 10:00–10:02 UTC/);
  assert.match(toSummary(event, entries, 'local'), /2026-10-04 12:00–12:02 UTC\+2/);
  assert.match(s, /OE1AAA, OE1BBB/);
  // latest check-in per station: OE1AAA (3 / – / 1), OE1BBB (5 / 4 / 3)
  assert.match(s, /innen, Fenster zu: Ø 4,0 \(n=2; 1× 3, 1× 5\)/);
  assert.match(s, /innen, Fenster offen: Ø 4,0 \(n=1; 1× 4\)/);
  assert.match(s, /im Freien: Ø 2,0 \(n=2; 1× 1, 1× 3\)/);
  assert.match(s, /Nicht erhalten nach Plattform\/Version:\n  Android 14: 1/);
  assert.match(s, /1030: 1 Stn\., AT-Alert 1\/1; Sirene Ø innen, Fenster zu 3,0 \/ innen, Fenster offen – \/ im Freien 1,0/);
});

test('location field: resolved location in CSV columns and ADIF GRIDSQUARE/LAT/LON', async () => {
  const { adifLatLon } = await import('../tools/confirm/js/export.js');
  assert.equal(adifLatLon(48.20833, true), 'N048 12.500');
  assert.equal(adifLatLon(16.37310, false), 'E016 22.386');
  assert.equal(adifLatLon(-33.8688, true), 'S033 52.128');
  assert.equal(adifLatLon(-0.9999999, false), 'W001 00.000'); // 59.999994' rounds up -> carry into degrees
  const loc = { type: 'address', label: 'Währinger Straße 40-42', postcode: '1090', district: 9, lat: 48.221, lon: 16.35663,
    maidenhead: 'JN88ef', source: 'vienna-ogd', confidence: 'exact', manual: false, input: 'Waehringerstr 42' };
  const es = [{ ...entries[0], loc, fields: { ...entries[0].fields, address: 'Waehringerstr 42', plz: '1090' } }, entries[1]];
  const csv = toCSV(event, es, ';').slice(1).trim().split('\r\n');
  const cols = csv[0].split(';');
  for (const c of ['standort_aufgeloest', 'lat', 'lon', 'locator', 'standort_konfidenz', 'standort_quelle']) assert.ok(cols.includes(c), c);
  const row = Object.fromEntries(cols.map((c, j) => [c, csv[1].split(';')[j]]));
  assert.equal(row.address, 'Waehringerstr 42', 'operator input kept as entered');
  assert.equal(row.standort_aufgeloest, 'Währinger Straße 40-42');
  assert.equal(row.locator, 'JN88ef');
  assert.equal(row.lat, '48.22100');
  assert.equal(row.standort_konfidenz, 'exakt');
  assert.equal(row.standort_quelle, 'automatisch');
  const row2 = Object.fromEntries(cols.map((c, j) => [c, csv[2].split(';')[j]]));
  assert.equal(row2.locator, '', 'unresolved line has empty location columns');
  const [a, b] = parseADIF(toADIF(event, es));
  assert.equal(a.GRIDSQUARE, 'JN88ef');
  assert.equal(a.LAT, 'N048 13.260');
  assert.equal(a.LON, 'E016 21.398');
  assert.equal(a.APP_OE1EBG_LOCATION, 'Waehringer Strasse 40-42');
  assert.match(a.COMMENT, /Standort: Waehringer Strasse 40-42 \(exakt\)/);
  assert.equal(b.GRIDSQUARE, undefined);
});

test('simple confirmation template has a QTH location field (exported as ADIF QTH)', () => {
  const ev = { id: 'r', title: 'Runde', template: 'calls', header };
  assert.ok(toCSV(ev, []).includes('qth') && toCSV(ev, []).includes('standort_aufgeloest'));
  const loc = { type: 'poi', label: 'Kahlenberg', postcode: '1190', lat: 48.276, lon: 16.333, maidenhead: 'JN88dg', confidence: 'high' };
  const [r] = parseADIF(toADIF(ev, [{ id: 'x', seq: 1, call: 'OE1AAA', ts: '2026-10-04T10:00:00Z', viaRepeater: false,
    snap: headerSnapshot(header), fields: { qth: 'Kahlenberg' }, loc, note: '' }]));
  assert.equal(r.QTH, 'Kahlenberg');
  assert.equal(r.GRIDSQUARE, 'JN88dg');
});

test('per-line repeater override: snapshot values drive CSV, ADIF and summary', () => {
  const base = headerSnapshot(header); // header repeater OE1XUU 438.950 -7.6
  const ovSnap = { ...base, repeaterCall: 'OE3XSA', repeaterFreq: '145.700', repeaterShift: '-0.6', repeaterTone: '162.2', repeaterOverride: true };
  const ev = { id: 'n', title: 'Verbundübung', template: 'calls', header };
  const es = [
    { id: '1', seq: 1, call: 'OE1AAA', ts: '2026-10-04T10:00:00Z', viaRepeater: true, snap: base, fields: {}, note: '' },
    { id: '2', seq: 2, call: 'OE3BBB', ts: '2026-10-04T10:01:00Z', viaRepeater: true, snap: ovSnap, fields: {}, note: '' },
    { id: '3', seq: 3, call: 'OE3CCC', ts: '2026-10-04T10:02:00Z', viaRepeater: true, snap: ovSnap, fields: {}, note: '' },
    { id: '4', seq: 4, call: 'OE1DDD', ts: '2026-10-04T10:03:00Z', viaRepeater: false, snap: base, fields: {}, note: '' },
  ];
  const lines = toCSV(ev, es).slice(1).trim().split('\r\n');
  const cols = lines[0].split(';');
  const row = i => Object.fromEntries(cols.map((c, j) => [c, lines[i].split(';')[j]]));
  assert.equal(row(1).relais, 'OE1XUU');
  assert.equal(row(1).relais_quelle, 'Header');
  assert.equal(row(2).relais, 'OE3XSA');
  assert.equal(row(2).relais_quelle, 'Zeile');
  assert.equal(row(2).freq_rx_mhz, '145.7');
  assert.equal(row(4).relais_quelle, '');
  const recs = parseADIF(toADIF(ev, es));
  assert.equal(recs[0].APP_OE1EBG_REPEATER, 'OE1XUU');
  assert.equal(recs[0].FREQ_RX, '438.95');
  assert.equal(recs[1].APP_OE1EBG_REPEATER, 'OE3XSA');
  assert.equal(recs[1].FREQ, '145.1');
  assert.equal(recs[1].FREQ_RX, '145.7');
  assert.match(recs[1].COMMENT, /CTCSS 162.2/);
  const sum = toSummary(ev, es);
  assert.match(sum, /Nach Relais:\n  OE3XSA: 2 \(OE3BBB, OE3CCC\)\n  OE1XUU: 1 \(OE1AAA\)\n  direkt: 1 \(OE1DDD\)/);
});

test('KML: same stations as the map, escaped, lon,lat, metadata on <Document>', () => {
  const loc = (lat, lon, extra = {}) => ({ type: 'address', label: 'Währinger Straße 1', postcode: '1090', lat, lon, maidenhead: 'JN88dg', source: 'vienna-ogd', confidence: 'high', manual: false, input: 'Währinger 1', ...extra });
  const ev = { id: 'k', title: 'Übung <A&B> "Ö"', template: 'rst', created: '2026-10-04T09:00:00Z', header };
  const es = [
    { id: '1', seq: 1, call: 'OE1AAA', ts: '2026-10-04T10:00:05Z', viaRepeater: true, snap: snapA, fields: {}, loc: loc(48.2, 16.35) },
    { id: '2', seq: 2, call: 'OE1BBB', ts: '2026-10-04T10:01:00Z', viaRepeater: false, snap: snapA, fields: {}, loc: null },
    { id: '3', seq: 3, call: 'OE1AAA', ts: '2026-10-04T10:05:00Z', viaRepeater: false, snap: snapA, fields: {}, loc: loc(48.21012, 16.36789, { label: 'Café <Ü> & Co', manual: true, confidence: 'likely' }) },
    { id: '4', seq: 4, call: 'OE3CCC', ts: '2026-10-04T10:06:00Z', viaRepeater: false, snap: snapA, fields: {}, loc: loc(48.3, 15.6), deleted: '2026-10-04T10:07:00Z' },
    { id: '5', seq: 5, call: 'OE3DDD', ts: '2026-10-04T10:08:00Z', viaRepeater: false, snap: snapA, fields: {}, loc: loc(48.1, 16.2, { type: 'postcode', label: '2340 Mödling' }) },
  ];
  assert.equal(KML_MIME, 'application/vnd.google-earth.kml+xml');
  assert.equal(xmlEscape('a & b <c> "d" \'e\' Ä\u0001'), 'a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos; Ä');
  const kml = toKML(ev, es);
  assert.ok(kml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2">'));
  assert.ok(!/&(?!amp;|lt;|gt;|quot;|apos;)/.test(kml), 'every & escaped');
  assert.ok(!/<(?![?/]?[A-Za-z])/.test(kml), 'no raw < in text');
  const names = [...kml.matchAll(/<Placemark>\s*<name>([^<]*)<\/name>/g)].map(m => m[1]);
  assert.deepEqual(names, stationsForMap(es).placed.map(s => s.call), 'same set as the map');
  assert.deepEqual(names, ['OE1AAA', 'OE3DDD'], 'no location / deleted omitted');
  const coords = [...kml.matchAll(/<coordinates>([^<]*)<\/coordinates>/g)].map(m => m[1]);
  assert.deepEqual(coords, ['16.36789,48.21012', '16.20000,48.10000'], 'lon,lat; latest located check-in');
  assert.match(kml, /<Document>\n  <name>Übung &lt;A&amp;B&gt; &quot;Ö&quot;<\/name>/, 'title escaped, umlauts kept');
  const doc = kml.slice(kml.indexOf('<Document>'), kml.indexOf('<Placemark>'));
  for (const want of ['2026-10-04', 'OE1EBG', 'OE1XKS', '2 von 3']) assert.ok(doc.includes(want), want);
  assert.match(kml, /<Data name="Standort"><value>Café &lt;Ü&gt; &amp; Co, 1090<\/value><\/Data>/);
  assert.match(kml, /<Data name="Zeit \(UTC\)"><value>2026-10-04 10:00:05 UTC, 2026-10-04 10:05:00 UTC<\/value>/);
  assert.match(kml, /<Data name="Relais"><value>OE1XUU, direkt<\/value>/);
  assert.match(kml, /<Data name="Konfidenz"><value>wahrscheinlich<\/value><\/Data>\n.*<Data name="Zuordnung"><value>gewählt<\/value>/);
  assert.match(kml, /<Data name="Locator"><value>JN88dg<\/value>/);
  // description: HTML escaped as XML text (values escaped twice)
  assert.match(kml, /<description>&lt;b&gt;Rufzeichen:&lt;\/b&gt; OE1AAA&lt;br&gt;/);
  assert.ok(kml.includes('Café &amp;lt;Ü&amp;gt; &amp;amp; Co'));
  assert.equal(toKML(ev, []).match(/<Placemark>/g), null, 'empty log: valid document without placemarks');
});
