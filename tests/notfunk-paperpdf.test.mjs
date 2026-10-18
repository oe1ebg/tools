// The Notfunk PDFs: the Vordruck (tools/notfunk/js/paperpdf.js: one portrait
// A4 page with the form's captions and options, nothing outside the page,
// nothing filled in but the Einsatz's name), the filled form and the book
// (bookpdf.js).
process.env.TZ = 'America/New_York'; // Austrian time must not depend on the device's zone
import test from 'node:test';
import assert from 'node:assert/strict';
import { blankFormPdf, formPdf, NFP_PAGE } from '../tools/notfunk/js/paperpdf.js';
import { bookPdf } from '../tools/notfunk/js/bookpdf.js';
import { blankFormSheet } from '../tools/notfunk/js/print.js';
import { emptyForm, formToFields } from '../tools/notfunk/js/form.js';
import { newMessage, setStatus } from '../tools/notfunk/js/model.js';
import { formatNumber } from '../tools/notfunk/js/numbering.js';
import { PDF_MM } from '../tools/shared/js/pdf.js';

const latin1 = bytes => String.fromCharCode(...bytes);
const NOW = '2026-10-18T09:30:00Z';
const OP = { name: 'Übung Blackout Wien' };

const decode = hex => hex.match(/../g).map(h => parseInt(h, 16))
  .map(c => ({ 0x96: '–', 0x85: '…' }[c] || String.fromCharCode(c))).join('');
const texts = pdf => [...pdf.matchAll(/<([0-9a-f]+)> Tj/g)].map(m => decode(m[1]));

test('blankFormPdf: one A4 portrait page, a valid file', () => {
  const pdf = latin1(blankFormPdf(OP, { now: NOW }));
  assert.ok(pdf.startsWith('%PDF-1.4\n'));
  assert.ok(pdf.endsWith('%%EOF\n'));
  assert.match(pdf, /\/Type \/Pages \/Kids \[3 0 R\] \/Count 1/);
  assert.match(pdf, /\/MediaBox \[0 0 595\.28 841\.89\]/);
  assert.deepEqual(NFP_PAGE, { width: 210, height: 297 });
  const xref = Number(pdf.match(/startxref\n(\d+)/)[1]);
  assert.equal(pdf.slice(xref, xref + 4), 'xref');
  const offsets = [...pdf.slice(xref).matchAll(/^(\d{10}) 00000 n $/gm)].map(m => Number(m[1]));
  offsets.forEach((o, i) => assert.equal(pdf.slice(o, o + `${i + 1} 0 obj`.length), `${i + 1} 0 obj`));
  assert.ok(/^[\x0a\x20-\x7e]*$/.test(pdf), 'all ASCII');
});

test('blankFormPdf: captions, options and the footer of the blank sheet are on the page', () => {
  const t = texts(latin1(blankFormPdf(OP, { now: NOW })));
  const s = blankFormSheet(OP, { now: NOW });
  const want = ['Meldeaufnahmeformular', 'ÖVSV NOTFUNK · ÜBUNG BLACKOUT WIEN', 'NOTFUNK-NR.',
    'NUR VON DER MELDESAMMELSTELLE AUSZUFÜLLEN', 'REFERENZ / GESCHÄFTSBUCH-NR.', 'FEDERFÜHREND', 'MITWIRKEND', 'ZUR KENNTNIS',
    s.timeLabel.toUpperCase(), 'ÜBERMITTLUNG', 'DRINGLICHKEIT', 'MELDUNGSART', 'VON (ABSENDER)', 'AN (ADRESSAT)',
    'BETREFF', 'ORT', 'BEZUG', 'INHALT – WÖRTLICH, WIE ÜBERMITTELT', s.readBackLabel,
    'AUFGENOMMEN VON (NAME / UNTERSCHRIFT)', 'ANMERKUNGEN / WEITERE VERANLASSUNG',
    `Notfunk-Meldebuch · Vordruck, gedruckt ${s.printed}`,
    ...s.directions.map(d => d.label.toUpperCase()),
    ...[...s.channels, ...s.priorities, ...s.types].map(o => o.label),
    ...s.handoverHeads.map(h => h.toUpperCase())];
  for (const w of want) assert.ok(t.includes(w), w);
  assert.deepEqual(s.priorities.map(p => p.label), ['Routine', 'Dringend', 'Notfall']);
  // each option a box of its own (no circles on the empty form): the three
  // choice rows with dotted lines between their 6 + 3 + 5 boxes
  const blank = latin1(blankFormPdf(OP, { now: NOW }));
  assert.equal((blank.match(/ c (?:B|S)$/gm) || []).length, 0);
  assert.equal((blank.match(/\[0\.8 1\.6\] 0 d/g) || []).length, 5 + 2 + 4);
});

