import { el, fill } from '../../shared/js/dom.js';
import { ChunkedSlot, chunkedIsAbort } from '../../shared/js/chunked.js';
import { logStatisticsSteps } from './statistics.js';
import { ADIF_SPEC_ENUMS } from '../../shared/js/adif-spec-data.js';

function lsDisplayDate(date) { return date ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}` : ''; }
function lsCount(n) { return n.toLocaleString('en-US'); }

export function initLogStatistics(read) {
  const overview = document.getElementById('stats');
  const panel = document.getElementById('log-statistics');
  const scope = document.getElementById('statistics-scope');
  const content = document.getElementById('statistics-body');
  const slot = new ChunkedSlot();
  let version = 0;
  async function update() {
    const seq = ++version;
    const { records: log, view: indices, fileCount } = read();
    slot.cancel();
    try {
      const whole = await slot.start(logStatisticsSteps(log, { fileCount, details: panel.open && scope.value === 'whole' }), { budget: 10 });
      if (seq !== version) return;
      const date = whole.firstDate ? `${lsDisplayDate(whole.firstDate)}–${lsDisplayDate(whole.lastDate)}` : 'no valid QSO dates';
      const items = [`${lsCount(whole.count)} QSOs`, `${lsCount(fileCount)} loaded file${fileCount === 1 ? '' : 's'}`, date,
        `${lsCount(whole.calls)} reported callsigns`, `${whole.bandCount} bands`, `${whole.modeCount} modes`];
      fill(overview, el('strong', {}, 'Whole log: '), ...items.map(text => el('span', { class: 'statistics-item' }, text)));
      if (!panel.open) return;
      const stats = scope.value === 'shown' ? await slot.start(logStatisticsSteps(log, { indices, fileCount }), { budget: 10 }) : whole;
      if (seq !== version) return;
      const distribution = (title, rows, labels = {}) => el('section', {}, el('h2', {}, title),
        rows.length ? el('table', { class: 'statistics-table' },
          el('thead', {}, el('tr', {}, ...['Value', 'QSOs', '%'].map(t => el('th', { scope: 'col' }, t)))),
          el('tbody', {}, ...rows.map(row => el('tr', {}, el('th', { scope: 'row' }, labels[row.value] ? `${row.value} — ${labels[row.value]}` : row.value), el('td', {}, lsCount(row.count)), el('td', {}, `${row.percent.toFixed(1)}%`))))) : el('p', {}, 'No QSOs.'));
      fill(content,
        el('p', {}, `${scope.value === 'shown' ? 'Shown QSOs' : 'Whole log'}: ${lsCount(stats.count)} QSOs · ${stats.fieldCount} populated fields · ${stats.dxccCount} DXCC entities · ${stats.missingCalls} missing callsigns.`),
        el('p', { class: 'hint' }, 'Percentages use all QSOs in this scope, including missing/invalid values; rounded to one decimal. Submodes retain reported MODE context; unrecognized submodes can be valid ADIF strings. DXCC 0 means no entity. Callsigns are reported calls, including portable suffixes. Files count loaded sources, including empty files.'),
        distribution('Bands', stats.bands), distribution('Modes', stats.modes), distribution('Submodes by reported MODE', stats.submodes),
        distribution('DXCC', stats.dxcc, ADIF_SPEC_ENUMS.DXCC_Entity_Code.labels),
        el('section', {}, el('h2', {}, 'Completeness'), el('p', { class: 'hint' }, 'Missing and invalid-present values are separate. BAND/FREQ is missing only when both are absent. Dates use QSO_DATE only. These counts do not add validation errors.'),
          el('table', { class: 'statistics-table' }, el('thead', {}, el('tr', {}, ...['Field', 'Missing', 'Invalid present'].map(t => el('th', { scope: 'col' }, t)))),
            el('tbody', {}, ...Object.entries(stats.completeness).map(([name, counts]) => el('tr', {}, el('th', { scope: 'row' }, name), el('td', {}, lsCount(counts.missing)), el('td', {}, lsCount(counts.invalid))))))));
    } catch (error) { if (!chunkedIsAbort(error)) throw error; }
  }
  panel.addEventListener('toggle', () => update());
  scope.addEventListener('change', () => update());
  return { update };
}
