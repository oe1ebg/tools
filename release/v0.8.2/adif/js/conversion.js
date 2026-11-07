// Export decisions are explicit, per field/category, and affect a copy only.
import { ADIF_SPEC_FIELDS, ADIF_SPEC_DATATYPES, ADIF_SPEC_ENUMS } from '../../shared/js/adif-spec-data.js';
import { adifAscii, adifRunSteps } from '../../shared/js/adif.js';
import { emptyFieldDefs, mergeFieldDefs } from './export.js';
import { tx } from '../../shared/js/i18n.js';

function cvMultiline(field, defs) {
  const type = ADIF_SPEC_FIELDS[field]?.type;
  const indicator = defs.userdefs.find(u => u.name === field)?.type || defs.types[field] || (field.startsWith('APP_') ? 'M' : 'S');
  return type ? type.includes('Multiline') : indicator === 'M' || indicator === 'G';
}
function cvAscii(value, field, defs) { return adifAscii(value, { keepBrackets: true, multiline: cvMultiline(field, defs) }); }
function cvChoice(value, label) { return { value, label }; }
function cvCloneDefs(defs) {
  return { ...emptyFieldDefs(), userdefs: (defs?.userdefs || []).map(u => ({ ...u })), types: { ...(defs?.types || {}) }, typeFiles: { ...(defs?.typeFiles || {}) }, apps: { ...(defs?.apps || {}) }, appOrigins: defs?.appOrigins || new WeakMap(), typeOverrides: new Set(defs?.typeOverrides || []), adxRecords: defs?.adxRecords || new WeakSet() };
}

