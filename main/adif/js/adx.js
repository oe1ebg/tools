// Native XML parsing, shared ADIF semantics, and lossless UTF-8 serialization.
// No schemas or external resources are consulted at runtime.
import { ADIF_SPEC_VERSION, ADIF_SPEC_FIELDS, ADIF_SPEC_DATATYPES } from '../../shared/js/adif-spec-data.js';
import { adifRunSteps, AdifLimitError } from '../../shared/js/adif.js';
import { validateAdifHeader, validateAdifRecordsSteps } from '../../shared/js/adif-validate.js';

export const ADX_MIME = 'application/octet-stream'; // Safari keeps the .adx filename
export class AdxImportError extends Error {
  constructor(code, message) { super(message); this.name = 'AdxImportError'; this.code = code; }
}

// Extension is a hint only. XML with another root is never sent to ADI recovery.
export function detectLogFormat(text, filename = '') {
  const start = text.replace(/^\ufeff/, '').trimStart();
  const withoutPreamble = start.replace(/^(?:<\x21--[^]*?-->\s*|<\?[^]*?\?>\s*)*/, '');
  if (/^<(?:[\w.-]+:)?ADX(?:\s|\/?>)/.test(withoutPreamble)) return 'adx';
  const adiTags = /<(?:[A-Za-z][\w]*:\d|eoh>|eor>)/i.test(start);
  const xmlPreamble = /^<\?xml|^<!DOCTYPE/i.test(start);
  const xmlClosing = /<\/[A-Za-z][\w.:-]*\s*>/.test(start);
  if (!xmlPreamble && !xmlClosing && adiTags) return 'adi';
  if (/^<\?|^<!|^<\/?[\w.-]+(?=\s|\/?>)/.test(start)) {
    throw new AdxImportError('ADX_STRUCTURE', 'XML content is not an ADX document.');
  }
  if (/\.adx$/i.test(filename) && !/<(?:[A-Za-z][\w]*:\d|eoh>|eor>)/i.test(start)) {
    throw new AdxImportError('ADX_STRUCTURE', 'The .adx file does not contain ADX XML or recognizable ADI.');
  }
  return 'adi';
}

function axName(node) { return node.localName; } // namespaces ignored (IV.B.1)
function axChildren(node) { return Array.from(node.children); }
function axAttributes(node, allowed = []) {
  if (!/^[A-Z][A-Z0-9_]*$/.test(axName(node))) throw new AdxImportError('ADX_STRUCTURE', 'ADX element names must be uppercase.');
  const seen = new Set();
  for (const attr of Array.from(node.attributes)) {
    if (attr.namespaceURI === 'http://www.w3.org/2000/xmlns/') continue;
    if (attr.namespaceURI && !allowed.includes(attr.localName)) continue; // ignored namespace metadata
    if (seen.has(attr.localName)) throw new AdxImportError('ADX_STRUCTURE', `${axName(node)} has duplicate attributes after namespace normalization.`);
    seen.add(attr.localName);
    if (!allowed.includes(attr.localName)) throw new AdxImportError('ADX_STRUCTURE', `${axName(node)}: unexpected or non-uppercase attribute ${attr.localName}.`);
  }
}
function axContainer(node) {
  if (Array.from(node.childNodes).some(n => (n.nodeType === 3 || n.nodeType === 4) && n.textContent.trim())) throw new AdxImportError('ADX_STRUCTURE', `${axName(node)} contains text outside fields.`);
}
function axEscape(value, attribute = false) {
  let s = String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r/g, '&#13;');
  if (attribute) s = s.replace(/"/g, '&quot;').replace(/\n/g, '&#10;').replace(/\t/g, '&#9;');
  return s;
}
function axAttribute(node, name) {
  // Namespace prefixes have no ADIF meaning; attribute local names still do.
  const attr = Array.from(node.attributes).find(a => a.namespaceURI !== 'http://www.w3.org/2000/xmlns/' && a.localName === name);
  return attr?.value ?? '';
}
function axText(node) {
  if (axChildren(node).length || Array.from(node.childNodes).some(n => n.nodeType === 4)) {
    throw new AdxImportError('ADX_FIELD_CONTENT', `${axName(node)}: field elements cannot contain nested elements or CDATA.`);
  }
  return node.textContent;
}
function axType(indicator) { return Object.values(ADIF_SPEC_DATATYPES).some(d => d.indicator === indicator); }

