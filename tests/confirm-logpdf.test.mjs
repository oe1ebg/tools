// The log as PDF ("Drucken", tools/confirm/js/logpdf.js): header on every
// page, rows oldest first, deleted lines left out, full wrapped notes,
// comment rows, "Seite x von y", every template, nothing outside the page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { logPdf } from '../tools/confirm/js/logpdf.js';
import { TEMPLATES } from '../tools/confirm/js/templates.js';
import { PDF_MM } from '../tools/shared/js/pdf.js';

const latin1 = bytes => String.fromCharCode(...bytes);
const decode = hex => hex.match(/../g).map(h => parseInt(h, 16)).map(c => (c === 0x96 ? '–' : c === 0x85 ? '…' : String.fromCharCode(c))).join('');
// per page: the texts drawn (in order)
function pages(pdf) {
  const streams = pdf.split('>>\nstream\n').slice(1).map(s => s.slice(0, s.indexOf('\nendstream')));
  return streams.map(st => [...st.matchAll(/<([0-9a-f]+)> Tj/g)].map(m => decode(m[1]).trim()));
}
const header = { operator: 'OE1ABC', station: 'OE1XYZ', myQth: 'Wien', myGrid: 'JN88ee', mode: 'FM', viaRepeater: false, freq: '145.500', repeaterCall: '', repeaterFreq: '', repeaterShift: '', repeaterTone: '' };
const snap = (over = {}) => ({ operator: 'OE1ABC', station: 'OE1XYZ', freq: '145.500', mode: 'FM', repeaterCall: '', repeaterFreq: '', repeaterShift: '', ...over });
const event = (template = 'calls', hdr = header) => ({ id: 'ev', title: 'Rundspruch Test', template, header: hdr, created: '2026-07-04T08:00:00.000Z' });
const checkin = (seq, call, ts, over = {}) => ({ id: `e${seq}`, eventId: 'ev', seq, ts, call, fields: { name: 'Karl', qth: 'Graz', rst_rcvd: '59', rst_sent: '57' }, note: '', viaRepeater: false, snap: snap(), created: ts, updated: ts, deleted: null, ...over });
const comment = (id, ts, text, over = {}) => ({ id, eventId: 'ev', kind: 'comment', ts, text, category: 'Technik', auto: null, snap: snap(), created: ts, updated: ts, deleted: null, ...over });
const opts = { mode: 'utc', now: '2026-10-18T10:00:00.000Z' };

test('structure: A4 landscape, valid xref, ASCII, nothing drawn outside the page', () => {
  const entries = [checkin(1, 'OE3AAA', '2026-07-04T08:01:00.000Z'), comment('c1', '2026-07-04T08:02:00.000Z', 'Pause')];
  const pdf = latin1(logPdf(event(), entries, opts));
  assert.ok(pdf.startsWith('%PDF-1.4\n') && pdf.endsWith('%%EOF\n'));
  assert.match(pdf, /\/MediaBox \[0 0 841\.89 595\.28\]/);
  const xref = Number(pdf.match(/startxref\n(\d+)/)[1]);
  assert.equal(pdf.slice(xref, xref + 4), 'xref');
  assert.ok(/^[\x0a\x20-\x7e]*$/.test(pdf));
  const W = 297 * PDF_MM, H = 210 * PDF_MM;
  for (const m of pdf.matchAll(/(-?[\d.]+) (-?[\d.]+) (?:Td|m|l)\b/g)) {
    assert.ok(+m[1] >= 0 && +m[1] <= W + 0.01 && +m[2] >= 0 && +m[2] <= H + 0.01, m[0]);
  }
  for (const m of pdf.matchAll(/(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) re/g)) {
    assert.ok(+m[1] >= 0 && +m[2] >= 0 && +m[1] + +m[3] <= W + 0.05 && +m[2] + +m[4] <= H + 0.05, m[0]);
  }
});

test('header on every page with all Betrieb fields, range, zone, template; "Seite x von y"', () => {
  const entries = Array.from({ length: 60 }, (_, i) => checkin(i + 1, `OE3A${String.fromCharCode(65 + (i % 26))}${i}`, `2026-07-04T08:${String(i % 60).padStart(2, '0')}:00.000Z`, { note: 'Kurze Notiz' }));
  const ps = pages(latin1(logPdf(event('calls', { ...header, viaRepeater: true, repeaterCall: 'OE1XUU', repeaterFreq: '438.950', repeaterShift: '-7.6', repeaterTone: '162.2' }), entries, opts)));
  assert.ok(ps.length >= 3);
  ps.forEach((t, i) => {
    for (const w of ['Bestätigungsverkehr', 'Rundspruch Test', 'Operator', 'OE1ABC', 'Station', 'OE1XYZ', 'QTH', 'Wien', 'Locator', 'JN88ee', 'Betriebsart', 'FM', 'Relais', 'OE1XUU', '438.950 MHz', 'Ablage', 'Signalisierung', 'CTCSS 162.2', 'Zeiten in UTC', 'ZEIT (UTC)', 'RUFZEICHEN', 'NOTIZ']) {
      assert.ok(t.includes(w), `page ${i + 1} lacks ${w}`);
    }
    assert.ok(t.some(x => x.startsWith('Zeitraum: 2026-07-04 08:00:00 bis 2026-07-04 08:59:00')));
    assert.ok(t.some(x => x.startsWith('Vorlage: ')));
    assert.ok(t.includes(`Seite ${i + 1} von ${ps.length}`));
  });
});

