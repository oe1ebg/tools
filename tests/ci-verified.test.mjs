// CI's verified-tree markers (scripts/ci_verified.py, .github/workflows/ci.yml):
// a run that passed with all five browser projects leaves a marker named
// after its git tree and scope; a later run of the same content skips the
// checks only when a marker of this repository's ci.yml covers its scope.
// Stdlib Python; the tests skip without python3.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SKIP = spawnSync('python3', ['--version'], { stdio: 'ignore' }).status === 0 ? false : 'needs python3';
const py = code => JSON.parse(execFileSync('python3', ['-c', `import sys, json; sys.path.insert(0, "scripts"); import ci_verified as v; print(json.dumps(${code}))`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));

const TREE = 'a'.repeat(40);
const REPO = 1411463818, FORK = 99;
const artifact = (name, over = {}) => ({ name, expired: false, workflow_run: { id: 7, repository_id: REPO, head_repository_id: REPO }, ...over });
const run = (over = {}) => ({ id: 7, path: '.github/workflows/ci.yml', conclusion: 'success', head_repository: { id: REPO }, html_url: 'https://github.com/oe1ebg/tools/actions/runs/7', ...over });

// find() with the API answers given: { name: [artifacts] }, { id: run }
function find(names, artifacts, runs) {
  const j = x => `json.loads(${JSON.stringify(JSON.stringify(x))})`;
  return py(`v.find(${j(names)}, lambda n: ${j(artifacts)}.get(n, []), lambda i: ${j(runs)}.get(str(i)), ${REPO})`);
}

test('marker names: the tree and the scope; only tree ids', { skip: SKIP }, () => {
  assert.equal(py(`v.marker_name("${TREE}", True, False)`), `ci-verified-${TREE}-a1s0`);
  assert.equal(py(`v.marker_name("${'b'.repeat(64)}", False, True)`), `ci-verified-${'b'.repeat(64)}-a0s1`);
  for (const bad of ['', 'abc', 'A'.repeat(40), `${TREE}/x`, 'g'.repeat(40)]) {
    assert.throws(() => py(`v.marker_name(${JSON.stringify(bad)}, True, True)`), e => /not a tree id/.test(e.stderr), `rejects ${JSON.stringify(bad)}`);
  }
  const out = execFileSync('python3', ['scripts/ci_verified.py', 'name', '--tree', TREE, '--adif', 'false', '--site', 'true'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(out.trim(), `ci-verified-${TREE}-a0s1`);
});

test('a marker counts when its scope covers the one needed, exact scope first', { skip: SKIP }, () => {
  const names = (a, s) => py(`v.covering_names("${TREE}", ${a ? 'True' : 'False'}, ${s ? 'True' : 'False'})`).map(n => n.slice(-4));
  assert.deepEqual(names(true, true), ['a1s1']);
  assert.deepEqual(names(true, false), ['a1s0', 'a1s1']);
  assert.deepEqual(names(false, true), ['a0s1', 'a1s1']);
  assert.deepEqual(names(false, false), ['a0s0', 'a0s1', 'a1s0', 'a1s1']);
});

test('only an unexpired marker of this repository\'s successful ci.yml run is accepted', { skip: SKIP }, () => {
  const name = `ci-verified-${TREE}-a1s1`;
  const ok = find([name], { [name]: [artifact(name)] }, { 7: run() });
  assert.equal(ok.html_url, 'https://github.com/oe1ebg/tools/actions/runs/7');
  const rejected = {
    expired: [{ [name]: [artifact(name, { expired: true })] }, { 7: run() }],
    'fork head': [{ [name]: [artifact(name, { workflow_run: { id: 7, repository_id: REPO, head_repository_id: FORK } })] }, { 7: run() }],
    'fork run': [{ [name]: [artifact(name)] }, { 7: run({ head_repository: { id: FORK } }) }],
    'other repository': [{ [name]: [artifact(name, { workflow_run: { id: 7, repository_id: FORK, head_repository_id: FORK } })] }, { 7: run() }],
    'other workflow': [{ [name]: [artifact(name)] }, { 7: run({ path: '.github/workflows/pages.yml' }) }],
    failed: [{ [name]: [artifact(name)] }, { 7: run({ conclusion: 'failure' }) }],
    'still running': [{ [name]: [artifact(name)] }, { 7: run({ conclusion: null }) }],
    'run gone': [{ [name]: [artifact(name)] }, {}],
    'other run id': [{ [name]: [artifact(name)] }, { 7: run({ id: 8 }) }],
    'other name': [{ [name]: [artifact(`${name}x`)] }, { 7: run() }],
    none: [{}, { 7: run() }],
  };
  for (const [why, [artifacts, runs]] of Object.entries(rejected)) assert.equal(find([name], artifacts, runs), null, why);
  // a later good marker of the same name still counts
  const second = artifact(name, { workflow_run: { id: 9, repository_id: REPO, head_repository_id: REPO } });
  assert.equal(find([name], { [name]: [artifact(name, { expired: true }), second] }, { 9: run({ id: 9, html_url: 'u9' }) }).html_url, 'u9');
});

test('lookup: any API failure means "not verified", written to GITHUB_OUTPUT', { skip: SKIP }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'oe1ebg-ci-'));
  const out = join(dir, 'out');
  writeFileSync(out, '');
  // no `gh` on PATH: the lookup fails, the run checks everything
  const python = execFileSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim();
  const r = spawnSync(python, ['scripts/ci_verified.py', 'lookup', '--tree', TREE, '--adif', 'true', '--site', 'true', '--repo', 'oe1ebg/tools'],
    { cwd: ROOT, encoding: 'utf8', env: { PATH: '/nonexistent', GITHUB_OUTPUT: out } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /::warning::verified-tree lookup failed/);
  assert.equal(readFileSync(out, 'utf8'), 'verified=false\nrun-url=\n');
});

test('ci.yml: the checks skip only for a verified tree; the marker needs every check passed', () => {
  const ci = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
  const job = name => ci.slice(ci.indexOf(`\n  ${name}:\n`) + 1).split(/\n  [a-z-]+:\n/)[0];
  for (const name of ['test', 'bundle', 'validate']) assert.match(job(name), /if: .*needs\.changes\.outputs\.verified != 'true'/, name);
  const marker = job('verified');
  assert.match(marker, /needs: \[changes, test, bundle, validate\]/);
  assert.match(marker, /needs\.changes\.outputs\.record == 'true'/);
  assert.match(marker, /needs\.test\.result == 'success'/);
  assert.match(marker, /needs\.bundle\.result == 'success' && needs\.validate\.result == 'success'/);
  assert.match(marker, /retention-days: 30/);
  const changes = job('changes');
  assert.match(changes, /actions: read/);
  // never recorded by a push to main (Chromium only) or a fork's PR
  assert.match(changes, /record: .*!\(github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'\).*fork != true/);
  // scheduled, manual and tag runs never skip
  assert.match(changes, /name: Already verified\?\n\s+id: verified\n\s+if: steps\.scope\.outputs\.all != 'true'/);
});
