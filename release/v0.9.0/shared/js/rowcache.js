// Keyed row reuse for large tables (issue #15): a re-render creates only the
// rows whose signature changed, reuses the others as they are (so focus and
// transient classes survive) and moves/removes the DOM nodes that differ.
// Plain DOM calls (firstChild, nextSibling, insertBefore, removeChild), no
// dependencies, so it runs against a small fake in the node tests.

// A cache: key -> { sig, node, ... }. One per table.
export function createRowCache() {
  return new Map();
}

// Brings `parent`'s children in line with `items` (in order).
//   cache  createRowCache(); replaced content, mutated in place
//   key    item -> string, unique within the list
//   sig    item -> string; equal key and sig = the old node is still right
//   build  item -> node (only called for new or changed items)
// Returns { created, reused, removed }.
export function syncRows(parent, cache, items, { key, sig, build }) {
  const next = new Map();
  const nodes = [];
  let created = 0;
  for (const item of items) {
    const k = key(item);
    const s = sig(item);
    const hit = cache.get(k);
    let entry;
    if (hit && hit.sig === s && !next.has(k)) {
      entry = hit;
    } else {
      const node = build(item);
      entry = { sig: s, node };
      created++;
    }
    next.set(k, entry);
    nodes.push(entry.node);
  }
  let cur = parent.firstChild;
  for (const node of nodes) {
    if (cur === node) cur = cur.nextSibling;
    else parent.insertBefore(node, cur);
  }
  let removed = 0;
  while (cur) {
    const after = cur.nextSibling;
    parent.removeChild(cur);
    removed++;
    cur = after;
  }
  cache.clear();
  for (const [k, v] of next) cache.set(k, v);
  return { created, reused: nodes.length - created, removed };
}

// Forget everything (the table was emptied or replaced by other content).
export function resetRows(cache) {
  cache.clear();
}
