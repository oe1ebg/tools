// Winlink exchange of the Notfunk-Meldebuch (issue #179). Pure functions, no
// DOM, no storage; unit-tested in oe1ebg/tests/notfunk-winlink.test.mjs.
//
// The contract with the Winlink form „OE Notfunk Meldung“ is
// ../winlink/FORMAT.md: one form variable `meldung` carries the complete
// message as compact, ASCII-only JSON (the payload), next to flat display
// fields for the plain-text body. This module
// - builds the payload of a stored message (winlinkPayload), its transport
//   text (winlinkJson) and the flat fields (winlinkFlatFields);
// - builds a ready message for Pat's out/ folder (winlinkB2f): body from the
//   form's template, the XML attachment as Pat's form builder writes it;
// - reads what comes back (parseWinlinkInput): the payload file (also
//   pasted), an RMS_Express_Form_*.xml (ours or another form) or a .b2f;
// - decides what an import does (winlinkImportPlan).
// Nothing here talks to the network: files and copy/paste only.

import { MESSAGE_TYPES, PRIORITIES, REF_KINDS, STATUS_FLOW, statusLabel, messageFields, validateMessage } from './model.js';
import { parseParty } from './form.js';

export const WINLINK_FORMAT = 'oe1ebg-notfunk-winlink';
export const WINLINK_VERSION = 1;
export const WINLINK_TEMPLATE_VERSION = 'OE Notfunk Meldung 1.0';
export const WINLINK_VIEWER = 'OE_Notfunk_Meldung_Viewer.html';
export const WINLINK_XML_NAME = 'RMS_Express_Form_OE_Notfunk_Meldung_Viewer.xml';
// Limits (FORMAT.md): a file read for import, the whole message as sent (body
// and attachment, before Winlink's compression) and the subject header.
export const WINLINK_INPUT_MAX_BYTES = 1024 * 1024;
export const WINLINK_MESSAGE_MAX_BYTES = 120 * 1024;
export const WINLINK_SUBJECT_MAX_BYTES = 128;
// The exercise marker (FORMAT.md): subject prefix, the first line of the
// body, and its own line before and after the Spruch (Inhalt).
export const WINLINK_EXERCISE_TAG = '[ÜBUNG]';
export const WINLINK_EXERCISE_LINE = '=== ACHTUNG ÜBUNG ===';

