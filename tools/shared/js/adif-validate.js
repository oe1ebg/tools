// ADIF validator for .adi text: validateAdif(source) checks a file against
// ADIF 3.1.7 and returns every issue it finds, without throwing on bad
// input. Pure (no DOM), used by the ADIF editor and the node tests.
//
// Pipeline: tolerant scanner (tags, values, resync after a wrong length)
// -> header + records -> structure checks -> header checks -> per-field
// checks driven by the generated spec data (adif-spec-data.js: data types,
// fields, enumerations) -> cross-field checks -> heuristics -> result.
//
// Severities: error = ADIF syntax or specification violation (any error:
// valid === false); warning = valid but inconsistent or suspicious;
// info = interoperability hint. Codes are stable (tests and the README
// list them); messages are for people and may change.
//
// Top-level names start with "av" or "AV_": the single-file bundle shares
// one scope with the editor's own modules.

import { ADIF_SPEC_VERSION, ADIF_SPEC_DATATYPES, ADIF_SPEC_FIELDS, ADIF_SPEC_ENUMS } from './adif-spec-data.js';
import { isValidLocator } from './maidenhead.js';

const AV_HEADER_FIELDS = new Set(Object.keys(ADIF_SPEC_FIELDS).filter(n => ADIF_SPEC_FIELDS[n].header));
const AV_INDICATOR_TYPES = Object.fromEntries(Object.entries(ADIF_SPEC_DATATYPES)
  .filter(([, d]) => d.indicator).map(([name, d]) => [d.indicator, name]));
// A tag: '<' + name + optional ':length' + optional ':type' + '>'.
const AV_TAG_RE = /<([^<>]*)>/y;
// A plausible tag inside a value (EOR/EOH, or a name with a length):
// a declared length running into it was too long.
const AV_NEXT_TAG_RE = /<(?:eor|eoh|[A-Za-z][A-Za-z0-9_]*:\d+(?::[A-Za-z])?)>/iy;
const AV_FIELD_NAME_RE = /^[^\s,:<>{}](?:[^,:<>{}]*[^\s,:<>{}])?$/;
const AV_APP_FIELD_RE = /^APP_([^_]+)_(.+)$/;
const AV_LOCATION_RE = /^([NSEW])(\d{3}) (\d{2}\.\d{3})$/i;
const AV_FORMAT_RES = {
  IOTARefNo: /^(?:AF|AN|AS|EU|NA|OC|SA)-(?!000)\d{3}$/i,
  // POTA/SOTA/WWFF patterns as in ADIF Multitool (adif/spec/validate.go)
  POTARef: /^[A-Z0-9]{1,4}-\d{4,5}(?:@(?:[A-Z]{2}|F|G|9M)-[A-Z0-9]{2,9})?$/i,
  SOTARef: /^[A-Z0-9]{1,4}\/[A-Z]{2}-\d{3}$/i,
  WWFFRef: /^[A-Z0-9]{1,4}FF-\d{4}$/i,
};
// City fields and the locator field a locator in them was probably meant for.
const AV_CITY_FIELDS = { MY_CITY: 'MY_GRIDSQUARE', MY_CITY_INTL: 'MY_GRIDSQUARE', QTH: 'GRIDSQUARE', QTH_INTL: 'GRIDSQUARE' };
const AV_QSO_FIELDS = ['CALL', 'QSO_DATE', 'TIME_ON', 'MODE'];

// Enumeration lookups, built once: name -> Map(UPPER value -> value).
const AV_ENUM_INDEX = new Map();
function avEnumIndex(name) {
  if (!AV_ENUM_INDEX.has(name)) {
    const e = ADIF_SPEC_ENUMS[name];
    let idx = null;
    if (e) {
      idx = { values: new Map(), byScope: null, importOnly: new Set((e.importOnly || []).map(v => v.toUpperCase())) };
      for (const v of e.values || []) idx.values.set(v.toUpperCase(), v);
      if (e.byScope) {
        idx.byScope = new Map();
        for (const [scope, vals] of Object.entries(e.byScope)) {
          idx.byScope.set(scope, new Set(vals.map(v => v.toUpperCase())));
          for (const v of vals) idx.values.set(v.toUpperCase(), v);
        }
      }
    }
    AV_ENUM_INDEX.set(name, idx);
  }
  return AV_ENUM_INDEX.get(name);
}

// Submode -> its mode(s), upper case.
const AV_SUBMODE_MODES = new Map();
for (const [mode, subs] of Object.entries(ADIF_SPEC_ENUMS.Submode?.byScope || {})) {
  for (const s of subs) {
    const k = s.toUpperCase();
    if (!AV_SUBMODE_MODES.has(k)) AV_SUBMODE_MODES.set(k, []);
    AV_SUBMODE_MODES.get(k).push(mode.toUpperCase());
  }
}

function avShort(v) {
  const s = String(v).replace(/\r/g, '\\r').replace(/\n/g, '\\n');
  return s.length > 40 ? s.slice(0, 39) + '…' : s;
}

