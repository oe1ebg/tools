// The official ADIF test QSOs (tests/fixtures/adif-spec/test-qsos.adi, from
// the ADIF resources archive via scripts/build_adif_spec.py), split into
// groups by the part of the spec they exercise. Shared by
// adif-official.test.mjs and adif-crosscheck.test.mjs.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateAdif } from '../tools/shared/js/adif-validate.js';
import { parseADIF } from '../tools/shared/js/adif.js';
import { serializeADIF, emptyFieldDefs, mergeFieldDefs } from '../tools/adif/js/export.js';

export const SOURCE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'adif-spec', 'test-qsos.adi'), 'utf8');
// The QSOs are dated around the archive's release; no DATE_IN_FUTURE.
export const TODAY = '20991231';
export const check = text => validateAdif(text, { today: TODAY });

export const whole = check(SOURCE);
export const HEADER = SOURCE.slice(0, whole.records[0].offset);
export const USERDEFS = new Set(Object.entries(whole.header.fields)
  .filter(([k]) => /^USERDEF\d+$/.test(k)).map(([, v]) => v.split(',')[0].toUpperCase()));

// Groups in order of precedence: a QSO belongs to the first that matches.
// The generator puts the subdivisions and DXCC entities into thousands of
// QSOs, the scalar fields into a handful each.
const GROUPS = [
  ['user-defined fields', n => USERDEFS.has(n)],
  ['application-defined fields', n => n.startsWith('APP_')],
  ['primary subdivisions (STATE, MY_STATE)', n => n === 'STATE' || n === 'MY_STATE'],
  ['secondary subdivisions (CNTY, MY_CNTY, *_ALT)', n => /^(MY_)?CNTY(_ALT)?$/.test(n)],
  ['DXCC entities (DXCC, MY_DXCC)', n => n === 'DXCC' || n === 'MY_DXCC'],
  ['contests, credits, awards', n => /^(CONTEST_ID|CREDIT_|AWARD_)/.test(n)],
  ['QSL and upload status', n => /QSL|_QSO_(UP|DOWN)LOAD_/.test(n)],
  ['bands, frequencies, modes', n => /^(BAND|FREQ)_RX$|^SUBMODE$/.test(n)],
];
const QSO_FIELDS = new Set(['QSO_DATE', 'TIME_ON', 'TIME_OFF', 'CALL', 'BAND', 'FREQ', 'MODE']);
function groupOf(fields) {
  const names = Object.keys(fields);
  for (const [name, match] of GROUPS) if (names.some(match)) return name;
  // only the fields every QSO has: the BAND, FREQ and MODE enumerations
  return names.every(n => QSO_FIELDS.has(n)) ? 'bands, frequencies, modes' : 'other fields';
}

// Source text per QSO, up to the next one (the generator's "====" comments
// between QSOs come along; text outside tags is ignored).
const recordText = i => SOURCE.slice(whole.records[i].offset, whole.records[i + 1]?.offset ?? SOURCE.length);
export const groups = new Map([...GROUPS.map(([name]) => name), 'other fields'].map(name => [name, []]));
whole.records.forEach((r, i) => groups.get(groupOf(r.fields)).push(i));

// The ADIF editor's round trip: load, export every column, as the editor does
// (with the file's USERDEF declarations and type indicators, js/app.js).
export function roundTrip(text) {
  const defs = {};
  const records = parseADIF(text, [], 'test-qsos.adi', undefined, undefined, defs);
  const fieldDefs = emptyFieldDefs();
  mergeFieldDefs(fieldDefs, defs, 'test-qsos.adi');
  const columns = [...new Set(records.flatMap(r => Object.keys(r)))];
  return { records, adi: serializeADIF(records, columns, '2026-10-08T00:00:00Z', fieldDefs) };
}

// A group as its own ADI file: the header plus the group's QSOs.
export const groupText = idx => HEADER + idx.map(recordText).join('');
