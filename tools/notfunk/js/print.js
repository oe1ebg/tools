// What the printouts show, as plain data (app.js turns it into the
// print-only #print-sheet and calls window.print(); "Als PDF sichern" in the
// print dialog makes the PDF). Pure, unit-tested.
//
// 1. formSheet(): the Meldeaufnahmeformular for one message, with the
//    fields of the ÖBFV E-31 form (SKKM Richtlinie 4.10.1): Ein/Aus,
//    Datum/Uhrzeit, Übermittlung (Tel./Mobil/Fax/E-Mail/Funk/Anders), Von,
//    An, Betreff, Inhalt, Name/Unterschrift, Anmerkungen, and an empty box
//    "Geschäftszahl, Auszeichnung" for the staff.
//    blankFormSheet(): the same form empty, to print a stack of them for
//    working without a device.
// 2. bookSheet(): the message book for a time range, the Geschäftsbuch
//    columns (one row per message, deleted ones left out).

import { DIRECTIONS, CHANNELS, MESSAGE_TYPES, PRIORITIES, STATUS_LABELS, currentStatus, liveMessages, fmtVienna, fmtUtc } from './model.js';
import { partyText } from './form.js';

// E-31 boxes; channels without their own box are "Anders" with the name.
const E31_CHANNELS = [['telefon', 'Tel.'], ['mobil', 'Mobil'], ['fax', 'Fax'], ['email', 'E-Mail'], ['funk', 'Funk'], ['anders', 'Anders']];

function viennaParts(iso) {
  const [date = '', time = '', zone = ''] = fmtVienna(iso).split(' ');
  return { date, time: time && `${time} ${zone}` };
}

function locationLine(loc) {
  if (!loc) return '';
  return [loc.label, loc.postcode && !loc.label.includes(loc.postcode) ? loc.postcode : '', loc.maidenhead].filter(Boolean).join(' · ');
}

// revisions: how many earlier versions are stored (the printout says
// "Fassung n+1", so a paper copy can be matched to the edit history).
export function formSheet(msg, op, { now, revisions = 0, byId = new Map() }) {
  const { date, time } = viennaParts(msg.ts);
  const own = CHANNELS[msg.channel] ? msg.channel : 'anders';
  const boxed = E31_CHANNELS.some(([k]) => k === own);
  return {
    title: op?.name || '',
    number: msg.number,
    deleted: !!msg.deleted,
    direction: msg.direction,
    directions: Object.entries(DIRECTIONS).map(([k, label]) => ({ key: k, label, checked: k === msg.direction })),
    date, time, utc: fmtUtc(msg.ts).split(' ').slice(1).join(' '),
    priority: PRIORITIES[msg.priority] || msg.priority,
    priorities: Object.entries(PRIORITIES).map(([k, label]) => ({ key: k, label, checked: k === msg.priority })),
    urgent: msg.priority !== 'routine',
    alarm: !!msg.alarm,
    channels: E31_CHANNELS.map(([k, label]) => ({
      label,
      checked: boxed ? k === own : k === 'anders',
      detail: k === 'funk' && own === 'funk' ? [msg.radio?.freq && `${msg.radio.freq} MHz`, msg.radio?.via && `via ${msg.radio.via}`].filter(Boolean).join(' ')
        : k === 'anders' && !boxed ? CHANNELS[msg.channel] || msg.channel : '',
    })),
    from: partyText(msg.from),
    to: [partyText(msg.to), msg.distribution?.length ? `Verteiler: ${msg.distribution.join(', ')}` : ''].filter(Boolean).join(' · '),
    subject: msg.subject,
    type: MESSAGE_TYPES[msg.type] || msg.type,
    text: msg.text,
    readBack: !!msg.readBack,
    stichzeit: msg.stichzeit ? viennaParts(msg.stichzeit).time : '',
    origin: msg.origin?.station || msg.origin?.place || msg.origin?.filed
      ? [msg.origin.station, msg.origin.place, msg.origin.filed ? `aufgegeben ${fmtVienna(msg.origin.filed)}` : ''].filter(Boolean).join(' · ') : '',
    location: locationLine(msg.location),
    replyTo: msg.replyTo ? byId.get(msg.replyTo)?.number || '' : '',
    operator: msg.operator,
    remarks: msg.remarks || '',
    status: STATUS_LABELS[currentStatus(msg)],
    printed: fmtVienna(now),
    version: revisions + 1,
  };
}

// The empty form: every box unticked, every field blank (handwriting),
// the priorities and "Stab herhören!" as boxes to tick.
export function blankFormSheet(op, { now }) {
  return {
    blank: true,
    title: op?.name || '',
    number: '', deleted: false,
    directions: Object.entries(DIRECTIONS).map(([key, label]) => ({ key, label, checked: false })),
    date: '', time: '', utc: '',
    priorities: Object.entries(PRIORITIES).map(([key, label]) => ({ key, label, checked: false })),
    types: Object.values(MESSAGE_TYPES),
    urgent: false, alarm: false, priority: '',
    channels: E31_CHANNELS.map(([, label]) => ({ label, checked: false, detail: '' })),
    from: '', to: '', subject: '', type: '', text: '', readBack: false,
    stichzeit: '', origin: '', location: '', replyTo: '', operator: '', remarks: '', status: '',
    printed: fmtVienna(now), version: null,
  };
}

// fromIso/toIso: optional bounds (inclusive); rows oldest first.
export function bookSheet(msgs, op, { now, fromIso = null, toIso = null }) {
  const rows = liveMessages(msgs)
    .filter(m => (!fromIso || m.ts >= fromIso) && (!toIso || m.ts <= toIso))
    .map(m => {
      const { date, time } = viennaParts(m.ts);
      return {
        number: m.number, date, time,
        direction: m.direction === 'in' ? 'Ein' : 'Aus',
        party: partyText(m.direction === 'in' ? m.from : m.to),
        subject: m.subject, text: m.text,
        type: MESSAGE_TYPES[m.type] || m.type,
        priority: m.priority === 'routine' ? '' : PRIORITIES[m.priority],
        alarm: !!m.alarm,
        status: STATUS_LABELS[currentStatus(m)],
        operator: m.operator,
      };
    });
  return {
    title: op?.name || '',
    station: [op?.prefix, op?.station].filter(Boolean).join(' '),
    range: fromIso || toIso ? `${fromIso ? fmtVienna(fromIso) : 'Beginn'} bis ${toIso ? fmtVienna(toIso) : 'jetzt'}` : 'gesamter Einsatz',
    printed: fmtVienna(now),
    rows,
  };
}
