// The series statistics sheet (tools/netlog/js/statspdfmodel.js + statspdf.js): the content as a
// pure model (German and English, estimated / left-out / unknown marks as ASCII, the estimate
// note, the empty series), the PDF made from it (valid, pages, text present, nothing outside the
// page, long tables and wide matrices continue on further pages). Synthetic callsigns only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useLang, t } from '../tools/netlog/js/i18n.js';
import { seriesStatistics } from '../tools/netlog/js/stats.js';
import { callBase } from '../tools/netlog/js/model.js';
import { statsPdfModel, spmAscii, spmStamp } from '../tools/netlog/js/statspdfmodel.js';
import { statsPdf } from '../tools/netlog/js/statspdf.js';
import { PDF_MM, pdfTextWidth } from '../tools/shared/js/pdf.js';

const T = (d, hm, quality = 'exact') => ({ iso: `${d}T${hm}:00.000Z`, quality });
const NONE = { iso: null, quality: 'unknown' };
const GEN = '2026-10-31T12:34:56.000Z';

function net(sid, date, number, { start = '18:00', end = '19:00', late = false, ncs = null } = {}, stations = []) {
  const session = { id: sid, seriesId: 'ser', number, name: '', date, created: `${date}T00:00:00.000Z`, start: late ? NONE : T(date, start), end: late ? NONE : T(date, end), ncsId: ncs, deleted: null };
  const data = { session, participants: [], rounds: [{ id: `${sid}r1`, eventId: sid, number: 1, order: 1, topic: '', start: late ? NONE : T(date, start), deleted: null }], contributions: [], notes: [], events: [] };
  stations.forEach(([call, from, to, name = ''], i) => {
    const id = `${sid}p${i}`;
    data.participants.push({ id, eventId: sid, call, base: callBase(call), name, profileId: null, status: 'active', rosterOrder: i + 1, created: `${date}T00:00:${String(i % 60).padStart(2, '0')}.000Z`, presence: from ? [{ from: T(date, from), to: to ? T(date, to) : null }] : [], deleted: null });
    if (from) data.events.push({ id: `${id}e`, eventId: sid, type: 'presence', kind: 'checkin', participantId: id, time: T(date, from), deleted: null });
  });
  return data;
}

const small = () => [
  net('a', '2026-10-01', 1, { ncs: 'ap0' }, [['OE0TEST', '18:00', '19:00', 'Mira'], ['DL0XYZ', '18:10', '18:40', 'Jörg Öhm'], ['?', '18:20', '18:30']]),
  net('b', '2026-10-08', 2, { late: true }, [['OE0TEST', '18:05', null, 'Mira']]),
];

// ---------- reading the PDF back ----------

const latin1 = bytes => Buffer.from(bytes).toString('latin1');
const decode = hex => hex.match(/../g).map(h => parseInt(h, 16)).map(c => (c === 0x96 ? '–' : c === 0x85 ? '…' : String.fromCharCode(c))).join('');
// per page: [{ text, x, y, size, bold }] in mm from the top left
function pages(pdf, pageH = 297) {
  const streams = pdf.split('>>\nstream\n').slice(1).map(s => s.slice(0, s.indexOf('\nendstream')));
  return streams.map(st => [...st.matchAll(/\/(F[12]) ([\d.]+) Tf [\d. ]+ (?:rg|g) ([\d.-]+) ([\d.-]+) Td <([0-9a-f]+)> Tj/g)].map(m => ({
    text: decode(m[5]), size: Number(m[2]), bold: m[1] === 'F2', x: Number(m[3]) / PDF_MM, y: pageH - Number(m[4]) / PDF_MM,
  })));
}
const texts = pdf => pages(pdf).map(p => p.map(x => x.text));
const flat = pdf => texts(pdf).flat().join('\n');

