// scripts/build_site.py: the footer of the overview page and the manuals
// (source repository, version, commit linked only for a real SHA).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_URL } from '../tools/shared/js/sources.js';
import { DATA_REQUIRED } from './real-data.mjs';

const OE1EBG = join(dirname(fileURLToPath(import.meta.url)), '..');

// footer(version, sha) via the project's Python (it needs python-markdown);
// null when neither uv nor a python3 with markdown is available.
function footer(version, sha) {
  const code = 'import sys, json; sys.path.insert(0, "scripts"); import build_site; '
    + 'print(build_site.footer(*json.loads(sys.argv[1])))';
  const args = ['-c', code, JSON.stringify([version, sha])];
  for (const [cmd, pre] of [['uv', ['run', 'python']], ['python3', []]]) {
    try {
      return execFileSync(cmd, [...pre, ...args], { cwd: OE1EBG, stdio: 'pipe', encoding: 'utf8' }).trim();
    } catch (e) {
      if (e.code !== 'ENOENT' && !/ModuleNotFoundError/.test(String(e.stderr))) throw e;
    }
  }
  return null;
}

test('overview and manuals link the repository, version and commit', t => {
  const f = footer('v1.2.3', 'abc1234');
  if (f === null) {
    assert.ok(!DATA_REQUIRED, 'DATA_TESTS=require, but no Python with python-markdown (uv sync)');
    return t.skip('no Python with python-markdown');
  }
  assert.match(f, /^<footer class="doc-footer">/);
  assert.ok(f.includes(`<a href="${REPO_URL}">github.com/oe1ebg/tools</a>`), f);
  assert.ok(f.includes('Version v1.2.3'), f);
  assert.ok(f.includes(`<a href="${REPO_URL}/commit/abc1234">abc1234</a>`), f);
  // a full SHA (CI, Justfile) links in full, shows short
  const full = 'abc1234' + '0'.repeat(33);
  assert.ok(footer('v1.2.3', full).includes(`<a href="${REPO_URL}/commit/${full}">abc1234</a>`));
  // dev builds and anything that isn't a SHA: no commit link, escaped
  const dev = footer('dev', 'dev');
  assert.ok(dev.includes('(commit dev)') && !dev.includes('/commit/'), dev);
  assert.ok(!footer('<x>', '<y>').includes('<y>'));
});

test('build_site renders the footer on every page', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(join(OE1EBG, 'scripts', 'build_site.py'), 'utf8');
  assert.match(src, /\{footer\}\n<\/main>/);
  assert.equal((src.match(/page\([^)]*, foot\)/g) || []).length, 2, 'overview and manuals');
});

// The development stub (`just dev-precache`) must never be staged: the
// bundle would ship tools that cannot work offline.
test('stage refuses a development precache.js stub', t => {
  const code = 'import sys, json, tempfile; from pathlib import Path; sys.path.insert(0, "scripts"); import build_site; '
    + 'd = Path(tempfile.mkdtemp()); '
    + '(d / "a").mkdir(); (d / "b").mkdir(); '
    + '(d / "a" / "precache.js").write_text("self.A_PRECACHE = { dev: true };\\n"); '
    + '(d / "b" / "precache.js").write_text("self.B_PRECACHE = {\\n  version: \\"1\\",\\n  files: [\\"./\\"],\\n};\\n"); '
    + 'print(json.dumps([p.parent.name for p in build_site.dev_stubs(d)]))';
  for (const [cmd, pre] of [['uv', ['run', 'python']], ['python3', []]]) {
    try {
      const out = execFileSync(cmd, [...pre, '-c', code], { cwd: OE1EBG, stdio: 'pipe', encoding: 'utf8' }).trim();
      assert.deepEqual(JSON.parse(out), ['a']);
      return;
    } catch (e) {
      if (e.code !== 'ENOENT' && !/ModuleNotFoundError/.test(String(e.stderr))) throw e;
    }
  }
  assert.ok(!DATA_REQUIRED, 'DATA_TESTS=require, but no Python with python-markdown (uv sync)');
  t.skip('no Python with python-markdown');
});