// Marker lines („=== ACHTUNG ÜBUNG ===“, also framed with *** or bare, or
// written UEBUNG) are never part of an imported text: { text, exercise }.
const WL_EXERCISE_LINE_RE = /^[ \t]*(?:[=*#-]{2,}[ \t]*)?ACHTUNG[ \t]+(?:ÜBUNG|UEBUNG|UBUNG)(?:[ \t]*[=*#-]{2,})?[ \t]*$/gim;
export function winlinkStripExercise(text) {
  const src = String(text ?? '');
  const out = src.replace(WL_EXERCISE_LINE_RE, '');
  if (out === src) return { text: src, exercise: false };
  return { text: out.replace(/^(?:[ \t]*\n)+/, '').replace(/(?:\n[ \t]*)+$/, '').replace(/\n{3,}/g, '\n\n'), exercise: true };
}
// "[ÜBUNG] Dringend …" -> { subject: "Dringend …", exercise: true }
export function winlinkStripExerciseTag(subject) {
  const m = /^\s*\[(?:ÜBUNG|UEBUNG)[^\]]*\]\s*/i.exec(String(subject ?? ''));
  return m ? { subject: String(subject).slice(m[0].length), exercise: true } : { subject: String(subject ?? ''), exercise: false };
}

// A payload is an exercise unless it says `exercise: false` (missing:
// unknown, so marked; the safe side).
export function winlinkIsExercise(payload) {
  return payload?.exercise !== false;
}

// The form's template (../winlink/OE_Notfunk_Meldung.txt, kept identical:
// the tests compare them). Winlink Express and Pat fill the <var x> slots.
export const WINLINK_TEMPLATE = `Form: OE_Notfunk_Meldung_Initial.html,OE_Notfunk_Meldung_Viewer.html
To: <var msgto>
Subject: <var kennung> <var prioritaet> <var nummer>: <var betreff>
Msg:
<var uebung>
NOTFUNK-MELDUNG <var nummer>
========================================
Nummer:        <var nummer>
Dringlichkeit: <var prioritaet>
Art:           <var art>
Zeit:          <var zeit>
Von:           <var von>
An:            <var an>
Betreff:       <var betreff>
Bezug:         <var bezug>

Inhalt:
<var uebung>

<var inhalt>

<var uebung>

Verlauf:
<var verlauf>

----------------------------------------
Gesendet von <var station>, Formular <var templateversion>.
Die ganze Meldung mit Verlauf steht im Anhang (Formular
"OE Notfunk Meldung"); das Notfunk-Meldebuch liest sie von dort ein.
`;

const WL_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
const wlIsObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const wlIsIso = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(v) && !Number.isNaN(Date.parse(v));
const wlStr = v => (typeof v === 'string' ? v : v == null ? '' : String(v));

/* ---------------------------------------------------------------- payload */

// `old` of a revision and the message itself: without the sender's local ids.
function wlStripLocal(rec) {
  const { eventId: _e, replyTo: _r, ...rest } = rec || {};
  return rest;
}

// The payload of a stored message. revisions: the message's revision records
// (any order); refMsg: the message it refers to (replyTo), if there is one;
// station: { call, operation, prefix, operator, exercise } of the sending
// book (exercise: the operation is an Übung; missing counts as true).
export function winlinkPayload(msg, revisions, refMsg, station, appVersion, now) {
  const revs = (revisions || []).filter(r => !r.messageId || r.messageId === msg.id)
    .slice().sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
    .map(r => ({ at: r.at, by: r.by || '', old: wlStripLocal(r.old) }));
  const src = refMsg?.source;
  const ref = msg.replyTo && refMsg && refMsg.id === msg.replyTo
    ? {
      id: refMsg.id, number: refMsg.number, station: refMsg.stationCall || '',
      source: src && src.id ? { id: src.id, number: wlStr(src.number), station: wlStr(src.station) } : null,
    }
    : null;
  return {
    format: WINLINK_FORMAT,
    version: WINLINK_VERSION,
    app: appVersion || 'dev',
    exported: now,
    exercise: station?.exercise !== false,
    station: {
      call: wlStr(station?.call).toUpperCase(), operation: wlStr(station?.operation),
      prefix: wlStr(station?.prefix), operator: wlStr(station?.operator).toUpperCase(),
    },
    message: wlStripLocal(msg),
    revisions: revs,
    ref,
  };
}

// The payload as it travels: compact JSON, ASCII only (everything above
// U+007E as \uXXXX, astral characters as their surrogate pair), < > & as
// < > &, no line breaks. Like the form's input page, a "{"
// inside a string is { too, so no text can look like a {var …} slot of
// the viewer. JSON.parse() gives the same object.
export function winlinkJson(payload) {
  return JSON.stringify(payload).replace(/[\u007f-\uffff<>&]|\{(?!["}])/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/* ---------------------------------------------------------------- flat fields */

// "2026-11-06 18:00 UTC" (radio data: UTC, stated).
export function winlinkUtc(iso) {
  return wlIsIso(iso) ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : '';
}

// The status history and the attempts of a message as text lines, oldest
// first: "2026-11-06 18:05 UTC übertragen an OE3ABC, rückgelesen (OE1XYZ)".
// Latin-1 only, so the lines survive the plain-text body; the same words as
// the form's input page (../winlink/OE_Notfunk_Meldung_Initial.html).
export function winlinkHistory(status, attempts, direction) {
  const lines = [];
  for (const s of Array.isArray(status) ? status : []) {
    if (!wlIsObj(s)) continue;
    const words = `${statusLabel(s.state, direction)}${s.to ? ` an ${s.to}` : ''}${s.who ? ` von ${s.who}` : ''}${s.readBack ? ', rückgelesen' : ''}`;
    lines.push({ at: wlStr(s.at), text: `${winlinkUtc(s.at)} ${words}${s.note ? `: ${s.note}` : ''}${s.by ? ` (${s.by})` : ''}` });
  }
  for (const a of Array.isArray(attempts) ? attempts : []) {
    if (!wlIsObj(a)) continue;
    lines.push({ at: wlStr(a.at), text: `${winlinkUtc(a.at)} Fehlversuch/Rückfrage${a.note ? `: ${a.note}` : ''}${a.by ? ` (${a.by})` : ''}` });
  }
  return lines.sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : 0)).map(x => x.text).join('\n');
}

// "Name / CALL" (as the form's input page writes it).
const wlParty = p => (wlIsObj(p) ? [p.name, p.call].filter(Boolean).join(' / ') : '');

// "Antwort auf W1-003 (OE1XYZ)" or ''.
function wlBezug(payload) {
  const m = payload.message;
  const kind = REF_KINDS[m.refKind] || 'Bezug:';
  if (payload.ref) return `${kind} ${payload.ref.number}${payload.ref.station ? ` (${payload.ref.station})` : ''}`;
  return m.refNumber ? `${kind} ${m.refNumber}` : '';
}

// The flat form fields (FORMAT.md, "Flat fields"), filled from the payload.
// msgto: the recipient's Winlink address (callsign or e-mail).
export function winlinkFlatFields(payload, msgto = '') {
  const m = payload.message;
  return {
    msgto: wlStr(msgto).trim(),
    kennung: winlinkIsExercise(payload) ? WINLINK_EXERCISE_TAG : '',
    uebung: winlinkIsExercise(payload) ? WINLINK_EXERCISE_LINE : '',
    nummer: m.number,
    prioritaet: PRIORITIES[m.priority] || PRIORITIES.routine,
    art: MESSAGE_TYPES[m.type] || MESSAGE_TYPES.meldung,
    von: wlParty(m.from),
    an: wlParty(m.to),
    betreff: m.subject || '',
    inhalt: m.text || '',
    zeit: winlinkUtc(m.ts),
    bezug: wlBezug(payload),
    station: payload.station?.call || '',
    verlauf: winlinkHistory(m.status, m.attempts, m.direction),
    format_version: String(payload.version),
    templateversion: WINLINK_TEMPLATE_VERSION,
  };
}

/* ---------------------------------------------------------------- template, XML, B2F */

// A Winlink text template filled in like Pat does it (internal/forms/
// builder.go, scanAndBuild): <var x> case-insensitively, per line; header
// lines To:/Subject:/Def:; the body starts after "Msg:".
export function winlinkRenderTemplate(template, vars) {
  const fill = line => line.replace(/<var\s*([\w-]+)\s*>/gi, (all, name) => {
    const k = name.toLowerCase();
    return Object.prototype.hasOwnProperty.call(vars, k) ? vars[k] : all;
  });
  const out = { to: '', subject: '', body: '' };
  let inBody = false;
  for (const raw of template.replace(/^﻿/, '').replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n')) {
    const line = fill(raw);
    if (inBody) { out.body += `${line}\n`; continue; }
    const i = line.indexOf(':');
    const key = (i < 0 ? line : line.slice(0, i)).trim().toLowerCase();
    const value = i < 0 ? '' : line.slice(i + 1);
    if (key === 'msg') { out.body += value; inBody = true; }
    else if (key === 'subject' || key === 'subj') out.subject = value.trim();
    else if (key === 'to') out.to = value.trim();
  }
  return out;
}

// Go's encoding/xml EscapeText (what Pat writes into the XML).
function wlXmlEscape(s) {
  return wlStr(s).replace(/[&<>"'\t\n\r]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&#34;', "'": '&#39;', '\t': '&#x9;', '\n': '&#xA;', '\r': '&#xD;' })[c])
    // characters XML 1.0 can't hold: U+FFFD, as Go does
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '\ufffd');
}

// "YYYYMMDDhhmmss" UTC.
function wlStamp(iso) {
  return iso.slice(0, 19).replace(/[-T:]/g, '');
}

// The XML attachment as Pat's buildXML() writes it: xml.MarshalIndent with
// four spaces, variables sorted by name, values trimmed, no newline at the end.
export function winlinkXml(vars, { mycall = '', now, appVersion = '', grid = '' } = {}) {
  const ind = n => ' '.repeat(4 * n);
  const tag = (n, k, v) => `${ind(n)}<${k}>${wlXmlEscape(v)}</${k}>`;
  const names = Object.keys(vars).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<RMS_Express_Form>',
    `${ind(1)}<form_parameters>`,
    tag(2, 'xml_file_version', '1.0'),
    tag(2, 'rms_express_version', appVersion),
    tag(2, 'submission_datetime', wlStamp(now)),
    tag(2, 'senders_callsign', mycall),
    tag(2, 'grid_square', grid),
    tag(2, 'display_form', WINLINK_VIEWER),
    tag(2, 'reply_template', ''),
    `${ind(1)}</form_parameters>`,
    `${ind(1)}<variables>`,
    ...names.map(k => tag(2, k, wlStr(vars[k]).trim())),
    `${ind(1)}</variables>`,
    '</RMS_Express_Form>',
  ].join('\n');
}

// Text -> ISO-8859-1 bytes; a character outside Latin-1 becomes "?".
export function winlinkLatin1(text) {
  const out = [];
  for (const ch of wlStr(text)) {
    const c = ch.codePointAt(0);
    out.push(c <= 0xff ? c : 0x3f);
  }
  return Uint8Array.from(out);
}

function wlFromLatin1(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 4096) s += String.fromCharCode(...bytes.subarray(i, i + 4096));
  return s;
}

function wlUtf8(text) {
  return new TextEncoder().encode(text);
}

// Bytes -> text: UTF-8 when valid (BOM dropped), else ISO-8859-1.
function wlDecode(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, '');
  } catch {
    return wlFromLatin1(bytes);
  }
}

// The body as wl2k-go writes it (StringToBody): every line ends in CRLF,
// lines longer than 998 bytes are split, ISO-8859-1.
function wlBodyBytes(body) {
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  let out = '';
  for (let line of lines) {
    do {
      const [head, rest] = [line.slice(0, 998), line.slice(998)];
      out += `${head}\r\n`;
      line = rest;
    } while (line.length);
  }
  return winlinkLatin1(out);
}

// RFC 2047 Q-encoding of a header with ISO-8859-1 (wl2k-go SetSubject).
export function winlinkHeaderText(text) {
  const bytes = winlinkLatin1(text);
  if (!bytes.some(b => b < 0x20 || b > 0x7e)) return wlFromLatin1(bytes);
  let q = '';
  for (const b of bytes) {
    if (b === 0x20) q += '_';
    else if (b >= 0x21 && b <= 0x7e && b !== 0x3d && b !== 0x3f && b !== 0x5f) q += String.fromCharCode(b);
    else q += `=${b.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return `=?ISO-8859-1?q?${q}?=`;
}

// "OE1ABC", "oe1abc@winlink.org" -> "OE1ABC"; "a@b.at" -> "SMTP:a@b.at" (wl2k-go AddressFromString).
export function winlinkAddress(addr) {
  const a = wlStr(addr).trim();
  if (a.split(':').length === 2) return a;
  const at = a.split('@');
  if (at.length === 1) return a.toUpperCase();
  if (at.length === 2 && at[1].toLowerCase() === 'winlink.org') return at[0].toUpperCase();
  return `SMTP:${a}`;
}

// A plausible recipient: a callsign (with optional -SSID) or an e-mail address.
export function winlinkAddressProblem(addr) {
  const a = wlStr(addr).trim();
  if (!a) return 'Winlink-Adresse des Empfängers fehlt';
  if (/^[A-Za-z0-9]{3,10}(-\d{1,2})?$/.test(a) || /^[^\s@:]+@[^\s@:]+\.[^\s@:]+$/.test(a)) return '';
  return 'Winlink-Adresse: ein Rufzeichen (z. B. OE3ABC) oder eine E-Mail-Adresse';
}

// A Winlink message id: 12 characters A–Z, 2–7 (base32 alphabet, as
// GenerateMid), here from the message, the time and the sender.
export function winlinkMid(seed) {
  const s = wlStr(seed);
  let h1 = 0x811c9dc5, h2 = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
    h2 ^= h2 >>> 15;
  }
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let out = '';
  for (let i = 0; i < 12; i++) {
    const word = i < 6 ? h1 : h2;
    out += A[(word >>> ((i % 6) * 5)) & 31];
  }
  return out;
}

function wlConcat(parts) {
  const n = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// What the form posts (a browser sends line breaks as CRLF), with what Pat
// adds itself (setDefaultFormValues).
function wlFormVars(payload, msgto, mycall) {
  const flat = Object.fromEntries(Object.entries(winlinkFlatFields(payload, msgto)).map(([k, v]) => [k, v.replace(/\r?\n/g, '\r\n')]));
  return {
    ...flat,
    meldung: winlinkJson(payload),
    msgsender: mycall,
    msgcc: '', msgsubject: '', msgbody: '', msgp2p: '', txtstr: '',
    msgisreply: 'False', msgisforward: 'False', msgisacknowledgement: 'False', msgseqnum: '0',
  };
}

// A ready message for Pat's mailbox (…/mailbox/<CALL>/out/<MID>.b2f), as
// wl2k-go writes one (fbb.Message.Write): headers with CRLF, Mid first, the
// others sorted; the body; the XML attachment. Returns { mid, bytes, subject,
// body, xml, to }.
export function winlinkB2f(payload, { mycall, msgto, now, mid = null, appVersion = '', grid = '' }) {
  const call = wlStr(mycall).trim().toUpperCase();
  const vars = wlFormVars(payload, msgto, call);
  const filled = winlinkRenderTemplate(WINLINK_TEMPLATE, vars);
  const body = wlBodyBytes(filled.body);
  const xml = winlinkXml(vars, { mycall: call, now, appVersion: appVersion || payload.app || '', grid });
  const xmlBytes = wlUtf8(xml);
  const id = mid || winlinkMid(`${payload.message.id}-${now}-${call}`);
  const date = `${now.slice(0, 4)}/${now.slice(5, 7)}/${now.slice(8, 10)} ${now.slice(11, 16)}`;
  const headers = [
    ['Mid', id],
    ['Body', String(body.length)],
    ['Content-Transfer-Encoding', '8bit'],
    ['Content-Type', 'text/plain; charset=ISO-8859-1'],
    ['Date', date],
    ['File', `${xmlBytes.length} ${WINLINK_XML_NAME}`],
    ['From', call],
    ['Mbo', call],
    ['Subject', winlinkHeaderText(filled.subject)],
    ['To', winlinkAddress(filled.to)],
    ['Type', 'Private'],
  ];
  const head = winlinkLatin1(`${headers.map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);
  const crlf = Uint8Array.of(13, 10);
  return { mid: id, bytes: wlConcat([head, body, crlf, xmlBytes, crlf]), subject: filled.subject, body: filled.body, xml, to: filled.to };
}

// Size and subject check before an export (FORMAT.md): { bytes, max,
// tooLarge, subjectBytes, error, warnings }. Too large is refused, never
// shortened: the history is part of the message.
export function winlinkExportCheck(payload, { msgto = '', mycall = '', now }) {
  const b2f = winlinkB2f(payload, { mycall: mycall || 'N0CALL', msgto: msgto || 'N0CALL', now });
  const bytes = b2f.bytes.length;
  const subjectBytes = Math.max(winlinkLatin1(b2f.subject).length, winlinkHeaderText(b2f.subject).length);
  const warnings = [];
  if (subjectBytes > WINLINK_SUBJECT_MAX_BYTES) warnings.push(`Der Betreff der Winlink-Nachricht ist ${subjectBytes} Byte lang (höchstens ${WINLINK_SUBJECT_MAX_BYTES}); Winlink kürzt oder verweigert ihn. Besser den Betreff der Meldung kürzen.`);
  if (/[^\u0000-ÿ]/.test(`${b2f.subject}\n${b2f.body}`)) warnings.push('Zeichen wie €, „“ oder Emoji erscheinen im Text der Winlink-Nachricht als „?“; im Formular und beim Einlesen ins Meldebuch bleiben sie erhalten.');
  if (payload.message.deleted) warnings.push('Diese Meldung ist gelöscht.');
  const tooLarge = bytes > WINLINK_MESSAGE_MAX_BYTES;
  const kb = n => `${(n / 1024).toFixed(1).replace('.', ',')} KB`;
  const error = tooLarge ? `Zu groß für Winlink: ${kb(bytes)}, höchstens ${kb(WINLINK_MESSAGE_MAX_BYTES)}. Die Meldung mit allen Fassungen (${payload.revisions.length}) und dem Verlauf wird nicht gekürzt; bitte den Inhalt aufteilen (mehrere Meldungen).` : '';
  return { bytes, max: WINLINK_MESSAGE_MAX_BYTES, tooLarge, subjectBytes, error, warnings, size: kb(bytes) };
}

/* ---------------------------------------------------------------- reading */

// Errors of a payload (German), or '' when it is fine. Strict: anything the
// book can't take as it is refuses the whole file.
function wlPayloadProblem(d) {
  if (!wlIsObj(d) || d.format !== WINLINK_FORMAT) return 'Keine Notfunk-Meldung für Winlink';
  if (!Number.isInteger(d.version) || d.version < 1) return 'Meldung unvollständig (version)';
  if (d.version > WINLINK_VERSION) return `Diese Meldung wurde mit einer neueren Version des Notfunk-Meldebuchs erstellt (Format ${d.version}, hier ${WINLINK_VERSION}). Bitte das Meldebuch aktualisieren`;
  if (!wlIsObj(d.station) || typeof d.station.call !== 'string') return 'Meldung unvollständig (Station)';
  if (d.exported != null && !wlIsIso(d.exported)) return 'Meldung fehlerhaft (Exportzeit)';
  if (d.exercise != null && typeof d.exercise !== 'boolean') return 'Meldung fehlerhaft (Übung)';
  const m = d.message;
  if (!wlIsObj(m)) return 'Meldung unvollständig (message)';
  if (typeof m.id !== 'string' || !WL_ID_RE.test(m.id)) return 'Meldung fehlerhaft (ID)';
  if (typeof m.number !== 'string' || !m.number.trim() || m.number.length > 40) return 'Meldung fehlerhaft (Nummer)';
  for (const k of ['subject', 'text']) if (typeof m[k] !== 'string') return `Meldung unvollständig (${k === 'text' ? 'Inhalt' : 'Betreff'})`;
  for (const k of ['from', 'to']) if (!wlIsObj(m[k])) return `Meldung unvollständig (${k === 'from' ? 'Absender' : 'Adressat'})`;
  for (const k of ['radio', 'origin']) if (m[k] != null && !wlIsObj(m[k])) return `Meldung fehlerhaft (${k})`;
  if (m.distribution != null && (!Array.isArray(m.distribution) || m.distribution.some(x => typeof x !== 'string'))) return 'Meldung fehlerhaft (Verteiler)';
  if (!wlIsIso(m.ts) || !wlIsIso(m.created) || !wlIsIso(m.updated)) return 'Meldung fehlerhaft (Zeitstempel)';
  if (m.deleted != null && !wlIsIso(m.deleted)) return 'Meldung fehlerhaft (gelöscht)';
  if (!Array.isArray(m.status) || !m.status.length || m.status.some(s => !wlIsObj(s) || !STATUS_FLOW.includes(s.state) || !wlIsIso(s.at))) return 'Meldung fehlerhaft (Status)';
  if (m.attempts != null && (!Array.isArray(m.attempts) || m.attempts.some(a => !wlIsObj(a) || !wlIsIso(a.at)))) return 'Meldung fehlerhaft (Fehlversuche)';
  if (m.source != null && !wlIsObj(m.source)) return 'Meldung fehlerhaft (Herkunft)';
  const errs = validateMessage(messageFields({ ...m, channel: 'winlink', replyTo: null, source: null, origin: m.origin || {}, radio: m.radio || {} }));
  if (errs.length) return `Meldung fehlerhaft: ${errs.join(', ')}`;
  if (!Array.isArray(d.revisions) || d.revisions.some(r => !wlIsObj(r) || !wlIsIso(r.at) || !wlIsObj(r.old))) return 'Meldung fehlerhaft (Fassungen)';
  const r = d.ref;
  if (r != null) {
    if (!wlIsObj(r) || typeof r.id !== 'string' || !WL_ID_RE.test(r.id) || typeof r.number !== 'string' || typeof r.station !== 'string') return 'Meldung fehlerhaft (Bezug)';
    if (r.source != null && (!wlIsObj(r.source) || typeof r.source.id !== 'string' || !WL_ID_RE.test(r.source.id))) return 'Meldung fehlerhaft (Bezug)';
  }
  return '';
}

// A payload from JSON text (file, pasted, `meldung` variable). Throws German Errors.
export function winlinkParsePayload(text) {
  let d;
  try {
    d = JSON.parse(text);
  } catch {
    throw new Error('Keine gültige Meldung (JSON fehlerhaft)');
  }
  const why = wlPayloadProblem(d);
  if (why) throw new Error(why);
  return d;
}

function wlEntities(s) {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>|&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (all, cdata, ent) => {
    if (cdata !== undefined) return cdata;
    const e = ent.toLowerCase();
    if (e[0] === '#') {
      const cp = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '\ufffd';
    }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e];
  });
}

