// The empty log on paper ("Leerformular") as a PDF: one landscape A4 page
// with PAPER_LINES lines in a template's columns, to print in advance (a
// stack of them for when a device fails, or for logging without one).
// Nothing is filled in: log, date, Betrieb, numbers, times and the sheet
// number are written by hand, so every sheet of a stack is the same.
//
// A PDF and not the page printed by the browser: every browser's print
// engine scales, breaks and pads differently; a PDF prints the same at its
// own size everywhere. Written with the shared PDF writer
// (../../shared/js/pdf.js). The columns follow the log's (logColumns()): each siren
// grade and AT-Alert's "ok" / "fehlt" a cell of its own to tick or cross,
// the full line between the groups, dotted lines inside.

import { logColumns, nameField } from './templates.js';
import { PDF_A4_LANDSCAPE, pdfCanvas, pdfDocument, pdfTextWidth } from '../../shared/js/pdf.js';

// 15 lines of 11.3 mm: room to write by hand on a clipboard, outdoors,
// in a hurry (ruled paper is 7-9 mm; forms for handwriting want 10 mm+)
export const PAPER_LINES = 15;

const PAPER_PAGE = PDF_A4_LANDSCAPE;
const PAPER_MARGIN = 7;

// Columns of the sheet: [{ w (% of the width), head, group, cell }]. A
// group's sub-columns share one heading; `cell` is what each empty line
// shows ("1", "ok", "/", "Handy" in the corner).
function paperColumns(tpl) {
  const cols = [
    { w: 4, head: 'Nr' },
    { w: 6.5, head: 'Zeit' },
    { w: 10, head: nameField(tpl) ? 'Rufzeichen / Name' : 'Rufzeichen' },
  ];
  for (const c of logColumns(tpl)) {
    if (c.kind === 'rst') cols.push({ w: 9, head: 'RST erh/geg', cell: { text: '/' } });
    else if (c.kind === 'location') cols.push({ w: 19, head: c.head });
    else if (c.kind === 'grades') {
      c.fields.forEach((f, i) => {
        const group = { head: i ? f.short : `${c.head} ${f.short}` };
        for (const g of ['1', '2', '3', '4', '5']) cols.push({ w: 2.1, group, cell: { text: g } });
      });
    } else if (c.kind === 'chain' && c.fields[0].key === 'atalert') {
      const group = { head: c.head };
      cols.push({ w: 2.8, group, cell: { text: 'ok' } }, { w: 3.6, group, cell: { text: 'fehlt' } },
        { w: 8, group, cell: { text: 'Handy', corner: true } });
    } else cols.push({ w: 12, head: c.head });
  }
  const used = cols.reduce((s, c) => s + c.w, 0);
  cols.push({ w: Math.max(100 - used, 8), head: 'Notiz' });
  return cols;
}

// The page's content stream.
function paperContent(tpl, lines) {
  const cv = pdfCanvas(PAPER_PAGE);
  const x0 = PAPER_MARGIN, x1 = PAPER_PAGE.width - PAPER_MARGIN, width = x1 - x0;
  const label = (text, x, y) => { cv.text(text.toUpperCase(), x, y, { size: 7 }); return x + pdfTextWidth(text.toUpperCase(), 7) + 1.2; };
  const blank = (xa, xb, y) => cv.line(xa, y + 0.6, xb, y + 0.6, { width: 0.6 });

  // the title line: the template, the log's name and the sheet number to fill in
  let y = PAPER_MARGIN + 5;
  const title = `${tpl.label} – Log`;
  cv.text(title, x0, y, { size: 12, bold: true });
  const sheetBlank = 16;
  const sheetLabelX = x1 - sheetBlank - 1.2 - pdfTextWidth('BLATT', 7);
  let x = label('Log', x0 + pdfTextWidth(title, 12, true) + 5, y);
  blank(x, sheetLabelX - 5, y);
  label('Blatt', sheetLabelX, y);
  blank(x1 - sheetBlank, x1, y);

  // Datum, Operator, Station, Frequenz / Mode, Relais: each its share
  y += 8.5;
  const fields = [['Datum', 1], ['Operator', 1], ['Station', 1], ['Frequenz / Mode', 1.4], ['Relais', 1]];
  const gap = 4, unit = (width - gap * (fields.length - 1)) / fields.reduce((s, f) => s + f[1], 0);
  x = x0;
  for (const [name, share] of fields) {
    const end = x + share * unit;
    blank(label(name, x, y), end, y);
    x = end + gap;
  }

  // the table: heading row, then the lines, as tall as the page allows
  const cols = paperColumns(tpl);
  const total = cols.reduce((s, c) => s + c.w, 0);
  let cx = x0;
  for (const c of cols) { c.x = cx; c.width = c.w / total * width; cx += c.width; }
  const top = y + 4, headH = 5.5;
  const foot = PAPER_PAGE.height - PAPER_MARGIN - 1;
  const bottom = foot - 3.5;
  const rowH = (bottom - top - headH) / lines;

  cv.fill(x0, top, width, headH, 0.92);
  const headY = top + headH / 2 + 1.2;
  for (let i = 0; i < cols.length; i++) {
    const c = cols[i];
    if (c.group) {
      if (cols[i - 1]?.group === c.group) continue;
      const members = cols.filter(m => m.group === c.group);
      const end = members[members.length - 1];
      cv.text(c.group.head.toUpperCase(), (c.x + end.x + end.width) / 2, headY, { size: 7, bold: true, align: 'center' });
    } else {
      cv.text(c.head.toUpperCase(), c.x + 1.2, headY, { size: 7, bold: true, align: i === 0 ? 'left' : 'left' });
    }
  }
  // the lines' cells: what each shows
  for (let r = 0; r < lines; r++) {
    const ry = top + headH + r * rowH;
    for (const c of cols) {
      if (!c.cell) continue;
      if (c.cell.corner) cv.text(c.cell.text, c.x + 0.8, ry + 2.4, { size: 6, gray: 0.45 });
      else cv.text(c.cell.text, c.x + c.width / 2, ry + rowH / 2 + 1, { size: 7.5, gray: 0.3, align: 'center' });
    }
  }
  // grid: dotted inside a group (below its heading), the full line elsewhere
  for (let i = 0; i <= cols.length; i++) {
    const xv = i < cols.length ? cols[i].x : x1;
    const inside = i > 0 && i < cols.length && cols[i].group && cols[i].group === cols[i - 1].group;
    if (inside) cv.line(xv, top + headH, xv, bottom, { width: 0.4, gray: 0.55, dash: [0.8, 1.6] });
    else cv.line(xv, top, xv, bottom, { width: 0.6 });
  }
  for (let r = 0; r <= lines; r++) cv.line(x0, top + headH + r * rowH, x1, top + headH + r * rowH, { width: 0.6 });
  cv.line(x0, top, x1, top, { width: 0.6 });

  cv.text('Relais oder Operator in der Notiz nur, wenn sie von den Angaben oben abweichen. Kommentare (Operatorwechsel, Frequenzwechsel, Pause …): eine eigene Zeile, Zeit und Text, Rufzeichen frei lassen.',
    x0, foot, { size: 7, gray: 0.2 });
  return cv.ops.join('\n');
}

// -> the PDF file as bytes (Uint8Array). tpl: the template.
export function paperPdf(tpl, { lines = PAPER_LINES } = {}) {
  return pdfDocument(PAPER_PAGE, paperContent(tpl, lines), `${tpl.label} – Leerformular`);
}
