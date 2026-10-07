// Emergency traffic log: entry form <-> message fields, and the printouts
// (tools/notfunk/js/form.js, print.js).
process.env.TZ = 'Europe/Vienna'; // local-time input is read as Vienna time
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyForm, setDirection, parseParty, partyText, formToFields, messageToForm, replyForm,
  nextStep, statusSteps, bookSummary, readTime,
} from '../tools/notfunk/js/form.js';
import { formSheet, blankFormSheet, bookSheet } from '../tools/notfunk/js/print.js';
import { newMessage, setStatus, softDelete } from '../tools/notfunk/js/model.js';
import { formatNumber } from '../tools/notfunk/js/numbering.js';

const NOW = '2026-10-07T12:53:00.000Z'; // 14:53 MESZ
const OP = { id: 'op1', name: 'Übung Blackout Wien', prefix: 'W1', station: 'Einsatzleitstelle', home: 'Stab', freq: '145.500', via: '' };

function save(form, seq, now = NOW) {
  const { fields, errors } = formToFields(form, { mode: 'local', now });
  assert.deepEqual(errors, []);
  return newMessage(fields, { prefix: 'W1', seq, number: formatNumber('W1', seq) }, { id: `m${seq}`, opId: 'op1', operator: 'oe1ebg', now });
}

