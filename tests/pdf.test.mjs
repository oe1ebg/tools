// The shared PDF writer (tools/shared/js/pdf.js): WinAnsi text, widths,
// page sizes, a structurally valid file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PDF_A4_LANDSCAPE, PDF_A4_PORTRAIT, PDF_MM, pdfCanvas, pdfDocument, pdfHex, pdfNum, pdfTextWidth, pdfWrap } from '../tools/shared/js/pdf.js';

const latin1 = bytes => String.fromCharCode(...bytes);

test('pdfHex: German text in WinAnsi', () => {
  assert.equal(pdfHex('äöüßÄÖÜ'), 'e4f6fcdfc4d6dc');
  assert.equal(pdfHex('–'), '96');
  assert.equal(pdfHex('„“'), '8493');
  assert.equal(pdfHex('…€'), '8580');
  assert.equal(pdfHex('A b'), '412062');
  assert.equal(pdfHex('日'), '3f'); // outside WinAnsi: "?"
});

test('pdfTextWidth: Helvetica widths, bold wider, scales with the size', () => {
  const w = pdfTextWidth('Hello', 10); // H722 e556 l222 l222 o556 = 2278
  assert.ok(Math.abs(w - 2.278 * 10 / PDF_MM) < 1e-9);
  assert.ok(pdfTextWidth('Hello', 10, true) > w);
  assert.ok(Math.abs(pdfTextWidth('Hello', 20) - 2 * w) < 1e-9);
  assert.equal(pdfTextWidth('', 10), 0);
  // umlauts count as their base letter, ß as B
  assert.equal(pdfTextWidth('ä', 9), pdfTextWidth('a', 9));
  assert.equal(pdfTextWidth('ß', 9), pdfTextWidth('B', 9));
});

test('pdfNum: at most two decimals', () => {
  assert.equal(pdfNum(1.23456), '1.23');
  assert.equal(pdfNum(2), '2');
});

function build(page) {
  const cv = pdfCanvas(page);
  cv.line(10, 10, 100, 10);
  cv.fill(10, 20, 30, 5, 0.9);
  cv.text('Größe – „Test“', 10, 40, { bold: true });
  return pdfDocument(page, cv.ops.join('\n'), 'Titel – Ä');
}

for (const [name, page, w, h] of [['landscape', PDF_A4_LANDSCAPE, 297, 210], ['portrait', PDF_A4_PORTRAIT, 210, 297]]) {
  test(`pdfDocument: A4 ${name}, MediaBox and xref`, () => {
    const pdf = latin1(build(page));
    assert.ok(pdf.startsWith('%PDF-1.4\n'));
    assert.ok(pdf.endsWith('%%EOF\n'));
    const box = pdf.match(/\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/);
    assert.equal(box[1], pdfNum(w * PDF_MM));
    assert.equal(box[2], pdfNum(h * PDF_MM));
    // the y axis is flipped against the page height
    assert.equal(pdf.match(/0 G \[\] 0 d [\d.]+ ([\d.]+) m/)[1], pdfNum((page.height - 10) * PDF_MM));
    const start = Number(pdf.match(/startxref\n(\d+)\n/)[1]);
    assert.ok(pdf.slice(start).startsWith('xref\n'));
    const entries = [...pdf.slice(start).matchAll(/(\d{10}) 00000 n /g)].map(m => Number(m[1]));
    assert.equal(entries.length, 7);
    entries.forEach((at, i) => assert.ok(pdf.slice(at).startsWith(`${i + 1} 0 obj\n`)));
    const len = Number(pdf.match(/\/Length (\d+)/)[1]);
    const body = pdf.match(/stream\n([\s\S]*)\nendstream/)[1];
    assert.equal(body.length, len);
    assert.ok(pdf.includes(`<${pdfHex('Größe – „Test“')}> Tj`));
    assert.ok(pdf.includes(`/Title <${pdfHex('Titel – Ä')}>`));
  });
}

test('pdfCanvas: text alignment and the fonts', () => {
  const cv = pdfCanvas(PDF_A4_PORTRAIT);
  cv.text('ab', 100, 50, { align: 'center', size: 10 });
  cv.text('ab', 100, 50, { align: 'right', bold: true });
  assert.match(cv.ops[0], /\/F1 10 Tf/);
  assert.match(cv.ops[1], /\/F2 9 Tf/);
  const left = Number(cv.ops[0].match(/g ([\d.]+) [\d.]+ Td/)[1]);
  assert.ok(Math.abs(left - (100 - pdfTextWidth('ab', 10) / 2) * PDF_MM) < 0.01);
});

