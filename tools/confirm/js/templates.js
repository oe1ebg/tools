// Log templates: which extra fields a line has beyond callsign, time,
// repeater flag and note. Field `adif` names a standard ADIF field; fields
// without one are exported as APP_OE1EBG_<KEY> (see export.js).
//
// Field types: text, rst, radio (options [value, label]), location (free
// text resolved with the offline Vienna lookup; the resolution is stored on
// the line as `loc`, and `plzKey` names a field that gets the resolved PLZ).
// `showIf` hides a field unless another field has the given value.

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
      { key: 'rst_rcvd', label: 'RST erh.', type: 'rst', adif: 'RST_RCVD' },
      { key: 'rst_sent', label: 'RST geg.', type: 'rst', adif: 'RST_SENT' },
      { key: 'name', label: 'Name', type: 'text', adif: 'NAME' },
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
      {
        key: 'siren', label: 'Sirene hörbar', type: 'radio',
        options: [
          ['innen_zu', 'innen, Fenster zu'],
          ['innen_offen', 'innen, Fenster offen'],
          ['aussen', 'nur im Freien'],
          ['nicht', 'nicht hörbar'],
        ],
      },
      {
        key: 'atalert', label: 'AT-Alert', type: 'radio',
        options: [['ja', 'erhalten'], ['nein', 'nicht erhalten']],
      },
      {
        key: 'platform', label: 'Handy', type: 'radio', showIf: ['atalert', 'nein'],
        options: [['android', 'Android'], ['ios', 'iOS'], ['andere', 'andere']],
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

export function fieldVisible(field, values) {
  if (!field.showIf) return true;
  const [k, v] = field.showIf;
  return values?.[k] === v;
}

// Human-readable value of a field ("innen, Fenster zu" instead of "innen_zu").
export function fieldDisplay(field, value) {
  if (value === undefined || value === null || value === '') return '';
  if (field.type === 'radio') {
    const opt = field.options.find(o => o[0] === value);
    return opt ? opt[1] : String(value);
  }
  return String(value);
}
