// ADIF (.adi) helpers shared by the ADIF editor and the confirmation log's
// export. Only the ADI text format (spec: adif.org.uk).

// ADIF .adi is an ASCII format: transliterate German characters, replace
// anything else non-ASCII. By default also drop "<" ">": legal inside a
// length-delimited value, but naive readers split on them, and the
// confirmation log's free text doesn't need them. keepBrackets: for the
// ADIF editor, which shouldn't change other programs' data more than needed.
export function adifAscii(s, { keepBrackets = false } = {}) {
  const t = String(s ?? '')
    .replace(/Ä/g, 'Ae').replace(/Ö/g, 'Oe').replace(/Ü/g, 'Ue')
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[\r\n\t]+/g, ' ');
  return (keepBrackets ? t : t.replace(/[<>]/g, ''))
    .replace(/[^\x20-\x7e]/g, '?')
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
// into headerInfo when given.
export function parseADIF(text, warnings, sourceLabel, headerInfo) {
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