test('pdfCanvas: rect outlines and circle (four curves, stroked or filled)', () => {
  const cv = pdfCanvas(PDF_A4_PORTRAIT);
  cv.rect(10, 20, 30, 5, { width: 1, dash: [2, 1] });
  // top left (10, 20), size 30 x 5 mm: the PDF rectangle starts at its lower left
  assert.equal(cv.ops[0], `1 w 0 G [2 1] 0 d ${pdfNum(10 * PDF_MM)} ${pdfNum((297 - 25) * PDF_MM)} ${pdfNum(30 * PDF_MM)} ${pdfNum(5 * PDF_MM)} re S`);
  cv.circle(50, 60, 2);
  cv.circle(50, 60, 2, { solid: true });
  assert.match(cv.ops[1], /^0\.6 w 0 G 0 g \[\] 0 d [\d. ]+ m( [\d. ]+){6} c( [\d. ]+){6} c( [\d. ]+){6} c( [\d. ]+){6} c S$/);
  assert.ok(cv.ops[2].endsWith(' c B'));
  // starts at the right-most point (cx + r, cy)
  assert.ok(cv.ops[1].includes(`${pdfNum(52 * PDF_MM)} ${pdfNum((297 - 60) * PDF_MM)} m`));
});

test('pdfDocument: several pages, Kids / Count and xref', () => {
  const pages = ['A', 'B', 'C'].map(t => { const cv = pdfCanvas(PDF_A4_PORTRAIT); cv.text(t, 10, 20); return cv.ops.join('\n'); });
  const pdf = latin1(pdfDocument(PDF_A4_PORTRAIT, pages, 'Drei'));
  assert.match(pdf, /\/Type \/Pages \/Kids \[3 0 R 5 0 R 7 0 R\] \/Count 3/);
  assert.equal((pdf.match(/\/Type \/Page \/Parent/g) || []).length, 3);
  const start = Number(pdf.match(/startxref\n(\d+)\n/)[1]);
  const entries = [...pdf.slice(start).matchAll(/(\d{10}) 00000 n /g)].map(m => Number(m[1]));
  assert.equal(entries.length, 11); // catalog, pages, 3 x (page, stream), 2 fonts, info
  entries.forEach((at, i) => assert.ok(pdf.slice(at).startsWith(`${i + 1} 0 obj\n`), `object ${i + 1}`));
  assert.match(pdf, /\/Size 12 \/Root 1 0 R \/Info 11 0 R/);
  // every page names the two fonts, which sit after the pages
  assert.equal((pdf.match(/\/Font << \/F1 9 0 R \/F2 10 0 R >>/g) || []).length, 3);
  assert.equal((pdf.match(/\/F1 (\d+) 0 R \/F2 (\d+) 0 R/g) || []).length, 3);
  const f1 = Number(pdf.match(/\/F1 (\d+) 0 R/)[1]);
  assert.ok(pdf.slice(entries[f1 - 1]).startsWith(`${f1} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica `));
  const streams = [...pdf.matchAll(/\/Length (\d+) >>\nstream\n([\s\S]*?)\nendstream/g)];
  assert.equal(streams.length, 3);
  streams.forEach(m => assert.equal(m[2].length, Number(m[1])));
  // an array of one page is the single-string document
  assert.equal(latin1(pdfDocument(PDF_A4_PORTRAIT, [pages[0]], 'x')), latin1(pdfDocument(PDF_A4_PORTRAIT, pages[0], 'x')));
});

test('pdfWrap: breaks at spaces, within the width, umlauts and line breaks kept', () => {
  const text = 'Für die Übung am Wochenende werden alle Stationen gebeten, größere Abstände einzuhalten und die Ölstände zu melden.';
  const lines = pdfWrap(text, 60, 10);
  assert.ok(lines.length > 2);
  for (const l of lines) assert.ok(pdfTextWidth(l, 10) <= 60, l);
  assert.equal(lines.join(' '), text);
  assert.deepEqual(pdfWrap('Zeile eins\nZeile zwei\r\n\nnach Leerzeile', 200, 10), ['Zeile eins', 'Zeile zwei', '', 'nach Leerzeile']);
  assert.deepEqual(pdfWrap('', 50, 10), ['']);
  assert.deepEqual(pdfWrap('kurz', 50, 10), ['kurz']);
  // bold is wider
  assert.ok(pdfWrap(text, 60, 10, true).length >= lines.length);
});

test('pdfWrap: a word wider than the line is broken hard, nothing lost', () => {
  const word = 'Donaudampfschifffahrtsgesellschaftskapitänsmützenabzeichen';
  const lines = pdfWrap(`vor ${word} nach`, 30, 10);
  for (const l of lines) assert.ok(pdfTextWidth(l, 10) <= 30, l);
  assert.equal(lines.join('').replace(/ /g, ''), `vor${word}nach`);
  assert.ok(lines.length >= 3);
  // a line narrower than one letter still advances (one character per line)
  assert.deepEqual(pdfWrap('abc', 0.1, 10), ['a', 'b', 'c']);
});

test('pdfCanvas: a colour [r, g, b] for text and fills, gray stays the default', () => {
  const cv = pdfCanvas(PDF_A4_PORTRAIT);
  cv.text('NOTFALL', 10, 10, { color: [1, 1, 1] });
  cv.fill(10, 10, 20, 5, [0.776, 0.157, 0.157]);
  cv.text('Text', 10, 20);
  cv.fill(10, 20, 5, 5, 0.5);
  const ops = cv.ops.join('\n');
  assert.match(ops, /\b1 1 1 rg\b/);
  assert.match(ops, /\b0\.78 0\.16 0\.16 rg\b/);
  assert.match(ops, /\b0 g\b/);
  assert.match(ops, /\b0\.5 g\b/);
});
