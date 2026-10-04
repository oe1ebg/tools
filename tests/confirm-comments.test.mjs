// Operator comments / log markers (issue #32): model, exporters, backup
// round-trip, automatic markers on header changes.
process.env.TZ = 'Europe/Vienna';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkinNumbers, previousCheckins, stats, liveSorted, liveCheckins, isComment, headerSnapshot, emptyHeader,
  newComment, headerChangeMarkers, operatorShifts, COMMENT_CATEGORIES, CAT_FREQ, CAT_HANDOVER,
} from '../docs/confirm/js/model.js';
import { toCSV, toADIF, toKML, toSummary } from '../docs/confirm/js/export.js';
import { stationsForMap } from '../docs/confirm/js/mapdata.js';

const header = {
  ...emptyHeader(), operator: 'OE1ABC', station: 'OE1XKS', freq: '145.500', mode: 'FM', myGrid: 'JN88ef',
  viaRepeater: true, repeaterCall: 'OE1XUU', repeaterFreq: '438.950', repeaterShift: '-7.6',
};
const header2 = { ...header, operator: 'OE1XYZ' };
const event = { id: 'ev', title: 'Rundspruch', template: 'calls', header: header2 };
const loc = { label: 'Kahlenberg', lat: 48.27, lon: 16.33, maidenhead: 'JN88dg', confidence: 'exact', manual: true };

// A check-in, a comment, a check-in, a handover marker, a repeat check-in;
// plus a deleted comment. Comments carry no seq.
const entries = [
  { id: 'a', eventId: 'ev', seq: 1, call: 'OE1AAA', ts: '2026-10-04T16:00:00.000Z', viaRepeater: true, snap: headerSnapshot(header), fields: {}, note: '', loc },
  { id: 'k1', eventId: 'ev', kind: 'comment', ts: '2026-10-04T16:05:00.000Z', text: 'Netz pausiert', category: 'Unterbrechung', snap: headerSnapshot(header), created: '2026-10-04T16:05:00.000Z' },
  { id: 'b', eventId: 'ev', seq: 2, call: 'OE1BBB', ts: '2026-10-04T16:10:00.000Z', viaRepeater: false, snap: headerSnapshot(header), fields: {}, note: '' },
  { id: 'k2', eventId: 'ev', kind: 'comment', ts: '2026-10-04T17:30:00.000Z', text: 'OE1XYZ übernimmt von OE1ABC', category: CAT_HANDOVER, auto: 'operator', snap: headerSnapshot(header2), created: '2026-10-04T17:30:00.000Z' },
  { id: 'c', eventId: 'ev', seq: 3, call: 'OE1AAA', ts: '2026-10-04T17:40:00.000Z', viaRepeater: true, snap: headerSnapshot(header2), fields: {}, note: '' },
  { id: 'k3', eventId: 'ev', kind: 'comment', ts: '2026-10-04T17:45:00.000Z', text: 'gelöscht', category: '', snap: headerSnapshot(header2), deleted: '2026-10-04T17:46:00.000Z' },
];

test('old entries without `kind` are check-ins', () => {
  assert.equal(isComment({ id: 'x', call: 'OE1AAA' }), false);
  assert.equal(isComment(entries[1]), true);
  assert.deepEqual(liveCheckins(entries).map(e => e.id), ['a', 'b', 'c']);
  assert.deepEqual(liveSorted(entries).map(e => e.id), ['a', 'k1', 'b', 'k2', 'c'], 'comments in time order, deleted left out');
});

test('comments do not affect check-in numbering, statistics or repeat detection', () => {
  const withC = checkinNumbers(entries);
  const without = checkinNumbers(entries.filter(e => !isComment(e)));
  assert.deepEqual([...withC], [...without]);
  assert.equal(withC.get('c'), 2, 'repeat check-in of OE1AAA');
  assert.equal(withC.has('k1'), false, 'no check-in number for a comment');
  assert.deepEqual(stats(entries), { total: 3, unique: 2 });
  assert.deepEqual(previousCheckins(entries, 'OE1AAA', 'c').map(e => e.id), ['a']);
  assert.deepEqual(previousCheckins(entries, undefined), []);
  assert.deepEqual(previousCheckins(entries, '').map(e => e.id), []);
});

test('map leaves comments out', () => {
  const { placed, unplaced } = stationsForMap(entries);
  assert.deepEqual([...placed, ...unplaced].map(s => s.call).sort(), ['OE1AAA', 'OE1BBB']);
  assert.equal(placed.find(s => s.call === 'OE1AAA').checkins.length, 2);
});

test('ADIF excludes comments', () => {
  const adi = toADIF(event, entries, '2026-10-04T18:00:00Z');
  assert.equal((adi.match(/<EOR>/g) || []).length, 3);
  assert.ok(!adi.includes('Netz pausiert'));
  assert.ok(!adi.includes('uebernimmt'));
  assert.ok(!/<CALL:0>/.test(adi));
});

