// The empty Meldeaufnahmeformular ("Vordruck") as a PDF: one portrait A4
// page of the ÖBFV E-31 form's fields (blankFormSheet() in print.js), to
// print a stack of for working without a device. Nothing is filled in but
// the Einsatz's name in the title line; everything else is written by hand.
//
// A PDF and not the page printed by the browser: every browser's print
// engine scales and pads differently (WebKit prints 1 CSS px as 0.8 pt);
// a PDF prints the same at its own size everywhere. Written with the
// shared PDF writer (../../shared/js/pdf.js). White paper, black thin
// lines, no filled areas. Writing lines are 9 mm and more apart, tick
// boxes and circles 4.4 mm and more: made for a pen on a clipboard.
// A circle = choose exactly one (Übermittlung, Dringlichkeit,
// Meldungsart), a square = an extra mark (Eingang / Ausgang, Rücklesen).
//
// The words (options, headings of the handover row, the footer) come from
// blankFormSheet() and model.js; only the captions of the fields are
// written here (NFP_CAPTIONS), as in printview.js.

import { blankFormSheet } from './print.js';
import { PDF_A4_PORTRAIT, pdfCanvas, pdfDocument, pdfTextWidth } from '../../shared/js/pdf.js';

export const NFP_PAGE = PDF_A4_PORTRAIT;
const NFP_MARGIN = 10;
const NFP_LINE = 0.8; // pt: frames
const NFP_WRITE = 0.5; // pt: lines to write on
const NFP_PITCH = 9.5; // mm between the ruled lines of the text
const NFP_TICK = 4.8; // mm: square to tick
const NFP_CIRCLE_R = 2.3; // mm: radius of the choice circles (4.6 mm across)

const NFP_CAPTIONS = {
  org: 'ÖVSV Notfunk',
  title: 'Meldeaufnahmeformular',
  number: 'Notfunk-Nr.',
  staff: 'Nur von der Meldesammelstelle auszufüllen',
  staffFields: ['Referenz / Geschäftsbuch-Nr.', 'Federführend', 'Mitwirkend', 'Zur Kenntnis'],
  date: 'Datum', time: 'Uhrzeit',
  channel: 'Übermittlung', priority: 'Dringlichkeit', type: 'Meldungsart',
  from: 'Von (Absender)', to: 'An (Adressat)', peer: 'Funkstelle', distribution: 'Verteiler',
  subject: 'Betreff', place: 'Ort', ref: 'Bezug',
  text: 'Inhalt – wörtlich, wie übermittelt',
  operator: 'Aufgenommen von (Name / Unterschrift)', station: 'an Station',
  remarks: 'Anmerkungen / weitere Veranlassung',
  sheet: 'Blatt',
};

// Tiles of a choice, wrapped to `width` mm: [{ option, x, y, w }] (x, y
// relative to the top left) and the height used.
const NFP_TILE_H = 7.6;
const NFP_TILE_GAP = 1.6;
function nfpTiles(options, width) {
  const tiles = [];
  let x = 0, y = 0;
  for (const option of options) {
    const w = 2.6 + NFP_CIRCLE_R * 2 + 2 + pdfTextWidth(option.label, 9.5) + 2.8;
    if (x && x + w > width) { x = 0; y += NFP_TILE_H + NFP_TILE_GAP; }
    tiles.push({ option, x, y, w });
    x += w + NFP_TILE_GAP;
  }
  return { tiles, height: y + NFP_TILE_H };
}

