// A strict reader for .adi files, checking what ADIF 3.1.7 requires
// (https://adif.org/317/ADIF_317.htm). Used by the export tests of both
// tools; not a test file itself.

// Band enumeration (III.B.4), MHz, the bands the tools can produce plus the
// common neighbours.
export const ADIF_BANDS = {
  '160m': [1.8, 2.0], '80m': [3.5, 4.0], '60m': [5.06, 5.45], '40m': [7.0, 7.3], '30m': [10.1, 10.15],
  '20m': [14.0, 14.35], '17m': [18.068, 18.168], '15m': [21.0, 21.45], '12m': [24.89, 24.99], '10m': [28.0, 29.7],
  '8m': [40, 45], '6m': [50, 54], '5m': [54.000001, 69.9], '4m': [70, 71], '2m': [144, 148], '1.25m': [222, 225],
  '70cm': [420, 450], '33cm': [902, 928], '23cm': [1240, 1300], '13cm': [2300, 2450], '9cm': [3300, 3500],
};

// Mode enumeration (III.B.10): the modes the tools write, with their submodes.
export const ADIF_MODES = {
  AM: [], CW: ['PCW'], FM: [], SSB: ['LSB', 'USB'], DIGITALVOICE: ['C4FM', 'DMR', 'DSTAR', 'FREEDV', 'M17'],
  FT8: [], RTTY: [], PSK: ['PSK31', 'PSK63'], MFSK: ['FT4'],
};

// Propagation mode enumeration (III.B.13).
export const ADIF_PROP_MODES = ['AS', 'AUE', 'AUR', 'BS', 'ECH', 'EME', 'ES', 'F2', 'FAI', 'GWAVE', 'INTERNET',
  'ION', 'IRL', 'LOS', 'MS', 'RPT', 'RS', 'SAT', 'TEP', 'TR'];

const HEADER_FIELDS = ['ADIF_VER', 'CREATED_TIMESTAMP', 'PROGRAMID', 'PROGRAMVERSION'];
const GRID_RE = /^[A-R]{2}(?:\d{2}(?:[A-X]{2}(?:\d{2})?)?)?$/i;
const GRID_EXT_RE = /^(?:[A-X]{2}(?:\d{2})?)$/i;
const LOCATION_RE = /^[NSEW]\d{3} [0-5]\d\.\d{3}$/;
const DATE_RE = /^\d{4}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/;
const TIME_RE = /^([01]\d|2[0-3])[0-5]\d(?:[0-5]\d)?$/;

// Parses `text` strictly: returns { header: {FIELD: value}, records:
// [{FIELD: value}] } and throws on the first spec violation, naming it.
export function readADI(text) {
  const fail = msg => { throw new Error(`ADIF: ${msg}`); };
  if (!/^[\x09\x0a\x0d\x20-\x7e]*$/.test(text)) fail('non-ASCII character in an .adi file');
  if (text.startsWith('<')) fail('no header (file starts with "<")');
  const eoh = /<eoh>/i.exec(text);
  if (!eoh) fail('header without <EOH>');
  const tag = /<([^:<>]+)(?::(\d+)(?::([A-Za-z]))?)?>/g;

  function scan(chunk, isHeader) {
    const fields = [];
    let m;
    tag.lastIndex = 0;
    while ((m = tag.exec(chunk))) {
      const name = m[1].toUpperCase();
      if (name === 'EOR' || name === 'EOH') { fields.push([name]); continue; }
      if (!/^[A-Z][A-Z0-9_]*$/.test(name)) fail(`bad field name <${m[1]}>`);
      if (m[2] === undefined) fail(`<${name}> without length`);
      const len = +m[2];
      const value = chunk.slice(tag.lastIndex, tag.lastIndex + len);
      if (value.length !== len) fail(`<${name}:${len}> runs past the end`);
      if (/[<>]/.test(value) && isHeader) fail(`<${name}> value contains a tag character`);
      fields.push([name, value]);
      tag.lastIndex += len;
    }
    return fields;
  }

  const header = {};
  for (const [name, value] of scan(text.slice(0, eoh.index), true)) {
    if (!HEADER_FIELDS.includes(name) && !/^USERDEF\d+$/.test(name)) fail(`unknown header field ${name}`);
    if (name in header) fail(`header field ${name} twice`);
    header[name] = value;
  }
  if (!/^\d+\.\d\.\d+$/.test(header.ADIF_VER || '')) fail('ADIF_VER missing or not X.Y.Z');
  if (header.CREATED_TIMESTAMP !== undefined) {
    const [d, t, ...rest] = header.CREATED_TIMESTAMP.split(' ');
    if (rest.length || !DATE_RE.test(d) || !/^\d{6}$/.test(t || '') || !TIME_RE.test(t)) fail('CREATED_TIMESTAMP not "YYYYMMDD HHMMSS"');
  }

  const records = [];
  let cur = {};
  for (const [name, value] of scan(text.slice(eoh.index + eoh[0].length), false)) {
    if (name === 'EOR') { records.push(cur); cur = {}; continue; }
    if (name === 'EOH') fail('second <EOH>');
    if (name in cur) fail(`field ${name} twice in one record`);
    cur[name] = value;
  }
  if (Object.keys(cur).length) fail('fields after the last <EOR>');
  records.forEach((r, i) => checkRecord(r, i + 1, fail));
  return { header, records };
}

