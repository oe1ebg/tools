// Austria-wide PLZ / Bezirk areas (data/austria-areas.json) on a small
// synthetic dataset (always runs), plus checks against the real generated
// data when it has been built.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { buildLocationIndex, locate, lookupMaidenhead } from '../tools/shared/js/location/index.js';
import { latLonToMaidenhead } from '../tools/shared/js/maidenhead.js';

function vienna() {
  const S = 1e5, B = (v, base) => Math.round((v - base) * S);
  const rows = [
    ['Hauptstraße', '1', '1100', 10, 48.1750, 16.3700],
    ['Quellenstraße', '10', '1100', 10, 48.1755, 16.3720],
    ['Badener Straße', '3', '1031', 3, 48.2000, 16.3900],
  ];
  return {
    scale: S, latBase: 48, lonBase: 16, plz: ['1031', '1100'],
    streets: [['Badener Straße', 2, 1], ['Hauptstraße', 0, 1], ['Quellenstraße', 1, 1]],
    hn: rows.map(r => r[1]), ap: rows.map(r => (r[2] === '1100' ? 1 : 0)), ad: rows.map(r => r[3]),
    alat: rows.map(r => B(r[4], 48)), alon: rows.map(r => B(r[5], 16)),
    places: [], districts: [[10, ['Favoriten']]], aliases: [], meta: {},
  };
}

// Row layout: see plzFields / bezirkFields in oe1ebg/austria-areas.json.
function areas() {
  return {
    schema: 1, meta: { stichtag: '2026-04-01' },
    states: ['', 'Bgld.', 'Ktn.', 'NÖ', 'OÖ', 'Sbg.', 'Stmk.', 'T', 'Vbg.', 'W'],
    plz: [
      ['1100', 'Wien', [], 9, ['900'], 48.16108, 16.38043, 10416, [['JN88ed', 54], ['JN88ee', 45]], 6, [['JN88', 100]]],
      ['2340', 'Mödling', [], 3, ['317'], 48.08268, 16.2906, 3943, [['JN88db', 53], ['JN88dc', 47]], 2, [['JN88', 100]]],
      ['2380', 'Perchtoldsdorf', [], 3, ['317'], 48.1192, 16.2660, 4000, [['JN88dc', 56], ['JN88dd', 44]], 3, [['JN88', 100]]],
      ['2500', 'Baden', ['Sooß'], 3, ['306'], 48.0060, 16.2340, 6000, [['JN88ca', 59], ['JN87cx', 41]], 4, [['JN88', 70], ['JN87', 30]]],
      ['7000', 'Eisenstadt', [], 1, ['101'], 47.8450, 16.5250, 5000, [['JN87gu', 93], ['JN87gt', 7]], 3, [['JN87', 100]]],
      ['8010', 'Graz', [], 6, ['601'], 47.07317, 15.45681, 10936, [['JN77rb', 77], ['JN77rc', 23]], 3, [['JN77', 100]]],
      ['8020', 'Graz', [], 6, ['601'], 47.0700, 15.4200, 9000, [['JN77qb', 80], ['JN77rb', 20]], 2, [['JN77', 100]]],
      ['8036', 'Graz', [], 6, ['601'], 47.0500, 15.4100, 3000, [['JN77qa', 100]], 1, [['JN77', 100]]],
      ['8041', 'Graz', [], 6, ['601'], 47.0300, 15.4600, 4000, [['JN77ra', 100]], 1, [['JN77', 100]]],
    ],
    bezirke: [
      ['101', 'Eisenstadt (Stadt)', ['Eisenstadt', 'Eisenstadt Stadt', 'Stadt Eisenstadt'], 1, 47.8450, 16.5250, 5000, [['JN87gu', 93]], 3, [['JN87', 100]], ['7000']],
      ['306', 'Baden', [], 3, 47.9500, 16.1500, 40000, [['JN88da', 14], ['JN87cw', 11]], 40, [['JN87', 60], ['JN88', 40]], ['2500']],
      ['317', 'Mödling', [], 3, 48.09558, 16.27628, 34490, [['JN88dc', 36], ['JN88db', 17]], 17, [['JN88', 100]], ['2380', '2340']],
      ['601', 'Graz (Stadt)', ['Graz', 'Graz Stadt', 'Stadt Graz'], 6, 47.06704, 15.43865, 45186, [['JN77rb', 38], ['JN77rc', 19]], 12, [['JN77', 100]], ['8010', '8020']],
      ['900', 'Wien', [], 9, 48.2082, 16.3623, 150513, [['JN88ee', 14]], 25, [['JN88', 100]], ['1220']],
      ['910', 'Favoriten', [], 9, 48.16108, 16.38043, 10416, [['JN88ed', 54], ['JN88ee', 45]], 6, [['JN88', 100]], ['1100']],
    ],
  };
}

const idx = buildLocationIndex(vienna(), areas());
const top = (q, o) => locate(idx, q, o).results[0];

test('PLZ alone -> area with centre locator and covered squares', () => {
  const r = top('2340');
  assert.equal(r.type, 'postcode');
  assert.equal(r.label, '2340 Mödling');
  assert.equal(r.postcode, '2340');
  assert.equal(r.maidenhead, latLonToMaidenhead(48.08268, 16.2906, 6));
  assert.deepEqual(r.areaInfo.locators, [['JN88db', 53], ['JN88dc', 47]]);
  assert.equal(r.areaInfo.state, 'NÖ');
  assert.equal(top('A-2340').postcode, '2340');
});