test('blankFormPdf: nothing filled in but the Einsatz name; without one, no name', () => {
  const t = texts(latin1(blankFormPdf(null, { now: NOW })));
  assert.ok(t.includes('ÖVSV NOTFUNK'));
  assert.ok(!t.some(x => x.includes('BLACKOUT')));
  assert.ok(!t.some(x => x.includes('Stab herhören')));
});

test('blankFormPdf: every drawing stays on the page, inside its margins', () => {
  const pdf = latin1(blankFormPdf(OP, { now: NOW }));
  const W = 210 * PDF_MM, H = 297 * PDF_MM;
  const content = pdf.match(/stream\n([\s\S]*)\nendstream/)[1];
  const nums = content.replace(/<[0-9a-f]+>/g, '').match(/(?:-?\d+(?:\.\d+)? ){4}re\b|-?\d+(?:\.\d+)? -?\d+(?:\.\d+)? (?:m|l|Td)\b|(?:-?\d+(?:\.\d+)? ){6}c/g) || [];
  assert.ok(nums.length > 100);
  const margin = 9 * PDF_MM;
  for (const op of nums) {
    const v = op.split(' ').filter(x => /^-?[\d.]+$/.test(x)).map(Number);
    if (/ re$/.test(op)) { // x y w h: the rectangle's lower left and its size
      assert.ok(v[0] >= margin - 0.01 && v[0] + v[2] <= W - margin + 0.01 && v[1] >= 0 && v[1] + v[3] <= H, op);
    } else {
      for (let i = 0; i < v.length; i += 2) {
        assert.ok(v[i] >= margin - 0.01 && v[i] <= W - margin + 0.01, `x ${op}`);
        assert.ok(v[i + 1] >= 0 && v[i + 1] <= H, `y ${op}`);
      }
    }
  }
});

test('blankFormPdf: the text area has at least 7 ruled lines, 10 mm apart or more', () => {
  const pdf = latin1(blankFormPdf(OP, { now: NOW }));
  // full-width writing lines: 0.5 pt, from x 12.5 mm to 197.5 mm
  const x = n => (n * PDF_MM).toFixed(2).replace(/\.?0+$/, '');
  const ys = [...pdf.matchAll(new RegExp(`^0\\.5 w 0 G \\[\\] 0 d ${x(12.5)} ([\\d.]+) m ${x(197.5)} \\1 l S$`, 'gm'))].map(m => Number(m[1]));
  assert.ok(ys.length >= 7, `${ys.length} lines`);
  for (let i = 1; i < ys.length; i++) assert.ok((ys[i - 1] - ys[i]) / PDF_MM >= 10 - 0.01);
});

// ---- the filled form and the book