export function parseADX(source, options = {}) { return adifRunSteps(parseADXSteps(source, options)); }
export function* parseADXSteps(source, { parser = null, limits = {}, name = '' } = {}) {
  const clean = source.replace(/<\x21--[^]*?-->|<\?[^]*?\?>/g, '');
  if (/<!DOCTYPE|<!ENTITY/i.test(clean)) throw new AdxImportError('ADX_PROHIBITED_XML', 'ADX does not allow DOCTYPE declarations or custom entities.');
  const encoding = /^\ufeff?\s*<\?xml[^?]*\bencoding\s*=\s*['"]([^'"]+)['"]/i.exec(source);
  if (encoding && !/^utf-8$/i.test(encoding[1])) throw new AdxImportError('ADX_ENCODING', 'ADX must use UTF-8 encoding.');
  yield { phase: 'parse', pos: 0, total: source.length, records: 0 };
  // Remove ignored PIs before native parsing, including stylesheet PIs.
  // Comments/CDATA are opaque so tag-shaped text in them is not rewritten.
  const parseSource = source.replace(/^\ufeff/, '').replace(/<\x21--[^]*?-->|<\x21\[CDATA\[[^]*?\]\]>|<\?[^]*?\?>/g, token => token.startsWith('<?') && !/^<\?xml(?:\s|\?>)/i.test(token) ? '' : token);
  const doc = (parser || new DOMParser()).parseFromString(parseSource, 'application/xml');
  if (!doc.documentElement || axName(doc.documentElement) === 'parsererror' || doc.getElementsByTagNameNS('*', 'parsererror').length) {
    throw new AdxImportError('ADX_XML_SYNTAX', 'Malformed or truncated XML; no records from this file were loaded.');
  }
  const root = doc.documentElement;
  axAttributes(root); axContainer(root);
  const children = axChildren(root);
  if (axName(root) !== 'ADX' || children.length !== 2 || axName(children[0]) !== 'HEADER' || axName(children[1]) !== 'RECORDS') {
    throw new AdxImportError('ADX_STRUCTURE', 'ADX requires one HEADER followed by one RECORDS element.');
  }
  axAttributes(children[0]); axContainer(children[0]);
  axAttributes(children[1]); axContainer(children[1]);
  const headerInfo = {}, defs = { userdefs: [], types: {}, apps: {}, appOrigins: new WeakMap(), adxRecords: new WeakSet() }, parsed = [], recordTypes = [], syntax = [];
  const syntaxCounts = { error: 0, warning: 0, info: 0 };
  const syntaxLimit = limits.maxIssues > 0 ? limits.maxIssues : Infinity;
  const diagnostic = (code, message, extra) => {
    syntaxCounts.error++;
    if (syntax.length < syntaxLimit) syntax.push({ severity: 'error', code, message, ...extra });
  };
  const seenUserIds = new Set(), seenUserNames = new Set();
  for (const node of axChildren(children[0])) {
    const field = axName(node), value = axText(node);
    axAttributes(node, field === 'USERDEF' ? ['FIELDID', 'TYPE', 'ENUM', 'RANGE'] : []);
    if (field === 'USERDEF') {
      const id = axAttribute(node, 'FIELDID'), type = axAttribute(node, 'TYPE').toUpperCase();
      const enumValue = axAttribute(node, 'ENUM'), range = axAttribute(node, 'RANGE');
      const fieldName = value.toUpperCase();
      if (!/^\d+$/.test(id) || +id <= 0 || seenUserIds.has(+id) || seenUserNames.has(fieldName) || (enumValue && range) || !axType(type)) {
        diagnostic('INVALID_USERDEF', 'USERDEF needs a unique positive FIELDID/name, valid TYPE and at most one ENUM or RANGE.', { recordType: 'header', field: fieldName });
      }
      seenUserIds.add(+id); seenUserNames.add(fieldName);
      const spec = value + (enumValue || range ? ',' + (enumValue || range) : '');
      defs.userdefs.push({ name: fieldName, type, spec, file: name });
    } else if (field === 'APP') {
      throw new AdxImportError('ADX_STRUCTURE', 'APP fields belong in RECORD, not HEADER.');
    } else {
      if (field in headerInfo) diagnostic('DUPLICATE_FIELD', `${field} appears twice in HEADER.`, { recordType: 'header', field });
      headerInfo[field] = value;
    }
  }
  const checkedHeader = validateAdifHeader(headerInfo, { format: 'adx', maxIssues: syntaxLimit === Infinity ? undefined : syntaxLimit });
  syntaxCounts.error += checkedHeader.errors; syntaxCounts.warning += checkedHeader.warnings; syntaxCounts.info += checkedHeader.infos;
  for (const issue of checkedHeader.issues) if (syntax.length < syntaxLimit) syntax.push(issue);
  const columnsRead = new Set();
  const allColumns = new Set(limits.columns || []);
  let fieldsRead = 0;
  // ADX separates APP PROGRAMID/FIELDNAME; their flattened ADI names can
  // collide. Determine stable editor-only qualifiers before reading values,
  // preserving the ordinary ADI identity whenever it occurs in the file.
  const appVariants = new Map(), appKeys = new Map();
  const appNodes = children[1].getElementsByTagNameNS('*', 'APP');
  for (let i = 0; i < appNodes.length; i++) {
    const pid = axAttribute(appNodes[i], 'PROGRAMID').toUpperCase();
    const fname = axAttribute(appNodes[i], 'FIELDNAME').toUpperCase();
    const base = `APP_${pid}_${fname}`, id = JSON.stringify([pid, fname]);
    if (!appVariants.has(base)) appVariants.set(base, new Map());
    appVariants.get(base).set(id, { pid, fname });
    if ((i & 1023) === 1023) yield { phase: 'parse', records: 0, pos: i + 1, total: appNodes.length };
  }
  for (const [base, variants] of appVariants) {
    const parts = /^APP_([^_]+)_(.+)$/.exec(base);
    const ordinary = parts ? JSON.stringify([parts[1], parts[2]]) : '';
    const preferred = variants.has(ordinary) ? ordinary : [...variants.keys()].sort()[0];
    for (const [id, { pid, fname }] of variants) appKeys.set(id, id === preferred ? base : `${base} [${pid.length}:${pid}${fname.length}:${fname}]`);
  }
  const recordNodes = axChildren(children[1]);
  for (const node of recordNodes) {
    if (axName(node) !== 'RECORD') throw new AdxImportError('ADX_STRUCTURE', 'RECORDS may contain only RECORD elements.');
    axAttributes(node);
    const rec = {}, types = {}, appInfo = {};
    const index = parsed.length;
    if (limits.maxRecords && index >= limits.maxRecords) throw new AdifLimitError('RECORDS', 'too many records', { at: index + 1, limit: limits.maxRecords });
    let fieldCount = 0;
    for (const fieldNode of axChildren(node)) {
      const element = axName(fieldNode);
      axAttributes(fieldNode, element === 'APP' ? ['PROGRAMID', 'FIELDNAME', 'TYPE'] : element === 'USERDEF' ? ['FIELDNAME', 'TYPE'] : []);
      let field = element;
      if (!/^[A-Z][A-Z0-9_]*$/.test(element)) throw new AdxImportError('ADX_STRUCTURE', 'ADX element names must be uppercase.');
      if (element === 'APP') {
        const programId = axAttribute(fieldNode, 'PROGRAMID'), fieldName = axAttribute(fieldNode, 'FIELDNAME');
        field = appKeys.get(JSON.stringify([programId.toUpperCase(), fieldName.toUpperCase()])) || `APP_${programId}_${fieldName}`.toUpperCase();
        const identity = { programId, fieldName, type: axAttribute(fieldNode, 'TYPE').toUpperCase() || 'M' };
        if (!programId || !fieldName || /[^\x20-\x7e]/.test(programId + fieldName)) diagnostic('INVALID_APPLICATION_FIELD', 'APP needs nonempty ASCII PROGRAMID and FIELDNAME attributes.', { recordType: 'qso', recordIndex: index, field });
        appInfo[field] = identity;
        if (!defs.apps[field]) defs.apps[field] = identity;
        const explicitType = Array.from(fieldNode.attributes).some(a => a.namespaceURI !== 'http://www.w3.org/2000/xmlns/' && a.localName === 'TYPE');
        if (explicitType && !axType(axAttribute(fieldNode, 'TYPE').toUpperCase())) diagnostic('INVALID_DATATYPE_INDICATOR', 'APP TYPE must be a recognized ADIF indicator when present.', { recordType: 'qso', recordIndex: index, field });
      }
      if (element === 'USERDEF') field = axAttribute(fieldNode, 'FIELDNAME').toUpperCase();
      const value = axText(fieldNode);
      if (field in rec) diagnostic('DUPLICATE_FIELD', `${field} appears twice in this QSO; the last value is used.`, { recordType: 'qso', recordIndex: index, field, value });
      if (element === 'USERDEF' && !seenUserNames.has(field)) diagnostic('INVALID_USERDEF', `${field} has no declaration in HEADER.`, { recordType: 'qso', recordIndex: index, field, value });
      rec[field] = value;
      if (element === 'APP') {
        types[field] = axAttribute(fieldNode, 'TYPE').toUpperCase();
        if (!(field in defs.types)) defs.types[field] = types[field];
      }
      columnsRead.add(field); allColumns.add(field);
      fieldCount++; fieldsRead++;
      if (limits.maxValueChars && value.length > limits.maxValueChars) throw new AdifLimitError('VALUE', 'value too long', { at: index + 1, field, length: value.length, limit: limits.maxValueChars });
      if (limits.maxFieldsPerRecord && fieldCount > limits.maxFieldsPerRecord) throw new AdifLimitError('FIELDS', 'too many fields', { at: index + 1, limit: limits.maxFieldsPerRecord });
      if (limits.maxFields && fieldsRead > limits.maxFields) throw new AdifLimitError('FIELDS_TOTAL', 'too many fields', { at: index + 1, limit: limits.maxFields });
      if (limits.maxColumns && allColumns.size > limits.maxColumns) throw new AdifLimitError('COLUMNS', 'too many columns', { at: index + 1, limit: limits.maxColumns });
      if (fieldsRead % 1024 === 0) yield { phase: 'parse', records: index, pos: index, total: recordNodes.length };
    }
    defs.adxRecords.add(rec);
    defs.appOrigins.set(rec, appInfo);
    parsed.push(rec); recordTypes.push(types);
    if (parsed.length % 256 === 0) yield { phase: 'parse', records: parsed.length, pos: parsed.length, total: recordNodes.length };
  }
  limits.fieldsRead = fieldsRead; limits.columnsRead = [...columnsRead];
  return { parsed, defs, headerInfo, recordTypes, syntax, syntaxCounts, warnings: [] };
}

