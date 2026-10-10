// Emergency traffic log: entry form <-> message fields, and the printouts
// (tools/notfunk/js/form.js, print.js).
process.env.TZ = 'America/New_York'; // Austrian time must not depend on the device's zone
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyForm, setDirection, parseParty, partyText, formToFields, messageToForm, replyForm,
  nextStep, statusSteps, bookSummary, normDate, normTime, readDateTime, readClock, readBound, dateText, clockText, needsZone, upgradeForm, formIsBlank, normalizeRef,
} from '../tools/notfunk/js/form.js';
import { formSheet, blankFormSheet, bookSheet } from '../tools/notfunk/js/print.js';
import { newMessage, setStatus, softDelete, addAttempt, normFreq, fmtFreq } from '../tools/notfunk/js/model.js';
import { formatNumber } from '../tools/notfunk/js/numbering.js';

const NOW = '2026-10-07T12:53:00.000Z'; // 14:53 MESZ
const OP = { id: 'op1', name: 'Übung Blackout Wien', prefix: 'W1', call: 'OE1XKS', station: 'Einsatzleitstelle', home: 'Stab', freq: '145.500', via: '' };

function save(form, seq, now = NOW) {
  const { fields, errors } = formToFields(form, { now });
  assert.deepEqual(errors, []);
  return newMessage(fields, { prefix: 'W1', seq, number: formatNumber('W1', seq) }, { id: `m${seq}`, opId: 'op1', operator: 'oe1ebg', now });
}

const filled = {
  ...emptyForm(OP), from: 'Lichtinsel 12 Floridsdorf', subject: 'Aggregat ausgefallen',
  text: 'Aggregat seit 14:45 aus.\n40 Personen vor Ort.', priority: 'emergency', type: 'anforderung',
};

test('empty form: operation defaults, own post receives', () => {
  const f = emptyForm(OP);
  assert.equal(f.direction, 'in');
  assert.equal(f.to, 'Stab');
  assert.equal(f.freq, '145.500');
  assert.equal(f.channel, 'funk');
});

test('direction switch moves the untouched own post', () => {
  const out = setDirection(emptyForm(OP), 'out', OP);
  assert.equal(out.from, 'Stab');
  assert.equal(out.to, '');
  assert.equal(setDirection(out, 'in', OP).to, 'Stab');
  // typed values stay where they are
  const typed = setDirection({ ...emptyForm(OP), from: 'LI 3' }, 'out', OP);
  assert.equal(typed.from, 'LI 3');
  assert.equal(typed.to, 'Stab');
});

test('parties: callsign, name / call, plain name', () => {
  assert.deepEqual(parseParty('oe1abc'), { name: '', call: 'OE1ABC', contact: '' });
  assert.deepEqual(parseParty('Stab S4 / oe1abc'), { name: 'Stab S4', call: 'OE1ABC', contact: '' });
  assert.deepEqual(parseParty('Lichtinsel 12'), { name: 'Lichtinsel 12', call: '', contact: '' });
  assert.deepEqual(parseParty('S4 / Versorgung'), { name: 'S4 / Versorgung', call: '', contact: '' });
  assert.equal(partyText({ name: 'Stab S4', call: 'OE1ABC' }), 'Stab S4 / OE1ABC');
  assert.equal(partyText({ name: '', call: 'OE1ABC' }), 'OE1ABC');
});

test('time: date and time in Austrian local time; empty = now, no date = today', () => {
  assert.equal(readDateTime('', '', NOW), NOW);
  assert.equal(readDateTime('', '14:05', NOW), '2026-10-07T12:05:00.000Z');
  assert.equal(readDateTime('2026-10-06', '23:30', NOW), '2026-10-06T21:30:00.000Z');
  assert.equal(readDateTime('2026-01-06', '23:30', NOW), '2026-01-06T22:30:00.000Z', 'winter time');
  assert.equal(readDateTime('2026-10-06', '', NOW), null, 'date without time');
  assert.equal(readDateTime('2026-03-29', '02:30', NOW), null, 'skipped when the clocks go forward');
  assert.equal(readDateTime('', '25:00', NOW), null);
  const { errors, fieldErrors } = formToFields({ ...filled, date: '2026-10-07', time: '' }, { now: NOW });
  assert.deepEqual(errors, ['Uhrzeit fehlt']);
  assert.deepEqual(Object.keys(fieldErrors), ['time']);
  assert.deepEqual(formToFields({ ...filled, date: '2026-03-29', time: '02:30' }, { now: NOW }).fieldErrors,
    { time: 'Diese Uhrzeit gibt es an dem Tag nicht (Datum ungültig oder Zeitumstellung)' });
});