test('model: German, the header, the summary, the estimate note and the marks as ASCII', () => {
  useLang('de');
  const m = statsPdfModel(seriesStatistics(small()), { seriesName: 'Abendrunde', generatedIso: GEN });
  assert.equal(m.title, 'Netlog · Statistik der Serie');
  assert.equal(m.seriesName, 'Abendrunde');
  assert.equal(m.generated, 'Erstellt 2026-10-31 12:34 UTC');
  assert.equal(m.sub, '2 Sitzungen gezählt', 'the stamp is not repeated in the sub line');
  assert.equal(m.estimate.title, 'Geschätzt:');
  assert.match(m.estimate.text, /Sprechzeit ist eine Schätzung und eine obere Grenze/);
  assert.doesNotMatch(m.estimate.text, /[≈≥✓]/);
  assert.match(m.estimate.text, /~ bedeutet geschätzt, >= mindestens/);
  assert.deepEqual(m.summary.items, [
    '2 Sitzungen gezählt', '2 verschiedene Stationen', '1 Sitzung ohne bekannte Zeiten',
    '1 Teilnehmer mit unvollständigem Rufzeichen nicht gezählt', '1 Sitzung ohne bekannten Beginn', '1 Sitzung ohne bekanntes Ende',
    '1 Anwesenheitsabschnitt ohne Zeit nicht gezählt',
  ]);
  // the regulars: OE0TEST first (2 sessions, the second one with an unknown time present)
  assert.equal(m.leaderboard.rows[0][0], '1');
  assert.deepEqual(m.leaderboard.rows[0][1], ['OE0TEST', 'Mira']);
  assert.equal(m.leaderboard.rows[0][2], '2/2 (100 %)');
  assert.equal(m.leaderboard.rows[0][3], '>= 01:00 (+1 ohne Zeit)');
  assert.match(m.leaderboard.rows[0][4], /^~ 00:00/);
  useLang('en');
});

test('model: matrix cells are text marks (+ present with the time, NCS, - absent), never colour alone', () => {
  useLang('en');
  const m = statsPdfModel(seriesStatistics(small()), { seriesName: 'S', generatedIso: GEN }).matrix;
  assert.deepEqual(m.sessions, [{ date: '2026-10-01', number: '#1' }, { date: '2026-10-08', number: '#2' }]);
  assert.deepEqual(m.rows[0].cells[0], { attended: true, lines: ['+ 01:00', 'NCS'] });
  assert.deepEqual(m.rows[0].cells[1], { attended: true, lines: ['+', '(+1 without time)'] });
  assert.deepEqual(m.rows[1].cells[1], { attended: false, lines: ['–'] });
  assert.match(m.legend, /\+ present/);
});

test('model: sessions and rotation rows, times with their zone, unknown as a dash', () => {
  useLang('en');
  const m = statsPdfModel(seriesStatistics(small()), { seriesName: 'S', generatedIso: GEN });
  assert.equal(m.sessions.zoneNote, 'times in UTC');
  assert.deepEqual(m.sessions.rows[0].slice(0, 3), ['2026-10-01', '#1', ['18:00–19:00 UTC', '01:00']]);
  assert.deepEqual(m.sessions.rows[0][3], ['Round 1: 01:00']);
  assert.deepEqual(m.sessions.rows[1].slice(0, 3), ['2026-10-08', '#2', ['–']]);
  assert.deepEqual(m.rotation.rows[0], ['2026-10-01', '#1', ['OE0TEST Mira 18:00-19:00 UTC · 01:00']]);
  assert.deepEqual(m.rotation.rows[1][2], ['-']);
});

test('model: a series without sessions has a text and no tables', () => {
  useLang('en');
  const m = statsPdfModel(seriesStatistics([]), { seriesName: 'Empty', generatedIso: GEN });
  assert.equal(m.empty, t('stats.empty'));
  assert.equal(m.leaderboard, null);
  assert.equal(m.matrix, null);
  assert.equal(m.sessions, null);
  const pdf = latin1(statsPdf(m));
  assert.ok(pdf.startsWith('%PDF-1.4\n') && pdf.endsWith('%%EOF\n'));
  assert.match(flat(pdf), /This series has no sessions yet/);
});

test('ASCII marks and the stamp', () => {
  assert.equal(spmAscii('≥ 01:00 (+1)  ≈ 02:00 ✓'), '>= 01:00 (+1) ~ 02:00 +');
  assert.equal(spmStamp('2026-10-31T23:59:59.999Z'), '2026-10-31 23:59 UTC');
});

