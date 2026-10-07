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

import { STATUS_FLOW, STATUS_LABELS, currentStatus, messageFields, validateMessage, liveMessages } from './model.js';
import { numberGaps } from './numbering.js';
import { normalizeCall, isPlausibleCall } from '../../shared/js/callbook.js';
import { parseTimeInput, splitTime } from '../../shared/js/time.js';

export const FORM_DEFAULTS = {
  direction: 'in', time: '', channel: 'funk', freq: '', via: '', type: 'meldung', priority: 'routine', alarm: false,
  from: '', to: '', subject: '', text: '', readBack: false, stichzeit: '', distribution: '', remarks: '',
  origStation: '', origPlace: '', origFiled: '', replyTo: null, location: null, locationText: '',
  // the stored time of an edited message: kept as it is (seconds included)
  // as long as the time field still shows it
  ts: null,
};

// A fresh form for an operation: its default frequency/relay and own post.
export function emptyForm(op) {
  return { ...FORM_DEFAULTS, freq: op?.freq || '', via: op?.via || '', to: op?.home || '' };
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

// "2026-10-07 14:05" in the given mode, for putting a stored time back into
// the form (seconds dropped).
export function timeText(iso, mode) {
  const { date, time } = splitTime(iso, mode);
  return date ? `${date} ${time.slice(0, 5)}` : '';
}

// Form -> { fields, errors }: fields for model.newMessage()/editMessage(),
// errors (German) that block saving.
export function formToFields(form, { mode = 'local', now }) {
  const errors = [];
  const ts = form.ts && form.time === timeText(form.ts, mode) ? form.ts : readTime(form.time, mode, now);
  if (!ts) errors.push('Zeit: HH:MM oder JJJJ-MM-TT HH:MM');
  let stichzeit = null;
  if (form.type === 'lagemeldung' && String(form.stichzeit ?? '').trim()) {
    stichzeit = readTime(form.stichzeit, mode, ts || now);
    if (!stichzeit) errors.push('Stichzeit: HH:MM oder JJJJ-MM-TT HH:MM');
  }
  let filed = null;
  if (String(form.origFiled ?? '').trim()) {
    filed = readTime(form.origFiled, mode, ts || now);
    if (!filed) errors.push('Aufgabezeit: HH:MM oder JJJJ-MM-TT HH:MM');
  }
  const fields = messageFields({
    direction: form.direction,
    ts: ts || now,
    channel: form.channel,
    radio: { freq: form.freq, via: form.via },
    type: form.type,
    priority: form.priority,
    alarm: form.alarm,
    from: parseParty(form.from),
    to: parseParty(form.to),
    distribution: String(form.distribution ?? '').split(/[,;]/),
    subject: form.subject,
    text: form.text,
    stichzeit,
    origin: { station: form.origStation, place: form.origPlace, filed },
    readBack: form.readBack,
    location: form.location || null,
    replyTo: form.replyTo || null,
    remarks: form.remarks,
  });
  // Unreadable times were replaced above (now / none), so validateMessage()
  // reports only the other problems.
  errors.push(...validateMessage(fields));
  return { fields, errors };
}

// A stored message back into the form (editing).
export function messageToForm(msg, mode = 'local') {
  return {
    ...FORM_DEFAULTS,
    direction: msg.direction, time: timeText(msg.ts, mode), ts: msg.ts, channel: msg.channel,
    freq: msg.radio?.freq || '', via: msg.radio?.via || '', type: msg.type, priority: msg.priority, alarm: !!msg.alarm,
    from: partyText(msg.from), to: partyText(msg.to), subject: msg.subject, text: msg.text, readBack: !!msg.readBack,
    stichzeit: msg.stichzeit ? timeText(msg.stichzeit, mode) : '', distribution: (msg.distribution || []).join(', '),
    remarks: msg.remarks || '', origStation: msg.origin?.station || '', origPlace: msg.origin?.place || '',
    origFiled: msg.origin?.filed ? timeText(msg.origin.filed, mode) : '', replyTo: msg.replyTo || null,
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
    channel: msg.channel, freq: msg.radio?.freq || '', via: msg.radio?.via || '',
    type: REPLY_TYPE[msg.type] || msg.type, priority: msg.priority,
    from: partyText(msg.to), to: partyText(msg.from),
    subject: msg.subject ? `Antwort: ${msg.subject.replace(/^Antwort: /, '')}` : 'Antwort',
    replyTo: msg.id,
  };
}

// The next handling step offered as a button in the book: forwarding and
// acknowledging are explicit; "beantwortet" follows from saving a reply.
const NEXT_STEP = { logged: ['forwarded', 'weiterleiten'], forwarded: ['acknowledged', 'quittieren'] };

export function nextStep(msg) {
  const s = NEXT_STEP[currentStatus(msg)];
  return s ? { state: s[0], label: s[1], done: STATUS_LABELS[s[0]] } : null;
}

// Status steps for the detail view: every state of the flow, done or not.
export function statusSteps(msg) {
  const at = new Map(msg.status.map(s => [s.state, s]));
  const cur = STATUS_FLOW.indexOf(currentStatus(msg));
  return STATUS_FLOW.map((state, i) => ({
    state, label: STATUS_LABELS[state], entry: at.get(state) || null,
    done: at.has(state), skipped: !at.has(state) && i < cur, next: i === cur + 1,
  }));
}

// Counts for the summary above the book.
export function bookSummary(msgs) {
  const live = liveMessages(msgs);
  const open = m => STATUS_FLOW.indexOf(currentStatus(m)) < STATUS_FLOW.indexOf('acknowledged');
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