const NOWL = '2026-10-07T12:53:00.000Z'; // 14:53 MESZ
const OPL = { id: 'op1', name: 'Übung Blackout Wien', prefix: 'W1', call: 'OE1XKS', station: 'Einsatzleitstelle', home: 'Stab', freq: '145.500', via: '' };
const pages = pdf => (pdf.match(/\/Type \/Page \/Parent/g) || []).length;
const streams = pdf => [...pdf.matchAll(/stream\n([\s\S]*?)\nendstream/g)].map(m => m[1]);
const pageTexts = pdf => streams(pdf).map(c => texts(`${c}`));
const WM = 210 * PDF_MM, HM = 297 * PDF_MM;

function msg(seq, extra = {}, form = {}) {
  const { fields, errors } = formToFields({
    ...emptyForm(OPL), from: 'Lichtinsel 12 Floridsdorf', subject: 'Aggregat ausgefallen', peer: 'oe1abc', distribution: 'S3',
    text: 'Aggregat seit 14:45 aus.\n40 Personen vor Ort.', priority: 'emergency', type: 'anforderung', readBack: true, ...form,
  }, { now: NOWL });
  assert.deepEqual(errors, []);
  const m = newMessage(fields, { prefix: 'W1', seq, number: formatNumber('W1', seq) }, { id: `m${seq}`, opId: 'op1', operator: 'oe1ebg', now: NOWL });
  return { ...m, ...extra };
}

test('formPdf: values in the cells, the chosen options marked, one page', () => {
  let m = msg(7, { staffRef: 'GZ 0412', remarks: 'Rückruf vereinbart' });
  m = setStatus(m, 'forwarded', { operator: 'oe1ebg', now: NOWL, to: 'Meldesammelstelle', at: '2026-10-07T13:00:00.000Z' });
  m = setStatus(m, 'acknowledged', { operator: 'oe1ebg', now: NOWL, who: 'S6 Huber', at: '2026-10-07T13:05:00.000Z' });
  const pdf = latin1(formPdf(m, OPL, { now: NOWL, revisions: 1 }));
  assert.equal(pages(pdf), 1);
  assert.match(pdf, /\/Count 1/);
  const t = texts(pdf);
  for (const w of ['W1-007', 'GZ 0412', '2026-10-07', '14:53', 'Lichtinsel 12 Floridsdorf', 'Stab', 'OE1ABC', 'S3', 'Aggregat ausgefallen',
    'Aggregat seit 14:45 aus.', '40 Personen vor Ort.', 'OE1EBG', 'Rückruf vereinbart', 'Meldesammelstelle', '15:00', 'S6 Huber', '15:05',
    'Funk', 'Notfall', 'Anforderung', 'EINGANG', 'AUSGANG', 'Rücklesen erfolgt und vom Absender als richtig bestätigt']) {
    assert.ok(t.includes(w), w);
  }
  assert.ok(t.some(x => x.startsWith('Notfunk-Meldebuch · Status übernommen · gedruckt 2026-10-07 14:53')));
  assert.ok(t.includes('Fassung 2') || t.some(x => x.includes('Fassung 2')));
  // the chosen option of each of the three choices is a filled circle (B), the other 11 are open (S)
  assert.equal((pdf.match(/ c B$/gm) || []).length, 3);
  assert.equal((pdf.match(/ c S$/gm) || []).length, 11);
  // the filled form is the blank one plus values: same captions
  const blank = texts(latin1(blankFormPdf(OPL, { now: NOWL })));
  for (const w of ['NOTFUNK-NR.', 'NUR VON DER MELDESAMMELSTELLE AUSZUFÜLLEN', 'BETREFF', 'ORT', 'BEZUG', 'MELDUNGSART']) assert.ok(blank.includes(w) && t.includes(w), w);
});