export function prepareExport(log, columns, target, sources = [], fallbackDefs = emptyFieldDefs(), sourceOf = null) {
  return adifRunSteps(prepareExportSteps(log, columns, target, sources, fallbackDefs, sourceOf));
}
export function* prepareExportSteps(log, columns, target, sources = [], fallbackDefs = emptyFieldDefs(), sourceOf = null) {
  const defs = emptyFieldDefs(); defs.apps = {}; defs.appOrigins = new WeakMap(); defs.typeOverrides = new Set(); defs.adxRecords = new WeakSet();
  const candidates = new Map(), groups = new Map();
  function group(key, field, reason, choices) {
    if (!groups.has(key)) groups.set(key, { key, field, reason, choices, entries: [] });
    return groups.get(key);
  }
  const keep = new Set(columns);
  for (const source of sources.length ? sources : [{ name: tx('current log', 'aktuelles Log'), defs: fallbackDefs }]) {
    const sourceDefs = cvCloneDefs(source.defs);
    sourceDefs.types = Object.fromEntries(Object.entries(sourceDefs.types).filter(([field]) => keep.has(field)));
    mergeFieldDefs(defs, sourceDefs, source.name);
    for (const field of sourceDefs.typeOverrides) defs.typeOverrides.add(field);
    for (const [field, identity] of Object.entries(sourceDefs.apps)) if (!defs.apps[field]) defs.apps[field] = identity;
    for (const u of sourceDefs.userdefs) {
      if (!candidates.has(u.name)) candidates.set(u.name, []);
      candidates.get(u.name).push({ ...u, file: source.name, kind: 'userdef' });
    }
    for (const [field, type] of Object.entries(sourceDefs.types)) {
      if (ADIF_SPEC_FIELDS[field] || sourceDefs.userdefs.some(u => u.name === field)) continue;
      if (!candidates.has(field)) candidates.set(field, []);
      const parts = /^APP_([^_]+)_(.+)$/.exec(field);
      const identity = sourceDefs.apps[field] || (parts ? { programId: parts[1], fieldName: parts[2] } : { programId: '', fieldName: field });
      candidates.get(field).push({ name: field, type: type || 'M', file: source.name, kind: 'app', ...identity });
    }

  }
  for (const [field, choices] of candidates) {
    const kinds = new Set(choices.map(c => c.kind));
    const types = new Set(choices.map(c => c.type || (c.kind === 'app' ? 'M' : '')));
    const identities = new Map();
    for (const c of choices) if (c.kind === 'app') {
      const key = JSON.stringify([c.programId.toUpperCase(), c.fieldName.toUpperCase()]);
      if (!identities.has(key)) identities.set(key, new Set());
      identities.get(key).add(c.type || 'M');
    }
    const independentApps = target === 'adx' && kinds.size === 1 && kinds.has('app') && [...identities.values()].every(t => t.size === 1);
    if ((types.size > 1 && !independentApps) || kinds.size > 1) {
      const g = group('definition:' + field, field, tx('Custom field declarations conflict; select the combined export definition.', 'Eigene Felddeklarationen widersprechen sich; die gemeinsame Definition für den Export wählen.'), [
        cvChoice('first', tx(`Use first (${choices[0].type || 'unspecified'})`, `Erste verwenden (${choices[0].type || 'ohne Angabe'})`)), cvChoice('last', tx(`Use last (${choices.at(-1).type || 'unspecified'})`, `Letzte verwenden (${choices.at(-1).type || 'ohne Angabe'})`)), cvChoice('text', tx('Declare as multiline text', 'Als mehrzeiligen Text deklarieren')), cvChoice('drop', tx('Omit this field', 'Dieses Feld weglassen'))]);
      g.candidates = choices;
      g.entries.push(...choices.map(c => ({ field, recordIndex: null, before: `${c.file}: ${c.kind} ${c.type} ${c.spec || ''}`, after: '' })));
    }
  }
  if (target === 'adi') for (const u of defs.userdefs) {
    const after = adifAscii(u.spec, { keepBrackets: true });
    if (after !== u.spec) {
      const g = group('restriction:' + u.name, u.name, tx('The custom declaration itself changes when written as ADI ASCII.', 'Die eigene Deklaration selbst ändert sich, wenn sie als ADI-ASCII geschrieben wird.'), [cvChoice('convert', tx('Approve displayed declaration conversion', 'Angezeigte Umwandlung der Deklaration annehmen')), cvChoice('drop', tx('Omit this field and declaration', 'Feld und Deklaration weglassen'))]);
      g.entries.push({ recordIndex: null, field: u.name, before: u.spec, after });
    }
  }
  for (const u of defs.userdefs) if (!u.type || !Object.values(ADIF_SPEC_DATATYPES).some(d => d.indicator === u.type)) {
    const g = group('type:' + u.name, u.name, tx('This custom declaration has no usable ADIF type.', 'Diese eigene Deklaration hat keinen brauchbaren ADIF-Typ.'), [cvChoice('text', tx('Declare as multiline text', 'Als mehrzeiligen Text deklarieren')), cvChoice('drop', tx('Omit this field', 'Dieses Feld weglassen'))]);
    g.entries.push({ recordIndex: null, field: u.name, before: u.type || tx('(missing type)', '(Typ fehlt)'), after: target === 'adx' ? 'G' : 'M' });
  }
  const copy = [], unicodeFields = new Set();
  for (let index = 0; index < log.length; index++) {
    const original = log[index];
    const rec = { ...original }; copy.push(rec);
    const sourceDefs = sourceOf?.(original) || fallbackDefs;
    if (sourceDefs?.adxRecords?.has(original)) defs.adxRecords.add(rec);
    if (target === 'adi' && defs.adxRecords.has(rec) && !Object.keys(rec).length) {
      const g = group('empty-records', tx('(empty records)', '(leere QSOs)'), tx('ADI readers cannot restore fieldless ADX records. Export ADX to retain them, or explicitly omit these records.', 'ADI-Leser können feldlose ADX-QSOs nicht wiederherstellen. Als ADX exportieren, um sie zu behalten, oder diese QSOs ausdrücklich weglassen.'), [cvChoice('drop', tx('Omit fieldless records', 'Feldlose QSOs weglassen'))]);
      g.entries.push({ recordIndex: index, field: '', before: tx('empty ADX record', 'leeres ADX-QSO'), after: tx('(omitted)', '(weggelassen)') });
    }
    const originalApps = sourceDefs?.appOrigins?.get(original) || sourceDefs?.apps || {};
    defs.appOrigins.set(rec, originalApps);
    for (const field of columns) {
      const value = rec[field];
      if (value === undefined || value === null || (value === '' && !(target === 'adi' && defs.adxRecords.has(rec)))) continue;
      // Resolve declaration conflicts before presenting value/type losses.
      if (/[^\x20-\x7e\r\n]/.test(value)) unicodeFields.add(field);
      if (groups.has('definition:' + field)) {
        groups.get('definition:' + field).entries.push({ recordIndex: index, field, before: value, after: tx('(export definition pending)', '(Export-Definition offen)') });
        continue;
      }
      const def = ADIF_SPEC_FIELDS[field];
      const customType = defs.userdefs.find(u => u.name === field)?.type || defs.types[field];
      let g, after;
      const appIdentity = originalApps[field] || defs.apps[field];
      if (target === 'adi' && field.startsWith('APP_') && (appIdentity?.programId.includes('_') || /[,<>:{}]/.test(field) || / $/.test(field))) {
        const invalid = /[,<>:{}]/.test(field) || / $/.test(field);
        g = group('identity:' + field, field, invalid ? tx('This APP identity cannot be represented as an ADI field name. Cancel or export ADX to retain it.', 'Diese APP-Kennung lässt sich nicht als ADI-Feldname darstellen. Abbrechen oder als ADX exportieren, um sie zu behalten.') : tx('ADI cannot retain the separate PROGRAMID/FIELDNAME boundary for this APP field. Re-importing ADI may attribute it to a different program.', 'ADI kann die Grenze zwischen PROGRAMID und FIELDNAME dieses APP-Felds nicht erhalten. Ein erneuter ADI-Import ordnet es womöglich einem anderen Programm zu.'), invalid ? [cvChoice('drop', tx('Omit this field', 'Dieses Feld weglassen'))] : [cvChoice('flatten', tx('Approve the flattened ADI field name', 'Zusammengezogenen ADI-Feldnamen annehmen')), cvChoice('drop', tx('Omit this field', 'Dieses Feld weglassen'))]);
        after = invalid ? '' : value;
      } else if (target === 'adi' && (def?.type.startsWith('Intl') || customType === 'I' || customType === 'G')) {
        const nonintl = field.replace(/_INTL$/, '');
        const canMap = nonintl !== field && ADIF_SPEC_FIELDS[nonintl] && !ADIF_SPEC_FIELDS[nonintl].type.startsWith('Intl');
        const choices = canMap ? [cvChoice('map-keep', tx(`Map to ${nonintl}; keep existing values on conflicts`, `Nach ${nonintl} übernehmen; bei Konflikten vorhandene Werte behalten`)), cvChoice('map-replace', tx(`Map to ${nonintl}; replace existing values on conflicts`, `Nach ${nonintl} übernehmen; bei Konflikten vorhandene Werte ersetzen`)), cvChoice('drop', tx('Omit international field', 'Internationales Feld weglassen'))] : [cvChoice('convert', tx('Convert to ASCII text type', 'In ASCII-Texttyp umwandeln')), cvChoice('drop', tx('Omit this field', 'Dieses Feld weglassen'))];
        g = group('international:' + field, field, tx('International data/types cannot be represented in ADI. Mapping transliterates characters; unsupported characters become ?.', 'Internationale Daten und Typen lassen sich in ADI nicht darstellen. Beim Übernehmen werden Zeichen umschrieben; nicht unterstützte Zeichen werden zu ?.'), choices);
        g.destination = canMap ? nonintl : field;
        after = cvAscii(value, canMap ? nonintl : field, defs);
      } else if (target === 'adx' && def?.header) {
        g = group('header-field:' + field, field, tx('A header field cannot be placed in an ADX QSO record. Cancel to edit it or use ADI to retain the existing representation.', 'Ein Header-Feld kann nicht in einem ADX-QSO stehen. Abbrechen, um es zu bearbeiten, oder ADI verwenden, um die vorhandene Darstellung zu behalten.'), [cvChoice('drop', tx('Omit this field from QSO records', 'Dieses Feld aus den QSOs weglassen'))]);
        after = '';
      } else if (target === 'adi' && cvAscii(value, field, defs) !== value) {
        g = group('value:' + field, field, tx('ADI serialization changes characters, surrounding whitespace, or line breaks. Unsupported characters become ?.', 'Das Schreiben als ADI ändert Zeichen, Leerraum am Rand oder Zeilenumbrüche. Nicht unterstützte Zeichen werden zu ?.'), [cvChoice('convert', tx('Approve displayed ASCII/whitespace conversion', 'Angezeigte ASCII-/Leerraum-Umwandlung annehmen')), cvChoice('drop', tx('Omit this field', 'Dieses Feld weglassen'))]);
        after = cvAscii(value, field, defs);
      } else if (target === 'adx' && !def && !field.startsWith('APP_') && !defs.userdefs.some(u => u.name === field)) {
        g = group('unknown:' + field, field, tx('ADX requires a USERDEF declaration for this nonstandard field.', 'ADX braucht für dieses nicht standardisierte Feld eine USERDEF-Deklaration.'), [cvChoice('declare', tx('Declare as text, preserving values', 'Als Text deklarieren, Werte bleiben')), cvChoice('drop', tx('Omit this field', 'Dieses Feld weglassen'))]);
        after = value;
      } else if (target === 'adx' && (def?.importOnly || (def?.rangeImportOnly && /^-?(?:\d+\.?\d*|\.\d+)$/.test(value) && ((def.min !== undefined && +value < def.min) || (def.max !== undefined && +value > def.max))) || (def?.enum && (def.enumScope ? ADIF_SPEC_ENUMS[def.enum]?.importOnlyByScope?.[String(rec[def.enumScope] || '').toUpperCase()] : ADIF_SPEC_ENUMS[def.enum]?.importOnly)?.some(v => v.toUpperCase() === String(value).toUpperCase())))) {
        g = group('deprecated:' + field, field, tx('This field/value is import-only and cannot be emitted in a conforming export. Cancel to edit it or use ADI to retain the existing representation.', 'Dieses Feld bzw. dieser Wert ist nur für den Import und darf in einem konformen Export nicht vorkommen. Abbrechen, um es zu bearbeiten, oder ADI verwenden, um die vorhandene Darstellung zu behalten.'), [cvChoice('drop', tx('Omit import-only occurrences', 'Nur-Import-Vorkommen weglassen'))]);
        after = '';
      } else if (target === 'adx' && /[^\x20-\x7e\r\n]/.test(value) && !(def?.type.startsWith('Intl') || customType === 'I' || customType === 'G')) {
        g = group('ascii:' + field, field, tx('Unicode is not legal in this ordinary ADIF field/type, even in XML.', 'Unicode ist in diesem gewöhnlichen ADIF-Feld bzw. -Typ nicht erlaubt, auch nicht in XML.'), [cvChoice('convert', tx('Approve displayed ASCII conversion', 'Angezeigte ASCII-Umwandlung annehmen')), cvChoice('drop', tx('Omit this field', 'Dieses Feld weglassen'))]);
        after = cvAscii(value, field, defs);
      }
      if (g) g.entries.push({ recordIndex: index, field, before: value, after, existing: g.destination && g.destination !== field ? rec[g.destination] : undefined, identity: g.key.startsWith('identity:') ? appIdentity : undefined });
    }
    if ((index & 255) === 255) yield { phase: 'preflight', done: index + 1, total: log.length };
  }
  // An unused Intl USERDEF declaration is representable in an ADI header
  // (the official ADI fixture includes these); only using its values needs conversion.

  return { target, records: copy, columns: [...columns], defs, unicodeFields, groups: [...groups.values()] };
}

