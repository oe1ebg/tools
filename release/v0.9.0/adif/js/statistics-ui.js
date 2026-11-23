import { el, fill } from '../../shared/js/dom.js';
import { ChunkedSlot, chunkedIsAbort } from '../../shared/js/chunked.js';
import { logStatisticsSteps } from './statistics.js';
import { ADIF_SPEC_ENUMS } from '../../shared/js/adif-spec-data.js';
import { tx } from '../../shared/js/i18n.js';

function lsDisplayDate(date) { return date ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}` : ''; }
// 6,202 / 6.202 and 12.3% / 12,3 % (no locale formatting: the same everywhere)
function lsCount(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, tx(',', '.')); }
// the statistics' own buckets ((missing), (invalid): FT2, …) are data keys: shown translated
function lsBucket(v) {
  const words = { '(missing)': tx('(missing)', '(fehlt)'), '(invalid)': tx('(invalid)', '(ungültig)'), '(unrecognized)': tx('(unrecognized)', '(unbekannt)') };
  return String(v).replace(/^\((missing|invalid|unrecognized)\)/, m => words[m]);
}
function lsPercent(p) { return tx(`${p.toFixed(1)}%`, `${p.toFixed(1).replace('.', ',')} %`); }

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
      const date = whole.firstDate ? `${lsDisplayDate(whole.firstDate)}–${lsDisplayDate(whole.lastDate)}` : tx('no valid QSO dates', 'keine gültigen QSO-Daten');
      const items = [`${lsCount(whole.count)} QSOs`, tx(`${lsCount(fileCount)} loaded file${fileCount === 1 ? '' : 's'}`, `${lsCount(fileCount)} geladene Datei${fileCount === 1 ? '' : 'en'}`), date,
        tx(`${lsCount(whole.calls)} reported callsigns`, `${lsCount(whole.calls)} gemeldete Rufzeichen`), tx(`${whole.bandCount} bands`, `${whole.bandCount} Bänder`), tx(`${whole.modeCount} modes`, `${whole.modeCount} Modes`)];
      fill(overview, el('strong', {}, tx('Whole log: ', 'Ganzes Log: ')), ...items.map(text => el('span', { class: 'statistics-item' }, text)));
      if (!panel.open) return;
      const stats = scope.value === 'shown' ? await slot.start(logStatisticsSteps(log, { indices, fileCount }), { budget: 10 }) : whole;
      if (seq !== version) return;
      const distribution = (title, rows, labels = {}) => el('section', {}, el('h2', {}, title),
        rows.length ? el('table', { class: 'statistics-table' },
          el('thead', {}, el('tr', {}, ...[tx('Value', 'Wert'), 'QSOs', '%'].map(t => el('th', { scope: 'col' }, t)))),
          el('tbody', {}, ...rows.map(row => el('tr', {}, el('th', { scope: 'row' }, labels[row.value] ? `${row.value} — ${labels[row.value]}` : lsBucket(row.value)), el('td', {}, lsCount(row.count)), el('td', {}, lsPercent(row.percent)))))) : el('p', {}, tx('No QSOs.', 'Keine QSOs.')));
      fill(content,
        el('p', {}, tx(`${scope.value === 'shown' ? 'Shown QSOs' : 'Whole log'}: ${lsCount(stats.count)} QSOs · ${stats.fieldCount} populated fields · ${stats.dxccCount} DXCC entities · ${stats.missingCalls} missing callsigns.`,
          `${scope.value === 'shown' ? 'Angezeigte QSOs' : 'Ganzes Log'}: ${lsCount(stats.count)} QSOs · ${stats.fieldCount} befüllte Felder · ${stats.dxccCount} DXCC-Gebiete · ${stats.missingCalls} fehlende Rufzeichen.`)),
        el('p', { class: 'hint' }, tx('Percentages use all QSOs in this scope, including missing/invalid values; rounded to one decimal. Submodes retain reported MODE context; unrecognized submodes can be valid ADIF strings. DXCC 0 means no entity. Callsigns are reported calls, including portable suffixes. Files count loaded sources, including empty files.',
          'Prozente beziehen sich auf alle QSOs dieses Bereichs, auch mit fehlenden oder ungültigen Werten; auf eine Dezimalstelle gerundet. Submodes stehen beim gemeldeten MODE; unbekannte Submodes können gültige ADIF-Texte sein. DXCC 0 heißt: kein Gebiet. Rufzeichen sind die gemeldeten, mit Portabel-Zusätzen. Dateien zählen die geladenen Quellen, auch leere.')),
        distribution(tx('Bands', 'Bänder'), stats.bands), distribution(tx('Modes', 'Modes'), stats.modes), distribution(tx('Submodes by reported MODE', 'Submodes nach gemeldetem MODE'), stats.submodes),
        distribution('DXCC', stats.dxcc, ADIF_SPEC_ENUMS.DXCC_Entity_Code.labels),
        el('section', {}, el('h2', {}, tx('Completeness', 'Vollständigkeit')), el('p', { class: 'hint' }, tx('Missing and invalid-present values are separate. BAND/FREQ is missing only when both are absent. Dates use QSO_DATE only. These counts do not add validation errors.',
          'Fehlende und vorhandene, aber ungültige Werte werden getrennt gezählt. BAND/FREQ fehlt nur, wenn beide fehlen. Daten nur aus QSO_DATE. Diese Zahlen ergeben keine zusätzlichen Prüffehler.')),
          el('table', { class: 'statistics-table' }, el('thead', {}, el('tr', {}, ...[tx('Field', 'Feld'), tx('Missing', 'Fehlt'), tx('Invalid present', 'Ungültig vorhanden')].map(t => el('th', { scope: 'col' }, t)))),
            el('tbody', {}, ...Object.entries(stats.completeness).map(([name, counts]) => el('tr', {}, el('th', { scope: 'row' }, name), el('td', {}, lsCount(counts.missing)), el('td', {}, lsCount(counts.invalid))))))));
    } catch (error) { if (!chunkedIsAbort(error)) throw error; }
  }
  panel.addEventListener('toggle', () => update());
  scope.addEventListener('change', () => update());
  return { update };
}
