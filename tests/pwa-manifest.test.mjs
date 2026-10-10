// The apps have no manifest `id`, so their identity is the resolved
// start_url (#28, tools/confirm/README.md "App identity"). Changing start_url
// silently changes the identity of every installed app, and an `id` would
// have to hard-code the URL prefix. The resolved identities are checked in
// the browser by tests/e2e/pwa-identity.spec.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

for (const tool of ['confirm', 'notfunk']) {
  test(`${tool} manifest: start_url "./", scope "./", no id`, () => {
    const m = JSON.parse(readFileSync(new URL(`../tools/${tool}/manifest.webmanifest`, import.meta.url), 'utf8'));
    assert.equal(m.start_url, './');
    assert.equal(m.scope, './');
    assert.ok(!('id' in m), 'an id would hard-code the prefix or collide');
  });
}
