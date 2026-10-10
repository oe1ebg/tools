// The ADIF editor keeps what a file says about its fields (issue #12):
// USERDEF declarations (with enumerations and ranges) and the data type
// indicators of application-defined fields, through parse → edit → export;
// tag-shaped text inside values stays a value; conflicting declarations of
// two files are merged or reported.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseADIF, parseADIFAuto } from '../tools/shared/js/adif.js';
import { validateAdif } from '../tools/shared/js/adif-validate.js';
import { serializeADIF, adifChangedValues, emptyFieldDefs, mergeFieldDefs, forgetFieldDefs } from '../tools/adif/js/export.js';

const STAMP = '2026-10-06T00:00:00Z';

test('parseADIF: tag-shaped text inside values, also "<EOH>" in a header value, by the declared lengths', () => {
  const text = 'hdr\n<PROGRAMID:9>X <EOH> Y<EOH>\n<CALL:6>OE1ABC <NOTES:22>a <EOR> b <CALL:4>OE1A <EOR>\n<CALL:6>OE3XYZ <EOR>\n';
  const warnings = [], header = {};
  const recs = parseADIF(text, warnings, 'f', header);
  assert.deepEqual(warnings, []);
  assert.equal(header.PROGRAMID, 'X <EOH> Y');
  assert.deepEqual(recs, [{ CALL: 'OE1ABC', NOTES: 'a <EOR> b <CALL:4>OE1A' }, { CALL: 'OE3XYZ' }]);
  // and back: the export keeps the value, the validator reads it the same way
  const out = serializeADIF(recs, ['CALL', 'NOTES'], STAMP);
  assert.deepEqual(parseADIF(out, [], 'rt'), recs);
  const r = validateAdif(out, { today: '20991231' });
  assert.equal(r.errors, 0, JSON.stringify(r.issues));
  assert.equal(r.records[0].fields.NOTES, 'a <EOR> b <CALL:4>OE1A');
});

test('parseADIF: a header length running past <EOH> keeps the other header fields and USERDEFs', () => {
  const text = 'hdr <ADIF_VER:5>3.1.7 <USERDEF1:6:N>MYNUMB <PROGRAMID:30>X <USERDEF2:5:S>OTHER <EOH>\n<CALL:4>OE1A <MYNUMB:1>5 <EOR>\n';
  const warnings = [], header = {}, defs = {};
  const recs = parseADIF(text, warnings, 'f', header, undefined, defs);
  assert.deepEqual(recs, [{ CALL: 'OE1A', MYNUMB: '5' }]);
  assert.deepEqual(header, { ADIF_VER: '3.1.7', PROGRAMID: 'X' });
  assert.deepEqual(defs.userdefs.map(u => u.spec), ['MYNUMB', 'OTHER'], 'before and after the bad field');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^f: header field PROGRAMID .*past <EOH>/);
  // the export keeps the declaration; the validator reports the bad length of the source
  const fieldDefs = emptyFieldDefs();
  mergeFieldDefs(fieldDefs, defs, 'f');
  const out = serializeADIF(recs, ['CALL', 'MYNUMB'], STAMP, fieldDefs);
  assert.ok(out.includes('<USERDEF1:6:N>MYNUMB'));
  assert.ok(!validateAdif(out, { today: '20991231' }).issues.some(i => i.code === 'UNKNOWN_FIELD'));
  assert.ok(validateAdif(text, { today: '20991231' }).issues.some(i => i.code === 'FIELD_LENGTH_MISMATCH' && i.field === 'PROGRAMID'));
});