// The page's content stream.
function nfpContent(s) {
  const cv = pdfCanvas(NFP_PAGE);
  const x0 = NFP_MARGIN, x1 = NFP_PAGE.width - NFP_MARGIN, width = x1 - x0;
  const caption = (text, x, y, opts = {}) => cv.text(text.toUpperCase(), x, y, { size: 6.8, gray: 0.15, ...opts });
  const writeLine = (xa, xb, y) => cv.line(xa, y, xb, y, { width: NFP_WRITE });
  // "Funkstelle ______" : a small caption and the line after it
  const labelled = (text, xa, xb, y) => {
    cv.text(text, xa, y, { size: 8, gray: 0.15 });
    writeLine(xa + pdfTextWidth(text, 8) + 1.5, xb, y);
  };
  const tick = (x, y, size = NFP_TICK) => cv.rect(x, y, size, size, { width: NFP_LINE });
  const frame = (x, y, w, h) => cv.rect(x, y, w, h, { width: NFP_LINE });
  // cells of a row side by side: widths in shares, borders between
  const cellsOf = (shares, total = width) => {
    const sum = shares.reduce((a, b) => a + b, 0);
    let x = x0;
    return shares.map(sh => { const c = { x, w: total * sh / sum }; x += c.w; return c; });
  };
  const row = (y, h, shares) => {
    const cells = cellsOf(shares);
    frame(x0, y, width, h);
    for (const c of cells.slice(1)) cv.line(c.x, y, c.x, y + h, { width: NFP_LINE });
    return cells;
  };
  const choice = (label, options, c, y) => {
    caption(label, c.x + 2.5, y + 3.6);
    const layout = nfpTiles(options, c.w - 5);
    for (const t of layout.tiles) {
      const tx = c.x + 2.5 + t.x, ty = y + 5.4 + t.y;
      cv.rect(tx, ty, t.w, NFP_TILE_H, { width: 0.7 });
      cv.circle(tx + 2.6 + NFP_CIRCLE_R, ty + NFP_TILE_H / 2, NFP_CIRCLE_R, { width: NFP_LINE });
      cv.text(t.option.label, tx + 2.6 + NFP_CIRCLE_R * 2 + 2, ty + NFP_TILE_H / 2 + 1.25, { size: 9.5 });
    }
  };
  const choiceHeight = (options, c) => 5.4 + nfpTiles(options, c.w - 5).height + 2.4;

  // ---- header: title, Eingang / Ausgang, the number's box
  let y = NFP_MARGIN;
  const numW = 50, numX = x1 - numW, headH = 24.5;
  caption([NFP_CAPTIONS.org, s.title].filter(Boolean).join(' · '), x0, y + 3.2, { size: 7 });
  cv.text(NFP_CAPTIONS.title, x0, y + 11.5, { size: 19, bold: true });
  const dirW = (numX - 5 - x0 - 3) / 2;
  s.directions.forEach((d, i) => {
    const bx = x0 + i * (dirW + 3), by = y + 14.5;
    cv.rect(bx, by, dirW, 10, { width: 1.1 });
    tick(bx + 3, by + 2.6, 4.8);
    // an arrow: Eingang down, Ausgang up
    const ax = bx + 13, top = by + 2.4, bot = by + 7.6, up = d.key === 'out';
    cv.line(ax, top, ax, bot, { width: 1.1 });
    const tip = up ? top : bot, back = up ? top + 2.2 : bot - 2.2;
    cv.line(ax, tip, ax - 1.8, back, { width: 1.1 });
    cv.line(ax, tip, ax + 1.8, back, { width: 1.1 });
    cv.text(d.label.toUpperCase(), bx + 18, by + 6.9, { size: 11, bold: true });
  });
  frame(numX, y, numW, headH);
  caption(NFP_CAPTIONS.number, numX + 2.5, y + 3.8);
  y += headH + 2.5;
  cv.line(x0, y, x1, y, { width: 1.5 });
  y += 3.5;

  // ---- the Meldesammelstelle's block (dashed)
  const staffH = 17.5;
  cv.rect(x0, y, width, staffH, { width: NFP_LINE, dash: [2, 1.5] });
  cv.text(NFP_CAPTIONS.staff.toUpperCase(), x0 + 2.5, y + 3.7, { size: 6.8, bold: true });
  const inner = width - 5, gap = 4;
  const shares = [1.3, 1, 1, 1], unit = (inner - gap * 3) / 4.3;
  let sx = x0 + 2.5;
  NFP_CAPTIONS.staffFields.forEach((f, i) => {
    const w = unit * shares[i];
    caption(f, sx, y + 8);
    writeLine(sx, sx + w, y + 14.2);
    sx += w + gap;
  });
  y += staffH + 3.5;

  // ---- rows of boxes
  // Datum / Uhrzeit | Übermittlung
  const aShares = [34, 66];
  const aCells = cellsOf(aShares);
  let h = Math.max(choiceHeight(s.channels, aCells[1]), 22);
  let cells = row(y, h, aShares);
  caption(s.timeLabel, cells[0].x + 2.5, y + 3.6);
  labelled(NFP_CAPTIONS.date, cells[0].x + 2.5, cells[0].x + cells[0].w - 3, y + 12.2);
  labelled(NFP_CAPTIONS.time, cells[0].x + 2.5, cells[0].x + cells[0].w - 3, y + 19.4);
  choice(NFP_CAPTIONS.channel, s.channels, cells[1], y);
  y += h;
  // Dringlichkeit | Meldungsart
  const bShares = [44, 56];
  const bCells = cellsOf(bShares);
  h = Math.max(choiceHeight(s.priorities, bCells[0]), choiceHeight(s.types, bCells[1]));
  cells = row(y, h, bShares);
  choice(NFP_CAPTIONS.priority, s.priorities, cells[0], y);
  choice(NFP_CAPTIONS.type, s.types, cells[1], y);
  y += h;
  // Von | An (each with the radio station; An also the distribution list)
  h = 31;
  cells = row(y, h, [1, 1]);
  cells.forEach((c, i) => {
    caption(i ? NFP_CAPTIONS.to : NFP_CAPTIONS.from, c.x + 2.5, y + 3.6);
    writeLine(c.x + 2.5, c.x + c.w - 2.5, y + 12);
    labelled(NFP_CAPTIONS.peer, c.x + 2.5, c.x + c.w - 2.5, y + 20.4);
    if (i) labelled(NFP_CAPTIONS.distribution, c.x + 2.5, c.x + c.w - 2.5, y + 28);
  });
  y += h;
  // Betreff | Ort | Bezug
  h = 15.5;
  cells = row(y, h, [1.7, 1.3, 0.6]);
  [NFP_CAPTIONS.subject, NFP_CAPTIONS.place, NFP_CAPTIONS.ref].forEach((t, i) => {
    caption(t, cells[i].x + 2.5, y + 3.6);
    writeLine(cells[i].x + 2.5, cells[i].x + cells[i].w - 2.5, y + 12.4);
  });
  y += h;

  // ---- below the text: Aufgenommen von | Anmerkungen, the handover, footer
  const takeH = 23, handH = 17, footY = NFP_PAGE.height - NFP_MARGIN + 0.5;
  const textBottom = footY - 4 - handH - takeH;
  // ---- the text: ruled lines, then the Rücklesen mark
  const textH = textBottom - y, readH = 9;
  frame(x0, y, width, textH);
  caption(NFP_CAPTIONS.text, x0 + 2.5, y + 3.6);
  const lines = Math.floor((textH - 5 - readH) / NFP_PITCH);
  const pitch = (textH - 5 - readH) / lines;
  for (let i = 1; i <= lines; i++) writeLine(x0 + 2.5, x1 - 2.5, y + 5 + i * pitch - 0.3);
  const readY = y + textH - readH + 2.3;
  tick(x0 + 2.5, readY, 4.4);
  cv.text(s.readBackLabel, x0 + 9, readY + 3.4, { size: 8.5, gray: 0.1 });
  y = textBottom;

  cells = row(y, takeH, [1, 1]);
  caption(NFP_CAPTIONS.operator, cells[0].x + 2.5, y + 3.6);
  writeLine(cells[0].x + 2.5, cells[0].x + cells[0].w - 2.5, y + 13);
  labelled(NFP_CAPTIONS.station, cells[0].x + 2.5, cells[0].x + cells[0].w - 2.5, y + 20);
  caption(NFP_CAPTIONS.remarks, cells[1].x + 2.5, y + 3.6);
  writeLine(cells[1].x + 2.5, cells[1].x + cells[1].w - 2.5, y + 13);
  writeLine(cells[1].x + 2.5, cells[1].x + cells[1].w - 2.5, y + 20);
  y += takeH;

  cells = row(y, handH, [1, 0.8, 1, 0.8]);
  s.handoverHeads.forEach((head, i) => {
    caption(head, cells[i].x + 2.5, y + 3.6);
    if (i === 3) tick(cells[i].x + 2.5, y + 8.3, 5.6);
    else writeLine(cells[i].x + 2.5, cells[i].x + cells[i].w - 2.5, y + 13.4);
  });

  // ---- footer
  cv.text(`Notfunk-Meldebuch · Vordruck, gedruckt ${s.printed}`, x0, footY, { size: 7, gray: 0.2 });
  const sheetBlank = 14;
  cv.text(NFP_CAPTIONS.sheet, x1 - sheetBlank - 1.5, footY, { size: 7, gray: 0.2, align: 'right' });
  writeLine(x1 - sheetBlank, x1, footY + 0.4);
  return cv.ops.join('\n');
}

// -> the empty form as PDF bytes (Uint8Array). op: the Einsatz (its name is
// in the title line), or null; now: ISO timestamp for "gedruckt".
export function blankFormPdf(op, { now }) {
  const s = blankFormSheet(op, { now });
  return pdfDocument(NFP_PAGE, nfpContent(s), `Meldeaufnahmeformular – Vordruck${s.title ? ` ${s.title}` : ''}`);
}
