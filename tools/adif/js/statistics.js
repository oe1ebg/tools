// Derived statistics only: never normalize or change the source records.
import { ADIF_SPEC_ENUMS } from '../../shared/js/adif-spec-data.js';
import { adifRunSteps } from '../../shared/js/adif.js';

const LS_MISSING = '(missing)';
const LS_INVALID = '(invalid)';
const LS_ENUMS = new Map();
for (const name of ['Band', 'Mode', 'Submode', 'DXCC_Entity_Code']) {
  const e = ADIF_SPEC_ENUMS[name];
  const values = [...(e.values || []), ...Object.values(e.byScope || {}).flat()];
  LS_ENUMS.set(name, new Map(values.map(v => [v.toUpperCase(), v])));
}

function lsValue(record, name) { return String(record[name] ?? ''); }
function lsMissing(value) { return !value.trim(); }
function lsCanonical(value, name) {
  if (lsMissing(value)) return LS_MISSING;
  return LS_ENUMS.get(name).get(value.toUpperCase()) ?? LS_INVALID;
}
function lsDate(value) {
  if (!/^\d{8}$/.test(value)) return false;
  const year = +value.slice(0, 4), month = +value.slice(4, 6), day = +value.slice(6);
  if (year < 1930 || month < 1 || month > 12 || day < 1) return false;
  const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1];
}
function lsTime(value) {
  return /^(?:\d{4}|\d{6})$/.test(value) && +value.slice(0, 2) < 24 && +value.slice(2, 4) < 60 && (value.length === 4 || +value.slice(4) < 60);
}
function lsAdd(map, value) { map.set(value, (map.get(value) || 0) + 1); }
function lsDistribution(map, total) {
  return [...map].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([value, count]) => ({ value, count, percent: total ? Math.round(count / total * 1000) / 10 : 0 }));
}
function lsDistinct(map) { return [...map.keys()].filter(v => v !== LS_MISSING && v !== LS_INVALID).length; }

export function calculateLogStatistics(log, options = {}) {
  return adifRunSteps(logStatisticsSteps(log, options));
}

// indices must describe the actual displayed view, including pinned edits.
export function* logStatisticsSteps(log, { indices = null, fileCount = 0, details = true } = {}) {
  const bands = new Map(), modes = new Map(), submodes = new Map(), dxcc = new Map();
  const calls = new Set(), fields = new Set();
  const completeness = Object.fromEntries(['CALL', 'QSO_DATE', 'TIME_ON', 'MODE', 'BAND/FREQ'].map(n => [n, { missing: 0, invalid: 0 }]));
  let firstDate = null, lastDate = null, missingCalls = 0;
  const count = indices ? indices.length : log.length;
  for (let pos = 0; pos < count; pos++) {
    const rec = log[indices ? indices[pos] : pos];
    const band = lsCanonical(lsValue(rec, 'BAND'), 'Band');
    const mode = lsCanonical(lsValue(rec, 'MODE'), 'Mode');
    lsAdd(bands, band); lsAdd(modes, mode);
    const call = lsValue(rec, 'CALL').trim();
    if (call) calls.add(call.toUpperCase()); else missingCalls++;
    const date = lsValue(rec, 'QSO_DATE');
    if (lsDate(date)) {
      if (firstDate === null || date < firstDate) firstDate = date;
      if (lastDate === null || date > lastDate) lastDate = date;
    }
    if (details) {
      for (const [name, value] of Object.entries(rec)) if (!lsMissing(String(value ?? ''))) fields.add(name);
      const rawSub = lsValue(rec, 'SUBMODE');
      let sub = lsCanonical(rawSub, 'Submode');
      if (sub === LS_INVALID && !/[^\x20-\x7e]/.test(rawSub)) sub = '(unrecognized)';
      lsAdd(submodes, sub === LS_MISSING || sub === LS_INVALID ? sub : `${mode}: ${sub}`);
      lsAdd(dxcc, lsCanonical(lsValue(rec, 'DXCC'), 'DXCC_Entity_Code'));
      const checks = { CALL: v => !/[^\x20-\x7e]/.test(v), QSO_DATE: lsDate, TIME_ON: lsTime,
        MODE: v => lsCanonical(v, 'Mode') !== LS_INVALID };
      for (const [name, valid] of Object.entries(checks)) {
        const value = lsValue(rec, name);
        if (lsMissing(value)) completeness[name].missing++;
        else if (!valid(value)) completeness[name].invalid++;
      }
      const frequency = lsValue(rec, 'FREQ');
      if (band === LS_MISSING && lsMissing(frequency)) completeness['BAND/FREQ'].missing++;
      else if (band === LS_INVALID || (!lsMissing(frequency) && (!/^-?(?:\d+\.?\d*|\.\d+)$/.test(frequency) || +frequency < 0))) completeness['BAND/FREQ'].invalid++;
    }
    if ((pos + 1) % 256 === 0) yield { phase: 'statistics', done: pos + 1, total: count };
  }
  return { count, fileCount, calls: calls.size, missingCalls, firstDate, lastDate,
    bandCount: lsDistinct(bands), modeCount: lsDistinct(modes),
    fieldCount: fields.size, dxccCount: [...dxcc.keys()].filter(v => v !== LS_MISSING && v !== LS_INVALID && v !== '0').length,
    completeness, bands: lsDistribution(bands, count), modes: lsDistribution(modes, count),
    submodes: lsDistribution(submodes, count), dxcc: lsDistribution(dxcc, count) };
}