test('dates and times are typed in one fixed format: YYYY-MM-DD, 24-hour HH:MM', () => {
  assert.deepEqual(['14:05', '9:05', '14.05', '1405', '905', ''].map(normTime), ['14:05', '09:05', '14:05', '14:05', '09:05', '']);
  assert.deepEqual(['2:30 PM', '24:00', '14:60', '14'].map(normTime), [null, null, null, null]);
  assert.deepEqual(['2026-10-08', '20261008', ''].map(normDate), ['2026-10-08', '2026-10-08', '']);
  assert.deepEqual(['10/08/2026', '08.10.2026', '2026/10/08'].map(normDate), [null, null, null], 'no US order, no slashes');
  assert.equal(readDateTime('20261006', '2330', NOW), '2026-10-06T21:30:00.000Z');
  assert.equal(formToFields({ ...filled, date: '10/07/2026', time: '14:05' }, { now: NOW }).fieldErrors.time, 'Datum als JJJJ-MM-TT, z. B. 2026-10-08');
  assert.equal(formToFields({ ...filled, date: '', time: '2:05 PM' }, { now: NOW }).fieldErrors.time, 'Uhrzeit als HH:MM, z. B. 14:05');
});

test('time: the hour that repeats when the clocks go back needs MESZ or MEZ', () => {
  const night = '2026-10-25T02:10:00.000Z'; // 03:10 MEZ, after the change
  assert.ok(needsZone('2026-10-25', '02:30'));
  assert.ok(!needsZone('2026-10-25', '03:30'));
  assert.equal(readDateTime('2026-10-25', '02:30', night, 'MESZ'), '2026-10-25T00:30:00.000Z');
  assert.equal(readDateTime('2026-10-25', '02:30', night, 'MEZ'), '2026-10-25T01:30:00.000Z');
  assert.equal(readDateTime('2026-10-25', '02:30', night), '2026-10-25T01:30:00.000Z', 'nearest now without a choice');
  const m = save({ ...filled, date: '2026-10-25', time: '02:30', zone: 'MESZ' }, 1, night);
  assert.equal(m.ts, '2026-10-25T00:30:00.000Z');
  const f = messageToForm(m);
  assert.deepEqual([f.date, f.time, f.zone], ['2026-10-25', '02:30', 'MESZ']);
  assert.equal(formToFields({ ...f, zone: 'MEZ' }, { now: night }).fields.ts, '2026-10-25T01:30:00.000Z', 'choice changed on edit');
  const s = formSheet(m, OP, { now: night });
  assert.deepEqual([s.date, s.time], ['2026-10-25', '02:30 MESZ']);
});

test('time of day (Stichzeit, Aufgabezeit, handover): the last one before, also the day before', () => {
  assert.equal(readClock('14:40', NOW), '2026-10-07T12:40:00.000Z');
  assert.equal(readClock('14:56', NOW), '2026-10-07T12:56:00.000Z', 'a few minutes ahead (clock drift)');
  assert.equal(readClock('15:30', NOW), '2026-10-06T13:30:00.000Z', 'later today = yesterday');
  assert.equal(readClock('23:50', '2026-10-07T22:10:00.000Z'), '2026-10-07T21:50:00.000Z', '00:10 → 23:50 the day before');
  assert.equal(readClock('', NOW), null);
  assert.equal(readClock('x', NOW), null);
});

