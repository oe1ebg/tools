// Data model of the emergency traffic log (Nachrichtenbuch). Pure functions,
// no DOM, no storage — unit-tested in oe1ebg/tests/notfunk-*.test.mjs.
//
// One record per message, modelled on the SKKM Meldeaufnahmeformular
// (Richtlinie für das Führen im Katastropheneinsatz, 4.10.1; ÖBFV E-31
// annex): direction, running number, time, channel, sender/recipient,
// subject, verbatim text, operator, further handling. Field choices and
// open questions: ../README.md. Times are stored as ISO 8601 UTC; the
// displayed zone is a view setting (fmtVienna / fmtUtc).
//
// Message numbers come from numbering.js and are immutable: editMessage()
// never touches prefix/seq/number. Edits keep the previous version as a
// revision; deletes are soft (`deleted` timestamp).

export const DIRECTIONS = { in: 'Eingang', out: 'Ausgang' };
export const CHANNELS = {
  funk: 'Funk', telefon: 'Telefon', muendlich: 'mündlich', melder: 'Melder', email: 'E-Mail', fax: 'Fax', anders: 'anders',
};
export const MESSAGE_TYPES = {
  meldung: 'Meldung', auftrag: 'Auftrag', frage: 'Frage', anforderung: 'Anforderung', lagemeldung: 'Lagemeldung',
};
// Provisional: no Austrian staff document defines priority levels (README,
// open question 3). These follow the IARU/ARENA radiogram precedences;
// `alarm` marks a message to announce with "Stab herhören!" (ÖBFV E-31 4.1.5).
export const PRIORITIES = { routine: 'Routine', priority: 'Priorität', emergency: 'Notfall' };
// Handling states in order; a message can skip states but never go back.
export const STATUS_FLOW = ['logged', 'forwarded', 'acknowledged', 'answered'];
export const STATUS_LABELS = { logged: 'erfasst', forwarded: 'weitergeleitet', acknowledged: 'quittiert', answered: 'beantwortet' };

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function trimmed(v) {
  return String(v ?? '').trim();
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
    radio: { freq: trimmed(f.radio?.freq), via: trimmed(f.radio?.via).toUpperCase() },
    type: f.type || 'meldung',
    priority: f.priority || 'routine',
    alarm: !!f.alarm,
    from: party(f.from),
    to: party(f.to),
    distribution: (f.distribution || []).map(trimmed).filter(Boolean),
    subject: trimmed(f.subject),
    text: String(f.text ?? '').replace(/\r\n?/g, '\n').trim(), // verbatim: inner whitespace kept
    stichzeit: f.stichzeit || null,
    origin: { station: trimmed(f.origin?.station).toUpperCase(), place: trimmed(f.origin?.place), filed: f.origin?.filed || null },
    readBack: !!f.readBack,
    location: f.location || null,
    replyTo: f.replyTo || null,
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
  if (!(f.priority in PRIORITIES)) errs.push('unbekannte Priorität');
  if (!f.from.name && !f.from.call) errs.push('Absender fehlt');
  if (!f.to.name && !f.to.call) errs.push('Empfänger fehlt');
  if (!f.text && !f.subject) errs.push('Betreff oder Inhalt fehlt');
  for (const k of ['stichzeit']) if (f[k] && !ISO_RE.test(f[k])) errs.push('Stichzeit ist ungültig');
  if (f.origin.filed && !ISO_RE.test(f.origin.filed)) errs.push('Aufgabezeit ist ungültig');
  return errs;
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

export function currentStatus(msg) {
  return msg.status[msg.status.length - 1].state;
}

// Advance the handling status; throws when going backwards or repeating.
export function setStatus(msg, state, { operator, now, note = '' }) {
  const from = STATUS_FLOW.indexOf(currentStatus(msg));
  const to = STATUS_FLOW.indexOf(state);
  if (to < 0) throw new Error(`unbekannter Status: ${state}`);
  if (to <= from) throw new Error(`Status kann nicht von „${STATUS_LABELS[STATUS_FLOW[from]]}“ auf „${STATUS_LABELS[state]}“ zurückgesetzt werden`);
  return { ...msg, status: [...msg.status, { state, at: now, by: trimmed(operator).toUpperCase(), note: trimmed(note) }], updated: now };
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
// open: true = not yet acknowledged/answered, query: text search }.
export function filterMessages(msgs, flt = {}) {
  const q = trimmed(flt.query).toLowerCase();
  return liveMessages(msgs).filter(m =>
    (!flt.direction || m.direction === flt.direction)
    && (!flt.priority || m.priority === flt.priority)
    && (!flt.status || currentStatus(m) === flt.status)
    && (!flt.open || STATUS_FLOW.indexOf(currentStatus(m)) < STATUS_FLOW.indexOf('acknowledged'))
    && (!q || [m.number, m.subject, m.text, m.from.name, m.from.call, m.to.name, m.to.call].join(' ').toLowerCase().includes(q)));
}

const VIENNA_FMT = new Intl.DateTimeFormat('de-AT', {
  timeZone: 'Europe/Vienna', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short',
});

// "05.10.2026 14:07 MESZ"-style local Vienna time, as on the Austrian staff
// forms (TT.MM.JJJJ hh:mm), with the zone so it can't be mistaken for UTC.
export function fmtVienna(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const p = Object.fromEntries(VIENNA_FMT.formatToParts(d).map(x => [x.type, x.value]));
  return `${p.day}.${p.month}.${p.year} ${p.hour}:${p.minute} ${p.timeZoneName}`;
}

// "05.10.2026 12:07 UTC"
export function fmtUtc(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const s = d.toISOString();
  return `${s.slice(8, 10)}.${s.slice(5, 7)}.${s.slice(0, 4)} ${s.slice(11, 16)} UTC`;
}
