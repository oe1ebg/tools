// Cross-check of the ADIF validator and exports against independent tools:
//   adifmt        ADIF Multitool (github.com/flwyd/adif-multitool): types,
//                 enumerations, ranges ("validate" exits 1 on errors)
//   adif-checker  github.com/k0swe/adif-checker: ADI syntax only (tags,
//                 lengths, stray bytes)
// Both are pinned in tests/tools/go.mod and built into tests/tools/bin/ by
// `just crosscheck-tools` (Go, or the golang image). Without them the
// tests skip, unless ADIF_CROSSCHECK=require (CI), which makes that a failure.
//
// Per input file the question is the same for every tool: does it find
// errors? The expectation follows from our own result (the validator's
// errors for adifmt, its syntax errors for adif-checker); where a tool
// deliberately differs, the case says so with the reason from the spec.
//
// A disagreement is not automatically our bug: look the case up in the ADIF
// specification (https://adif.org.uk/317/ADIF_317.htm) first, then fix our
// code, or record the tool's deviation here with the spec section.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateAdif } from '../tools/shared/js/adif-validate.js';
import { toADIF } from '../tools/confirm/js/export.js';
import { TEMPLATES, exampleValues } from '../tools/confirm/js/templates.js';
import { headerSnapshot } from '../tools/confirm/js/model.js';
import { SOURCE, whole, groups, groupText, roundTrip } from './adif-official.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures', 'adif');
const TODAY = '20261007';
const REQUIRED = process.env.ADIF_CROSSCHECK === 'require';

// $ADIFMT / $ADIF_CHECKER, else tests/tools/bin/, else PATH.
function findTool(name, envVar) {
  if (process.env[envVar]) return process.env[envVar];
  const local = join(HERE, 'tools', 'bin', process.platform === 'win32' ? `${name}.exe` : name);
  if (existsSync(local)) return local;
  return spawnSync(name, [], { stdio: 'ignore' }).error ? null : name;
}
const TOOLS = {
  adifmt: { bin: findTool('adifmt', 'ADIFMT'), args: f => ['validate', f] },
  'adif-checker': { bin: findTool('adif-checker', 'ADIF_CHECKER'), args: f => [f] },
};
const missing = Object.entries(TOOLS).filter(([, t]) => !t.bin).map(([name]) => name);
const skip = missing.length ? `not found: ${missing.join(', ')} (just crosscheck-tools)` : false;

