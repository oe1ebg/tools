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

import { STATUS_FLOW, statusLabel, currentStatus, nextHandover, messageFields, validateMessage, liveMessages, normFreq, ZONE, zoneHint } from './model.js';
import { numberGaps, parseNumber, formatNumber } from './numbering.js';
import { normalizeCall, isPlausibleCall } from '../../shared/js/callbook.js';
import { wallClock, wallToInstants, closestTo } from '../../shared/js/time.js';

export const FORM_DEFAULTS = {
  direction: 'in', date: '', time: '', zone: '', channel: 'funk', freq: '', via: '', type: 'meldung', priority: 'routine', alarm: false,
  from: '', to: '', peer: '', subject: '', text: '', readBack: false, stichzeit: '', distribution: '', remarks: '',
  origStation: '', origPlace: '', origPlaceLoc: null, origFiled: '', replyTo: null, refKind: 'antwort', ref: '',
  location: null, locationText: '',
  // the stored times of an edited message: kept as they are (seconds
  // included) as long as the fields still show them
  ts: null, stichzeitTs: null, origFiledTs: null,
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

// Times in the form are Austrian local time (ZONE) in the inputs' own
// formats: date 'YYYY-MM-DD' (<input type="date">), time 'HH:MM'
// (<input type="time">). The hour that repeats when the clocks go back
// (last Sunday of October, 02:00–02:59) needs a choice: zone 'MESZ' (the
// first time) or 'MEZ' (the second); without one, the occurrence nearest
// `ref` is taken.

// 'YYYY-MM-DD' / 'HH:MM' of an instant in Austrian local time.
export function dateText(iso) {
  return iso ? wallClock(iso, ZONE).date : '';
}

export function clockText(iso) {
  return iso ? wallClock(iso, ZONE).time.slice(0, 5) : '';
}

// Is date + time in the repeated hour (so the form asks MESZ or MEZ)?
export function needsZone(date, time) {
  return wallToInstants(date, time, ZONE).length > 1;
}

function pickZone(candidates, zone, ref) {
  if (candidates.length > 1 && (zone === 'MESZ' || zone === 'MEZ')) return candidates[zone === 'MESZ' ? 0 : 1];
  return closestTo(candidates, ref);
}

// The message time: date + time as ISO UTC; both empty = now; no date =
// today. null when it can't be read (no time, impossible date, a time
// skipped when the clocks go forward).
export function readDateTime(date, time, now, zone = '') {
  const d = String(date ?? '').trim(), t = String(time ?? '').trim();
  if (!d && !t) return now;
  if (!t) return null;
  return pickZone(wallToInstants(d || dateText(now), t, ZONE), zone, now);
}

// A time of day ('HH:MM') before ref: the latest such time at most five
// minutes after ref (clock drift), so "23:50" for a message at 00:10 is
// the day before. For the Stichzeit, the Aufgabezeit and the handover
// steps; null when empty or unreadable.
export function readClock(time, ref) {
  const t = String(time ?? '').trim();
  if (!t || !ref) return null;
  const limit = Date.parse(ref) + 5 * 60e3;
  const today = dateText(ref);
  const [y, m, d] = today.split('-').map(Number);
  const yesterday = new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
  const all = [...wallToInstants(yesterday, t, ZONE), ...wallToInstants(today, t, ZONE)].filter(iso => Date.parse(iso) <= limit);
  return all.length ? all[all.length - 1] : null;
}

// A bound of the printed range: date and/or time; a date alone is the
// start (or with end, the last minute) of that day, a time alone today.
export function readBound(date, time, now, end = false) {
  const d = String(date ?? '').trim(), t = String(time ?? '').trim();
  if (!d && !t) return null;
  const at = wallToInstants(d || dateText(now), t || (end ? '23:59:59' : '00:00'), ZONE);
  return at.length ? at[end ? at.length - 1 : 0] : null;
}

// A typed message number ("w1-7") as stored ("W1-007"); anything else as typed.
export function normalizeRef(text) {
  const t = String(text ?? '').trim();
  const n = parseNumber(t);
  return n ? formatNumber(n.prefix, n.seq) : t.toUpperCase();
}

// Drafts from before date and time were split hold "2026-10-07 14:05" in
// `time`; Stichzeit and Aufgabezeit may hold a date too.
export function upgradeForm(f) {
  const out = { ...FORM_DEFAULTS, ...f };
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}:\d{2})/.exec(out.time || '');
  if (m && !out.date) Object.assign(out, { date: m[1], time: m[2].padStart(5, '0') });
  for (const k of ['stichzeit', 'origFiled']) {
    const t = /(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(out[k] || '');
    out[k] = t ? `${t[1].padStart(2, '0')}:${t[2]}` : '';
  }
  return out;
}

