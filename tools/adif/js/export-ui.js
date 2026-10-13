import { el, fill } from '../../shared/js/dom.js';
import { ChunkedSlot, chunkedIsAbort } from '../../shared/js/chunked.js';
import { prepareExportSteps, applyExportChoicesSteps } from './conversion.js';
import { serializeADIFSteps, ADI_MIME } from './export.js';
import { serializeADXSteps, ADX_MIME } from './adx.js';
import { validateAdifSteps, validateAdifRecordsSteps } from '../../shared/js/adif-validate.js';

// Native modal dialogs keep background editing disabled and restore focus.
export async function exportLogWithDecisions({ records: log, columns, target, sources, defs, download, onMessage, returnFocus, sourceOf }) {
  const previousFocus = returnFocus || document.activeElement;
  const dialog = el('dialog', { id: 'export-decisions', 'aria-labelledby': 'export-decision-title' });
  const title = el('h2', { id: 'export-decision-title' }, `Export ${target.toUpperCase()}`);
  const status = el('p', { role: 'status' }, 'Checking export…');
  const content = el('div', { class: 'export-decisions-body' });
  const cancel = el('button', { type: 'button' }, 'Cancel');
  const preserve = el('button', { type: 'button', hidden: target === 'adx', disabled: true }, 'Export ADX instead');
  const confirm = el('button', { type: 'button', disabled: true }, 'Export with these choices');
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
        confirm.textContent = 'Export with these choices';
        const selects = new Map();
        const formRows = plan.groups.map((group, index) => {
          const id = `export-choice-${index}`;
          const select = el('select', { id }, el('option', { value: '' }, 'Choose explicitly…'), ...group.choices.map(c => el('option', { value: c.value }, c.label)));
          selects.set(group.key, select);
          const sample = group.entries.slice(0, 3).map(e => el('li', {}, `QSO ${e.recordIndex === null ? 'declaration' : e.recordIndex + 1}: ${String(e.before).slice(0, 160)} → ${String(e.after).slice(0, 160)}${e.identity ? ` (APP identity ${e.identity.programId} / ${e.identity.fieldName} → ADI name ${e.field})` : ''}${e.existing !== undefined ? ` (existing destination: ${String(e.existing).slice(0, 160)})` : ''}`));
          return el('section', {}, el('h3', {}, `${group.field}: ${group.entries.length} affected item(s)`), el('p', {}, group.reason),
            el('ul', {}, ...sample), el('label', { for: id }, `Decision for ${group.field}`), select);
        });
        const fullList = el('button', { type: 'button' }, 'Download complete affected list');
        fullList.addEventListener('click', () => download(JSON.stringify(plan.groups.map(g => ({ field: g.field, reason: g.reason, entries: g.entries })), null, 2), 'application/json', 'adif-export-effects.json'));
        fill(content, el('p', {}, 'Only the export copy changes. Every unresolved category needs a choice. Cancel to edit individual exceptions in the table. Unsupported transliteration becomes ?.'), fullList, ...formRows);
        status.textContent = `${plan.groups.length} decision(s) required; no log download has started.`;
        confirm.disabled = true; preserve.disabled = false;
        for (const select of selects.values()) select.addEventListener('change', () => { confirm.disabled = [...selects.values()].some(s => !s.value); });
        const approved = await new Promise(resolve => {
          choiceResolve = resolve;
          confirm.onclick = () => finishChoice(Object.fromEntries([...selects].map(([key, select]) => [key, select.value])));
        });
        if (approved === null || cancelled) return false;
        if (approved === 'adx') { target = requestedTarget; preserve.hidden = true; title.textContent = 'Export ADX'; current = { records: log, columns, defs }; currentSources = sources; summaries.length = 0; continue; }
        preserve.disabled = true;
        current = await job.start(applyExportChoicesSteps(plan, approved), { budget: 10 });
        summaries.push(...current.summary);
        confirm.disabled = true; status.textContent = 'Checking the approved export copy…';
        continue;
      }
      current = await job.start(applyExportChoicesSteps(plan, {}), { budget: 10 });
      fill(content, el('p', {}, summaries.length ? summaries.join('; ') : 'No conversion losses found.'));
      const text = await job.start(target === 'adx' ? serializeADXSteps(current.records, current.columns, undefined, current.defs) : serializeADIFSteps(current.records, current.columns, undefined, current.defs), { budget: 10 });
      const checked = await job.start(target === 'adx' ? validateAdifRecordsSteps(current.records, current.defs, { format: 'adx', lean: true, maxIssues: 100000 }) : validateAdifSteps(text, { lean: true, maxIssues: 100000 }), { budget: 10 });
      if (cancelled) return false;
      // Existing invalid logs remain exportable; preflight reports the selected
      // output's conformance independently from conversion-loss approval.
      if (checked.errors) {
        status.textContent = `Selected ${target.toUpperCase()} export: ${checked.errors} validation error(s), ${checked.warnings} warning(s). Cancel to fix them or explicitly export this invalid log.`;
        fill(content, el('p', {}, summaries.join('; ')), el('ul', {}, ...checked.issues.filter(i => i.severity === 'error').slice(0, 20).map(i => el('li', {}, `${i.field || 'file'}: ${i.message}`))));
        confirm.textContent = 'Export with reported validation errors'; confirm.disabled = false; preserve.disabled = false;
        const approval = await new Promise(resolve => { choiceResolve = resolve; confirm.onclick = () => finishChoice('export'); });
        if (!approval || cancelled) return false;
        if (approval === 'adx') { target = 'adx'; preserve.hidden = true; current = { records: log, columns, defs }; currentSources = sources; summaries.length = 0; continue; }
      }
      dialog.close();
      download(text, target === 'adx' ? ADX_MIME : ADI_MIME, target);
      if (summaries.length || checked.errors || checked.warnings) onMessage(`Exported ${target.toUpperCase()}: ${checked.errors} error(s), ${checked.warnings} warning(s).${summaries.length ? ' Export transformations: ' + summaries.join('; ') : ''}`);
      return true;
    }
  } catch (error) {
    if (!chunkedIsAbort(error)) {
      status.textContent = `Export stopped: ${error.message}. No log download started; editor data is unchanged.`;
      fill(content); confirm.hidden = true; preserve.hidden = true;
      await new Promise(resolve => { choiceResolve = resolve; });
    }
    return false;
  } finally {
    job.cancel(); dialog.remove(); previousFocus?.focus?.();
  }
}
