// Notfunk-Meldebuch <-> Winlink, the Meldebuch side (issue #179; contract
// tools/notfunk/winlink/FORMAT.md; the form pack itself:
// notfunk-winlink.test.mjs): payload, ASCII transport, flat fields, the .b2f
// for Pat (byte for byte as Pat v1.0.0 writes it:
// tests/fixtures/notfunk-winlink/pat/), the parsers, the import rules, the
// limits, and the data model (channel, `source`, backups). Regenerate the
// sample fixture with WRITE_FIXTURES=1.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openToolStorage } from '../tools/shared/js/storage.js';
import { NOTFUNK_STORES } from '../tools/notfunk/js/db.js';
import { newMessage, editMessage, setStatus, addAttempt, messageFields, currentStatus, CHANNELS, MESSAGE_TEXT_MAX } from '../tools/notfunk/js/model.js';
import { toBackup, parseBackup, mergeBackup, toGeschaeftsbuchCSV } from '../tools/notfunk/js/export.js';
import { saveNewMessage, updateMessage, replaceSource, changedFields, editBaseOf } from '../tools/notfunk/js/ops.js';
import { formToFields, messageToForm } from '../tools/notfunk/js/form.js';
import { formSheet } from '../tools/notfunk/js/print.js';
import {
  winlinkPayload, winlinkJson, winlinkFlatFields, winlinkB2f, winlinkParseB2f, winlinkXml, winlinkExportCheck, winlinkRenderTemplate,
  winlinkHeaderText, winlinkDecodeHeader, winlinkLatin1, winlinkAddress, winlinkAddressProblem, winlinkMid, parseWinlinkInput, winlinkImportPlan,
  WINLINK_TEMPLATE, WINLINK_XML_NAME, WINLINK_INPUT_MAX_BYTES, WINLINK_MESSAGE_MAX_BYTES, WINLINK_SUBJECT_MAX_BYTES,
} from '../tools/notfunk/js/winlink.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(ROOT, 'tests/fixtures/notfunk-winlink');
const PAT = path.join(FIX, 'pat');
const read = p => new Uint8Array(fs.readFileSync(p));

const T0 = '2026-11-06T17:00:00.000Z';
const T1 = '2026-11-06T17:05:00.000Z';
const T2 = '2026-11-06T17:20:00.000Z';
const T3 = '2026-11-06T17:30:00.000Z';
const NOW = '2026-11-06T18:00:00.000Z';
const STATION_A = { call: 'OE1XYZ', operation: 'Übung Donau', prefix: 'W1', operator: 'OE1XYZ' };
const STATION_B = { call: 'OE3ABC', operation: 'Übung Tulln', prefix: 'K', operator: 'OE3ABC' };
const TRICKY = 'Zeile 1: äöü ÄÖÜ ß € „zitiert“ 📻✅\n  <b>kein HTML</b> & "Anführung" \'x\' {var nummer} {MsgSender}\nEnde';

