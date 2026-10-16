// Keyed list rendering that patches rows in place: a row is created once
// per key and then only updated (update() changes what differs), so a
// focused field, its caret and the scroll position survive re-renders and
// autosaves. Rows move only when the order changed. DOM only through the
// node methods used here.

// parent: the list element. items: in display order. key(item) -> string.
// create(item) -> node. update(node, item): bring the node up to date.
export function keyedList(parent, items, { key, create, update }) {
  const old = new Map();
  for (const n of [...parent.children]) {
    if (n.dataset && n.dataset.key) old.set(n.dataset.key, n);
    else n.remove(); // placeholders (an empty-list note)
  }
  const nodes = [];
  for (const item of items) {
    const k = key(item);
    let n = old.get(k);
    if (n) old.delete(k);
    else {
      n = create(item);
      n.dataset.key = k;
    }
    update(n, item);
    nodes.push(n);
  }
  for (const n of old.values()) n.remove();
  // move only what is out of place; keep focus on a moved row
  const active = document.activeElement;
  let cur = parent.firstElementChild;
  for (const n of nodes) {
    if (cur === n) { cur = cur.nextElementSibling; continue; }
    const hadFocus = n.contains(active);
    const sel = hadFocus && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : null;
    parent.insertBefore(n, cur);
    if (hadFocus && document.activeElement !== active) {
      active.focus({ preventScroll: true });
      if (sel) try { active.setSelectionRange(sel[0], sel[1]); } catch { /* not a text field */ }
    }
  }
  return nodes;
}

// Set a text only when it differs (no needless mutation, no repeated
// screen-reader announcement).
export function setText(node, text) {
  const s = String(text ?? '');
  if (node.textContent !== s) node.textContent = s;
}

export function setAttr(node, name, value) {
  if (value === null || value === undefined || value === false) {
    if (node.hasAttribute(name)) node.removeAttribute(name);
  } else {
    const s = value === true ? '' : String(value);
    if (node.getAttribute(name) !== s) node.setAttribute(name, s);
  }
}

// A field's value, but not while the user is typing in it.
export function setValue(field, value) {
  const s = String(value ?? '');
  if (document.activeElement !== field && field.value !== s) field.value = s;
}