test('printed range: date alone = whole day, time alone = today', () => {
  assert.equal(readBound('', '', NOW), null);
  assert.equal(readBound('2026-10-06', '', NOW), '2026-10-05T22:00:00.000Z');
  assert.equal(readBound('2026-10-06', '', NOW, true), '2026-10-06T21:59:59.000Z');
  assert.equal(readBound('', '13:30', NOW), '2026-10-07T11:30:00.000Z');
});

test('drafts from before the split date/time fields are upgraded', () => {
  const f = upgradeForm({ ...filled, time: '2026-10-07 9:05', stichzeit: '2026-10-07 08:30', origFiled: '7:15' });
  assert.deepEqual([f.date, f.time, f.stichzeit, f.origFiled], ['2026-10-07', '09:05', '08:30', '07:15']);
  assert.equal(upgradeForm({ ...filled, date: '2026-10-07', time: '14:05' }).time, '14:05');
});

test('time prefill: with the date, so midnight and paper entries stay right', () => {
  assert.deepEqual([dateText(NOW), clockText(NOW)], ['2026-10-07', '14:53']);
  // begun 23:58, saved after midnight: the prefilled day is kept
  const begun = '2026-10-07T21:58:00.000Z';
  const { fields } = formToFields({ ...filled, date: dateText(begun), time: clockText(begun) }, { now: '2026-10-07T22:03:00.000Z' });
  assert.equal(fields.ts, '2026-10-07T21:58:00.000Z');
});

test('blank form: operation defaults and the time do not count', () => {
  assert.equal(formIsBlank(emptyForm(OP), OP), true);
  assert.equal(formIsBlank({ ...emptyForm(OP), date: '2026-10-07', time: '14:53' }, OP), true);
  assert.equal(formIsBlank({ ...emptyForm(OP), peer: 'OE1ABC' }, OP), false);
});

test('warnings ask, they do not block: Funkstelle, time far off', () => {
  const ok = formToFields({ ...filled, peer: 'oe1abc', readBack: true }, { now: NOW });
  assert.deepEqual(ok.warnings, []);
  assert.equal(ok.fields.peer, 'OE1ABC');
  const w = formToFields({ ...filled, date: '2026-10-07', time: '11:00' }, { now: NOW });
  assert.deepEqual(w.errors, []);
  assert.deepEqual(w.warnings, ['Funkstelle fehlt', 'Zeit liegt 4 h zurück (Nachtrag?)']);
  assert.deepEqual(w.fieldWarnings, { peer: 'Funkstelle fehlt', time: 'Zeit liegt 4 h zurück (Nachtrag?)' }, 'each warning names its field');
  assert.deepEqual(formToFields({ ...filled, peer: 'X', readBack: true, time: '15:30' }, { now: NOW }).warnings, ['Zeit liegt in der Zukunft']);
  assert.deepEqual(formToFields({ ...filled, peer: 'X', readBack: false }, { now: NOW }).warnings, [], 'read-back is optional, never asked');
  // an edit keeps its old time without asking; no radio station by phone
  assert.deepEqual(formToFields({ ...filled, channel: 'telefon', readBack: true, date: '2026-10-07', time: '11:00' }, { now: NOW, editing: true }).warnings, []);
  // outgoing: read back at the transmission, not asked here
  assert.deepEqual(formToFields({ ...filled, direction: 'out', peer: 'X' }, { now: NOW }).warnings, []);
});

test('frequency: comma or point, one way to show it', () => {
  assert.equal(normFreq('145,5'), '145.500');
  assert.equal(normFreq('438.9375 MHz'), '438.9375');
  assert.equal(normFreq('145'), '145.000');
  assert.equal(normFreq('KW'), 'KW');
  assert.equal(fmtFreq('145.500'), '145,500');
  assert.equal(save({ ...filled, freq: '145,5' }, 1).radio.freq, '145.500');
});

