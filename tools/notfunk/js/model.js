// Data model of the emergency traffic log (Nachrichtenbuch). Pure functions,
// no DOM, no storage — unit-tested in oe1ebg/tests/notfunk-*.test.mjs.
//
// One record per message, modelled on the SKKM Meldeaufnahmeformular
// (Richtlinie für das Führen im Katastropheneinsatz, 4.10.1; ÖBFV E-31
// annex): direction, running number, time, channel, sender/recipient,
// subject, verbatim text, operator, further handling. Field choices and
// open questions: ../README.md. Times are stored as ISO 8601 UTC and shown
// in Austrian local time (ZONE, fmtVienna).
//
// Message numbers come from numbering.js and are immutable: editMessage()
// never touches prefix/seq/number. Edits keep the previous version as a
// revision; deletes are soft (`deleted` timestamp).

import { wallClock, isRepeatedWall, isoInZone } from '../../shared/js/time.js';

export const DIRECTIONS = { in: 'Eingang', out: 'Ausgang' };
export const CHANNELS = {
  funk: 'Funk', telefon: 'Telefon', muendlich: 'mündlich', melder: 'Melder', email: 'E-Mail', fax: 'Fax', anders: 'anders',
};
export const MESSAGE_TYPES = {
  meldung: 'Meldung', auftrag: 'Auftrag', frage: 'Frage', anforderung: 'Anforderung', lagemeldung: 'Lagemeldung',
};
// Dringlichkeit. Provisional: no Austrian staff document defines levels
// (README, open question 3); three levels after the IARU/ARENA radiogram
// precedences (keys kept from the first draft). `alarm` asks for the
// message to be announced with "Stab herhören!" (ÖBFV E-31 4.1.5); the
// announcement itself is recorded separately (announceAlarm()), so a
// ticked box never pretends it happened.
export const PRIORITIES = { routine: 'Routine', priority: 'Dringend', emergency: 'Notfall' };
// Handling states in order; a message can skip states but never go back.
// The words depend on the direction: an incoming message is handed over to
// the Meldesammelstelle (übergeben) and taken over by it (übernommen), an
// outgoing one is transmitted (übertragen) and its receipt confirmed. None
// of them means that an order in the text has been carried out.
export const STATUS_FLOW = ['logged', 'forwarded', 'acknowledged', 'answered'];
export const STATUS_WORDS = {
  in: { logged: 'erfasst', forwarded: 'übergeben', acknowledged: 'übernommen', answered: 'beantwortet' },
  out: { logged: 'zur Übertragung', forwarded: 'übertragen', acknowledged: 'Empfang bestätigt', answered: 'beantwortet' },
};
// The label of a state for a message (or a direction).
export function statusLabel(state, direction) {
  return (STATUS_WORDS[direction] || STATUS_WORDS.in)[state] || state;
}
// Bezug: what a message refers to (replyTo = the id of that message in
// this operation, refNumber = its number as typed, also from elsewhere).
export const REF_KINDS = { antwort: 'Antwort auf', korrektur: 'Korrektur zu', ergaenzung: 'Ergänzung zu' };

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function trimmed(v) {
  return String(v ?? '').trim();
}

// A frequency as typed ("145,5", "145.500 MHz") -> "145.500" (point, at
// least three decimals); anything that isn't a number is kept as typed.
export function normFreq(v) {
  const t = trimmed(v).replace(/\s*mhz$/i, '');
  if (!/^\d{1,5}([.,]\d{1,6})?$/.test(t)) return t;
  const [int, dec = ''] = t.replace(',', '.').split('.');
  return `${int}.${dec.padEnd(3, '0')}`;
}

// "145.500" -> "145,500" (German decimal comma, as shown and printed).
export function fmtFreq(v) {
  const t = normFreq(v);
  return /^\d+\.\d+$/.test(t) ? t.replace('.', ',') : t;
}

function party(p) {
  return { name: trimmed(p?.name), call: trimmed(p?.call).toUpperCase(), contact: trimmed(p?.contact) };
}

// The editable fields of a message, normalised. Unknown keys are dropped.
export function messageFields(f) {
  return {
    direction: f.direction,
    ts: f.ts,
    channel: f.channel || 'funk',
    radio: { freq: normFreq(f.radio?.freq), via: trimmed(f.radio?.via).toUpperCase() },
    // Gegenstelle: the radio station heard (in) or sent to (out); from/to
    // are the sender and addressee of the message itself.
    peer: trimmed(f.peer).toUpperCase(),
    type: f.type || 'meldung',
    priority: f.priority || 'routine',
    alarm: !!f.alarm,
    from: party(f.from),
    to: party(f.to),
    distribution: (f.distribution || []).map(trimmed).filter(Boolean),
    subject: trimmed(f.subject),
    text: String(f.text ?? '').replace(/\r\n?/g, '\n').trim(), // verbatim: inner whitespace kept
    stichzeit: f.stichzeit || null,
    origin: {
      station: trimmed(f.origin?.station).toUpperCase(), place: trimmed(f.origin?.place), filed: f.origin?.filed || null,
      placeLoc: f.origin?.placeLoc || null,
    },
    readBack: !!f.readBack,
    location: f.location || null,
    replyTo: f.replyTo || null,
    refKind: f.refKind in REF_KINDS ? f.refKind : (f.replyTo || trimmed(f.refNumber) ? 'antwort' : null),
    refNumber: trimmed(f.refNumber).toUpperCase(),
    // the Meldesammelstelle's own number for this message (Geschäftsbuch),
    // once it is reported back; never the Notfunk number
    staffRef: trimmed(f.staffRef),
    remarks: trimmed(f.remarks),
  };
}

