// The Leerformular PDF (tools/confirm/js/paperpdf.js): a valid one-page A4
// landscape file per template, with the log's columns and 15 empty lines.
import test from 'node:test';
import assert from 'node:assert/strict';
import { paperPdf, PAPER_LINES } from '../tools/confirm/js/paperpdf.js';
import { TEMPLATES } from '../tools/confirm/js/templates.js';

const latin1 = bytes => String.fromCharCode(...bytes);

// The texts drawn on the page (hex strings in WinAnsi) in order.
function texts(pdf) {
  return [...pdf.matchAll(/<([0-9a-f]+)> Tj/g)].map(m => {
    const codes = m[1].match(/../g).map(h => parseInt(h, 16));
    return codes.map(c => (c === 0x96 ? '–' : c === 0x85 ? '…' : String.fromCharCode(c))).join('');
  });
}

for (const tpl of TEMPLATES) {
  test(`paperPdf(${tpl.key}): one A4 landscape page, the xref points at every object`, () => {
    const pdf = latin1(paperPdf(tpl));
    assert.ok(pdf.startsWith('%PDF-1.4\n'));
    assert.ok(pdf.endsWith('%%EOF\n'));
    assert.match(pdf, /\/Type \/Pages \/Kids \[3 0 R\] \/Count 1/);
    assert.match(pdf, /\/MediaBox \[0 0 841\.89 595\.28\]/);
    const xref = Number(pdf.match(/startxref\n(\d+)/)[1]);
    assert.equal(pdf.slice(xref, xref + 4), 'xref');
    const offsets = [...pdf.slice(xref).matchAll(/^(\d{10}) 00000 n $/gm)].map(m => Number(m[1]));
    assert.equal(offsets.length, 7);
    offsets.forEach((o, i) => assert.equal(pdf.slice(o, o + `${i + 1} 0 obj`.length), `${i + 1} 0 obj`));
    const len = Number(pdf.match(/<< \/Length (\d+) >>\nstream\n/)[1]);
    const start = pdf.indexOf('stream\n') + 'stream\n'.length;
    assert.equal(pdf.slice(start + len, start + len + '\nendstream'.length), '\nendstream');
    assert.ok(/^[\x0a\x20-\x7e]*$/.test(pdf), 'all ASCII');
  });
}

test('paperPdf: the Zivilschutz sheet has its columns, 15 lines and no log data', () => {
  const tpl = TEMPLATES.find(t => t.key === 'zivilschutz');
  const t = texts(latin1(paperPdf(tpl)));
  assert.equal(PAPER_LINES, 15);
  assert.ok(t.includes('Zivilschutz-Probealarm – Log'));
  for (const h of ['NR', 'ZEIT', 'RUFZEICHEN', 'STANDORT', 'SIRENE ZU', 'OFFEN', 'AUSSEN', 'AT-ALERT', 'NOTIZ']) assert.ok(t.includes(h), h);
  assert.equal(t.filter(x => x === 'Handy').length, 15);
  assert.equal(t.filter(x => x === 'fehlt').length, 15);
  // each line: 1-5 for three groups
  assert.equal(t.filter(x => x === '3').length, 45);
});

test('paperPdf: Rufzeichen + RST names the column and has the slash per line', () => {
  const t = texts(latin1(paperPdf(TEMPLATES.find(x => x.key === 'rst'))));
  assert.ok(t.includes('RUFZEICHEN / NAME'));
  assert.ok(t.includes('RST ERH/GEG'));
  assert.equal(t.filter(x => x === '/').length, 15);
});
