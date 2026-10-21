// UX and accessibility survey (AGENTS.md, "UX and accessibility"): the main
// views of every tool with the example data (examples/backups/, the
// official ADIF test QSOs, stubbed SOTA alerts), each on desktop light,
// desktop dark and a phone. Per view: axe-core with the WCAG 2.0/2.1/2.2
// A/AA rules, targets under 24x24 px, reflow at 320 px, a keyboard focus
// walk, screenshots. Not a test (it reports, it does not fail): run
// `just a11y-survey` after `just build`; results and screenshots land in
// tests/e2e/a11y-survey/ (git-ignored), a summary on stdout.
import { chromium, devices } from '@playwright/test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('./', import.meta.url));
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const OUT = `${HERE}a11y-survey/`;
const PORT = Number(process.env.SURVEY_PORT || 8017);
const BASE = process.env.BASE_URL ? `${process.env.BASE_URL.replace(/\/$/, '')}/tools/` : `http://127.0.0.1:${PORT}/tools/`;
const EX = `${ROOT}examples/backups/`;
const ADI = `${ROOT}tests/fixtures/adif-spec/test-qsos.adi`;
const AXE = await readFile(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
await mkdir(OUT + 'shots', { recursive: true });

// the built site/, unless BASE_URL points elsewhere
const server = process.env.BASE_URL ? null : spawn('python3', ['serve.py', `${ROOT}site`, String(PORT)], { cwd: HERE, stdio: 'ignore' });
for (let i = 0; i < 50 && !process.env.BASE_URL; i++) {
  try { if ((await fetch(BASE)).ok) break; } catch { /* not yet */ }
  await new Promise(r => setTimeout(r, 200));
}

const TILE = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const TILE_HOSTS = /^https:\/\/([a-c]\.tile\.opentopomap\.org|tile\.openstreetmap\.org|mapsneu\.wien\.gv\.at)\//;
const at = h => new Date(Date.now() + h * 3600_000).toISOString().slice(0, 19);
const ALERTS = [
  { id: 1, dateActivated: at(3), associationCode: 'OE', summitCode: 'WI-001', summitDetails: 'Hermannskogel', frequency: '145.500-fm', comments: 'survey', activatingCallsign: 'OE0QXA/P', activatorName: 'Demo', posterCallsign: 'OE0QXA' },
  { id: 2, dateActivated: at(5), associationCode: 'OE', summitCode: 'WI-002', summitDetails: 'Kahlenberg', frequency: '7.032-cw', comments: '', activatingCallsign: 'OE0QXB', activatorName: '', posterCallsign: 'OE0QXB' },
];

const ready = (page, flag) => page.waitForFunction(f => globalThis[f] === true, flag, { timeout: 30000 });
const settle = page => page.waitForTimeout(500);

// Views: [tool, view, async setup(page) -> leaves the page in that view]
const VIEWS = [
  ['confirm', 'start (4 logs)', async p => { await p.goto(BASE + 'confirm/'); await ready(p, 'CONFIRM_READY'); await p.setInputFiles('#import-file', EX + 'confirm-full.json'); await p.locator('#import-msg').waitFor(); }],
  ['confirm', 'log (check-ins)', async p => { await p.getByText('DEMO · Rundspruch-Bestätigungen 1').first().click(); await p.locator('#log-body tr[data-id]').first().waitFor(); }],
  ['confirm', 'survey log (Probealarm)', async p => { await p.locator('#btn-back').click(); await p.getByText('DEMO · Fiktive Warnmittel-Übung').first().click(); await p.locator('#log-body tr[data-id]').first().waitFor(); }],
  ['notfunk', 'start (operation)', async p => { await p.goto(BASE + 'notfunk/'); await ready(p, 'NOTFUNK_READY'); await p.setInputFiles('#import-file', EX + 'notfunk-full.json'); await p.locator('#import-msg').waitFor(); }],
  ['notfunk', 'message book', async p => { await p.getByRole('button', { name: /öffnen/ }).first().click(); await p.locator('#book-body tr[data-id]').first().waitFor(); }],
  ['netlog', 'sessions & series', async p => {
    await p.goto(BASE + 'netlog/'); await ready(p, 'NETLOG_READY');
    await p.setInputFiles('#import-file', EX + 'netlog-full.json');
    await p.waitForFunction(() => /Importiert|Imported/.test(document.querySelector('#data-msg').textContent));
    await p.locator('#series-list .card-toggle').first().click();
  }],
  ['netlog', 'live notes + history', async p => {
    await p.locator('#series-list button.session-open').first().click(); await p.locator('#view-live').waitFor();
    await p.locator('#roster button.person').nth(2).click();
    if (await p.locator('#btn-history').isEnabled()) await p.locator('#btn-history').click();
  }],
  ['netlog', 'my turn', async p => { await p.keyboard.press('m'); await p.locator('#view-turn').waitFor(); }],
  ['netlog', 'continuous log', async p => { await p.locator('#tab-log').click(); await p.locator('#view-log').waitFor(); }],
  ['netlog', 'net control', async p => { await p.locator('#tab-control').click(); await p.locator('#view-control').waitFor(); }],
  ['netlog', 'search dialog', async p => { await p.locator('#tab-live').click(); await p.keyboard.press('/'); await p.keyboard.type('Antenne'); await p.locator('#search-scope').selectOption('all'); }],
  ['netlog', 'help dialog', async p => { await p.keyboard.press('Escape'); await p.locator('#btn-help').click(); }],
  ['adif', 'start (empty)', async p => { await p.goto(BASE + 'adif/'); await p.locator('#btn-open').waitFor(); }],
  ['adif', 'log loaded (official test QSOs)', async p => { await p.setInputFiles('#file-input', ADI); await p.locator('#stats').filter({ hasText: /QSO/ }).waitFor({ timeout: 30000 }); }],
  ['sota-alerts', 'map with alerts', async p => {
    await p.route(TILE_HOSTS, r => r.fulfill({ contentType: 'image/png', body: TILE }));
    await p.route('https://api2.sota.org.uk/**', r => (new URL(r.request().url()).pathname === '/api/alerts' ? r.fulfill({ json: ALERTS }) : r.fulfill({ status: 404, json: {} })));
    await p.goto(BASE + 'sota-alerts/'); await p.locator('#map.leaflet-container').waitFor();
    await p.locator('#stats').filter({ hasText: /alert|Alert/ }).waitFor({ timeout: 20000 }).catch(() => {});
  }],
];

const CONFIGS = [
  ['desktop-light', { viewport: { width: 1300, height: 900 }, colorScheme: 'light' }],
  ['desktop-dark', { viewport: { width: 1300, height: 900 }, colorScheme: 'dark' }],
  ['phone-light', { ...devices['Pixel 7'], colorScheme: 'light' }],
];

async function audit(page) {
  await page.addScriptTag({ content: AXE });
  const axe = await page.evaluate(async () => {
    const r = await globalThis.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] }, resultTypes: ['violations'] });
    return r.violations.map(v => ({ id: v.id, impact: v.impact, help: v.help, tags: v.tags.filter(t => /^wcag\d/.test(t)), count: v.nodes.length,
      nodes: v.nodes.slice(0, 6).map(n => ({ target: n.target.join(' '), html: n.html.slice(0, 160), summary: (n.failureSummary || '').split('\n').slice(1, 3).join(' ').slice(0, 220) })) }));
  });
  const metrics = await page.evaluate(() => {
    const vis = e => { const b = e.getBoundingClientRect(); const s = getComputedStyle(e); return b.width > 0 && b.height > 0 && s.visibility !== 'hidden' && !e.closest('[hidden]'); };
    const inline = e => e.tagName === 'A' && e.closest('p, li, td, span.hint, small') && (e.parentElement.textContent || '').trim().length > (e.textContent || '').trim().length + 8;
    const small = [];
    for (const e of document.querySelectorAll('button, a[href], input:not([type=hidden]), select, textarea, [role=button], summary')) {
      if (!vis(e) || inline(e)) continue;
      const b = e.getBoundingClientRect();
      if (b.width < 24 || b.height < 24) small.push(`${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}${e.className && typeof e.className === 'string' ? '.' + e.className.split(' ')[0] : ''} "${(e.getAttribute('aria-label') || e.textContent || e.value || '').trim().slice(0, 30)}" ${Math.round(b.width)}×${Math.round(b.height)}`);
    }
    return { scrollW: document.documentElement.scrollWidth, innerW: innerWidth, small: small.slice(0, 40), smallCount: small.length };
  });
  return { axe, metrics };
}

