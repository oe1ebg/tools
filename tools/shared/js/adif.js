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
export function adifField(name, value) {
  if (value === undefined || value === null || value === '') return '';
  const v = String(value);
  return `<${name}:${v.length}>${v} `;
}

// adifField() with the value made plain ASCII first (adifAscii()).
export function adifAsciiField(name, value, opts) {
  return adifField(name, adifAscii(value, opts));
}

// Records of an ADI file as [{FIELD: value}] (field names upper-cased).
// Problems go to `warnings` (prefixed with sourceLabel); ADIF_VER,
// PROGRAMID and PROGRAMVERSION from a header (text before <EOH>) are copied
// into headerInfo when given. stats (optional): stats.unclean counts the
// values that don't end where a separator or the next tag starts, a sign
// that the lengths were counted in another unit (see parseADIFAuto()).
export function parseADIF(text, warnings, sourceLabel, headerInfo, stats) {
  const tagRe = /<([A-Za-z0-9_]+)(?::(\d+)(?::[A-Za-z]+)?)?>/g;
  let bodyStart = 0;
  const firstNonWs = text.match(/\S/);
  if (!firstNonWs || firstNonWs[0] !== '<' || !/^\s*<[A-Za-z]+:\d/.test(text)) {
    // Likely has a free-text header; look for <EOH>
    const eoh = /<eoh>/i.exec(text);
    if (eoh) {
      bodyStart = eoh.index + eoh[0].length;
    } else if (firstNonWs && firstNonWs[0] !== '<') {
      warnings.push(`${sourceLabel}: no <EOH> tag found; parsing entire file as records.`);
    }
  }
  if (headerInfo && bodyStart > 0) {
    // Header fields (e.g. <ADIF_VER:5>3.1.7) live before <EOH> and use the same
    // tag syntax as body fields, so scan just that slice with its own loop —
    // only when a real <EOH> was found, never as a fallback over body text.
    const headerText = text.slice(0, bodyStart);
    const hRe = /<([A-Za-z0-9_]+)(?::(\d+)(?::[A-Za-z]+)?)?>/g;
    let hm;
    while ((hm = hRe.exec(headerText)) !== null) {
      const hname = hm[1].toUpperCase();
      if (hname === 'EOH' || hm[2] === undefined) continue;
      const hlen = parseInt(hm[2], 10);
      const hval = headerText.slice(hRe.lastIndex, hRe.lastIndex + hlen);
      if (hname === 'ADIF_VER' || hname === 'PROGRAMID' || hname === 'PROGRAMVERSION') {
        headerInfo[hname] = hval;
      }
      hRe.lastIndex += hlen;
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
export function parseADIFAuto(text, warnings, sourceLabel, headerInfo) {
  if (!/[^\x00-\x7f]/.test(text)) return parseADIF(text, warnings, sourceLabel, headerInfo);
  const charStats = { unclean: 0 }, byteStats = { unclean: 0 };
  const charWarnings = [], byteWarnings = [];
  const charHeader = {}, byteHeader = {};
  const asChars = parseADIF(text, charWarnings, sourceLabel, charHeader, charStats);
  const asBytes = parseADIF(utf8ByteString(text), byteWarnings, sourceLabel, byteHeader, byteStats);
  const useBytes = byteStats.unclean < charStats.unclean;
  warnings.push(...(useBytes ? byteWarnings : charWarnings));
  if (useBytes) warnings.push(`${sourceLabel}: field lengths count UTF-8 bytes, not characters (as the file's program writes them); read that way.`);
  const header = useBytes ? byteHeader : charHeader;
  if (headerInfo) for (const [k, v] of Object.entries(header)) headerInfo[k] = useBytes ? fromUtf8ByteString(v) : v;
  if (!useBytes) return asChars;
  return asBytes.map(rec => Object.fromEntries(Object.entries(rec).map(([k, v]) => [k, fromUtf8ByteString(v)])));
}
