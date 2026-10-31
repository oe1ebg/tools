// The slides of the Notfunk introduction are committed exports (docs/static/notfunk-einfuehrung/),
// staged to downloads/ by scripts/build_site.py and linked from the manual's
// start page. They must be real files of their format and stay linked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const bytes = name => readFileSync(new URL(`docs/static/notfunk-einfuehrung/${name}`, root));
const text = path => readFileSync(new URL(path, root), 'utf8');

const SLIDES = [
  ['notfunk-einfuehrung.pdf', b => b.subarray(0, 5).toString() === '%PDF-'],
  ['notfunk-einfuehrung.pptx', b => b.subarray(0, 2).toString() === 'PK'],
  ['notfunk-einfuehrung-basic.pptx', b => b.subarray(0, 2).toString() === 'PK'],
  ['notfunk-einfuehrung.html', b => /^\s*<!doctype html/i.test(b.toString('utf8', 0, 200))],
];

test('slides: committed exports are real files of their format', () => {
  for (const [name, isFormat] of SLIDES) {
    const b = bytes(name);
    assert.ok(b.length > 10000, `${name} is not empty`);
    assert.ok(isFormat(b), `${name} has the signature of its format`);
  }
});

// The PowerPoint files are shipped for downloading by their direct URL
// (downloads/notfunk-einfuehrung/), not linked from the start page.
test('slides: the start page links PDF and HTML, not the PowerPoint files; build stages them all', () => {
  const index = text('docs/notfunk-anleitung/index.de.md');
  for (const [name] of SLIDES) {
    const linked = index.includes(`](../downloads/notfunk-einfuehrung/${name})`);
    assert.equal(linked, !name.endsWith('.pptx'), `${name}: ${linked ? 'is linked' : 'is not linked'} from the start page`);
  }
  assert.ok(text('scripts/build_site.py').includes('shutil.copytree(slides, OUT_DIR / "downloads" / slides.name)'), 'build_site.py stages the directory');
});
