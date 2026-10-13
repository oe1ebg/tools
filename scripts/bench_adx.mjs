// Served-independent import/edit/export benchmark of built file:// ADIF bundles.
// node scripts/bench_adx.mjs --engine chromium,firefox,webkit --runs 5 --out FILE
// --bundle PATH and --adi-only measure an older ADI-only bundle as baseline.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, firefox, webkit } from '../tests/e2e/node_modules/playwright/index.mjs';
const args = process.argv.slice(2);
const option = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
const engines = option('--engine', 'chromium').split(',');
const runs = Number(option('--runs', '5'));
const bundle = pathToFileURL(resolve(option('--bundle', 'tools/adif/adif-editor.html'))).href;
const adiOnly = args.includes('--adi-only');
const officialADI = readFileSync('tests/fixtures/adif-spec/test-qsos.adi');
const officialADX = readFileSync('tests/fixtures/adif-spec/test-qsos.adx');
const largeADI = Buffer.from('x\n<ADIF_VER:5>3.1.8<EOH>\n' + Array.from({ length: 50000 }, (_, i) => {
  const call = 'OE' + i;
  return `<CALL:${call.length}>${call}<QSO_DATE:8>20260901<TIME_ON:4>1200<BAND:3>20m<MODE:3>SSB<FREQ:4>14.2<DXCC:3>206<EOR>\n`;
}).join(''));
const largeADX = Buffer.from('<?xml version="1.0" encoding="UTF-8"?><ADX><HEADER><ADIF_VER>3.1.8</ADIF_VER></HEADER><RECORDS>' + Array.from({ length: 50000 }, (_, i) => `<RECORD><CALL>OE${i}</CALL><QSO_DATE>20260901</QSO_DATE><TIME_ON>1200</TIME_ON><BAND>20m</BAND><MODE>SSB</MODE><FREQ>14.2</FREQ><DXCC>206</DXCC></RECORD>`).join('') + '</RECORDS></ADX>');
const workloads = [['official', 'adi', officialADI, 6202], ['50k', 'adi', largeADI, 50000], ...adiOnly ? [] : [['official', 'adx', officialADX, 6202], ['50k', 'adx', largeADX, 50000]]];
function rssOfTree(rootPid) {
  const result = spawnSync('ps', ['-axo', 'pid=,ppid=,rss='], { encoding: 'utf8' });
  if (result.status !== 0) return null;
  const rows = result.stdout.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
  const pids = new Set([rootPid]);
  for (;;) { const before = pids.size; for (const [pid, parent] of rows) if (pids.has(parent)) pids.add(pid); if (pids.size === before) break; }
  return rows.filter(([pid]) => pids.has(pid)).reduce((sum, row) => sum + row[2], 0) * 1024;
}
const results = { bundleSHA256: createHash('sha256').update(readFileSync(new URL(bundle))).digest('hex'), node: process.version, platform: process.platform, bundle, runs, memory: 'sum of RSS of the owned browser process tree, sampled every 100 ms; shared pages may be double-counted and OS-reparented helpers may be omitted; approximate sampled peak', samples: [] };
for (const engine of engines) {
  const server = await ({ chromium, firefox, webkit })[engine].launchServer();
  const browser = await ({ chromium, firefox, webkit })[engine].connect(server.wsEndpoint());
  try {
    for (const [label, format, buffer, count] of workloads) for (let run = 0; run < runs; run++) {
      const context = await browser.newContext({ acceptDownloads: true });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
      await page.route('**/*', route => route.request().url().startsWith('file:') ? route.continue() : route.abort());
      await page.goto(bundle);
      let peakRSS = rssOfTree(server.process().pid);
      const timer = setInterval(() => { const rss = rssOfTree(server.process().pid); if (rss !== null) peakRSS = Math.max(peakRSS || 0, rss); }, 100);
      await page.evaluate(() => {
        window.adxBenchLag = { max: 0, last: performance.now() };
        window.adxBenchTimer = setInterval(() => { const now = performance.now(); window.adxBenchLag.max = Math.max(window.adxBenchLag.max, now - window.adxBenchLag.last - 20); window.adxBenchLag.last = now; }, 20);
        return true;
      });
      try {
        let start = performance.now();
        await page.locator('#file-input').setInputFiles({ name: `${label}.${format}`, mimeType: 'application/octet-stream', buffer });
        await page.waitForFunction(() => document.querySelector('#drop tbody tr[data-ri]') && document.querySelector('#import-progress')?.hidden && !document.querySelector('#validation').classList.contains('is-checking'), null, { timeout: 120000 });
        await page.waitForFunction(expected => document.querySelector('#stats').textContent.replace(/,/g, '').includes(expected + ' QSOs'), count, { timeout: 120000 });
        const importMs = performance.now() - start;
        const cell = page.locator('td[data-col="CALL"]').first();
        await cell.fill('OE1BENCH');
        start = performance.now(); await cell.press('Tab');
        await page.waitForFunction(() => document.querySelector('#validation-summary').textContent.includes('current log') && !document.querySelector('#validation').classList.contains('is-checking'), null, { timeout: 120000 });
        const editMs = performance.now() - start;
        start = performance.now(); const download = page.waitForEvent('download', { timeout: 120000 });
        await page.locator(format === 'adx' ? '#btn-export-adx' : '#btn-export').click();
        await download;
        const exportMs = performance.now() - start;
        const maxLagMs = await page.evaluate(() => { clearInterval(window.adxBenchTimer); return window.adxBenchLag.max; });
        if (errors.length) throw new Error(errors.join('\n'));
        const sample = { engine, label, format, run, bytes: buffer.length, count, importMs, editMs, exportMs, maxLagMs, peakRSS };
        results.samples.push(sample); console.log(JSON.stringify(sample));
      } finally { clearInterval(timer); await context.close(); }
    }
  } finally { await browser.close(); await server.close(); }
}
writeFileSync(option('--out', '/private/tmp/adx-benchmark.json'), JSON.stringify(results, null, 2) + '\n');
