// Notfunk Stichzeit / Aufgabezeit (issue #20): a draft restore keeps what was
// typed, and a moved message does not keep times of its old day. Run in
// several device time zones: Austrian time must not depend on them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyForm, formToFields, messageToForm, upgradeForm } from '../tools/notfunk/js/form.js';
import { newMessage } from '../tools/notfunk/js/model.js';

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