// "3.1.7" > "3.1.6": compares X.Y.Z numerically; null when not X.Y.Z.
function avCompareVersion(a, b) {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

function avDaysInMonth(y, m) {
  return [31, (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}

// Problems with a Date value (YYYYMMDD, 1930 <= YYYY), or ''.
function avDateProblem(v) {
  if (!/^\d{8}$/.test(v)) return 'is not a date in YYYYMMDD format';
  const y = +v.slice(0, 4), m = +v.slice(4, 6), d = +v.slice(6, 8);
  if (y < 1930) return 'has a year before 1930';
  if (m < 1 || m > 12) return 'has no valid month';
  if (d < 1 || d > avDaysInMonth(y, m)) return `has no valid day (${y}-${String(m).padStart(2, '0')} has ${avDaysInMonth(y, m)} days)`;
  return '';
}

// Problems with a Time value (HHMM or HHMMSS), or ''.
function avTimeProblem(v) {
  if (!/^\d{4}(?:\d{2})?$/.test(v)) return 'is not a time in HHMM or HHMMSS format';
  if (+v.slice(0, 2) > 23) return 'has an hour above 23';
  if (+v.slice(2, 4) > 59) return 'has a minute above 59';
  if (v.length === 6 && +v.slice(4, 6) > 59) return 'has a second above 59';
  return '';
}

// Offset -> { line, column } (both 1-based).
function avLineIndex(source) {
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source.charCodeAt(i) === 10) starts.push(i + 1);
  return offset => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
    }
    return { line: lo + 1, column: offset - starts[lo] + 1 };
  };
}

/* ---------- scanner ---------- */

// Tokens of an .adi text: { kind: 'tag'|'eoh'|'eor', name, type, value,
// offset (of '<'), valueOffset }. Recoverable syntax problems are reported
// through issue(); the scan never stops early.
function avScan(source, issue) {
  const tokens = [];
  let pos = 0;
  while (pos < source.length) {
    const lt = source.indexOf('<', pos);
    if (lt < 0) break;
    AV_TAG_RE.lastIndex = lt;
    const m = AV_TAG_RE.exec(source);
    if (!m) {
      issue('error', 'MALFORMED_FIELD', "'<' without a closing '>' before the next '<' or the end of the file.", { offset: lt });
      pos = lt + 1;
      continue;
    }
    const tagEnd = lt + m[0].length;
    const parts = m[1].split(':');
    const rawName = parts[0];
    const upper = rawName.toUpperCase();
    if ((upper === 'EOR' || upper === 'EOH') && parts.length === 1) {
      tokens.push({ kind: upper.toLowerCase(), name: upper, offset: lt });
      pos = tagEnd;
      continue;
    }
    if (!AV_FIELD_NAME_RE.test(rawName) || parts.length > 3) {
      issue('error', 'MALFORMED_FIELD', `<${avShort(m[1])}> is no valid field tag (<NAME:LENGTH> or <NAME:LENGTH:TYPE>).`, { offset: lt });
      pos = tagEnd;
      continue;
    }
    if (parts.length === 1) {
      issue('error', 'MALFORMED_FIELD', `<${avShort(rawName)}> has no length (<NAME:LENGTH>); skipped.`, { offset: lt, field: upper });
      pos = tagEnd;
      continue;
    }
    if (!/^\d+$/.test(parts[1]) || (parts.length === 3 && !/^[A-Za-z]$/.test(parts[2]))) {
      issue('error', 'MALFORMED_FIELD', `<${avShort(m[1])}>: the length must be digits and the type a single letter.`, { offset: lt, field: upper });
      pos = tagEnd;
      continue;
    }
    const len = parseInt(parts[1], 10);
    const type = parts.length === 3 ? parts[2].toUpperCase() : '';
    const end = tagEnd + len;
    const available = source.slice(tagEnd, Math.min(end, source.length));
    // A declared length that runs into the next tag: cut the value there
    // and continue with that tag (resync), so one wrong length doesn't
    // swallow the following fields.
    let cut = -1;
    for (let i = available.indexOf('<'); i >= 0; i = available.indexOf('<', i + 1)) {
      AV_NEXT_TAG_RE.lastIndex = tagEnd + i;
      if (AV_NEXT_TAG_RE.test(source)) { cut = i; break; }
    }
    if (cut >= 0) {
      const value = available.slice(0, cut).replace(/\s+$/, '');
      issue('error', 'FIELD_LENGTH_MISMATCH',
        `<${upper}:${len}> declares ${len} characters, but the value "${avShort(value)}" has ${value.length} before the next tag.`,
        { offset: lt, field: upper, value });
      tokens.push({ kind: 'tag', name: upper, type, value, offset: lt, valueOffset: tagEnd });
      pos = tagEnd + cut;
      continue;
    }
    if (end > source.length) {
      issue('error', 'TRUNCATED_FIELD', `<${upper}:${len}> declares ${len} characters, but the file ends after ${available.length}.`,
        { offset: lt, field: upper, value: available });
      tokens.push({ kind: 'tag', name: upper, type, value: available, offset: lt, valueOffset: tagEnd, unsure: true });
      break;
    }
    // Text right after the value (no separator, no tag): the declared
    // length is too short. The value is read as declared, as other
    // programs would read it.
    const rest = /^[^\s<]+/.exec(source.slice(end, end + 200));
    if (rest) {
      issue('error', 'FIELD_LENGTH_MISMATCH',
        `<${upper}:${len}>: the value "${avShort(available)}" (${len} characters as declared) is followed directly by "${avShort(rest[0])}"; the declared length does not match the value.`,
        { offset: lt, field: upper, value: available });
    }
    tokens.push({ kind: 'tag', name: upper, type, value: available, offset: lt, valueOffset: tagEnd, unsure: !!rest });
    pos = end;
  }
  return tokens;
}

