// Netlog's time display (tools/netlog/js/clock.js): UTC by default, local
// time on request, always with the zone; typed times read in the shown
// zone. Storage stays UTC.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useLang } from '../tools/netlog/js/i18n.js';
import { timeMode, setTimeMode, hm, hms, zone, hmz, parseHm, localChoiceText } from '../tools/netlog/js/clock.js';
import { splitTime, zoneAbbr, localZoneName, localZoneText } from '../tools/shared/js/time.js';

const ISO = '2026-10-17T19:42:07.000Z';

test('UTC by default, with its zone', () => {
  setTimeMode('utc');
  assert.equal(timeMode(), 'utc');
  assert.equal(hm(ISO), '19:42');
  assert.equal(hms(ISO), '19:42:07');
  assert.equal(zone(ISO), 'UTC');
  assert.equal(hmz(ISO), '19:42 UTC');
  assert.equal(hm(null), '');
  assert.equal(parseHm('19:05', ISO), '2026-10-17T19:05:00.000Z');
  assert.equal(parseHm('25:00', ISO), null);
});

test('local time: the device zone, labelled; typed times in that zone', () => {
  setTimeMode('local');
  assert.equal(timeMode(), 'local');
  assert.equal(hm(ISO), splitTime(ISO, 'local').time.slice(0, 5));
  useLang('de');
  assert.equal(zone(ISO), zoneAbbr(ISO, 'de'));
  assert.match(hmz(ISO), /^\d{2}:\d{2} \S+$/);
  useLang('en');
  assert.equal(zone(ISO), zoneAbbr(ISO, 'en'));
  const back = parseHm(hm(ISO), ISO);
  assert.equal(back.slice(11, 16), ISO.slice(11, 16), 'what is shown reads back as the same instant');
  setTimeMode('bogus');
  assert.equal(timeMode(), 'utc');
});


test('the local choice names the zone and its offset', () => {
  const name = localZoneName();
  assert.equal(typeof name, 'string');
  const text = localZoneText('local', ISO);
  assert.match(text, /\(UTC([+−]\d+(:\d{2})?)?\)$/);
  if (name) assert.ok(text.startsWith(name));
});

test('local zone short names per language and per instant (Europe/Vienna)', { skip: localZoneName() !== 'Europe/Vienna' }, () => {
  const summer = '2026-07-01T10:00:00Z', winter = '2026-01-15T10:00:00Z';
  setTimeMode('local');
  useLang('de');
  assert.equal(zone(summer), 'MESZ');
  assert.equal(zone(winter), 'MEZ');
  assert.equal(localChoiceText('local', summer), 'Europe/Vienna (MESZ)');
  useLang('en');
  assert.equal(zone(summer), 'CEST');
  assert.equal(zone(winter), 'CET');
  assert.equal(hmz(summer), '12:00 CEST');
  setTimeMode('utc');
  assert.equal(zone(summer), 'UTC');
  useLang('de');
});
