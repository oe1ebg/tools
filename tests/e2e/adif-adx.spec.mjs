import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { test, expect, downloadText } from './fixtures.mjs';
import { parseADIF } from '../../tools/shared/js/adif.js';
import { calculateLogStatistics } from '../../tools/adif/js/statistics.js';

const XML_FIXTURE = fileURLToPath(new URL('../fixtures/adif-spec/test-qsos.adx', import.meta.url));
const xml = fields => `<?xml version="1.0" encoding="UTF-8"?><ADX><HEADER><ADIF_VER>3.1.8</ADIF_VER></HEADER><RECORDS><RECORD><CALL>OE1AB</CALL><QSO_DATE>20261012</QSO_DATE><TIME_ON>1200</TIME_ON><BAND>20m</BAND><MODE>SSB</MODE>${fields}</RECORD></RECORDS></ADX>`;
const input = (text, name = 'example.adx') => ({ name, mimeType: 'application/xml', buffer: Buffer.from(text) });
async function loadXml(page, text = xml('<NAME_INTL>Jürgen 😀</NAME_INTL><NOTES>a &lt;EOR&gt; &amp; b&#13;&#10;c</NOTES>')) {
  await page.goto('tools/adif/');
  await page.locator('#file-input').setInputFiles(input(text));
  await expect(page.locator('#stats')).toContainText('1 QSOs');
}
async function approveChoices(page, values) {
  const dialog = page.locator('#export-decisions');
  await expect(dialog).toBeVisible();
  for (const [field, choice] of Object.entries(values)) await dialog.getByLabel(`Decision for ${field}`, { exact: true }).selectOption(choice);
  await dialog.getByRole('button', { name: 'Export with these choices', exact: true }).click();
}

test('ADX preserves Unicode, XML text, edits, and both export formats', { tag: '@adif' }, async ({ page }) => {
  await loadXml(page);
  await expect(page.locator('#file-info')).toContainText('(ADX)');
  await expect(page.locator('td[data-col="NAME_INTL"]')).toContainText('Jürgen 😀');
  await expect(page.locator('#validation-summary')).toContainText('ADIF valid');
  const name = page.locator('td[data-col="NAME_INTL"]');
  await name.fill('Éva 😀'); await name.press('Tab');
  await expect(page.locator('#validation-summary')).toContainText('current log');
  await expect(page.locator('#validation-summary')).toContainText('ADIF valid');
  let download = page.waitForEvent('download');
  await page.locator('#btn-export-adx').click();
  let file = await download;
  expect(file.suggestedFilename()).toBe('example.adx');
  let text = await downloadText(file);
  expect(text).toContain('<NAME_INTL>Éva 😀</NAME_INTL>');
  expect(text).toContain('a &lt;EOR&gt; &amp; b&#13;\nc');
  download = page.waitForEvent('download');
  await page.locator('#btn-export').click();
  await approveChoices(page, { NAME_INTL: 'map-keep' });
  file = await download;
  expect(file.suggestedFilename()).toBe('example.adi');
  const parsed = parseADIF(await downloadText(file));
  expect(parsed[0].NAME).toBe('Eva ??');
  await expect(name).toContainText('Éva 😀'); // only the export copy changes
});

test('cancelling loss decisions preserves data, dirty state and keyboard focus', { tag: '@adif' }, async ({ page }) => {
  await loadXml(page);
  const cell = page.locator('td[data-col="NAME_INTL"]');
  await cell.fill('Änne'); await cell.press('Tab');
  await page.locator('#btn-export').click();
  await expect(page.locator('#export-decisions')).toBeVisible();
  await expect(page.locator('#export-decisions button').filter({ hasText: 'Export with these choices' })).toBeDisabled();
  await page.locator('#export-decisions').press('Escape');
  await expect(page.locator('#export-decisions')).toHaveCount(0);
  await expect(page.locator('#btn-export')).toBeFocused();
  await expect(cell).toContainText('Änne');
  let warned = false;
  page.on('dialog', async dialog => { warned = dialog.type() === 'beforeunload'; await dialog.accept(); });
  await page.reload();
  expect(warned).toBe(true);
});

