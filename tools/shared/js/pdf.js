// A minimal PDF writer for the tools' paper forms (Confirm's Leerformular,
// Notfunk's blank message form), without a library: lines, rectangles and
// text in the PDF's built-in Helvetica / Helvetica-Bold (no font embedded),
// Latin-1 / WinAnsi text, drawn in mm from the top left of a page of any
// size (A4 landscape or portrait). Pure, except pdfOpen() (UI).
//
// A PDF and not the page printed by the browser: every browser's print
// engine scales, breaks and pads differently; a PDF prints the same at its
// own size everywhere.
//
//   const cv = pdfCanvas(PDF_A4_PORTRAIT);   // cv.line / fill / text
//   const bytes = pdfDocument(PDF_A4_PORTRAIT, cv.ops.join('\n'), 'Title');
//   pdfOpen(bytes, 'form.pdf');

export const PDF_MM = 72 / 25.4;
export const PDF_A4_LANDSCAPE = { width: 297, height: 210 }; // mm
export const PDF_A4_PORTRAIT = { width: 210, height: 297 };

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
export function pdfTextWidth(text, size, bold = false) {
  const table = bold ? PDF_HELV_BOLD : PDF_HELV;
  let units = 0;
  for (const ch of text) {
    const base = PDF_BASE_LETTER[ch] || ch;
    const c = base.charCodeAt(0);
    units += c >= 32 && c <= 126 ? table[c - 32] : ch === '…' ? 1000 : 556;
  }
  return units / 1000 * size / PDF_MM;
}

export function pdfHex(text) {
  return [...text].map(ch => pdfCode(ch).toString(16).padStart(2, '0')).join('');
}

export const pdfNum = v => (Math.round(v * 100) / 100).toString();

// A content stream drawn in mm from the top left of a page { width, height }.
export function pdfCanvas({ height }) {
  const ops = [];
  const X = x => pdfNum(x * PDF_MM), Y = y => pdfNum((height - y) * PDF_MM);
  return {
    ops,
    line(x1, y1, x2, y2, { width = 0.6, gray = 0, dash = null } = {}) {
      ops.push(`${pdfNum(width)} w ${pdfNum(gray)} G ${dash ? `[${dash.join(' ')}] 0 d` : '[] 0 d'} ${X(x1)} ${Y(y1)} m ${X(x2)} ${Y(y2)} l S`);
    },
    // an outlined rectangle (top left x, y; size w, h)
    rect(x, y, w, h, { width = 0.6, gray = 0, dash = null } = {}) {
      ops.push(`${pdfNum(width)} w ${pdfNum(gray)} G ${dash ? `[${dash.join(' ')}] 0 d` : '[] 0 d'} ${X(x)} ${Y(y + h)} ${pdfNum(w * PDF_MM)} ${pdfNum(h * PDF_MM)} re S`);
    },
    // a circle (centre cx, cy; radius r) as four Bezier curves; `solid`
    // fills it (a chosen option)
    circle(cx, cy, r, { width = 0.6, gray = 0, solid = false } = {}) {
      const k = r * 0.5523, p = (x, y) => `${X(x)} ${Y(y)}`;
      ops.push(`${pdfNum(width)} w ${pdfNum(gray)} G ${pdfNum(gray)} g [] 0 d ${p(cx + r, cy)} m `
        + `${p(cx + r, cy + k)} ${p(cx + k, cy + r)} ${p(cx, cy + r)} c `
        + `${p(cx - k, cy + r)} ${p(cx - r, cy + k)} ${p(cx - r, cy)} c `
        + `${p(cx - r, cy - k)} ${p(cx - k, cy - r)} ${p(cx, cy - r)} c `
        + `${p(cx + k, cy - r)} ${p(cx + r, cy - k)} ${p(cx + r, cy)} c ${solid ? 'B' : 'S'}`);
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

// -> the PDF file as bytes (Uint8Array): one page of `page` ({ width, height }
// in mm) with the content stream `content` (from pdfCanvas().ops.join('\n'))
// and `title` in the document info.
export function pdfDocument(page, content, title) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pdfNum(page.width * PDF_MM)} ${pdfNum(page.height * PDF_MM)}] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    `<< /Title <${pdfHex(title)}> /Producer (oe1ebg tools) >>`,
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

// UI: opens the PDF in a new tab (to print at its own size); downloads it as
// `filename` where the tab is blocked.
export function pdfOpen(bytes, filename) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  if (!window.open(url, '_blank')) {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.append(a);
    a.click();
    a.remove();
  }
  // the tab keeps it while open (a reload there needs the URL a while longer)
  setTimeout(() => URL.revokeObjectURL(url), 10 * 60000);
}