// The simple elements inside <section>…</section> of an RMS_Express_Form XML
// as { name (lower case): value }.
function wlXmlSection(xml, section) {
  const m = new RegExp(`<${section}\\s*>([\\s\\S]*?)</${section}\\s*>`, 'i').exec(xml);
  const out = {};
  if (!m) return out;
  const re = /<([A-Za-z_][\w.-]*)\s*\/>|<([A-Za-z_][\w.-]*)\s*>([\s\S]*?)<\/\2\s*>/g;
  for (let e; (e = re.exec(m[1]));) {
    const name = (e[1] || e[2]).toLowerCase();
    if (!(name in out)) out[name] = e[1] ? '' : wlEntities(e[3]).replace(/\r\n?/g, '\n');
  }
  return out;
}

// An RMS_Express_Form XML: { params, vars }; throws when it is none.
export function winlinkParseXml(text) {
  if (!/<RMS_Express_Form[\s>]/i.test(text)) throw new Error('Kein Winlink-Formular (RMS_Express_Form fehlt)');
  return { params: wlXmlSection(text, 'form_parameters'), vars: wlXmlSection(text, 'variables') };
}

const WL_FLAT_SUBJECT = ['betreff', 'subject', 'subjectline', 'msgsubject', 'subj', 'title'];
const WL_FLAT_TEXT = ['inhalt', 'message', 'msg', 'msgbody', 'body', 'text', 'comments', 'message_body'];
const WL_FLAT_FROM = ['von', 'fm_name', 'from', 'from_name', 'sender', 'msgsender'];
const WL_FLAT_TO = ['an', 'to_name', 'to', 'addressee'];