export function applyExportChoices(plan, choices) {
  return adifRunSteps(applyExportChoicesSteps(plan, choices));
}
export function* applyExportChoicesSteps(plan, choices) {
  const log = [], defs = cvCloneDefs(plan.defs);
  for (let i = 0; i < plan.records.length; i++) {
    const rec = { ...plan.records[i] };
    log.push(rec);
    if (plan.defs.adxRecords?.has(plan.records[i])) defs.adxRecords.add(rec);
    const appInfo = plan.defs.appOrigins?.get(plan.records[i]);
    if (appInfo) defs.appOrigins.set(rec, appInfo);
    if ((i & 255) === 255) yield { phase: 'copy', done: i + 1, total: plan.records.length };
  }
  const columns = new Set(plan.columns), summary = [], omittedRecords = new Set();
  for (const group of plan.groups) {
    const action = choices[group.key];
    if (!group.choices.some(c => c.value === action)) throw new Error(tx(`Choose how to handle ${group.field}: ${group.reason}`, `Wählen, wie ${group.field} behandelt wird: ${group.reason}`));
    const field = group.field;
    if (group.key === 'empty-records') {
      for (const entry of group.entries) omittedRecords.add(entry.recordIndex);
      summary.push(tx(`Omitted ${group.entries.length} fieldless ADX record(s).`, `${group.entries.length} feldlose(s) ADX-QSO(s) weggelassen.`));
      continue;
    }
    summary.push(tx(`${field}: ${group.entries.length} affected item(s), ${group.choices.find(c => c.value === action).label}`, `${field}: ${group.entries.length} betroffene(r) Eintrag/Einträge, ${group.choices.find(c => c.value === action).label}`));
    if (group.key.startsWith('definition:')) {
      defs.typeOverrides.add(field);
      const selected = action === 'last' ? group.candidates.at(-1) : group.candidates[0];
      defs.userdefs = defs.userdefs.filter(u => u.name !== field);
      delete defs.types[field];
      if (action === 'text') {
        const unicode = plan.target === 'adx' && plan.unicodeFields.has(field);
        if (field.startsWith('APP_')) defs.types[field] = unicode ? 'G' : 'M';
        else defs.userdefs.push({ name: field, type: unicode ? 'G' : 'M', spec: field });
      } else if (action !== 'drop') {
        if (selected.kind === 'userdef') defs.userdefs.push({ ...selected });
        else defs.types[field] = selected.type;
      }
    }
    if (action === 'drop') {
      if (group.key.startsWith('deprecated:')) for (const entry of group.entries) delete log[entry.recordIndex][field];
      else {
        for (let i = 0; i < log.length; i++) {
          delete log[i][field];
          if ((i & 255) === 255) yield { phase: 'conversion', done: i + 1, total: log.length };
        }
        columns.delete(field); defs.userdefs = defs.userdefs.filter(u => u.name !== field); delete defs.types[field];
      }
      continue;
    }
    if (group.key.startsWith('identity:') && action === 'flatten') {
      delete defs.apps[field];
      for (let i = 0; i < log.length; i++) {
        const appInfo = defs.appOrigins.get(log[i]);
        if (appInfo?.[field]) { const changed = { ...appInfo }; delete changed[field]; defs.appOrigins.set(log[i], changed); }
        if ((i & 255) === 255) yield { phase: 'identity', done: i + 1, total: log.length };
      }
    }
    if (group.key.startsWith('type:') && action === 'text') {
      const user = defs.userdefs.find(u => u.name === field);
      if (user) user.type = plan.target === 'adx' ? 'G' : 'M';
    }
    if (group.key.startsWith('restriction:') && action === 'convert') {
      const user = defs.userdefs.find(u => u.name === field);
      if (user) user.spec = group.entries[0].after;
    }
    if (group.key.startsWith('unknown:') && action === 'declare') {
      const unicode = plan.unicodeFields.has(field);
      const original = defs.types[field];
      const valid = !!original && Object.values(ADIF_SPEC_DATATYPES).some(d => d.indicator === original);
      defs.userdefs.push({ name: field, type: valid ? original : unicode ? 'G' : 'M', spec: field });
    }
    if (group.key.startsWith('international:')) {
      if (action === 'convert') {
        defs.typeOverrides.add(field);
        const user = defs.userdefs.find(u => u.name === field);
        if (user) user.type = user.type === 'G' ? 'M' : 'S';
        if (defs.types[field]) defs.types[field] = defs.types[field] === 'G' ? 'M' : 'S';
      } else if (action.startsWith('map-')) {
        columns.add(group.destination); columns.delete(field);
      }
    }
    let transformed = 0;
    if (action === 'convert' || action.startsWith('map-')) for (const entry of group.entries) {
      if (++transformed % 256 === 0) yield { phase: 'conversion', done: transformed, total: group.entries.length };
      if (entry.recordIndex === null) continue;
      const rec = log[entry.recordIndex];
      if (rec[field] === undefined) continue; // a previous category omitted it
      const destination = action.startsWith('map-') ? group.destination : field;
      if (destination === field || !rec[destination] || action === 'map-replace') rec[destination] = cvAscii(rec[field], destination, defs);
      if (destination !== field) delete rec[field];
    }
  }
  // ADX has no legal representation for unpaired surrogates or XML controls.
  let inspected = 0;
  if (plan.target === 'adx') for (const rec of log) for (const value of Object.values(rec)) {
    if (++inspected % 1024 === 0) yield { phase: 'characters', done: inspected, total: inspected };
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/.test(value)) throw new Error(tx('An exported value contains a character forbidden in XML. Edit that value before exporting.', 'Ein exportierter Wert enthält ein in XML verbotenes Zeichen. Den Wert vor dem Export bearbeiten.'));
    for (let i = 0; i < value.length; i++) {
      const c = value.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) {
        const next = value.charCodeAt(++i);
        if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error(tx('An exported value contains an unpaired Unicode surrogate. Edit it before exporting.', 'Ein exportierter Wert enthält ein unpaariges Unicode-Surrogat. Den Wert vor dem Export bearbeiten.'));
      } else if (c >= 0xdc00 && c <= 0xdfff) throw new Error(tx('An exported value contains an unpaired Unicode surrogate. Edit it before exporting.', 'Ein exportierter Wert enthält ein unpaariges Unicode-Surrogat. Den Wert vor dem Export bearbeiten.'));
    }
  }
  return { records: log.filter((_, i) => !omittedRecords.has(i)), columns: [...columns], defs, summary };
}
