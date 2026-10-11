import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRowCache, syncRows, resetRows } from '../tools/shared/js/rowcache.js';

// A minimal fake of the DOM calls syncRows uses.
class FakeNode {
  constructor(label) { this.label = label; this.parent = null; }
  get nextSibling() {
    const k = this.parent?.kids;
    return k ? k[k.indexOf(this) + 1] ?? null : null;
  }
}
class FakeParent {
  constructor() { this.kids = []; }
  get firstChild() { return this.kids[0] ?? null; }
  insertBefore(n, ref) {
    const i = this.kids.indexOf(n);
    if (i >= 0) this.kids.splice(i, 1);
    n.parent = this;
    const j = ref ? this.kids.indexOf(ref) : this.kids.length;
    this.kids.splice(j, 0, n);
  }
  removeChild(n) { this.kids.splice(this.kids.indexOf(n), 1); n.parent = null; }
}

const opts = built => ({
  key: i => i.id,
  sig: i => i.v,
  build: i => { built.push(i.id); return new FakeNode(`${i.id}:${i.v}`); },
});
const labels = p => p.kids.map(n => n.label);

test('first sync builds every row in order', () => {
  const p = new FakeParent(), c = createRowCache(), built = [];
  const r = syncRows(p, c, [{ id: 'a', v: 1 }, { id: 'b', v: 1 }], opts(built));
  assert.deepEqual(labels(p), ['a:1', 'b:1']);
  assert.deepEqual(r, { created: 2, reused: 0, removed: 0 });
});

test('unchanged rows are reused (same node), a changed one is rebuilt, a new one added', () => {
  const p = new FakeParent(), c = createRowCache(), built = [];
  syncRows(p, c, [{ id: 'a', v: 1 }, { id: 'b', v: 1 }], opts(built));
  const [na, nb] = p.kids;
  built.length = 0;
  const r = syncRows(p, c, [{ id: 'n', v: 1 }, { id: 'a', v: 1 }, { id: 'b', v: 2 }], opts(built));
  assert.deepEqual(built, ['n', 'b']);
  assert.equal(p.kids[1], na);
  assert.notEqual(p.kids[2], nb);
  assert.deepEqual(labels(p), ['n:1', 'a:1', 'b:2']);
  assert.equal(r.created, 2);
  assert.equal(r.reused, 1);
  assert.equal(nb.parent, null, 'the replaced node is gone from the parent');
});

test('rows that drop out (filter) are removed, a reorder moves nodes', () => {
  const p = new FakeParent(), c = createRowCache(), built = [];
  const items = ['a', 'b', 'c', 'd'].map(id => ({ id, v: 1 }));
  syncRows(p, c, items, opts(built));
  const nodes = [...p.kids];
  built.length = 0;
  syncRows(p, c, [items[3], items[1]], opts(built));
  assert.deepEqual(built, []);
  assert.deepEqual(p.kids, [nodes[3], nodes[1]]);
  // a filtered-out row that comes back is built again (the cache forgot it)
  syncRows(p, c, items, opts(built));
  assert.deepEqual(built, ['a', 'c']);
  assert.deepEqual(labels(p), ['a:1', 'b:1', 'c:1', 'd:1']);
});

test('foreign nodes (a placeholder row) are removed, resetRows forgets rows', () => {
  const p = new FakeParent(), c = createRowCache(), built = [];
  p.insertBefore(new FakeNode('empty'), null);
  syncRows(p, c, [{ id: 'a', v: 1 }], opts(built));
  assert.deepEqual(labels(p), ['a:1']);
  resetRows(c);
  syncRows(p, c, [{ id: 'a', v: 1 }], opts(built));
  assert.deepEqual(built, ['a', 'a']);
});

test('the result equals a full rebuild for random edits', () => {
  const p = new FakeParent(), c = createRowCache();
  let seed = 7;
  const rnd = n => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
  for (let step = 0; step < 200; step++) {
    const all = Array.from({ length: 30 }, (_, i) => ({ id: `m${i}`, v: rnd(3) }));
    const items = all.filter(() => rnd(3) > 0).sort(() => rnd(3) - 1);
    syncRows(p, c, items, opts([]));
    assert.deepEqual(labels(p), items.map(i => `${i.id}:${i.v}`));
  }
});