test('PDF: valid structure, header, texts in the sheet, the estimate note and the page numbers', () => {
  useLang('de');
  const bytes = statsPdf(statsPdfModel(seriesStatistics(small()), { seriesName: 'Abendrunde', generatedIso: GEN }));
  const pdf = latin1(bytes);
  assert.ok(pdf.startsWith('%PDF-1.4\n') && pdf.endsWith('%%EOF\n'));
  assert.match(pdf, /\/MediaBox \[0 0 595\.28 841\.89\]/);
  const xref = Number(pdf.match(/startxref\n(\d+)/)[1]);
  assert.equal(pdf.slice(xref, xref + 4), 'xref');
  assert.equal(pages(pdf).length, Number(pdf.match(/\/Count (\d+)/)[1]));
  const all = flat(pdf);
  for (const s of ['Netlog · Statistik der Serie', 'Abendrunde', 'Geschätzt:', 'Stammgäste', 'Anwesenheit je Sitzung', 'Wechsel der Rundenleitung',
    'OE0TEST', 'DL0XYZ', 'Jörg Öhm', '2026-10-08', `Seite 1 von ${pages(pdf).length}`, 'NCS', 'Zeiten in UTC']) assert.ok(all.includes(s), s);
  assert.doesNotMatch(all, /[≈≥✓?]\s/, 'no marks that the font lacks');
  // exactly one date stamp per page: ISO date, 24 h time, UTC; not the roster flow's "gedruckt"
  const stamps = pages(pdf).map(p => p.filter(x => /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(x.text) && x.size === 8.5).map(x => x.text));
  stamps.forEach(s => assert.deepEqual(s, ['Erstellt 2026-10-31 12:34 UTC']));
  assert.doesNotMatch(all, /gedruckt/);
  assert.equal(all.match(/Erstellt/g).length, pages(pdf).length);
  assert.match(all, /Sprechzeit ist eine Schätzung/);
  useLang('en');
});

function bigSeries(sessions, stations) {
  const list = [];
  for (let i = 1; i <= sessions; i++) {
    const day = `2026-${String(1 + Math.floor((i - 1) / 28)).padStart(2, '0')}-${String(1 + (i - 1) % 28).padStart(2, '0')}`;
    list.push(net(`s${i}`, day, i, { ncs: 'sp0' }, Array.from({ length: stations }, (_, k) => [`OE${k % 9}Q${String.fromCharCode(65 + (k % 26))}${String.fromCharCode(65 + Math.floor(k / 26))}`, '18:00', `18:${10 + (k % 40)}`, k % 7 === 0 ? 'A very long name that has to wrap inside its cell and may never be cut off' : `Name ${k}`])));
  }
  return list;
}

test('PDF: many stations and sessions flow onto further pages, nothing leaves the page', () => {
  useLang('en');
  const stats = seriesStatistics(bigSeries(14, 70));
  const model = statsPdfModel(stats, { seriesName: 'Big net', generatedIso: GEN });
  const pdf = latin1(statsPdf(model));
  const n = Number(pdf.match(/\/Count (\d+)/)[1]);
  assert.ok(n >= 8, `pages: ${n}`);
  const ps = pages(pdf);
  assert.equal(ps.length, n);
  ps.forEach((page, i) => {
    assert.ok(page.some(x => x.text === `Page ${i + 1} of ${n}`), `page ${i + 1} is numbered`);
    for (const x of page) {
      const w = pdfTextWidth(x.text, x.size, x.bold);
      assert.ok(x.x >= 14.9 && x.x + w <= 195.6 || /^Page \d+ of \d+$/.test(x.text) || x.text.startsWith('Printed') || x.x + w <= 195.6, `${x.text} within the margins on page ${i + 1}`);
      assert.ok(x.y > 5 && x.y < 292, `${x.text} within the page`);
    }
  });
  // the table heads repeat with "(continued)"
  const all = flat(pdf);
  assert.ok((all.match(/\(continued\)/g) || []).length >= 3);
  // 14 sessions need two matrix blocks (6 sessions per block)
  assert.match(all, /Sessions 1 to 6 of 14/);
  assert.match(all, /Sessions 13 to 14 of 14/);
  // every station is in the leaderboard and in the matrix; the long name is complete (wrapped)
  assert.equal(stats.leaderboard.length, 70);
  assert.ok(all.includes('OE0QAA'));
  assert.ok(all.includes('OE6QRC'));
  assert.ok(all.includes('very long name that has'));
  assert.ok(all.includes('cut off'));
  // the long series name wraps instead of leaving the cell
  const long = latin1(statsPdf(statsPdfModel(stats, { seriesName: 'Series with a name that is much too long for one line of the sheet, and it goes on and on and on', generatedIso: GEN })));
  assert.ok(flat(long).replace(/\n/g, ' ').includes('and it goes on and on and on'));
});
