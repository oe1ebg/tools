// Return navigation: before a jump (a station link in My Turn, a search
// result, m from Live Notes, …) the origin is pushed: session, workspace,
// selected station, summary round, scroll and the focused item. Back (b or
// the visible button) restores exactly that; data edits made meanwhile
// stay. When the focused item is gone (deleted meanwhile), focus goes to
// the nearest surviving item of its list, else the section heading.

const MAX = 40;

// What the focused element is, independent of the DOM nodes (they may be
// re-created): the nearest element with an id, the keyed row (data-key)
// and the field class inside it.
export function describeFocus(node) {
  if (!node || node === document.body || !node.closest) return null;
  const row = node.closest('[data-key]');
  const list = row ? row.parentElement : null;
  const anchor = node.closest('[id]');
  return {
    id: node.id || null,
    anchor: anchor ? anchor.id : null,
    list: list && list.id ? list.id : null,
    key: row ? row.dataset.key : null,
    index: row && list ? [...list.children].indexOf(row) : -1,
    cls: node.classList && node.classList.length ? node.classList[0] : null,
    tag: node.tagName,
    sel: 'selectionStart' in node && typeof node.selectionStart === 'number' ? [node.selectionStart, node.selectionEnd] : null,
  };
}

export function findFocus(d, root = document) {
  if (!d) return null;
  if (d.id) { const n = root.getElementById ? root.getElementById(d.id) : document.getElementById(d.id); if (n) return n; }
  const list = d.list ? document.getElementById(d.list) : null;
  const scope = list || (d.anchor ? document.getElementById(d.anchor) : null);
  if (scope && d.key) {
    const row = [...scope.querySelectorAll('[data-key]')].find(r => r.dataset.key === d.key);
    if (row) {
      const inner = d.cls ? [...row.querySelectorAll(d.tag || '*')].find(n => n.classList.contains(d.cls)) : null;
      return inner || row;
    }
    // gone: the nearest surviving row of the same list
    if (list && list.children.length) {
      const rows = [...list.children].filter(r => r.dataset && r.dataset.key);
      if (rows.length) return rows[Math.min(Math.max(d.index, 0), rows.length - 1)];
    }
  }
  return scope || null;
}

export function createNav(app) {
  const stack = [];
  const capture = () => ({
    sessionId: app.sessionId(),
    view: app.ui.view,
    selected: app.ui.selected,
    summary: app.ui.summary,
    roundOpen: { ...app.ui.roundOpen },
    scrollY: globalThis.scrollY,
    viewScroll: (document.getElementById(`view-${app.ui.view}`) || {}).scrollTop || 0,
    focus: describeFocus(document.activeElement),
  });
  return {
    push() {
      stack.push(capture());
      if (stack.length > MAX) stack.shift();
    },
    canBack: () => stack.length > 0,
    peek: () => stack[stack.length - 1] || null,
    async back() {
      const o = stack.pop();
      if (!o) return false;
      await app.flush();
      if (o.sessionId !== app.sessionId()) await app.openSessionNow(o.sessionId, o.view);
      app.ui.view = o.view;
      if (o.selected && app.participant(o.selected)) app.ui.selected = o.selected;
      app.ui.summary = o.summary;
      // rounds expanded to show a source stay as the user had them
      app.ui.roundOpen = o.roundOpen;
      app.syncHash();
      app.render();
      const v = document.getElementById(`view-${o.view}`);
      if (v) v.scrollTop = o.viewScroll;
      globalThis.scrollTo(0, o.scrollY);
      const n = findFocus(o.focus) || (v && v.querySelector('h2, h3'));
      if (n) {
        if (n.tabIndex < 0 && !n.hasAttribute('tabindex')) n.setAttribute('tabindex', '-1');
        n.focus({ preventScroll: true });
        if (o.focus && o.focus.sel && n === document.activeElement && 'setSelectionRange' in n) {
          try { n.setSelectionRange(o.focus.sel[0], o.focus.sel[1]); } catch { /* not a text field */ }
        }
      }
      return true;
    },
  };
}