test('KML excludes comments', () => {
  const kml = toKML(event, entries);
  assert.equal((kml.match(/<Placemark>/g) || []).length, 1);
  assert.ok(!kml.includes('Netz pausiert'));
  assert.ok(kml.includes('1 von 2'), 'station count without comments');
});

function parseCSV(csv) {
  const lines = csv.slice(1).trim().split('\r\n');
  const cols = lines[0].split(';');
  return { cols, rows: lines.slice(1).map(l => Object.fromEntries(cols.map((c, j) => [c, l.split(';')[j]]))) };
}

test('CSV leaves comments out by default (no typ column)', () => {
  const { cols, rows } = parseCSV(toCSV(event, entries, ';'));
  assert.ok(!cols.includes('typ'));
  assert.ok(!cols.includes('kategorie'));
  assert.equal(cols[0], 'zeitstempel_utc');
  assert.deepEqual(rows.map(r => r.rufzeichen), ['OE1AAA', 'OE1BBB', 'OE1AAA']);
  assert.deepEqual(rows.map(r => r.checkin_nr), ['1', '1', '2']);
});

test('CSV option "Operator-Kommentare einschließen": typ column, empty QSO fields, time order', () => {
  const { cols, rows } = parseCSV(toCSV(event, entries, ';', { comments: true }));
  assert.deepEqual(cols.slice(0, 3), ['zeitstempel_utc', 'typ', 'kategorie'], 'time stays first');
  assert.deepEqual(rows.map(r => r.typ), ['checkin', 'kommentar', 'checkin', 'kommentar', 'checkin']);
  const k = rows[1];
  assert.equal(k.zeitstempel_utc, '2026-10-04 16:05:00');
  assert.equal(k.kategorie, 'Unterbrechung');
  assert.equal(k.notiz, 'Netz pausiert');
  assert.equal(k.operator, 'OE1ABC');
  for (const c of ['nr', 'checkin_nr', 'rufzeichen', 'ueber_relais', 'relais', 'freq_mhz', 'band', 'mode']) assert.equal(k[c], '', c);
  assert.equal(rows[3].operator, 'OE1XYZ', 'handover marker carries the new operator');
  assert.equal(rows[4].checkin_nr, '2', 'numbering unchanged');
  assert.equal(rows[0].kategorie, '');
});

test('summary includes comments in time order and an Operators line', () => {
  const s = toSummary(event, entries);
  assert.match(s, /2 Stationen, 3 Check-ins/);
  assert.match(s, /Operators: OE1ABC 16:00–17:30, OE1XYZ 17:30–17:40 UTC/);
  const i1 = s.indexOf('16:05 [Unterbrechung] Netz pausiert (Op OE1ABC)');
  const i2 = s.indexOf('17:30 [Schichtwechsel / Übergabe] OE1XYZ übernimmt von OE1ABC (Op OE1XYZ)');
  assert.ok(i1 > 0 && i2 > i1, s);
  assert.ok(!s.includes('gelöscht'), 'deleted comment left out');
  assert.match(toSummary(event, entries, 'local'), /Operators: OE1ABC 18:00–19:30, OE1XYZ 19:30–19:40 UTC\+2/);
  // One operator only: no Operators line, no comment section.
  const plain = toSummary(event, entries.filter(e => !isComment(e) && e.snap.operator === 'OE1ABC'));
  assert.ok(!plain.includes('Operators:'));
  assert.ok(!plain.includes('Operator-Kommentare'));
});

test('operatorShifts: runs of the same operator from the snapshots', () => {
  assert.deepEqual(operatorShifts(entries), [
    { operator: 'OE1ABC', from: '2026-10-04T16:00:00.000Z', to: '2026-10-04T17:30:00.000Z' },
    { operator: 'OE1XYZ', from: '2026-10-04T17:30:00.000Z', to: '2026-10-04T17:40:00.000Z' },
  ]);
  assert.deepEqual(operatorShifts([]), []);
});

test('JSON backup round-trip keeps comments; old backups without kind still load as check-ins', () => {
  const backup = { format: 'oe1ebg-confirm-backup', version: 1, events: [{ event, entries, revisions: [] }] };
  const back = JSON.parse(JSON.stringify(backup)).events[0].entries;
  assert.deepEqual(back, entries);
  assert.deepEqual(stats(back), stats(entries));
  assert.equal(toSummary(event, back), toSummary(event, entries));
  assert.equal(toCSV(event, back, ';', { comments: true }), toCSV(event, entries, ';', { comments: true }));
  // A pre-#32 backup: no kind fields at all.
  const old = JSON.parse(JSON.stringify(entries.filter(e => !isComment(e))));
  assert.ok(old.every(e => !('kind' in e)));
  assert.deepEqual(stats(old), { total: 3, unique: 2 });
});

