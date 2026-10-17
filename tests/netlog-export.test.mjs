// Netlog's session exports (tools/netlog/js/export.js): ADIF against the
// ADIF 3.1.7 rules (our validator and tests/adif-spec.mjs), the CSV files
// (spreadsheet-safe, UTC, estimated times marked) and the report data.
// Synthetic callsigns only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryStore } from '../tools/netlog/js/memstore.js';
import { NETLOG_STORES } from '../tools/netlog/js/db.js';
import {
  createSession, updateSession, addParticipant, updateParticipant, createRound, createNote, toggleResponse, setItemText,
  toggleTask, setNcs, deleteParticipant, setStatus,
} from '../tools/netlog/js/ops.js';
import {
  netAdif, netAdifIssues, stationsCsv, notesCsv, reportData, radioInfo, parseRadioText, parseFreqText, adifBand, exportBase,
} from '../tools/netlog/js/export.js';
import { validateAdif } from '../tools/shared/js/adif-validate.js';
import { readADI, isCompleteQSO } from './adif-spec.mjs';
import { t, setLang } from '../tools/netlog/js/i18n.js';

const TAB = 'tab-test';
const REPEATERS = [
  { call: 'OE0XQR', out: 438.95, in: 431.35, shift: -7.6, modes: ['FM'] },
  { call: 'OE0XQD', out: 438.5, in: 430.9, shift: -7.6, modes: ['DMR', 'FM'] },
];

async function fixture() {
  const store = memoryStore(NETLOG_STORES);
  const s = await createSession(store, { tab: TAB }, { own: 'OE0QXZ', name: 'Testrunde <Ä>', round: 1, radio: { repeater: 'OE0XQR 438.950' } });
  const ctx = { sessionId: s.id, tab: TAB };
  const n = await addParticipant(store, ctx, { call: 'OE0QXN', name: 'Nora', qth: 'Wien', locator: 'jn88ee12' });
  const a = await addParticipant(store, ctx, { call: 'oe0qxa', name: 'Änne "A"', qth: '=SUMME(1)', locator: 'JN88' });
  await addParticipant(store, ctx, { call: 'OE0QX?' });
  await addParticipant(store, ctx, { call: 'OE0QXZ' }); // me
  const gone = await addParticipant(store, ctx, { call: 'OE0QXG' });
  await deleteParticipant(store, ctx, gone.id);
  await setNcs(store, ctx, n.id);
  await setStatus(store, ctx, a.id, 'out');
  // an estimated check-in time
  const raw = await store.get('participants', a.id);
  await store.tx([{ store: 'participants', put: { ...raw, presence: [{ ...raw.presence[0], from: { iso: '2026-10-16T18:05:00.000Z', quality: 'estimated' } }, ...raw.presence.slice(1)] } }]);
  const note = await createNote(store, ctx, { participantId: a.id, text: '=1+1 antenna\nsecond line' });
  await toggleResponse(store, ctx, note.id, true);
  const items = await store.getAll('items');
  await setItemText(store, ctx, items.find(i => i.kind === 'response').id, 'ask about the antenna');
  await toggleTask(store, ctx, note.id, true);
  await createRound(store, ctx, {});
  await createNote(store, ctx, { participantId: n.id, text: 'round two' });
  const all = name => store.getAll(name).then(l => l.filter(r => r.eventId === s.id));
  const session = await store.get('sessions', s.id);
  return {
    store, ctx, ids: { n: n.id, a: a.id },
    data: { session, participants: await all('participants'), rounds: await all('rounds'), notes: await all('notes'), items: await all('items'), contributions: await all('contributions') },
  };
}

test('repeater/frequency text: call and MHz; band from the ADIF band table', () => {
  assert.deepEqual(parseRadioText('OE0XQR 438.950'), { call: 'OE0XQR', mhz: 438.95 });
  assert.deepEqual(parseRadioText('3,650 MHz'), { call: null, mhz: 3.65 });
  assert.deepEqual(parseRadioText('OE0XQR'), { call: 'OE0XQR', mhz: null });
  assert.deepEqual(parseRadioText(''), { call: null, mhz: null });
  assert.equal(adifBand(438.95), '70cm');
  assert.equal(adifBand(145.6), '2m');
  assert.equal(adifBand(3.65), '80m');
  assert.equal(adifBand(1000), '');
  assert.equal(adifBand(null), '');
});

