// Virtualized table body for the ADIF editor: only the rows in and around
// the visible part of the scroll container exist in the DOM (rows of a
// fixed height, a spacer row above and below for the rest), so a log of
// 50 000 QSOs × 190 fields stays as fast as one of 50. Generic: what a row
// looks like comes from the caller (renderRow), which rows exist from
// rowCount()/rowKey(pos).
//
// Rows are keyed by rowKey (the record index): a row that stays in the
// window is kept as is (with its focus), new ones are rendered as they
// scroll in. Before a row holding the focus is removed, beforeRemove(tr)
// runs (the editor commits the cell there, removal itself fires no blur).

export class VirtualBody {
  // scroller: the scrolling element; table: its <table> with a <thead>
  // and an empty <tbody>; columns: number of cells per row (for the
  // spacers' colspan).
  constructor(scroller, table, { columns, rowCount, rowKey, renderRow, beforeRemove }){
    this.scroller = scroller;
    this.table = table;
    this.thead = table.tHead;
    this.tbody = table.tBodies[0];
    this.rowCount = rowCount;
    this.rowKey = rowKey;
    this.renderRow = renderRow;
    this.beforeRemove = beforeRemove || (() => {});
    this.rowHeight = 0;        // measured from the first rendered row
    this.first = 0;            // window: display positions [first, last)
    this.last = 0;
    this.rows = new Map();     // key -> <tr> of the rows in the DOM
    this.frame = 0;
    this.top = this.spacer(columns);
    this.bottom = this.spacer(columns);
    this.tbody.replaceChildren(this.top, this.bottom);
    this.onScroll = () => {
      if (!this.frame) this.frame = requestAnimationFrame(() => { this.frame = 0; this.update(); });
    };
    scroller.addEventListener('scroll', this.onScroll, { passive: true });
    window.addEventListener('resize', this.onScroll);
  }

  spacer(columns){
    const tr = document.createElement('tr');
    tr.className = 'spacer';
    tr.setAttribute('aria-hidden', 'true');
    const td = document.createElement('td');
    td.colSpan = columns;
    tr.appendChild(td);
    return tr;
  }

  destroy(){
    this.scroller.removeEventListener('scroll', this.onScroll);
    window.removeEventListener('resize', this.onScroll);
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  // Where the body starts inside the scroller's content, and how much of
  // the viewport the sticky header covers.
  bodyTop(){ return this.table.offsetTop + this.thead.offsetHeight; }
  headHeight(){ return this.thead.offsetHeight; }

  // The <tr> of a key if it's rendered.
  row(key){ return this.rows.get(key) || null; }

  // Rendered rows, for updates in place (e.g. validation flags).
  forEachRow(fn){ for (const [key, tr] of this.rows) fn(tr, key); }

  // Re-render: force = the rows' content or order changed (all rows of the
  // window are rendered anew); otherwise only the window moves.
  update(force = false){
    const n = this.rowCount();
    const height = this.scroller.clientHeight || 600;
    const rh = this.rowHeight || 28;
    const y = Math.max(0, this.scroller.scrollTop - this.bodyTop());
    const over = Math.ceil(height / rh); // one screen above and below
    let first = Math.max(0, Math.floor(y / rh) - over);
    let last = Math.min(n, Math.ceil((y + height) / rh) + over);
    if (first > last) first = last;
    this.table.setAttribute('aria-rowcount', String(n + 1)); // + the header row
    if (!force && first === this.first && last === this.last && this.rows.size === last - first) return;
    this.first = first;
    this.last = last;

    const wanted = new Map();
    for (let pos = first; pos < last; pos++){
      const key = this.rowKey(pos);
      wanted.set(key, force ? null : this.rows.get(key) || null);
    }
    // remove what leaves the window (commit a focused cell first)
    const active = document.activeElement;
    for (const [key, tr] of this.rows){
      if (wanted.get(key) === tr) continue;
      if (active && tr.contains(active)) this.beforeRemove(tr);
      tr.remove();
    }
    this.rows = new Map();
    let cursor = this.top.nextSibling;
    for (let pos = first; pos < last; pos++){
      const key = this.rowKey(pos);
      let tr = wanted.get(key);
      if (!tr){
        tr = this.renderRow(key, pos);
        tr.setAttribute('aria-rowindex', String(pos + 2)); // 1 is the header row
      }
      this.rows.set(key, tr);
      if (tr === cursor) cursor = cursor.nextSibling;
      else this.tbody.insertBefore(tr, cursor);
    }
    if (!this.rowHeight && this.rows.size){
      const h = this.rows.values().next().value.getBoundingClientRect().height;
      if (h > 0){
        this.rowHeight = h;
        if (Math.abs(h - rh) > 0.5) return this.update(true);
      }
    }
    this.setSpacer(this.top, first * (this.rowHeight || rh));
    this.setSpacer(this.bottom, (n - last) * (this.rowHeight || rh));
  }

  setSpacer(tr, px){
    tr.hidden = px <= 0;
    tr.firstChild.style.height = `${px}px`;
  }

  // Scroll so that display position pos is fully visible below the sticky
  // header, render the window there, and return its row.
  reveal(pos){
    const rh = this.rowHeight || 28;
    const top = this.bodyTop() + pos * rh;
    const head = this.headHeight();
    const s = this.scroller;
    if (top - head < s.scrollTop) s.scrollTop = top - head;
    else if (top + rh > s.scrollTop + s.clientHeight) s.scrollTop = top + rh - s.clientHeight;
    this.update();
    return this.rows.get(this.rowKey(pos)) || null;
  }
}
