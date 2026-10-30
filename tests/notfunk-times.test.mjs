// Notfunk Stichzeit / Aufgabezeit (issue #20): a draft restore keeps what was
// typed, and a moved message does not keep times of its old day. Run in
// several device time zones: Austrian time must not depend on them.
// Issue #153: the changes of time (2026-03-29 02:00 -> 03:00, 2026-10-25
// 03:00 -> 02:00, both at 01:00 UTC) need no zone choice; stored times are
// absolute instants.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyForm, formToFields, messageToForm, upgradeForm, readDateTime, readClock } from '../tools/notfunk/js/form.js';
import { newMessage, setStatus, fmtVienna, viennaDate, viennaTime, isoVienna } from '../tools/notfunk/js/model.js';
import { toGeschaeftsbuchCSV, GB_COLUMNS } from '../tools/notfunk/js/export.js';

const NOW = '2026-10-07T12:53:00.000Z'; // 14:53 MESZ
const OP = { id: 'op1', name: 'Übung', prefix: 'W1', home: 'Stab' };
const filled = { ...emptyForm(OP), from: 'Lichtinsel 12', subject: 'Lage', text: 'Text', type: 'lagemeldung' };

function inZone(tz, fn) {
  const old = process.env.TZ;
  process.env.TZ = tz;
  try {
    fn();
  } finally {
    if (old === undefined) delete process.env.TZ;
    else process.env.TZ = old;
  }
}

for (const tz of ['America/New_York', 'Europe/Vienna', 'Asia/Tokyo']) {
  test(`draft restore keeps a typed Stichzeit/Aufgabezeit (TZ ${tz})`, () => inZone(tz, () => {
    assert.equal(upgradeForm({ stichzeit: '1405' }).stichzeit, '14:05');
    assert.equal(upgradeForm({ origFiled: '14.05' }).origFiled, '14:05');
    assert.equal(upgradeForm({ stichzeit: '9:05' }).stichzeit, '09:05');
    assert.equal(upgradeForm({ stichzeit: '2026-10-07 14:05' }).stichzeit, '14:05', 'older drafts with a date');
    assert.equal(upgradeForm({ origFiled: '2026-10-07T14:05:30' }).origFiled, '14:05');
    assert.equal(upgradeForm({ stichzeit: '' }).stichzeit, '');
    assert.equal(upgradeForm({}).origFiled, '');
    // unreadable text is kept, the field warning shows it
    assert.equal(upgradeForm({ stichzeit: 'gegen Mittag' }).stichzeit, 'gegen Mittag');
    assert.equal(upgradeForm({ origFiled: '25:99' }).origFiled, '25:99');
    const bad = formToFields(upgradeForm({ ...filled, stichzeit: 'gegen Mittag' }), { now: NOW });
    assert.equal(bad.fieldErrors.stichzeit, 'Stichzeit als Uhrzeit (HH:MM)');
    // a restored "1405" saves as 14:05 (before the message at 14:53)
    const ok = formToFields(upgradeForm({ ...filled, stichzeit: '1405' }), { now: NOW });
    assert.equal(ok.fieldErrors.stichzeit, undefined);
    assert.equal(ok.fields.stichzeit, '2026-10-07T12:05:00.000Z');
  }));

  test(`a moved message does not keep Stichzeit/Aufgabezeit of its old day (TZ ${tz})`, () => inZone(tz, () => {
    const at = '2026-10-08T12:30:00.000Z';
    // 2026-10-08 14:00 MESZ, Stichzeit 13:00, Aufgabezeit 12:30
    const { fields, errors } = formToFields({ ...filled, date: '2026-10-08', time: '14:00', stichzeit: '13:00', origFiled: '12:30' }, { now: at });
    assert.deepEqual(errors, []);
    const m = newMessage(fields, { prefix: 'W1', seq: 1, number: 'W1-001' }, { id: 'm1', opId: 'op1', operator: 'oe1ebg', now: at });
    assert.equal(m.stichzeit, '2026-10-08T11:00:00.000Z');
    const form = messageToForm(m);
    const edit = f => formToFields(f, { now: NOW, editing: true }).fields;
    // nothing moved: the stored times are kept as they are (seconds included)
    const same = edit({ ...form, stichzeitTs: '2026-10-08T11:00:42.000Z' });
    assert.equal(same.stichzeit, '2026-10-08T11:00:42.000Z');
    // the date moved by a day: read again against the new message time
    const moved = edit({ ...form, date: '2026-10-09' });
    assert.equal(moved.ts, '2026-10-09T12:00:00.000Z');
    assert.equal(moved.stichzeit, '2026-10-09T11:00:00.000Z');
    assert.equal(moved.origin.filed, '2026-10-09T10:30:00.000Z');
    // the time of day moved
    assert.equal(edit({ ...form, time: '12:00' }).stichzeit, '2026-10-07T11:00:00.000Z', '13:00 is after 12:00: the day before');
    assert.equal(edit({ ...form, time: '15:30' }).stichzeit, '2026-10-08T11:00:00.000Z');
    // the Stichzeit itself changed
    assert.equal(edit({ ...form, stichzeit: '13:30' }).stichzeit, '2026-10-08T11:30:00.000Z');
  }));
}

