// The manuals' screenshots are made by the build (tests/e2e/manual.shots.mjs,
// `just build` / `just screenshots`) and are not committed. What must hold:
// every image a manual uses is either made by the generator or one of the
// few committed static pictures (docs/static/); nothing is committed in
// docs/img/; the check that a release has them all (scripts/check_manual_images.py)
// works. No browser needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const read = p => readFileSync(join(ROOT, p), 'utf8');

// docs/*.md and the manuals' sub pages (docs/<manual>/*.md link ../img/…)
const used = new Set(readdirSync(join(ROOT, 'docs'), { recursive: true }).filter(n => n.endsWith('.md'))
  .flatMap(n => [...read(`docs/${n}`).matchAll(/\]\((?:\.\.\/)*img\/([A-Za-z0-9._-]+)\)/g)].map(m => m[1])));
const generated = new Set([...read('tests/e2e/manual.shots.mjs').matchAll(/'((?:confirm|notfunk)-[a-z0-9-]+)'/g)].map(m => `${m[1]}.png`));
const staticImgs = new Set(existsSync(join(ROOT, 'docs/static')) ? readdirSync(join(ROOT, 'docs/static')) : []);

test('every image the manuals use is made by the generator or committed in docs/static/', () => {
  assert.ok(used.size >= 15, 'the manuals have their screenshots');
  const unmade = [...used].filter(n => !generated.has(n) && !staticImgs.has(n));
  assert.deepEqual(unmade, [], 'add it to tests/e2e/manual.shots.mjs');
});

test('nothing is committed in docs/img/ (the pictures are build output, git-ignored in build/)', () => {
  let tracked;
  try {
    tracked = execFileSync('git', ['ls-files', 'docs/img'], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return;   // not a git checkout
  }
  assert.equal(tracked, '');
  assert.match(read('.gitignore'), /^build$/m);
});

test('the release check lists what is missing and passes when everything is there', () => {
  const dir = mkdtempSync(join(tmpdir(), 'manual-img-'));
  const run = () => spawnSync('python3', ['scripts/check_manual_images.py', dir], { cwd: ROOT, encoding: 'utf8' });
  const first = run();
  assert.equal(first.status, 1);
  for (const n of used) assert.ok(first.stderr.includes(n), n);
  for (const n of used) writeFileSync(join(dir, n), 'x');
  const ok = run();
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /all \d+ present/);
});

test('the Justfile makes the screenshots in the build and a release requires them', () => {
  const just = read('Justfile');
  assert.match(just, /^build:.* stage manual-images$/m);
  assert.match(just, /check_manual_images\.py site\/tools\/img/);
  assert.match(read('.github/workflows/release.yml'), /MANUAL_IMAGES: require/);
  assert.match(read('.github/workflows/ci.yml'), /MANUAL_IMAGES: never/);
});