test('Bezug: a number of this operation links, anything else stays text', () => {
  const a = save(filled, 3);
  const byNumber = new Map([[a.number, a]]);
  assert.equal(normalizeRef('w1-3'), 'W1-003');
  const linked = formToFields({ ...filled, ref: 'w1-3', refKind: 'korrektur' }, { now: NOW, byNumber }).fields;
  assert.deepEqual([linked.replyTo, linked.refNumber, linked.refKind], ['m3', 'W1-003', 'korrektur']);
  const other = formToFields({ ...filled, ref: 'K2-010' }, { now: NOW, byNumber }).fields;
  assert.deepEqual([other.replyTo, other.refNumber, other.refKind], [null, 'K2-010', 'antwort']);
  assert.equal(formToFields(filled, { now: NOW, byNumber }).fields.refKind, null);
});

test('form -> message: verbatim text, Stichzeit only for Lagemeldung', () => {
  const m = save({ ...filled, stichzeit: '14:15' }, 1);
  assert.equal(m.ts, NOW);
  assert.equal(m.text, 'Aggregat seit 14:45 aus.\n40 Personen vor Ort.');
  assert.equal(m.to.name, 'Stab');
  assert.equal(m.radio.freq, '145.500');
  assert.equal(m.stichzeit, null);
  const lm = save({ ...filled, type: 'lagemeldung', stichzeit: '14:15' }, 2);
  assert.equal(lm.stichzeit, '2026-10-07T12:15:00.000Z');
});

test('form errors at the fields: sender, addressee, subject, text', () => {
  const { errors, fieldErrors } = formToFields(emptyForm({ ...OP, home: '' }), { now: NOW });
  assert.deepEqual(Object.keys(fieldErrors), ['from', 'to', 'subject', 'text']);
  assert.equal(fieldErrors.from, 'Absender fehlt: wer gibt die Meldung auf?');
  assert.equal(errors.length, 4);
});

test('message -> form -> message round trip', () => {
  const m = save({ ...filled, distribution: 'S3, S4', remarks: 'Rückruf zugesagt', origStation: 'oe3xyz', origFiled: '14:40' }, 1);
  const again = formToFields(messageToForm(m), { now: '2026-10-08T00:00:00.000Z' }).fields;
  for (const k of ['direction', 'channel', 'type', 'priority', 'subject', 'text', 'remarks', 'readBack']) assert.deepEqual(again[k], m[k], k);
  assert.equal(again.ts, '2026-10-07T12:53:00.000Z');
  assert.deepEqual(again.distribution, ['S3', 'S4']);
  assert.deepEqual(again.from, m.from);
  assert.deepEqual(again.origin, { station: 'OE3XYZ', place: '', filed: '2026-10-07T12:40:00.000Z', placeLoc: null });
  const p = save({ ...filled, peer: 'oe1abc', ref: 'K2-001' }, 2);
  const back = messageToForm(p);
  assert.deepEqual([back.peer, back.ref, back.refKind], ['OE1ABC', 'K2-001', 'antwort']);
});

test('edit keeps the stored time to the second unless the time is changed', () => {
  const m = save(filled, 1, '2026-10-07T12:53:41.250Z');
  const f = messageToForm(m);
  assert.equal(formToFields(f, { now: NOW }).fields.ts, '2026-10-07T12:53:41.250Z');
  assert.equal(formToFields({ ...f, time: '14:50' }, { now: NOW }).fields.ts, '2026-10-07T12:50:00.000Z');
});

test('reply: other direction, parties swapped, linked', () => {
  const m = save(filled, 1);
  const r = replyForm(m, OP);
  assert.equal(r.direction, 'out');
  assert.equal(r.from, 'Stab');
  assert.equal(r.to, 'Lichtinsel 12 Floridsdorf');
  assert.equal(r.replyTo, 'm1');
  assert.deepEqual([r.ref, r.refKind], ['W1-001', 'antwort']);
  assert.equal(r.type, 'meldung');
  assert.equal(r.subject, 'Antwort: Aggregat ausgefallen');
  assert.equal(replyForm(save({ ...r, text: 'Tankwagen um 16 Uhr.' }, 2), OP).subject, 'Antwort: Aggregat ausgefallen');
});