const isBlankText = v => !String(v ?? '').trim();

// Form -> { fields, errors, fieldErrors, warnings }: fields for
// model.newMessage()/editMessage(); fieldErrors (German, by form field:
// time, from, to, subject, text, stichzeit, origFiled) block saving and are
// shown at the field, errors is the same as a list; warnings only ask
// before saving (missing radio station, a time far off, no read-back).
// byNumber: the operation's messages by number, to link the Bezug.
// editing: an edit of a stored message (no time warnings).
export function formToFields(form, { now, byNumber = new Map(), editing = false }) {
  const fieldErrors = {};
  // an edited message keeps its stored times while the fields still show them
  const keptTs = form.ts && form.date === dateText(form.ts) && form.time === clockText(form.ts) && (form.zone || '') === zoneHint(form.ts) ? form.ts : null;
  const keep = (stored, time) => (stored && time === clockText(stored) ? stored : null);
  const ts = keptTs || readDateTime(form.date, form.time, now, form.zone);
  if (!ts) fieldErrors.time = isBlankText(form.time) ? 'Uhrzeit fehlt' : 'Diese Uhrzeit gibt es an dem Tag nicht (Datum ungültig oder Zeitumstellung)';
  if (isBlankText(form.from)) fieldErrors.from = 'Absender fehlt: wer gibt die Meldung auf?';
  if (isBlankText(form.to)) fieldErrors.to = 'Adressat fehlt: für wen ist die Meldung?';
  if (isBlankText(form.subject)) fieldErrors.subject = 'Betreff fehlt';
  if (isBlankText(form.text)) fieldErrors.text = 'Inhalt fehlt';
  let stichzeit = null;
  if (form.type === 'lagemeldung' && !isBlankText(form.stichzeit)) {
    stichzeit = keep(form.stichzeitTs, form.stichzeit) || readClock(form.stichzeit, ts || now);
    if (!stichzeit) fieldErrors.stichzeit = 'Stichzeit als Uhrzeit (HH:MM)';
  }
  let filed = null;
  if (!isBlankText(form.origFiled)) {
    filed = keep(form.origFiledTs, form.origFiled) || readClock(form.origFiled, ts || now);
    if (!filed) fieldErrors.origFiled = 'Aufgabezeit als Uhrzeit (HH:MM)';
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
export function messageToForm(msg) {
  return {
    ...FORM_DEFAULTS,
    direction: msg.direction, date: dateText(msg.ts), time: clockText(msg.ts), zone: zoneHint(msg.ts), ts: msg.ts, channel: msg.channel,
    freq: msg.radio?.freq || '', via: msg.radio?.via || '', type: msg.type, priority: msg.priority, alarm: !!msg.alarm,
    from: partyText(msg.from), to: partyText(msg.to), peer: msg.peer || '', subject: msg.subject, text: msg.text, readBack: !!msg.readBack,
    stichzeit: clockText(msg.stichzeit), stichzeitTs: msg.stichzeit || null, distribution: (msg.distribution || []).join(', '),
    remarks: msg.remarks || '', origStation: msg.origin?.station || '', origPlace: msg.origin?.place || '',
    origPlaceLoc: msg.origin?.placeLoc || null,
    origFiled: clockText(msg.origin?.filed), origFiledTs: msg.origin?.filed || null, replyTo: msg.replyTo || null,
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
