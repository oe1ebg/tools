// The entry form of the message book as plain data: what the inputs hold
// (strings and booleans) <-> the message fields of model.js. Pure, no DOM,
// unit-tested (oe1ebg/tests/notfunk-form.test.mjs); app.js reads and writes
// the inputs.
//
// From/To are one text each, as heard ("Lichtinsel 12 Floridsdorf",
// "OE1ABC", "Stab S4 / OE1ABC"): a lone callsign goes to `call`, "name /
// CALL" is split, anything else is the name. The operation's own post
// (`op.home`, e.g. "Stab") is the default recipient of incoming and the
// default sender of outgoing messages.

import { STATUS_FLOW, statusLabel, currentStatus, nextHandover, messageFields, validateMessage, liveMessages, normFreq } from './model.js';
import { numberGaps, parseNumber, formatNumber } from './numbering.js';
import { normalizeCall, isPlausibleCall } from '../../shared/js/callbook.js';
import { parseTimeInput, splitTime } from '../../shared/js/time.js';

export const FORM_DEFAULTS = {
  direction: 'in', time: '', channel: 'funk', freq: '', via: '', type: 'meldung', priority: 'routine', alarm: false,
  from: '', to: '', peer: '', subject: '', text: '', readBack: false, stichzeit: '', distribution: '', remarks: '',
  origStation: '', origPlace: '', origPlaceLoc: null, origFiled: '', replyTo: null, refKind: 'antwort', ref: '',
  location: null, locationText: '',
  // the stored time of an edited message: kept as it is (seconds included)
  // as long as the time field still shows it
  ts: null,
};

// A fresh form for an operation: its default frequency/relay and own post.
export function emptyForm(op) {
  return { ...FORM_DEFAULTS, freq: op?.freq ? normFreq(op.freq) : '', via: op?.via || '', to: op?.home || '' };
}

// Switching Eingang/Ausgang moves the own post to the other side when it
// is still where the default put it.
export function setDirection(form, direction, op) {
  const home = op?.home || '';
  const next = { ...form, direction };
  if (!home || form.direction === direction) return next;
  if (direction === 'out' && form.to === home && !form.from) return { ...next, from: home, to: '' };
  if (direction === 'in' && form.from === home && !form.to) return { ...next, to: home, from: '' };
  return next;
}

// "Stab S4 / OE1ABC" -> { name: 'Stab S4', call: 'OE1ABC' }; "oe1abc" ->
// { call: 'OE1ABC' }; anything else -> { name }.
export function parseParty(text) {
  const t = String(text ?? '').trim();
  const m = /^(.*\S)\s*\/\s*([A-Za-z0-9/]+)$/.exec(t);
  if (m && isPlausibleCall(normalizeCall(m[2]))) return { name: m[1], call: normalizeCall(m[2]), contact: '' };
  const call = normalizeCall(t);
  if (t && !/\s/.test(t) && isPlausibleCall(call)) return { name: '', call, contact: '' };
  return { name: t, call: '', contact: '' };
}

export function partyText(p) {
  if (!p) return '';
  if (p.name && p.call && p.call !== p.name) return `${p.name} / ${p.call}`;
  return p.name || p.call || '';
}

// A typed time in the form ("14:05", "2026-10-07 14:05", empty = now) as
// ISO UTC, or null when it can't be read. mode: 'local' or 'utc'.
export function readTime(text, mode, nowIso) {
  return String(text ?? '').trim() ? parseTimeInput(text, mode, nowIso) : nowIso;
}

// A typed message number ("w1-7") as stored ("W1-007"); anything else as typed.
export function normalizeRef(text) {
  const t = String(text ?? '').trim();
  const n = parseNumber(t);
  return n ? formatNumber(n.prefix, n.seq) : t.toUpperCase();
}

// "2026-10-07 14:05" in the given mode, for putting a stored time back into
// the form (seconds dropped). Also the prefill of the time field when a
// message is begun: with the date, so a message finished after midnight
// or typed in later from paper keeps the right day.
export function timeText(iso, mode) {
  const { date, time } = splitTime(iso, mode);
  return date ? `${date} ${time.slice(0, 5)}` : '';
}