function wlFirst(vars, keys) {
  for (const k of keys) if (typeof vars[k] === 'string' && vars[k].trim()) return vars[k].trim();
  return '';
}

// "Routine" -> 'routine' (and the keys themselves); null when unknown.
function wlKeyOf(table, label) {
  const t = wlStr(label).trim().toLowerCase();
  for (const [k, v] of Object.entries(table)) if (k === t || v.toLowerCase() === t) return k;
  return null;
}

// "2026-11-06 18:00 UTC" -> ISO; null otherwise.
function wlUtcIso(text) {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::\d{2})?\s*(?:UTC|Z)?$/i.exec(wlStr(text).trim());
  if (!m) return null;
  const iso = `${m[1]}T${m[2]}:00.000Z`;
  return wlIsIso(iso) ? iso : null;
}

// The flat fields of our form or another one (best effort).
function wlFlatFromVars(vars, params, fallback = {}) {
  const ours = 'nummer' in vars || 'prioritaet' in vars || wlStr(params.display_form).toLowerCase() === WINLINK_VIEWER.toLowerCase();
  const text = winlinkStripExercise(wlFirst(vars, WL_FLAT_TEXT) || fallback.text || '');
  const subj = winlinkStripExerciseTag(wlFirst(vars, WL_FLAT_SUBJECT) || fallback.subject || '');
  const flat = {
    form: wlStr(params.display_form),
    ours,
    subject: subj.subject,
    text: text.text,
    // foreign forms and plain messages: a marker line or subject tag
    exercise: text.exercise || subj.exercise ? true : null,
    from: wlFirst(vars, WL_FLAT_FROM) || fallback.from || wlStr(params.senders_callsign),
    to: wlFirst(vars, WL_FLAT_TO),
    station: (ours ? wlStr(vars.station).trim() : '') || wlStr(params.senders_callsign).trim() || fallback.station || '',
  };
  if (ours) {
    Object.assign(flat, {
      number: wlStr(vars.nummer).trim(),
      priority: wlKeyOf(PRIORITIES, vars.prioritaet),
      type: wlKeyOf(MESSAGE_TYPES, vars.art),
      ts: wlUtcIso(vars.zeit),
      bezug: wlStr(vars.bezug).trim(),
      formatVersion: wlStr(vars.format_version).trim(),
      // our form since the marker: kennung/uebung filled = exercise; older
      // form versions without the fields: unknown (null)
      exercise: 'kennung' in vars || 'uebung' in vars ? !!(wlStr(vars.kennung).trim() || wlStr(vars.uebung).trim()) : null,
      history: wlStr(vars.verlauf).trim(),
    });
  }
  return flat;
}