// Problems that block saving (German, shown in the form). Logging is
// otherwise never blocked: everything but the essentials is optional.
export function validateMessage(f) {
  const errs = [];
  if (!(f.direction in DIRECTIONS)) errs.push('Eingang oder Ausgang wählen');
  if (!ISO_RE.test(f.ts || '')) errs.push('Zeit fehlt oder ist ungültig');
  if (!(f.channel in CHANNELS)) errs.push('unbekannter Übermittlungsweg');
  if (!(f.type in MESSAGE_TYPES)) errs.push('unbekannte Nachrichtenart');
  if (!(f.priority in PRIORITIES)) errs.push('unbekannte Dringlichkeit');
  if (!f.from.name && !f.from.call) errs.push('Absender fehlt');
  if (!f.to.name && !f.to.call) errs.push('Adressat fehlt');
  // (the form asks for both; older records may have only one of them)
  if (!f.text && !f.subject) errs.push('Betreff oder Inhalt fehlt');
  for (const k of ['stichzeit']) if (f[k] && !ISO_RE.test(f[k])) errs.push('Stichzeit ist ungültig');
  if (f.origin.filed && !ISO_RE.test(f.origin.filed)) errs.push('Aufgabezeit ist ungültig');
  return errs;
}

// What the time of a message is called: received (in) or sent (out).
export function timeLabel(direction) {
  return direction === 'out' ? 'Gesendet am' : 'Empfangen am';
}

// The read-back confirmation, worded for the direction.
export function readBackLabel(direction) {
  return direction === 'out'
    ? 'Von der Gegenstelle rückgelesen und als richtig bestätigt'
    : 'Rücklesen erfolgt und vom Absender als richtig bestätigt';
}

// A new message record. numbered: { prefix, seq, number } from
// numbering.saveNumbered(); meta: { id, opId, operator, now }.
export function newMessage(fields, numbered, meta) {
  const f = messageFields(fields);
  const errs = validateMessage(f);
  if (errs.length) throw new Error(errs.join('; '));
  return {
    id: meta.id, eventId: meta.opId,
    prefix: numbered.prefix, seq: numbered.seq, number: numbered.number,
    ...f,
    operator: trimmed(meta.operator).toUpperCase(),
    status: [{ state: 'logged', at: meta.now, by: trimmed(meta.operator).toUpperCase(), note: '' }],
    attempts: [], alarmDone: null,
    created: meta.now, updated: meta.now, deleted: null,
  };
}

// An edit: { next, revision }. Store both in one tx. The revision is the
// previous version as it was; identity, number and history are kept.
export function editMessage(msg, changes, { revisionId, operator, now }) {
  const f = messageFields({ ...msg, ...changes });
  const errs = validateMessage(f);
  if (errs.length) throw new Error(errs.join('; '));
  const next = { ...msg, ...f, updated: now, editedBy: trimmed(operator).toUpperCase() };
  const revision = { id: revisionId, eventId: msg.eventId, messageId: msg.id, at: now, by: next.editedBy, old: msg };
  return { next, revision };
}

export function softDelete(msg, { operator, now }) {
  return { ...msg, deleted: now, deletedBy: trimmed(operator).toUpperCase(), updated: now };
}

export function restoreDeleted(msg, { now }) {
  return { ...msg, deleted: null, updated: now };
}

// The furthest state reached. The handover steps (forwarded, acknowledged)
// and the answer are separate facts: a reply can come before the handover
// is recorded, and the handover can still be recorded after it.
export function currentStatus(msg) {
  return STATUS_FLOW[Math.max(...msg.status.map(s => STATUS_FLOW.indexOf(s.state)))];
}

const HANDOVER = ['forwarded', 'acknowledged'];

// The next handover step not recorded yet (forwarded, then acknowledged),
// or null.
export function nextHandover(msg) {
  const done = new Set(msg.status.map(s => s.state));
  if (done.has('acknowledged')) return null;
  return done.has('forwarded') ? 'acknowledged' : 'forwarded';
}