const work = mkdtempSync(join(tmpdir(), 'adif-crosscheck-'));
let fileNo = 0;
// Runs a tool on `text` (written to a temp file): { errors, output }.
function run(tool, text) {
  const file = join(work, `in-${++fileNo}.adi`);
  writeFileSync(file, text);
  const r = spawnSync(TOOLS[tool].bin, TOOLS[tool].args(file), { encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.error) throw r.error;
  return { errors: r.status !== 0, output: `${r.stderr}${r.stdout}`.trim().split('\n').slice(-5).join('\n') };
}

// What adif-checker looks at: the structure, not the values.
const SYNTAX_CODES = new Set(['UNRECOVERABLE_PARSE_ERROR', 'MALFORMED_FIELD', 'TRUNCATED_FIELD', 'FIELD_LENGTH_MISMATCH',
  'MISSING_EOH', 'DUPLICATE_EOH', 'MISSING_EOR', 'MALFORMED_RECORD']);
function expectations(text) {
  const r = validateAdif(text, { today: TODAY });
  const errors = r.issues.filter(i => i.severity === 'error');
  return {
    ours: errors.map(i => i.code),
    adifmt: errors.length > 0,
    'adif-checker': errors.some(i => SYNTAX_CODES.has(i.code)),
  };
}

// The check of one input against both tools. `differs`: { tool: { errors,
// why } } for a deliberate, documented difference from expectations().
function crossCheck(label, text, differs = {}) {
  const exp = expectations(text);
  for (const tool of Object.keys(TOOLS)) {
    const expected = differs[tool] ? differs[tool].errors : exp[tool];
    const got = run(tool, text);
    assert.equal(got.errors, expected,
      `${label}: ${tool} ${got.errors ? 'finds errors' : 'finds none'}, expected ${expected ? 'errors' : 'none'}` +
      ` (our errors: ${exp.ours.join(', ') || 'none'}${differs[tool] ? `; documented difference: ${differs[tool].why}` : ''}).` +
      ` Check the ADIF spec before changing either side (AGENTS.md).\n${got.output}`);
  }
}

// The one test that fails without the tools when they are required (CI).
test('cross-check tools', { skip: REQUIRED ? false : skip }, t => {
  if (missing.length) assert.fail(`ADIF_CROSSCHECK=require, but not found: ${missing.join(', ')}`);
  const v = spawnSync(TOOLS.adifmt.bin, ['version'], { encoding: 'utf8' });
  t.diagnostic(`adifmt: ${v.stdout.split('\n')[0]}; adif-checker: ${TOOLS['adif-checker'].bin}`);
});

// --- our fixtures ----------------------------------------------------------

const FIXTURE_DIFFERS = {
  'invalid-length.adi': {
    // <CALL:5>OE1ABC: read as the declared 5 characters; the "C" after it is
    // outside any field and ignored (ADIF 3.1.7 IV.A.6). adifmt agrees; we
    // add a warning. adif-checker rejects the stray byte.
    'adif-checker': { errors: true, why: 'adif-checker rejects characters between fields; IV.A.6 says they are ignored' },
  },
};
for (const name of readdirSync(FIXTURES).filter(n => n.endsWith('.adi')).sort()) {
  test(`cross-check fixture ${name}`, { skip }, () => {
    crossCheck(name, readFileSync(join(FIXTURES, name), 'utf8'), FIXTURE_DIFFERS[name]);
  });
}

// --- the official test QSOs --------------------------------------------------

// The generator writes notes between QSOs ("==== Not including …", "This
// is a real call …"). adif-checker rejects text between records; the spec
// (IV.A.2) only lists Header, Record, Record…, and the spec's own test file
// has such text, which adifmt and we accept. Checked once as is, stripped
// everywhere else (no value in this file contains "<EOR>").
const stripComments = text => text.replace(/(<eor>)[^<]*/gi, '$1\r\n\r\n');
const BETWEEN_RECORDS = { 'adif-checker': { errors: true, why: 'adif-checker rejects text between records (the official file has it)' } };

test(`cross-check official test QSOs: whole file as published (${whole.records.length} QSOs)`, { skip }, () => {
  crossCheck('official test QSOs', SOURCE, BETWEEN_RECORDS);
});
test('cross-check official test QSOs: whole file without the text between records', { skip }, () => {
  crossCheck('official test QSOs (stripped)', stripComments(SOURCE));
});
for (const [name, idx] of groups) {
  test(`cross-check official test QSOs: ${name} (${idx.length} QSOs)`, { skip }, () => {
    crossCheck(name, stripComments(groupText(idx)));
  });
}

// --- our exports -------------------------------------------------------------

test('cross-check ADIF editor export of the official test QSOs', { skip }, () => {
  crossCheck('editor export', roundTrip(SOURCE).adi);
});

// Typed USERDEF/APP fields with line breaks and tag-shaped text in values
// (issue #12), as the editor writes them back.
for (const name of ['userdef-typed.adi', 'tag-in-value.adi']) {
  test(`cross-check ADIF editor export of fixture ${name}`, { skip }, () => {
    crossCheck(`editor export of ${name}`, roundTrip(readFileSync(join(FIXTURES, name), 'utf8')).adi);
  });
}

// Annotation text after a value, outside any field: ignored (IV.A.6), so the
// declared length holds even with "<EOR>" inside the value.
test('cross-check annotation text after a value with <EOR> inside it', { skip }, () => {
  crossCheck('annotated value',
    'x\r\n<ADIF_VER:5>3.1.7\r\n<EOH>\r\n<CALL:5>OE1AB<QSO_DATE:8>20261004<TIME_ON:4>1200<BAND:3>20m<MODE:3>SSB' +
    '<NOTES:20>literal <EOR> insideignored annotation<EOR>\r\n',
    { 'adif-checker': { errors: true, why: 'adif-checker rejects characters between fields; IV.A.6 says they are ignored' } });
});

// A length ending inside a tag-shaped sequence: legal, the rest of it is
// ignored text (IV.A.1, IV.A.6).
for (const [label, notes] of [['<NOTES:7><CALL:5> annotation', '<NOTES:7><CALL:5> annotation'], ['<NOTES:4><EOR> annotation', '<NOTES:4><EOR> annotation']]) {
  test(`cross-check length ending inside a tag: ${label}`, { skip }, () => {
    crossCheck(label, 'x\r\n<ADIF_VER:5>3.1.7\r\n<EOH>\r\n<CALL:5>OE1AB<QSO_DATE:8>20261010<TIME_ON:4>1200<BAND:3>20m<MODE:3>SSB' + notes + '<EOR>\r\n',
      { 'adif-checker': { errors: true, why: 'adif-checker rejects characters between fields; IV.A.6 says they are ignored' } });
  });
}

test('cross-check confirmation-log exports (every template)', { skip }, () => {
  const header = {
    operator: 'OE1EBG', station: 'OE1XKS', freq: '145,500', mode: 'FM', myGrid: 'jn88ef12ab', myQth: 'Wien Döbling',
    viaRepeater: false, repeaterCall: 'OE1XUU', repeaterFreq: '438,950', repeaterShift: '-7,6', repeaterTone: '88.5',
  };
  const loc = { lat: 48.2, lon: 16.37, maidenhead: 'JN88ee12', label: 'Straße <½>', confidence: 'high', input: 'x', origin: 'search' };
  for (const tpl of TEMPLATES) {
    const base = { fields: exampleValues(tpl), note: 'Notiz\nmit <Zeilenumbruch>' };
    const entries = [
      { id: 'a', seq: 1, call: 'oe1aaa', ts: '2026-10-04T23:59:59.999Z', viaRepeater: true, snap: headerSnapshot(header), ...base, loc },
      { id: 'b', seq: 2, call: 'OE3XYZ/P', ts: '2026-10-05T00:00:00Z', viaRepeater: false, snap: headerSnapshot(header), ...base },
    ];
    crossCheck(`confirm template ${tpl.key}`, toADIF({ id: tpl.key, title: 'T <x>', template: tpl.key, header }, entries, '2026-10-06T12:34:56.789Z'));
  }
});

// --- single values ----------------------------------------------------------

// One QSO with one field set (or replaced), CR LF separated as the official
// file. Invalid values first, then valid edge cases nobody should flag.
const BASE = { CALL: 'OE1ABC', QSO_DATE: '20261004', TIME_ON: '1200', BAND: '20m', FREQ: '14.200', MODE: 'SSB' };
const qso = fields => 'cross-check\r\n<ADIF_VER:5>3.1.7\r\n<EOH>\r\n' +
  Object.entries({ ...BASE, ...fields }).map(([k, v]) => `<${k}:${v.length}>${v}`).join('\r\n') + '\r\n<EOR>\r\n';
const VALUES = [
  // [fields, code we report (or null: no error), documented differences]
  [{ QSO_DATE: '20260230' }, 'INVALID_DATE'],
  [{ QSO_DATE: '19291231' }, 'INVALID_DATE'],
  [{ TIME_ON: '2460' }, 'INVALID_TIME'],
  [{ TIME_ON: '12345' }, 'INVALID_TIME'],
  [{ BAND: '11m' }, 'INVALID_ENUM'],
  [{ MODE: 'FOO' }, 'INVALID_ENUM'],
  [{ FREQ: 'abc' }, 'INVALID_NUMBER'],
  [{ TX_PWR: '5W' }, 'INVALID_NUMBER'],
  [{ CQZ: '41' }, 'NUMBER_OUT_OF_RANGE'],
  [{ ITUZ: '0' }, 'NUMBER_OUT_OF_RANGE'],
  [{ AGE: '-1' }, 'NUMBER_OUT_OF_RANGE'],
  [{ K_INDEX: '10' }, 'NUMBER_OUT_OF_RANGE'],
  [{ QSO_RANDOM: 'X' }, 'INVALID_BOOLEAN'],
  [{ GRIDSQUARE: 'JN8' }, 'INVALID_GRIDSQUARE'],
  [{ GRIDSQUARE: 'SZ88' }, 'INVALID_GRIDSQUARE',
    { adifmt: { errors: false, why: 'adifmt does not check the letter range; the first pair is A-R (spec III.A.1)' } }],
  [{ LAT: 'N48 12.345' }, 'INVALID_LOCATION'],
  [{ LAT: 'N091 00.000' }, 'INVALID_LOCATION'],
  [{ DXCC: '9999' }, 'INVALID_ENUM'],
  [{ DXCC: '291', STATE: 'XX' }, 'INVALID_ENUM'],
  [{ CONT: 'XX' }, 'INVALID_ENUM'],
  [{ PROP_MODE: 'REPEATER' }, 'INVALID_ENUM'],
  [{ QSL_RCVD: 'X' }, 'INVALID_ENUM'],
  [{ CREDIT_SUBMITTED: 'DXCC:CARD&FAX' }, 'INVALID_ENUM',
    { adifmt: { errors: false, why: 'adifmt does not check the QSL media of a CreditList item (spec III.A, CreditList)' } }],
  [{ SOTA_REF: 'OE-WI-001' }, 'INVALID_DATATYPE'],
  [{ IOTA: 'EU5' }, 'INVALID_DATATYPE'],
  [{ POTA_REF: 'foo' }, 'INVALID_DATATYPE'],
  [{ WWFF_REF: 'foo' }, 'INVALID_DATATYPE'],
  [{ COMMENT: 'a\r\nb' }, 'INVALID_CHARACTER'],
  [{ COMMENT: 'Grüße' }, 'INVALID_CHARACTER',
    { 'adif-checker': { errors: true, why: 'adif-checker counts bytes: the UTF-8 umlauts leave stray bytes after the length' } }],
  [{ NAME_INTL: 'Joerg' }, 'INTL_FIELD_IN_ADI',
    { adifmt: { errors: false, why: 'adifmt accepts Intl fields in .adi; the spec forbids them there (IV.A.1)' } }],
  [{ ANT_AZ: '370' }, null,
    { adifmt: { errors: true, why: 'the spec calls ANT_AZ outside 0-360 import-only (field ANT_AZ); we report an info' } }],
  // valid
  [{ BAND: '20M' }, null],
  [{ QSO_DATE: '20240229' }, null],
  [{ TIME_ON: '235959' }, null],
  [{ NOTES: 'a\r\nb' }, null],
  [{ APP_OE1EBG_WX: 'a\r\nb' }, null],
  // tag-shaped text inside a value, the declared length is right (IV.A.1);
  // we add a TAG_IN_VALUE or RECORD_END_IN_VALUE warning, no error
  [{ NOTES: 'a <EOR> b <EOH>' }, null],
  [{ COMMENT: 'copied <CALL:4>OE1A' }, null],
  [{ GRIDSQUARE: 'jn88ef12' }, null],
  [{ FREQ: '14.07' }, null],
  [{ MODE: 'MFSK', SUBMODE: 'FT4' }, null],
  [{ CONTEST_ID: 'MY-OWN' }, null],
  [{ VUCC_GRIDS: 'JN88,JN89' }, null],
];
for (const [fields, code, differs] of VALUES) {
  const label = Object.entries(fields).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ');
  test(`cross-check value ${label}`, { skip }, () => {
    const text = qso(fields);
    const ours = expectations(text).ours;
    if (code) assert.ok(ours.includes(code), `${label}: we report ${ours.join(', ') || 'no error'}, expected ${code}`);
    else assert.deepEqual(ours, [], `${label}: we report ${ours.join(', ')}`);
    crossCheck(label, text, differs);
  });
}