test('formPdf: outgoing message, ticks and the other channel', () => {
  let m = msg(8, {}, { direction: 'out', from: 'Stab', to: 'LI 3', channel: 'fax', readBack: false });
  m = setStatus(m, 'forwarded', { operator: 'x', now: NOWL, to: 'Funk', at: '2026-10-07T13:00:00.000Z' });
  const pdf = latin1(formPdf(m, OPL, { now: NOWL }));
  const t = texts(pdf);
  assert.ok(t.includes('anders: Fax'));
  assert.ok(t.includes('ÜBERTRAGEN AN') && t.includes('FEHLVERSUCHE / RÜCKFRAGE'));
  // the chosen direction is ticked with a cross (2 lines): Ausgang here
  assert.equal((pdf.match(/^1\.3 w /gm) || []).length, 2);
});

test('formPdf: a long text continues on further pages; nothing is lost or off the page', () => {
  const line = i => `Zeile ${i}: Die Station meldet den Stand der Dinge am Einsatzort mit mehreren Anmerkungen zur Lage und zur Stromversorgung.`;
  const text = Array.from({ length: 70 }, (_, i) => line(i + 1)).join('\n');
  const m = msg(9, { remarks: 'x' }, { text });
  const pdf = latin1(formPdf(m, OPL, { now: NOWL }));
  const n = pages(pdf);
  assert.ok(n >= 3, `${n} pages`);
  assert.match(pdf, new RegExp(`/Count ${n}`));
  const per = pageTexts(pdf);
  assert.ok(per[0].includes('Fortsetzung auf Seite 2'));
  assert.ok(per[0].some(x => x.includes('Seite 1 von ' + n)));
  for (let i = 1; i < n; i++) {
    assert.ok(per[i].includes('W1-009'), `number on page ${i + 1}`);
    assert.ok(per[i].includes('Betreff: Aggregat ausgefallen'));
    assert.ok(per[i].includes(`Fortsetzung, Seite ${i + 1} von ${n}`));
    assert.ok(per[i].some(x => x.includes(`Seite ${i + 1} von ${n}`)));
  }
  assert.ok(!per[n - 1].includes('Fortsetzung auf Seite 2'));
  // all words of the text are on the pages, in order
  const joined = per.flat().join(' ');
  for (let i = 1; i <= 70; i++) assert.ok(joined.includes(`Zeile ${i}:`), `line ${i}`);
  const at = i => joined.indexOf(`Zeile ${i}:`);
  for (let i = 1; i < 70; i++) assert.ok(at(i) < at(i + 1));
  // everything stays on the page, inside the margins
  for (const c of streams(pdf)) {
    for (const op of c.replace(/<[0-9a-f]+>/g, '').match(/-?\d+(?:\.\d+)? -?\d+(?:\.\d+)? (?:m|l|Td)\b/g) || []) {
      const [x, y] = op.split(' ').map(Number);
      assert.ok(x >= 9 * PDF_MM - 0.01 && x <= WM - 9 * PDF_MM + 0.01 && y >= 0 && y <= HM, op);
    }
  }
});

test('formPdf: single-line values are shortened with "…" and given in full on the last page', () => {
  const subject = 'Ein sehr langer Betreff, der garantiert nicht in die Zelle passt, weil er einfach immer weiter und weiter und weiter geht';
  const m = msg(10, {}, { subject });
  const pdf = latin1(formPdf(m, OPL, { now: NOWL }));
  assert.equal(pages(pdf), 2);
  const [p1, p2] = pageTexts(pdf);
  assert.ok(p1.some(x => x.startsWith('Ein sehr langer Betreff') && x.endsWith('…')));
  assert.ok(!p1.includes(subject));
  assert.ok(p1.includes('Gekürzte Angaben: vollständig auf Seite 2'));
  assert.ok(p2.some(x => subject.startsWith(x.replace(/\.\.\.$/, '')) || x.includes('Ein sehr langer')));
  assert.ok(p2.join(' ').includes('weiter und weiter und weiter geht'));
  // a short message makes no second page
  assert.equal(pages(latin1(formPdf(msg(11), OPL, { now: NOWL }))), 1);
});