test('parseADIF: an "<EOH>" inside a correct header value is not taken for the end when a later length is wrong', () => {
  const text = 'hdr <PROGRAMID:9>has <EOH> <USERDEF1:6:N>MYNUMB <ADIF_VER:50>3.1.7 <EOH>\n<CALL:4>OE1A <MYNUMB:1>5 <EOR>\n';
  const warnings = [], header = {}, defs = {};
  const recs = parseADIF(text, warnings, 'f', header, undefined, defs);
  assert.deepEqual(recs, [{ CALL: 'OE1A', MYNUMB: '5' }]);
  assert.deepEqual(header, { PROGRAMID: 'has <EOH>', ADIF_VER: '3.1.7' });
  assert.deepEqual(defs.userdefs.map(u => u.spec), ['MYNUMB']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^f: header field ADIF_VER .*past <EOH>/, 'the field that is really wrong');
  // a length ending inside the <EOH> tag itself
  const mid = [], midHeader = {};
  assert.deepEqual(parseADIF('x <ADIF_VER:7>3.1.7 <EOH>\n<CALL:4>OE1A <EOR>\n', mid, 'g', midHeader), [{ CALL: 'OE1A' }]);
  assert.deepEqual(midHeader, { ADIF_VER: '3.1.7' });
  assert.match(mid[0], /ADIF_VER/);
});

const TYPED = 'hdr\r\n<ADIF_VER:5>3.1.7\r\n<USERDEF1:14:M>QSO_TRANSCRIPT\r\n<USERDEF2:21:E>ANTENNA,{DIPOLE,YAGI}\r\n' +
  '<USERDEF3:16:N>ELEVATION,{0:90}\r\n<USERDEF4:6:S>MY_AMP\r\n<EOH>\r\n' +
  '<CALL:6>OE1ABC <QSO_DATE:8>20261004 <TIME_ON:4>1902 <BAND:2>2m <MODE:2>FM <QSO_TRANSCRIPT:16>NAME FRED\r\n73 GL ' +
  '<ANTENNA:4>YAGI <ELEVATION:2>45 <MY_AMP:4>1 KW <APP_OE1EBG_RATING:1:N>5 <APP_OE1EBG_WX:18:M>Cloudy\r\nLight rain ' +
  '<APP_OE1EBG_MEMO:4>a\r\nb <APP_OE1EBG_TAG:7:S>one two <EOR>\r\n';

test('parseADIF: defs collect USERDEF declarations and type indicators', () => {
  const defs = {};
  parseADIF(TYPED, [], 'typed.adi', undefined, undefined, defs);
  assert.deepEqual(defs.userdefs, [
    { name: 'QSO_TRANSCRIPT', type: 'M', spec: 'QSO_TRANSCRIPT' },
    { name: 'ANTENNA', type: 'E', spec: 'ANTENNA,{DIPOLE,YAGI}' },
    { name: 'ELEVATION', type: 'N', spec: 'ELEVATION,{0:90}' },
    { name: 'MY_AMP', type: 'S', spec: 'MY_AMP' },
  ]);
  assert.deepEqual(defs.types, { APP_OE1EBG_RATING: 'N', APP_OE1EBG_WX: 'M', APP_OE1EBG_MEMO: '', APP_OE1EBG_TAG: 'S' }, 'APP_ without indicator: empty (MultilineString, IV.A.4)');
  const auto = {};
  parseADIFAuto(TYPED, [], 'typed.adi', undefined, auto);
  assert.deepEqual(auto, defs, 'parseADIFAuto passes them on');
  const utf8 = {};
  parseADIFAuto(TYPED.replace('<USERDEF4:6:S>MY_AMP', '<USERDEF4:8:S>MY_AMP_Ä'), [], 'u.adi', undefined, utf8);
  assert.equal(utf8.userdefs[3].spec, 'MY_AMP_Ä', 'a byte-counted file: read back as text');
});

