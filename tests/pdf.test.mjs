// The shared PDF writer (tools/shared/js/pdf.js): WinAnsi text, widths,
// page sizes, a structurally valid file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PDF_A4_LANDSCAPE, PDF_A4_PORTRAIT, PDF_MM, pdfCanvas, pdfDocument, pdfHex, pdfNum, pdfTextWidth } from '../tools/shared/js/pdf.js';

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
