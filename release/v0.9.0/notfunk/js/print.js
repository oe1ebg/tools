// What the printouts show, as plain data (paperpdf.js draws it as PDFs with
// the shared writer). Pure, unit-tested.
//
// 1. formSheet(): the Meldeaufnahmeformular for one message on one A4 page,
//    with the fields of the ÖBFV E-31 form (SKKM Richtlinie 4.10.1): Ein/Aus,
//    Datum/Uhrzeit (Austrian local time), Übermittlung, Von, An, Betreff,
//    Inhalt, Name/Unterschrift, Anmerkungen; a block "Nur von der
//    Meldesammelstelle auszufüllen" (Referenz, federführend,
//    mitwirkend, zur Kenntnis; only the reference is filled in, once it was
//    reported back) and the handover (Eingang) or transmission (Ausgang).
//    blankFormSheet(): the same form empty, to print a stack of for working
//    without a device.
// 2. bookSheet(): the message book for a time range, the Geschäftsbuch
//    columns (one row per message, deleted ones left out).

import {
  DIRECTIONS, CHANNELS, MESSAGE_TYPES, PRIORITIES, REF_KINDS, statusLabel, statusEntry, timeLabel, readBackLabel,
  currentStatus, liveMessages, fmtVienna, viennaDate, viennaTime, fmtFreq,
} from './model.js';
import { partyText } from './form.js';

// Every field of the Einsatz header ("Einsatz" panel), labelled, for the
// head of a printout: [[label, value]], the empty ones left out.
export function einsatzFields(op) {
  return [
    ['Stationskürzel', op?.prefix], ['Station', op?.call], ['Standort', op?.station],
    ['Operator', op?.operator], ['Für Stelle', op?.home],
    ['Frequenz', op?.freq ? `${fmtFreq(op.freq)} MHz` : ''], ['Relais', op?.via],
  ].filter(([, v]) => v);
}

// The channels as printed (one line, short words).
const PAPER_CHANNELS = [['funk', 'Funk'], ['telefon', 'Telefon'], ['muendlich', 'mündlich'], ['melder', 'Melder'], ['email', 'E-Mail'], ['anders', 'anders']];

function locationLine(loc) {
  if (!loc) return '';
  return [loc.label, loc.postcode && !loc.label.includes(loc.postcode) ? loc.postcode : '', loc.maidenhead].filter(Boolean).join(' · ');
}

function paperOptions(list, chosen) {
  return list.map(([key, label]) => ({ key, label, checked: key === chosen }));
}

const HANDOVER_HEADS = {
  in: ['Übergeben an', 'Übergabezeitpunkt', 'Übernommen durch', 'Übernahme bestätigt'],
  out: ['Übertragen an', 'Übertragungszeitpunkt', 'Empfang bestätigt durch', 'Fehlversuche / Rückfrage'],
  blank: ['Übergeben / übertragen an', 'Zeitpunkt', 'Übernommen / empfangen durch', 'Bestätigt'],
};

// revisions: how many earlier versions are stored (the printout says
// "Fassung n+1", so a paper copy can be matched to the edit history).
export function formSheet(msg, op, { now, revisions = 0, byId = new Map() }) {
  const channel = PAPER_CHANNELS.some(([k]) => k === msg.channel) ? msg.channel : 'anders';
  const fwd = statusEntry(msg, 'forwarded');
  const ack = statusEntry(msg, 'acknowledged');
  const attempts = msg.attempts || [];
  const ref = msg.replyTo ? byId.get(msg.replyTo)?.number || msg.refNumber : msg.refNumber;
  const handover = msg.direction === 'out'
    ? [fwd?.to || '', fwd ? viennaTime(fwd.at) : '', ack ? [ack.who, viennaTime(ack.at)].filter(Boolean).join(', ') : '',
      attempts.map(a => [viennaTime(a.at), a.note].filter(Boolean).join(' ')).join('; ')]
    : [fwd?.to || '', fwd ? viennaTime(fwd.at) : '', ack?.who || '', ack ? viennaTime(ack.at) : ''];
  return {
    title: op?.name || '',
    station: [op?.prefix, msg.stationCall || op?.call, op?.station].filter(Boolean).join(' · '),
    einsatz: einsatzFields(op),
    number: msg.number,
    deleted: !!msg.deleted,
    direction: msg.direction,
    directions: Object.entries(DIRECTIONS).map(([key, label]) => ({ key, label, checked: key === msg.direction })),
    staffRef: msg.staffRef || '',
    timeLabel: timeLabel(msg.direction),
    date: viennaDate(msg.ts), time: viennaTime(msg.ts),
    created: viennaTime(msg.created),
    channels: paperOptions(PAPER_CHANNELS, channel),
    channelOther: channel === 'anders' && msg.channel !== 'anders' ? CHANNELS[msg.channel] || msg.channel : '',
    priorities: paperOptions(Object.entries(PRIORITIES), msg.priority),
    type: MESSAGE_TYPES[msg.type] || msg.type,
    types: paperOptions(Object.entries(MESSAGE_TYPES), msg.type),
    from: partyText(msg.from),
    to: partyText(msg.to),
    peer: msg.peer || '',
    distribution: (msg.distribution || []).join(', '),
    subject: msg.subject,
    location: locationLine(msg.location) || msg.locationText || '',
    ref: ref ? `${REF_KINDS[msg.refKind] || REF_KINDS.antwort} ${ref}` : '',
    text: msg.text,
    readBack: !!msg.readBack,
    readBackLabel: readBackLabel(msg.direction),
    extra: [
      msg.stichzeit ? `Stichzeit ${viennaTime(msg.stichzeit)}` : '',
      msg.origin?.station || msg.origin?.place || msg.origin?.filed
        ? `Ursprung: ${[msg.origin.station, msg.origin.place, msg.origin.filed ? `aufgegeben ${fmtVienna(msg.origin.filed)}` : ''].filter(Boolean).join(' · ')}` : '',
    ].filter(Boolean).join(' · '),
    operator: msg.operator,
    stationCall: msg.stationCall || '',
    remarks: msg.remarks || '',
    handoverHeads: HANDOVER_HEADS[msg.direction] || HANDOVER_HEADS.in,
    handover,
    handoverDone: !!ack,
    status: statusLabel(currentStatus(msg), msg.direction),
    printed: fmtVienna(now),
    version: revisions + 1,
  };
}