test('serializeADIF with defs: USERDEF header, type indicators and multiline values round-trip', () => {
  const defs = {};
  const recs = parseADIF(TYPED, [], 'typed.adi', undefined, undefined, defs);
  const fieldDefs = emptyFieldDefs();
  assert.deepEqual(mergeFieldDefs(fieldDefs, defs, 'typed.adi'), []);
  const cols = Object.keys(recs[0]);
  const out = serializeADIF(recs, cols, STAMP, fieldDefs);
  assert.ok(out.includes('<CREATED_TIMESTAMP:15>20261006 000000\n<USERDEF1:14:M>QSO_TRANSCRIPT\n<USERDEF2:21:E>ANTENNA,{DIPOLE,YAGI}\n' +
    '<USERDEF3:16:N>ELEVATION,{0:90}\n<USERDEF4:6:S>MY_AMP\n<EOH>'), out);
  assert.ok(out.includes('<QSO_TRANSCRIPT:16>NAME FRED\r\n73 GL '), 'USERDEF M keeps its line break; the tag carries no type');
  assert.ok(out.includes('<APP_OE1EBG_RATING:1:N>5 '), 'APP type indicator kept');
  assert.ok(out.includes('<APP_OE1EBG_WX:18:M>Cloudy\r\nLight rain '));
  assert.ok(out.includes('<APP_OE1EBG_MEMO:4>a\r\nb '), 'APP without indicator: MultilineString (IV.A.4)');
  const r = validateAdif(out, { today: '20991231' });
  assert.deepEqual(r.issues.filter(i => i.severity !== 'info').map(i => i.code), []);
  const back = {};
  assert.deepEqual(parseADIF(out, [], 'rt', undefined, undefined, back), recs);
  assert.deepEqual(back.userdefs, defs.userdefs);
  assert.deepEqual(back.types, defs.types);
  assert.equal(adifChangedValues(recs, cols, fieldDefs), 0);
  // a line break in a field whose type can't hold it becomes a blank, and is counted
  const edited = [{ ...recs[0], MY_AMP: '1\nKW', APP_OE1EBG_TAG: 'x\ny' }];
  const out2 = serializeADIF(edited, cols, STAMP, fieldDefs);
  assert.ok(out2.includes('<MY_AMP:4>1 KW ') && out2.includes('<APP_OE1EBG_TAG:3:S>x y '), out2);
  assert.equal(adifChangedValues(edited, cols, fieldDefs), 2);
  // without defs: the export as before (no USERDEF header, no indicators)
  assert.ok(!serializeADIF(recs, cols, STAMP).includes('USERDEF'));
  // a removed column takes its declaration along
  forgetFieldDefs(fieldDefs, 'ANTENNA');
  forgetFieldDefs(fieldDefs, 'APP_OE1EBG_RATING');
  const out3 = serializeADIF(recs, cols.filter(c => c !== 'ANTENNA'), STAMP, fieldDefs);
  assert.ok(!out3.includes('ANTENNA') && out3.includes('<USERDEF3:6:S>MY_AMP') && out3.includes('<APP_OE1EBG_RATING:1>5 '), out3);
});

