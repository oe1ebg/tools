// The ADIF editor's compliance panel (tools/adif/js/compliance.js): the
// facts it derives from build-info.js, with and without a build.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adifSpecUrl, goModuleRev, complianceFacts } from '../tools/adif/js/compliance.js';
import { REPO_URL } from '../tools/shared/js/sources.js';

test('adifSpecUrl: the spec page of a version', () => {
  assert.equal(adifSpecUrl('3.1.7'), 'https://adif.org.uk/317/ADIF_317.htm');
  assert.match(adifSpecUrl(), /^https:\/\/adif\.org\.uk\/\d+\/ADIF_\d+\.htm$/);
});

test('goModuleRev: commit and date of a Go pseudo-version', () => {
  assert.deepEqual(goModuleRev('v0.0.0-20260914171904-aa2fd1bfbb3d'), { rev: 'aa2fd1bfbb3d', date: '2026-09-14' });
  assert.equal(goModuleRev('v0.1.22'), null);
  assert.equal(goModuleRev(undefined), null);
});

const FULL = 'abc1234' + '0'.repeat(33);

test('complianceFacts: a CI build links commit, checks, run and the commit\'s files', () => {
  const f = complianceFacts({
    commit: 'abc1234', version: '0123456789ab', run: 'https://github.com/oe1ebg/tools/actions/runs/42',
    adifmt: 'v0.1.22', adifChecker: 'v0.0.0-20260914171904-aa2fd1bfbb3d', commitFull: FULL,
  });
  assert.equal(f.commitUrl, `${REPO_URL}/commit/abc1234`);
  // the checks page needs the full SHA (/commit/<short>/checks is a 404)
  assert.equal(f.checksUrl, `${REPO_URL}/commit/${FULL}/checks`);
  assert.equal(f.runUrl, 'https://github.com/oe1ebg/tools/actions/runs/42');
  assert.equal(f.runId, '42');
  assert.equal(f.file('tests/adif-spec.mjs'), `${REPO_URL}/blob/abc1234/tests/adif-spec.mjs`);
  assert.equal(f.workflowUrl, `${REPO_URL}/actions/workflows/ci.yml`);
});

test('complianceFacts: local and dev builds have no run / no commit', () => {
  const local = complianceFacts({ commit: 'abc1234', version: 'x', run: null });
  assert.equal(local.runUrl, null);
  assert.equal(local.commit, 'abc1234');
  assert.equal(local.checksUrl, null, 'no full SHA: no checks link');
  for (const dev of [undefined, {}, { commit: 'dev' }]) {
    const f = complianceFacts(dev);
    assert.equal(f.commit, null);
    assert.equal(f.checksUrl, null);
    assert.equal(f.file('x'), `${REPO_URL}/blob/main/x`);
  }
});
