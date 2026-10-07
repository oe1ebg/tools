// What the printouts show, as plain data (app.js turns it into the
// print-only #print-sheet and calls window.print(); "Als PDF sichern" in the
// print dialog makes the PDF). Pure, unit-tested.
//
// 1. formSheet(): the Meldeaufnahmeformular for one message on one A4 page,
//    with the fields of the ÖBFV E-31 form (SKKM Richtlinie 4.10.1): Ein/Aus,
//    Datum/Uhrzeit with the time zone, Übermittlung, Von, An, Betreff,
//    Inhalt, Name/Unterschrift, Anmerkungen; a block "Nur von der
//    Meldesammelstelle / dem Stab auszufüllen" (Referenz, federführend,
//    mitwirkend, zur Kenntnis; only the reference is filled in, once it was
//    reported back) and the handover (Eingang) or transmission (Ausgang).
//    blankFormSheet(): the same form empty, to print a stack of them for
//    working without a device.
// 2. bookSheet(): the message book for a time range, the Geschäftsbuch
//    columns (one row per message, deleted ones left out).

import {
  DIRECTIONS, CHANNELS, MESSAGE_TYPES, PRIORITIES, REF_KINDS, statusLabel, statusEntry, timeLabel, readBackLabel,
  currentStatus, liveMessages, fmtVienna, fmtUtc,
} from './model.js';
import { partyText } from './form.js';

// The channels as printed (one line, short words).
const PAPER_CHANNELS = [['funk', 'Funk'], ['telefon', 'Telefon'], ['muendlich', 'mündlich'], ['melder', 'Melder'], ['email', 'E-Mail'], ['anders', 'anders']];

// "05.10.2026", "14:07", "MESZ"
function viennaParts(iso) {
  const [date = '', time = '', zone = ''] = fmtVienna(iso).split(' ');
  return { date, time, zone };
}

function viennaHhmm(iso) {
  const p = viennaParts(iso);
  return p.time ? `${p.time} ${p.zone}` : '';
}

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
  const t = viennaParts(msg.ts);
  const channel = PAPER_CHANNELS.some(([k]) => k === msg.channel) ? msg.channel : 'anders';
  const fwd = statusEntry(msg, 'forwarded');
  const ack = statusEntry(msg, 'acknowledged');
  const attempts = msg.attempts || [];
  const ref = msg.replyTo ? byId.get(msg.replyTo)?.number || msg.refNumber : msg.refNumber;
  const handover = msg.direction === 'out'
    ? [fwd?.to || '', fwd ? viennaHhmm(fwd.at) : '', ack ? [ack.who, viennaHhmm(ack.at)].filter(Boolean).join(', ') : '',
      attempts.map(a => [viennaHhmm(a.at), a.note].filter(Boolean).join(' ')).join('; ')]
    : [fwd?.to || '', fwd ? viennaHhmm(fwd.at) : '', ack?.who || '', ack ? viennaHhmm(ack.at) : ''];
  return {
    title: op?.name || '',
    station: [op?.prefix, op?.station].filter(Boolean).join(' '),
    number: msg.number,
    deleted: !!msg.deleted,
    direction: msg.direction,
    directions: Object.entries(DIRECTIONS).map(([key, label]) => ({ key, label, checked: key === msg.direction })),
    staffRef: msg.staffRef || '',
    timeLabel: timeLabel(msg.direction),
    date: t.date, time: t.time, zone: t.zone,
    utc: fmtUtc(msg.ts).split(' ').slice(1).join(' '),
    created: viennaHhmm(msg.created),
    channels: paperOptions(PAPER_CHANNELS, channel),
    channelOther: channel === 'anders' && msg.channel !== 'anders' ? CHANNELS[msg.channel] || msg.channel : '',
    priorities: paperOptions(Object.entries(PRIORITIES), msg.priority),
    alarm: !!msg.alarm,
    alarmDone: msg.alarmDone ? viennaHhmm(msg.alarmDone.at) : '',
    type: MESSAGE_TYPES[msg.type] || msg.type,
    types: Object.values(MESSAGE_TYPES),
    from: partyText(msg.from),
    to: partyText(msg.to),
    peer: msg.peer || '',
    distribution: (msg.distribution || []).join(', '),
    subject: msg.subject,
    location: locationLine(msg.location),
    ref: ref ? `${REF_KINDS[msg.refKind] || REF_KINDS.antwort} ${ref}` : '',
    text: msg.text,
    readBack: !!msg.readBack,
    readBackLabel: readBackLabel(msg.direction),
    extra: [
      msg.stichzeit ? `Stichzeit ${viennaHhmm(msg.stichzeit)}` : '',
      msg.origin?.station || msg.origin?.place || msg.origin?.filed
        ? `Ursprung: ${[msg.origin.station, msg.origin.place, msg.origin.filed ? `aufgegeben ${fmtVienna(msg.origin.filed)}` : ''].filter(Boolean).join(' · ')}` : '',
    ].filter(Boolean).join(' · '),
    operator: msg.operator,
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
    number: '', deleted: false, direction: '',
    directions: Object.entries(DIRECTIONS).map(([key, label]) => ({ key, label, checked: false })),
    staffRef: '',
    timeLabel: 'Empfangen / gesendet am',
    date: '', time: '', zone: '', utc: '', created: '',
    channels: paperOptions(PAPER_CHANNELS, null), channelOther: '',
    priorities: paperOptions(Object.entries(PRIORITIES), null),
    alarm: false, alarmDone: '',
    type: '', types: Object.values(MESSAGE_TYPES),
    from: '', to: '', peer: '', distribution: '', subject: '', location: '', ref: '', text: '',
    readBack: false, readBackLabel: 'Rücklesen erfolgt und als richtig bestätigt',
    extra: '', operator: '', remarks: '',
    handoverHeads: HANDOVER_HEADS.blank, handover: ['', '', '', ''], handoverDone: false,
    status: '', printed: fmtVienna(now), version: null,
  };
}

// fromIso/toIso: optional bounds (inclusive); rows oldest first.
export function bookSheet(msgs, op, { now, fromIso = null, toIso = null }) {
  const rows = liveMessages(msgs)
    .filter(m => (!fromIso || m.ts >= fromIso) && (!toIso || m.ts <= toIso))
    .map(m => {
      const { date } = viennaParts(m.ts);
      return {
        number: m.number, staffRef: m.staffRef || '', date, time: viennaHhmm(m.ts),
        direction: m.direction === 'in' ? 'Ein' : 'Aus',
        party: partyText(m.direction === 'in' ? m.from : m.to),
        subject: m.subject, text: m.text,
        type: MESSAGE_TYPES[m.type] || m.type,
        priority: m.priority === 'routine' ? '' : PRIORITIES[m.priority],
        alarm: !!m.alarm,
        status: statusLabel(currentStatus(m), m.direction),
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