function bandOf(mhz) {
  return Object.entries(ADIF_BANDS).find(([, [lo, hi]]) => mhz >= lo && mhz <= hi)?.[0];
}

function checkRecord(r, nr, fail) {
  const f = msg => fail(`record ${nr}: ${msg}`);
  for (const k of ['CALL', 'QSO_DATE', 'TIME_ON']) if (!r[k]) f(`${k} missing`);
  if (!DATE_RE.test(r.QSO_DATE)) f(`QSO_DATE ${r.QSO_DATE}`);
  if (!TIME_RE.test(r.TIME_ON)) f(`TIME_ON ${r.TIME_ON}`);
  if (!/^[A-Z0-9/]+$/.test(r.CALL)) f(`CALL ${r.CALL}`);
  for (const k of ['OPERATOR', 'STATION_CALLSIGN', 'OWNER_CALLSIGN']) {
    if (k in r && !/^[A-Z0-9/]+$/.test(r[k])) f(`${k} "${r[k]}" is no callsign`);
  }
  for (const [freq, band] of [['FREQ', 'BAND'], ['FREQ_RX', 'BAND_RX']]) {
    if (freq in r) {
      if (!/^\d+(\.\d+)?$/.test(r[freq])) f(`${freq} ${r[freq]} is no number`);
      const b = bandOf(+r[freq]);
      if (band in r && r[band] !== b) f(`${band} ${r[band]} doesn't match ${freq} ${r[freq]}`);
    }
    if (band in r && !(r[band].toLowerCase() in ADIF_BANDS)) f(`${band} ${r[band]} not in the band enumeration`);
  }
  if ('MODE' in r && !(r.MODE in ADIF_MODES)) f(`MODE ${r.MODE}`);
  if ('SUBMODE' in r && !(ADIF_MODES[r.MODE] || []).includes(r.SUBMODE)) f(`SUBMODE ${r.SUBMODE} for MODE ${r.MODE}`);
  if ('PROP_MODE' in r && !ADIF_PROP_MODES.includes(r.PROP_MODE)) f(`PROP_MODE ${r.PROP_MODE}`);
  for (const k of ['GRIDSQUARE', 'MY_GRIDSQUARE']) {
    if (k in r && !(GRID_RE.test(r[k]) && r[k].length % 2 === 0)) f(`${k} ${r[k]}`);
    if (`${k}_EXT` in r) {
      if (!GRID_EXT_RE.test(r[`${k}_EXT`])) f(`${k}_EXT ${r[`${k}_EXT`]}`);
      if ((r[k] || '').length !== 8) f(`${k}_EXT without an 8-character ${k}`);
    }
  }
  for (const k of ['LAT', 'LON', 'MY_LAT', 'MY_LON']) {
    if (k in r && !LOCATION_RE.test(r[k])) f(`${k} ${r[k]}`);
  }
  if ('LAT' in r && (r.LAT[0] === 'E' || r.LAT[0] === 'W' || +r.LAT.slice(1, 4) > 90)) f(`LAT ${r.LAT}`);
  if ('LON' in r && (r.LON[0] === 'N' || r.LON[0] === 'S' || +r.LON.slice(1, 4) > 180)) f(`LON ${r.LON}`);
  for (const [k, v] of Object.entries(r)) {
    if (/[\r\n]/.test(v) && k !== 'ADDRESS' && k !== 'NOTES' && k !== 'QSLMSG') f(`${k} has a line break (String field)`);
  }
}

// What every logbook program needs to file a QSO: band or frequency, and a mode.
export function isCompleteQSO(r) {
  return !!(r.CALL && r.QSO_DATE && r.TIME_ON && (r.BAND || r.FREQ) && r.MODE);
}