test('next step and status steps', () => {
  let m = save(filled, 1);
  assert.deepEqual(nextStep(m), { state: 'forwarded', label: 'übergeben', done: 'übergeben' });
  const out = save({ ...filled, direction: 'out', from: 'Stab', to: 'LI 3' }, 9);
  assert.deepEqual(nextStep(out), { state: 'forwarded', label: 'übertragen', done: 'übertragen' });
  assert.deepEqual(nextStep(setStatus(out, 'forwarded', { operator: 'x', now: NOW })), { state: 'acknowledged', label: 'Empfang bestätigt', done: 'Empfang bestätigt' });
  m = setStatus(m, 'forwarded', { operator: 'oe1ebg', now: NOW });
  assert.equal(nextStep(m).state, 'acknowledged');
  m = setStatus(m, 'answered', { operator: 'oe1ebg', now: NOW });
  // answered, but the takeover is still to be recorded
  assert.equal(nextStep(m).state, 'acknowledged');
  assert.equal(nextStep(setStatus(m, 'acknowledged', { operator: 'x', now: NOW })), null);
  const steps = statusSteps(m);
  assert.deepEqual(steps.map(s => s.label), ['erfasst', 'übergeben', 'übernommen', 'beantwortet']);
  assert.deepEqual(steps.map(s => [s.state, s.done, s.skipped]), [
    ['logged', true, false], ['forwarded', true, false], ['acknowledged', false, false], ['answered', true, false],
  ]);
});

test('summary: open emergencies, unacknowledged, range, gaps', () => {
  const a = save(filled, 1);
  const b = setStatus(save({ ...filled, priority: 'routine' }, 2), 'acknowledged', { operator: 'x', now: NOW });
  const c = softDelete(save(filled, 3), { operator: 'x', now: NOW });
  const s = bookSummary([a, b, c]);
  assert.equal(s.total, 2);
  assert.equal(s.emergencyOpen, 1);
  assert.equal(s.unacknowledged, 1);
  assert.deepEqual(s.range, ['W1-001 bis W1-003']);
  assert.deepEqual(s.gaps, []);
  assert.deepEqual(bookSummary([a, save(filled, 3)]).gaps, ['W1-002']);
});

test('Meldeaufnahmeformular: fields, date + time, staff block, handover', () => {
  let m = save({ ...filled, distribution: 'S3', peer: 'oe1abc', readBack: true }, 7);
  m = { ...m, staffRef: 'GZ 0412' };
  m = setStatus(m, 'forwarded', { operator: 'oe1ebg', now: NOW, to: 'Meldesammelstelle', at: '2026-10-07T13:00:00.000Z' });
  const s = formSheet(m, OP, { now: NOW, revisions: 1 });
  assert.equal(s.number, 'W1-007');
  assert.equal(s.staffRef, 'GZ 0412');
  // the own station: code, callsign (kept with the message, else the operation's) and address
  assert.equal(s.station, 'W1 · OE1XKS · Einsatzleitstelle');
  assert.equal(formSheet({ ...m, stationCall: 'OE3ABC' }, { ...OP, call: 'OE1XKS' }, { now: NOW }).station, 'W1 · OE3ABC · Einsatzleitstelle', 'the message keeps its own');
  assert.deepEqual([s.timeLabel, s.date, s.time], ['Empfangen am', '2026-10-07', '14:53'], 'local time, no zone');
  assert.deepEqual(s.directions.map(d => [d.label, d.checked]), [['Eingang', true], ['Ausgang', false]]);
  assert.deepEqual(s.channels.filter(c => c.checked).map(c => c.label), ['Funk']);
  assert.deepEqual(s.priorities.filter(p => p.checked).map(p => p.label), ['Notfall']);
  assert.deepEqual(s.types.filter(t => t.checked).map(t => t.label), ['Anforderung']);
  assert.deepEqual([s.from, s.to, s.peer, s.distribution], ['Lichtinsel 12 Floridsdorf', 'Stab', 'OE1ABC', 'S3']);
  assert.equal(s.readBackLabel, 'Rücklesen erfolgt und vom Absender als richtig bestätigt');
  assert.deepEqual(s.handoverHeads, ['Übergeben an', 'Übergabezeitpunkt', 'Übernommen durch', 'Übernahme bestätigt']);
  assert.deepEqual(s.handover, ['Meldesammelstelle', '15:00', '', '']);
  assert.equal(s.status, 'übergeben');
  assert.equal(s.version, 2);
  assert.equal(s.operator, 'OE1EBG');
  const other = formSheet(save({ ...filled, channel: 'fax' }, 8), OP, { now: NOW });
  assert.deepEqual(other.channels.filter(c => c.checked).map(c => c.key), ['anders']);
  assert.equal(other.channelOther, 'Fax');
  // outgoing: sent, transmission, failed attempts
  let out = save({ ...filled, direction: 'out', from: 'Stab', to: 'LI 3', peer: 'oe3xyz' }, 9);
  out = addAttempt(out, { operator: 'x', now: NOW, note: 'keine Antwort' });
  const o = formSheet(out, OP, { now: NOW });
  assert.equal(o.timeLabel, 'Gesendet am');
  assert.equal(o.status, 'zur Übertragung');
  assert.deepEqual(o.handoverHeads, ['Übertragen an', 'Übertragungszeitpunkt', 'Empfang bestätigt durch', 'Fehlversuche / Rückfrage']);
  assert.equal(o.handover[3], '14:53 keine Antwort');
});

