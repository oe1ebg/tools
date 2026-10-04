// Log templates: which extra fields a line has beyond callsign, time,
// repeater flag and note. Field `adif` names a standard ADIF field; fields
// without one are exported as APP_OE1EBG_<KEY> (see export.js).
//
// Field types: text, rst, radio (options [value, label]), location (free
// text resolved with the offline Vienna lookup; the resolution is stored on
// the line as `loc`, and `plzKey` names a field that gets the resolved PLZ).
// `showIf` hides a field unless another field has the given value (or one
// of the given values). `optionsBy: [fieldKey, { value: options }]` makes
// a radio field's options depend on another field. `grade` marks school
// grades 1-5 (averaged in the summary). `short` is the label in compact
// views (map cards; '' = value only, missing = left out there); fields with
// the same `group` are shown together under that name.

// School grades for the siren test: 1 = sehr gut hörbar ... 5 = nicht hörbar.
const GRADES = [['1', '1'], ['2', '2'], ['3', '3'], ['4', '4'], ['5', '5']];
const GRADE_HINT = 'Schulnote: 1 = sehr gut hörbar, 2 = gut, 3 = befriedigend, 4 = kaum, 5 = nicht hörbar';

// Major OS versions offered for the AT-Alert question (newest first).
// Values carry the platform prefix so "iOS 17" and "Android 17" differ.
const OS_VERSIONS = {
  ios: [['ios27', 'iOS 27'], ['ios26', 'iOS 26'], ['ios18', 'iOS 18'], ['ios17', 'iOS 17'], ['ios16', 'iOS 16'],
    ['ios15', 'iOS 15'], ['ios_old', 'iOS älter'], ['ios_unknown', 'weiß nicht']],
  android: [['android17', 'Android 17'], ['android16', 'Android 16'], ['android15', 'Android 15'], ['android14', 'Android 14'],
    ['android13', 'Android 13'], ['android12', 'Android 12'], ['android11', 'Android 11'], ['android10', 'Android 10'],
    ['android_old', 'Android älter'], ['android_unknown', 'weiß nicht']],
};

export const TEMPLATES = [
  {
    key: 'calls',
    label: 'Bestätigungsverkehr',
    hint: 'Rufzeichen + QTH, z. B. nach Rundspruch',
    fields: [
      { key: 'qth', label: 'QTH / Standort', type: 'location', size: 24, adif: 'QTH' },
    ],
  },
  {
    key: 'rst',
    label: 'Rufzeichen + RST',
    hint: 'Rapport, optional Name und QTH',
    fields: [
      { key: 'rst_rcvd', label: 'RST erh.', type: 'rst', adif: 'RST_RCVD', short: 'erh.' },
      { key: 'rst_sent', label: 'RST geg.', type: 'rst', adif: 'RST_SENT', short: 'geg.' },
      { key: 'name', label: 'Name', type: 'text', adif: 'NAME', short: '' },
      { key: 'qth', label: 'QTH / Standort', type: 'location', size: 22, adif: 'QTH' },
    ],
  },
  {
    key: 'zivilschutz',
    label: 'Zivilschutz-Probealarm',
    hint: 'Standort/PLZ (Wien offline aufgelöst), Sirene, AT-Alert',
    fields: [
      { key: 'address', label: 'Standort (Adresse, Ort, PLZ, Locator)', type: 'location', size: 28, plzKey: 'plz' },
      { key: 'plz', label: 'PLZ', type: 'text', size: 5, inputmode: 'numeric' },
      // Audibility of the warning siren, one school grade (1-5) per situation.
      { key: 'siren_closed', label: 'Sirene innen, Fenster zu', type: 'radio', options: GRADES, grade: true, hint: GRADE_HINT, group: 'Sirene', short: 'zu' },
      { key: 'siren_open', label: 'Sirene innen, Fenster offen', type: 'radio', options: GRADES, grade: true, hint: GRADE_HINT, group: 'Sirene', short: 'offen' },
      { key: 'siren_outside', label: 'Sirene im Freien', type: 'radio', options: GRADES, grade: true, hint: GRADE_HINT, group: 'Sirene', short: 'außen' },
      {
        key: 'atalert', label: 'AT-Alert', type: 'radio', short: 'AT-Alert',
        options: [['ja', 'erhalten'], ['nein', 'nicht erhalten']],
      },
      {
        key: 'platform', label: 'Handy', type: 'radio', showIf: ['atalert', 'nein'], short: '',
        options: [['android', 'Android'], ['ios', 'iOS'], ['andere', 'andere']],
      },
      {
        // Major OS version; the options depend on the chosen platform.
        key: 'os_version', label: 'Version', type: 'radio', showIf: ['platform', ['ios', 'android']], short: '',
        optionsBy: ['platform', OS_VERSIONS],
      },
    ],
  },
];

export function hasLocationField(tpl) {
  return tpl.fields.some(f => f.type === 'location');
}

export function templateFor(key) {
  return TEMPLATES.find(t => t.key === key) || TEMPLATES[0];
}

// Pass the template to make visibility transitive: a field depending on a
// hidden field is hidden too (os_version -> platform -> atalert).
export function fieldVisible(field, values, tpl) {
  if (!field.showIf) return true;
  const [k, v] = field.showIf;
  const ok = Array.isArray(v) ? v.includes(values?.[k]) : values?.[k] === v;
  if (!ok || !tpl) return ok;
  const parent = tpl.fields.find(f => f.key === k);
  return parent ? fieldVisible(parent, values, tpl) : ok;
}

// All options of a radio field, across groups for `optionsBy` fields.
export function fieldOptions(field) {
  return field.optionsBy ? Object.values(field.optionsBy[1]).flat() : field.options || [];
}

// The options to offer given the current values (`optionsBy` fields).
export function currentOptions(field, values) {
  if (!field.optionsBy) return field.options || [];
  const [k, groups] = field.optionsBy;
  return groups[values?.[k]] || [];
}

// Human-readable value of a field ("innen, Fenster zu" instead of "innen_zu").
export function fieldDisplay(field, value) {
  if (value === undefined || value === null || value === '') return '';
  if (field.type === 'radio') {
    const opt = fieldOptions(field).find(o => o[0] === value);
    return opt ? opt[1] : String(value);
  }
  return String(value);
}

// Compact one-line summary of a line's values for the map cards, e.g.
// "Sirene zu 2 offen 1 außen 1 · AT-Alert nicht erhalten · Android 14".
// Only fields with a `short` label; a value that the next one repeats
// ("Android", then "Android 14") is dropped.
export function shortSummary(tpl, values) {
  const parts = [];
  let group = null;
  for (const f of tpl.fields) {
    if (f.short === undefined || !fieldVisible(f, values, tpl)) continue;
    const v = fieldDisplay(f, values?.[f.key]);
    if (!v) continue;
    const text = f.short ? `${f.short} ${v}` : v;
    if (f.group && group === f.group) {
      parts[parts.length - 1] += ` ${text}`;
      continue;
    }
    group = f.group || null;
    parts.push(f.group ? `${f.group} ${text}` : text);
  }
  return parts.filter((p, i) => !(parts[i + 1] || '').startsWith(p)).join(' · ');
}