test('Vienna PLZ uses the Austria-wide area (with locators); 1031 falls back to the Vienna data', () => {
  const r = top('1100');
  assert.equal(r.label, '1100 Wien');
  assert.equal(r.district, 10);
  assert.equal(r.areaInfo.locators[0][0], 'JN88ed');
  const r1031 = top('1031');
  assert.equal(r1031.type, 'postcode');
  assert.equal(r1031.areaInfo, undefined);
});

test('Gemeinde name -> its PLZ first, its Bezirk next (not ambiguous)', () => {
  const res = locate(idx, 'Mödling').results;
  assert.equal(res[0].label, '2340 Mödling');
  assert.equal(res[1].type, 'bezirk');
  assert.notEqual(res[0].confidence, 'ambiguous');
  assert.equal(top('Perchtoldsdorf').postcode, '2380');
  assert.match(top('Sooß').note, /Gemeinde Sooß/);
});

test('"Bezirk X" prefers the Bezirk', () => {
  for (const q of ['Bezirk Mödling', 'Bez. Mödling', 'BH Baden']) {
    const r = top(q);
    assert.equal(r.type, 'bezirk', q);
    assert.ok(r.areaInfo.locators.length, q);
  }
  assert.equal(top('Bezirk Mödling').label, 'Bezirk Mödling, NÖ');
  assert.equal(top('Bezirk Mödling').postcode, undefined, 'a Bezirk has no single PLZ');
});

test('Statutarstadt alias; a Gemeinde with many PLZ goes to its Bezirk', () => {
  const r = top('Graz');
  assert.equal(r.type, 'bezirk');
  assert.equal(r.bezirk, '601');
  assert.ok(locate(idx, 'Eisenstadt').results.some(x => x.type === 'bezirk' && x.bezirk === '101'));
});

test('PLZ outside Vienna + text: no Vienna streets, area result with a note', () => {
  const res = locate(idx, '2340 Hauptstraße').results;
  assert.equal(res.length, 1);
  assert.equal(res[0].type, 'postcode');
  assert.match(res[0].note, /nur für Wien/);
  assert.equal(res[0].confidence, 'low');
  // ... while the Gemeinde name with its PLZ is a confident hit.
  const r = top('2340 Mödling');
  assert.equal(r.label, '2340 Mödling');
  assert.equal(r.evidence.postcodeMatch, true);
});

test('PLZ evidence checks a Bezirk', () => {
  const r = locate(idx, '2500 Baden').results.find(x => x.type === 'bezirk');
  assert.equal(r.evidence.postcodeMatch, true);
});

test('partial PLZ completes', () => {
  const res = locate(idx, '23').results;
  assert.deepEqual(res.map(r => r.postcode).sort(), ['2340', '2380']);
  assert.ok(res.every(r => r.confidence === 'low'), 'never auto-selected');
  assert.equal(locate(idx, '23').autoSelect, null);
});

test('Vienna district results carry the district locator coverage', () => {
  const r = top('Favoriten');
  assert.equal(r.type, 'district');
  assert.equal(r.areaInfo.locators[0][0], 'JN88ed');
});

test('locator -> Austrian PLZ in that square', () => {
  const m = lookupMaidenhead(idx, 'JN77rb');
  assert.deepEqual(m.areaPostcodes.map(p => p.postcode), ['8010', '8020']);
  assert.equal(m.centerPostcode, '8010');
  const r = top('JN77rb');
  assert.equal(r.postcode, '8010');
  assert.equal(r.city, 'Graz');
  assert.ok(lookupMaidenhead(idx, 'JN87').areaPostcodes.some(p => p.postcode === '7000'));
});

test('without austria-areas.json everything still works Vienna-only', () => {
  const v = buildLocationIndex(vienna());
  assert.equal(locate(v, '2340').results.length, 0);
  assert.equal(locate(v, '1100').results[0].label, '1100 Wien');
  assert.equal(locate(v, 'Quellenstraße 10').results[0].type, 'address');
});

const REAL_V = new URL('../tools/shared/data/vienna-locations.json', import.meta.url);
const REAL_A = new URL('../tools/shared/data/austria-areas.json', import.meta.url);
const haveReal = existsSync(REAL_V) && existsSync(REAL_A);

test('real data: every PLZ and Bezirk resolves', { skip: !haveReal && 'data not built (just build-confirm)' }, () => {
  const areasData = JSON.parse(readFileSync(REAL_A, 'utf8'));
  const real = buildLocationIndex(JSON.parse(readFileSync(REAL_V, 'utf8')), areasData);
  assert.ok(areasData.plz.length > 2000);
  for (const [plz] of areasData.plz) {
    const r = locate(real, plz).results[0];
    assert.equal(r?.postcode, plz, plz);
    assert.ok(r.areaInfo.locators.length >= 1, plz);
  }
  for (const [code, name] of areasData.bezirke) {
    if (code.startsWith('9')) continue;
    assert.ok(locate(real, `Bezirk ${name}`).results.some(r => r.bezirk === code), name);
  }
  assert.equal(locate(real, '1010').results[0].maidenhead, 'JN88ef');
  assert.equal(locate(real, 'Mödling').results[0].label, '2340 Mödling');
  assert.equal(locate(real, 'Graz').results[0].bezirk, '601');
  assert.equal(locate(real, 'Finkenstein am Faaker See').results[0].label.split(' ').slice(1).join(' '), 'Finkenstein am Faaker See');
  const t = performance.now();
  for (const q of ['2340', 'Bezirk Liezen', 'Krems', 'Innsbruck', '23', 'JN77rb']) locate(real, q);
  assert.ok((performance.now() - t) / 6 < 100, 'lookup under 100 ms');
});