const TIME_HINT = 'HH:MM oder JJJJ-MM-TT HH:MM';
const isBlankText = v => !String(v ?? '').trim();

// Form -> { fields, errors, fieldErrors, warnings }: fields for
// model.newMessage()/editMessage(); fieldErrors (German, by form field:
// time, from, to, subject, text, stichzeit, origFiled) block saving and are
// shown at the field, errors is the same as a list; warnings only ask
// before saving (missing radio station, a time far off, no read-back).
// byNumber: the operation's messages by number, to link the Bezug.
// editing: an edit of a stored message (no time warnings).
export function formToFields(form, { mode = 'local', now, byNumber = new Map(), editing = false }) {
  const fieldErrors = {};
  const ts = form.ts && form.time === timeText(form.ts, mode) ? form.ts : readTime(form.time, mode, now);
  if (!ts) fieldErrors.time = `Datum und Uhrzeit als ${TIME_HINT}`;
  if (isBlankText(form.from)) fieldErrors.from = 'Absender fehlt: wer gibt die Meldung auf?';
  if (isBlankText(form.to)) fieldErrors.to = 'Adressat fehlt: für wen ist die Meldung?';
  if (isBlankText(form.subject)) fieldErrors.subject = 'Betreff fehlt';
  if (isBlankText(form.text)) fieldErrors.text = 'Inhalt fehlt';
  let stichzeit = null;
  if (form.type === 'lagemeldung' && !isBlankText(form.stichzeit)) {
    stichzeit = readTime(form.stichzeit, mode, ts || now);
    if (!stichzeit) fieldErrors.stichzeit = `Stichzeit als ${TIME_HINT}`;
  }
  let filed = null;
  if (!isBlankText(form.origFiled)) {
    filed = readTime(form.origFiled, mode, ts || now);
    if (!filed) fieldErrors.origFiled = `Aufgabezeit als ${TIME_HINT}`;
  }
  // Bezug: a number of this operation links the message, anything else is
  // kept as typed (e.g. a number of another station).
  const refNumber = normalizeRef(form.ref);
  const refMsg = refNumber ? byNumber.get(refNumber) : null;
  const fields = messageFields({
    direction: form.direction,
    ts: ts || now,
    channel: form.channel,
    radio: { freq: form.freq, via: form.via },
    peer: form.channel === 'funk' ? form.peer : '',
    type: form.type,
    priority: form.priority,
    alarm: form.alarm,
    from: parseParty(form.from),
    to: parseParty(form.to),
    distribution: String(form.distribution ?? '').split(/[,;]/),
    subject: form.subject,
    text: form.text,
    stichzeit,
    origin: { station: form.origStation, place: form.origPlace, filed, placeLoc: isBlankText(form.origPlace) ? null : form.origPlaceLoc || null },
    readBack: form.readBack,
    location: form.location || null,
    replyTo: refMsg ? refMsg.id : refNumber ? null : form.replyTo || null,
    refKind: refNumber || form.replyTo ? form.refKind : null,
    refNumber: refMsg ? refMsg.number : refNumber,
    remarks: form.remarks,
  });
  // Unreadable times were replaced above (now / none), and the form asks
  // for more than the model, so the model adds only what is left.
  const errors = Object.values(fieldErrors);
  if (!errors.length) errors.push(...validateMessage(fields));
  const warnings = [];
  if (fields.channel === 'funk' && !fields.peer) warnings.push('Gegenstelle fehlt');
  if (ts && !editing) {
    const min = Math.round((Date.parse(now) - Date.parse(ts)) / 60000);
    if (min < -5) warnings.push('Zeit liegt in der Zukunft');
    else if (min > 60) warnings.push(`Zeit liegt ${min < 120 ? `${min} min` : `${Math.round(min / 60)} h`} zurück (Nachtrag?)`);
  }
  if (fields.direction === 'in' && !fields.readBack && fields.text) warnings.push('Rücklesen nicht bestätigt');
  return { fields, errors, fieldErrors, warnings };
}

// Has anything of the message been typed yet? (The time is prefilled at
// the first keystroke.) Defaults from the operation don't count.
export function formIsBlank(f, op) {
  const def = emptyForm(op);
  return ['from', 'to', 'peer', 'subject', 'text', 'remarks', 'distribution', 'locationText', 'ref', 'origStation', 'origPlace', 'origFiled', 'stichzeit']
    .every(k => isBlankText(f[k]) || f[k] === def[k]) && !f.replyTo;
}