test('frequency field: MHz or an ADIF band name; separate from the repeater', () => {
  assert.deepEqual(parseFreqText('145.500'), { mhz: 145.5, band: '2m' });
  assert.deepEqual(parseFreqText('3,650 MHz'), { mhz: 3.65, band: '80m' });
  assert.deepEqual(parseFreqText('2m'), { mhz: null, band: '2m' });
  assert.deepEqual(parseFreqText('70CM'), { mhz: null, band: '70cm' });
  assert.deepEqual(parseFreqText(''), { mhz: null, band: '' });
  // a direct net: frequency only, no repeater, no PROP_MODE
  let r = radioInfo({ radio: { repeater: '', freq: '144.300', mode: 'SSB' } }, REPEATERS);
  assert.equal(r.repeater, null);
  assert.equal(r.txMHz, 144.3);
  assert.equal(r.band, '2m');
  // a band only ("2m SSB net")
  r = radioInfo({ radio: { freq: '2m', mode: 'SSB' } }, REPEATERS);
  assert.equal(r.txMHz, null);
  assert.equal(r.band, '2m');
  // a repeater off the list with its own frequency field
  r = radioInfo({ radio: { repeater: 'OE0XQX', freq: '145.600' } }, REPEATERS);
  assert.equal(r.repeater, 'OE0XQX');
  assert.equal(r.txMHz, 145.6);
});

test('ADIF of a direct 2m SSB net: BAND without FREQ, no PROP_MODE; still valid', async () => {
  const { data } = await fixture();
  const session = { ...data.session, radio: { repeater: '', freq: '2m', mode: 'SSB' } };
  const adi = netAdif({ ...data, session }, { repeaters: REPEATERS });
  const v = validateAdif(adi, { today: '20261017' });
  assert.equal(v.errors, 0, JSON.stringify(v.issues));
  const { records } = readADI(adi);
  for (const r of records) {
    assert.ok(isCompleteQSO(r));
    assert.equal(r.BAND, '2m');
    assert.equal(r.FREQ, undefined);
    assert.equal(r.MODE, 'SSB');
    assert.equal(r.PROP_MODE, undefined);
    assert.equal(r.APP_OE1EBG_REPEATER, undefined);
  }
  assert.deepEqual(netAdifIssues({ ...data, session }, REPEATERS).problems, []);
});

test('radio facts: the repeater list gives input/output and a single usable mode; a set mode wins', () => {
  let r = radioInfo({ radio: { repeater: 'OE0XQR 438.950' } }, REPEATERS);
  assert.equal(r.fromList, true);
  assert.equal(r.txMHz, 431.35);
  assert.equal(r.rxMHz, 438.95);
  assert.deepEqual(r.mode, ['FM', '']);
  assert.equal(r.modeFromList, true);
  r = radioInfo({ radio: { repeater: 'OE0XQD', mode: '' } }, REPEATERS);
  assert.equal(r.mode, null, 'two modes in the list: none chosen');
  r = radioInfo({ radio: { repeater: 'OE0XQD', mode: 'DMR' } }, REPEATERS);
  assert.deepEqual(r.mode, ['DIGITALVOICE', 'DMR']);
  r = radioInfo({ radio: { repeater: '3.650', mode: 'SSB' } }, null);
  assert.equal(r.repeater, null);
  assert.equal(r.txMHz, 3.65);
});

test('ADIF: one valid QSO per checked-in station; me, partial and deleted ones left out; notes never in it', async () => {
  const { data } = await fixture();
  const adi = netAdif(data, { createdIso: '2026-10-16T20:00:00.000Z', programVersion: 'abc1234', repeaters: REPEATERS });
  const v = validateAdif(adi, { today: '20261017' });
  assert.equal(v.errors, 0, JSON.stringify(v.issues));
  assert.equal(v.warnings, 0, JSON.stringify(v.issues));
  const { header, records } = readADI(adi);
  assert.equal(header.ADIF_VER, '3.1.7');
  assert.equal(header.PROGRAMID, 'OE1EBG');
  assert.equal(header.PROGRAMVERSION, 'abc1234');
  assert.deepEqual(records.map(r => r.CALL), ['OE0QXN', 'OE0QXA'], 'NCS first; no OE0QX?, no OE0QXZ (me), no deleted OE0QXG');
  for (const r of records) {
    assert.ok(isCompleteQSO(r), JSON.stringify(r));
    assert.equal(r.STATION_CALLSIGN, 'OE0QXZ');
    assert.equal(r.MODE, 'FM');
    assert.equal(r.PROP_MODE, 'RPT');
    assert.equal(r.FREQ, '431.35');
    assert.equal(r.BAND, '70cm');
    assert.equal(r.FREQ_RX, '438.95');
    assert.equal(r.APP_OE1EBG_REPEATER, 'OE0XQR');
    assert.equal(r.APP_OE1EBG_NET, 'Testrunde Ae');
  }
  const [n, a] = records;
  assert.match(n.COMMENT, /NCS/);
  assert.equal(n.GRIDSQUARE, 'JN88ee12');
  assert.equal(a.QSO_DATE, '20261016');
  assert.equal(a.TIME_ON, '180500');
  assert.match(a.COMMENT, /check-in time estimated/);
  assert.equal(a.NAME, 'Aenne "A"');
  assert.ok(!adi.includes('antenna') && !adi.includes('round two'), 'no notes');
});

