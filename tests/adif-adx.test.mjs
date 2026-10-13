import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { parseADIF } from '../tools/shared/js/adif.js';
import { validateAdifRecords } from '../tools/shared/js/adif-validate.js';
import { serializeADX, detectLogFormat } from '../tools/adif/js/adx.js';
import { prepareExport, applyExportChoices } from '../tools/adif/js/conversion.js';
import { emptyFieldDefs } from '../tools/adif/js/export.js';

const stamp = '2026-10-13T12:00:00Z';
const python = process.env.ADX_PYTHON || new URL('../.venv/bin/python', import.meta.url).pathname;
const required = process.env.ADIF_XMLCHECK === 'require';
const probe = spawnSync(python, ['-c', 'import lxml.etree'], { encoding: 'utf8' });
const unavailable = probe.error || probe.status !== 0;
const skip = !required && unavailable ? 'lxml unavailable: uv sync --group xml-tests (ADIF_XMLCHECK=require makes this fail)' : false;
function schema(text, kind = 'export') {
  const r = spawnSync(python, ['scripts/check_adx_schema.py', kind], { input: text, encoding: 'utf8', maxBuffer: 16 << 20 });
  if (r.error) throw r.error;
  return r;
}

test('XML cross-check tooling is available when required', { skip }, () => { assert.equal(!!unavailable, false, 'install locked xml-tests dependencies'); });
test('content detection preserves ADI recovery and rejects unrelated XML', () => {
  for (const input of ['\ufeff <?xml version="1.0"?> <!--header--><ADX><HEADER/><RECORDS/></ADX>', '<n:ADX xmlns:n="urn:x"><n:HEADER/><n:RECORDS/></n:ADX>']) assert.equal(detectLogFormat(input), 'adx');
  assert.equal(detectLogFormat('<BROKEN>'.repeat(100) + '<CALL:3>ABC<EOR>'), 'adi');
  assert.equal(detectLogFormat('<CALL:3>ABC<EOR>', 'wrong.adx'), 'adi');
  assert.throws(() => detectLogFormat('<root><entry>hi</entry></root>', 'log.adi'), /not an ADX/);
});
test('format-aware semantics retain Unicode only in international types', () => {
  assert.equal(validateAdifRecords([{ NAME_INTL: 'Jürgen 😀' }], {}, { format: 'adx' }).errors, 0);
  assert.ok(validateAdifRecords([{ NAME_INTL: 'Jürgen 😀' }], {}, { format: 'adi' }).issues.some(i => i.code === 'INTL_FIELD_IN_ADI'));
  assert.ok(validateAdifRecords([{ NAME: 'Jürgen' }], {}, { format: 'adx' }).errors > 0);
  const defs = { userdefs: [{ name: 'TRANSCRIPT', type: 'G', spec: 'TRANSCRIPT' }], types: { APP_X_NAME: 'I' } };
  assert.equal(validateAdifRecords([{ TRANSCRIPT: 'Ä\n😀', APP_X_NAME: 'é' }], defs, { format: 'adx' }).errors, 0);
  const bad = validateAdifRecords([{ TRANSCRIPT: 'x' }], { userdefs: [{ name: 'TRANSCRIPT', type: 'N', spec: 'TRANSCRIPT,{1:3}' }] }, { format: 'adx' });
  assert.ok(bad.issues.some(i => i.code === 'INVALID_NUMBER'));
});
test('conversion requires every choice and preserves the original, including collision choices', () => {
  const log = [{ CALL: 'OE1AB', NAME_INTL: 'Jürgen 😀', NAME: 'Existing', COMMENT: ' ä ', APP_X_TEXT: 'Grüße' }];
  const defs = { userdefs: [], types: { APP_X_TEXT: 'I' } };
  const original = JSON.stringify(log);
  const plan = prepareExport(log, Object.keys(log[0]), 'adi', [], defs);
  assert.throws(() => applyExportChoices(plan, {}), /Choose/);
  const choices = Object.fromEntries(plan.groups.map(g => [g.key, g.key === 'international:NAME_INTL' ? 'map-keep' : 'convert']));
  let result = applyExportChoices(plan, choices);
  assert.equal(result.records[0].NAME, 'Existing'); assert.equal(result.records[0].NAME_INTL, undefined);
  assert.equal(result.records[0].COMMENT, 'ae'); assert.equal(result.defs.types.APP_X_TEXT, 'S');
  choices['international:NAME_INTL'] = 'map-replace';
  result = applyExportChoices(plan, choices);
  assert.equal(result.records[0].NAME, 'Juergen ??'); // non-BMP falls outside ADI
  assert.equal(JSON.stringify(log), original);
});
test('conflicting source declarations require an export definition; type decisions are re-preflighted', () => {
  const defsA = { userdefs: [{ name: 'X', type: 'N', spec: 'X,{1:3}' }], types: {} };
  const defsB = { userdefs: [{ name: 'X', type: 'I', spec: 'X' }], types: {} };
  const plan = prepareExport([{ X: '1' }, { X: 'ä' }], ['X'], 'adi', [{ name: 'a', defs: defsA }, { name: 'b', defs: defsB }]);
  assert.ok(plan.groups.some(g => g.key === 'definition:X'));
  const choices = Object.fromEntries(plan.groups.map(g => [g.key, g.key === 'definition:X' ? 'last' : 'convert']));
  const copy = applyExportChoices(plan, choices);
  const next = prepareExport(copy.records, copy.columns, 'adi', [], copy.defs);
  assert.ok(next.groups.some(g => g.key === 'international:X'));
  assert.equal(defsA.userdefs[0].type, 'N'); assert.equal(defsB.userdefs[0].type, 'I');
});
test('ADX escaping, APP/USERDEF metadata, and unknown-field decisions', { skip }, () => {
  const log = [{ CALL: 'OE1AB', NAME_INTL: 'é😀', NOTES: 'a <EOR> & b\r\n', APP_X_TEXT: 'x & "y"', CUSTOM: 'z' }];
  const plan = prepareExport(log, Object.keys(log[0]), 'adx', [], { userdefs: [], types: { APP_X_TEXT: 'S' } });
  const result = applyExportChoices(plan, { 'unknown:CUSTOM': 'declare' });
  const xml = serializeADX(result.records, result.columns, stamp, result.defs);
  assert.match(xml, /&lt;EOR&gt; &amp; b&#13;\n/);
  assert.match(xml, /<APP PROGRAMID="X" FIELDNAME="TEXT" TYPE="S">/);
  assert.equal(schema(xml).status, 0, schema(xml).stderr);
});
test('official ADX import fixture passes the generic schema', { skip }, () => {
  const text = readFileSync(new URL('./fixtures/adif-spec/test-qsos.adx', import.meta.url), 'utf8');
  const result = schema(text, 'generic'); assert.equal(result.status, 0, result.stderr);
});
test('official ADI conversion passes the version-specific export schema', { skip }, () => {
  const defs = {};
  const log = parseADIF(readFileSync(new URL('./fixtures/adif-spec/test-qsos.adi', import.meta.url), 'utf8'), [], 'official', undefined, undefined, defs);
  const columns = [...new Set(log.flatMap(r => Object.keys(r)))];
  const xml = serializeADX(log, columns, stamp, defs);
  const result = schema(xml); assert.equal(result.status, 0, result.stderr);
});
test('XSD checks catch malformed structures and original upstream lookahead constraints', { skip }, () => {
  const xml = value => `<ADX><HEADER/><RECORDS><RECORD><CNTY_ALT>${value}</CNTY_ALT></RECORD></RECORDS></ADX>`;
  assert.equal(schema(xml('NZ_REGIONS:Northland/Whangarei'), 'generic').status, 0);
  for (const bad of ['NZ_REGIONS:North  land/Whangarei', 'NZ_REGIONS:Northland /Whangarei', 'NZ_REGIONS:Northland/Wha--ngarei']) assert.notEqual(schema(xml(bad), 'generic').status, 0, bad);
  assert.notEqual(schema('<ADX><HEADER/><WRONG/></ADX>').status, 0);
});

test('import-only subdivision codes are scoped by the reported DXCC entity', () => {
  const canadian = prepareExport([{ DXCC: '1', STATE: 'BC' }], ['DXCC', 'STATE'], 'adx');
  assert.deepEqual(canadian.groups, []);
  const older = prepareExport([{ DXCC: '50', STATE: 'BC' }], ['DXCC', 'STATE'], 'adx');
  assert.ok(older.groups.some(g => g.key === 'deprecated:STATE'));
});
test('unknown typed fields acquire equivalent USERDEF metadata in ADX', () => {
  const plan = prepareExport([{ CUSTOM: '3' }], ['CUSTOM'], 'adx', [], { userdefs: [], types: { CUSTOM: 'N' } });
  const result = applyExportChoices(plan, { 'unknown:CUSTOM': 'declare' });
  assert.equal(result.defs.userdefs[0].type, 'N');
});

test('custom Number ranges use the full ADIF decimal syntax and enforce boundaries', () => {
  const defs = { userdefs: [{ name: 'LEVEL', type: 'N', spec: 'LEVEL,{.5:2.}' }] };
  for (const [value, errors] of [['.4', 1], ['.5', 0], ['2.', 0], ['2.1', 1]]) {
    const result = validateAdifRecords([{ LEVEL: value }], defs, { format: 'adx' });
    assert.equal(result.errors, errors, value);
  }
});

test('unused USERDEF declarations are preserved and empty ADX fields remain representable', { skip }, () => {
  const defs = { userdefs: [{ name: 'UNUSED', type: 'E', spec: 'UNUSED,{A,B}' }], types: {} };
  const plan = prepareExport([{ CALL: 'OE1AB' }], ['CALL'], 'adx', [], defs);
  const copy = applyExportChoices(plan, {});
  assert.equal(copy.defs.userdefs.length, 1);
  assert.match(serializeADX(copy.records, copy.columns, stamp, copy.defs), /ENUM="\{A,B\}">UNUSED<\/USERDEF>/);
  const empty = serializeADX([{}, { NAME: '' }], ['NAME'], stamp, defs);
  assert.equal((empty.match(/<RECORD>/g) || []).length, 2);
  assert.match(empty, /<NAME><\/NAME>/);
  assert.equal(schema(empty).status, 0);
  assert.ok(validateAdifRecords([{ QSO_DATE: '' }], {}, { format: 'adx' }).issues.some(i => i.code === 'INVALID_DATE'));
});

test('import-only angle values require an explicit ADX export decision', () => {
  assert.deepEqual(prepareExport([{ ANT_AZ: '360' }], ['ANT_AZ'], 'adx').groups, []);
  const plan = prepareExport([{ ANT_AZ: '370' }], ['ANT_AZ'], 'adx');
  assert.ok(plan.groups.some(g => g.key === 'deprecated:ANT_AZ'));
  assert.throws(() => applyExportChoices(plan, {}), /Choose/);
});

test('official ADI export retains unused Intl declarations without conversion prompts', () => {
  const defs = {};
  const log = parseADIF(readFileSync(new URL('./fixtures/adif-spec/test-qsos.adi', import.meta.url), 'utf8'), [], 'official', undefined, undefined, defs);
  const plan = prepareExport(log, [...new Set(log.flatMap(r => Object.keys(r)))], 'adi', [], defs);
  assert.deepEqual(plan.groups, []);
  assert.equal(plan.defs.userdefs.length, defs.userdefs.length);
});
