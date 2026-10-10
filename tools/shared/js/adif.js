// ADIF (.adi) helpers shared by the ADIF editor and the confirmation log's
// export. Only the ADI text format (spec: adif.org.uk).

const ADIF_PRINTABLE_RE = /^[\x20-\x7e]*$/;

// ADIF .adi is an ASCII format: transliterate German characters, replace
// anything else non-ASCII. By default also drop "<" ">": legal inside a
// length-delimited value, but naive readers split on them, and the
// confirmation log's free text doesn't need them. keepBrackets: for the
// ADIF editor, which shouldn't change other programs' data more than needed.
// multiline: for MultilineString fields, keeps line breaks (as CR LF, the
// only line break ADIF allows); otherwise they become blanks.
export function adifAscii(s, { keepBrackets = false, multiline = false } = {}) {
  const raw = String(s ?? '');
  // fast path: printable ASCII only (the usual case) needs no transliteration
  if (ADIF_PRINTABLE_RE.test(raw)) return (keepBrackets ? raw : raw.replace(/[<>]/g, '')).trim();
  let t = raw
    .replace(/Ä/g, 'Ae').replace(/Ö/g, 'Oe').replace(/Ü/g, 'Ue')
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  t = multiline
    ? t.replace(/\r\n|\r|\n/g, '\r\n').replace(/\t/g, ' ')
    : t.replace(/[\r\n\t]+/g, ' ');
  return (keepBrackets ? t : t.replace(/[<>]/g, ''))
    .replace(multiline ? /[^\x20-\x7e\r\n]/g : /[^\x20-\x7e]/g, '?')
    .trim();
}

// One `<NAME:len>value ` field, or '' for an empty/missing value (ADIF has
// no empty fields). The value is written as is; see adifAsciiField().
// type: an optional data type indicator (<NAME:len:N>).
export function adifField(name, value, type = '') {
  if (value === undefined || value === null || value === '') return '';
  const v = String(value);
  return `<${name}:${v.length}${type ? ':' + type : ''}>${v} `;
}

// adifField() with the value made plain ASCII first (adifAscii()).
export function adifAsciiField(name, value, opts, type = '') {
  return adifField(name, adifAscii(value, opts), type);
}

// The fields of an ADI header, read by their lengths (so "<EOH>" inside a
// value doesn't end it), up to <EOH>: { end (after <EOH>), fields:
// [[NAME, value, type]] }, or null when there is no <EOH> that way.
function adifHeaderFields(text) {
  const re = /<([A-Za-z0-9_]+)(?::(\d+)(?::([A-Za-z]+))?)?>/g;
  const fields = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const name = m[1].toUpperCase();
    if (name === 'EOH' && m[2] === undefined) return { end: re.lastIndex, fields };
    if (m[2] === undefined) continue;
    const len = parseInt(m[2], 10);
    fields.push([name, text.slice(re.lastIndex, re.lastIndex + len), m[3] ? m[3].toUpperCase() : '']);
    re.lastIndex += len;
  }
  return null;
}

