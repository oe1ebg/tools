// Netlog's user-opened station lookup links (tools/netlog/js/links.js):
// verified URL forms, encoded callsigns, no lookup of an unresolved
// callsign, a Wavelog base address only (http/https, no credentials).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stationLinks, wavelogUrl } from '../tools/netlog/js/links.js';

test('lookup links for the base callsign, encoded', () => {
  assert.deepEqual(stationLinks('OE/OE0QXB/P', '').map(l => l.href), [
    'https://www.qrz.com/db/OE0QXB',
    'https://www.hamqth.com/OE0QXB',
    'https://www.qrzcq.com/call/OE0QXB',
    'https://aprs.fi/info/a/OE0QXB',
  ]);
  assert.equal(stationLinks('OE0QXB', 'https://log.example.org/').at(-1).href, 'https://log.example.org/');
});

test('no lookup of an unresolved callsign', () => {
  assert.deepEqual(stationLinks('OE0QX?', ''), []);
  assert.deepEqual(stationLinks('?', 'https://log.example.org/').map(l => l.label), ['Wavelog']);
});

test('Wavelog address: http(s) only, no credentials, no query, trailing slash', () => {
  assert.equal(wavelogUrl('https://log.example.org'), 'https://log.example.org/');
  assert.equal(wavelogUrl('https://log.example.org/wavelog?x=1#y'), 'https://log.example.org/wavelog/');
  assert.equal(wavelogUrl('javascript:alert(1)'), '');
  assert.equal(wavelogUrl('https://user:pw@log.example.org/'), '');
  assert.equal(wavelogUrl('ftp://log.example.org/'), '');
  assert.equal(wavelogUrl('not a url'), '');
  assert.equal(wavelogUrl(''), '');
});