test('blank form: nothing ticked, nothing filled in', () => {
  const s = blankFormSheet(OP, { now: NOW });
  assert.equal(s.blank, true);
  assert.equal(s.title, 'Übung Blackout Wien');
  assert.equal(s.number, '');
  assert.ok([...s.directions, ...s.channels, ...s.priorities].every(x => !x.checked));
  assert.deepEqual(s.priorities.map(p => p.label), ['Routine', 'Dringend', 'Notfall']);
  assert.deepEqual(s.types.map(t => [t.label, t.checked]), [['Meldung', false], ['Auftrag', false], ['Frage', false], ['Anforderung', false], ['Lagemeldung', false]]);
  assert.equal(s.timeLabel, 'Empfangen / gesendet am');
  assert.equal(blankFormSheet(null, { now: NOW }).title, '');
});

test('Meldebuch printout: range, deleted left out, oldest first', () => {
  const a = save(filled, 1, '2026-10-07T11:00:00.000Z');
  const b = save({ ...filled, direction: 'out', from: 'Stab', to: 'LI 3', priority: 'routine' }, 2, '2026-10-07T12:00:00.000Z');
  const c = softDelete(save(filled, 3, '2026-10-07T12:30:00.000Z'), { operator: 'x', now: NOW });
  const all = bookSheet([c, b, a], OP, { now: NOW });
  assert.deepEqual(all.rows.map(r => r.number), ['W1-001', 'W1-002']);
  assert.equal(all.range, 'gesamter Einsatz');
  assert.deepEqual([all.rows[1].direction, all.rows[1].party, all.rows[1].priority], ['Aus', 'LI 3', '']);
  const part = bookSheet([a, b], OP, { now: NOW, fromIso: '2026-10-07T11:30:00.000Z' });
  assert.deepEqual(part.rows.map(r => r.number), ['W1-002']);
  assert.match(part.range, /^2026-10-07 13:30 bis jetzt$/);
});

test('date picker: months from Monday, ISO dates; month steps across the year', async () => {
  const { pickerMonth, shiftMonth } = await import('../tools/notfunk/js/picker.js');
  const oct = pickerMonth('2026-10');
  assert.equal(oct.title, 'Oktober 2026');
  // 1 Oct 2026 is a Thursday: three empty cells, then the 1st
  assert.deepEqual(oct.weeks[0], [null, null, null, '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04']);
  assert.equal(oct.weeks.flat().filter(Boolean).length, 31);
  assert.ok(oct.weeks.every(w => w.length === 7));
  assert.equal(pickerMonth('2028-02').weeks.flat().filter(Boolean).length, 29, 'leap year');
  assert.equal(pickerMonth('2026-01').title, 'Jänner 2026');
  assert.equal(shiftMonth('2026-12', 1), '2027-01');
  assert.equal(shiftMonth('2026-01', -1), '2025-12');
});