test('mergeFieldDefs: conflicting declarations from two files', () => {
  const target = emptyFieldDefs();
  const a = { userdefs: [
    { name: 'ANTENNA', type: 'E', spec: 'ANTENNA,{DIPOLE,YAGI}' },
    { name: 'ELEVATION', type: 'N', spec: 'ELEVATION,{0:90}' },
    { name: 'SWR', type: 'N', spec: 'SWR' },
    { name: 'RIGNAME', type: 'S', spec: 'RIGNAME' },
  ], types: { APP_X_RATING: 'N' } };
  const b = { userdefs: [
    { name: 'ANTENNA', type: 'E', spec: 'antenna,{yagi, LOOP}' },
    { name: 'ELEVATION', type: 'N', spec: 'ELEVATION,{-5:45}' },
    { name: 'SWR', type: 'S', spec: 'SWR' },
    { name: 'RIGNAME', type: 'S', spec: 'RIGNAME' },
    { name: 'NEW', type: 'B', spec: 'NEW' },
  ], types: { APP_X_RATING: 'S', APP_X_OTHER: 'D' } };
  assert.deepEqual(mergeFieldDefs(target, a, 'a.adi'), []);
  const msgs = mergeFieldDefs(target, b, 'b.adi');
  assert.equal(msgs.length, 4, msgs.join('\n'));
  assert.match(msgs[0], /ANTENNA.*accepts the values of both/);
  assert.match(msgs[1], /ELEVATION.*-5:90/);
  assert.match(msgs[2], /SWR has type S here, but N in a\.adi; the export keeps N/);
  assert.match(msgs[3], /APP_X_RATING has data type S here, but N in a\.adi/);
  assert.deepEqual(target.userdefs.map(u => [u.name, u.type, u.spec, u.file]), [
    ['ANTENNA', 'E', 'ANTENNA,{DIPOLE,YAGI,LOOP}', 'a.adi'],
    ['ELEVATION', 'N', 'ELEVATION,{-5:90}', 'a.adi'],
    ['SWR', 'N', 'SWR', 'a.adi'],
    ['RIGNAME', 'S', 'RIGNAME', 'a.adi'],
    ['NEW', 'B', 'NEW', 'b.adi'],
  ]);
  assert.deepEqual(target.types, { APP_X_RATING: 'N', APP_X_OTHER: 'D' });
  // an enumeration and none: no restriction, so no value becomes invalid
  const t2 = emptyFieldDefs();
  mergeFieldDefs(t2, { userdefs: [{ name: 'A', type: 'E', spec: 'A,{X,Y}' }] }, 'a.adi');
  assert.equal(mergeFieldDefs(t2, { userdefs: [{ name: 'A', type: 'E', spec: 'A' }] }, 'b.adi').length, 1);
  assert.equal(t2.userdefs[0].spec, 'A');
  // The merged log's export: the values of both files fit the widened
  // declarations; the SWR value of b.adi doesn't fit a.adi's type, and
  // the check of the export (the editor's issue list) says so.
  const recs = [{ CALL: 'OE1A', ANTENNA: 'YAGI', ELEVATION: '80', SWR: '1.5' }, { CALL: 'OE1B', ANTENNA: 'LOOP', ELEVATION: '-5', SWR: 'low' }];
  const r = validateAdif(serializeADIF(recs, ['CALL', 'ANTENNA', 'ELEVATION', 'SWR'], STAMP, target), { today: '20991231' });
  assert.deepEqual(r.issues.filter(i => i.severity === 'error').map(i => `${i.code} ${i.field} ${i.recordIndex}`), ['INVALID_NUMBER SWR 1']);
});