/* ---------- value checks ---------- */

// Checks one value against a data type; calls report(severity, code, message).
// def: the field's spec entry (min/max/enum) or a USERDEF/APP stand-in.
function avCheckType(value, typeName, def, name, report, ctx) {
  const v = value;
  const say = text => `${name} "${avShort(v)}" ${text}`;
  const multiline = typeName === 'MultilineString' || typeName === 'IntlMultilineString';
  if (typeName === 'IntlString' || typeName === 'IntlMultilineString' || typeName === 'IntlCharacter') {
    report('error', 'INTL_FIELD_IN_ADI', `${name} has type ${typeName}, which ADIF allows only in ADX files, not in .adi.`);
    return;
  }
  // Every other type is ASCII (Character: codes 32-126).
  const bad = /[^\x20-\x7e\r\n]/.exec(v);
  if (bad) {
    report('error', 'INVALID_CHARACTER', say(`contains "${bad[0]}", which is not printable ASCII (ADI files are ASCII).`));
  }
  if (/[\r\n]/.test(v)) {
    if (!multiline) report('error', 'INVALID_CHARACTER', say('contains a line break, which only MultilineString fields may.'));
    else if (/[\r\n]/.test(v.replace(/\r\n/g, ''))) report('info', 'LINE_BREAK_NOT_CRLF', `${name}: line breaks in ADIF are CR LF; this value has bare CR or LF.`);
  }
  switch (typeName) {
    case 'Boolean':
      if (!/^[YN]$/i.test(v)) report('error', 'INVALID_BOOLEAN', say('is not a Boolean (Y or N).'));
      return;
    case 'Character':
      if (v.length !== 1) report('error', 'INVALID_DATATYPE', say('is not a single character.'));
      return;
    case 'Digit':
      if (!/^\d$/.test(v)) report('error', 'INVALID_NUMBER', say('is not a single digit.'));
      return;
    case 'Number': case 'Integer': case 'PositiveInteger': {
      const re = typeName === 'Number' ? /^-?(?:\d+\.?\d*|\.\d+)$/ : typeName === 'Integer' ? /^-?\d+$/ : /^\d+$/;
      if (!re.test(v)) {
        report('error', 'INVALID_NUMBER', say(`is not ${typeName === 'Number' ? 'a Number' : `an ${typeName}`} (digits, ${typeName === 'Number' ? 'optional minus sign and decimal point' : typeName === 'Integer' ? 'optional minus sign' : 'no sign'}).`));
        return;
      }
      const n = parseFloat(v);
      const min = def?.min ?? ADIF_SPEC_DATATYPES[typeName]?.min;
      const max = def?.max ?? ADIF_SPEC_DATATYPES[typeName]?.max;
      if ((min !== undefined && n < min) || (max !== undefined && n > max)) {
        const range = max === undefined ? `at least ${min}` : min === undefined ? `at most ${max}` : `${min} to ${max}`;
        if (def?.rangeImportOnly) report('info', 'NUMBER_OUT_OF_RANGE', say(`is outside ${range}; ADIF allows that on import only (normalize it for export).`));
        else report('error', 'NUMBER_OUT_OF_RANGE', say(`is outside the allowed range (${range}).`));
      }
      return;
    }
    case 'Date': {
      const p = avDateProblem(v);
      if (p) report('error', 'INVALID_DATE', say(p + '.'));
      else if (ctx.today && v > ctx.today) report('warning', 'DATE_IN_FUTURE', say('lies in the future.'));
      return;
    }
    case 'Time': {
      const p = avTimeProblem(v);
      if (p) report('error', 'INVALID_TIME', say(p + '.'));
      return;
    }
    case 'GridSquare':
      avCheckGrid(v, name, report, 8);
      return;
    case 'GridSquareExt':
      if (!/^[A-X]{2}(?:\d{2})?$/i.test(v)) report('error', 'INVALID_GRIDSQUARE', say('is not a locator extension (characters 9-10 as letters A-X, optionally 11-12 as digits).'));
      return;
    case 'GridSquareList':
      for (const item of v.split(',')) avCheckGrid(item, name, report, 8);
      return;
    case 'Location': {
      const m = AV_LOCATION_RE.exec(v);
      const isLat = /(?:^|_)LAT$/.test(name), isLon = /(?:^|_)LON$/.test(name);
      if (!m) { report('error', 'INVALID_LOCATION', say('is not a Location (XDDD MM.MMM, e.g. N048 12.345).')); return; }
      const dir = m[1].toUpperCase(), deg = +m[2], min = +m[3];
      if (min >= 60) report('error', 'INVALID_LOCATION', say('has minutes of 60 or more.'));
      else if (isLat && !/[NS]/.test(dir)) report('error', 'INVALID_LOCATION', say('is a latitude: it must start with N or S.'));
      else if (isLon && !/[EW]/.test(dir)) report('error', 'INVALID_LOCATION', say('is a longitude: it must start with E or W.'));
      else if (deg + min / 60 > (/[NS]/.test(dir) ? 90 : 180)) report('error', 'INVALID_LOCATION', say('is out of range.'));
      return;
    }
    case 'IOTARefNo': case 'POTARef': case 'SOTARef': case 'WWFFRef':
      if (!AV_FORMAT_RES[typeName].test(v)) report('error', 'INVALID_DATATYPE', say(`is not a valid ${typeName}.`));
      return;
    case 'POTARefList':
      if (!v.split(',').every(item => AV_FORMAT_RES.POTARef.test(item))) report('error', 'INVALID_DATATYPE', say('is not a comma-separated list of POTA references.'));
      return;
    case 'SponsoredAwardList': {
      const sponsors = ADIF_SPEC_ENUMS.Award_Sponsor?.values || [];
      for (const item of v.split(',')) {
        if (!sponsors.some(s => item.toUpperCase().startsWith(s.toUpperCase()) && item.length > s.length)) {
          report('error', 'INVALID_ENUM', `${name}: "${avShort(item)}" does not start with a sponsor from the Award_Sponsor enumeration (${sponsors.join(' ')}).`);
        }
      }
      return;
    }
    case 'CreditList':
      avCheckCreditList(v, name, def, report);
      return;
    case 'SecondaryAdministrativeSubdivisionListAlt':
      for (const item of v.split(';')) avCheckEnum(item, 'Secondary_Administrative_Subdivision_Alt', name, report, 'error');
      return;
    case 'Enumeration':
      if (def?.userEnum) {
        if (!def.userEnum.has(v.toUpperCase())) report('error', 'INVALID_ENUM', say(`is not one of the values its USERDEF declares (${[...def.userEnum].join(', ')}).`));
      } else if (def?.enum && !def.enumScope) {
        avCheckEnum(v, def.enum, name, report, 'error');
      }
      return;
    case 'String': case 'MultilineString':
      // String fields with a recommended enumeration (CONTEST_ID, SUBMODE):
      // other values are allowed, but less interoperable.
      if (def?.enum && !def.enumScope && avEnumIndex(def.enum)) {
        avCheckEnum(v, def.enum, name, report, 'warning');
      }
      return;
    default:
      return; // AwardList, SecondarySubdivisionList: no format check beyond ASCII
  }
}