test('malformed/prohibited XML and unsupported encoding skip only that file', { tag: '@adif' }, async ({ page, browserName, expectConsoleError }) => {
  await loadXml(page, xml(''));
  const invalid = [
    xml('').slice(0, -6),
    '<!DOCTYPE ADX [<!ENTITY x "bad">]>' + xml('').replace(/^<\?xml[^?]+\?>/, ''),
    xml('<NOTES><![CDATA[value]]></NOTES>'),
    xml('<NOTES><VALUE>x</VALUE></NOTES>'),
    '<other><record>hello</record></other>',
    xml('').replace('UTF-8', 'windows-1252'),
  ];
  for (const text of invalid) {
    if (browserName === 'firefox' && text === invalid[0]) expectConsoleError(/^\[JavaScript Error: "XML Parsing Error: no root element found\nLocation: [^\n]+\/adif\/\nLine Number 1, Column \d+:"/);
    await page.locator('#file-input').setInputFiles(input(text, 'bad.adx'));
    await expect(page.locator('#warnings')).toContainText('not loaded');
    await expect(page.locator('#stats')).toContainText('1 QSOs');
  }
  if (browserName === 'firefox') expectConsoleError(/^\[JavaScript Error: "XML Parsing Error: no root element found\nLocation: [^\n]+\/adif\/\nLine Number 1, Column \d+:"/);
  await page.locator('#file-input').setInputFiles([input(invalid[0], 'bad.adx'), input(xml(''), 'valid.adx')]);
  await expect(page.locator('#stats')).toContainText('2 QSOs');
  await expect(page.locator('#warnings')).toContainText('bad.adx: not loaded');
});

test('native ADX mapping handles namespaces, PI, entities, duplicates and limits', { tag: '@adif' }, async ({ page }) => {
  await page.goto('tools/adif/');
  const results = await page.evaluate(async () => {
    const { parseADX } = await import('./js/adx.js');
    const { validateAdifRecords } = await import('../shared/js/adif-validate.js');
    const text = '<?xml version="1.0"?><?example test?><n:ADX xmlns:n="urn:test"><n:HEADER><n:USERDEF FIELDID="1" TYPE="G">TEXT</n:USERDEF></n:HEADER><n:RECORDS><n:RECORD><n:CALL>A</n:CALL><n:CALL>B</n:CALL><n:USERDEF FIELDNAME="TEXT">é&#x1F600;&#13;&#10;&amp;</n:USERDEF><n:APP PROGRAMID="X" FIELDNAME="Y" TYPE="N">3</n:APP></n:RECORD></n:RECORDS></n:ADX>';
    const data = parseADX(text);
    let limited = false;
    try { parseADX(text, { limits: { maxValueChars: 3 } }); } catch (e) { limited = e.code === 'VALUE'; }
    return { parsed: data.parsed, defs: data.defs, syntax: data.syntax, limited,
      valid: validateAdifRecords(data.parsed, data.defs, { format: 'adx' }).valid };
  });
  expect(results.parsed[0]).toEqual({ CALL: 'B', TEXT: 'é😀\r\n&', APP_X_Y: '3' });
  expect(results.defs.userdefs[0].type).toBe('G');
  expect(results.syntax.some(i => i.code === 'DUPLICATE_FIELD')).toBe(true);
  expect(results.limited).toBe(true); expect(results.valid).toBe(true);
});

test('official ADX parses and round-trips every value; equivalent records have equal statistics', { tag: '@adif' }, async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('tools/adif/');
  const source = readFileSync(XML_FIXTURE, 'utf8');
  const output = await page.evaluate(async source => {
    const { parseADX, serializeADX, validateADXRecordsSteps } = await import('./js/adx.js');
    const { adifRunSteps } = await import('../shared/js/adif.js');
    const { calculateLogStatistics } = await import('./js/statistics.js');
    const first = parseADX(source);
    const check = adifRunSteps(validateADXRecordsSteps(first, { today: '20991231' }));
    const columns = [...new Set(first.parsed.flatMap(r => Object.keys(r)))];
    const xml = serializeADX(first.parsed, columns, '2026-10-13T12:00:00Z', first.defs);
    const back = parseADX(xml);
    return { count: first.parsed.length, issues: check.issues.slice(0, 15), equal: first.parsed.every((r, i) => JSON.stringify(Object.entries(r).sort()) === JSON.stringify(Object.entries(back.parsed[i]).sort())),
      stats: calculateLogStatistics(first.parsed, { fileCount: 1 }), xml };
  }, source);
  expect(output.count).toBe(6202); expect(output.issues).toEqual([]); expect(output.equal).toBe(true);
  const adi = parseADIF(readFileSync(new URL('../fixtures/adif-spec/test-qsos.adi', import.meta.url), 'utf8'));
  const stats = calculateLogStatistics(adi, { fileCount: 1 });
  // Intl fields make the field count intentionally format-specific.
  for (const name of ['count', 'calls', 'firstDate', 'lastDate', 'bands', 'modes', 'submodes', 'dxcc', 'completeness']) expect(output.stats[name]).toEqual(stats[name]);
  if (process.env.ADIF_XMLCHECK === 'require') {
    const result = spawnSync(process.env.ADX_PYTHON || '../../.venv/bin/python', ['../../scripts/check_adx_schema.py', 'export'], { input: output.xml, encoding: 'utf8' });
    expect(result.status, result.stderr || result.error?.message).toBe(0);
  }
  await page.locator('#file-input').setInputFiles(XML_FIXTURE);
  await expect(page.locator('#stats')).toContainText('6,202 QSOs');
  await expect(page.locator('#validation-summary')).toContainText('ADIF valid');
  const downloaded = page.waitForEvent('download');
  await page.locator('#btn-export-adx').click();
  const exported = await downloadText(await downloaded);
  expect(exported.match(/<RECORD>/g)).toHaveLength(6202);
  expect(exported).toContain('<STATE>BC</STATE>');
});

test('mixed source definition conflicts require a choice before export', { tag: '@adif' }, async ({ page }) => {
  await page.goto('tools/adif/');
  const a = 'x\n<USERDEF1:1:N>X<EOH><CALL:1>A<X:1>1<EOR>';
  const b = xml('<USERDEF FIELDNAME="X">é</USERDEF>').replace('</HEADER>', '<USERDEF FIELDID="1" TYPE="I">X</USERDEF></HEADER>');
  await page.locator('#file-input').setInputFiles([input(a, 'a.adi'), input(b, 'b.adx')]);
  await expect(page.locator('#stats')).toContainText('2 QSOs');
  await page.locator('#btn-export-adx').click();
  await expect(page.locator('#export-decisions')).toContainText('Custom field declarations conflict');
  const download = page.waitForEvent('download');
  await approveChoices(page, { X: 'text' });
  const text = await downloadText(await download);
  expect(text).toContain('TYPE="G">X</USERDEF>');
  expect(text).toContain('<USERDEF FIELDNAME="X">é</USERDEF>');
  await expect(page.locator('td[data-col="X"]').nth(1)).toHaveText('é');
});

test('typed, representable values round-trip through all four format combinations', { tag: '@adif' }, async ({ page }) => {
  await page.goto('tools/adif/');
  const output = await page.evaluate(async () => {
    const { parseADX, serializeADX } = await import('./js/adx.js');
    const { parseADIF } = await import('../shared/js/adif.js');
    const { serializeADIF } = await import('./js/export.js');
    const source = 'x\n<USERDEF1:11:N>LEVEL,{1:9}<USERDEF2:15:E>CHOICE,{YES,NO}<EOH><CALL:5>OE1AB<LEVEL:1>5<CHOICE:3>YES<APP_X_COUNT:1:N>2<NOTES:9>a <EOR> b<EOR>';
    const defs = {}, records = parseADIF(source, [], '', undefined, undefined, defs);
    const columns = Object.keys(records[0]);
    const generated = serializeADX(records, columns, undefined, defs);
    const results = [];
    for (const from of ['adi', 'adx']) for (const to of ['adi', 'adx']) {
      const firstDefs = {}, first = from === 'adx' ? parseADX(generated) : { parsed: parseADIF(source, [], '', undefined, undefined, firstDefs), defs: firstDefs };
      const text = to === 'adx' ? serializeADX(first.parsed, columns, undefined, first.defs) : serializeADIF(first.parsed, columns, undefined, first.defs);
      const backDefs = {}, back = to === 'adx' ? parseADX(text) : { parsed: parseADIF(text, [], '', undefined, undefined, backDefs), defs: backDefs };
      results.push({ from, to, records: back.parsed, userdefs: back.defs.userdefs.map(u => [u.name, u.type, u.spec]), appType: back.defs.types.APP_X_COUNT });
    }
    return results;
  });
  for (const result of output) {
    expect(result.records[0]).toEqual({ CALL: 'OE1AB', LEVEL: '5', CHOICE: 'YES', APP_X_COUNT: '2', NOTES: 'a <EOR> b' });
    expect(result.userdefs).toEqual([['LEVEL', 'N', 'LEVEL,{1:9}'], ['CHOICE', 'E', 'CHOICE,{YES,NO}']]);
    expect(result.appType).toBe('N');
  }
});

test('ADX limits are checked below/at/above boundaries without partial application', { tag: '@adif' }, async ({ page }) => {
  await page.goto('tools/adif/');
  const result = await page.evaluate(async () => {
    const { parseADX } = await import('./js/adx.js');
    const sample = '<ADX><HEADER/><RECORDS><RECORD><CALL>ABC</CALL><MODE>SSB</MODE></RECORD></RECORDS></ADX>';
    const counts = [];
    for (const limit of [2, 3, 4]) {
      try { counts.push(parseADX(sample, { limits: { maxValueChars: limit } }).parsed.length); }
      catch (e) { counts.push(e.code); }
    }
    const limits = [];
    for (const values of [{ maxFields: 1 }, { maxFields: 2 }, { maxColumns: 1 }, { maxColumns: 2 }, { maxFieldsPerRecord: 1 }, { maxFieldsPerRecord: 2 }, { maxRecords: -1 }, { maxRecords: 1 }]) {
      try { limits.push(parseADX(sample, { limits: values }).parsed.length); } catch (e) { limits.push(e.code); }
    }
    const duplicates = sample.replace('<MODE>SSB</MODE>', '<CALL>ABC</CALL>'.repeat(50));
    const bounded = parseADX(duplicates, { limits: { maxIssues: 5 } });
    return { counts, limits, diagnostics: bounded.syntax.length, totalErrors: bounded.syntaxCounts.error };
  });
  expect(result.counts).toEqual(['VALUE', 1, 1]);
  expect(result.limits).toEqual(['FIELDS_TOTAL', 1, 'COLUMNS', 1, 'FIELDS', 1, 'RECORDS', 1]);
  expect(result.diagnostics).toBe(5); expect(result.totalErrors).toBe(50);
});

test('stylesheet processing instructions are ignored without requesting resources', { tag: '@adif' }, async ({ page }) => {
  await loadXml(page, xml('<NOTES>before<?example ignored?>after</NOTES>').replace('?><ADX>', '?><!-- <?example inside comment?> --><?xml-stylesheet type="text/css" href="https://invalid.example/external.css"?><ADX>'));
  await expect(page.locator('td[data-col="NOTES"]')).toHaveText('beforeafter');
});

test('cancelling a large ADX import leaves the previous log and metadata intact', { tag: '@adif' }, async ({ page }) => {
  await loadXml(page, xml(''));
  const record = '<RECORD><CALL>OE1AB</CALL><QSO_DATE>20260901</QSO_DATE><TIME_ON>1200</TIME_ON><BAND>20m</BAND><MODE>SSB</MODE><NOTES>large import</NOTES></RECORD>';
  const big = '<ADX><HEADER><ADIF_VER>3.1.8</ADIF_VER></HEADER><RECORDS>' + record.repeat(50000) + '</RECORDS></ADX>';
  await page.locator('#file-input').setInputFiles(input(big, 'big.adx'));
  await expect(page.locator('#import-progress')).toBeVisible();
  await page.locator('#btn-cancel-import').click();
  await expect(page.locator('#import-progress')).toBeHidden();
  await expect(page.locator('#warnings')).toContainText('Import cancelled; the log is unchanged.');
  await expect(page.locator('#stats')).toContainText('1 QSOs');
  await expect(page.locator('#file-info')).not.toContainText('big.adx');
});

test('APP components with underscores retain identity and require explicit ADI flattening', { tag: '@adif' }, async ({ page }) => {
  await loadXml(page, xml('<APP PROGRAMID="X_Y" FIELDNAME="Z" TYPE="S">value</APP>'));
  let downloaded = page.waitForEvent('download');
  await page.locator('#btn-export-adx').click();
  expect(await downloadText(await downloaded)).toContain('<APP PROGRAMID="X_Y" FIELDNAME="Z" TYPE="S">value</APP>');
  await page.locator('#btn-export').click();
  await expect(page.locator('#export-decisions')).toContainText('cannot retain the separate PROGRAMID/FIELDNAME boundary');
  downloaded = page.waitForEvent('download');
  await approveChoices(page, { APP_X_Y_Z: 'flatten' });
  expect(await downloadText(await downloaded)).toContain('<APP_X_Y_Z:5:S>value');
});

test('different source APP identities keep independent types and values in combined ADX', { tag: '@adif' }, async ({ page }) => {
  await page.goto('tools/adif/');
  await page.locator('#file-input').setInputFiles([
    input(xml('<APP PROGRAMID="X_Y" FIELDNAME="Z" TYPE="N">3</APP>'), 'one.adx'),
    input(xml('<APP PROGRAMID="X" FIELDNAME="Y_Z" TYPE="S">text</APP>'), 'two.adx'),
  ]);
  await expect(page.locator('#stats')).toContainText('2 QSOs');
  const download = page.waitForEvent('download');
  await page.locator('#btn-export-adx').click();
  const result = await downloadText(await download);
  expect(result).toContain('<APP PROGRAMID="X_Y" FIELDNAME="Z" TYPE="N">3</APP>');
  expect(result).toContain('<APP PROGRAMID="X" FIELDNAME="Y_Z" TYPE="S">text</APP>');
});

test('colliding APP identities within one ADX record remain distinct and survive sorting/export', { tag: '@adif' }, async ({ page }) => {
  const fields = '<APP PROGRAMID="X_Y" FIELDNAME="Z" TYPE="N">3</APP><APP PROGRAMID="X" FIELDNAME="Y_Z" TYPE="S">text</APP>';
  await loadXml(page, xml(fields));
  await page.locator('th[data-col="CALL"] .sortcol').click();
  await expect(page.locator('#validation-summary')).toContainText('ADIF valid');
  await expect(page.locator('td[data-col="APP_X_Y_Z"]')).toHaveText('text');
  await expect(page.locator('td[data-col^="APP_X_Y_Z ["]')).toHaveText('3');
  const download = page.waitForEvent('download');
  await page.locator('#btn-export-adx').click();
  const result = await downloadText(await download);
  expect(result).toContain('<APP PROGRAMID="X_Y" FIELDNAME="Z" TYPE="N">3</APP>');
  expect(result).toContain('<APP PROGRAMID="X" FIELDNAME="Y_Z" TYPE="S">text</APP>');
  await expect(page.locator('td[data-col^="APP_X_Y_Z ["]')).toHaveText('3');
});

test('switching to ADX after earlier conversion decisions restarts from original Unicode data', { tag: '@adif' }, async ({ page }) => {
  await page.goto('tools/adif/');
  const a = 'x\n<USERDEF1:1:N>X<EOH><CALL:1>A<X:1>1<EOR>';
  const b = xml('<USERDEF FIELDNAME="X">é</USERDEF>').replace('</HEADER>', '<USERDEF FIELDID="1" TYPE="I">X</USERDEF></HEADER>');
  await page.locator('#file-input').setInputFiles([input(a, 'a.adi'), input(b, 'b.adx')]);
  await expect(page.locator('#stats')).toContainText('2 QSOs');
  await page.locator('#btn-export').click();
  await approveChoices(page, { X: 'first' });
  await expect(page.locator('#export-decisions')).toContainText('ADI serialization changes');
  await approveChoices(page, { X: 'convert' });
  await expect(page.locator('#export-decisions')).toContainText('Selected ADI export:');
  await page.locator('#export-decisions').getByRole('button', { name: 'Export ADX instead', exact: true }).click();
  const downloaded = page.waitForEvent('download');
  await approveChoices(page, { X: 'text' });
  const result = await downloadText(await downloaded);
  expect(result).toContain('<USERDEF FIELDNAME="X">é</USERDEF>');
  await expect(page.locator('td[data-col="X"]').nth(1)).toHaveText('é');
});

test('empty ADX records/fields and unused declarations survive export; ADI omissions require a choice', { tag: '@adif' }, async ({ page }) => {
  await page.goto('tools/adif/');
  const source = '<ADX><HEADER><ADIF_VER>3.1.8</ADIF_VER><USERDEF FIELDID="1" TYPE="E" ENUM="{A,B}">UNUSED</USERDEF></HEADER><RECORDS><RECORD/><RECORD><NAME/></RECORD></RECORDS></ADX>';
  await page.locator('#file-input').setInputFiles(input(source));
  await expect(page.locator('#stats')).toContainText('2 QSOs');
  let download = page.waitForEvent('download'); await page.locator('#btn-export-adx').click();
  const ax = await downloadText(await download);
  expect(ax.match(/<RECORD>/g)).toHaveLength(2); expect(ax).toContain('<NAME></NAME>'); expect(ax).toContain('>UNUSED</USERDEF>');
  await page.locator('#btn-export').click();
  await expect(page.locator('#export-decisions')).toContainText('cannot restore fieldless ADX records');
  download = page.waitForEvent('download');
  await approveChoices(page, { '(empty records)': 'drop' });
  const adi = await downloadText(await download);
  expect(adi).toContain('<NAME:0>'); expect(adi).toContain('UNUSED,{A,B}');
  expect(parseADIF(adi)).toEqual([{ NAME: '' }]);
  await expect(page.locator('#stats')).toContainText('2 QSOs');
});

test('header-only ADX files retain definitions and can be exported without invented QSOs', { tag: '@adif' }, async ({ page }) => {
  await page.goto('tools/adif/');
  await page.locator('#file-input').setInputFiles(input('<ADX><HEADER><USERDEF FIELDID="1" TYPE="N" RANGE="{0:5}">UNUSED</USERDEF></HEADER><RECORDS/></ADX>'));
  await expect(page.locator('#stats')).toContainText('0 QSOs');
  await expect(page.locator('#stats')).toContainText('1 loaded file');
  const download = page.waitForEvent('download'); await page.locator('#btn-export-adx').click();
  const result = await downloadText(await download);
  expect(result).toContain('RANGE="{0:5}">UNUSED</USERDEF>'); expect(result).not.toContain('<RECORD>');
});