const ZONES = ['America/New_York', 'Europe/Vienna', 'Asia/Tokyo', 'UTC'];
const read = (date, time, now) => readDateTime(date, time, now);

for (const tz of ZONES) {
  test(`March: the skipped hour 02:00-02:59 is refused with a hint, 01:59 and 03:00 are read (TZ ${tz})`, () => inZone(tz, () => {
    const now = '2026-03-29T08:00:00.000Z'; // 10:00 MESZ
    assert.equal(read('2026-03-29', '01:59', now), '2026-03-29T00:59:00.000Z');
    for (const t of ['02:00', '02:30', '02:59']) assert.equal(read('2026-03-29', t, now), null, t);
    assert.equal(read('2026-03-29', '03:00', now), '2026-03-29T01:00:00.000Z');
    // the day before and after have a 02:30
    assert.equal(read('2026-03-28', '02:30', now), '2026-03-28T01:30:00.000Z');
    assert.equal(read('2026-03-30', '02:30', now), '2026-03-30T00:30:00.000Z');
    const { fieldErrors } = formToFields({ ...filled, date: '2026-03-29', time: '02:30' }, { now });
    assert.match(fieldErrors.time, /Diese Uhrzeit gibt es nicht.*von 02:00 auf 03:00.*03:00 oder später.*01:59 oder früher/, 'says what is wrong and what to do');
    assert.doesNotMatch(fieldErrors.time, /MESZ|MEZ/);
    assert.equal(formToFields({ ...filled, date: '2026-03-29', time: '03:00' }, { now }).fieldErrors.time, undefined);
    // an impossible date keeps its own message
    assert.match(formToFields({ ...filled, date: '2026-02-30', time: '10:00' }, { now }).fieldErrors.time, /Datum gibt es nicht/);
  }));

  test(`October: the repeated hour is resolved by the reference time, below/at/above the hour (TZ ${tz})`, () => inZone(tz, () => {
    const D = '2026-10-25';
    const first = (hhmm) => `${D}T00:${hhmm}:00.000Z`; // 02:mm MESZ
    const second = (hhmm) => `${D}T01:${hhmm}:00.000Z`; // 02:mm MEZ
    // not in the hour: the first run (summer time)
    for (const now of ['2026-10-24T23:59:59.000Z' /* 01:59:59 MESZ, just before */, '2026-10-25T02:00:00.000Z' /* 03:00 MEZ, just after */, '2026-10-25T08:00:00.000Z', '2026-10-20T10:00:00.000Z']) {
      assert.equal(read(D, '02:30', now), first('30'), `now ${now}`);
    }
    // now in the first run (02:xx MESZ): the nearest, i.e. the first run unless the typed time is far into the second
    assert.equal(read(D, '02:10', `${D}T00:00:00.000Z`), first('10'), 'now = the very first instant of the hour');
    assert.equal(read(D, '02:10', first('30')), first('10'));
    assert.equal(read(D, '02:50', first('30')), first('50'), '20 min ahead is nearer than 40 min back');
    assert.equal(read(D, '02:50', first('05')), first('50'), '45 min ahead of now beats 75 min ahead');
    // now in the second run (02:xx MEZ): the second run
    assert.equal(read(D, '02:10', second('20')), second('10'));
    assert.equal(read(D, '02:30', second('20')), second('30'));
    assert.equal(read(D, '02:05', second('59')), second('05'));
    assert.equal(read(D, '02:10', `${D}T01:59:59.000Z`), second('10'), 'now = the very last second of the hour');
    // the neighbouring hours are not ambiguous at all
    assert.equal(read(D, '01:59', second('20')), '2026-10-24T23:59:00.000Z');
    assert.equal(read(D, '03:00', first('30')), `${D}T02:00:00.000Z`);
    assert.equal(read(D, '03:00', second('20')), `${D}T02:00:00.000Z`);
    // other days: no repeated hour
    assert.equal(read('2026-10-24', '02:30', second('20')), '2026-10-24T00:30:00.000Z');
    assert.equal(read('2026-10-26', '02:30', second('20')), '2026-10-26T01:30:00.000Z');
    // through the form, nothing but the typed text is needed
    const a = formToFields({ ...filled, date: D, time: '02:30' }, { now: second('20') });
    assert.deepEqual([a.errors, a.fields.ts], [[], second('30')]);
    const b = formToFields({ ...filled, date: D, time: '02:30' }, { now: '2026-10-25T08:00:00.000Z' });
    assert.deepEqual([b.errors, b.fields.ts], [[], first('30')]);
    // a live (empty) date and time is now, in either run
    assert.equal(formToFields({ ...filled, date: '', time: '' }, { now: second('20') }).fields.ts, second('20'));
  }));

  test(`messages stored in the repeated hour show the same times, no zone anywhere (TZ ${tz})`, () => inZone(tz, () => {
    const D = '2026-10-25';
    const at = `${D}T08:00:00.000Z`;
    const mk = (seq, ts) => newMessage(
      formToFields({ ...filled, date: viennaDate(ts), time: viennaTime(ts) }, { now: ts }).fields,
      { prefix: 'W1', seq, number: `W1-00${seq}` }, { id: `r${seq}`, opId: 'op1', operator: 'oe1ebg', now: ts });
    const m1 = mk(1, `${D}T00:30:00.000Z`), m2 = mk(2, `${D}T01:30:00.000Z`);
    // two messages 02:30 and 02:30: told apart by their instants, which are stored as absolute ISO UTC
    assert.deepEqual([m1.ts, m2.ts], [`${D}T00:30:00.000Z`, `${D}T01:30:00.000Z`]);
    assert.deepEqual([m1.created, m2.created], [m1.ts, m2.ts]);
    assert.deepEqual([fmtVienna(m1.ts), fmtVienna(m2.ts)], ['2026-10-25 02:30', '2026-10-25 02:30']);
    assert.deepEqual([isoVienna(m1.ts), isoVienna(m2.ts)], ['2026-10-25T02:30:00+02:00', '2026-10-25T02:30:00+01:00']);
    // editing without touching the time keeps the instant of either run, whatever "now" is
    for (const m of [m1, m2]) {
      const f = messageToForm(m);
      assert.ok(!('zone' in f));
      assert.equal(formToFields({ ...f, subject: 'neu' }, { now: at, editing: true }).fields.ts, m.ts);
    }
    // status steps keep their instants; the CSV carries them with the offset
    const fwd = setStatus(m2, 'forwarded', { operator: 'x', now: `${D}T01:40:00.000Z`, to: 'MSS', at: `${D}T01:35:00.000Z` });
    assert.equal(fwd.status.at(-1).at, `${D}T01:35:00.000Z`);
    assert.equal(fwd.updated, `${D}T01:40:00.000Z`);
    const csv = toGeschaeftsbuchCSV([m1, fwd]).slice(1).trimEnd().split('\r\n');
    const col = (line, name) => line.split(';')[GB_COLUMNS.indexOf(name)];
    assert.equal(col(csv[1], 'Zeitstempel (ISO 8601)'), '2026-10-25T02:30:00+02:00');
    assert.equal(col(csv[2], 'Zeitstempel (ISO 8601)'), '2026-10-25T02:30:00+01:00');
    assert.equal(col(csv[2], 'Übergeben / übertragen um'), '02:35');
    assert.equal(col(csv[2], 'Übergeben / übertragen um (ISO 8601)'), '2026-10-25T02:35:00+01:00');
    assert.equal(col(csv[2], 'Erfasst (ISO 8601)'), '2026-10-25T02:30:00+01:00');
    assert.equal(col(csv[1], 'Übergeben / übertragen um (ISO 8601)'), '');
    assert.ok(!csv.join('\n').match(/MESZ|MEZ/), 'no zone name in the CSV');
    // a draft saved by the version with the zone choice still restores
    const old = upgradeForm({ ...filled, date: D, time: '02:30', zone: 'MEZ' });
    assert.deepEqual([old.date, old.time, old.zone], [D, '02:30', undefined]);
  }));

  test(`Stichzeit/Aufgabezeit around the changes of time and midnight (TZ ${tz})`, () => inZone(tz, () => {
    // October: the latest 02:30 at most 5 minutes after the message
    assert.equal(readClock('02:30', '2026-10-25T01:40:00.000Z'), '2026-10-25T01:30:00.000Z', 'message 02:40 MEZ: the second run');
    assert.equal(readClock('02:30', '2026-10-25T00:40:00.000Z'), '2026-10-25T00:30:00.000Z', 'message 02:40 MESZ: only the first run is past');
    assert.equal(readClock('02:30', '2026-10-25T00:20:00.000Z'), '2026-10-24T00:30:00.000Z', 'message 02:20 MESZ: not yet, the day before');
    assert.equal(readClock('02:30', '2026-10-25T00:25:00.000Z'), '2026-10-25T00:30:00.000Z', 'five minutes of drift are allowed');
    // after the change, a time before it is the same night
    assert.equal(readClock('01:50', '2026-10-25T01:10:00.000Z'), '2026-10-24T23:50:00.000Z');
    // midnight (CET): 23:50 for a message at 00:10 is the day before
    assert.equal(readClock('23:50', '2026-10-25T23:10:00.000Z'), '2026-10-25T22:50:00.000Z');
    // March: a time that does not exist today is read as the day before (known behaviour)
    assert.equal(readClock('02:30', '2026-03-29T01:10:00.000Z'), '2026-03-28T01:30:00.000Z');
    assert.equal(readClock('01:50', '2026-03-29T01:10:00.000Z'), '2026-03-29T00:50:00.000Z');
    assert.equal(readClock('03:30', '2026-03-29T01:40:00.000Z'), '2026-03-29T01:30:00.000Z');
  }));
}
