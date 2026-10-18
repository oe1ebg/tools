// The empty log on paper ("Leerformular") as a PDF: one landscape A4 page
// with PAPER_LINES lines in a template's columns, to print in advance (a
// stack of them for when a device fails, or for logging without one).
// Nothing is filled in: log, date, Betrieb, numbers, times and the sheet
// number are written by hand, so every sheet of a stack is the same.
//
// A PDF and not the page printed by the browser: every browser's print
// engine scales, breaks and pads differently; a PDF prints the same at its
// own size everywhere. Written here, without a library: lines, rectangles
// and text in the PDF's built-in Helvetica (no font embedded), Latin-1 /
// WinAnsi text. The columns follow the log's (logColumns()): each siren
// grade and AT-Alert's "ok" / "fehlt" a cell of its own to tick or cross,
// the full line between the groups, dotted lines inside.

import { logColumns, nameField } from './templates.js';

// 15 lines of 11.3 mm: room to write by hand on a clipboard, outdoors,
// in a hurry (ruled paper is 7-9 mm; forms for handwriting want 10 mm+)
export const PAPER_LINES = 15;

const PDF_MM = 72 / 25.4;
const PDF_PAGE_W = 297, PDF_PAGE_H = 210; // A4 landscape, mm
const PDF_MARGIN = 7;

// Helvetica / Helvetica-Bold advance widths (1/1000 em) for ASCII 32..126
// (Adobe's AFM files); other characters use the width of their base letter.
const PDF_HELV = '278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584'.split(',').map(Number);
const PDF_HELV_BOLD = '278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584'.split(',').map(Number);
// WinAnsi codes outside Latin-1 that German text needs
const PDF_WIN_ANSI = { '–': 0x96, '—': 0x97, '…': 0x85, '„': 0x84, '“': 0x93, '”': 0x94, '‚': 0x82, '‘': 0x91, '’': 0x92, '€': 0x80 };
const PDF_BASE_LETTER = { 'Ä': 'A', 'Ö': 'O', 'Ü': 'U', 'ä': 'a', 'ö': 'o', 'ü': 'u', 'ß': 'B', 'é': 'e', 'è': 'e' };

function pdfCode(ch) {
  if (PDF_WIN_ANSI[ch]) return PDF_WIN_ANSI[ch];
  const c = ch.charCodeAt(0);
  return c < 256 ? c : 0x3f; // "?"
}

// Width of a text in mm at `size` pt.
function pdfTextWidth(text, size, bold = false) {
  const table = bold ? PDF_HELV_BOLD : PDF_HELV;
  let units = 0;
  for (const ch of text) {
    const base = PDF_BASE_LETTER[ch] || ch;
    const c = base.charCodeAt(0);
    units += c >= 32 && c <= 126 ? table[c - 32] : ch === '…' ? 1000 : 556;
  }
  return units / 1000 * size / PDF_MM;
}

function pdfHex(text) {
  return [...text].map(ch => pdfCode(ch).toString(16).padStart(2, '0')).join('');
}

const pdfNum = v => (Math.round(v * 100) / 100).toString();

// A content stream drawn in mm from the top left of the page.
function pdfCanvas() {
  const ops = [];
  const X = x => pdfNum(x * PDF_MM), Y = y => pdfNum((PDF_PAGE_H - y) * PDF_MM);
  return {
    ops,
    line(x1, y1, x2, y2, { width = 0.6, gray = 0, dash = null } = {}) {
      ops.push(`${pdfNum(width)} w ${pdfNum(gray)} G ${dash ? `[${dash.join(' ')}] 0 d` : '[] 0 d'} ${X(x1)} ${Y(y1)} m ${X(x2)} ${Y(y2)} l S`);
    },
    fill(x, y, w, h, gray) {
      ops.push(`${pdfNum(gray)} g ${X(x)} ${Y(y + h)} ${pdfNum(w * PDF_MM)} ${pdfNum(h * PDF_MM)} re f`);
    },
    // baseline at y; align: left | center | right of x
    text(str, x, y, { size = 9, bold = false, gray = 0, align = 'left' } = {}) {
      const w = pdfTextWidth(str, size, bold);
      const left = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
      ops.push(`BT /${bold ? 'F2' : 'F1'} ${pdfNum(size)} Tf ${pdfNum(gray)} g ${X(left)} ${Y(y)} Td <${pdfHex(str)}> Tj ET`);
    },
  };
}

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
  const cv = pdfCanvas();
  const x0 = PDF_MARGIN, x1 = PDF_PAGE_W - PDF_MARGIN, width = x1 - x0;
  const label = (text, x, y) => { cv.text(text.toUpperCase(), x, y, { size: 7 }); return x + pdfTextWidth(text.toUpperCase(), 7) + 1.2; };
  const blank = (xa, xb, y) => cv.line(xa, y + 0.6, xb, y + 0.6, { width: 0.6 });

  // the title line: the template, the log's name and the sheet number to fill in
  let y = PDF_MARGIN + 5;
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
  const foot = PDF_PAGE_H - PDF_MARGIN - 1;
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
  const content = paperContent(tpl, lines);
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pdfNum(PDF_PAGE_W * PDF_MM)} ${pdfNum(PDF_PAGE_H * PDF_MM)}] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    `<< /Title <${pdfHex(`${tpl.label} – Leerformular`)}> /Producer (oe1ebg tools) >>`,
  ];
  // All ASCII (text as hex strings): string length = byte length.
  let out = '%PDF-1.4\n';
  const offsets = objects.map((body, i) => {
    const at = out.length;
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${objects.length} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i);
  return bytes;
}