// Records of an ADI file as [{FIELD: value}] (field names upper-cased).
// Problems go to `warnings` (prefixed with sourceLabel); ADIF_VER,
// PROGRAMID and PROGRAMVERSION from a header (text before <EOH>) are copied
// into headerInfo when given. stats (optional): stats.unclean counts the
// values that don't end where a separator or the next tag starts, a sign
// that the lengths were counted in another unit (see parseADIFAuto()).
// defs (optional): what the file says about the fields' types, for an
// export that keeps it: defs.userdefs = [{ name, type, spec }] from the
// header's USERDEFn fields (name upper-cased, type the indicator letter or
// '', spec the declaration as written: NAME, NAME,{A,B} or NAME,{min:max});
// defs.types = { NAME: 'N' }, the first data type indicator of each field
// in the records.
export function parseADIF(text, warnings, sourceLabel, headerInfo, stats, defs) {
  const tagRe = /<([A-Za-z0-9_]+)(?::(\d+)(?::([A-Za-z]+))?)?>/g;
  let bodyStart = 0;
  let header = [];
  const firstNonWs = text.match(/\S/);
  if (!firstNonWs || firstNonWs[0] !== '<' || !/^\s*<[A-Za-z]+:\d/.test(text)) {
    // Likely has a free-text header: read its fields up to <EOH>; if the
    // lengths don't lead there (a wrong length), the first "<EOH>" text.
    const h = adifHeaderFields(text);
    if (h) {
      bodyStart = h.end;
      header = h.fields;
    } else {
      const eoh = /<eoh>/i.exec(text);
      if (eoh) {
        bodyStart = eoh.index + eoh[0].length;
        header = adifHeaderFields(text.slice(0, eoh.index) + '<EOH>')?.fields || [];
      } else if (firstNonWs && firstNonWs[0] !== '<') {
        warnings.push(`${sourceLabel}: no <EOH> tag found; parsing entire file as records.`);
      }
    }
  }
  if (defs) {
    defs.userdefs = defs.userdefs || [];
    defs.types = defs.types || {};
  }
  for (const [hname, hval, htype] of header) {
    if (headerInfo && (hname === 'ADIF_VER' || hname === 'PROGRAMID' || hname === 'PROGRAMVERSION')) {
      headerInfo[hname] = hval;
    }
    if (defs && /^USERDEF\d+$/.test(hname)) {
      const spec = hval.trim();
      const name = spec.split(/[,{]/)[0].trim().toUpperCase();
      if (name) defs.userdefs.push({ name, type: htype, spec });
    }
  }
  const body = text.slice(bodyStart);
  const records = [];
  let current = {};
  let any = false;
  tagRe.lastIndex = 0;
  let m;
  while ((m = tagRe.exec(body)) !== null) {
    const name = m[1].toUpperCase();
    const lenStr = m[2];
    const tagEnd = tagRe.lastIndex;
    if (name === 'EOR') {
      records.push(current);
      current = {};
      any = false;
      continue;
    }
    if (name === 'EOH') continue;
    if (lenStr === undefined) {
      warnings.push(`${sourceLabel}: field <${name}> has no length, skipped.`);
      continue;
    }
    const len = parseInt(lenStr, 10);
    const value = body.slice(tagEnd, tagEnd + len);
    if (stats) {
      const next = body.charAt(tagEnd + len);
      if ((next !== '' && next !== '<' && !/\s/.test(next)) || /[\s<]$/.test(value)) stats.unclean++;
    }
    current[name] = value;
    if (defs && m[3] && !(name in defs.types)) defs.types[name] = m[3].toUpperCase();
    any = true;
    tagRe.lastIndex = tagEnd + len;
  }
  if (any) {
    warnings.push(`${sourceLabel}: trailing fields after last <EOR>, appended as final record.`);
    records.push(current);
  }
  return records;
}

// The text's UTF-8 bytes as a string of one char per byte, and back.
function utf8ByteString(text) {
  const bytes = new TextEncoder().encode(text);
  let out = '';
  for (let i = 0; i < bytes.length; i += 8192) out += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return out;
}

function fromUtf8ByteString(s) {
  return new TextDecoder().decode(Uint8Array.from(s, c => c.charCodeAt(0)));
}

// parseADIF() for files from other programs. ADIF counts a value's length in
// characters and allows only ASCII, but many loggers write UTF-8 and count
// bytes: then every value with an umlaut is cut in the wrong place. For a
// non-ASCII file both readings are tried, and the byte reading wins when its
// values line up with the separators and tags better (stats.unclean).
export function parseADIFAuto(text, warnings, sourceLabel, headerInfo, defs) {
  if (!/[^\x00-\x7f]/.test(text)) return parseADIF(text, warnings, sourceLabel, headerInfo, undefined, defs);
  const charStats = { unclean: 0 }, byteStats = { unclean: 0 };
  const charWarnings = [], byteWarnings = [];
  const charHeader = {}, byteHeader = {};
  const charDefs = {}, byteDefs = {};
  const asChars = parseADIF(text, charWarnings, sourceLabel, charHeader, charStats, charDefs);
  const asBytes = parseADIF(utf8ByteString(text), byteWarnings, sourceLabel, byteHeader, byteStats, byteDefs);
  const useBytes = byteStats.unclean < charStats.unclean;
  warnings.push(...(useBytes ? byteWarnings : charWarnings));
  if (useBytes) warnings.push(`${sourceLabel}: field lengths count UTF-8 bytes, not characters (as the file's program writes them); read that way.`);
  const header = useBytes ? byteHeader : charHeader;
  if (headerInfo) for (const [k, v] of Object.entries(header)) headerInfo[k] = useBytes ? fromUtf8ByteString(v) : v;
  if (defs) {
    const d = useBytes ? byteDefs : charDefs;
    defs.userdefs = (defs.userdefs || []).concat(d.userdefs.map(u => (useBytes ? { ...u, spec: fromUtf8ByteString(u.spec) } : u)));
    defs.types = Object.assign(defs.types || {}, d.types);
  }
  if (!useBytes) return asChars;
  return asBytes.map(rec => Object.fromEntries(Object.entries(rec).map(([k, v]) => [k, fromUtf8ByteString(v)])));
}