function avCheckGrid(v, name, report, maxLen) {
  if (isValidLocator(v) && v.length <= maxLen) return;
  if (isValidLocator(v)) {
    report('error', 'INVALID_GRIDSQUARE', `${name} "${avShort(v)}" has ${v.length} characters; ADIF allows 2, 4, 6 or 8 here (characters 9-12 go into ${name.replace(/S$/, '')}_EXT).`);
  } else {
    report('error', 'INVALID_GRIDSQUARE', `${name} "${avShort(v)}" is not a Maidenhead locator (2, 4, 6 or 8 characters, e.g. JN88ee).`);
  }
}

// severity for values outside the enumeration ('error' for Enumeration
// fields, 'warning' for String fields that recommend one).
function avCheckEnum(v, enumName, name, report, severity) {
  const idx = avEnumIndex(enumName);
  if (!idx) return; // enumeration not part of the exported spec data (e.g. DARC_DOK)
  const key = enumName === 'DXCC_Entity_Code' && /^\d+$/.test(v) ? String(parseInt(v, 10)) : v.toUpperCase();
  if (!idx.values.has(key)) {
    if (severity === 'error') report('error', 'INVALID_ENUM', `${name} "${avShort(v)}" is not in the ${enumName} enumeration.`);
    else report('warning', 'NONSTANDARD_ENUM_VALUE', `${name} "${avShort(v)}" is not in the ${enumName} enumeration (allowed, but other programs may not know it).`);
  } else if (idx.importOnly.has(key)) {
    report('warning', 'IMPORT_ONLY_VALUE', `${name} "${avShort(v)}" is import-only in ADIF ${ADIF_SPEC_VERSION}: programs read it, but should not write it.`);
  }
}

function avCheckCreditList(v, name, def, report) {
  const credit = avEnumIndex('Credit'), award = avEnumIndex('Award'), medium = avEnumIndex('QSL_Medium');
  for (const item of v.split(',')) {
    const [c, media, ...rest] = item.split(':');
    const key = c.toUpperCase();
    if (credit?.values.has(key)) {
      if (rest.length || (media !== undefined && !media.split('&').every(x => medium?.values.has(x.toUpperCase())))) {
        report('error', 'INVALID_ENUM', `${name}: "${avShort(item)}" must be a credit, optionally followed by ":" and QSL media joined by "&" (e.g. DXCC:CARD&LOTW).`);
      }
    } else if (media === undefined && (def?.altTypes || []).includes('AwardList') && award?.values.has(key)) {
      report('warning', 'IMPORT_ONLY_VALUE', `${name}: "${avShort(item)}" is an Award (import-only); use Credit values.`);
    } else {
      report('error', 'INVALID_ENUM', `${name}: "${avShort(item)}" is not in the Credit enumeration.`);
    }
  }
}