function wlFromVars(vars, params, base, fallback) {
  const raw = wlStr(vars.meldung).trim();
  if (raw) {
    const payload = winlinkParsePayload(raw);
    return { ...base, kind: 'payload', payload };
  }
  if (wlStr(vars.format_version).trim() && Number(vars.format_version) > WINLINK_VERSION) {
    throw new Error(`Diese Meldung wurde mit einer neueren Version des Formulars erstellt (Format ${vars.format_version}). Bitte das Meldebuch aktualisieren`);
  }
  return { ...base, kind: 'flat', flat: wlFlatFromVars(vars, params, fallback) };
}

// RFC 2047 encoded words (=?ISO-8859-1?q?…?=, =?utf-8?b?…?=) in a header.
export function winlinkDecodeHeader(value) {
  const s = wlStr(value).replace(/(=\?[^?]+\?[qb]\?[^?]*\?=)\s+(?==\?)/gi, '$1');
  return s.replace(/=\?([^?]+)\?([qb])\?([^?]*)\?=/gi, (all, cs, enc, text) => {
    let bytes;
    if (enc.toLowerCase() === 'b') {
      try { bytes = Uint8Array.from(atob(text), c => c.charCodeAt(0)); } catch { return all; }
    } else {
      const bin = text.replace(/_/g, ' ').replace(/=([0-9a-f]{2})/gi, (x, h) => String.fromCharCode(parseInt(h, 16)));
      bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
    }
    return /^utf-?8$/i.test(cs) ? new TextDecoder().decode(bytes) : wlFromLatin1(bytes);
  });
}

