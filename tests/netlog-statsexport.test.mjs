// The series statistics as CSV (tools/netlog/js/statsexport.js): columns, escaping, qualities,
// empty cells for unknown values, ISO UTC instants, one row per station and session, order.
// Synthetic callsigns only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useLang, t } from '../tools/netlog/js/i18n.js';
import { seriesStatistics } from '../tools/netlog/js/stats.js';
import { callBase } from '../tools/netlog/js/model.js';
import { seriesStatsCsv, seriesStatsBase, stxDuration, stxInstant, stxQuality } from '../tools/netlog/js/statsexport.js';

const T = (d, hm, quality = 'exact') => ({ iso: `${d}T${hm}:00.000Z`, quality });
const NONE = { iso: null, quality: 'unknown' };

function net(sid, date, number, { start = '18:00', end = '19:00', late = false, ncs = null } = {}, stations = []) {
  const session = { id: sid, seriesId: 'ser', number, name: '', date, created: `${date}T00:00:00.000Z`, start: late ? NONE : T(date, start), end: late ? NONE : T(date, end), ncsId: ncs, deleted: null };
  const data = { session, participants: [], rounds: [{ id: `${sid}r1`, eventId: sid, number: 1, order: 1, topic: '', start: late ? NONE : T(date, start), deleted: null }], contributions: [], notes: [], events: [] };
  stations.forEach(([call, from, to, name = ''], i) => {
    const id = `${sid}p${i}`;
    data.participants.push({ id, eventId: sid, call, base: callBase(call), name, profileId: null, status: 'active', rosterOrder: i + 1, created: `${date}T00:00:0${i}.000Z`, presence: from ? [{ from: T(date, from), to: to ? T(date, to) : null }] : [], deleted: null });
    if (from) data.events.push({ id: `${id}e`, eventId: sid, type: 'presence', kind: 'checkin', participantId: id, time: T(date, from), deleted: null });
  });
  return data;
}

// the CSV as rows of cells (the quoting undone; no cell here has a line break)
function parse(csv, sep = ';') {
  assert.ok(csv.startsWith('﻿'), 'BOM');
  assert.ok(csv.endsWith('\r\n'));
  return csv.slice(1, -2).split('\r\n').map(line => {
    const cells = [];
    let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
      else if (c === '"') q = true;
      else if (c === sep) { cells.push(cur); cur = ''; } else cur += c;
    }
    cells.push(cur);
    return cells;
  });
}

const series = () => [
  net('b', '2026-10-08', 2, { late: true }, [['OE0TEST', '18:05', null, 'Mira']]),
  net('a', '2026-10-01', 1, { ncs: 'ap0' }, [['OE0TEST', '18:00', '19:00', 'Mira'], ['DL0XYZ', '18:10', '18:40'], ['OE0AAA', null, null], ['?', '18:20', '18:30']]),
];

test('durations, instants and qualities', () => {
  assert.equal(stxDuration(0), '00:00:00');
  assert.equal(stxDuration(3661999), '01:01:01');
  assert.equal(stxDuration(100 * 3600000), '100:00:00');
  assert.equal(stxDuration(null), '');
  assert.equal(stxDuration(-5), '');
  assert.equal(stxInstant('2026-10-01T18:00:00.000Z'), '2026-10-01T18:00:00Z');
  assert.equal(stxInstant('2026-10-01T18:00:00.250Z'), '2026-10-01T18:00:00.250Z');
  assert.equal(stxInstant(null), '');
  assert.equal(stxInstant('nonsense'), '');
  assert.equal(stxQuality({ ms: 1, quality: 'exact', leftOut: 0 }), 'exact');
  assert.equal(stxQuality({ ms: 1, quality: 'estimated', leftOut: 0 }), 'estimated');
  assert.equal(stxQuality({ ms: 1, quality: 'exact', leftOut: 2 }), 'estimated');
  assert.equal(stxQuality({ ms: null, quality: 'unknown', leftOut: 1 }), 'unknown');
});

test('header: one title per column, German and English', () => {
  useLang('en');
  const en = parse(seriesStatsCsv(seriesStatistics([]), 'Evening net', t));
  assert.equal(en.length, 1);
  assert.equal(en[0].length, 21);
  assert.deepEqual(en[0].slice(0, 7), ['Series', 'Session date', 'Session no.', 'Session start (UTC)', 'Callsign', 'Name', 'Attended']);
  assert.match(en[0][18], /ESTIMATE/);
  useLang('de');
  const de = parse(seriesStatsCsv(seriesStatistics([]), 'Abendrunde', t));
  assert.deepEqual(de[0].slice(0, 7), ['Serie', 'Sitzung Datum', 'Sitzung Nr.', 'Sitzung Beginn (UTC)', 'Rufzeichen', 'Name', 'Anwesend']);
  assert.match(de[0][18], /GESCHÄTZT/);
  assert.equal(new Set(de[0]).size, 21, 'every title is different');
  useLang('en');
});

test('a series without sessions: the header only', () => {
  useLang('en');
  const csv = seriesStatsCsv(seriesStatistics([]), 'Evening net', t);
  assert.equal(csv.split('\r\n').length, 2);
  assert.equal(parse(csv).length, 1);
});

