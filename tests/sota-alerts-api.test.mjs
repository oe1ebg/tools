import { test } from 'node:test';
import assert from 'node:assert/strict';

const bounds = { getSouth: () => 48.2, getWest: () => 16.3, getNorth: () => 48.3, getEast: () => 16.4 };
let version = 0;
const api = () => import(`../tools/sota-alerts/js/api.js?test=${version++}`);

test('Overpass sends form data, no credentials and an origin-only Referer policy', async t => {
  const { searchOsmSummitsInView, OVERPASS_URL } = await api();
  const elements = [{ id: 1 }];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, OVERPASS_URL);
    const request = new Request(url, options);
    assert.equal(request.method, 'POST');
    assert.equal(request.credentials, 'omit');
    assert.equal(request.referrerPolicy, 'origin');
    assert.match(request.headers.get('Content-Type'), /^application\/x-www-form-urlencoded/);
    const query = new URLSearchParams(await request.text()).get('data');
    assert.equal(query, '[out:json][timeout:25];node["communication:amateur_radio:sota"](48.2,16.3,48.3,16.4);out body;');
    return Response.json({ elements });
  });
  assert.deepEqual(await searchOsmSummitsInView(bounds), elements);
});

test('Overpass rejects parallel searches and unlocks after a failure', async t => {
  const { searchOsmSummitsInView } = await api();
  let finish;
  const fetch = t.mock.method(globalThis, 'fetch', () => new Promise(resolve => { finish = resolve; }));
  const first = searchOsmSummitsInView(bounds);
  await assert.rejects(searchOsmSummitsInView(bounds), /already running/);
  assert.equal(fetch.mock.callCount(), 1);
  finish(new Response('', { status: 504 }));
  await assert.rejects(first, /busy or unavailable.*504/);
  fetch.mock.mockImplementation(async () => Response.json({ elements: [] }));
  assert.deepEqual(await searchOsmSummitsInView(bounds), []);
});

test('Overpass handles network/CORS failures, refusals and invalid responses without retrying', async t => {
  const { searchOsmSummitsInView } = await api();
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(searchOsmSummitsInView(bounds), /network, CORS or a server refusal.*Referer/);
  fetch.mock.mockImplementation(async () => new Response('', { status: 406 }));
  await assert.rejects(searchOsmSummitsInView(bounds), /refused.*406/);
  fetch.mock.mockImplementation(async () => new Response('<html>busy</html>'));
  await assert.rejects(searchOsmSummitsInView(bounds), /unexpected response/);
  assert.equal(fetch.mock.callCount(), 3);
});

test('Overpass waits at least 30 seconds after 429 and respects Retry-After', async t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  for (const [header, wait] of [[null, 30_000], ['1', 30_000], ['120', 120_000], [new Date(now + 60_000).toUTCString(), 60_000]]) {
    now = 1_000_000;
    const { searchOsmSummitsInView } = await api();
    const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('', {
      status: 429, headers: header ? { 'Retry-After': header } : {},
    }));
    await assert.rejects(searchOsmSummitsInView(bounds), /429/);
    now += wait - 1;
    await assert.rejects(searchOsmSummitsInView(bounds), /rate-limiting/);
    assert.equal(fetch.mock.callCount(), 1);
    now++;
    fetch.mock.mockImplementation(async () => Response.json({ elements: [] }));
    assert.deepEqual(await searchOsmSummitsInView(bounds), []);
    fetch.mock.restore();
  }
});

test('Overpass aborts a stalled request after 35 seconds and clears its timer', async t => {
  const { searchOsmSummitsInView } = await api();
  let expire;
  t.mock.method(globalThis, 'setTimeout', (fn, delay) => { assert.equal(delay, 35_000); expire = fn; return 123; });
  const cleared = t.mock.method(globalThis, 'clearTimeout', id => assert.equal(id, 123));
  t.mock.method(globalThis, 'fetch', async (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
  }));
  const pending = searchOsmSummitsInView(bounds);
  expire();
  await assert.rejects(pending, /timed out/);
  assert.equal(cleared.mock.callCount(), 1);
});