test('bookPdf: header and column heads on every page, Seite x von y, the full text', () => {
  const rows = [];
  for (let i = 1; i <= 40; i++) rows.push(msg(i, {}, { text: `Meldung ${i}: ${'Text der Meldung. '.repeat(12)}Ende ${i}.` }));
  const reply = { ...msg(41), replyTo: rows[0].id, direction: 'out', from: 'Stab', to: 'LI 3' };
  const pdf = latin1(bookPdf([...rows, reply], OPL, { now: NOWL }));
  const n = pages(pdf);
  assert.ok(n >= 5, `${n} pages`);
  assert.match(pdf, /\/MediaBox \[0 0 841\.89 595\.28\]/);
  const per = pageTexts(pdf);
  per.forEach((t, i) => {
    assert.ok(t.includes('Notfunk-Meldebuch'), 'title');
    assert.ok(t.includes('Übung Blackout Wien'), 'Einsatz');
    // every field of the Einsatz header, labelled
    for (const v of ['Stationskürzel ', 'W1', 'OE1XKS', 'Einsatzleitstelle']) assert.ok(t.includes(v), v);
    assert.ok(t.some(x => x.startsWith('Zeitraum: ') && x.endsWith(' (gesamter Einsatz)')), 'Zeitraum');
    assert.ok(t.some(x => x.startsWith('gedruckt 2026-10-07 14:53')));
    for (const h of ['NR. · ZEIT', 'GEGENSTELLE', 'BETREFF · INHALT', 'STATUS']) assert.ok(t.includes(h), h);
    assert.ok(t.includes(`Seite ${i + 1} von ${n}`));
  });
  // every message with its complete text (the wrapped lines in order)
  const all = per.flat().join(' ');
  for (let i = 1; i <= 41; i++) assert.ok(all.includes(`W1-${String(i).padStart(3, '0')}`), `number ${i}`);
  for (let i = 1; i <= 40; i++) assert.ok(all.includes(`Meldung ${i}:`) && all.includes(`Ende ${i}.`), `text ${i}`);
  assert.ok(all.includes('Bezug W1-001'));
  assert.ok(all.includes('Ausgang an') && all.includes('Eingang von'));
  // the time range of the print
  const part = latin1(bookPdf(rows, OPL, { now: NOWL, fromIso: '2026-10-07T11:30:00.000Z' }));
  assert.ok(pageTexts(part)[0].some(x => x.startsWith('Zeitraum: 2026-10-07 13:30 bis 2026-')));
});

test('bookPdf: a row longer than a page is split, nothing truncated; empty range says so', () => {
  const words = Array.from({ length: 900 }, (_, i) => `wort${i}`).join(' ');
  const rows = [msg(1), msg(2, {}, { text: words }), msg(3)];
  const pdf = latin1(bookPdf(rows, OPL, { now: NOWL }));
  const per = pageTexts(pdf);
  assert.ok(per.length >= 3);
  const all = per.flat().join(' ');
  for (let i = 0; i < 900; i++) assert.ok(all.includes(`wort${i}`), `wort${i}`);
  assert.ok(per.slice(1).some(t => t.includes('Fortsetzung') && t.includes('W1-002')), 'the number is repeated on the continuation');
  const empty = pageTexts(latin1(bookPdf([], OPL, { now: NOWL })));
  assert.equal(empty.length, 1);
  assert.ok(empty[0].includes('Keine Meldungen in diesem Zeitraum.'));
  assert.ok(empty[0].includes('Seite 1 von 1'));
  // nothing outside the page or its margins
  for (const c of streams(pdf)) {
    for (const op of c.replace(/<[0-9a-f]+>/g, '').match(/-?\d+(?:\.\d+)? -?\d+(?:\.\d+)? (?:m|l|Td)\b/g) || []) {
      const [x, y] = op.split(' ').map(Number);
      assert.ok(x >= 9 * PDF_MM && x <= (297 - 9) * PDF_MM && y >= 0 && y <= 210 * PDF_MM, op);
    }
  }
});