// A B2F message (wl2k-go fbb.Message.ReadFrom): { headers, body, files: [{ name, data }] }.
export function winlinkParseB2f(bytes) {
  let i = 0;
  while (i < bytes.length && (bytes[i] === 0x20 || (bytes[i] >= 0x09 && bytes[i] <= 0x0d))) i++;
  // headers end at the first empty line
  let end = -1;
  for (let j = i; j < bytes.length - 1; j++) {
    if (bytes[j] === 0x0a && (bytes[j + 1] === 0x0a || (bytes[j + 1] === 0x0d && bytes[j + 2] === 0x0a))) { end = j + 1; break; }
  }
  if (end < 0) throw new Error('Keine Winlink-Nachricht (.b2f): Kopfzeilen unvollständig');
  const headers = {};
  for (const line of wlFromLatin1(bytes.subarray(i, end)).split(/\r?\n/)) {
    const k = line.indexOf(':');
    if (k <= 0) continue;
    const name = line.slice(0, k).trim().toLowerCase();
    (headers[name] ||= []).push(line.slice(k + 1).trim());
  }
  if (!headers.mid?.[0]) throw new Error('Keine Winlink-Nachricht (.b2f): Mid fehlt');
  let pos = end + (bytes[end] === 0x0d ? 2 : 1);
  const section = n => {
    if (!Number.isSafeInteger(n) || n < 0 || pos + n > bytes.length) throw new Error('Winlink-Nachricht (.b2f) unvollständig oder beschädigt');
    const data = bytes.subarray(pos, pos + n);
    pos += n;
    if (bytes[pos] === 0x0d && bytes[pos + 1] === 0x0a) pos += 2;
    else if (bytes[pos] === 0x0a) pos += 1;
    return data;
  };
  const bodyBytes = section(Number(headers.body?.[0] || 0));
  const charset = /charset=\s*"?([\w-]+)/i.exec(headers['content-type']?.[0] || '')?.[1] || 'ISO-8859-1';
  const body = /^utf-?8$/i.test(charset) ? new TextDecoder().decode(bodyBytes) : wlFromLatin1(bodyBytes);
  const files = (headers.file || []).map(v => {
    const m = /^(\d+)\s+(.*)$/.exec(v);
    if (!m) throw new Error('Winlink-Nachricht (.b2f) beschädigt: Anhang');
    return { name: winlinkDecodeHeader(m[2]), data: section(Number(m[1])) };
  });
  return { headers, body: body.replace(/\r\n/g, '\n'), files };
}

