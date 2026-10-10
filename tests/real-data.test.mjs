// DATA_TESTS=require (tests/real-data.mjs): a data test without its data
// must fail in CI and the release builds, not skip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function skipOption(env, present) {
  const code = `import('./tests/real-data.mjs').then(m => console.log(JSON.stringify(m.skipWithout(${present}, 'build it first'))))`;
  const out = execFileSync(process.execPath, ['-e', code], {
    cwd: ROOT, env: { ...process.env, DATA_TESTS: env }, encoding: 'utf8',
  });
  return JSON.parse(out);
}

test('data tests skip without data, unless DATA_TESTS=require', () => {
  assert.equal(skipOption('', false), 'build it first');
  assert.equal(skipOption('', true), false);
  assert.equal(skipOption('require', false), false);
  assert.equal(skipOption('require', true), false);
  assert.equal(skipOption('yes', false), 'build it first', 'only "require" requires');
});

// A data test must run (and fail) without its data when required: run one
// against a data directory that doesn't exist.
test('DATA_TESTS=require turns a missing data file into a failure', () => {
  const code = `
    import { test } from 'node:test';
    import { readFileSync, existsSync } from 'node:fs';
    import { skipWithout } from './tests/real-data.mjs';
    const f = 'tests/no-such-data/x.json';
    test('needs data', { skip: skipWithout(existsSync(f), 'no data') }, () => readFileSync(f));`;
  const run = flag => {
    // a standalone run, not a subtest of this node --test process
    const env = { ...process.env, DATA_TESTS: flag };
    delete env.NODE_TEST_CONTEXT;
    try {
      execFileSync(process.execPath, ['--input-type=module', '-e', code], { cwd: ROOT, env, stdio: 'pipe' });
      return 0;
    } catch (e) {
      return e.status;
    }
  };
  assert.equal(run(''), 0, 'skips without the flag');
  assert.notEqual(run('require'), 0, 'fails with DATA_TESTS=require');
});