const filled = {
  ...emptyForm(OP), from: 'Lichtinsel 12 Floridsdorf', subject: 'Aggregat ausgefallen',
  text: 'Aggregat seit 14:45 aus.\n40 Personen vor Ort.', priority: 'emergency', alarm: true, type: 'anforderung',
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

test('time: empty = now, HH:MM local on the day of now, full date', () => {
  assert.equal(readTime('', 'local', NOW), NOW);
  assert.equal(readTime('14:05', 'local', NOW), '2026-10-07T12:05:00.000Z');
  assert.equal(readTime('2026-10-06 23:30', 'local', NOW), '2026-10-06T21:30:00.000Z');
  assert.equal(readTime('25:00', 'local', NOW), null);
  const { errors } = formToFields({ ...filled, time: '14.05' }, { mode: 'local', now: NOW });
  assert.deepEqual(errors, ['Zeit: HH:MM oder JJJJ-MM-TT HH:MM']);
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

test('form errors: sender, recipient, subject or text', () => {
  const { errors } = formToFields(emptyForm({ ...OP, home: '' }), { mode: 'local', now: NOW });
  assert.deepEqual(errors, ['Absender fehlt', 'Empfänger fehlt', 'Betreff oder Inhalt fehlt']);
});

test('message -> form -> message round trip', () => {
  const m = save({ ...filled, distribution: 'S3, S4', remarks: 'Rückruf zugesagt', origStation: 'oe3xyz', origFiled: '14:40' }, 1);
  const again = formToFields(messageToForm(m), { mode: 'local', now: '2026-10-08T00:00:00.000Z' }).fields;
  for (const k of ['direction', 'channel', 'type', 'priority', 'alarm', 'subject', 'text', 'remarks', 'readBack']) assert.deepEqual(again[k], m[k], k);
  assert.equal(again.ts, '2026-10-07T12:53:00.000Z');
  assert.deepEqual(again.distribution, ['S3', 'S4']);
  assert.deepEqual(again.from, m.from);
  assert.deepEqual(again.origin, { station: 'OE3XYZ', place: '', filed: '2026-10-07T12:40:00.000Z' });
});

test('edit keeps the stored time to the second unless the time is changed', () => {
  const m = save(filled, 1, '2026-10-07T12:53:41.250Z');
  const f = messageToForm(m);
  assert.equal(formToFields(f, { mode: 'local', now: NOW }).fields.ts, '2026-10-07T12:53:41.250Z');
  assert.equal(formToFields({ ...f, time: '2026-10-07 14:50' }, { mode: 'local', now: NOW }).fields.ts, '2026-10-07T12:50:00.000Z');
});

test('reply: other direction, parties swapped, linked', () => {
  const m = save(filled, 1);
  const r = replyForm(m, OP);
  assert.equal(r.direction, 'out');
  assert.equal(r.from, 'Stab');
  assert.equal(r.to, 'Lichtinsel 12 Floridsdorf');
  assert.equal(r.replyTo, 'm1');
  assert.equal(r.type, 'meldung');
  assert.equal(r.subject, 'Antwort: Aggregat ausgefallen');
  assert.equal(replyForm(save(r, 2), OP).subject, 'Antwort: Aggregat ausgefallen');
});

test('next step and status steps', () => {
  let m = save(filled, 1);
  assert.deepEqual(nextStep(m), { state: 'forwarded', label: 'weiterleiten', done: 'weitergeleitet' });
  m = setStatus(m, 'forwarded', { operator: 'oe1ebg', now: NOW });
  assert.equal(nextStep(m).state, 'acknowledged');
  m = setStatus(m, 'answered', { operator: 'oe1ebg', now: NOW });
  assert.equal(nextStep(m), null);
  const steps = statusSteps(m);
  assert.deepEqual(steps.map(s => [s.state, s.done, s.skipped]), [
    ['logged', true, false], ['forwarded', true, false], ['acknowledged', false, true], ['answered', true, false],
  ]);
});

test('summary: open emergencies, unacknowledged, range, gaps', () => {
  const a = save(filled, 1);
  const b = setStatus(save({ ...filled, priority: 'routine', alarm: false }, 2), 'acknowledged', { operator: 'x', now: NOW });
  const c = softDelete(save(filled, 3), { operator: 'x', now: NOW });
  const s = bookSummary([a, b, c]);
  assert.equal(s.total, 2);
  assert.equal(s.emergencyOpen, 1);
  assert.equal(s.unacknowledged, 1);
  assert.deepEqual(s.range, ['W1-001 bis W1-003']);
  assert.deepEqual(s.gaps, []);
  assert.deepEqual(bookSummary([a, save(filled, 3)]).gaps, ['W1-002']);
});

test('Meldeaufnahmeformular: E-31 fields, Vienna time, channel boxes', () => {
  const m = save({ ...filled, distribution: 'S3' }, 7);
  const s = formSheet(m, OP, { now: NOW, revisions: 1 });
  assert.equal(s.number, 'W1-007');
  assert.equal(s.date, '07.10.2026');
  assert.equal(s.time, '14:53 MESZ');
  assert.equal(s.utc, '12:53 UTC');
  assert.deepEqual(s.directions.map(d => [d.label, d.checked]), [['Eingang', true], ['Ausgang', false]]);
  assert.deepEqual(s.channels.filter(c => c.checked).map(c => [c.label, c.detail]), [['Funk', '145.500 MHz']]);
  assert.equal(s.priority, 'Notfall');
  assert.equal(s.alarm, true);
  assert.equal(s.to, 'Stab · Verteiler: S3');
  assert.equal(s.version, 2);
  assert.equal(s.operator, 'OE1EBG');
  const other = formSheet(save({ ...filled, channel: 'melder' }, 8), OP, { now: NOW });
  assert.deepEqual(other.channels.filter(c => c.checked).map(c => [c.label, c.detail]), [['Anders', 'Melder']]);
});

test('blank form: nothing ticked, nothing filled in', () => {
  const s = blankFormSheet(OP, { now: NOW });
  assert.equal(s.blank, true);
  assert.equal(s.title, 'Übung Blackout Wien');
  assert.equal(s.number, '');
  assert.ok([...s.directions, ...s.channels, ...s.priorities].every(x => !x.checked));
  assert.deepEqual(s.priorities.map(p => p.label), ['Routine', 'Priorität', 'Notfall']);
  assert.deepEqual(s.types, ['Meldung', 'Auftrag', 'Frage', 'Anforderung', 'Lagemeldung']);
  assert.equal(blankFormSheet(null, { now: NOW }).title, '');
});

test('Meldebuch printout: range, deleted left out, oldest first', () => {
  const a = save(filled, 1, '2026-10-07T11:00:00.000Z');
  const b = save({ ...filled, direction: 'out', from: 'Stab', to: 'LI 3', priority: 'routine', alarm: false }, 2, '2026-10-07T12:00:00.000Z');
  const c = softDelete(save(filled, 3, '2026-10-07T12:30:00.000Z'), { operator: 'x', now: NOW });
  const all = bookSheet([c, b, a], OP, { now: NOW });
  assert.deepEqual(all.rows.map(r => r.number), ['W1-001', 'W1-002']);
  assert.equal(all.range, 'gesamter Einsatz');
  assert.deepEqual([all.rows[1].direction, all.rows[1].party, all.rows[1].priority], ['Aus', 'LI 3', '']);
  const part = bookSheet([a, b], OP, { now: NOW, fromIso: '2026-10-07T11:30:00.000Z' });
  assert.deepEqual(part.rows.map(r => r.number), ['W1-002']);
  assert.match(part.range, /^07\.10\.2026 13:30 MESZ bis jetzt$/);
});
