// The Wavelog import (issue #82): API client with a stubbed fetch, the QSO
// mapping and per-callsign summary, and the store's v2 migration. Synthetic
// callsigns only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  wavelogBase, wavelogGet, wavelogLogbooks, wavelogQsos, wavelogTokenScopes, WavelogError, WAVELOG_MAX_PAGES,
} from '../tools/wavelog-import/js/wavelog.js';
import { callsignQsoFromWavelog, summarizeCallsignQsos } from '../tools/shared/js/callsign-qsos.js';
import { memoryStore } from '../tools/netlog/js/memstore.js';
import { buildCallsignDirectory } from '../tools/shared/js/callsign-merge.js';
import {
  CALLSIGN_STORES, CALLSIGN_SCHEMA, ensureBuiltinSource, loadCallsignStore, upsertCallsignQsos, loadCallsignQsos,
  writeCallsignSummary, eraseCallsignSource,
} from '../tools/shared/js/callsign-store.js';

const res = (status, body, headers = {}) => ({ ok: status < 300, status, headers: { get: k => headers[k] ?? null }, json: async () => { if (body === undefined) throw new Error('x'); return body; } });
const noSleep = () => Promise.resolve();

test('wavelogBase: https, localhost http, no credentials, strips /api[/v2], trailing slash', () => {
  assert.equal(wavelogBase('https://wl.example.org'), 'https://wl.example.org/');
  assert.equal(wavelogBase(' https://wl.example.org/wavelog/api/v2 '), 'https://wl.example.org/wavelog/');
  assert.equal(wavelogBase('https://wl.example.org/?x=1#y'), 'https://wl.example.org/');
  assert.equal(wavelogBase('http://localhost:8080/'), 'http://localhost:8080/');
  for (const bad of ['', 'wl.example.org', 'http://wl.example.org/', 'https://u:p@wl.example.org/', 'ftp://x.org/']) assert.equal(wavelogBase(bad), '', bad);
});

test('request: bearer token, no cookies/referrer, query built, JSON returned', async () => {
  let seen;
  const fetchFn = async (url, init) => { seen = { url, init }; return res(200, { data: [] }); };
  await wavelogGet('https://wl.example.org/', 'qso', { token: 'wl2_abc', params: { station_id: '1,4', page: 2, skip: undefined }, fetchFn });
  assert.equal(seen.url, 'https://wl.example.org/api/v2/qso?station_id=1%2C4&page=2');
  assert.equal(seen.init.headers.Authorization, 'Bearer wl2_abc');
  assert.equal(seen.init.credentials, 'omit');
  assert.equal(seen.init.referrerPolicy, 'no-referrer');
  assert.equal(seen.init.method, 'GET');
});

