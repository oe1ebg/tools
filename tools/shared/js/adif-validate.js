// ADIF validator for .adi text: validateAdif(source) checks a file against
// ADIF 3.1.8 and returns every issue it finds, without throwing on bad
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
// list them); messages are for people and may change. They are in the
// page's language (i18n.js, tx(): English unless chosen otherwise).
//
// Top-level names start with "av" or "AV_": the single-file bundle shares
// one scope with the editor's own modules.

import { ADIF_SPEC_VERSION, ADIF_SPEC_DATATYPES, ADIF_SPEC_FIELDS, ADIF_SPEC_ENUMS } from './adif-spec-data.js';
import { isValidLocator } from './maidenhead.js';
import { adifCountsBytesSteps, adifRunSteps, adifUtf8Bytes, adifFromUtf8Bytes } from './adif.js';
import { tx } from './i18n.js';

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

// "3.1.8" > "3.1.6": compares X.Y.Z numerically; null when not X.Y.Z.
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
  if (!/^\d{8}$/.test(v)) return tx('is not a date in YYYYMMDD format', 'ist kein Datum im Format JJJJMMTT');
  const y = +v.slice(0, 4), m = +v.slice(4, 6), d = +v.slice(6, 8);
  if (y < 1930) return tx('has a year before 1930', 'hat ein Jahr vor 1930');
  if (m < 1 || m > 12) return tx('has no valid month', 'hat keinen gültigen Monat');
  if (d < 1 || d > avDaysInMonth(y, m)) return tx(`has no valid day (${y}-${String(m).padStart(2, '0')} has ${avDaysInMonth(y, m)} days)`, `hat keinen gültigen Tag (${y}-${String(m).padStart(2, '0')} hat ${avDaysInMonth(y, m)} Tage)`);
  return '';
}