export function* validateADXRecordsSteps(data, options = {}) {
  const result = yield* validateAdifRecordsSteps(data.parsed, data.defs, { ...options, format: 'adx', recordTypes: data.recordTypes });
  const syntaxCounts = data.syntaxCounts || { error: 0, warning: 0, info: 0 };
  if (!data.syntaxCounts) for (const i of data.syntax || []) syntaxCounts[i.severity]++;
  result.errors += syntaxCounts.error; result.warnings += syntaxCounts.warning; result.infos += syntaxCounts.info;
  let retained = 0;
  for (const issue of data.syntax || []) {
    if (!options.maxIssues || result.issues.length < options.maxIssues) { result.issues.push(issue); retained++; }
  }
  const omitted = syntaxCounts.error + syntaxCounts.warning + syntaxCounts.info - retained;
  if (omitted) result.issuesDropped = (result.issuesDropped || 0) + omitted;
  result.valid = result.errors === 0;
  result.header = { fields: data.headerInfo };
  return result;
}

export function serializeADX(log, columns, createdIso = new Date().toISOString(), defs = {}) {
  return adifRunSteps(serializeADXSteps(log, columns, createdIso, defs));
}
export function* serializeADXSteps(log, columns, createdIso = new Date().toISOString(), defs = {}) {
  const stamp = createdIso.replace(/[-:]/g, '').replace('T', ' ').slice(0, 15);
  const out = [`<?xml version="1.0" encoding="UTF-8"?>\n<ADX>\n<HEADER><ADIF_VER>${ADIF_SPEC_VERSION}</ADIF_VER><PROGRAMID>ADIFEditor</PROGRAMID><CREATED_TIMESTAMP>${stamp}</CREATED_TIMESTAMP>`];
  const users = new Map();
  (defs.userdefs || []).forEach((u, i) => {
    users.set(u.name, u);
    const restriction = /^[^,]+,(\{[^]*\})$/.exec(u.spec)?.[1];
    const attr = restriction ? ` ${restriction.includes(':') ? 'RANGE' : 'ENUM'}="${axEscape(restriction, true)}"` : '';
    out.push(`<USERDEF FIELDID="${i + 1}" TYPE="${axEscape(u.type, true)}"${attr}>${axEscape(u.name)}</USERDEF>`);
  });
  out.push('</HEADER>\n<RECORDS>\n');
  for (let i = 0; i < log.length; i++) {
    const rec = log[i];
    out.push('<RECORD>');
    for (const field of columns) {
      const value = rec[field];
      if (value === undefined || value === null) continue;
      if (users.has(field)) out.push(`<USERDEF FIELDNAME="${axEscape(field, true)}">${axEscape(value)}</USERDEF>`);
      else if (field.startsWith('APP_')) {
        const identity = defs.appOrigins?.get(rec)?.[field] || defs.apps?.[field];
        out.push(axApp(field, defs.typeOverrides?.has(field) ? defs.types?.[field] || 'M' : identity?.type || defs.types?.[field] || 'M', value, identity));
      }
      else if (ADIF_SPEC_FIELDS[field]) out.push(`<${field}>${axEscape(value)}</${field}>`);
      else throw new Error(`${field}: declare an unknown field as USERDEF before ADX export.`);
    }
    out.push('</RECORD>\n');
    if ((i & 255) === 255) yield { phase: 'export', done: i + 1, total: log.length };
  }
  out.push('</RECORDS>\n</ADX>\n');
  return out.join('');
}
function axApp(field, type, value, identity = null) {
  const match = /^APP_([^_]+)_(.+)$/.exec(field);
  if (!match) throw new Error(`${field}: invalid application-defined field name.`);
  return `<APP PROGRAMID="${axEscape(identity?.programId || match[1], true)}" FIELDNAME="${axEscape(identity?.fieldName || match[2], true)}" TYPE="${axEscape(type, true)}">${axEscape(value)}</APP>`;
}