test('newComment: comment entry with header snapshot, no callsign, no seq', () => {
  const c = newComment({ eventId: 'ev', ts: '2026-10-04T18:00:00.000Z', text: '  Relais ausgefallen ', category: 'Technik', header });
  assert.equal(c.kind, 'comment');
  assert.equal(c.text, 'Relais ausgefallen');
  assert.equal(c.category, 'Technik');
  assert.equal(c.snap.operator, 'OE1ABC');
  assert.equal(c.snap.repeaterCall, 'OE1XUU');
  assert.equal(c.deleted, null);
  assert.ok(!('call' in c) && !('seq' in c));
  assert.ok(c.id && c.created);
  assert.deepEqual(COMMENT_CATEGORIES, ['Frequenzwechsel', 'Schichtwechsel / Übergabe', 'Unterbrechung', 'Technik', 'Sonstiges']);
});

test('headerChangeMarkers: operator change -> handover marker', () => {
  const { markers, base } = headerChangeMarkers(header, header2);
  assert.equal(markers.length, 1);
  assert.equal(markers[0].category, CAT_HANDOVER);
  assert.equal(markers[0].text, 'OE1XYZ übernimmt von OE1ABC');
  assert.equal(markers[0].auto, 'operator');
  assert.equal(base.operator, 'OE1XYZ');
  assert.deepEqual(headerChangeMarkers(base, header2).markers, [], 'no second marker for the same change');
});

test('headerChangeMarkers: repeater change, repeater off, direct frequency change', () => {
  const r = headerChangeMarkers(header, { ...header, repeaterCall: 'OE3XSA', repeaterFreq: '438.900' });
  assert.equal(r.markers.length, 1);
  assert.equal(r.markers[0].category, CAT_FREQ);
  assert.equal(r.markers[0].text, 'OE1XUU (438.950 MHz) → OE3XSA (438.900 MHz)');
  const off = headerChangeMarkers(r.base, { ...header, repeaterCall: 'OE3XSA', repeaterFreq: '438.900', viaRepeater: false });
  assert.equal(off.markers[0].text, 'OE3XSA (438.900 MHz) → direkt (145.500 MHz)');
  const qsy = headerChangeMarkers(off.base, { ...header, viaRepeater: false, freq: '145.525' });
  assert.equal(qsy.markers.length, 1);
  assert.equal(qsy.markers[0].text, 'direkt (145.500 MHz) → direkt (145.525 MHz)');
  // A direct-frequency change while on a repeater is no change of what is used.
  assert.deepEqual(headerChangeMarkers(header, { ...header, freq: '145.600' }).markers, []);
});

test('headerChangeMarkers: both at once, half-typed states, unrelated fields, fresh log', () => {
  const both = headerChangeMarkers(header, { ...header2, repeaterCall: 'OE3XSA' });
  assert.deepEqual(both.markers.map(m => m.category), [CAT_HANDOVER, CAT_FREQ]);
  // Cleared operator / ticked repeater without callsign: wait, keep base.
  const half = headerChangeMarkers(header, { ...header, operator: '', repeaterCall: '' });
  assert.deepEqual(half.markers, []);
  assert.equal(half.base.operator, 'OE1ABC');
  assert.equal(half.base.repeaterCall, 'OE1XUU');
  const done = headerChangeMarkers(half.base, { ...header, operator: 'OE1XYZ', repeaterCall: 'OE1XUU' });
  assert.deepEqual(done.markers.map(m => m.text), ['OE1XYZ übernimmt von OE1ABC']);
  // Station, locator, QTH, mode: no marker.
  assert.deepEqual(headerChangeMarkers(header, { ...header, station: 'OE1XAA', myGrid: 'JN88ee', mode: 'DMR', myQth: 'X' }).markers, []);
  // A fresh log (no lines yet): setting up the header writes nothing, but the base moves on.
  const fresh = headerChangeMarkers(emptyHeader(), header, false);
  assert.deepEqual(fresh.markers, []);
  assert.deepEqual(headerChangeMarkers(fresh.base, header).markers, []);
  // First operator in a log that already has lines.
  assert.equal(headerChangeMarkers({ ...header, operator: '' }, header).markers[0].text, 'Operator OE1ABC');
});

test('lines before and after a marker keep their own header snapshot', () => {
  const { rows } = parseCSV(toCSV(event, entries, ';', { comments: true }));
  assert.deepEqual(rows.map(r => r.operator), ['OE1ABC', 'OE1ABC', 'OE1ABC', 'OE1XYZ', 'OE1XYZ']);
});