// Record a status step; throws when it is recorded already or would go
// back (handing over after the takeover, answering twice).
// at: when it happened (default now; `recorded` is always now), to: handed
// over / transmitted to whom, who: taken over / receipt confirmed by whom,
// readBack: an outgoing message was read back by the receiving station.
export function setStatus(msg, state, { operator, now, at = null, to = '', who = '', note = '', readBack = false }) {
  if (!STATUS_FLOW.includes(state) || state === 'logged') throw new Error(`unbekannter Status: ${state}`);
  const done = new Set(msg.status.map(s => s.state));
  const back = HANDOVER.includes(state)
    ? HANDOVER.slice(HANDOVER.indexOf(state)).some(s => done.has(s))
    : done.has(state);
  if (back) throw new Error(`Status kann nicht von „${statusLabel(currentStatus(msg), msg.direction)}“ auf „${statusLabel(state, msg.direction)}“ zurückgesetzt werden`);
  if (at && !ISO_RE.test(at)) throw new Error('Zeitpunkt ist ungültig');
  const entry = {
    state, at: at || now, recorded: now, by: trimmed(operator).toUpperCase(),
    to: trimmed(to), who: trimmed(who), note: trimmed(note),
  };
  if (readBack) entry.readBack = true;
  return { ...msg, ...(readBack ? { readBack: true } : {}), status: [...msg.status, entry], updated: now };
}

// The status entry of a state, if it was reached.
export function statusEntry(msg, state) {
  return msg.status.find(s => s.state === state) || null;
}

// A failed transmission attempt or a query back (Rückfrage): logged, the
// status stays where it is.
export function addAttempt(msg, { operator, now, at = null, note = '' }) {
  if (at && !ISO_RE.test(at)) throw new Error('Zeitpunkt ist ungültig');
  return { ...msg, attempts: [...(msg.attempts || []), { at: at || now, recorded: now, by: trimmed(operator).toUpperCase(), note: trimmed(note) }], updated: now };
}

// "Stab herhören!" was actually announced: when, by / to whom.
export function announceAlarm(msg, { operator, now, at = null, note = '' }) {
  if (!msg.alarm) throw new Error('„Stab herhören!“ ist für diese Meldung nicht angefordert');
  if (at && !ISO_RE.test(at)) throw new Error('Zeitpunkt ist ungültig');
  return { ...msg, alarmDone: { at: at || now, recorded: now, by: trimmed(operator).toUpperCase(), note: trimmed(note) }, updated: now };
}

// Live (not deleted) messages in number order per prefix, then by time.
export function liveMessages(msgs) {
  return msgs.filter(m => !m.deleted).sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.prefix < b.prefix ? -1 : a.prefix > b.prefix ? 1 : a.seq - b.seq));
}

// Replies to a message (replyTo = its id), oldest first.
export function repliesTo(msgs, id) {
  return liveMessages(msgs).filter(m => m.replyTo === id);
}

// Filters for the message book and the map: { direction, priority, status,
// open: true = not yet taken over / receipt not confirmed, query: text search }.
export function filterMessages(msgs, flt = {}) {
  const q = trimmed(flt.query).toLowerCase();
  return liveMessages(msgs).filter(m =>
    (!flt.direction || m.direction === flt.direction)
    && (!flt.priority || m.priority === flt.priority)
    && (!flt.status || currentStatus(m) === flt.status)
    && (!flt.open || !m.status.some(x => x.state === 'acknowledged'))
    && (!q || [m.number, m.staffRef, m.peer, m.subject, m.text, m.from.name, m.from.call, m.to.name, m.to.call].join(' ').toLowerCase().includes(q)));
}

// All times are Austrian local time (Europe/Vienna), on any device: typed,
// shown, printed and exported. Stored as ISO 8601 UTC, so the DST change
// is no problem; only the hour that repeats when the clocks go back gets
// its zone (MESZ, then MEZ) where a time is shown.
export const ZONE = 'Europe/Vienna';

const ZONE_NAME_FMT = new Intl.DateTimeFormat('de-AT', { timeZone: ZONE, timeZoneName: 'short' });

// "MESZ" / "MEZ" in the repeated hour, '' otherwise.
export function zoneHint(iso) {
  if (!isRepeatedWall(iso, ZONE)) return '';
  return ZONE_NAME_FMT.formatToParts(new Date(iso)).find(p => p.type === 'timeZoneName')?.value || '';
}

// "05.10.2026" and "14:07" (in the repeated hour "02:30 MESZ").
export function viennaDate(iso) {
  const { date } = wallClock(iso, ZONE);
  return date ? `${date.slice(8, 10)}.${date.slice(5, 7)}.${date.slice(0, 4)}` : '';
}

export function viennaTime(iso) {
  const { time } = wallClock(iso, ZONE);
  if (!time) return '';
  const hint = zoneHint(iso);
  return `${time.slice(0, 5)}${hint ? ` ${hint}` : ''}`;
}

// "05.10.2026 14:07", as on the Austrian staff forms (TT.MM.JJJJ hh:mm).
export function fmtVienna(iso) {
  const d = viennaDate(iso);
  return d ? `${d} ${viennaTime(iso)}` : '';
}

// "2026-10-05T14:07:00+02:00": ISO 8601 with the offset, for the CSV.
export function isoVienna(iso) {
  return isoInZone(iso, ZONE);
}