// Reads an import: a file (name, bytes) or pasted text. Returns
// { kind: 'payload', payload, via, mid?, from? } or
// { kind: 'flat', flat: { subject, text, from, to, station, form, ours, … }, via, mid? }.
// Throws a German Error for anything else (too large, not recognised, invalid).
export function parseWinlinkInput(name, input) {
  const bytes = typeof input === 'string' ? wlUtf8(input) : input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length > WINLINK_INPUT_MAX_BYTES) {
    throw new Error(`${name ? `„${name}“ ist` : 'Der Text ist'} ${(bytes.length / 1048576).toFixed(1).replace('.', ',')} MB groß; mehr als 1 MB wird nicht übernommen`);
  }
  let k = 0;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) k = 3;
  while (k < bytes.length && (bytes[k] === 0x20 || (bytes[k] >= 0x09 && bytes[k] <= 0x0d))) k++;
  const first = bytes[k];
  if (first === 0x7b) { // {
    return { kind: 'payload', via: 'json', payload: winlinkParsePayload(wlDecode(bytes)) };
  }
  if (first === 0x3c) { // <
    const { params, vars } = winlinkParseXml(wlDecode(bytes));
    return wlFromVars(vars, params, { via: 'xml' }, {});
  }
  if (/^mid\s*:/i.test(wlFromLatin1(bytes.subarray(k, k + 8)))) {
    const b2f = winlinkParseB2f(bytes);
    const mid = b2f.headers.mid[0];
    const from = b2f.headers.from?.[0] || '';
    const subject = winlinkDecodeHeader(b2f.headers.subject?.[0] || '');
    const base = { via: 'b2f', mid, from };
    const fallback = { subject, text: b2f.body.trim(), from, station: from };
    const forms = b2f.files.filter(f => /^RMS_Express_Form_.*\.xml$/i.test(f.name));
    const ours = forms.find(f => f.name.toLowerCase() === WINLINK_XML_NAME.toLowerCase()) || forms[0];
    if (ours) {
      const { params, vars } = winlinkParseXml(wlDecode(ours.data));
      return wlFromVars(vars, params, base, fallback);
    }
    const text = winlinkStripExercise(b2f.body.trim());
    const subj = winlinkStripExerciseTag(subject);
    return { ...base, kind: 'flat', flat: { form: '', ours: false, subject: subj.subject, text: text.text, from, to: '', station: from, exercise: text.exercise || subj.exercise ? true : null } };
  }
  throw new Error(`${name ? `„${name}“` : 'Der Text'}: nicht erkannt. Erwartet: die Datei aus dem Formular „OE Notfunk Meldung“ (.json), ein RMS_Express_Form_….xml oder eine Winlink-Nachricht (.b2f)`);
}

/* ---------------------------------------------------------------- import plan */

// The sender's record kept with an imported message (read-only).
export function winlinkSource(payload, extra = {}) {
  const m = payload.message;
  const src = {
    format_version: payload.version,
    station: payload.station.call || '',
    operation: wlStr(payload.station.operation),
    operator: wlStr(m.operator),
    id: m.id,
    number: m.number,
    direction: m.direction,
    ts: m.ts,
    status: m.status,
    attempts: Array.isArray(m.attempts) ? m.attempts : [],
    revisions: payload.revisions,
    updated: m.updated,
    exported: payload.exported || null,
    exercise: winlinkIsExercise(payload),
  };
  if (extra.mid) src.mid = extra.mid;
  return src;
}

