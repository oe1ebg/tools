// The JUnit reporter for CI (tests/junit-reporter.mjs), run on
// tests/fixtures/junit/sample.mjs in a child `node --test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OE1EBG = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(mkdtempSync(join(tmpdir(), 'junit-')), 'sample.xml');
// Without NODE_TEST_CONTEXT, which would make the child report to this run.
const { NODE_TEST_CONTEXT, ...env } = process.env;
const run = spawnSync(process.execPath, ['--test', '--test-reporter=./tests/junit-reporter.mjs',
  `--test-reporter-destination=${out}`, 'tests/fixtures/junit/sample.mjs'], { cwd: OE1EBG, encoding: 'utf8', env });
const xml = readFileSync(out, 'utf8');
const cases = [...xml.matchAll(/<testcase name="([^"]*)"[^>]*?(\/>|>([\s\S]*?)<\/testcase>)/g)]
  .map(m => ({ name: m[1], body: m[3] ?? '' }));
const byName = Object.fromEntries(cases.map(c => [c.name, c.body]));

test('the run fails like the sample does', () => {
  assert.equal(run.status, 1, run.stderr);
});

test('one testsuite per test file, with the counts', () => {
  const suites = [...xml.matchAll(/<testsuite [^>]*>/g)].map(m => m[0]);
  assert.equal(suites.length, 1);
  assert.match(suites[0], /name="tests\/fixtures\/junit\/sample\.mjs"/);
  assert.match(suites[0], /tests="8" failures="2" errors="0" skipped="2"/);
});

test('nested tests are flattened as "parent › child", parents without own failure left out', () => {
  assert.deepEqual(cases.map(c => c.name), [
    'passes', 'fails with &lt;markup&gt; &amp; &quot;quotes&quot;', 'skips', 'todo',
    'parent › child passes', 'parent › child fails', 'suite › inner', 'diagnostic',
  ]);
});

test('failures, skips and diagnostics', () => {
  assert.match(byName['fails with &lt;markup&gt; &amp; &quot;quotes&quot;'], /<failure message="one is not &lt;two&gt;" type="AssertionError">/);
  assert.match(byName['parent › child fails'], /<failure message="child broke" type="TypeError">/);
  assert.match(byName.skips, /<skipped message="tool not found"\/>/);
  assert.match(byName.todo, /<skipped message="todo"\/>/);
  assert.equal(byName.passes, '');
  assert.match(xml, /<system-out>tool v1\.2\.3<\/system-out>/);
});
