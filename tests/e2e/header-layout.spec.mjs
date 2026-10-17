// The common header (#108 C1, C3): in every tool the way back comes first
// and the help ("? Hilfe" / "? Help") last, at the right of the first
// line; on a phone the help stays on the first line too. ? outside text
// fields opens the help dialog, Esc closes it and the focus goes back.
import { test, expect } from './fixtures.mjs';

const TOOLS = [
  { path: 'tools/confirm/', flag: 'CONFIRM_READY', help: /Hilfe/ },
  { path: 'tools/notfunk/', flag: 'NOTFUNK_READY', help: /Hilfe/ },
  { path: 'tools/netlog/', flag: 'NETLOG_READY', help: /Help|Hilfe/ },
  { path: 'tools/adif/', help: /Help/ },
  { path: 'tools/sota-alerts/', help: /Help/, sota: true },
];

// SOTA: no network in the tests (sota-alerts.spec.mjs stubs the same way)
const TILE = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const TILE_HOSTS = /^https:\/\/([a-c]\.tile\.opentopomap\.org|tile\.openstreetmap\.org|mapsneu\.wien\.gv\.at)\//;

async function open(page, t) {
  if (t.sota) {
    await page.route(TILE_HOSTS, route => route.fulfill({ contentType: 'image/png', body: TILE }));
    await page.route('https://api2.sota.org.uk/**', route => route.fulfill({ json: [] }));
  }
  await page.goto(t.path);
  if (t.flag) await expect.poll(() => page.evaluate(f => globalThis[f] === true, t.flag)).toBe(true);
  await expect(page.locator('#btn-help')).toBeVisible();
}

for (const t of TOOLS) {
  test(`${t.path}: back link first, help last and on the first line; ? opens the help, Esc closes it`, async ({ page }) => {
    await open(page, t);
    const header = page.locator('#site-header');
    const focusable = header.locator('a[href], button:not([hidden])');
    await expect(focusable.first()).toHaveAttribute('id', 'home-link');
    // help: the last control, with a name that starts with its visible text
    const help = page.locator('#btn-help');
    await expect(help).toHaveAccessibleName(t.help);
    const ids = await header.evaluate(h => [...h.querySelectorAll('a[href], button')].filter(n => n.offsetParent).map(n => n.id || n.textContent.trim()));
    expect(ids.at(-1)).toBe('btn-help');
    // at the right end of the header's first line
    const hb = await header.boundingBox();
    const bb = await help.boundingBox();
    const back = await page.locator('#home-link').boundingBox();
    expect(bb.y).toBeLessThan(back.y + back.height);
    expect(hb.x + hb.width - (bb.x + bb.width)).toBeLessThan(40);

    await page.locator('#home-link').focus();
    await page.keyboard.press('?');
    await expect(page.locator('#help-dlg')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#help-dlg')).toBeHidden();
    await expect(page.locator('#home-link')).toBeFocused();
  });
}

// Nothing in the header covers anything else, at any width: chips wrap
// inside their group instead of spilling over their neighbours.
const overlaps = page => page.evaluate(() => {
  const items = [...document.querySelectorAll('#site-header a, #site-header button, #site-header .chip, #site-header .toggle, #site-header .clock, #site-header .title, #site-header .hdr-note')]
    // a toggle counts as one item, not its buttons
    .filter(n => n.offsetParent && !n.parentElement.closest('.toggle'))
    .map(n => ({ id: n.id || n.className || n.textContent.trim().slice(0, 20), r: n.getBoundingClientRect() }));
  const hit = [];
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    const a = items[i].r, b = items[j].r;
    if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) hit.push(`${items[i].id} × ${items[j].id}`);
  }
  return hit;
});

for (const t of TOOLS) {
  test(`${t.path}: header items never overlap (1280, 900, 700 px)`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name.startsWith('mobile'), 'desktop widths');
    // one load (a reload while the service worker installs makes WebKit log
    // an error), then the widths
    await page.setViewportSize({ width: 1280, height: 800 });
    await open(page, t);
    // the longest status texts: the update button and its waiting text
    await page.evaluate(() => {
      const u = document.querySelector('#btn-update');
      if (u) { u.hidden = false; u.textContent = 'Update wartet: Eingabe klären'; }
    });
    for (const width of [1280, 900, 700]) {
      await page.setViewportSize({ width, height: 800 });
      expect(await overlaps(page), `${width} px`).toEqual([]);
    }
  });
}