test('ADIF issues: what is left out and what is missing, before the export', async () => {
  const { data } = await fixture();
  let r = netAdifIssues(data, REPEATERS);
  assert.deepEqual(r.skipped, [{ call: 'OE0QX?', why: 'partial' }]);
  assert.deepEqual(r.problems, []);
  r = netAdifIssues({ ...data, session: { ...data.session, radio: { repeater: 'somewhere' }, own: { call: '', base: '' } } }, REPEATERS);
  assert.deepEqual(r.problems, ['noMode', 'noBand', 'noOwn']);
  // without a mode the file is still valid ADI (logbooks complain about the QSOs)
  const adi = netAdif({ ...data, session: { ...data.session, radio: {} } }, { repeaters: null });
  assert.equal(validateAdif(adi, { today: '20261017' }).errors, 0);
});

test('stations CSV: every live station, NCS first, UTC, estimated marked, formulas defused; both languages', async () => {
  const { data } = await fixture();
  setLang('en');
  const csv = stationsCsv(data, t);
  assert.ok(csv.startsWith('\ufeffCallsign;Name;QTH;Locator;Status;Role;Check-in date (UTC);Check-in time (UTC);Check-in time;'));
  const lines = csv.trim().split('\r\n');
  assert.equal(lines.length, 1 + 4, 'header + four live stations');
  assert.match(lines[1], /^OE0QXN;Nora;Wien;jn88ee12;active \(checked in\);NCS;/);
  assert.match(lines[2], /^OE0QXA;"Änne ""A""";'=SUMME\(1\);JN88;checked out;;2026-10-16;18:05:00;estimated;\d{4}-\d\d-\d\d;\d\d:\d\d:\d\d;0;1$/);
  assert.ok(lines.some(l => l.startsWith('OE0QXZ;') && l.includes(';me;')));
  setLang('de');
  assert.ok(stationsCsv(data, t).startsWith('\ufeffRufzeichen;Name;QTH;'));
  setLang('en');
});

test('notes CSV: recorded order, round, response with its reply, task; multiline kept, formulas defused', async () => {
  const { data } = await fixture();
  setLang('en');
  const csv = notesCsv(data, t);
  const lines = csv.slice(1).replace(/\r\n$/, '').split(/\r\n(?=\d{4}-)/);
  assert.equal(lines[0].split(';')[0], 'Date (UTC)');
  assert.match(lines[1], /;1;OE0QXA;"Änne ""A""";"'=1\+1 antenna\nsecond line";open;ask about the antenna;open$/);
  assert.match(lines[2], /;2;OE0QXN;Nora;round two;;;$/);
});

test('report data: rounds oldest first, notes grouped by station; file names', async () => {
  const { data } = await fixture();
  const r = reportData(data);
  assert.deepEqual(r.stations.map(p => p.call), ['OE0QXN', 'OE0QXA', 'OE0QX?', 'OE0QXZ']);
  assert.deepEqual(r.rounds.map(x => x.number), [1, 2]);
  assert.equal(r.rounds[0].groups[0].p.call, 'OE0QXA');
  assert.equal(r.rounds[1].groups[0].notes[0].text, 'round two');
  assert.equal(exportBase({ ...data.session, date: '2026-10-16' }, null), '2026-10-16_testrunde-a');
  assert.equal(exportBase({ date: '2026-10-16', name: '' }, null), '2026-10-16_netlog');
});