// A stored message back into the form (editing).
export function messageToForm(msg, mode = 'local') {
  return {
    ...FORM_DEFAULTS,
    direction: msg.direction, time: timeText(msg.ts, mode), ts: msg.ts, channel: msg.channel,
    freq: msg.radio?.freq || '', via: msg.radio?.via || '', type: msg.type, priority: msg.priority, alarm: !!msg.alarm,
    from: partyText(msg.from), to: partyText(msg.to), peer: msg.peer || '', subject: msg.subject, text: msg.text, readBack: !!msg.readBack,
    stichzeit: msg.stichzeit ? timeText(msg.stichzeit, mode) : '', distribution: (msg.distribution || []).join(', '),
    remarks: msg.remarks || '', origStation: msg.origin?.station || '', origPlace: msg.origin?.place || '',
    origPlaceLoc: msg.origin?.placeLoc || null,
    origFiled: msg.origin?.filed ? timeText(msg.origin.filed, mode) : '', replyTo: msg.replyTo || null,
    refKind: msg.refKind || 'antwort', ref: msg.refNumber || '',
    location: msg.location || null, locationText: msg.location?.input || msg.location?.label || '',
  };
}

// The form for answering msg: the other direction, sender and recipient
// swapped, same channel and frequency, linked by replyTo.
const REPLY_TYPE = { frage: 'meldung', anforderung: 'meldung', auftrag: 'meldung' };

export function replyForm(msg, op) {
  return {
    ...emptyForm(op),
    direction: msg.direction === 'in' ? 'out' : 'in',
    channel: msg.channel, freq: msg.radio?.freq || '', via: msg.radio?.via || '', peer: msg.peer || '',
    type: REPLY_TYPE[msg.type] || msg.type, priority: msg.priority,
    from: partyText(msg.to), to: partyText(msg.from),
    subject: msg.subject ? `Antwort: ${msg.subject.replace(/^Antwort: /, '')}` : 'Antwort',
    replyTo: msg.id, refKind: 'antwort', ref: msg.number,
  };
}

// The next handling step offered as a button in the book: handing over /
// transmitting and the confirmation are explicit; "beantwortet" follows
// from saving a reply (and doesn't stop the handover being recorded).
const STEP_LABELS = {
  in: { forwarded: 'übergeben', acknowledged: 'Übernahme bestätigt' },
  out: { forwarded: 'übertragen', acknowledged: 'Empfang bestätigt' },
};

export function nextStep(msg) {
  const state = nextHandover(msg);
  return state ? { state, label: (STEP_LABELS[msg.direction] || STEP_LABELS.in)[state], done: statusLabel(state, msg.direction) } : null;
}

// Status steps for the detail view: every state of the flow, done or not
// (a handover step is skipped when a later one is recorded without it).
export function statusSteps(msg) {
  const at = new Map(msg.status.map(s => [s.state, s]));
  const next = nextHandover(msg);
  return STATUS_FLOW.map(state => ({
    state, label: statusLabel(state, msg.direction), entry: at.get(state) || null,
    done: at.has(state), skipped: state === 'forwarded' && !at.has(state) && at.has('acknowledged'), next: state === next,
  }));
}

// Counts for the summary above the book.
export function bookSummary(msgs) {
  const live = liveMessages(msgs);
  const open = m => !m.status.some(x => x.state === 'acknowledged');
  const prefixes = [...new Set(live.map(m => m.prefix))].sort();
  const range = prefixes.map(p => {
    const seqs = msgs.filter(m => m.prefix === p).map(m => m.seq);
    return `${p}-${String(Math.min(...seqs)).padStart(3, '0')} bis ${p}-${String(Math.max(...seqs)).padStart(3, '0')}`;
  });
  return {
    total: live.length,
    emergencyOpen: live.filter(m => (m.priority === 'emergency' || m.alarm) && open(m)).length,
    unacknowledged: live.filter(open).length,
    range,
    // deleted messages keep their number, so they count for gaps too
    gaps: numberGaps(msgs),
  };
}
