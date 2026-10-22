// Annotated pictures for the manuals: a screenshot (or the render of a PDF)
// with outlined fields and labels with arrows in the margins.
//
//   annotate(context, png, { width, height }, notes, outPath, { legend })
//
// png: the picture; width/height: its size in CSS px (a picture made at a
// higher device scale is shown at this size). Every note is
// { box: { x, y, w, h }, text, side }: box is the field in the picture's CSS
// px, side 'left', 'right' or 'top' is the margin the label stands in (default:
// the nearer of left and right; 'top' for fields that share a row with
// others, so no arrow crosses a neighbour). The composition is made on a blank page, so the tools' CSP
// does not matter, and screenshotted at the scale of the picture.
//
// Colours: a note may have a `color` (use GROUP_COLORS) to show which fields
// belong together; they are the Okabe-Ito hues darkened to at least 4.5:1
// against white and differ in lightness as well as hue. The colour is never
// the only carrier: every label says what the field is, and `legend`
// ([{ color, text }]) names the groups under the picture.
const LABEL_W = 270;
const GAP = 40;
const COLOR = '#b0174f';
export const GROUP_COLORS = {
  blue: '#0b5cad',
  orange: '#a84300',
  green: '#1a6b2a',
  purple: '#7b3fa0',
  gray: '#595959',
};

export async function annotate(context, png, size, notes, outPath, { legend = [] } = {}) {
  const page = await context.newPage();
  try {
    const data = `data:image/png;base64,${Buffer.from(png).toString('base64')}`;
    await page.setViewportSize({ width: Math.ceil(size.width + 2 * (LABEL_W + GAP) + 40), height: Math.ceil(size.height + 260) });
    await page.setContent(`<!doctype html><meta charset="utf-8"><body style="margin:0;background:#fff;font:600 19px/1.25 -apple-system,'Segoe UI',Helvetica,Arial,sans-serif;color:#1a1a1a"><div id="wrap" style="position:relative;display:inline-block;padding:20px"></div>`);
    await page.evaluate(({ data, size, notes, legend, LABEL_W, GAP, COLOR }) => {
      const wrap = document.getElementById('wrap');
      const NS = 'http://www.w3.org/2000/svg';
      const left = LABEL_W + GAP;
      const oy = notes.some(n => n.side === 'top') ? 110 : 0;   // the band for labels above
      wrap.style.width = `${size.width + 2 * left}px`;
      const legendH = legend.length ? 56 : 0;
      wrap.style.height = `${size.height + oy + legendH}px`;
      const img = document.createElement('img');
      img.src = data;
      img.width = size.width;
      img.height = size.height;
      img.style.cssText = `position:absolute;left:${left + 20}px;top:${20 + oy}px;border:1px solid #bbb;box-sizing:content-box`;
      wrap.append(img);
      const svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('width', size.width + 2 * left);
      svg.setAttribute('height', size.height + oy);
      svg.style.cssText = 'position:absolute;left:20px;top:20px;overflow:visible';
      const colors = [...new Set(notes.map(n => n.color || COLOR))];
      svg.innerHTML = `<defs>${colors.map((c, i) => `<marker id="a${i}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10z" fill="${c}"/></marker>`).join('')}</defs>`;
      wrap.append(svg);
      const label = (n, x) => {
        const el = document.createElement('div');
        el.textContent = n.text;
        el.style.cssText = `position:absolute;width:${LABEL_W - 20}px;padding:6px 10px;background:#fff;border:4px solid ${n.color || COLOR};border-radius:6px;left:${x + 20}px`;
        wrap.append(el);
        n.el = el;
        n.h = el.offsetHeight;
      };
      const place = (side, items) => {
        items.sort((a, b) => (a.box.y + a.box.h / 2) - (b.box.y + b.box.h / 2));
        let bottom = -Infinity;
        for (const n of items) {
          label(n, side === 'left' ? 0 : left + size.width + GAP);
          n.cy = n.box.y + n.box.h / 2;
          n.top = Math.max(bottom + 10, n.cy - n.h / 2);
          bottom = n.top + n.h;
        }
        let limit = size.height;
        for (const n of items.slice().reverse()) {
          n.top = Math.min(n.top, limit - n.h);
          limit = n.top - 10;
          n.el.style.top = `${20 + oy + n.top}px`;
        }
      };
      const tops = notes.filter(n => n.side === 'top').sort((a, b) => a.box.x - b.box.x);
      let nextX = left;
      for (const n of tops) {
        const w = LABEL_W - 20 + 22;
        n.lx = Math.max(nextX, left + n.box.x + n.box.w / 2 - w / 2);
        label(n, n.lx);
        n.top = oy - 12 - n.h;
        n.el.style.top = `${20 + n.top}px`;
        nextX = n.lx + w + 10;
      }
      place('left', notes.filter(n => n.side === 'left'));
      place('right', notes.filter(n => n.side === 'right'));
      const line = (x1, y1, x2, y2, c) => {
        const l = document.createElementNS(NS, 'line');
        l.setAttribute('x1', x1); l.setAttribute('y1', y1); l.setAttribute('x2', x2); l.setAttribute('y2', y2);
        l.setAttribute('stroke', c); l.setAttribute('stroke-width', 3.5); l.setAttribute('marker-end', `url(#a${colors.indexOf(c)})`);
        svg.append(l);
      };
      for (const n of notes) {
        const bx = n.box.x + left, by = n.box.y + oy, bw = n.box.w, bh = n.box.h;
        const rect = document.createElementNS(NS, 'rect');
        rect.setAttribute('x', bx - 3); rect.setAttribute('y', by - 3);
        rect.setAttribute('width', bw + 6); rect.setAttribute('height', bh + 6);
        rect.setAttribute('rx', 5);
        rect.setAttribute('fill', 'none'); rect.setAttribute('stroke', n.color || COLOR); rect.setAttribute('stroke-width', 3.5);
        svg.append(rect);
        if (n.side === 'top') {
          const lcx = n.lx + (LABEL_W - 20 + 22) / 2;
          const tx = Math.min(Math.max(lcx, bx + 8), bx + bw - 8);
          line(lcx, n.top + n.h + 4, tx, by - 4, n.color || COLOR);
        } else {
          const isLeft = n.side === 'left';
          const y1 = oy + n.top + n.h / 2;
          line(isLeft ? LABEL_W : left + size.width + GAP, y1, isLeft ? bx - 4 : bx + bw + 4, Math.min(Math.max(y1, by + 3), by + bh - 3), n.color || COLOR);
        }
      }
      if (legend.length) {
        const row = document.createElement('div');
        row.style.cssText = `position:absolute;left:${20 + left}px;top:${20 + oy + size.height + 18}px;width:${size.width}px;display:flex;flex-wrap:wrap;gap:8px 22px;justify-content:center`;
        for (const l of legend) {
          const chip = document.createElement('div');
          chip.style.cssText = `display:flex;align-items:center;gap:8px;font-weight:600`;
          const sw = document.createElement('span');
          sw.style.cssText = `width:30px;height:18px;border:4px solid ${l.color};border-radius:4px;display:inline-block;box-sizing:border-box`;
          chip.append(sw, document.createTextNode(l.text));
          row.append(chip);
        }
        wrap.append(row);
      }
    }, { data, size, notes: notes.map(n => ({ ...n, side: n.side || (n.box.x + n.box.w / 2 < size.width / 2 ? 'left' : 'right') })), legend, LABEL_W, GAP, COLOR });
    await page.locator('img').evaluate(i => i.decode());
    await page.locator('#wrap').screenshot({ path: outPath });
  } finally {
    await page.close();
  }
  return outPath;
}