/* ---------- USERDEF ---------- */

// <USERDEFn:len:type>NAME[,{A,B,C}|,{min:max}] -> { name, type, userEnum, min, max } or a problem string.
function avParseUserdef(value, typeIndicator) {
  const type = AV_INDICATOR_TYPES[typeIndicator];
  if (!type) return 'USERDEF needs a data type indicator (e.g. <USERDEF1:8:S>)';
  const m = /^([^,{}<>:]+?)(?:,\{(.*)\})?$/.exec(value.trim());
  if (!m) return `USERDEF value "${avShort(value)}" is not NAME, NAME,{A,B} or NAME,{min:max}`;
  const def = { name: m[1].trim().toUpperCase(), type };
  if (m[2] !== undefined) {
    const range = /^(-?\d+(?:\.\d+)?):(-?\d+(?:\.\d+)?)$/.exec(m[2]);
    if (range) { def.min = parseFloat(range[1]); def.max = parseFloat(range[2]); }
    else def.userEnum = new Set(m[2].split(',').map(s => s.trim().toUpperCase()));
  }
  return def;
}

/* ---------- main ---------- */

// Validates the text of an .adi file. options.today ('YYYYMMDD', default:
// the current UTC date; '' disables the future-date check). Returns
// { valid, errors, warnings, infos, issues, records, header, specVersion }:
// issues: { severity, code, message, recordType ('file'|'header'|'qso'),
// recordIndex (0-based index into records, for 'qso'), field, value,
// offset, line, column } (absent keys: not applicable); records:
// [{ index, offset, line, fields: {NAME: value}, offsets: {NAME: offset} }].
export function validateAdif(source, options = {}) {
  const text = typeof source === 'string' ? source : String(source ?? '');
  const today = options.today !== undefined ? options.today : new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const ctx = { today };
  const issues = [];
  const where = avLineIndex(text);
  const issue = (severity, code, message, extra = {}) => {
    const it = { severity, code, message, recordType: extra.recordType || 'file' };
    for (const k of ['recordIndex', 'field', 'value', 'offset']) if (extra[k] !== undefined) it[k] = extra[k];
    if (it.offset !== undefined) Object.assign(it, where(it.offset));
    issues.push(it);
  };
  const result = () => {
    const errors = issues.filter(i => i.severity === 'error').length;
    const warnings = issues.filter(i => i.severity === 'warning').length;
    const infos = issues.filter(i => i.severity === 'info').length;
    return { valid: errors === 0, errors, warnings, infos, issues, records, header, specVersion: ADIF_SPEC_VERSION };
  };
  const records = [];
  let header = null;

  if (!text.trim()) {
    issue('error', 'UNRECOVERABLE_PARSE_ERROR', 'The file is empty: no ADIF data.');
    return result();
  }
  const scanIssues = [];
  const tokens = avScan(text, (severity, code, message, extra) => scanIssues.push([severity, code, message, extra]));
  if (!tokens.some(t => t.kind === 'tag')) {
    issue('error', 'UNRECOVERABLE_PARSE_ERROR', 'Unable to recover ADIF record structure: no field tags (<NAME:LENGTH>value) found.');
    return result();
  }
  // Scanner issues get their record attached below, once records are known.

  /* header */
  const eohs = tokens.filter(t => t.kind === 'eoh');
  let bodyStart = 0;
  // ADIF: a file has a header when its first character is not '<' (a
  // leading byte order mark doesn't count).
  const body = text.replace(/^\ufeff/, '');
  if (body[0] !== '<') {
    if (eohs.length) bodyStart = tokens.indexOf(eohs[0]) + 1;
    else if (!body.trimStart().startsWith('<')) issue('error', 'MISSING_EOH', 'The file starts with header text but has no <EOH>; everything after the text is read as records.', { recordType: 'header' });
    else issue('info', 'NO_HEADER', `The file has no header, so it doesn't say which ADIF version it uses (ADIF_VER ${ADIF_SPEC_VERSION} is assumed).`, { recordType: 'header' });
  } else if (eohs.length) {
    bodyStart = tokens.indexOf(eohs[0]) + 1;
    issue('warning', 'HEADER_STARTS_WITH_TAG', "The file starts with '<' but has an <EOH>: ADIF says such a file has no header, so strict readers miss the header fields.", { recordType: 'header', offset: 0 });
  } else {
    issue('info', 'NO_HEADER', `The file has no header, so it doesn't say which ADIF version it uses (ADIF_VER ${ADIF_SPEC_VERSION} is assumed).`, { recordType: 'header' });
  }
  for (const extra of eohs.slice(1)) issue('error', 'DUPLICATE_EOH', 'A second <EOH>; ignored.', { recordType: 'file', offset: extra.offset });

  const userdefs = new Map();
  if (bodyStart > 0) {
    header = { offset: 0, fields: {}, offsets: {} };
    for (const t of tokens.slice(0, bodyStart - 1)) {
      const at = { recordType: 'header', field: t.name, offset: t.offset };
      if (t.kind === 'eor') { issue('error', 'MALFORMED_RECORD', '<EOR> inside the header (before <EOH>).', at); continue; }
      if (t.name in header.fields) issue('error', 'DUPLICATE_FIELD', `Header field ${t.name} appears twice; the last value is used.`, at);
      header.fields[t.name] = t.value;
      header.offsets[t.name] = t.offset;
      const report = (severity, code, message) => issue(severity, code, message, { ...at, value: t.value });
      if (/^USERDEF\d+$/.test(t.name)) {
        const def = avParseUserdef(t.value, t.type);
        if (typeof def === 'string') report('error', 'INVALID_USERDEF', `${t.name}: ${def}.`);
        else if (ADIF_SPEC_FIELDS[def.name]) report('error', 'INVALID_USERDEF', `${t.name} declares ${def.name}, which is an ADIF field.`);
        else userdefs.set(def.name, def);
      } else if (AV_HEADER_FIELDS.has(t.name)) {
        avCheckType(t.value, 'String', null, t.name, report, ctx);
      } else if (AV_APP_FIELD_RE.test(t.name)) {
        // application-defined header fields are allowed
      } else if (ADIF_SPEC_FIELDS[t.name]) {
        report('warning', 'FIELD_NOT_IN_HEADER', `${t.name} is a QSO field; in the header it applies to no QSO.`);
      } else {
        report('warning', 'UNKNOWN_FIELD', `${t.name} is not an ADIF ${ADIF_SPEC_VERSION} header field.`);
      }
    }
    const ver = header.fields.ADIF_VER;
    if (ver === undefined) {
      issue('info', 'MISSING_ADIF_VERSION', `The header has no ADIF_VER; readers assume an ADIF version (this validator: ${ADIF_SPEC_VERSION}).`, { recordType: 'header' });
    } else if (!/^\d+\.\d\.\d$/.test(ver)) {
      issue('error', 'INVALID_ADIF_VERSION', `ADIF_VER "${avShort(ver)}" is not in X.Y.Z format (e.g. ${ADIF_SPEC_VERSION}).`, { recordType: 'header', field: 'ADIF_VER', value: ver, offset: header.offsets.ADIF_VER });
    } else if (avCompareVersion(ver, ADIF_SPEC_VERSION) > 0) {
      issue('warning', 'UNSUPPORTED_ADIF_VERSION', `The file declares ADIF ${ver}; this validator knows ADIF ${ADIF_SPEC_VERSION}, so newer fields and values may be reported wrongly and the check may be incomplete.`, { recordType: 'header', field: 'ADIF_VER', value: ver, offset: header.offsets.ADIF_VER });
    }
    const ts = header.fields.CREATED_TIMESTAMP;
    if (ts !== undefined) {
      const [d, t, ...more] = ts.split(' ');
      if (more.length || !t || t.length !== 6 || avDateProblem(d) || avTimeProblem(t)) {
        issue('error', 'INVALID_DATATYPE', `CREATED_TIMESTAMP "${avShort(ts)}" is not "YYYYMMDD HHMMSS".`, { recordType: 'header', field: 'CREATED_TIMESTAMP', value: ts, offset: header.offsets.CREATED_TIMESTAMP });
      }
    }
  }

  /* records */
  let cur = null;
  const startRecord = t => ({ index: records.length, offset: t.offset, line: where(t.offset).line, fields: {}, offsets: {}, types: {}, unsure: new Set() });
  for (const t of tokens.slice(bodyStart)) {
    if (t.kind === 'eoh') continue;
    if (t.kind === 'eor') {
      if (!cur) {
        issue('warning', 'EMPTY_RECORD', '<EOR> without any field before it (empty record); ignored.', { recordType: 'file', offset: t.offset });
        continue;
      }
      records.push(cur);
      cur = null;
      continue;
    }
    if (!cur) cur = startRecord(t);
    if (t.name in cur.fields) {
      issue('error', 'DUPLICATE_FIELD', `${t.name} appears twice in this QSO; the last value is used.`, { recordType: 'qso', recordIndex: cur.index, field: t.name, value: t.value, offset: t.offset });
    }
    cur.fields[t.name] = t.value;
    cur.offsets[t.name] = t.offset;
    cur.types[t.name] = t.type;
    if (t.unsure) cur.unsure.add(t.name);
  }
  if (cur) {
    records.push(cur);
    issue('error', 'MISSING_EOR', 'The last QSO has no closing <EOR>; read as a QSO anyway.', { recordType: 'qso', recordIndex: cur.index, offset: cur.offset });
  }
  if (!records.length) issue('info', 'NO_RECORDS', 'The file contains no QSO records.');

  // Scanner issues, attached to the header or the QSO they occurred in.
  for (const [severity, code, message, extra] of scanIssues) {
    const e = { ...extra };
    if (header && e.offset < eohs[0].offset) e.recordType = 'header';
    else {
      const rec = avRecordAt(records, e.offset);
      if (rec) { e.recordType = 'qso'; e.recordIndex = rec.index; }
    }
    issue(severity, code, message, e);
  }

  /* fields */
  const once = new Map(); // code|field -> issue, for per-file findings (reported once, with a count)
  const reportOnce = (severity, code, field, message, offset) => {
    const key = `${code}|${field}`;
    if (once.has(key)) once.get(key).count++;
    else once.set(key, { severity, code, message, field, offset, count: 1 });
  };
  const appTypes = new Map();
  for (const rec of records) {
    for (const [name, value] of Object.entries(rec.fields)) {
      const offset = rec.offsets[name];
      const at = { recordType: 'qso', recordIndex: rec.index, field: name, value, offset };
      const report = (severity, code, message) => issue(severity, code, message, at);
      if (value === '') continue; // <NAME:0>: no value
      if (rec.unsure.has(name)) continue; // wrong length: already reported, the value is unreliable
      const indicator = rec.types[name];
      if (indicator && !AV_INDICATOR_TYPES[indicator]) {
        report('error', 'INVALID_DATATYPE_INDICATOR', `<${name}:…:${indicator}>: "${indicator}" is no ADIF data type indicator (${Object.keys(AV_INDICATOR_TYPES).join(' ')}).`);
      }
      let def = ADIF_SPEC_FIELDS[name];
      let typeName;
      if (def && !def.header) {
        typeName = def.type;
        if (def.importOnly) reportOnce('info', 'IMPORT_ONLY_FIELD', name, `${name} is import-only in ADIF ${ADIF_SPEC_VERSION}: programs read it, but should not write it.`, offset);
        const expected = ADIF_SPEC_DATATYPES[typeName]?.indicator;
        if (indicator && AV_INDICATOR_TYPES[indicator] && expected && indicator !== expected) {
          report('warning', 'TYPE_INDICATOR_MISMATCH', `${name} has type ${typeName} (${expected}), but its tag says ${AV_INDICATOR_TYPES[indicator]} (${indicator}).`);
        }
      } else if (def?.header || /^USERDEF\d+$/.test(name)) {
        report('warning', 'HEADER_FIELD_IN_RECORD', `${name} is a header field; inside a QSO it has no meaning.`);
        continue;
      } else if (userdefs.has(name)) {
        def = userdefs.get(name);
        typeName = def.type;
      } else if (name.startsWith('APP_')) {
        if (!AV_APP_FIELD_RE.test(name)) {
          report('error', 'INVALID_APPLICATION_FIELD', `${name}: application-defined fields are named APP_{PROGRAMID}_{FIELDNAME}.`);
          continue;
        }
        typeName = AV_INDICATOR_TYPES[indicator];
        if (!indicator) reportOnce('info', 'APP_FIELD_WITHOUT_TYPE', name, `${name} has no data type indicator (e.g. <${name}:LENGTH:S>); other programs read it as text.`, offset);
        else if (typeName) {
          if (appTypes.has(name) && appTypes.get(name) !== indicator) report('warning', 'APP_FIELD_TYPE_INCONSISTENT', `${name} has type ${indicator} here, but ${appTypes.get(name)} in an earlier QSO.`);
          else appTypes.set(name, indicator);
        }
        // ADIF 3.1.7 IV.A.4: without an indicator the contents must conform
        // to MultilineString (so line breaks are fine).
        if (!indicator) typeName = 'MultilineString';
        else if (!typeName) typeName = 'String';
        def = null;
      } else {
        reportOnce('warning', 'UNKNOWN_FIELD', name, `${name} is not an ADIF ${ADIF_SPEC_VERSION} field; application-specific data belongs in APP_{PROGRAMID}_${name} (or a USERDEF).`, offset);
        typeName = AV_INDICATOR_TYPES[indicator] || 'String';
        def = null;
      }
      let v = value;
      // A value ending in a line break in a one-line field: the length
      // counted the separator too (unless the scanner already said so).
      if (/[\r\n]+$/.test(v) && typeName !== 'MultilineString' && typeName !== 'IntlMultilineString') {
        report('error', 'FIELD_LENGTH_MISMATCH', `${name}: the declared length includes the line break after the value "${avShort(v.replace(/[\r\n]+$/, ''))}".`);
        v = v.replace(/[\r\n]+$/, '');
        if (!v) continue;
      }
      avCheckType(v, typeName, def, name, report, ctx);
    }
    avCrossChecks(rec, issue);
  }
  for (const it of once.values()) {
    const count = it.count > 1 ? ` (${it.count} QSOs)` : '';
    issue(it.severity, it.code, it.message + count, { recordType: 'file', field: it.field, offset: it.offset });
  }

  issues.sort((a, b) => (a.offset ?? -1) - (b.offset ?? -1));
  for (const r of records) { delete r.types; delete r.unsure; }
  return result();
}

