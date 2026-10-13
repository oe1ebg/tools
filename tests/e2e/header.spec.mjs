// The header bar keeps its height while the offline chip changes on the first
// visit ("offline: prüfe…", "offline: lädt…", "offline bereit ✓"): the page
// can already be used then, and a bar that wraps for a moment moves it under
// the pointer, so a click lands elsewhere (#36). Every frame until the offline
// chip has settled, in every project (desktop and phone widths); compared are
// the frames with the storage chip's final text, which decides the wrapping
// (it arrives shortly after the start; headless Firefox never answers it).
import { test, expect, offlineSettled } from './fixtures.mjs';

const TOOLS = {
  confirm: 'tools/confirm/',
  notfunk: 'tools/notfunk/',
};

for (const [tool, path] of Object.entries(TOOLS)) {
  test(`${tool}: the header keeps its height while the offline chip changes`, async ({ page }) => {
    await page.addInitScript(() => {
      const frames = globalThis.__headerFrames = [];
      const frame = () => {
        const h = document.querySelector('#site-header');
        if (h) {
          const px = Math.round(h.getBoundingClientRect().height);
          const offline = document.querySelector('#st-offline')?.textContent;
          const storage = document.querySelector('#st-storage')?.textContent;
          const last = frames.at(-1);
          if (last?.px !== px || last?.offline !== offline || last?.storage !== storage) frames.push({ px, offline, storage, t: Math.round(performance.now()) });
        }
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
    await page.goto(path);
    await offlineSettled(page);
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    const frames = await page.evaluate(() => globalThis.__headerFrames);
    const storage = await page.locator('#st-storage').textContent();
    const compared = frames.filter(f => f.storage === storage);
    expect(compared.map(f => f.offline), JSON.stringify(frames)).toContain(await page.locator('#st-offline').textContent());
    expect(new Set(compared.map(f => f.px)).size, JSON.stringify(frames)).toBe(1);
  });
}