test('one row per station and session, oldest session first, roster order, unresolved calls left out', () => {
  useLang('en');
  const rows = parse(seriesStatsCsv(seriesStatistics(series()), 'Evening net', t)).slice(1);
  assert.deepEqual(rows.map(r => [r[1], r[2], r[4]]), [
    ['2026-10-01', '1', 'OE0TEST'], ['2026-10-01', '1', 'DL0XYZ'], ['2026-10-01', '1', 'OE0AAA'], ['2026-10-08', '2', 'OE0TEST'],
  ]);
  assert.ok(rows.every(r => r.length === 21 && r[0] === 'Evening net'));
});

test('values: ISO UTC instants, hh:mm:ss, qualities, empty cells for unknown, never 0 for unknown', () => {
  useLang('en');
  const [, a1, , a3, b1] = parse(seriesStatsCsv(seriesStatistics(series()), 'Evening net', t));
  // OE0TEST in session 1: net control, 18:00-19:00, checked in at the start
  assert.deepEqual(a1.slice(3), ['2026-10-01T18:00:00Z', 'OE0TEST', 'Mira', 'yes', '01:00:00', 'exact', '0', '2026-10-01T18:00:00Z', '00:00:00', 'exact', 'yes', '01:00:00', 'exact', '0', '0', '00:00:00', 'estimated', '0']);
  // OE0AAA never checked in: not attended, nothing measured, check-in unknown (empty cells)
  assert.deepEqual(a3.slice(4), ['OE0AAA', '', 'no', '00:00:00', 'exact', '0', '', '', 'unknown', 'no', '00:00:00', 'exact', '0', '0', '00:00:00', 'estimated', '0']);
  // session 2 was joined late: no start, so no offset; the open interval has no end: time present unknown
  assert.equal(b1[3], '');
  assert.deepEqual(b1.slice(6, 13), ['yes', '', 'unknown', '1', '2026-10-08T18:05:00Z', '', 'unknown']);
});

test('speaking time is marked as an estimate with the turns that could not be counted', () => {
  useLang('en');
  const data = net('s', '2026-10-01', 1, {}, [['OE0TEST', '18:00', '19:00'], ['DL0XYZ', '18:10', '18:40']]);
  data.contributions.push({ id: 'c1', eventId: 's', participantId: 'sp0', roundId: 'sr1', seq: 1, time: T('2026-10-01', '18:00'), deleted: null });
  data.contributions.push({ id: 'c2', eventId: 's', participantId: 'sp1', roundId: 'sr1', seq: 2, time: T('2026-10-01', '18:10'), deleted: null });
  data.contributions.push({ id: 'c3', eventId: 's', participantId: 'sp1', roundId: 'sr1', seq: 3, time: { iso: null, quality: 'unknown' }, deleted: null });
  const rows = parse(seriesStatsCsv(seriesStatistics([data]), 'S', t)).slice(1);
  assert.deepEqual(rows[0].slice(16), ['1', '0', '00:10:00', 'estimated', '0']);
  // the second station: its turns are bounded by an unknown time, nothing measurable -> empty, not 0
  assert.deepEqual(rows[1].slice(16), ['2', '0', '', 'unknown', '2']);
});

test('escaping: separator, quotes, line breaks and formula starts in a name or series', () => {
  useLang('en');
  const data = net('s', '2026-10-01', 1, {}, [['OE0TEST', '18:00', '19:00', 'Mira; "M" =1+1'], ['DL0XYZ', '18:10', '18:40', '-cmd']]);
  const csv = seriesStatsCsv(seriesStatistics([data]), '=Evening;net', t);
  const rows = parse(csv).slice(1);
  assert.equal(rows[0][0], "'=Evening;net");
  assert.equal(rows[0][5], 'Mira; "M" =1+1');
  assert.equal(rows[1][5], "'-cmd");
  assert.ok(csv.includes('"\'=Evening;net"'));
});

test('another separator and a number-less session', () => {
  useLang('en');
  const data = net('s', '2026-10-01', null, {}, [['OE0TEST', '18:00', '19:00']]);
  const rows = parse(seriesStatsCsv(seriesStatistics([data]), 'S', t, ','), ',').slice(1);
  assert.equal(rows[0][2], '');
});

test('many sessions and stations: a row for each, no row dropped', () => {
  useLang('en');
  const list = [];
  for (let i = 1; i <= 40; i++) {
    const day = `2026-${String(1 + Math.floor((i - 1) / 28)).padStart(2, '0')}-${String(1 + (i - 1) % 28).padStart(2, '0')}`;
    list.push(net(`s${i}`, day, i, {}, Array.from({ length: 30 }, (_, k) => [`OE0A${String.fromCharCode(65 + (k % 26))}${k > 25 ? 'Z' : ''}`, '18:00', '18:30'])));
  }
  const rows = parse(seriesStatsCsv(seriesStatistics(list), 'S', t)).slice(1);
  assert.equal(rows.length, 40 * 30);
  assert.deepEqual([...new Set(rows.map(r => r[2]))], Array.from({ length: 40 }, (_, i) => String(i + 1)));
  assert.equal(new Set(rows.map(r => r[4])).size, 30);
});

test('file name base: the date and the series name as ASCII', () => {
  assert.equal(seriesStatsBase('Abendrunde Wien', '2026-10-31'), '2026-10-31_abendrunde-wien');
  assert.equal(seriesStatsBase('Übung ÖVSV!', '2026-10-31'), '2026-10-31_ubung-ovsv');
  assert.equal(seriesStatsBase('', '2026-10-31'), '2026-10-31_netlog');
});