const wlRefText = (number, station) => `${number} (${station || '?'})`;
const wlLocOk = l => wlIsObj(l) && typeof l.label === 'string' && Number.isFinite(l.lat) && Number.isFinite(l.lon);

// What an import does. localMessages: the open operation's messages (the
// Bezug is resolved there); allMessages: every stored message (own
// messages and earlier imports are recognised in any operation).
// home: the operation's „Für Stelle“ (Adressat when the file names none);
// now: the time of receipt (the new message's time).
// Returns one of
// - { kind: 'own', local }: a message of this book came back; not imported
// - { kind: 'duplicate', local }: imported before, nothing newer
// - { kind: 'update-source', local, source }: imported before, the sender's
//   record is newer: only `source` is replaced
// - { kind: 'new', fields, source, refLocal, warnings }: a new incoming message
//   for the form (the operator reviews it before saving)
export function winlinkImportPlan(parsed, localMessages, { allMessages = localMessages, home = '', now }) {
  const all = allMessages || [];
  const live = (localMessages || []).filter(m => !m.deleted);
  const warnings = [];
  if (parsed.kind === 'payload') {
    const p = parsed.payload;
    const m = p.message;
    const own = all.find(x => x.id === m.id || (m.source?.id && x.id === m.source.id));
    if (own) return { kind: 'own', local: own };
    const prior = all.find(x => x.source?.id === m.id);
    if (prior) {
      if ((m.updated || '') > (prior.source.updated || '')) return { kind: 'update-source', local: prior, source: winlinkSource(p, { mid: parsed.mid || prior.source.mid }) };
      return { kind: 'duplicate', local: prior };
    }
    let refLocal = null;
    let refNumber = '';
    if (p.ref) {
      const ids = [p.ref.id, p.ref.source?.id].filter(Boolean);
      refLocal = live.find(x => ids.includes(x.id) || (x.source?.id && ids.includes(x.source.id))) || null;
      refNumber = refLocal ? refLocal.number : wlRefText(p.ref.number, p.ref.station);
    } else if (m.refNumber) {
      refNumber = wlRefText(m.refNumber, p.station.call);
    }
    if (m.deleted) warnings.push('Der Absender hat diese Meldung gelöscht.');
    // a resolved place only in the shape this book stores (else as text)
    const loc = wlLocOk(m.location) ? m.location : null;
    const placeLoc = wlLocOk(m.origin?.placeLoc) ? m.origin.placeLoc : null;
    const fields = messageFields({
      ...m,
      direction: 'in', ts: now, channel: 'winlink', radio: {}, peer: '', readBack: false,
      replyTo: refLocal ? refLocal.id : null,
      refKind: refNumber ? m.refKind || 'antwort' : null,
      refNumber,
      location: loc,
      locationText: loc ? '' : wlStr(m.locationText || m.location?.label),
      origin: { ...(m.origin || {}), station: m.origin?.station || p.station.call || '', placeLoc },
      staffRef: '',
      source: null,
    });
    return { kind: 'new', fields, source: winlinkSource(p, { mid: parsed.mid }), refLocal, warnings };
  }
  const f = parsed.flat;
  if (parsed.mid) {
    const prior = all.find(x => x.source?.mid === parsed.mid);
    if (prior) return { kind: 'duplicate', local: prior };
  }
  if (f.ours && f.number && f.station) {
    const prior = all.find(x => x.source && !x.source.id && x.source.number === f.number && x.source.station === f.station);
    if (prior) return { kind: 'duplicate', local: prior };
  }
  if (!f.subject && !f.text) throw new Error('Die Nachricht hat weder Betreff noch Text');
  let refKind = null;
  let refNumber = '';
  if (f.bezug) {
    const kind = Object.entries(REF_KINDS).find(([, label]) => f.bezug.startsWith(`${label} `));
    refKind = kind ? kind[0] : 'antwort';
    refNumber = kind ? f.bezug.slice(kind[1].length + 1).trim() : f.bezug;
  }
  if (!f.ours) warnings.push(f.form ? `Anderes Formular (${f.form}): nur Betreff, Text und Absender übernommen.` : 'Nachricht ohne Formular: nur Betreff, Text und Absender übernommen.');
  const fields = messageFields({
    direction: 'in', ts: now, channel: 'winlink', type: f.type || 'meldung', priority: f.priority || 'routine',
    from: parseParty(f.from), to: f.to ? parseParty(f.to) : parseParty(home),
    subject: f.subject || f.text.split('\n')[0].slice(0, 80), text: f.text || f.subject,
    origin: { station: f.station || '' },
    refKind, refNumber,
  });
  const source = {
    format_version: f.formatVersion ? Number(f.formatVersion) || null : null,
    station: f.station || '',
    id: null,
    number: f.number || '',
    ts: f.ts || null,
    status: [], attempts: [], revisions: [],
    exported: null,
    ...(f.exercise != null ? { exercise: f.exercise } : {}),
    ...(f.history ? { history: f.history } : {}),
    ...(f.form ? { form: f.form } : {}),
    ...(parsed.mid ? { mid: parsed.mid } : {}),
  };
  return { kind: 'new', fields, source, refLocal: null, warnings };
}