// Problems with a Time value (HHMM or HHMMSS), or ''.
function avTimeProblem(v) {
  if (!/^\d{4}(?:\d{2})?$/.test(v)) return tx('is not a time in HHMM or HHMMSS format', 'ist keine Uhrzeit im Format HHMM oder HHMMSS');
  if (+v.slice(0, 2) > 23) return tx('has an hour above 23', 'hat eine Stunde über 23');
  if (+v.slice(2, 4) > 59) return tx('has a minute above 59', 'hat eine Minute über 59');
  if (v.length === 6 && +v.slice(4, 6) > 59) return tx('has a second above 59', 'hat eine Sekunde über 59');
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

// Byte offset (into the UTF-8 bytes of text) -> character offset.
function avByteToChar(text) {
  const map = [];
  for (let i = 0; i < text.length;) {
    const cp = text.codePointAt(i);
    const n = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    for (let k = 0; k < n; k++) map.push(i);
    i += cp > 0xffff ? 2 : 1;
  }
  map.push(text.length);
  return offset => map[Math.min(offset, map.length - 1)];
}

// Tokens of an .adi text: { kind: 'tag'|'eoh'|'eor', name, type, value,
// offset (of '<'), valueOffset }. Recoverable syntax problems are reported
// through issue(); the scan never stops early.
// dec: the value as text (byte mode: adifFromUtf8Bytes, the source being
// the file's UTF-8 bytes, one char per byte); byteMode: lengths count bytes.
// extraEoh: { offsets, omitted, cap }: a second and later <EOH> makes no
// token (a flood of them would only fill memory); its offset is kept up to
// cap, the rest is counted in omitted.
function* avScan(source, issue, dec = v => v, byteMode = false, extraEoh = { offsets: [], omitted: 0, cap: Infinity }) {
  const tokens = [];
  let eohSeen = false;
  let pos = 0;
  let work = 0;
  while (pos < source.length) {
    // by scanned work, not by tokens: a long run of malformed tags makes none
    if ((++work & 4095) === 0) yield { phase: 'scan', pos, total: source.length };
    const lt = source.indexOf('<', pos);
    if (lt < 0) break;
    AV_TAG_RE.lastIndex = lt;
    const m = AV_TAG_RE.exec(source);
    if (!m) {
      issue('error', 'MALFORMED_FIELD', tx("'<' without a closing '>' before the next '<' or the end of the file.", "'<' ohne schließendes '>' vor dem nächsten '<' oder dem Dateiende."), { offset: lt });
      pos = lt + 1;
      continue;
    }
    const tagEnd = lt + m[0].length;
    const parts = m[1].split(':');
    const rawName = parts[0];
    const upper = rawName.toUpperCase();
    if ((upper === 'EOR' || upper === 'EOH') && parts.length === 1) {
      if (upper === 'EOH' && eohSeen) {
        if (extraEoh.offsets.length < extraEoh.cap) extraEoh.offsets.push(lt);
        else extraEoh.omitted++;
      } else {
        if (upper === 'EOH') eohSeen = true;
        tokens.push({ kind: upper.toLowerCase(), name: upper, offset: lt });
      }
      pos = tagEnd;
      continue;
    }
    if (!AV_FIELD_NAME_RE.test(rawName) || parts.length > 3) {
      issue('error', 'MALFORMED_FIELD', tx(`<${avShort(m[1])}> is no valid field tag (<NAME:LENGTH> or <NAME:LENGTH:TYPE>).`, `<${avShort(m[1])}> ist kein gültiges Feld-Tag (<NAME:LÄNGE> oder <NAME:LÄNGE:TYP>).`), { offset: lt });
      pos = tagEnd;
      continue;
    }
    if (parts.length === 1) {
      issue('error', 'MALFORMED_FIELD', tx(`<${avShort(rawName)}> has no length (<NAME:LENGTH>); skipped.`, `<${avShort(rawName)}> hat keine Länge (<NAME:LÄNGE>); übersprungen.`), { offset: lt, field: upper });
      pos = tagEnd;
      continue;
    }
    if (!/^\d+$/.test(parts[1]) || (parts.length === 3 && !/^[A-Za-z]$/.test(parts[2]))) {
      issue('error', 'MALFORMED_FIELD', tx(`<${avShort(m[1])}>: the length must be digits and the type a single letter.`, `<${avShort(m[1])}>: die Länge muss aus Ziffern bestehen und der Typ ein einzelner Buchstabe sein.`), { offset: lt, field: upper });
      pos = tagEnd;
      continue;
    }
    const len = parseInt(parts[1], 10);
    const type = parts.length === 3 ? parts[2].toUpperCase() : '';
    const end = tagEnd + len;
    const available = source.slice(tagEnd, Math.min(end, source.length));
    const shown = dec(available); // the value as text (byte mode: decoded)
    // Tag-shaped text inside the declared length (<EOR>, <EOH>, <CALL:4>):
    // the first one (cut), whether a whole <EOR> lies inside, and whether
    // one starts inside the value but ends after it (the length ends
    // inside a tag: still the value as declared, IV.A.1/IV.A.6, but
    // suspicious).
    let cut = -1, inside = false, eorInside = false, straddle = false;
    for (let i = available.indexOf('<'); i >= 0; i = available.indexOf('<', i + 1)) {
      AV_NEXT_TAG_RE.lastIndex = tagEnd + i;
      if (!AV_NEXT_TAG_RE.test(source)) continue;
      if (cut < 0) cut = i;
      if (AV_NEXT_TAG_RE.lastIndex > end) { straddle = true; continue; }
      inside = true;
      if (/^<eor>$/i.test(source.slice(tagEnd + i, AV_NEXT_TAG_RE.lastIndex))) eorInside = true;
    }
    const bytes = !byteMode && /[^\x00-\x7f]/.test(available) ? tx(' The value has non-ASCII characters: the length was probably counted in UTF-8 bytes, not characters.', ' Der Wert enthält Nicht-ASCII-Zeichen: Die Länge wurde wohl in UTF-8-Bytes gezählt, nicht in Zeichen.') : '';
    // Only a length past the end of the file is cut: at the first tag
    // inside it, continuing with that tag (resync), so one wrong length
    // doesn't swallow the following fields. The ADIF editor's parser reads
    // it the same way (parseADIF in adif.js).
    if (cut >= 0 && end > source.length) {
      const value = dec(available.slice(0, cut).replace(/\s+$/, ''));
      const eor = /^<eor>/i.test(available.slice(cut)) ? tx(' It runs over <EOR>, the end of the QSO: the QSO ends there.', ' Sie läuft über <EOR>, das Ende des QSOs: Das QSO endet dort.') : '';
      issue('error', 'FIELD_LENGTH_MISMATCH',
        tx(`<${upper}:${len}> declares ${len} characters, but the file ends after ${available.length}; the value "${avShort(value)}" ends at the next tag.${eor}${bytes}`, `<${upper}:${len}> gibt ${len} Zeichen an, aber die Datei endet nach ${available.length}; der Wert „${avShort(value)}“ endet am nächsten Tag.${eor}${bytes}`),
        { offset: lt, field: upper, value });
      tokens.push({ kind: 'tag', name: upper, type, value, offset: lt, valueOffset: tagEnd, unsure: true });
      pos = tagEnd + cut;
      continue;
    }
    if (end > source.length) {
      issue('error', 'TRUNCATED_FIELD', tx(`<${upper}:${len}> declares ${len} characters, but the file ends after ${available.length}.`, `<${upper}:${len}> gibt ${len} Zeichen an, aber die Datei endet nach ${available.length}.`),
        { offset: lt, field: upper, value: shown });
      tokens.push({ kind: 'tag', name: upper, type, value: shown, offset: lt, valueOffset: tagEnd, unsure: true });
      break;
    }
    // The declared length fits: it is what counts. The value is the
    // declared number of characters (ADIF 3.1.8 IV.A.1), never split at
    // tag-shaped text inside it, and characters after it outside a field
    // or <EOR> are ignored (IV.A.6), also the rest of a tag the length
    // ends in. Suspicious boundaries are warnings only; they never change
    // how the file is read.
    const at = { offset: lt, field: upper, value: shown };
    if (eorInside) {
      // An <EOR> inside the value is the typical sign of a too long length
      // that swallowed the end of the QSO (and maybe the next one's
      // fields): valid per spec, but its own, clearer warning.
      issue('warning', 'RECORD_END_IN_VALUE',
        tx(`<${upper}:${len}>: the value "${avShort(shown)}" contains <EOR>; read as part of the value, as the declared length says, so no QSO ends there. If the length is too long, this value swallowed the end of the QSO and the fields after it (two QSOs read as one): check the length.`, `<${upper}:${len}>: Der Wert „${avShort(shown)}“ enthält <EOR>; wie die angegebene Länge sagt, als Teil des Werts gelesen, dort endet also kein QSO. Ist die Länge zu groß, hat dieser Wert das Ende des QSOs und die Felder danach verschluckt (zwei QSOs als eines gelesen): Länge prüfen.`),
        at);
    } else if (inside) {
      issue('warning', 'TAG_IN_VALUE',
        tx(`<${upper}:${len}>: the value "${avShort(shown)}" contains text that looks like an ADIF tag; read as part of the value, as the declared length says. If that is not intended, the length is wrong (programs that split on tags will misread it too).`, `<${upper}:${len}>: Der Wert „${avShort(shown)}“ enthält Text, der wie ein ADIF-Tag aussieht; wie die angegebene Länge sagt, als Teil des Werts gelesen. Ist das nicht gewollt, stimmt die Länge nicht (Programme, die an Tags trennen, lesen es ebenfalls falsch).`),
        at);
    }
    // Text after the value before the next tag: right after it (no
    // separator), or after a blank (<NAME:3>Max Mustermann): the length
    // probably doesn't match the value.
    const after = /^(\s*)([^<]*?)\s*(?:<|$)/.exec(source.slice(end, end + 200));
    if (after && after[2]) {
      const what = after[1] ? tx('followed, after a blank, by', 'nach einem Leerzeichen gefolgt von') : tx('followed directly by', 'direkt gefolgt von');
      const hint = straddle ? tx(' (too long: it ends inside a tag)', ' (zu lang: sie endet in einem Tag)') : cut >= 0 ? tx(' (too long: it runs over a tag)', ' (zu lang: sie läuft über ein Tag)') : after[1] ? tx(' (too short?)', ' (zu kurz?)') : '';
      issue('warning', 'FIELD_LENGTH_MISMATCH',
        tx(`<${upper}:${len}>: the value "${avShort(shown)}" (${len} ${byteMode ? 'bytes' : 'characters'} as declared) is ${what} "${avShort(dec(after[2]))}". ADIF ignores text outside fields (IV.A.6), so it is read as declared, but the declared length probably does not match the value${hint}.${bytes}`, `<${upper}:${len}>: Der Wert „${avShort(shown)}“ (${len} ${byteMode ? 'Bytes' : 'Zeichen'} laut Angabe) ist ${what} „${avShort(dec(after[2]))}“. ADIF ignoriert Text außerhalb von Feldern (IV.A.6), daher wird er wie angegeben gelesen, aber die angegebene Länge passt wohl nicht zum Wert${hint}.${bytes}`),
        at);
    }
    tokens.push({ kind: 'tag', name: upper, type, value: shown, offset: lt, valueOffset: tagEnd });
    pos = end;
  }
  return tokens;
}

/* ---------- value checks ---------- */

// Checks one value against a data type; calls report(severity, code, message).
// def: the field's spec entry (min/max/enum) or a USERDEF/APP stand-in.
function avCheckType(value, typeName, def, name, report, ctx) {
  const v = value;
  const say = text => tx(`${name} "${avShort(v)}" ${text}`, `${name} „${avShort(v)}“ ${text}`);
  const multiline = typeName === 'MultilineString' || typeName === 'IntlMultilineString';
  const international = typeName === 'IntlString' || typeName === 'IntlMultilineString' || typeName === 'IntlCharacter';
  if (international && ctx.format !== 'adx') {
    report('error', 'INTL_FIELD_IN_ADI', tx(`${name} has type ${typeName}, which ADIF allows only in ADX files, not in .adi.`, `${name} hat den Typ ${typeName}, den ADIF nur in ADX-Dateien erlaubt, nicht in .adi.`));
    return;
  }
  // Every other type is ASCII (Character: codes 32-126).
  const bad = international ? /[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/.exec(v) : /[^\x20-\x7e\r\n]/.exec(v);
  if (bad) {
    report('error', 'INVALID_CHARACTER', say(international ? tx('contains a character forbidden in XML.', 'enthält ein in XML verbotenes Zeichen.') : ctx.format === 'adx' ? tx(`contains "${bad[0]}", which this non-international ADIF type cannot hold.`, `enthält „${bad[0]}“, das dieser nicht-internationale ADIF-Typ nicht aufnehmen kann.`) : tx(`contains "${bad[0]}", which is not printable ASCII (ADI files are ASCII).`, `enthält „${bad[0]}“, kein druckbares ASCII (ADI-Dateien sind ASCII).`)));
  }
  if (/[\r\n]/.test(v)) {
    if (!multiline) report('error', 'INVALID_CHARACTER', say(tx('contains a line break, which only MultilineString fields may.', 'enthält einen Zeilenumbruch, den nur MultilineString-Felder haben dürfen.')));
    else if (ctx.format !== 'adx' && /[\r\n]/.test(v.replace(/\r\n/g, ''))) report('info', 'LINE_BREAK_NOT_CRLF', tx(`${name}: line breaks in ADIF are CR LF; this value has bare CR or LF.`, `${name}: Zeilenumbrüche sind in ADIF CR LF; dieser Wert hat ein einzelnes CR oder LF.`));
  }
  switch (typeName) {
    case 'Boolean':
      if (!/^[YN]$/i.test(v)) report('error', 'INVALID_BOOLEAN', say(tx('is not a Boolean (Y or N).', 'ist kein Boolean (Y oder N).')));
      return;
    case 'Character':
      if (v.length !== 1) report('error', 'INVALID_DATATYPE', say(tx('is not a single character.', 'ist kein einzelnes Zeichen.')));
      return;
    case 'Digit':
      if (!/^\d$/.test(v)) report('error', 'INVALID_NUMBER', say(tx('is not a single digit.', 'ist keine einzelne Ziffer.')));
      return;
    case 'Number': case 'Integer': case 'PositiveInteger': {
      const re = typeName === 'Number' ? /^-?(?:\d+\.?\d*|\.\d+)$/ : typeName === 'Integer' ? /^-?\d+$/ : /^\d+$/;
      if (!re.test(v)) {
        report('error', 'INVALID_NUMBER', say(tx(`is not ${typeName === 'Number' ? 'a Number' : `an ${typeName}`} (digits, ${typeName === 'Number' ? 'optional minus sign and decimal point' : typeName === 'Integer' ? 'optional minus sign' : 'no sign'}).`,
          `ist kein ${typeName} (Ziffern, ${typeName === 'Number' ? 'optional Minuszeichen und Dezimalpunkt' : typeName === 'Integer' ? 'optional Minuszeichen' : 'ohne Vorzeichen'}).`)));
        return;
      }
      const n = parseFloat(v);
      const min = def?.min ?? ADIF_SPEC_DATATYPES[typeName]?.min;
      const max = def?.max ?? ADIF_SPEC_DATATYPES[typeName]?.max;
      if ((min !== undefined && n < min) || (max !== undefined && n > max)) {
        const range = max === undefined ? tx(`at least ${min}`, `mindestens ${min}`) : min === undefined ? tx(`at most ${max}`, `höchstens ${max}`) : tx(`${min} to ${max}`, `${min} bis ${max}`);
        if (def?.rangeImportOnly) report('info', 'NUMBER_OUT_OF_RANGE', say(tx(`is outside ${range}; ADIF allows that on import only (normalize it for export).`, `liegt außerhalb von ${range}; ADIF erlaubt das nur beim Import (für den Export normalisieren).`)));
        else report('error', 'NUMBER_OUT_OF_RANGE', say(tx(`is outside the allowed range (${range}).`, `liegt außerhalb des erlaubten Bereichs (${range}).`)));
      }
      return;
    }
    case 'Date': {
      const p = avDateProblem(v);
      if (p) report('error', 'INVALID_DATE', say(p + '.'));
      else if (ctx.today && v > ctx.today) report('warning', 'DATE_IN_FUTURE', say(tx('lies in the future.', 'liegt in der Zukunft.')));
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
      if (!/^[A-X]{2}(?:\d{2})?$/i.test(v)) report('error', 'INVALID_GRIDSQUARE', say(tx('is not a locator extension (characters 9-10 as letters A-X, optionally 11-12 as digits).', 'ist keine Locator-Erweiterung (Zeichen 9-10 als Buchstaben A-X, optional 11-12 als Ziffern).')));
      return;
    case 'GridSquareList':
      for (const item of v.split(',')) avCheckGrid(item, name, report, 8);
      return;
    case 'Location': {
      const m = AV_LOCATION_RE.exec(v);
      const isLat = /(?:^|_)LAT$/.test(name), isLon = /(?:^|_)LON$/.test(name);
      if (!m) { report('error', 'INVALID_LOCATION', say(tx('is not a Location (XDDD MM.MMM, e.g. N048 12.345).', 'ist keine Location (XDDD MM.MMM, z. B. N048 12.345).'))); return; }
      const dir = m[1].toUpperCase(), deg = +m[2], min = +m[3];
      if (min >= 60) report('error', 'INVALID_LOCATION', say(tx('has minutes of 60 or more.', 'hat 60 oder mehr Minuten.')));
      else if (isLat && !/[NS]/.test(dir)) report('error', 'INVALID_LOCATION', say(tx('is a latitude: it must start with N or S.', 'ist eine Breite: Sie muss mit N oder S beginnen.')));
      else if (isLon && !/[EW]/.test(dir)) report('error', 'INVALID_LOCATION', say(tx('is a longitude: it must start with E or W.', 'ist eine Länge: Sie muss mit E oder W beginnen.')));
      else if (deg + min / 60 > (/[NS]/.test(dir) ? 90 : 180)) report('error', 'INVALID_LOCATION', say(tx('is out of range.', 'liegt außerhalb des Bereichs.')));
      return;
    }
    case 'IOTARefNo': case 'POTARef': case 'SOTARef': case 'WWFFRef':
      if (!AV_FORMAT_RES[typeName].test(v)) report('error', 'INVALID_DATATYPE', say(tx(`is not a valid ${typeName}.`, `ist keine gültige ${typeName}.`)));
      return;
    case 'POTARefList':
      if (!v.split(',').every(item => AV_FORMAT_RES.POTARef.test(item))) report('error', 'INVALID_DATATYPE', say(tx('is not a comma-separated list of POTA references.', 'ist keine durch Kommas getrennte Liste von POTA-Referenzen.')));
      return;
    case 'SponsoredAwardList': {
      const sponsors = ADIF_SPEC_ENUMS.Award_Sponsor?.values || [];
      for (const item of v.split(',')) {
        if (!sponsors.some(s => item.toUpperCase().startsWith(s.toUpperCase()) && item.length > s.length)) {
          report('error', 'INVALID_ENUM', tx(`${name}: "${avShort(item)}" does not start with a sponsor from the Award_Sponsor enumeration (${sponsors.join(' ')}).`, `${name}: „${avShort(item)}“ beginnt mit keinem Sponsor aus der Aufzählung Award_Sponsor (${sponsors.join(' ')}).`));
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
        if (!def.userEnum.has(v.toUpperCase())) report('error', 'INVALID_ENUM', say(tx(`is not one of the values its USERDEF declares (${[...def.userEnum].join(', ')}).`, `ist keiner der Werte, die seine USERDEF angibt (${[...def.userEnum].join(', ')}).`)));
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
    report('error', 'INVALID_GRIDSQUARE', tx(`${name} "${avShort(v)}" has ${v.length} characters; ADIF allows 2, 4, 6 or 8 here (characters 9-12 go into ${name.replace(/S$/, '')}_EXT).`, `${name} „${avShort(v)}“ hat ${v.length} Zeichen; ADIF erlaubt hier 2, 4, 6 oder 8 (Zeichen 9-12 gehören in ${name.replace(/S$/, '')}_EXT).`));
  } else {
    report('error', 'INVALID_GRIDSQUARE', tx(`${name} "${avShort(v)}" is not a Maidenhead locator (2, 4, 6 or 8 characters, e.g. JN88ee).`, `${name} „${avShort(v)}“ ist kein Maidenhead-Locator (2, 4, 6 oder 8 Zeichen, z. B. JN88ee).`));
  }
}

// severity for values outside the enumeration ('error' for Enumeration
// fields, 'warning' for String fields that recommend one).
function avCheckEnum(v, enumName, name, report, severity) {
  const idx = avEnumIndex(enumName);
  if (!idx) return; // enumeration not part of the exported spec data (e.g. DARC_DOK)
  const key = enumName === 'DXCC_Entity_Code' && /^\d+$/.test(v) ? String(parseInt(v, 10)) : v.toUpperCase();
  if (!idx.values.has(key)) {
    if (severity === 'error') report('error', 'INVALID_ENUM', tx(`${name} "${avShort(v)}" is not in the ${enumName} enumeration.`, `${name} „${avShort(v)}“ ist nicht in der Aufzählung ${enumName}.`));
    else report('warning', 'NONSTANDARD_ENUM_VALUE', tx(`${name} "${avShort(v)}" is not in the ${enumName} enumeration (allowed, but other programs may not know it).`, `${name} „${avShort(v)}“ ist nicht in der Aufzählung ${enumName} (erlaubt, aber andere Programme kennen den Wert vielleicht nicht).`));
  } else if (idx.importOnly.has(key)) {
    report('warning', 'IMPORT_ONLY_VALUE', tx(`${name} "${avShort(v)}" is import-only in ADIF ${ADIF_SPEC_VERSION}: programs read it, but should not write it.`, `${name} „${avShort(v)}“ ist in ADIF ${ADIF_SPEC_VERSION} nur für den Import: Programme lesen den Wert, sollen ihn aber nicht schreiben.`));
  }
}

function avCheckCreditList(v, name, def, report) {
  const credit = avEnumIndex('Credit'), award = avEnumIndex('Award'), medium = avEnumIndex('QSL_Medium');
  for (const item of v.split(',')) {
    const [c, media, ...rest] = item.split(':');
    const key = c.toUpperCase();
    if (credit?.values.has(key)) {
      if (rest.length || (media !== undefined && !media.split('&').every(x => medium?.values.has(x.toUpperCase())))) {
        report('error', 'INVALID_ENUM', tx(`${name}: "${avShort(item)}" must be a credit, optionally followed by ":" and QSL media joined by "&" (e.g. DXCC:CARD&LOTW).`, `${name}: „${avShort(item)}“ muss ein Credit sein, optional gefolgt von „:“ und QSL-Medien, verbunden mit „&“ (z. B. DXCC:CARD&LOTW).`));
      }
    } else if (media === undefined && (def?.altTypes || []).includes('AwardList') && award?.values.has(key)) {
      report('warning', 'IMPORT_ONLY_VALUE', tx(`${name}: "${avShort(item)}" is an Award (import-only); use Credit values.`, `${name}: „${avShort(item)}“ ist ein Award (nur für den Import); Credit-Werte verwenden.`));
    } else {
      report('error', 'INVALID_ENUM', tx(`${name}: "${avShort(item)}" is not in the Credit enumeration.`, `${name}: „${avShort(item)}“ ist nicht in der Aufzählung Credit.`));
    }
  }
}

/* ---------- USERDEF ---------- */

// <USERDEFn:len:type>NAME[,{A,B,C}|,{min:max}] -> { name, type, userEnum, min, max } or a problem string.
function avParseUserdef(value, typeIndicator) {
  const type = AV_INDICATOR_TYPES[typeIndicator];
  if (!type) return tx('USERDEF needs a data type indicator (e.g. <USERDEF1:8:S>)', 'USERDEF braucht eine Typangabe (z. B. <USERDEF1:8:S>)');
  const m = /^([^,{}<>:]+?)(?:,\{(.*)\})?$/.exec(value.trim());
  if (!m) return tx(`USERDEF value "${avShort(value)}" is not NAME, NAME,{A,B} or NAME,{min:max}`, `USERDEF-Wert „${avShort(value)}“ ist nicht NAME, NAME,{A,B} oder NAME,{min:max}`);
  const def = { name: m[1].trim().toUpperCase(), type };
  if (m[2] !== undefined) {
    const range = /^(-?(?:\d+\.?\d*|\.\d+)):(-?(?:\d+\.?\d*|\.\d+))$/.exec(m[2]);
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
// More options, for big files: lean (true: records keep only index,
// offset and line, their fields and offsets are dropped once checked,
// which saves much of the memory a big result keeps); maxIssues (the
// issues kept, in the order they were found, then sorted; the counts
// errors/warnings/infos and `valid` still count all, issuesDropped says
// how many were left out; findings per file, as UNKNOWN_FIELD, are always
// kept; half of the budget goes to the structure issues, the rest to the
// per-field ones). bytesMode (true/false): the caller knows already how the
// lengths count (adifCountsBytesSteps), so it is not detected again.
export function validateAdif(source, options = {}) {
  return adifRunSteps(validateAdifSteps(source, options));
}

// validateAdif() as a generator for chunked checking: it yields progress
// ({ phase: 'scan', pos, total } characters scanned; { phase: 'records',
// done, total } tokens sorted into QSOs; { phase: 'check', done, total }
// QSOs checked) every few thousand steps and returns what validateAdif()
// returns, whatever the caller does in between.
export function* validateAdifSteps(source, options = {}) {
  const text = typeof source === 'string' ? source : String(source ?? '');
  const today = options.today !== undefined ? options.today : new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const ctx = { today };
  const issues = [];
  const counts = { error: 0, warning: 0, info: 0 };
  const maxIssues = options.maxIssues > 0 ? options.maxIssues : Infinity;
  // half of the budget for the file's structure (syntax, header, records),
  // the rest, and what the first half left, for the per-field findings, so a
  // file full of syntax problems still gets its QSO findings and flags
  let issueBudget = maxIssues === Infinity ? Infinity : Math.ceil(maxIssues / 2);
  let dropped = 0;
  const where = avLineIndex(text);
  const issue = (severity, code, message, extra = {}) => {
    counts[severity]++;
    if (issues.length >= issueBudget && !extra.always) { dropped++; return; }
    const it = { severity, code, message, recordType: extra.recordType || 'file' };
    for (const k of ['recordIndex', 'field', 'value', 'offset']) if (extra[k] !== undefined) it[k] = extra[k];
    if (it.offset !== undefined) Object.assign(it, where(it.offset));
    issues.push(it);
  };
  const result = () => {
    const out = { valid: counts.error === 0, errors: counts.error, warnings: counts.warning, infos: counts.info, issues, records, header, specVersion: ADIF_SPEC_VERSION };
    if (dropped) out.issuesDropped = dropped;
    return out;
  };
  const records = [];
  let header = null;

  if (!text.trim()) {
    issue('error', 'UNRECOVERABLE_PARSE_ERROR', tx('The file is empty: no ADIF data.', 'Die Datei ist leer: keine ADIF-Daten.'));
    return result();
  }
  // Scanner findings wait for their QSO. Only as many as the structure
  // budget could keep are retained (the first ones, in the order found, as
  // the cap would keep them); the others are only counted.
  const scanIssues = [];
  const extraEoh = { offsets: [], omitted: 0, cap: issueBudget };
  const scanOmitted = { error: 0, warning: 0, info: 0 };
  // Lengths counted in UTF-8 bytes (many loggers): read the file as the
  // ADIF editor does (adifCountsBytes, shared with parseADIFAuto), by its
  // bytes; positions are mapped back to characters.
  const byteMode = options.bytesMode !== undefined ? options.bytesMode : yield* adifCountsBytesSteps(text);
  const toChar = byteMode ? avByteToChar(text) : null;
  const tokens = yield* avScan(byteMode ? adifUtf8Bytes(text) : text,
    (severity, code, message, extra) => {
      if (scanIssues.length >= issueBudget) { scanOmitted[severity]++; return; }
      scanIssues.push([severity, code, message, toChar && extra?.offset !== undefined ? { ...extra, offset: toChar(extra.offset) } : extra]);
    },
    byteMode ? adifFromUtf8Bytes : undefined, byteMode, extraEoh);
  if (toChar) extraEoh.offsets = extraEoh.offsets.map(toChar);
  if (toChar) for (const t of tokens) { t.offset = toChar(t.offset); if (t.valueOffset !== undefined) t.valueOffset = toChar(t.valueOffset); }
  if (byteMode) {
    issue('warning', 'LENGTHS_IN_BYTES', tx('The field lengths in this file count UTF-8 bytes, not characters as ADIF says (IV.A.1); read that way, as the ADIF editor does. Values with non-ASCII characters are not ASCII either (ADI is ASCII).', 'Die Feldlängen dieser Datei zählen UTF-8-Bytes, nicht Zeichen, wie ADIF es vorsieht (IV.A.1); so gelesen, wie es auch der ADIF-Editor tut. Werte mit Nicht-ASCII-Zeichen sind auch kein ASCII (ADI ist ASCII).'));
  }
  if (!tokens.some(t => t.kind === 'tag')) {
    issue('error', 'UNRECOVERABLE_PARSE_ERROR', tx('Unable to recover ADIF record structure: no field tags (<NAME:LENGTH>value) found.', 'Keine ADIF-QSO-Struktur erkennbar: keine Feld-Tags (<NAME:LÄNGE>Wert) gefunden.'));
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
    else if (!body.trimStart().startsWith('<')) issue('error', 'MISSING_EOH', tx('The file starts with header text but has no <EOH>; everything after the text is read as records.', 'Die Datei beginnt mit Header-Text, hat aber kein <EOH>; alles nach dem Text wird als QSOs gelesen.'), { recordType: 'header' });
    else issue('info', 'NO_HEADER', tx(`The file has no header, so it doesn't say which ADIF version it uses (ADIF_VER ${ADIF_SPEC_VERSION} is assumed).`, `Die Datei hat keinen Header und sagt daher nicht, welche ADIF-Version sie verwendet (angenommen: ADIF_VER ${ADIF_SPEC_VERSION}).`), { recordType: 'header' });
  } else if (eohs.length) {
    bodyStart = tokens.indexOf(eohs[0]) + 1;
    issue('warning', 'HEADER_STARTS_WITH_TAG', tx("The file starts with '<' but has an <EOH>: ADIF says such a file has no header, so strict readers miss the header fields.", "Die Datei beginnt mit '<', hat aber ein <EOH>: Laut ADIF hat eine solche Datei keinen Header, strenge Leser übersehen also die Header-Felder."), { recordType: 'header', offset: 0 });
  } else {
    issue('info', 'NO_HEADER', tx(`The file has no header, so it doesn't say which ADIF version it uses (ADIF_VER ${ADIF_SPEC_VERSION} is assumed).`, `Die Datei hat keinen Header und sagt daher nicht, welche ADIF-Version sie verwendet (angenommen: ADIF_VER ${ADIF_SPEC_VERSION}).`), { recordType: 'header' });
  }
  for (const offset of extraEoh.offsets) issue('error', 'DUPLICATE_EOH', tx('A second <EOH>; ignored.', 'Ein zweites <EOH>; ignoriert.'), { recordType: 'file', offset });
  counts.error += extraEoh.omitted; dropped += extraEoh.omitted;

  const userdefs = new Map();
  if (bodyStart > 0) {
    header = { offset: 0, fields: {}, offsets: {} };
    for (const t of tokens.slice(0, bodyStart - 1)) {
      const at = { recordType: 'header', field: t.name, offset: t.offset };
      if (t.kind === 'eor') { issue('error', 'MALFORMED_RECORD', tx('<EOR> inside the header (before <EOH>).', '<EOR> im Header (vor <EOH>).'), at); continue; }
      if (t.name in header.fields) issue('error', 'DUPLICATE_FIELD', tx(`Header field ${t.name} appears twice; the last value is used.`, `Das Header-Feld ${t.name} kommt zweimal vor; der letzte Wert gilt.`), at);
      header.fields[t.name] = t.value;
      header.offsets[t.name] = t.offset;
      const report = (severity, code, message) => issue(severity, code, message, { ...at, value: t.value });
      if (/^USERDEF\d+$/.test(t.name)) {
        const def = avParseUserdef(t.value, t.type);
        if (typeof def === 'string') report('error', 'INVALID_USERDEF', `${t.name}: ${def}.`);
        else if (ADIF_SPEC_FIELDS[def.name]) report('error', 'INVALID_USERDEF', tx(`${t.name} declares ${def.name}, which is an ADIF field.`, `${t.name} deklariert ${def.name}, ein ADIF-Feld.`));
        else userdefs.set(def.name, def);
      } else if (AV_HEADER_FIELDS.has(t.name)) {
        avCheckType(t.value, 'String', null, t.name, report, ctx);
      } else if (AV_APP_FIELD_RE.test(t.name)) {
        // application-defined header fields are allowed
      } else if (ADIF_SPEC_FIELDS[t.name]) {
        report('warning', 'FIELD_NOT_IN_HEADER', tx(`${t.name} is a QSO field; in the header it applies to no QSO.`, `${t.name} ist ein QSO-Feld; im Header gilt es für kein QSO.`));
      } else {
        report('warning', 'UNKNOWN_FIELD', tx(`${t.name} is not an ADIF ${ADIF_SPEC_VERSION} header field.`, `${t.name} ist kein Header-Feld von ADIF ${ADIF_SPEC_VERSION}.`));
      }
    }
    const ver = header.fields.ADIF_VER;
    if (ver === undefined) {
      issue('info', 'MISSING_ADIF_VERSION', tx(`The header has no ADIF_VER; readers assume an ADIF version (this validator: ${ADIF_SPEC_VERSION}).`, `Der Header hat kein ADIF_VER; Leser nehmen eine ADIF-Version an (diese Prüfung: ${ADIF_SPEC_VERSION}).`), { recordType: 'header' });
    } else if (!/^\d+\.\d\.\d$/.test(ver)) {
      issue('error', 'INVALID_ADIF_VERSION', tx(`ADIF_VER "${avShort(ver)}" is not in X.Y.Z format (e.g. ${ADIF_SPEC_VERSION}).`, `ADIF_VER „${avShort(ver)}“ ist nicht im Format X.Y.Z (z. B. ${ADIF_SPEC_VERSION}).`), { recordType: 'header', field: 'ADIF_VER', value: ver, offset: header.offsets.ADIF_VER });
    } else if (avCompareVersion(ver, ADIF_SPEC_VERSION) > 0) {
      issue('warning', 'UNSUPPORTED_ADIF_VERSION', tx(`The file declares ADIF ${ver}; this validator knows ADIF ${ADIF_SPEC_VERSION}, so newer fields and values may be reported wrongly and the check may be incomplete.`, `Die Datei gibt ADIF ${ver} an; diese Prüfung kennt ADIF ${ADIF_SPEC_VERSION}, neuere Felder und Werte werden daher vielleicht falsch gemeldet und die Prüfung ist womöglich unvollständig.`), { recordType: 'header', field: 'ADIF_VER', value: ver, offset: header.offsets.ADIF_VER });
    }
    const ts = header.fields.CREATED_TIMESTAMP;
    if (ts !== undefined) {
      const [d, t, ...more] = ts.split(' ');
      if (more.length || !t || t.length !== 6 || avDateProblem(d) || avTimeProblem(t)) {
        issue('error', 'INVALID_DATATYPE', tx(`CREATED_TIMESTAMP "${avShort(ts)}" is not "YYYYMMDD HHMMSS".`, `CREATED_TIMESTAMP „${avShort(ts)}“ ist nicht „JJJJMMTT HHMMSS“.`), { recordType: 'header', field: 'CREATED_TIMESTAMP', value: ts, offset: header.offsets.CREATED_TIMESTAMP });
      }
    }
  }

  /* records */
  let cur = null;
  const startRecord = t => ({ index: records.length, offset: t.offset, line: where(t.offset).line, fields: {}, offsets: {}, types: {}, unsure: new Set() });
  let seen = 0;
  for (const t of tokens.slice(bodyStart)) {
    if (++seen % 4096 === 0) yield { phase: 'records', done: seen, total: tokens.length - bodyStart };
    if (t.kind === 'eoh') continue;
    if (t.kind === 'eor') {
      if (!cur) {
        issue('warning', 'EMPTY_RECORD', tx('<EOR> without any field before it (empty record); ignored.', '<EOR> ohne ein Feld davor (leeres QSO); ignoriert.'), { recordType: 'file', offset: t.offset });
        continue;
      }
      records.push(cur);
      cur = null;
      continue;
    }
    if (!cur) cur = startRecord(t);
    if (t.name in cur.fields) {
      issue('error', 'DUPLICATE_FIELD', tx(`${t.name} appears twice in this QSO; the last value is used.`, `${t.name} kommt in diesem QSO zweimal vor; der letzte Wert gilt.`), { recordType: 'qso', recordIndex: cur.index, field: t.name, value: t.value, offset: t.offset });
    }
    cur.fields[t.name] = t.value;
    cur.offsets[t.name] = t.offset;
    cur.types[t.name] = t.type;
    if (t.unsure) cur.unsure.add(t.name);
  }
  if (cur) {
    records.push(cur);
    issue('error', 'MISSING_EOR', tx('The last QSO has no closing <EOR>; read as a QSO anyway.', 'Das letzte QSO hat kein schließendes <EOR>; trotzdem als QSO gelesen.'), { recordType: 'qso', recordIndex: cur.index, offset: cur.offset });
  }
  if (!records.length) issue('info', 'NO_RECORDS', tx('The file contains no QSO records.', 'Die Datei enthält keine QSOs.'));

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
  for (const severity of ['error', 'warning', 'info']) { counts[severity] += scanOmitted[severity]; dropped += scanOmitted[severity]; }

  /* fields */
  issueBudget = maxIssues;
  yield* avValidateRecords(records, userdefs, issue, ctx, options, issues);
  return result();
}

// The record whose text contains offset (records are in file order).
// Shared record semantics for ADI source validation and format-aware ADX edits.
function* avValidateRecords(records, userdefs, issue, ctx, options, issues) {
  const once = new Map(); // code|field -> issue, for per-file findings (reported once, with a count)
  const reportOnce = (severity, code, field, message, offset) => {
    const key = `${code}|${field}`;
    if (once.has(key)) once.get(key).count++;
    else once.set(key, { severity, code, message, field, offset, count: 1 });
  };
  const appTypes = new Map();
  for (const rec of records) {
    if ((rec.index & 255) === 255) yield { phase: 'check', done: rec.index + 1, total: records.length };
    for (const [name, value] of Object.entries(rec.fields)) {
      const offset = rec.offsets[name];
      const at = { recordType: 'qso', recordIndex: rec.index, field: name, value, offset };
      const report = (severity, code, message) => issue(severity, code, message, at);
      const appIdentity = rec.appInfo?.[name];
      const appKey = ctx.format === 'adx' && appIdentity ? JSON.stringify([appIdentity.programId.toUpperCase(), appIdentity.fieldName.toUpperCase()]) : name;
      // The first occurrence of an application-defined field determines its
      // type (IV.A.4), also when it has no value (<APP_X_Y:0:N>); the
      // editor's parser takes it from there too.
      if (name.startsWith('APP_') && !appTypes.has(appKey)) {
        const ind = rec.types[name];
        const first = !ind ? 'M' : AV_INDICATOR_TYPES[ind] ? ind : '';
        if (first) appTypes.set(appKey, first);
      }
      if (value === '' && ctx.format !== 'adx') continue; // ADI <NAME:0>: no value; ADX still has datatype constraints
      if (rec.unsure.has(name)) continue; // wrong length: already reported, the value is unreliable
      const indicator = rec.types[name];
      if (indicator && !AV_INDICATOR_TYPES[indicator]) {
        report('error', 'INVALID_DATATYPE_INDICATOR', tx(`<${name}:…:${indicator}>: "${indicator}" is no ADIF data type indicator (${Object.keys(AV_INDICATOR_TYPES).join(' ')}).`, `<${name}:…:${indicator}>: „${indicator}“ ist keine ADIF-Typangabe (${Object.keys(AV_INDICATOR_TYPES).join(' ')}).`));
      }
      let def = ADIF_SPEC_FIELDS[name];
      let typeName;
      if (def && !def.header) {
        typeName = def.type;
        if (def.importOnly) reportOnce('info', 'IMPORT_ONLY_FIELD', name, tx(`${name} is import-only in ADIF ${ADIF_SPEC_VERSION}: programs read it, but should not write it.`, `${name} ist in ADIF ${ADIF_SPEC_VERSION} nur für den Import: Programme lesen das Feld, sollen es aber nicht schreiben.`), offset);
        const expected = ADIF_SPEC_DATATYPES[typeName]?.indicator;
        if (indicator && AV_INDICATOR_TYPES[indicator] && expected && indicator !== expected) {
          report('warning', 'TYPE_INDICATOR_MISMATCH', tx(`${name} has type ${typeName} (${expected}), but its tag says ${AV_INDICATOR_TYPES[indicator]} (${indicator}).`, `${name} hat den Typ ${typeName} (${expected}), sein Tag sagt aber ${AV_INDICATOR_TYPES[indicator]} (${indicator}).`));
        }
      } else if (def?.header || /^USERDEF\d+$/.test(name)) {
        report('warning', 'HEADER_FIELD_IN_RECORD', tx(`${name} is a header field; inside a QSO it has no meaning.`, `${name} ist ein Header-Feld; in einem QSO hat es keine Bedeutung.`));
        continue;
      } else if (userdefs.has(name)) {
        def = userdefs.get(name);
        typeName = def.type;
      } else if (name.startsWith('APP_')) {
        if (!AV_APP_FIELD_RE.test(name)) {
          report('error', 'INVALID_APPLICATION_FIELD', tx(`${name}: application-defined fields are named APP_{PROGRAMID}_{FIELDNAME}.`, `${name}: Anwendungsfelder heißen APP_{PROGRAMID}_{FIELDNAME}.`));
          continue;
        }
        if (!indicator) reportOnce('info', 'APP_FIELD_WITHOUT_TYPE', name, tx(`${name} has no data type indicator (e.g. <${name}:LENGTH:S>); other programs read it as text.`, `${name} hat keine Typangabe (z. B. <${name}:LÄNGE:S>); andere Programme lesen es als Text.`), offset);
        // ADIF 3.1.8 IV.A.4: without an indicator the contents must conform
        // to MultilineString (so line breaks are fine), and the first
        // occurrence of an application-defined field in a file determines
        // its data type: later values are checked against that.
        const own = !indicator ? 'M' : AV_INDICATOR_TYPES[indicator] ? indicator : '';
        if (own) {
          if (!appTypes.has(appKey)) appTypes.set(appKey, own);
          const first = appTypes.get(appKey);
          if (first !== own) report(ctx.format === 'adx' ? 'error' : 'warning', 'APP_FIELD_TYPE_INCONSISTENT', tx(`${name} has type ${indicator || 'M (no indicator)'} here, but ${first} at its first occurrence in the file, which determines its type (IV.A.4); checked as ${first}.`, `${name} hat hier den Typ ${indicator || 'M (keine Angabe)'}, beim ersten Vorkommen in der Datei aber ${first}, und das bestimmt den Typ (IV.A.4); als ${first} geprüft.`));
          typeName = AV_INDICATOR_TYPES[first];
        } else {
          typeName = 'String';
        }
        def = null;
      } else {
        reportOnce('warning', 'UNKNOWN_FIELD', name, tx(`${name} is not an ADIF ${ADIF_SPEC_VERSION} field; application-specific data belongs in APP_{PROGRAMID}_${name} (or a USERDEF).`, `${name} ist kein Feld von ADIF ${ADIF_SPEC_VERSION}; anwendungseigene Daten gehören in APP_{PROGRAMID}_${name} (oder eine USERDEF).`), offset);
        typeName = AV_INDICATOR_TYPES[indicator] || 'String';
        def = null;
      }
      let v = value;
      // A value ending in a line break in a one-line field: the length
      // counted the separator too (unless the scanner already said so).
      if (ctx.format !== 'adx' && /[\r\n]+$/.test(v) && typeName !== 'MultilineString' && typeName !== 'IntlMultilineString') {
        report('error', 'FIELD_LENGTH_MISMATCH', tx(`${name}: the declared length includes the line break after the value "${avShort(v.replace(/[\r\n]+$/, ''))}".`, `${name}: Die angegebene Länge enthält den Zeilenumbruch nach dem Wert „${avShort(v.replace(/[\r\n]+$/, ''))}“.`));
        v = v.replace(/[\r\n]+$/, '');
        if (!v) continue;
      }
      avCheckType(v, typeName, def, name, report, ctx);
    }
    avCrossChecks(rec, issue);
    if (options.lean) { rec.fields = null; rec.offsets = null; } // freed as we go
  }
  for (const it of once.values()) {
    const count = it.count > 1 ? tx(` (${it.count} QSOs)`, ` (${it.count} QSOs)`) : '';
    issue(it.severity, it.code, it.message + count, { recordType: 'file', field: it.field, offset: it.offset, always: true });
  }

  issues.sort((a, b) => (a.offset ?? -1) - (b.offset ?? -1));
  if (options.lean) {
    // compact objects: the dropped fields are no longer referenced at all
    for (let i = 0; i < records.length; i++) records[i] = { index: records[i].index, offset: records[i].offset, line: records[i].line };
  } else {
    for (const r of records) { delete r.types; delete r.unsure; }
  }

}

// Header value semantics without ADI source length/tag heuristics.
export function validateAdifHeader(fields, options = {}) {
  const issues = [], counts = { error: 0, warning: 0, info: 0 };
  const limit = options.maxIssues > 0 ? options.maxIssues : Infinity;
  const issue = (severity, code, message, field, value) => {
    counts[severity]++;
    if (issues.length < limit) issues.push({ severity, code, message, recordType: 'header', field, value });
  };
  const ctx = { format: options.format || 'adi', today: '' };
  for (const [name, value] of Object.entries(fields)) {
    const report = (severity, code, message) => issue(severity, code, message, name, value);
    if (AV_HEADER_FIELDS.has(name)) avCheckType(value, 'String', null, name, report, ctx);
    else if (ADIF_SPEC_FIELDS[name]) report('warning', 'FIELD_NOT_IN_HEADER', tx(`${name} is a QSO field; in the header it applies to no QSO.`, `${name} ist ein QSO-Feld; im Header gilt es für kein QSO.`));
    else report('warning', 'UNKNOWN_FIELD', tx(`${name} is not an ADIF ${ADIF_SPEC_VERSION} header field.`, `${name} ist kein Header-Feld von ADIF ${ADIF_SPEC_VERSION}.`));
  }
  const ver = fields.ADIF_VER;
  if (ver === undefined) issue('info', 'MISSING_ADIF_VERSION', tx(`The header has no ADIF_VER; this validator assumes ${ADIF_SPEC_VERSION}.`, `Der Header hat kein ADIF_VER; diese Prüfung nimmt ${ADIF_SPEC_VERSION} an.`), 'ADIF_VER');
  else if (!/^\d+\.\d\.\d$/.test(ver)) issue('error', 'INVALID_ADIF_VERSION', tx(`ADIF_VER "${avShort(ver)}" is not in X.Y.Z format.`, `ADIF_VER „${avShort(ver)}“ ist nicht im Format X.Y.Z.`), 'ADIF_VER', ver);
  else if (avCompareVersion(ver, ADIF_SPEC_VERSION) > 0) issue('warning', 'UNSUPPORTED_ADIF_VERSION', tx(`The file declares ADIF ${ver}; this validator knows ADIF ${ADIF_SPEC_VERSION}, so the check may be incomplete.`, `Die Datei gibt ADIF ${ver} an; diese Prüfung kennt ADIF ${ADIF_SPEC_VERSION}, sie ist daher womöglich unvollständig.`), 'ADIF_VER', ver);
  const ts = fields.CREATED_TIMESTAMP;
  if (ts !== undefined) {
    const [date, time, ...more] = ts.split(' ');
    if (more.length || !time || time.length !== 6 || avDateProblem(date) || avTimeProblem(time)) issue('error', 'INVALID_DATATYPE', tx(`CREATED_TIMESTAMP "${avShort(ts)}" is not "YYYYMMDD HHMMSS".`, `CREATED_TIMESTAMP „${avShort(ts)}“ ist nicht „JJJJMMTT HHMMSS“.`), 'CREATED_TIMESTAMP', ts);
  }
  return { errors: counts.error, warnings: counts.warning, infos: counts.info, issues };
}

export function validateAdifRecords(log, defs = {}, options = {}) {
  return adifRunSteps(validateAdifRecordsSteps(log, defs, options));
}

// A direct record check never serializes through a lossy interchange format.
export function* validateAdifRecordsSteps(log, defs = {}, options = {}) {
  const issues = [], counts = { error: 0, warning: 0, info: 0 };
  const limit = options.maxIssues > 0 ? options.maxIssues : Infinity;
  let dropped = 0;
  const issue = (severity, code, message, extra = {}) => {
    counts[severity]++;
    if (issues.length >= limit) { dropped++; return; }
    const it = { severity, code, message, recordType: extra.recordType || 'file', ...extra };
    issues.push(it);
  };
  const recs = log.map((fields, index) => {
    const appInfo = defs.appOrigins?.get(fields) || defs.apps;
    let types = options.recordTypes?.[index] || defs.types || {};
    if (!options.recordTypes && appInfo && Object.keys(appInfo).length) {
      types = { ...types };
      for (const [name, identity] of Object.entries(appInfo)) if (!defs.typeOverrides?.has(name)) types[name] = identity.type || types[name] || 'M';
    }
    return { index, fields, appInfo, offsets: {}, types, unsure: new Set() };
  });
  const userdefs = new Map();
  for (const u of defs.userdefs || []) {
    const def = avParseUserdef(u.spec, u.type);
    if (typeof def === 'string' || ADIF_SPEC_FIELDS[u.name]) issue('error', 'INVALID_USERDEF', `${u.name}: ${typeof def === 'string' ? def : tx('declares an ADIF-defined field', 'deklariert ein von ADIF definiertes Feld')}.`, { recordType: 'header', field: u.name });
    else userdefs.set(u.name, def);
  }
  const ctx = { today: options.today !== undefined ? options.today : new Date().toISOString().slice(0, 10).replace(/-/g, ''), format: options.format || 'adi' };
  yield* avValidateRecords(recs, userdefs, issue, ctx, options, issues);
  const out = { valid: counts.error === 0, errors: counts.error, warnings: counts.warning, infos: counts.info, issues, records: recs, header: null, specVersion: ADIF_SPEC_VERSION };
  if (dropped) out.issuesDropped = dropped;
  return out;
}

function avRecordAt(records, offset) {
  let lo = 0, hi = records.length - 1, found = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (records[mid].offset <= offset) { found = records[mid]; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}

/* ---------- cross-field checks and heuristics ---------- */

// Built once: the band ranges in spec order, bands by lower-case name, and
// the fields whose enumeration depends on another field (spec order).
const AV_BAND_RANGES = ADIF_SPEC_ENUMS.Band?.ranges || {};
const AV_BAND_LIST = Object.keys(AV_BAND_RANGES).map(b => [b, AV_BAND_RANGES[b][0], AV_BAND_RANGES[b][1]]);
const AV_BAND_BY_LOWER = new Map();
for (const [b] of AV_BAND_LIST) if (!AV_BAND_BY_LOWER.has(b.toLowerCase())) AV_BAND_BY_LOWER.set(b.toLowerCase(), b);
const AV_SCOPED_ENUM_FIELDS = Object.entries(ADIF_SPEC_FIELDS).filter(([, def]) => def.enumScope && def.enum !== 'Submode');

function avBandOf(mhz) {
  for (const [b, lo, hi] of AV_BAND_LIST) if (mhz >= lo && mhz <= hi) return b;
  return undefined;
}

function avCrossChecks(rec, issue) {
  const f = rec.fields;
  const has = k => f[k] !== undefined && f[k] !== '';
  const at = (field, extra = {}) => ({ recordType: 'qso', recordIndex: rec.index, field, value: f[field], offset: rec.offsets[field] ?? rec.offset, ...extra });
  const ranges = AV_BAND_RANGES;
  const bandKey = b => AV_BAND_BY_LOWER.get(String(b).toLowerCase());

  for (const [freqField, bandField] of [['FREQ', 'BAND'], ['FREQ_RX', 'BAND_RX']]) {
    if (!has(freqField) || !/^-?(?:\d+\.?\d*|\.\d+)$/.test(f[freqField])) continue;
    const mhz = parseFloat(f[freqField]);
    const band = has(bandField) ? bandKey(f[bandField]) : undefined;
    if (band) {
      const [lo, hi] = ranges[band];
      if (mhz < lo || mhz > hi) {
        const actual = avBandOf(mhz);
        issue('warning', 'BAND_FREQUENCY_MISMATCH',
          tx(`${bandField}=${f[bandField]} does not match ${freqField}=${f[freqField]} MHz (${band}: ${lo}-${hi} MHz${actual ? `; ${f[freqField]} MHz is in ${actual}` : ''}).`, `${bandField}=${f[bandField]} passt nicht zu ${freqField}=${f[freqField]} MHz (${band}: ${lo}-${hi} MHz${actual ? `; ${f[freqField]} MHz liegt in ${actual}` : ''}).`),
          at(bandField, { field: `${bandField}/${freqField}` }));
      }
    } else if (!has(bandField) && !avBandOf(mhz)) {
      issue('info', 'FREQUENCY_OUTSIDE_BANDS', tx(`${freqField}=${f[freqField]} MHz is in none of ADIF's amateur bands.`, `${freqField}=${f[freqField]} MHz liegt in keinem der Amateurfunkbänder von ADIF.`), at(freqField));
    }
  }

  if (has('SUBMODE')) {
    const sub = f.SUBMODE.toUpperCase();
    const modes = AV_SUBMODE_MODES.get(sub);
    if (!has('MODE')) {
      issue('warning', 'MODE_SUBMODE_MISMATCH', tx(`SUBMODE=${f.SUBMODE} without MODE${modes ? ` (it belongs to MODE=${modes.join('/')})` : ''}.`, `SUBMODE=${f.SUBMODE} ohne MODE${modes ? ` (es gehört zu MODE=${modes.join('/')})` : ''}.`), at('SUBMODE', { field: 'MODE/SUBMODE' }));
    } else if (modes && !modes.includes(f.MODE.toUpperCase())) {
      issue('warning', 'MODE_SUBMODE_MISMATCH', tx(`SUBMODE=${f.SUBMODE} belongs to MODE=${modes.join('/')}, not MODE=${f.MODE}.`, `SUBMODE=${f.SUBMODE} gehört zu MODE=${modes.join('/')}, nicht zu MODE=${f.MODE}.`), at('SUBMODE', { field: 'MODE/SUBMODE' }));
    } else if (!modes) {
      issue('warning', 'NONSTANDARD_ENUM_VALUE', tx(`SUBMODE "${avShort(f.SUBMODE)}" is not in the Submode enumeration (allowed, but other programs may not know it).`, `SUBMODE „${avShort(f.SUBMODE)}“ ist nicht in der Aufzählung Submode (erlaubt, aber andere Programme kennen den Wert vielleicht nicht).`), at('SUBMODE'));
    }
  }

  // Enumerations whose values depend on another field (STATE by DXCC, …).
  for (const [name, def] of AV_SCOPED_ENUM_FIELDS) {
    if (!has(name) || !has(def.enumScope)) continue;
    const idx = avEnumIndex(def.enum);
    const scope = /^\d+$/.test(f[def.enumScope]) ? String(parseInt(f[def.enumScope], 10)) : f[def.enumScope].toUpperCase();
    const allowed = idx?.byScope?.get(scope);
    if (allowed && !allowed.has(f[name].toUpperCase())) {
      issue('error', 'INVALID_ENUM', tx(`${name} "${avShort(f[name])}" is not in the ${def.enum} enumeration for ${def.enumScope}=${f[def.enumScope]}.`, `${name} „${avShort(f[name])}“ ist nicht in der Aufzählung ${def.enum} für ${def.enumScope}=${f[def.enumScope]}.`), at(name));
    }
  }

  for (const k of ['GRIDSQUARE', 'MY_GRIDSQUARE']) {
    if (has(`${k}_EXT`) && (f[k] || '').length !== 8) {
      issue('warning', 'GRIDSQUARE_EXT_MISMATCH', tx(`${k}_EXT needs an 8-character ${k} (it holds characters 9 and up).`, `${k}_EXT braucht ein 8-stelliges ${k} (es enthält die Zeichen ab 9).`), at(`${k}_EXT`));
    }
  }
  for (const [a, b] of [['LAT', 'LON'], ['MY_LAT', 'MY_LON']]) {
    if (has(a) !== has(b)) issue('warning', 'INCOMPLETE_LOCATION', tx(`${has(a) ? a : b} without ${has(a) ? b : a}.`, `${has(a) ? a : b} ohne ${has(a) ? b : a}.`), at(has(a) ? a : b));
  }
  const missing = AV_QSO_FIELDS.filter(k => !has(k));
  if (!has('BAND') && !has('FREQ')) missing.splice(3, 0, tx('BAND or FREQ', 'BAND oder FREQ'));
  if (missing.length) {
    issue('warning', 'MISSING_QSO_FIELD', tx(`This QSO has no ${missing.join(', ')} (a QSO needs at least CALL, QSO_DATE, TIME_ON, BAND or FREQ and MODE).`, `Diesem QSO fehlt ${missing.join(', ')} (ein QSO braucht mindestens CALL, QSO_DATE, TIME_ON, BAND oder FREQ und MODE).`), { recordType: 'qso', recordIndex: rec.index, offset: rec.offset });
  }

  // Heuristics: valid ADIF, but probably the wrong field.
  for (const [city, grid] of Object.entries(AV_CITY_FIELDS)) {
    const v = f[city];
    if (has(city) && v.length >= 4 && v.length <= 10 && /^[A-R]{2}\d{2}/i.test(v) && isValidLocator(v)) {
      issue('warning', 'SUSPICIOUS_CITY_VALUE', tx(`${city} contains a value that looks like a Maidenhead locator ("${v}"). Did you mean ${grid}?`, `${city} enthält einen Wert, der wie ein Maidenhead-Locator aussieht („${v}“). War ${grid} gemeint?`), at(city));
    }
  }
}