// The record whose text contains offset (records are in file order).
function avRecordAt(records, offset) {
  let lo = 0, hi = records.length - 1, found = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (records[mid].offset <= offset) { found = records[mid]; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}

/* ---------- cross-field checks and heuristics ---------- */

function avBandOf(mhz) {
  const ranges = ADIF_SPEC_ENUMS.Band?.ranges || {};
  return Object.keys(ranges).find(b => mhz >= ranges[b][0] && mhz <= ranges[b][1]);
}

function avCrossChecks(rec, issue) {
  const f = rec.fields;
  const has = k => f[k] !== undefined && f[k] !== '';
  const at = (field, extra = {}) => ({ recordType: 'qso', recordIndex: rec.index, field, value: f[field], offset: rec.offsets[field] ?? rec.offset, ...extra });
  const ranges = ADIF_SPEC_ENUMS.Band?.ranges || {};
  const bandKey = b => Object.keys(ranges).find(k => k.toLowerCase() === String(b).toLowerCase());

  for (const [freqField, bandField] of [['FREQ', 'BAND'], ['FREQ_RX', 'BAND_RX']]) {
    if (!has(freqField) || !/^-?(?:\d+\.?\d*|\.\d+)$/.test(f[freqField])) continue;
    const mhz = parseFloat(f[freqField]);
    const band = has(bandField) ? bandKey(f[bandField]) : undefined;
    if (band) {
      const [lo, hi] = ranges[band];
      if (mhz < lo || mhz > hi) {
        const actual = avBandOf(mhz);
        issue('warning', 'BAND_FREQUENCY_MISMATCH',
          `${bandField}=${f[bandField]} does not match ${freqField}=${f[freqField]} MHz (${band}: ${lo}-${hi} MHz${actual ? `; ${f[freqField]} MHz is in ${actual}` : ''}).`,
          at(bandField, { field: `${bandField}/${freqField}` }));
      }
    } else if (!has(bandField) && !avBandOf(mhz)) {
      issue('info', 'FREQUENCY_OUTSIDE_BANDS', `${freqField}=${f[freqField]} MHz is in none of ADIF's amateur bands.`, at(freqField));
    }
  }

  if (has('SUBMODE')) {
    const sub = f.SUBMODE.toUpperCase();
    const modes = AV_SUBMODE_MODES.get(sub);
    if (!has('MODE')) {
      issue('warning', 'MODE_SUBMODE_MISMATCH', `SUBMODE=${f.SUBMODE} without MODE${modes ? ` (it belongs to MODE=${modes.join('/')})` : ''}.`, at('SUBMODE', { field: 'MODE/SUBMODE' }));
    } else if (modes && !modes.includes(f.MODE.toUpperCase())) {
      issue('warning', 'MODE_SUBMODE_MISMATCH', `SUBMODE=${f.SUBMODE} belongs to MODE=${modes.join('/')}, not MODE=${f.MODE}.`, at('SUBMODE', { field: 'MODE/SUBMODE' }));
    } else if (!modes) {
      issue('warning', 'NONSTANDARD_ENUM_VALUE', `SUBMODE "${avShort(f.SUBMODE)}" is not in the Submode enumeration (allowed, but other programs may not know it).`, at('SUBMODE'));
    }
  }

  // Enumerations whose values depend on another field (STATE by DXCC, …).
  for (const [name, def] of Object.entries(ADIF_SPEC_FIELDS)) {
    if (!def.enumScope || def.enum === 'Submode' || !has(name) || !has(def.enumScope)) continue;
    const idx = avEnumIndex(def.enum);
    const scope = /^\d+$/.test(f[def.enumScope]) ? String(parseInt(f[def.enumScope], 10)) : f[def.enumScope].toUpperCase();
    const allowed = idx?.byScope?.get(scope);
    if (allowed && !allowed.has(f[name].toUpperCase())) {
      issue('error', 'INVALID_ENUM', `${name} "${avShort(f[name])}" is not in the ${def.enum} enumeration for ${def.enumScope}=${f[def.enumScope]}.`, at(name));
    }
  }

  for (const k of ['GRIDSQUARE', 'MY_GRIDSQUARE']) {
    if (has(`${k}_EXT`) && (f[k] || '').length !== 8) {
      issue('warning', 'GRIDSQUARE_EXT_MISMATCH', `${k}_EXT needs an 8-character ${k} (it holds characters 9 and up).`, at(`${k}_EXT`));
    }
  }
  for (const [a, b] of [['LAT', 'LON'], ['MY_LAT', 'MY_LON']]) {
    if (has(a) !== has(b)) issue('warning', 'INCOMPLETE_LOCATION', `${has(a) ? a : b} without ${has(a) ? b : a}.`, at(has(a) ? a : b));
  }
  const missing = AV_QSO_FIELDS.filter(k => !has(k));
  if (!has('BAND') && !has('FREQ')) missing.splice(3, 0, 'BAND or FREQ');
  if (missing.length) {
    issue('warning', 'MISSING_QSO_FIELD', `This QSO has no ${missing.join(', ')} (a QSO needs at least CALL, QSO_DATE, TIME_ON, BAND or FREQ and MODE).`, { recordType: 'qso', recordIndex: rec.index, offset: rec.offset });
  }

  // Heuristics: valid ADIF, but probably the wrong field.
  for (const [city, grid] of Object.entries(AV_CITY_FIELDS)) {
    const v = f[city];
    if (has(city) && v.length >= 4 && v.length <= 10 && /^[A-R]{2}\d{2}/i.test(v) && isValidLocator(v)) {
      issue('warning', 'SUSPICIOUS_CITY_VALUE', `${city} contains a value that looks like a Maidenhead locator ("${v}"). Did you mean ${grid}?`, at(city));
    }
  }
}