test('errors: API code and scope, HTTP status, network, timeout, abort, not JSON', async () => {
  const base = 'https://wl.example.org/';
  const code = async fetchFn => wavelogGet(base, 'x', { token: 't', fetchFn, sleep: noSleep, timeoutMs: 20 }).then(() => null, e => e);
  const e1 = await code(async () => res(403, { error: { code: 'insufficient_scope', details: { required_scope: 'qso:read' } } }));
  assert.ok(e1 instanceof WavelogError); assert.equal(e1.code, 'insufficient_scope'); assert.equal(e1.required, 'qso:read'); assert.equal(e1.status, 403);
  assert.equal((await code(async () => res(401, undefined))).code, 'http-401');
  assert.equal((await code(async () => { throw new TypeError('Failed to fetch'); })).code, 'network');
  assert.equal((await code(async () => res(200, undefined))).code, 'bad-response');
  assert.equal((await code((_u, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted')))))).code, 'timeout');
  const ctl = new AbortController();
  const p = wavelogGet(base, 'x', { token: 't', signal: ctl.signal, timeoutMs: 1000, fetchFn: (_u, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted')))) });
  ctl.abort();
  assert.equal((await p.then(() => null, e => e)).code, 'aborted');
});

test('429: waits Retry-After (capped), then succeeds; gives up after three retries', async () => {
  const waits = [];
  let n = 0;
  const ok = await wavelogGet('https://wl.example.org/', 'x', {
    token: 't', sleep: ms => { waits.push(ms); return Promise.resolve(); },
    fetchFn: async () => (++n < 3 ? res(429, { error: { code: 'rate_limited' } }, { 'Retry-After': n === 1 ? '2' : '999' }) : res(200, { data: 1 })),
  });
  assert.deepEqual(ok, { data: 1 });
  assert.deepEqual(waits, [2000, 60000]);
  n = 0;
  const err = await wavelogGet('https://wl.example.org/', 'x', { token: 't', sleep: noSleep, fetchFn: async () => { n++; return res(429, { error: { code: 'rate_limited' } }); } }).then(() => null, e => e);
  assert.equal(err.code, 'rate_limited');
  assert.equal(n, 4);
});

test('logbooks and token scopes', async () => {
  const fetchFn = async url => (url.includes('/logbook')
    ? res(200, { data: [{ id: 1, name: 'Home', station_ids: [1] }, { id: 3, name: 'Contest', station_ids: [1, 4] }, { name: 'no id' }] })
    : res(200, { data: { scopes: ['qso:read', 'logbook:read'] } }));
  assert.deepEqual(await wavelogLogbooks('https://wl.example.org/', { token: 't', fetchFn }), [
    { id: 1, name: 'Home', stationIds: [1] }, { id: 3, name: 'Contest', stationIds: [1, 4] },
  ]);
  assert.deepEqual(await wavelogTokenScopes('https://wl.example.org/', { token: 't', fetchFn }), ['qso:read', 'logbook:read']);
  assert.equal(await wavelogTokenScopes('https://wl.example.org/', { token: 't', fetchFn: async () => res(404, {}) }), null);
  await assert.rejects(wavelogLogbooks('https://wl.example.org/', { token: 't', fetchFn: async () => res(200, { data: {} }) }), { code: 'bad-response' });
});

test('qsos: pages until has_more is false, stations joined, per_page clamped', async () => {
  const urls = [];
  const fetchFn = async url => {
    urls.push(url);
    const page = Number(new URL(url).searchParams.get('page'));
    return res(200, { data: [{ id: page * 10 }, { id: page * 10 + 1 }], meta: { page, total: 5, has_more: page < 3 } });
  };
  const got = [];
  const n = await wavelogQsos('https://wl.example.org/', [1, 4], { token: 't', fetchFn, perPage: 99999, onPage: (q, m) => got.push([q.length, m.page, m.total]) });
  assert.equal(n, 6);
  assert.deepEqual(got, [[2, 1, 5], [2, 2, 5], [2, 3, 5]]);
  const u = new URL(urls[0]);
  assert.equal(u.searchParams.get('station_id'), '1,4');
  assert.equal(u.searchParams.get('per_page'), '5000');
  assert.equal(await wavelogQsos('https://wl.example.org/', [1], { token: 't', fetchFn: async () => res(200, { data: [], meta: { has_more: true } }) }), 0);   // no endless loop on empty pages
  await assert.rejects(wavelogQsos('https://wl.example.org/', [1], { token: 't', fetchFn: async () => res(200, { data: [{ id: 1 }], meta: { has_more: true } }) }), { code: 'too-many-pages' });
  assert.ok(WAVELOG_MAX_PAGES >= 1000);
});

test('QSO mapping: id, call, date/time, submode wins, grid upper case, unusable ones refused', () => {
  const q = callsignQsoFromWavelog({ id: 7, call: 'oe0qxa/p', qso_date: '2026-06-16 17:06:00', band: '20m', mode: 'SSB', submode: 'USB', name: ' Anna ', qth: 'Graz', gridsquare: 'jn77ab' }, 'wavelog:x:1');
  assert.deepEqual(q, { id: 'wavelog:x:1:7', eventId: 'wavelog:x:1', source: 'wavelog:x:1', wlId: 7, call: 'OE0QXA/P', base: 'OE0QXA', date: '2026-06-16', time: '17:06:00', band: '20m', mode: 'USB', name: 'Anna', qth: 'Graz', grid: 'JN77AB' });
  assert.equal(callsignQsoFromWavelog({ call: 'OE0QXA' }, 's'), null);
  assert.equal(callsignQsoFromWavelog({ id: 1, call: '' }, 's'), null);
  assert.equal(callsignQsoFromWavelog({ id: 1, call: 'OE0QXA', qso_date: 'garbage' }, 's').date, '');
});

test('summary: count, last date, latest non-empty name/QTH/grid', () => {
  const mk = (id, call, d, extra = {}) => callsignQsoFromWavelog({ id, call, qso_date: `${d} 12:00:00`, ...extra }, 's');
  const rows = summarizeCallsignQsos([
    mk(1, 'OE0QXA', '2026-01-01', { name: 'Anna Alt', qth: 'Wien' }),
    mk(2, 'OE0QXA/P', '2026-03-01', { name: 'Anna', gridsquare: 'JN88' }),
    mk(3, 'OE0QXA', '2026-02-01'),
    mk(4, 'OE0QXB', '2025-05-05'),
  ]);
  assert.deepEqual(rows, [
    { call: 'OE0QXA', base: 'OE0QXA', name: 'Anna', qth: 'Wien', grid: 'JN88', note: '3 QSO, 2026-03-01' },
    { call: 'OE0QXB', base: 'OE0QXB', name: '', qth: '', grid: '', note: '1 QSO, 2025-05-05' },
  ]);
});

test('schema v2: migration from v1 only adds qsos; stable name', () => {
  assert.equal(CALLSIGN_SCHEMA.name, 'oe1ebg-callsigns');
  assert.equal(CALLSIGN_SCHEMA.version, 2);
  const fromV1 = []; CALLSIGN_SCHEMA.upgrade(1, n => fromV1.push(n));
  assert.deepEqual(fromV1, ['qsos']);
  const fresh = []; CALLSIGN_SCHEMA.upgrade(0, n => fresh.push(n));
  assert.deepEqual(fresh.sort(), Object.keys(CALLSIGN_STORES).sort());
});

test('store: re-import upserts by Wavelog id, summary is a source of its own, erase removes QSOs too', async () => {
  const store = memoryStore(CALLSIGN_STORES);
  await ensureBuiltinSource(store, 'Austria');
  const sid = 'wavelog:wl.example.org:1';
  const mk = (id, call, d, extra = {}) => callsignQsoFromWavelog({ id, call, qso_date: `${d} 12:00:00`, ...extra }, sid);
  await upsertCallsignQsos(store, [mk(1, 'OE0QXA', '2026-01-01', { name: 'Anna' }), mk(2, 'OE0QXB', '2026-01-02')]);
  await writeCallsignSummary(store, { sourceId: sid, name: 'Home', rows: summarizeCallsignQsos(await loadCallsignQsos(store, sid)) });
  await upsertCallsignQsos(store, [mk(1, 'OE0QXA', '2026-01-01', { name: 'Anna Neu' }), mk(3, 'OE0QXA', '2026-02-02')]);
  assert.equal((await loadCallsignQsos(store, sid)).length, 3);          // 1 replaced, not duplicated
  const src = await writeCallsignSummary(store, { sourceId: sid, name: 'Home', rows: summarizeCallsignQsos(await loadCallsignQsos(store, sid)) });
  assert.equal(src.gen, 2);
  assert.equal((await store.getAll('sources')).filter(s => s.kind === 'wavelog').length, 1);
  const dir = buildCallsignDirectory({ ...(await loadCallsignStore(store)), callbook: null });
  const hit = dir.lookup('OE0QXA');
  assert.equal(hit.name, 'Anna Neu');
  assert.deepEqual(hit.notes.map(n => n.text), ['2 QSO, 2026-02-02']);
  await eraseCallsignSource(store, sid);
  assert.equal((await store.getAll('qsos')).length, 0);
  assert.equal((await store.getAll('records')).length, 0);
});