// The validator and the editor's parser must agree on where fields and
// QSOs end, or the editor drops the per-record issues (validateFile).
test('validator and parseADIFAuto agree on field and record boundaries', () => {
  const B = s => new TextEncoder().encode(s).length;
  const f = (n, v, len = v.length) => `<${n}:${len}>${v}`;
  const H = 'h\n<ADIF_VER:5>3.1.7\n<EOH>\n';
  const inputs = [
    // char-counted, tricky but valid
    H + f('CALL', 'OE1AB') + f('NOTES', 'literal <EOR> inside') + 'ignored annotation<EOR>\n',
    H + f('CALL', 'OE1AB') + f('NOTES', 'a <CALL:4>OE1A b') + ' <EOR>\n' + f('CALL', 'OE3XY') + '<EOR>\n',
    H + f('CALL', 'OE1AB') + f('COMMENT', '<EOH>') + '<EOR>',
    // wrong lengths
    H + f('CALL', 'OE1ABC', 9) + ' <EOR>' + f('CALL', 'OE3XYZ') + ' <EOR>\n',
    H + f('COMMENT', 'hi', 12) + '<EOR>' + f('CALL', 'OE3XYZ') + '<EOR>\n',
    H + f('CALL', 'OE1ABC', 5) + ' <EOR>\n',
    H + f('NAME', 'Max', 3) + ' Mustermann<EOR>\n',
    H + f('CALL', 'OE1ABC') + f('NOTES', 'abc', 50) + '<EOR>' + f('CALL', 'OE3XYZ') + '<EOR>',
    H + f('CALL', 'OE1ABC') + f('NOTES', 'abc', 50),
    // a length ending inside a tag-shaped sequence: legal, the rest is ignored (IV.A.6)
    H + '<CALL:5>OE1AB<QSO_DATE:8>20261010<TIME_ON:4>1200<BAND:2>2m<MODE:2>FM<NOTES:7><CALL:5> annotation<EOR>',
    H + '<CALL:5>OE1AB<NOTES:4><EOR> annotation<EOR>',
    H + f('CALL', 'OE1ABC', 12) + '\n<QSO_DATE:8>20261004 <EOR>\n',
    // byte-counted UTF-8 lengths (many loggers)
    H + f('NAME', 'Jürgen', B('Jürgen')) + f('QSO_DATE', '20261004') + '<EOR>\n',
    H + f('NAME', 'Jürgen', B('Jürgen')) + '<EOR>' + f('NAME', 'Max') + '<EOR>\n',
    H + f('QTH', 'Großenzersdorf Müllerstraße', B('Großenzersdorf Müllerstraße')) + ' ' + f('CALL', 'OE3ABC') + ' <EOR>\n' +
      f('NAME', 'Jörg', B('Jörg')) + f('CALL', 'OE3XYZ') + '<EOR>\n',
    H + f('NAME', 'Jürgen', B('Jürgen')) + f('NOTES', 'Grüße <EOR> aus Wien', B('Grüße <EOR> aus Wien')) + '<EOR>\n',
    // char-counted non-ASCII (wrong for ADI, but the lengths are right)
    H + f('NAME', 'Jürgen') + f('QTH', 'Döbling') + '<EOR>\n' + f('NAME', 'Max') + '<EOR>\n',
  ];
  for (const text of inputs) {
    const v = validateAdif(text, { today: '20991231' });
    const p = parseADIFAuto(text, [], 'x');
    assert.equal(v.records.length, p.length, `records: ${JSON.stringify(text)}`);
    v.records.forEach((r, i) => {
      assert.deepEqual(Object.keys(r.fields).sort(), Object.keys(p[i]).sort(), `fields of QSO ${i}: ${JSON.stringify(text)}`);
      assert.deepEqual(r.fields, p[i], `values of QSO ${i}: ${JSON.stringify(text)}`);
    });
  }
});

test('parseADIFAuto: a length ending inside a tag-shaped sequence holds (IV.A.1, IV.A.6)', () => {
  const w = [];
  assert.deepEqual(parseADIFAuto('<CALL:5>OE1AB<QSO_DATE:8>20261010<TIME_ON:4>1200<BAND:2>2m<MODE:2>FM<NOTES:7><CALL:5> annotation<EOR>', w, 'r'),
    [{ CALL: 'OE1AB', QSO_DATE: '20261010', TIME_ON: '1200', BAND: '2m', MODE: 'FM', NOTES: '<CALL:5' }]);
  assert.deepEqual(parseADIFAuto('<CALL:5>OE1AB<NOTES:4><EOR> annotation<EOR>', w, 'r'), [{ CALL: 'OE1AB', NOTES: '<EOR' }]);
  assert.deepEqual(w, []);
  // only a length past the end of the file is cut, at the next tag
  const t = [];
  assert.deepEqual(parseADIFAuto('<CALL:6>OE1ABC <NOTES:50>abc <EOR><CALL:6>OE3XYZ <EOR>', t, 'e'), [{ CALL: 'OE1ABC', NOTES: 'abc' }, { CALL: 'OE3XYZ' }]);
  assert.match(t[0], /past the end of the file/);
  // byte-counted lengths: read by bytes
  const b = [];
  assert.deepEqual(parseADIFAuto('<NAME:7>Jürgen<EOR><NAME:3>Max<EOR>', b, 'b'), [{ NAME: 'Jürgen' }, { NAME: 'Max' }]);
  assert.match(b.at(-1), /UTF-8 bytes/);
});

