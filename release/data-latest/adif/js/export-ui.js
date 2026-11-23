import { el, fill } from '../../shared/js/dom.js';
import { ChunkedSlot, chunkedIsAbort } from '../../shared/js/chunked.js';
import { prepareExportSteps, applyExportChoicesSteps } from './conversion.js';
import { serializeADIFSteps, ADI_MIME } from './export.js';
import { serializeADXSteps, ADX_MIME } from './adx.js';
import { validateAdifSteps, validateAdifRecordsSteps } from '../../shared/js/adif-validate.js';
import { tx } from '../../shared/js/i18n.js';

// Native modal dialogs keep background editing disabled and restore focus.
export async function exportLogWithDecisions({ records: log, columns, target, sources, defs, download, onMessage, returnFocus, sourceOf }) {
  const previousFocus = returnFocus || document.activeElement;
  const dialog = el('dialog', { id: 'export-decisions', 'aria-labelledby': 'export-decision-title' });
  const title = el('h2', { id: 'export-decision-title' }, tx(`Export ${target.toUpperCase()}`, `${target.toUpperCase()} exportieren`));
  const status = el('p', { role: 'status' }, tx('Checking export…', 'Prüfe den Export…'));
  const content = el('div', { class: 'export-decisions-body' });
  const cancel = el('button', { type: 'button' }, tx('Cancel', 'Abbrechen'));
  const preserve = el('button', { type: 'button', hidden: target === 'adx', disabled: true }, tx('Export ADX instead', 'Stattdessen ADX exportieren'));
  const confirm = el('button', { type: 'button', disabled: true }, tx('Export with these choices', 'Mit dieser Wahl exportieren'));
  dialog.append(title, status, content, el('div', { class: 'export-decisions-actions' }, cancel, preserve, confirm));
  document.body.appendChild(dialog);
  const job = new ChunkedSlot();
  let choiceResolve = null, cancelled = false, requestedTarget = null;
  function finishChoice(value) { if (choiceResolve) { const resolve = choiceResolve; choiceResolve = null; resolve(value); } }
  cancel.addEventListener('click', () => { cancelled = true; job.cancel(); finishChoice(null); dialog.close(); });
  dialog.addEventListener('cancel', event => { event.preventDefault(); cancel.click(); });
  preserve.addEventListener('click', () => { requestedTarget = 'adx'; finishChoice('adx'); });
  dialog.showModal();
  cancel.focus();
  const summaries = [];
  let current = { records: log, columns, defs }, currentSources = sources;
  try {
    // Resolving a type conflict can expose a further loss (e.g. Intl -> ADI).
    // Re-preflight the approved copy before writing any download.
    for (;;) {
      const plan = await job.start(prepareExportSteps(current.records, current.columns, target, currentSources, current.defs, currentSources.length ? sourceOf : null), { budget: 10 });
      if (cancelled) return false;
      currentSources = [];
      if (plan.groups.length) {
        confirm.textContent = tx('Export with these choices', 'Mit dieser Wahl exportieren');
        const selects = new Map();
        const formRows = plan.groups.map((group, index) => {
          const id = `export-choice-${index}`;
          const select = el('select', { id }, el('option', { value: '' }, tx('Choose explicitly…', 'Ausdrücklich wählen…')), ...group.choices.map(c => el('option', { value: c.value }, c.label)));
          selects.set(group.key, select);
          const sample = group.entries.slice(0, 3).map(e => el('li', {}, `QSO ${e.recordIndex === null ? tx('declaration', 'Deklaration') : e.recordIndex + 1}: ${String(e.before).slice(0, 160)} → ${String(e.after).slice(0, 160)}${e.identity ? tx(` (APP identity ${e.identity.programId} / ${e.identity.fieldName} → ADI name ${e.field})`, ` (APP-Kennung ${e.identity.programId} / ${e.identity.fieldName} → ADI-Name ${e.field})`) : ''}${e.existing !== undefined ? tx(` (existing destination: ${String(e.existing).slice(0, 160)})`, ` (vorhandenes Ziel: ${String(e.existing).slice(0, 160)})`) : ''}`));
          return el('section', {}, el('h3', {}, tx(`${group.field}: ${group.entries.length} affected item(s)`, `${group.field}: ${group.entries.length} betroffene(r) Eintrag/Einträge`)), el('p', {}, group.reason),
            el('ul', {}, ...sample), el('label', { for: id }, tx(`Decision for ${group.field}`, `Entscheidung für ${group.field}`)), select);
        });
        const fullList = el('button', { type: 'button' }, tx('Download complete affected list', 'Vollständige Liste der Betroffenen herunterladen'));
        fullList.addEventListener('click', () => download(JSON.stringify(plan.groups.map(g => ({ field: g.field, reason: g.reason, entries: g.entries })), null, 2), 'application/json', 'adif-export-effects.json'));
        fill(content, el('p', {}, tx('Only the export copy changes. Every unresolved category needs a choice. Cancel to edit individual exceptions in the table. Unsupported transliteration becomes ?.', 'Nur die Export-Kopie ändert sich. Jede offene Kategorie braucht eine Wahl. Abbrechen, um einzelne Ausnahmen in der Tabelle zu bearbeiten. Nicht umschreibbare Zeichen werden zu ?.')), fullList, ...formRows);
        status.textContent = tx(`${plan.groups.length} decision(s) required; no log download has started.`, `${plan.groups.length} Entscheidung(en) nötig; kein Download des Logs gestartet.`);
        confirm.disabled = true; preserve.disabled = false;
        for (const select of selects.values()) select.addEventListener('change', () => { confirm.disabled = [...selects.values()].some(s => !s.value); });
        const approved = await new Promise(resolve => {
          choiceResolve = resolve;
          confirm.onclick = () => finishChoice(Object.fromEntries([...selects].map(([key, select]) => [key, select.value])));
        });
        if (approved === null || cancelled) return false;
        if (approved === 'adx') { target = requestedTarget; preserve.hidden = true; title.textContent = tx('Export ADX', 'ADX exportieren'); current = { records: log, columns, defs }; currentSources = sources; summaries.length = 0; continue; }
        preserve.disabled = true;
        current = await job.start(applyExportChoicesSteps(plan, approved), { budget: 10 });
        summaries.push(...current.summary);
        confirm.disabled = true; status.textContent = tx('Checking the approved export copy…', 'Prüfe die angenommene Export-Kopie…');
        continue;
      }
      current = await job.start(applyExportChoicesSteps(plan, {}), { budget: 10 });
      fill(content, el('p', {}, summaries.length ? summaries.join('; ') : tx('No conversion losses found.', 'Keine Umwandlungsverluste gefunden.')));
      const text = await job.start(target === 'adx' ? serializeADXSteps(current.records, current.columns, undefined, current.defs) : serializeADIFSteps(current.records, current.columns, undefined, current.defs), { budget: 10 });
      const checked = await job.start(target === 'adx' ? validateAdifRecordsSteps(current.records, current.defs, { format: 'adx', lean: true, maxIssues: 100000 }) : validateAdifSteps(text, { lean: true, maxIssues: 100000 }), { budget: 10 });
      if (cancelled) return false;
      // Existing invalid logs remain exportable; preflight reports the selected
      // output's conformance independently from conversion-loss approval.
      if (checked.errors) {
        status.textContent = tx(`Selected ${target.toUpperCase()} export: ${checked.errors} validation error(s), ${checked.warnings} warning(s). Cancel to fix them or explicitly export this invalid log.`, `Gewählter ${target.toUpperCase()}-Export: ${checked.errors} Prüffehler, ${checked.warnings} Warnung(en). Abbrechen, um sie zu beheben, oder dieses ungültige Log ausdrücklich exportieren.`);
        fill(content, el('p', {}, summaries.join('; ')), el('ul', {}, ...checked.issues.filter(i => i.severity === 'error').slice(0, 20).map(i => el('li', {}, `${i.field || tx('file', 'Datei')}: ${i.message}`))));
        confirm.textContent = tx('Export with reported validation errors', 'Mit den gemeldeten Prüffehlern exportieren'); confirm.disabled = false; preserve.disabled = false;
        const approval = await new Promise(resolve => { choiceResolve = resolve; confirm.onclick = () => finishChoice('export'); });
        if (!approval || cancelled) return false;
        if (approval === 'adx') { target = 'adx'; preserve.hidden = true; current = { records: log, columns, defs }; currentSources = sources; summaries.length = 0; continue; }
      }
      dialog.close();
      download(text, target === 'adx' ? ADX_MIME : ADI_MIME, target);
      if (summaries.length || checked.errors || checked.warnings) onMessage(tx(`Exported ${target.toUpperCase()}: ${checked.errors} error(s), ${checked.warnings} warning(s).${summaries.length ? ' Export transformations: ' + summaries.join('; ') : ''}`, `${target.toUpperCase()} exportiert: ${checked.errors} Fehler, ${checked.warnings} Warnung(en).${summaries.length ? ' Umwandlungen im Export: ' + summaries.join('; ') : ''}`));
      return true;
    }
  } catch (error) {
    if (!chunkedIsAbort(error)) {
      status.textContent = tx(`Export stopped: ${error.message}. No log download started; editor data is unchanged.`, `Export abgebrochen: ${error.message}. Kein Download des Logs gestartet; die Daten im Editor sind unverändert.`);
      fill(content); confirm.hidden = true; preserve.hidden = true;
      await new Promise(resolve => { choiceResolve = resolve; });
    }
    return false;
  } finally {
    job.cancel(); dialog.remove(); previousFocus?.focus?.();
  }
}