test('direct operation: Frequenz instead of the repeater fields', () => {
  const t = pages(latin1(logPdf(event(), [], opts)))[0];
  assert.ok(t.includes('direkt') && t.includes('145.500 MHz') && t.includes('Frequenz'));
  assert.ok(t.includes('Keine Zeilen in diesem Log.'));
});

test('rows oldest first, deleted lines left out, a check-in number shows', () => {
  const entries = [
    checkin(3, 'OE3CCC', '2026-07-04T08:03:00.000Z'),
    checkin(1, 'OE3AAA', '2026-07-04T08:01:00.000Z'),
    checkin(2, 'OE3BBB', '2026-07-04T08:02:00.000Z', { deleted: '2026-07-04T09:00:00.000Z' }),
    checkin(4, 'OE3AAA', '2026-07-04T08:04:00.000Z'),
  ];
  const t = pages(latin1(logPdf(event(), entries, opts))).flat();
  assert.ok(!t.includes('OE3BBB'));
  const calls = t.filter(x => /^OE3[A-C]{3}$/.test(x));
  assert.deepEqual(calls, ['OE3AAA', 'OE3CCC', 'OE3AAA']);
  assert.ok(t.includes('2. Check-in'));
  assert.ok(t.includes('Zeitraum: 2026-07-04 08:01:00 bis 2026-07-04 08:04:00'));
  assert.ok(t.includes('08:01:00Z'));
});

test('a long note is wrapped and complete, and a long row continues on the next page', () => {
  const words = Array.from({ length: 3000 }, (_, i) => `wort${i}`);
  const note = words.join(' ');
  const entries = [checkin(1, 'OE3AAA', '2026-07-04T08:01:00.000Z', { note }), checkin(2, 'OE3BBB', '2026-07-04T08:02:00.000Z')];
  const ps = pages(latin1(logPdf(event(), entries, opts)));
  assert.ok(ps.length >= 2);
  const drawn = ps.flat().filter(x => /^(wort\d+ ?)+$/.test(x)).join(' ').split(' ');
  assert.deepEqual(drawn, words);
  assert.ok(ps[1].includes('1'), 'the continuation repeats the number');
  assert.ok(ps.flat().includes('OE3BBB'));
});

test('a comment is a full-width row: time, category, text, operator if different', () => {
  const entries = [checkin(1, 'OE3AAA', '2026-07-04T08:01:00.000Z'),
    comment('c1', '2026-07-04T08:02:00.000Z', 'Operatorwechsel auf OE1QQQ', { category: 'Operatorwechsel', snap: snap({ operator: 'OE1QQQ' }) }),
    comment('c2', '2026-07-04T08:03:00.000Z', 'Betrieb geändert', { auto: 'header' })];
  const t = pages(latin1(logPdf(event(), entries, opts))).flat();
  for (const w of ['08:02:00Z', 'OPERATORWECHSEL', 'Operatorwechsel auf OE1QQQ', 'Op OE1QQQ/OE1XYZ', 'TECHNIK (AUTO)', 'Betrieb geändert']) assert.ok(t.includes(w), w);
});

test('a Relais that differs from the Betrieb is framed and said in words', () => {
  const e = checkin(1, 'OE3AAA', '2026-07-04T08:01:00.000Z', { viaRepeater: true, snap: snap({ repeaterCall: 'OE3XYZ', repeaterFreq: '145.700' }) });
  const same = checkin(2, 'OE3BBB', '2026-07-04T08:02:00.000Z');
  const pdf = latin1(logPdf(event(), [e, same], opts));
  const t = pages(pdf).flat();
  assert.ok(t.includes('OE3XYZ') && t.includes('abweichend') && t.includes('145.700 MHz'));
  assert.equal(t.filter(x => x === 'abweichend').length, 1);
  assert.match(pdf, /\[1 0\.8\] 0 d/); // the dashed frame
});

test('local time mode states the zone', () => {
  const t = pages(latin1(logPdf(event(), [checkin(1, 'OE3AAA', '2026-07-04T08:01:00.000Z')], { ...opts, mode: 'local' }))).flat();
  assert.ok(t.some(x => /^Zeiten in Ortszeit \(/.test(x)));
  assert.ok(t.some(x => /^ZEIT \(.+\)$/.test(x)));
});

for (const tpl of TEMPLATES) {
  test(`template ${tpl.key}: a valid PDF with its column heads`, () => {
    const fields = Object.fromEntries(tpl.fields.map(f => [f.key, f.example || '1']));
    const entries = [checkin(1, 'OE3AAA', '2026-07-04T08:01:00.000Z', { fields, note: 'Notiz' })];
    const pdf = latin1(logPdf(event(tpl.key), entries, opts));
    assert.match(pdf, /\/Count 1\b/);
    const t = pages(pdf)[0];
    for (const w of ['NR', 'ZEIT (UTC)', 'RUFZEICHEN', 'RELAIS', 'NOTIZ']) assert.ok(t.includes(w), w);
    if (tpl.key === 'zivilschutz') {
      for (const w of ['STANDORT', 'SIRENE', 'AT-ALERT', 'zu', 'offen', 'außen']) assert.ok(t.includes(w.toLowerCase() === w ? w : w), w);
    }
    if (tpl.key === 'rst') assert.ok(t.some(x => x.startsWith('RST ')));
  });
}