class MemoryStorage {
  #m = new Map();
  get length() { return this.#m.size; }
  key(i) { return [...this.#m.keys()][i] ?? null; }
  getItem(k) { return this.#m.has(k) ? this.#m.get(k) : null; }
  setItem(k, v) { this.#m.set(k, String(v)); }
  removeItem(k) { this.#m.delete(k); }
}
const SCHEMA = { name: 'test', version: 1, lsPrefix: 'test:', stores: NOTFUNK_STORES, upgrade() {} };
beforeEach(() => { globalThis.localStorage = new MemoryStorage(); });

const num = (prefix, seq) => ({ prefix, seq, number: `${prefix}-${String(seq).padStart(3, '0')}` });
const meta = (id, opId, op, now = T0) => ({ id, opId, operator: op.operator, stationCall: op.call, now });

// Station A's book: W1-003 (incoming from B, imported earlier, so it has a
// source), W1-007 (outgoing answer to it, edited once, one attempt, transmitted).
function bookA() {
  const w3 = {
    ...newMessage({ direction: 'in', ts: T0, channel: 'winlink', from: { name: 'Bezirksstab', call: 'OE3ABC' }, to: { name: 'Stab' }, subject: 'Lage', text: 'Brücke gesperrt.' },
      num('W1', 3), meta('a-w3', 'opA', STATION_A)),
    source: { format_version: 1, station: 'OE3ABC', id: 'b-k12', number: 'K-012', status: [], attempts: [], revisions: [], updated: T0, exported: T0 },
  };
  let w7 = newMessage({
    direction: 'out', ts: T1, channel: 'winlink', type: 'anforderung', priority: 'priority',
    from: { name: 'Stab', call: 'OE1XYZ' }, to: { name: 'Bezirksstab', call: 'OE3ABC' }, distribution: ['Lagezentrum'],
    subject: 'Notstrom', text: 'Erste Fassung', replyTo: 'a-w3', refKind: 'antwort', refNumber: 'W1-003',
    origin: { station: 'OE1XYZ', place: 'Wien' }, remarks: 'Rückruf möglich',
  }, num('W1', 7), meta('a-w7', 'opA', STATION_A, T1));
  const { next, revision } = editMessage(w7, { text: TRICKY, subject: 'Notstrom <2×> & Treibstoff' }, { revisionId: 'r1', operator: 'OE1XYZ', now: T2 });
  w7 = addAttempt(next, { operator: 'OE1XYZ', now: T2, note: 'keine Antwort' });
  w7 = setStatus(w7, 'forwarded', { operator: 'OE1XYZ', now: T3, to: 'OE3ABC', note: 'per Winlink' });
  return { w3, w7, revisions: [revision] };
}

function payloadA() {
  const { w3, w7, revisions } = bookA();
  return winlinkPayload(w7, revisions, w3, STATION_A, '0.9.0', NOW);
}

/* ---------------------------------------------------------------- payload */

test('payload: the record as stored, without local ids; revisions oldest first; ref with its source', () => {
  const { w3, w7, revisions } = bookA();
  const second = { ...revisions[0], id: 'r0', at: T1, old: { ...revisions[0].old, text: 'Nullte Fassung' } };
  const p = winlinkPayload(w7, [revisions[0], second, { id: 'x', messageId: 'other', at: T0, old: {} }], w3, STATION_A, '0.9.0', NOW);
  assert.equal(p.format, 'oe1ebg-notfunk-winlink');
  assert.equal(p.version, 1);
  assert.equal(p.app, '0.9.0');
  assert.equal(p.exported, NOW);
  assert.deepEqual(p.station, STATION_A);
  const { eventId: _e, replyTo: _r, ...rest } = w7;
  assert.deepEqual(p.message, rest, 'every field, status, attempts, created/updated/deleted, editedBy');
  assert.ok(!('eventId' in p.message) && !('replyTo' in p.message));
  for (const k of Object.keys(messageFields(w7))) if (k !== 'replyTo') assert.ok(k in p.message, k);
  assert.equal(p.message.attempts.length, 1);
  assert.equal(p.message.status.length, 2);
  assert.deepEqual(p.revisions.map(r => r.at), [T1, T2], 'oldest first, other messages left out');
  for (const r of p.revisions) {
    assert.deepEqual(Object.keys(r), ['at', 'by', 'old']);
    assert.ok(!('eventId' in r.old) && !('replyTo' in r.old));
  }
  assert.deepEqual(p.ref, { id: 'a-w3', number: 'W1-003', station: 'OE1XYZ', source: { id: 'b-k12', number: 'K-012', station: 'OE3ABC' } });
  // a referenced message of this book itself: no source
  const { source: _s, ...plain } = w3;
  assert.deepEqual(winlinkPayload(w7, [], plain, STATION_A, '0.9.0', NOW).ref, { id: 'a-w3', number: 'W1-003', station: 'OE1XYZ', source: null });
  // no Bezug: null, refKind/refNumber stay in message
  const noRef = winlinkPayload({ ...w7, replyTo: null }, [], null, STATION_A, '0.9.0', NOW);
  assert.equal(noRef.ref, null);
  assert.equal(noRef.message.refNumber, 'W1-003');
  // an imported message keeps its own source in the payload
  assert.deepEqual(winlinkPayload(w3, [], null, STATION_A, '0.9.0', NOW).message.source, w3.source);
});

test('winlinkJson: ASCII only, no < > & or line breaks, round trip of every character', () => {
  const p = payloadA();
  const j = winlinkJson(p);
  assert.match(j, /^[\x20-\x7e]*$/, 'printable ASCII only');
  assert.doesNotMatch(j, /[<>&]/);
  assert.ok(j.includes('\\u00e4') && j.includes('\\u20ac') && j.includes('\\u201e') && j.includes('\\ud83d\\udcfb'), 'ä, €, „, emoji as escapes (surrogate pair)');
  assert.ok(j.includes('\\u003cb\\u003e') && j.includes('\\u0026'));
  assert.ok(j.includes('\\u007bvar nummer}'), 'a "{" in a string is escaped too (no {var} slot)');
  assert.deepEqual(JSON.parse(j), p);
  assert.equal(JSON.parse(j).message.text, TRICKY);
  for (const s of ['', '\n', '\u0000\u001f', '\u007f\u0080ÿ', '😀', '{}', '{"a":1}', '}{', '</script>', '\\u0041']) {
    const t = { format: 'x', s, o: {}, a: [{}] };
    assert.deepEqual(JSON.parse(winlinkJson(t)), t, JSON.stringify(s));
  }
});

test('flat fields: exactly the variables of FORMAT.md', () => {
  const f = winlinkFlatFields(payloadA(), 'OE3ABC');
  assert.deepEqual(f, {
    msgto: 'OE3ABC',
    kennung: '[ÜBUNG]',
    uebung: '=== ACHTUNG ÜBUNG ===',
    nummer: 'W1-007',
    prioritaet: 'Dringend',
    art: 'Anforderung',
    von: 'Stab / OE1XYZ',
    an: 'Bezirksstab / OE3ABC',
    betreff: 'Notstrom <2×> & Treibstoff',
    inhalt: TRICKY,
    zeit: '2026-11-06 17:05 UTC',
    bezug: 'Antwort auf W1-003 (OE1XYZ)',
    station: 'OE1XYZ',
    verlauf: [
      '2026-11-06 17:05 UTC zur Übertragung (OE1XYZ)',
      '2026-11-06 17:20 UTC Fehlversuch/Rückfrage: keine Antwort (OE1XYZ)',
      '2026-11-06 17:30 UTC übertragen an OE3ABC: per Winlink (OE1XYZ)',
    ].join('\n'),
    format_version: '1',
    templateversion: 'OE Notfunk Meldung 1.0',
  });
  // a Bezug typed as text (no linked message)
  const p = payloadA();
  p.ref = null;
  p.message.refNumber = 'K-099';
  p.message.refKind = 'korrektur';
  assert.equal(winlinkFlatFields(p).bezug, 'Korrektur zu K-099');
  p.message.refNumber = '';
  assert.equal(winlinkFlatFields(p).bezug, '');
  // exercise: from the operation; a payload without the field counts as exercise
  assert.equal(p.exercise, true);
  p.exercise = false;
  assert.deepEqual([winlinkFlatFields(p).kennung, winlinkFlatFields(p).uebung], ['', '']);
  delete p.exercise;
  assert.equal(winlinkFlatFields(p).kennung, '[ÜBUNG]');
  assert.equal(winlinkPayload(bookA().w7, [], null, { ...STATION_A, exercise: false }, '0.9.0', NOW).exercise, false);
  assert.equal(winlinkPayload(bookA().w7, [], null, STATION_A, '0.9.0', NOW).exercise, true, 'operations without the field are exercises');
});

test('the template is the form pack\'s OE_Notfunk_Meldung.txt', () => {
  const file = path.join(ROOT, 'tools/notfunk/winlink/OE_Notfunk_Meldung.txt');
  assert.equal(WINLINK_TEMPLATE, fs.readFileSync(file, 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n'));
  const r = winlinkRenderTemplate(WINLINK_TEMPLATE, winlinkFlatFields(payloadA(), 'OE3ABC'));
  assert.equal(r.to, 'OE3ABC');
  assert.equal(r.subject, '[ÜBUNG] Dringend W1-007: Notstrom <2×> & Treibstoff');
  assert.match(r.body, /^=== ACHTUNG ÜBUNG ===\nNOTFUNK-MELDUNG W1-007\n/, 'the marker is the first line');
  assert.match(r.body, /\nInhalt:\n=== ACHTUNG ÜBUNG ===\n\nZeile 1: äöü[^]*\nEnde\n\n=== ACHTUNG ÜBUNG ===\n\nVerlauf:/);
  // not an exercise: no marker, no subject prefix (Pat trims the subject)
  const p = payloadA();
  p.exercise = false;
  const e = winlinkRenderTemplate(WINLINK_TEMPLATE, winlinkFlatFields(p, 'OE3ABC'));
  assert.equal(e.subject, 'Dringend W1-007: Notstrom <2×> & Treibstoff');
  assert.doesNotMatch(e.body, /ÜBUNG/);
  assert.match(e.body, /^\nNOTFUNK-MELDUNG W1-007\n/);
  assert.match(r.body, /\nVerlauf:\n2026-11-06 17:05 UTC zur Übertragung/);
  assert.doesNotMatch(r.body, /<var /i, 'every slot filled');
});

/* ---------------------------------------------------------------- B2F and XML */

test('b2f: wl2k-go layout, Latin-1 body, XML attachment, parsed back to the same payload', () => {
  const p = payloadA();
  const b = winlinkB2f(p, { mycall: 'oe1xyz', msgto: 'oe3abc', now: NOW });
  assert.match(b.mid, /^[A-Z2-7]{12}$/);
  assert.equal(winlinkB2f(p, { mycall: 'OE1XYZ', msgto: 'OE3ABC', now: NOW }).mid, b.mid, 'deterministic for one message, time and sender');
  const text = Buffer.from(b.bytes).toString('latin1');
  const [head] = text.split('\r\n\r\n');
  const lines = head.split('\r\n');
  assert.deepEqual(lines.map(l => l.split(':')[0]), ['Mid', 'Body', 'Content-Transfer-Encoding', 'Content-Type', 'Date', 'File', 'From', 'Mbo', 'Subject', 'To', 'Type']);
  assert.ok(lines.includes('Date: 2026/11/06 18:00'));
  assert.ok(lines.includes('From: OE1XYZ') && lines.includes('Mbo: OE1XYZ') && lines.includes('To: OE3ABC') && lines.includes('Type: Private'));
  assert.ok(lines.includes('Content-Type: text/plain; charset=ISO-8859-1'));
  const parsed = winlinkParseB2f(b.bytes);
  assert.equal(Number(parsed.headers.body[0]), winlinkLatin1(b.body.replace(/\r?\n/g, '\r\n')).length);
  assert.equal(parsed.files.length, 1);
  assert.equal(parsed.files[0].name, WINLINK_XML_NAME);
  assert.match(parsed.body, /Zeile 1: äöü ÄÖÜ ß \? \?zitiert\? \?\?\n/, 'outside Latin-1 becomes ?');
  assert.ok(!/\r/.test(parsed.body));
  const back = parseWinlinkInput('x.b2f', b.bytes);
  assert.equal(back.kind, 'payload');
  assert.equal(back.mid, b.mid);
  assert.deepEqual(back.payload, p);
  // the XML alone, and as text
  assert.deepEqual(parseWinlinkInput('a.xml', parsed.files[0].data).payload, p);
  assert.deepEqual(parseWinlinkInput('', b.xml).payload, p);
  // a body line over 998 bytes is split like wl2k-go does
  const long = structuredClone(p);
  long.message.text = 'z'.repeat(2500);
  const lb = winlinkParseB2f(winlinkB2f(long, { mycall: 'OE1XYZ', msgto: 'OE3ABC', now: NOW }).bytes).body;
  assert.ok(lb.includes(`\n${'z'.repeat(998)}\n${'z'.repeat(998)}\n${'z'.repeat(504)}\n`));
});

test('b2f and XML: byte for byte what Pat v1.0.0 writes (recorded fixtures)', { skip: !fs.existsSync(path.join(PAT, 'XI3ANHPBSOTX.b2f')) && 'no Pat fixtures' }, () => {
  const payload = JSON.parse(fs.readFileSync(path.join(PAT, 'W1-007.winlink.json'), 'utf8'));
  const pat = read(path.join(PAT, 'XI3ANHPBSOTX.b2f'));
  const mine = winlinkB2f(payload, { mycall: 'OE1XYZ', msgto: 'OE3ABC', now: '2026-11-06T20:26:03.000Z', mid: 'XI3ANHPBSOTX', appVersion: 'Pat v1.0.0 (2e6a8d1)', grid: 'JN88' });
  assert.equal(Buffer.compare(Buffer.from(mine.bytes), Buffer.from(pat)), 0);
  assert.equal(mine.xml, fs.readFileSync(path.join(PAT, 'RMS_Express_Form_OE_Notfunk_Meldung_Viewer.xml'), 'utf8'));
  // and read back: the b2f, the XML attachment, the payload file
  for (const name of ['XI3ANHPBSOTX.b2f', 'RMS_Express_Form_OE_Notfunk_Meldung_Viewer.xml', 'W1-007.winlink.json']) {
    const r = parseWinlinkInput(name, read(path.join(PAT, name)));
    assert.equal(r.kind, 'payload', name);
    assert.deepEqual(r.payload, payload, name);
  }
  assert.equal(parseWinlinkInput('x.b2f', pat).mid, 'XI3ANHPBSOTX');
});

test('our form filled in by hand (no `meldung`): the flat fields, recorded with Pat', { skip: !fs.existsSync(path.join(PAT, 'manual-5VZ7K4AHV4SK.b2f')) && 'no Pat fixtures' }, () => {
  for (const name of ['manual-5VZ7K4AHV4SK.b2f', 'manual-RMS_Express_Form_OE_Notfunk_Meldung_Viewer.xml']) {
    const r = parseWinlinkInput(name, read(path.join(PAT, name)));
    assert.equal(r.kind, 'flat', name);
    assert.equal(r.flat.ours, true);
    assert.equal(r.flat.number, 'K-001');
    assert.equal(r.flat.priority, 'emergency');
    assert.equal(r.flat.subject, 'Brücke gesperrt');
    assert.equal(r.flat.text, 'Zeile 1 äöü €\nZeile 2', 'CRLF of the form post as LF');
    assert.equal(r.flat.station, 'OE1XYZ');
    const plan = winlinkImportPlan(r, [], { home: 'Stab', now: NOW });
    assert.equal(plan.kind, 'new');
    assert.equal(plan.fields.priority, 'emergency');
    assert.equal(plan.fields.channel, 'winlink');
    assert.equal(plan.source.number, 'K-001');
    assert.equal(plan.source.station, 'OE1XYZ');
    assert.equal(plan.source.exercise, true, 'manual entry: Übung checked by default');
    assert.doesNotMatch(plan.fields.text, /ACHTUNG/);
  }
});

test('XML as Pat escapes it (encoding/xml): entities, CRLF, CDATA, BOM, Latin-1', () => {
  const p = payloadA();
  const meldung = winlinkJson(p).replace(/"/g, '&#34;');
  const xml = `﻿<?xml version="1.0" encoding="UTF-8"?>\r\n<RMS_Express_Form>\r\n  <form_parameters><display_form>OE_Notfunk_Meldung_Viewer.html</display_form><senders_callsign>OE1XYZ</senders_callsign></form_parameters>\r\n  <variables>\r\n    <Inhalt>A &amp; B &lt;c&gt; &#34;d&#34; &#39;e&#39;&#xD;&#xA;f &#228; &#x1F4FB;</Inhalt>\r\n    <leer/>\r\n    <meldung>${meldung}</meldung>\r\n  </variables>\r\n</RMS_Express_Form>`;
  assert.deepEqual(parseWinlinkInput('f.xml', Buffer.from(xml, 'utf8')).payload, p);
  // without meldung: flat, with the escapes decoded
  const flat = parseWinlinkInput('f.xml', xml.replace(/<meldung>.*<\/meldung>/, '<betreff><![CDATA[x < y]]></betreff>'));
  assert.equal(flat.kind, 'flat');
  assert.equal(flat.flat.text, 'A & B <c> "d" \'e\'\nf ä 📻');
  assert.equal(flat.flat.subject, 'x < y');
  // ISO-8859-1 bytes (not UTF-8) are read as Latin-1
  const latin = Buffer.from('<RMS_Express_Form><variables><subject>Brücke</subject><message>Text</message></variables></RMS_Express_Form>', 'latin1');
  assert.equal(parseWinlinkInput('l.xml', latin).flat.subject, 'Brücke');
  // winlinkXml: Go's escaping of every special character, values trimmed, variables sorted
  const x = winlinkXml({ b: ' a&b<c>"d"\'e\'\t\r\nf ', a: '' }, { mycall: 'OE1XYZ', now: NOW });
  assert.match(x, /<a><\/a>\n {8}<b>a&amp;b&lt;c&gt;&#34;d&#34;&#39;e&#39;&#x9;&#xD;&#xA;f<\/b>/);
  assert.ok(x.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<RMS_Express_Form>\n    <form_parameters>\n        <xml_file_version>1.0</xml_file_version>'));
  assert.ok(x.endsWith('    </variables>\n</RMS_Express_Form>'));
  assert.throws(() => parseWinlinkInput('a.xml', '<html></html>'), /Kein Winlink-Formular/);
});

test('other forms and plain messages: subject, text and sender only', () => {
  const ics = `<?xml version="1.0"?><RMS_Express_Form><form_parameters><display_form>ICS213_Viewer.html</display_form><senders_callsign>OE3ABC</senders_callsign></form_parameters>
<variables><msgsender>OE3ABC</msgsender><fm_name>Einsatzleiter Tulln</fm_name><to_name>Stab Wien</to_name><subjectline>Pegel Donau</subjectline><message>Pegel steigt.</message></variables></RMS_Express_Form>`;
  const r = parseWinlinkInput('RMS_Express_Form_ICS213_Viewer.xml', ics);
  assert.equal(r.kind, 'flat');
  assert.deepEqual([r.flat.subject, r.flat.text, r.flat.from, r.flat.to, r.flat.station, r.flat.ours], ['Pegel Donau', 'Pegel steigt.', 'Einsatzleiter Tulln', 'Stab Wien', 'OE3ABC', false]);
  const plan = winlinkImportPlan(r, [], { home: 'Stab', now: NOW });
  assert.equal(plan.kind, 'new');
  assert.equal(plan.fields.subject, 'Pegel Donau');
  assert.equal(plan.fields.from.name, 'Einsatzleiter Tulln');
  assert.equal(plan.fields.direction, 'in');
  assert.equal(plan.fields.ts, NOW);
  assert.equal(plan.source.form, 'ICS213_Viewer.html');
  assert.match(plan.warnings[0], /Anderes Formular \(ICS213_Viewer\.html\)/);
  // an IARU-style form with unknown variable names: sender from the parameters
  const iaru = parseWinlinkInput('i.xml', '<RMS_Express_Form><form_parameters><senders_callsign>OE5XYZ</senders_callsign><display_form>IARU_Message_Viewer.html</display_form></form_parameters><variables><text>Alles ruhig</text></variables></RMS_Express_Form>');
  assert.equal(iaru.flat.text, 'Alles ruhig');
  assert.equal(iaru.flat.from, 'OE5XYZ');
  const ip = winlinkImportPlan(iaru, [], { home: 'Stab', now: NOW });
  assert.equal(ip.fields.subject, 'Alles ruhig', 'no subject: the first line');
  assert.equal(ip.fields.to.name, 'Stab', 'no addressee: the own post');
  // a .b2f without a form: headers and body
  const plain = winlinkB2f(payloadA(), { mycall: 'OE3ABC', msgto: 'OE1XYZ', now: NOW });
  const parsed = winlinkParseB2f(plain.bytes);
  const head = Buffer.from(plain.bytes).toString('latin1').split('\r\n\r\n')[0]
    .replace(/^File: .*\r\n/m, '').replace(/^Subject: .*$/m, `Subject: ${winlinkHeaderText('Grüße aus Tulln')}`);
  const bare = Buffer.concat([Buffer.from(`${head}\r\n\r\n`, 'latin1'), Buffer.from(parsed.body.replace(/\n/g, '\r\n'), 'latin1')]);
  const r2 = parseWinlinkInput('x.b2f', bare);
  assert.equal(r2.kind, 'flat');
  assert.equal(r2.flat.subject, 'Grüße aus Tulln');
  assert.equal(r2.flat.from, 'OE3ABC');
  assert.match(r2.flat.text, /^NOTFUNK-MELDUNG W1-007/);
  assert.equal(r2.mid, plain.mid);
  // a .b2f with another form's XML
  const icsBytes = Buffer.from(ics);
  const withIcs = Buffer.concat([Buffer.from(`Mid: ABCDEFGHIJKL\r\nBody: 6\r\nDate: 2026/11/06 18:00\r\nFile: ${icsBytes.length} RMS_Express_Form_ICS213_Viewer.xml\r\nFrom: OE3ABC\r\nSubject: ICS213\r\nTo: OE1XYZ\r\n\r\nText\r\n\r\n`, 'latin1'), icsBytes, Buffer.from('\r\n')]);
  const r3 = parseWinlinkInput('y.b2f', withIcs);
  assert.equal(r3.flat.subject, 'Pegel Donau');
  assert.equal(r3.mid, 'ABCDEFGHIJKL');
  // exercise marker lines are never part of an imported text; the marker is kept as such
  const markedBody = Buffer.from('=== ACHTUNG \xdcBUNG ===\r\n\r\nPegel steigt.\r\nZweite Zeile\r\n\r\n*** ACHTUNG UEBUNG ***\r\n', 'latin1');
  const marked = Buffer.concat([Buffer.from(`${head.replace(/^Body: \d+$/m, `Body: ${markedBody.length}`)}\r\n\r\n`, 'latin1'), markedBody]);
  const r4 = parseWinlinkInput('m.b2f', marked);
  assert.equal(r4.flat.text, 'Pegel steigt.\nZweite Zeile');
  assert.equal(r4.flat.exercise, true);
  const p4 = winlinkImportPlan(r4, [], { home: 'Stab', now: NOW });
  assert.equal(p4.fields.text, 'Pegel steigt.\nZweite Zeile');
  assert.equal(p4.source.exercise, true);
  // in another form's text, and the subject tag
  const icsEx = ics.replace('<subjectline>Pegel Donau', '<subjectline>[ÜBUNG] Pegel Donau').replace('<message>Pegel steigt.', '<message>ACHTUNG ÜBUNG\nPegel steigt.\nACHTUNG ÜBUNG');
  const r5 = parseWinlinkInput('i.xml', icsEx);
  assert.deepEqual([r5.flat.subject, r5.flat.text, r5.flat.exercise], ['Pegel Donau', 'Pegel steigt.', true]);
  assert.equal(r.flat.exercise, null, 'no marker: unknown');
  // a text that merely mentions the words keeps them
  const mention = parseWinlinkInput('i.xml', ics.replace('<message>Pegel steigt.', '<message>Achtung Übung morgen um 9 Uhr'));
  assert.equal(mention.flat.text, 'Achtung Übung morgen um 9 Uhr');
  // a truncated .b2f is refused
  assert.throws(() => parseWinlinkInput('z.b2f', withIcs.subarray(0, withIcs.length - 40)), /unvollständig oder beschädigt/);
});

test('headers and addresses: Q-encoding of the subject, wl2k-go addresses', () => {
  assert.equal(winlinkHeaderText('Routine W1-007: Lage'), 'Routine W1-007: Lage');
  assert.equal(winlinkHeaderText('Übung = ja_?'), '=?ISO-8859-1?q?=DCbung_=3D_ja=5F=3F?=');
  assert.equal(winlinkDecodeHeader('=?ISO-8859-1?q?=DCbung_=3D_ja=5F=3F?='), 'Übung = ja_?');
  assert.equal(winlinkDecodeHeader('=?utf-8?b?w5xidW5n?= =?utf-8?q?_2?='), 'Übung 2');
  assert.equal(winlinkAddress('oe3abc'), 'OE3ABC');
  assert.equal(winlinkAddress('oe3abc@winlink.org'), 'OE3ABC');
  assert.equal(winlinkAddress('a.b@example.at'), 'SMTP:a.b@example.at');
  assert.equal(winlinkAddressProblem('OE3ABC-10'), '');
  assert.equal(winlinkAddressProblem('stab@example.at'), '');
  assert.match(winlinkAddressProblem(''), /fehlt/);
  assert.match(winlinkAddressProblem('Stab Wien'), /Rufzeichen/);
  assert.notEqual(winlinkMid('a'), winlinkMid('b'));
});

/* ---------------------------------------------------------------- limits */

test('input limit: 1 MB below, at and above', () => {
  const base = winlinkJson(payloadA());
  const pad = n => `${base}${' '.repeat(n - base.length)}`;
  assert.equal(parseWinlinkInput('a.json', pad(WINLINK_INPUT_MAX_BYTES - 1)).kind, 'payload');
  assert.equal(parseWinlinkInput('a.json', pad(WINLINK_INPUT_MAX_BYTES)).kind, 'payload');
  assert.throws(() => parseWinlinkInput('a.json', pad(WINLINK_INPUT_MAX_BYTES + 1)), /„a\.json“ ist 1,0 MB groß; mehr als 1 MB/);
  assert.throws(() => parseWinlinkInput('', 'Hallo'), /nicht erkannt/);
  assert.throws(() => parseWinlinkInput('x.json', '{"format":"oe1ebg-notfunk-winlink"'), /JSON fehlerhaft/);
});

test('export limit: 120 KB below, at and above; subject 128 bytes below, at and above', () => {
  const p = payloadA();
  const c = winlinkExportCheck(p, { msgto: 'OE3ABC', mycall: 'OE1XYZ', now: NOW });
  assert.equal(c.bytes, winlinkB2f(p, { mycall: 'OE1XYZ', msgto: 'OE3ABC', now: NOW }).bytes.length);
  assert.equal(c.tooLarge, false);
  assert.equal(c.max, WINLINK_MESSAGE_MAX_BYTES);
  // the largest text that fits, one character more, one less
  const sized = n => {
    const q = structuredClone(p);
    q.message.text = 'x'.repeat(n);
    q.revisions = [];
    return winlinkExportCheck(q, { msgto: 'OE3ABC', mycall: 'OE1XYZ', now: NOW });
  };
  let lo = 1, hi = MESSAGE_TEXT_MAX;
  while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (sized(mid).bytes <= WINLINK_MESSAGE_MAX_BYTES) lo = mid; else hi = mid - 1; }
  const [below, at, above] = [sized(lo - 1), sized(lo), sized(lo + 1)];
  assert.ok(below.bytes < at.bytes && at.bytes <= WINLINK_MESSAGE_MAX_BYTES && above.bytes > WINLINK_MESSAGE_MAX_BYTES, `${at.bytes} ${above.bytes}`);
  assert.equal(below.tooLarge, false);
  assert.equal(at.tooLarge, false);
  assert.equal(above.tooLarge, true);
  assert.match(above.error, /^Zu groß für Winlink: .* KB, höchstens 120,0 KB\. .*nicht gekürzt/);
  // a long edit history is refused too, never dropped
  const q = structuredClone(p);
  q.revisions = Array.from({ length: 40 }, (_, i) => ({ at: T1, by: 'OE1XYZ', old: { ...p.message, text: `Fassung ${i} ${'y'.repeat(1500)}` } }));
  const big = winlinkExportCheck(q, { msgto: 'OE3ABC', mycall: 'OE1XYZ', now: NOW });
  assert.equal(big.tooLarge, true);
  assert.match(big.error, /Fassungen \(40\)/);
  // subject: "<Dringlichkeit> <Nummer>: <Betreff>" in bytes (not an exercise;
  // the exercise prefix counts, Q-encoded, below)
  const subj = n => {
    const s = structuredClone(p);
    s.exercise = false;
    s.message.subject = 'b'.repeat(n - 'Dringend W1-007: '.length);
    return winlinkExportCheck(s, { msgto: 'OE3ABC', mycall: 'OE1XYZ', now: NOW });
  };
  const has = r => r.warnings.some(w => /Betreff der Winlink-Nachricht/.test(w));
  assert.equal(subj(WINLINK_SUBJECT_MAX_BYTES - 1).subjectBytes, 127);
  assert.equal(has(subj(WINLINK_SUBJECT_MAX_BYTES - 1)), false);
  assert.equal(subj(WINLINK_SUBJECT_MAX_BYTES).subjectBytes, 128);
  assert.equal(has(subj(WINLINK_SUBJECT_MAX_BYTES)), false);
  assert.match(subj(WINLINK_SUBJECT_MAX_BYTES + 1).warnings.join(' '), /Betreff der Winlink-Nachricht ist 129 Byte lang/);
  // umlauts are Q-encoded in the header and count as such
  const u = structuredClone(p);
  u.message.subject = 'ü'.repeat(40);
  assert.ok(winlinkExportCheck(u, { msgto: 'OE3ABC', mycall: 'OE1XYZ', now: NOW }).subjectBytes > 128);
  // the exercise prefix "[ÜBUNG] " counts, Q-encoded (the Ü makes the whole subject an encoded word)
  const ex = structuredClone(p);
  ex.message.subject = 'b'.repeat(80);
  const plain = { ...structuredClone(ex), exercise: false };
  const withTag = winlinkExportCheck(ex, { msgto: 'OE3ABC', mycall: 'OE1XYZ', now: NOW }).subjectBytes;
  assert.ok(withTag > winlinkExportCheck(plain, { msgto: 'OE3ABC', mycall: 'OE1XYZ', now: NOW }).subjectBytes + '[ÜBUNG] '.length, `${withTag}`);
  assert.equal(withTag, winlinkHeaderText(`[ÜBUNG] Dringend W1-007: ${'b'.repeat(80)}`).length);
});

test('a newer format version is rejected in every form', () => {
  const p = { ...payloadA(), version: 2 };
  assert.throws(() => parseWinlinkInput('a.json', JSON.stringify(p)), /neueren Version des Notfunk-Meldebuchs erstellt \(Format 2, hier 1\)/);
  const b = winlinkB2f(payloadA(), { mycall: 'OE1XYZ', msgto: 'OE3ABC', now: NOW });
  const xml = b.xml.replace(/<meldung>(.*)<\/meldung>/, (all, m) => `<meldung>${m.replace('&#34;version&#34;:1', '&#34;version&#34;:2')}</meldung>`);
  assert.throws(() => parseWinlinkInput('a.xml', xml), /neueren Version/);
  const flat = b.xml.replace(/<meldung>.*<\/meldung>/, '<meldung></meldung>').replace('<format_version>1<', '<format_version>2<');
  assert.throws(() => parseWinlinkInput('a.xml', flat), /neueren Version des Formulars/);
  assert.equal(parseWinlinkInput('a.json', JSON.stringify({ ...payloadA(), version: 1 })).kind, 'payload', 'equal is fine');
});

test('strict validation: a broken payload is refused as a whole, with a German message', () => {
  const bad = mut => {
    const p = structuredClone(payloadA());
    mut(p);
    return () => parseWinlinkInput('a.json', JSON.stringify(p));
  };
  assert.throws(bad(p => { p.format = 'x'; }), /Keine Notfunk-Meldung/);
  assert.throws(bad(p => { delete p.message.id; }), /ID/);
  assert.throws(bad(p => { p.message.status = [{ state: 'weg', at: T0 }]; }), /Status/);
  assert.throws(bad(p => { p.message.ts = 'gestern'; }), /Zeitstempel/);
  assert.throws(bad(p => { p.message.from = { name: '', call: '' }; }), /Absender fehlt/);
  assert.throws(bad(p => { p.message.text = 'x'.repeat(MESSAGE_TEXT_MAX + 1); }), /Inhalt ist zu lang/);
  assert.throws(bad(p => { p.revisions = [{ at: 'x' }]; }), /Fassungen/);
  assert.throws(bad(p => { p.ref = { id: 'a b', number: 'W1-1', station: 'X' }; }), /Bezug/);
  assert.throws(bad(p => { p.message.source = 'x'; }), /Herkunft/);
  assert.throws(bad(p => { p.station = null; }), /Station/);
});

/* ---------------------------------------------------------------- import rules */

// Station B's book before the import: one own outgoing message (K-005).
function bookB() {
  return [newMessage({ direction: 'out', ts: T0, channel: 'winlink', from: { name: 'Bezirksstab' }, to: { name: 'Stab Wien' }, subject: 'Frage', text: 'Wie ist die Lage?' },
    num('K', 5), meta('b-k5', 'opB', STATION_B))];
}

test('import plan: a new incoming message for review, with the sender\'s record as source', () => {
  const p = payloadA();
  const plan = winlinkImportPlan({ kind: 'payload', payload: p, mid: 'MID123456789' }, bookB(), { home: 'Stab Tulln', now: NOW });
  assert.equal(plan.kind, 'new');
  const f = plan.fields;
  assert.equal(f.direction, 'in');
  assert.equal(f.channel, 'winlink');
  assert.equal(f.ts, NOW, 'received now');
  assert.deepEqual([f.type, f.priority, f.subject, f.text], ['anforderung', 'priority', p.message.subject, TRICKY]);
  assert.deepEqual(f.from, p.message.from);
  assert.deepEqual(f.to, p.message.to);
  assert.equal(f.readBack, false);
  assert.equal(f.origin.station, 'OE1XYZ');
  assert.equal(f.replyTo, null);
  assert.equal(f.refNumber, 'W1-003 (OE1XYZ)', 'unresolved: number and station');
  assert.ok(!('source' in f));
  assert.deepEqual(plan.source, {
    format_version: 1, station: 'OE1XYZ', operation: 'Übung Donau', operator: 'OE1XYZ', id: 'a-w7', number: 'W1-007', direction: 'out', ts: T1,
    status: p.message.status, attempts: p.message.attempts, revisions: p.revisions, updated: p.message.updated, exported: NOW, exercise: true, mid: 'MID123456789',
  });
  // not an exercise at the sender: kept as such
  assert.equal(winlinkImportPlan({ kind: 'payload', payload: { ...p, exercise: false } }, bookB(), { now: NOW }).source.exercise, false);
  // saved like any new message: own number, status starts at "erfasst", source kept
  const msg = newMessage({ ...f, source: plan.source }, num('K', 6), meta('b-k6', 'opB', STATION_B, NOW));
  assert.equal(currentStatus(msg), 'logged');
  assert.equal(msg.status.length, 1);
  assert.deepEqual(msg.source, plan.source);
  // a deleted message at the sender: a warning
  const del = structuredClone(p);
  del.message.deleted = T3;
  assert.match(winlinkImportPlan({ kind: 'payload', payload: del }, [], { now: NOW }).warnings.join(' '), /gelöscht/);
});

test('round trip A -> B -> A: the reply resolves (ref.source.id) and marks the original answered', async () => {
  const store = await openToolStorage(SCHEMA);
  // B takes over A's W1-007 as K-001 and answers it with K-002
  const opB = { id: 'opB', name: 'Übung Tulln', prefix: 'K', call: 'OE3ABC', operator: 'OE3ABC' };
  const fromA = parseWinlinkInput('W1-007.winlink.json', winlinkJson(payloadA()));
  const planB = winlinkImportPlan(fromA, [], { now: NOW });
  const k1 = await saveNewMessage(store, { op: opB, fields: { ...planB.fields, source: planB.source }, messageId: 'b-k1', meta: { operator: 'OE3ABC', stationCall: 'OE3ABC', now: NOW } });
  assert.equal(k1.number, 'K-001');
  assert.deepEqual(k1.source, planB.source);
  const k2fields = messageFields({ direction: 'out', ts: NOW, channel: 'winlink', from: { name: 'Bezirksstab' }, to: { name: 'Stab', call: 'OE1XYZ' }, subject: 'Antwort', text: 'Aggregate unterwegs.', replyTo: k1.id, refKind: 'antwort', refNumber: k1.number });
  const k2 = await saveNewMessage(store, { op: opB, fields: k2fields, messageId: 'b-k2', meta: { operator: 'OE3ABC', stationCall: 'OE3ABC', now: NOW } });
  const reply = winlinkPayload(k2, [], k1, STATION_B, '0.9.0', NOW);
  assert.deepEqual(reply.ref, { id: 'b-k1', number: 'K-001', station: 'OE3ABC', source: { id: 'a-w7', number: 'W1-007', station: 'OE1XYZ' } });
  // the reply travels as a .b2f; back at A it resolves through ref.source.id to A's own W1-007
  const { w3, w7 } = bookA();
  const parsed = parseWinlinkInput('x.b2f', winlinkB2f(reply, { mycall: 'OE3ABC', msgto: 'OE1XYZ', now: NOW }).bytes);
  const planA = winlinkImportPlan(parsed, [w3, w7], { now: NOW });
  assert.equal(planA.kind, 'new');
  assert.equal(planA.fields.replyTo, 'a-w7');
  assert.equal(planA.fields.refNumber, 'W1-007');
  assert.equal(planA.refLocal.id, 'a-w7');
  assert.equal(planA.source.mid, parsed.mid);
  // the form takes it as it is (Bezug = a number of this operation)
  const form = { ...messageToForm(planA.fields), source: planA.source };
  const checked = formToFields(form, { now: NOW, byNumber: new Map([w3, w7].map(m => [m.number, m])) });
  assert.deepEqual(checked.errors, []);
  assert.equal(checked.fields.replyTo, 'a-w7');
  assert.deepEqual(checked.fields.source, planA.source);
  // saved at A in one transaction with the "answered" status of W1-007
  const opA = { id: 'opA', name: 'Übung Donau', prefix: 'W1', call: 'OE1XYZ', operator: 'OE1XYZ' };
  await store.tx([{ store: 'messages', put: w3 }, { store: 'messages', put: w7 }]);
  const saved = await saveNewMessage(store, { op: opA, fields: checked.fields, messageId: 'a-w8', meta: { operator: 'OE1XYZ', stationCall: 'OE1XYZ', now: NOW } });
  assert.equal(saved.number, 'W1-008');
  assert.equal(currentStatus(await store.get('messages', 'a-w7')), 'answered');
  // importing it again is idempotent
  // (B's messages share this test store: only A's book counts here)
  const all = (await store.getAll('messages')).filter(m => m.eventId === 'opA');
  assert.equal(winlinkImportPlan(parsed, all, { allMessages: all, now: NOW }).kind, 'duplicate');
  // resolution by ref.id: a message whose id is the referenced one
  const direct = winlinkImportPlan({ kind: 'payload', payload: { ...reply, ref: { ...reply.ref, id: 'a-w3', source: null } } }, [w3, w7], { now: NOW });
  assert.equal(direct.fields.replyTo, 'a-w3');
  // and by an imported message's source.id (B's id of a message A took over)
  const viaSource = winlinkImportPlan({ kind: 'payload', payload: { ...reply, ref: { id: 'b-k12', number: 'K-012', station: 'OE3ABC', source: null } } }, [w3, w7], { now: NOW });
  assert.equal(viaSource.fields.replyTo, 'a-w3');
  // a deleted message is not linked (the form only links live ones)
  const gone = winlinkImportPlan({ kind: 'payload', payload: reply }, [w3, { ...w7, deleted: NOW }], { now: NOW });
  assert.equal(gone.fields.replyTo, null);
  assert.equal(gone.fields.refNumber, 'K-001 (OE3ABC)');
});

test('import plan: again = duplicate; newer = only the source block; own message = reported', async () => {
  const p = payloadA();
  const first = winlinkImportPlan({ kind: 'payload', payload: p }, [], { now: NOW });
  const local = newMessage({ ...first.fields, source: first.source, subject: 'vom Empfänger geändert' }, num('K', 1), meta('b-k1', 'opB', STATION_B, NOW));
  // the same file again, or an older one: nothing to do
  assert.deepEqual(winlinkImportPlan({ kind: 'payload', payload: p }, [local], { now: NOW }), { kind: 'duplicate', local });
  const older = structuredClone(p);
  older.message.updated = T0;
  assert.equal(winlinkImportPlan({ kind: 'payload', payload: older }, [local], { now: NOW }).kind, 'duplicate');
  // in another operation: still found (allMessages)
  assert.equal(winlinkImportPlan({ kind: 'payload', payload: p }, [], { allMessages: [local], now: NOW }).kind, 'duplicate');
  // newer at the sender (receipt confirmed): the source block only
  const newer = structuredClone(p);
  newer.message = setStatus(newer.message, 'acknowledged', { operator: 'OE1XYZ', now: '2026-11-06T18:30:00.000Z', who: 'OE3ABC' });
  const upd = winlinkImportPlan({ kind: 'payload', payload: newer, mid: 'NEWMID' }, [local], { now: NOW });
  assert.equal(upd.kind, 'update-source');
  assert.equal(upd.local, local);
  assert.equal(upd.source.status.length, 3);
  assert.equal(upd.source.mid, 'NEWMID');
  const store = await openToolStorage(SCHEMA);
  await store.tx([{ store: 'messages', put: local }]);
  const after = await replaceSource(store, local, upd.source, '2026-11-06T18:31:00.000Z');
  assert.deepEqual(after.source, upd.source);
  assert.equal(after.subject, 'vom Empfänger geändert', 'the receiver\'s fields stay');
  assert.deepEqual({ ...after, source: null, updated: null }, { ...local, source: null, updated: null });
  assert.ok(after.updated > local.updated);
  await assert.rejects(replaceSource(store, local, upd.source, NOW), { name: 'ConflictError' }, 'compare-and-set');
  // own message coming back: by its id, or a copy that names it as source
  const { w7 } = bookA();
  assert.deepEqual(winlinkImportPlan({ kind: 'payload', payload: p }, [w7], { now: NOW }), { kind: 'own', local: w7 });
  const forwarded = structuredClone(p);
  forwarded.message.id = 'c-copy';
  forwarded.message.source = { id: 'a-w7', number: 'W1-007', station: 'OE1XYZ' };
  assert.equal(winlinkImportPlan({ kind: 'payload', payload: forwarded }, [w7], { now: NOW }).kind, 'own');
  // flat messages: the same Winlink message id, or our form's number + station
  const flat = { kind: 'flat', mid: 'ABCDEFGHIJKL', flat: { ours: false, subject: 'S', text: 'T', from: 'OE3ABC', to: '', station: 'OE3ABC', form: '' } };
  const fl = winlinkImportPlan(flat, [], { home: 'Stab', now: NOW });
  const flatLocal = newMessage({ ...fl.fields, source: fl.source }, num('W1', 9), meta('a-w9', 'opA', STATION_A));
  assert.equal(winlinkImportPlan(flat, [flatLocal], { now: NOW }).kind, 'duplicate');
  assert.equal(winlinkImportPlan({ ...flat, mid: 'OTHERMID0000' }, [flatLocal], { now: NOW }).kind, 'new');
  const ours = { kind: 'flat', flat: { ours: true, number: 'K-001', station: 'OE3ABC', subject: 'S', text: 'T', from: 'OE3ABC', to: 'Stab', form: '' } };
  const ol = winlinkImportPlan(ours, [], { now: NOW });
  const oursLocal = newMessage({ ...ol.fields, source: ol.source }, num('W1', 10), meta('a-w10', 'opA', STATION_A));
  assert.equal(winlinkImportPlan(ours, [oursLocal], { now: NOW }).kind, 'duplicate');
  assert.throws(() => winlinkImportPlan({ kind: 'flat', flat: { subject: '', text: '' } }, [], { now: NOW }), /weder Betreff noch Text/);
});

/* ---------------------------------------------------------------- data model */

test('model: channel winlink; `source` kept by edits, the form and backups; older records unchanged', async () => {
  assert.equal(CHANNELS.winlink, 'Winlink');
  assert.equal(Object.keys(CHANNELS).at(-1), 'winlink', 'last: the digit keys of the other channels stay');
  const { w3, w7, revisions } = bookA();
  // messageFields: only an object; absent otherwise (older records have none)
  assert.ok(!('source' in messageFields(w7)));
  assert.deepEqual(messageFields(w3).source, w3.source);
  assert.ok(!('source' in messageFields({ ...w7, source: 'x' })));
  // an edit from the form: the form has no source, the record keeps it
  const form = messageToForm(w3);
  const { fields } = formToFields({ ...form, text: 'Brücke offen.' }, { now: NOW, editing: true });
  assert.ok(!('source' in fields));
  const changes = changedFields(fields, editBaseOf(w3).fields);
  assert.deepEqual(Object.keys(changes), ['text']);
  const { next, revision } = editMessage(w3, changes, { revisionId: 'r9', operator: 'OE1XYZ', now: NOW });
  assert.deepEqual(next.source, w3.source);
  assert.deepEqual(revision.old.source, w3.source);
  // a CAS edit on storage too
  const store = await openToolStorage(SCHEMA);
  await store.tx([{ store: 'messages', put: w3 }]);
  const stored = await updateMessage(store, w3, cur => editMessage(cur, changes, { revisionId: 'r10', operator: 'OE1XYZ', now: NOW }));
  assert.deepEqual(stored.source, w3.source);
  // backup round trip: channel winlink and source survive; a message without them stays as it was
  const op = { id: 'opA', name: 'Übung Donau', prefix: 'W1', created: T0, updated: T0, exercise: false };
  const legacy = newMessage({ direction: 'in', ts: T0, channel: 'funk', from: { name: 'X' }, to: { name: 'Y' }, subject: 'alt', text: 'alt' }, num('W1', 1), meta('a-w1', 'opA', STATION_A));
  const json = toBackup({ operation: op, messages: [legacy, w3, w7], revisions, counters: [] }, NOW);
  const back = parseBackup(json);
  assert.deepEqual(back.dropped, []);
  assert.deepEqual(back.messages, [legacy, w3, w7]);
  assert.equal(back.operation.exercise, false, 'the operation\'s exercise flag survives the backup');
  assert.ok(!('source' in back.messages[0]));
  const merged = mergeBackup(back, { operation: null, messages: [], revisions: [], counters: [] });
  assert.equal(merged.added, 3);
  assert.deepEqual(merged.ops.find(o => o.put.id === 'a-w3').put.source, w3.source);
  // a damaged source drops that message only (with a reason), like other record problems
  const broken = parseBackup(toBackup({ operation: op, messages: [legacy, { ...w3, source: { status: 'x' } }], revisions: [], counters: [] }, NOW));
  assert.deepEqual(broken.dropped, [{ what: 'Meldung W1-003', why: 'ungültige Winlink-Herkunft' }]);
  // CSV and print: the channel by its name
  assert.match(toGeschaeftsbuchCSV([w7]), /;Winlink;/);
  assert.equal(formSheet(w7, { ...op, call: 'OE1XYZ' }, { now: NOW, revisions: 1, byId: new Map() }).channelOther, 'Winlink');
});

/* ---------------------------------------------------------------- fixture */

test('sample fixture (fictitious OE1XYZ / OE3ABC) is what the code writes', () => {
  const file = path.join(FIX, 'sample.winlink.json');
  const text = `${winlinkJson(payloadA())}\n`;
  if (process.env.WRITE_FIXTURES) fs.writeFileSync(file, text);
  assert.equal(fs.readFileSync(file, 'utf8'), text);
  assert.deepEqual(parseWinlinkInput('sample.winlink.json', read(file)).payload, payloadA());
});