test('APP_ type from the first occurrence, also an empty one: validator and export agree', () => {
  const text = 'h\n<EOH>\n<CALL:5>OE1AB<APP_X_Y:0:N><EOR>\n<CALL:5>OE1AC<APP_X_Y:3>abc<EOR>\n';
  const r = validateAdif(text, { today: '20991231' });
  assert.ok(r.issues.some(i => i.code === 'APP_FIELD_TYPE_INCONSISTENT'), 'the N of the empty first occurrence counts');
  assert.ok(r.issues.some(i => i.code === 'INVALID_NUMBER'), 'abc checked as N');
  const defs = {};
  const recs = parseADIF(text, [], 'x', undefined, undefined, defs);
  assert.equal(defs.types.APP_X_Y, 'N');
  const target = emptyFieldDefs();
  mergeFieldDefs(target, defs, 'x');
  const back = validateAdif(serializeADIF(recs, ['CALL', 'APP_X_Y'], STAMP, target), { today: '20991231' });
  assert.ok(back.issues.some(i => i.code === 'INVALID_NUMBER'), 'the export check says the same');
});

// IV.A.4: an application-defined field without indicator is MultilineString,
// and its first occurrence in a file determines its type.
test('implicit APP_ types: conflicts across files in both orders, first occurrence within a file', () => {
  const A = 'a\n<EOH>\n<CALL:5>OE1AB<APP_DEMO_DATA:13>first\r\nsecond<EOR>\n';
  const B = 'b\n<EOH>\n<CALL:5>OE1AB<APP_DEMO_DATA:1:N>1<EOR>\n';
  const load = files => {
    const target = emptyFieldDefs(), recs = [], msgs = [];
    for (const [name, text] of files) {
      const defs = {};
      recs.push(...parseADIF(text, [], name, undefined, undefined, defs));
      msgs.push(...mergeFieldDefs(target, defs, name));
    }
    const out = serializeADIF(recs, ['CALL', 'APP_DEMO_DATA'], STAMP, target);
    return { msgs, out, r: validateAdif(out, { today: '20991231' }) };
  };
  // A first: M (no indicator) wins, both values fit; still a warning
  const ab = load([['a.adi', A], ['b.adi', B]]);
  assert.equal(ab.msgs.length, 1);
  assert.match(ab.msgs[0], /APP_DEMO_DATA has data type N here, but M \(no indicator\) in a\.adi/);
  assert.ok(ab.out.includes('<APP_DEMO_DATA:13>first\r\nsecond '), 'line break kept, no indicator');
  assert.equal(ab.r.errors, 0, JSON.stringify(ab.r.issues));
  // B first: N wins; A's multiline text is the visible loss in the export check
  const ba = load([['b.adi', B], ['a.adi', A]]);
  assert.equal(ba.msgs.length, 1);
  assert.match(ba.msgs[0], /APP_DEMO_DATA has data type M \(no indicator\) here, but N in b\.adi; the export writes N/);
  assert.ok(ba.out.includes('<APP_DEMO_DATA:12:N>first second '));
  assert.deepEqual(ba.r.issues.filter(i => i.severity === 'error').map(i => `${i.code} ${i.field} ${i.recordIndex}`), ['INVALID_NUMBER APP_DEMO_DATA 1']);
  // an explicit :M and none are the same type: no conflict
  assert.deepEqual(load([['a.adi', A], ['m.adi', 'm\n<EOH>\n<CALL:5>OE1AB<APP_DEMO_DATA:1:M>x<EOR>\n']]).msgs, []);
  // within one file the first occurrence decides (validator)
  const one = validateAdif('h\n<EOH>\n<CALL:5>OE1AB<APP_DEMO_DATA:3>a b<EOR>\n<CALL:5>OE1AC<APP_DEMO_DATA:3:N>abc<EOR>\n', { today: '20991231' });
  const codes = one.issues.map(i => `${i.severity} ${i.code} ${i.recordIndex ?? ''}`);
  assert.ok(codes.includes('warning APP_FIELD_TYPE_INCONSISTENT 1'), codes.join());
  assert.ok(!codes.some(c => c.includes('INVALID_NUMBER')), 'checked as M, the type of the first occurrence');
});