async function focusWalk(page, n = 60) {
  const out = { stops: 0, invisible: [] };
  await page.evaluate(() => { document.activeElement && document.activeElement.blur(); window.scrollTo(0, 0); });
  for (let i = 0; i < n; i++) {
    await page.keyboard.press('Tab');
    const r = await page.evaluate(() => {
      const e = document.activeElement;
      if (!e || e === document.body) return null;
      const s = getComputedStyle(e);
      const visible = (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0) || (s.boxShadow && s.boxShadow !== 'none');
      const b = e.getBoundingClientRect();
      return { name: `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''} "${(e.getAttribute('aria-label') || e.textContent || e.value || '').trim().slice(0, 30)}"`, visible, onScreen: b.bottom > 0 && b.top < innerHeight && b.width > 0 };
    });
    if (!r) continue;
    out.stops++;
    if (!r.visible || !r.onScreen) out.invisible.push(`${r.name}${r.visible ? '' : ' (no focus style)'}${r.onScreen ? '' : ' (off screen)'}`);
  }
  out.invisible = [...new Set(out.invisible)].slice(0, 20);
  return out;
}

const results = [];
const browser = await chromium.launch();
for (const [cfgName, cfg] of CONFIGS) {
  // one context per tool and config: the views of a tool build on each other
  const byTool = {};
  for (const [tool, view, setup] of VIEWS) {
    if (!byTool[tool]) {
      const ctx = await browser.newContext({ ...cfg, locale: 'de-AT', timezoneId: 'Europe/Vienna', bypassCSP: true });
      byTool[tool] = await ctx.newPage();
    }
    const page = byTool[tool];
    const rec = { tool, view, config: cfgName };
    try {
      await setup(page);
      await settle(page);
      const slug = `${tool}-${view.replace(/[^a-z0-9]+/gi, '-')}-${cfgName}`.toLowerCase();
      await page.screenshot({ path: `${OUT}shots/${slug}.png`, fullPage: cfgName !== 'desktop-dark' });
      Object.assign(rec, await audit(page));
      if (cfgName === 'desktop-light') {
        rec.focus = await focusWalk(page);
        // reflow at 320 CSS px
        const vp = page.viewportSize();
        await page.setViewportSize({ width: 320, height: 800 });
        await settle(page);
        rec.reflow320 = await page.evaluate(() => ({ scrollW: document.documentElement.scrollWidth, innerW: innerWidth }));
        await page.screenshot({ path: `${OUT}shots/${slug}-320.png`, fullPage: false });
        await page.setViewportSize(vp);
        await settle(page);
      }
      rec.shot = slug;
    } catch (e) {
      rec.error = String(e.message || e).split('\n')[0];
    }
    results.push(rec);
    console.log(`${cfgName} ${tool} / ${view}: ${rec.error ? 'ERROR ' + rec.error : `${rec.axe.length} axe rules, ${rec.metrics.smallCount} small targets${rec.reflow320 ? `, 320: ${rec.reflow320.scrollW}px` : ''}`}`);
  }
  for (const p of Object.values(byTool)) await p.context().close();
}
await browser.close();
await writeFile(OUT + 'results.json', JSON.stringify(results, null, 1));
if (server) server.kill();

