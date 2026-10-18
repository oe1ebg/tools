// The Vordruck PDF (tools/notfunk/js/paperpdf.js): one portrait A4 page
// with the form's captions and options, nothing outside the page, nothing
// filled in but the Einsatz's name.
import test from 'node:test';
import assert from 'node:assert/strict';
import { blankFormPdf, NFP_PAGE } from '../tools/notfunk/js/paperpdf.js';
import { blankFormSheet } from '../tools/notfunk/js/print.js';
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
    'AUFGENOMMEN VON (NAME / UNTERSCHRIFT)', 'ANMERKUNGEN / WEITERE VERANLASSUNG', 'Blatt',
    `Notfunk-Meldebuch · Vordruck, gedruckt ${s.printed}`,
    ...s.directions.map(d => d.label.toUpperCase()),
    ...[...s.channels, ...s.priorities, ...s.types].map(o => o.label),
    ...s.handoverHeads.map(h => h.toUpperCase())];
  for (const w of want) assert.ok(t.includes(w), w);
  assert.deepEqual(s.priorities.map(p => p.label), ['Routine', 'Dringend', 'Notfall']);
  // each option once; every choice has its circle (6 + 3 + 5), the ticks are squares
  assert.equal((latin1(blankFormPdf(OP, { now: NOW })).match(/ c (?:B|S)$/gm) || []).length, 14);
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

test('blankFormPdf: the text area has at least 7 ruled lines, 9 mm apart or more', () => {
  const pdf = latin1(blankFormPdf(OP, { now: NOW }));
  // full-width writing lines: 0.5 pt, from x 12.5 mm to 197.5 mm
  const x = n => (n * PDF_MM).toFixed(2).replace(/\.?0+$/, '');
  const ys = [...pdf.matchAll(new RegExp(`^0\\.5 w 0 G \\[\\] 0 d ${x(12.5)} ([\\d.]+) m ${x(197.5)} \\1 l S$`, 'gm'))].map(m => Number(m[1]));
  assert.ok(ys.length >= 7, `${ys.length} lines`);
  for (let i = 1; i < ys.length; i++) assert.ok((ys[i - 1] - ys[i]) / PDF_MM >= 9 - 0.01);
});
