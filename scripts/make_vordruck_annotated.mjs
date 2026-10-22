// Makes docs/static/notfunk-vordruck-beschriftet.png: the empty Notfunk form
// (the tool's own PDF) with labelled fields, for docs/notfunk-ausdruck.md.
// Committed, not built: the pinned Playwright image has no PDF rasteriser
// (docs/static/ holds the pictures of that kind). Run after the form
// changes (tools/notfunk/js/paperpdf.js):
//
//   node scripts/make_vordruck_annotated.mjs
//
// Needs poppler (pdftoppm, pdftotext) and Playwright (tests/e2e/node_modules).
// Each note names a word that must stand inside its box on the page, so a
// changed layout fails here instead of producing a wrong picture.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blankFormPdf } from '../tools/notfunk/js/paperpdf.js';
import { annotate } from '../tests/e2e/annotate.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, 'docs/static/notfunk-vordruck-beschriftet.png');
const PX = 100 / 72;   // the boxes below are in pixels at 100 dpi

// box: x, y, w, h at 100 dpi; word: a word of the form inside the box
const NOTES = [
  { box: [591, 39, 196, 96], word: 'NOTFUNK-NR.', side: 'right', text: 'Nummer der Meldung, fortlaufend (z. B. W1-007)' },
  { box: [40, 96, 532, 40], word: 'EINGANG', side: 'left', text: 'Richtung ankreuzen: Eingang = empfangen, Ausgang = weitergefunkt' },
  { box: [39, 160, 748, 62], word: 'MELDESAMMELSTELLE', side: 'right', text: 'Frei lassen: füllt die Meldesammelstelle aus' },
  { box: [40, 233, 430, 66], word: 'EMPFANGEN', side: 'left', text: 'Wann die Meldung übermittelt wurde: Datum und Uhrzeit (Ortszeit)' },
  { box: [473, 233, 314, 66], word: 'DRINGLICHKEIT', side: 'right', text: 'Dringlichkeit: eine Stufe einkreisen' },
  { box: [40, 300, 747, 98], word: 'ÜBERMITTLUNG', side: 'right', text: 'Wie übermittelt (Funk, Telefon …) und Meldungsart: jeweils einkreisen' },
  { box: [40, 402, 374, 118], word: '(ABSENDER)', side: 'left', text: 'Von: wer die Meldung aufgibt, und seine Funkstelle' },
  { box: [414, 402, 373, 118], word: '(ADRESSAT)', side: 'right', text: 'An: für wen sie bestimmt ist, mit Funkstelle und Verteiler' },
  { box: [40, 522, 747, 60], word: 'BETREFF', side: 'left', text: 'Betreff (kurz), Ort des Ereignisses, Bezug auf eine frühere Meldung' },
  { box: [40, 584, 747, 340], word: 'INHALT', side: 'left', text: 'Inhalt: der Wortlaut, wie übermittelt, nichts weglassen' },
  { box: [48, 930, 300, 22], word: 'Rücklesen', side: 'right', text: 'Rücklesen (optional): ankreuzen, wenn der Absender bestätigt hat' },
  { box: [40, 958, 374, 92], word: 'AUFGENOMMEN', side: 'left', text: 'Aufgenommen von: Ihr Name oder Ihre Unterschrift, Ihre Station' },
  { box: [40, 1050, 747, 66], word: 'ZEITPUNKT', side: 'right', text: 'Übergabe bzw. Übertragung: an wen, wann, wer hat übernommen' },
];

const dir = mkdtempSync(join(tmpdir(), 'vordruck-'));
writeFileSync(join(dir, 'v.pdf'), blankFormPdf(null, { now: '2026-10-08T12:00:00Z' }));
execFileSync('pdftoppm', ['-r', '150', '-png', '-singlefile', join(dir, 'v.pdf'), join(dir, 'v')]);
const words = [...execFileSync('pdftotext', ['-bbox', join(dir, 'v.pdf'), '-'], { encoding: 'utf8' })
  .matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g)]
  .map(m => ({ x1: +m[1], y1: +m[2], x2: +m[3], y2: +m[4], t: m[5] }));
for (const n of NOTES) {
  const [x, y, w, h] = n.box.map(v => v / PX);   // points
  const hit = words.some(k => k.t === n.word && k.x1 >= x - 1 && k.x2 <= x + w + 1 && k.y1 >= y - 1 && k.y2 <= y + h + 1);
  if (!hit) throw new Error(`the form changed: "${n.word}" is not inside its box ${n.box}`);
}

const { chromium } = await import(join(ROOT, 'tests/e2e/node_modules/@playwright/test/index.mjs'));
const browser = await chromium.launch();
const context = await browser.newContext({ deviceScaleFactor: 1.5 });
await annotate(context, readFileSync(join(dir, 'v.png')), { width: 827, height: 1170 },
  NOTES.map(n => ({ box: { x: n.box[0], y: n.box[1], w: n.box[2], h: n.box[3] }, text: n.text, side: n.side })), OUT);
await browser.close();
console.log(`wrote ${OUT}`);