// The empty form: every box unticked, every field blank (handwriting).
export function blankFormSheet(op, { now }) {
  return {
    blank: true,
    title: op?.name || '',
    station: '',
    // printed before an Einsatz starts: its header is not known yet
    einsatz: [],
    number: '', deleted: false, direction: '',
    directions: Object.entries(DIRECTIONS).map(([key, label]) => ({ key, label, checked: false })),
    staffRef: '',
    timeLabel: 'Empfangen / gesendet am',
    date: '', time: '', created: '',
    channels: paperOptions(PAPER_CHANNELS, null), channelOther: '',
    priorities: paperOptions(Object.entries(PRIORITIES), null),
    type: '', types: paperOptions(Object.entries(MESSAGE_TYPES), null),
    from: '', to: '', peer: '', distribution: '', subject: '', location: '', ref: '', text: '',
    readBack: false, readBackLabel: 'Rücklesen erfolgt und als richtig bestätigt',
    extra: '', operator: '', stationCall: '', remarks: '',
    handoverHeads: HANDOVER_HEADS.blank, handover: ['', '', '', ''], handoverDone: false,
    status: '', printed: fmtVienna(now), version: null,
  };
}

// The name of a party (the callsign only when there is no name), as the
// book on screen shows it.
function printPartyName(p) {
  return p?.name || p?.call || '';
}

// fromIso/toIso: optional bounds (inclusive); rows oldest first. Per row the
// columns of the book on screen: number (date, time, the Meldesammelstelle's
// reference, the message it answers), the other party with the direction
// (`own`: the own side, only where it differs from the usual one), type /
// priority / subject / text, and the status with its time and operator.
export function bookSheet(msgs, op, { now, fromIso = null, toIso = null }) {
  const live = liveMessages(msgs);
  const numberOf = new Map(msgs.map(m => [m.id, m.number]));
  const count = new Map();
  for (const m of live) {
    const own = printPartyName(m.direction === 'in' ? m.to : m.from);
    if (own) count.set(own, (count.get(own) || 0) + 1);
  }
  const home = [...count].sort((a, b) => b[1] - a[1])[0]?.[0] || op?.home || '';
  const chosen = live.filter(m => (!fromIso || m.ts >= fromIso) && (!toIso || m.ts <= toIso));
  // the range as dates and times: the chosen bounds, else the first and the
  // last message's time; "(gesamter Einsatz)" when no bound was chosen
  const times = chosen.map(m => m.ts).sort();
  const from = fromIso || times[0], to = toIso || times.at(-1);
  const range = from && to ? `${fmtVienna(from)} bis ${fmtVienna(to)}${fromIso || toIso ? '' : ' (gesamter Einsatz)'}`
    : fromIso || toIso ? `${fromIso ? fmtVienna(fromIso) : 'Beginn'} bis ${toIso ? fmtVienna(toIso) : 'jetzt'}` : 'gesamter Einsatz';
  const rows = chosen
    .map(m => {
      const inbound = m.direction === 'in';
      const own = printPartyName(inbound ? m.to : m.from);
      const last = m.status[m.status.length - 1];
      return {
        number: m.number, staffRef: m.staffRef || '', date: viennaDate(m.ts), time: viennaTime(m.ts),
        reply: (m.replyTo ? numberOf.get(m.replyTo) : '') || m.refNumber || '',
        inbound,
        direction: inbound ? 'Ein' : 'Aus',
        party: partyText(inbound ? m.from : m.to),
        own: own && own !== home ? own : '',
        subject: m.subject, text: m.text,
        type: MESSAGE_TYPES[m.type] || m.type,
        priority: m.priority === 'routine' ? '' : PRIORITIES[m.priority],
        status: statusLabel(currentStatus(m), m.direction),
        statusAt: last ? fmtVienna(last.at) : '', statusBy: last?.by || '',
        operator: m.operator,
      };
    });
  return {
    title: op?.name || '',
    station: [op?.prefix, op?.call, op?.station].filter(Boolean).join(' · '),
    einsatz: einsatzFields(op),
    range,
    printed: fmtVienna(now),
    rows,
  };
}