// summary: axe rules per tool, then reflow and small targets per view
const byRule = new Map();
for (const r of results) for (const v of r.axe || []) {
  const k = `${v.id} (${v.impact}; ${v.tags.join(', ')})`;
  if (!byRule.has(k)) byRule.set(k, new Map());
  const t = byRule.get(k);
  t.set(r.tool, Math.max(t.get(r.tool) || 0, v.count));
}
console.log('\n## axe-core: rules with violations (max nodes per view)');
if (!byRule.size) console.log('none');
for (const [k, t] of byRule) console.log(`- ${k}: ${[...t].map(([tool, n]) => `${tool} ${n}`).join(', ')}`);
console.log('\n## per view (desktop light): reflow at 320 px, targets < 24 px, focus problems');
for (const r of results.filter(x => x.config === 'desktop-light')) {
  if (r.error) { console.log(`- ${r.tool} / ${r.view}: ERROR ${r.error}`); continue; }
  console.log(`- ${r.tool} / ${r.view}: ${r.reflow320.scrollW > r.reflow320.innerW ? `overflows (${r.reflow320.scrollW} px)` : 'fits'}, ${r.metrics.smallCount} small targets, ${r.focus.invisible.length} focus problems`);
}
console.log(`\nDetails: ${OUT}results.json, screenshots: ${OUT}shots/`);
