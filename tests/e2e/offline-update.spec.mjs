// Service worker installation and updates (issue #13), for both offline
// tools. Chromium only, like the other service worker tests. The tools'
// precache.js is replaced through context.route(), which also intercepts
// the worker's own importScripts().
//   - a broken or missing manifest fails the install (first install: not
//     "ready", nothing cached; later: the working installation stays),
//   - development mode is only the explicit stub,
//   - a failed update check is shown,
//   - a failed draft save holds the update/reload back (local click, update
//     from another tab), keeps the input, and "Erneut versuchen" /
//     "Trotzdem aktualisieren" go on.
import { test, expect } from './fixtures.mjs';

const TOOLS = {
  confirm: {
    path: 'tools/confirm/',
    ready: () => globalThis.CONFIRM_READY === true,
    input: '#f-call',
    // start typing something that has to survive an update
    async typeInput(page) {
      await page.getByRole('button', { name: '+ Neues Log' }).click();
      await page.locator('#new-event input[name="title"]').fill('E2E Update');
      await page.getByRole('button', { name: /Log anlegen/ }).click();
      await expect(page.locator('#view-log')).toBeVisible();
      await page.locator('#f-call').fill('OE1ABC');
    },
  },
  notfunk: {
    path: 'tools/notfunk/',
    ready: () => globalThis.NOTFUNK_READY === true,
    input: '#m-text',
    async typeInput(page) {
      await page.getByRole('button', { name: '+ Neuer Einsatz' }).click();
      await page.locator('#n-name').fill('E2E Update');
      await page.locator('#n-prefix').fill('u1');
      await page.locator('#n-operator').fill('oe1ebg');
      await page.getByRole('button', { name: 'Einsatz anlegen' }).click();
      await expect(page.locator('#view-book')).toBeVisible();
      await page.locator('#m-text').fill('Halb getippte Meldung');
    },
  },
};

const GARBAGE = 'self.X_PRECACHE = {';
const scriptJs = body => ({ status: 200, contentType: 'text/javascript', body });

// The same files with another version: it installs, but to the browser it is
// a new version (update available).
async function serveNewVersion(context, tool) {
  await context.route(`**/tools/${tool}/precache.js`, async route => {
    const res = await route.fetch();
    const body = (await res.text()).replace(/version: "([^"]+)"/, 'version: "$1x"');
    await route.fulfill({ response: res, body });
  });
}

// Chromium does not route the browser's own update check (reg.update()) through
// Playwright, but a registration of another script URL for the same scope is
// an update to the page in every way (updatefound, waiting worker): the tests
// use that to bring a new version, a broken one or none.
const registerVersion = (page, name) => page.evaluate(n => navigator.serviceWorker.register(`sw.js?${n}`).then(() => {}, () => {}), name);

const swInfo = (page, tool) => page.evaluate(async tool => {
  const reg = await navigator.serviceWorker.getRegistration();
  return {
    active: reg?.active?.state ?? null,
    waiting: !!reg?.waiting,
    controller: !!navigator.serviceWorker.controller,
    caches: (await caches.keys()).filter(k => k.startsWith(`tools-${tool}-`)).sort(),
  };
}, tool);

async function openReady(page, tool) {
  await page.goto(TOOLS[tool].path);
  await expect(page.locator('#st-offline')).toHaveText('offline bereit ✓', { timeout: 45_000 });
  await expect.poll(() => page.evaluate(TOOLS[tool].ready)).toBe(true);
}

// A new version is waiting (and its button shown) in this page.
async function stageUpdate(page, context, tool) {
  await serveNewVersion(context, tool);
  await registerVersion(page, 'v2');
  await expect(page.locator('#btn-update')).toBeVisible({ timeout: 30_000 });
}

// IndexedDB transactions fail from now on (quota, a blocked database): the
// apps cannot save their drafts. restoreStorage() repairs it.
// It then types one more character (X), so a draft is always waiting to be saved
// (the debounce may already have stored what was typed before).
async function breakStorage(page, tool) {
  await page.evaluate(() => {
    globalThis.__tx = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function () { throw new DOMException('quota', 'QuotaExceededError'); };
  });
  const input = page.locator(TOOLS[tool].input);
  await input.fill(`${await input.inputValue()}X`);
  return input.inputValue();
}
const restoreStorage = page => page.evaluate(() => { IDBDatabase.prototype.transaction = globalThis.__tx; });
const marker = page => page.evaluate(() => globalThis.__marker).catch(() => undefined); // a navigation destroys the context
// The apps log the failed save as console.error: that is what these tests
// provoke, so it is not a problem of the page.
const expectSaveErrors = problems => {
  for (let i = problems.length - 1; i >= 0; i--) if (/QuotaExceededError: quota/.test(problems[i])) problems.splice(i, 1);
};

for (const tool of Object.keys(TOOLS)) {
  test.describe(`${tool}: service worker`, () => {
    test.skip(({ browserName }) => browserName !== 'chromium', 'service workers: Chromium only');

    test('a broken manifest fails the first install: not "ready", nothing cached', async ({ page, context }) => {
      await context.route(`**/tools/${tool}/precache.js`, route => route.fulfill(scriptJs(GARBAGE)));
      await page.goto(TOOLS[tool].path);
      await expect(page.locator('#st-offline')).toHaveText('Offline-Einrichtung fehlgeschlagen', { timeout: 30_000 });
      await expect(page.locator('#st-offline')).toHaveClass(/err/);
      expect(await swInfo(page, tool)).toEqual({ active: null, waiting: false, controller: false, caches: [] });
    });

    test('a missing manifest (404) is no development mode either', async ({ page, context }) => {
      await context.route(`**/tools/${tool}/precache.js`, route => route.fulfill({ status: 404, body: 'nope' }));
      await page.goto(TOOLS[tool].path);
      await expect(page.locator('#st-offline')).toHaveText('Offline-Einrichtung fehlgeschlagen', { timeout: 30_000 });
      expect((await swInfo(page, tool)).caches).toEqual([]);
    });

    test('the explicit development stub is reported as development', async ({ page, context }) => {
      await context.route(`**/tools/${tool}/precache.js`, route => route.fulfill(scriptJs(`self.${tool.toUpperCase()}_PRECACHE = { dev: true };`)));
      await page.goto(TOOLS[tool].path);
      await expect(page.locator('#st-offline')).toHaveText('Entwicklungsmodus (nicht offline)', { timeout: 30_000 });
      await expect(page.locator('#st-offline')).toHaveClass(/warn/);
    });

    test('a broken new version cannot replace the working installation', async ({ page, context }) => {
      await openReady(page, tool);
      const before = await swInfo(page, tool);
      await context.route(`**/tools/${tool}/precache.js`, route => route.fulfill(scriptJs(GARBAGE)));
      await registerVersion(page, 'broken');
      await expect(page.locator('#st-update')).toHaveText('Update fehlgeschlagen');
      expect(await swInfo(page, tool)).toEqual(before);
      await expect(page.locator('#st-offline')).toHaveText('offline bereit ✓');
      await expect(page.locator('#btn-update')).toBeHidden();
      // the cache still serves the tool with the network cut
      await context.setOffline(true);
      await page.reload();
      await expect(page.locator('#st-offline')).toHaveText('offline bereit ✓', { timeout: 20_000 });
      await context.setOffline(false);
    });

    test('a failed update check is shown, not silent', async ({ page, context }) => {
      await openReady(page, tool);
      // the update check itself fails (server down, bad response)
      await page.evaluate(() => { ServiceWorkerRegistration.prototype.update = () => Promise.reject(new TypeError('Failed to update a ServiceWorker')); });
      // the page checks at most once a minute: move its clock past that
      await page.evaluate(() => {
        const real = Date.now;
        Date.now = () => real() + 120e3;
        window.dispatchEvent(new Event('online'));
      });
      await expect(page.locator('#st-update')).toHaveText('Update-Prüfung fehlgeschlagen');
      await expect(page.locator('#st-offline')).toHaveText('offline bereit ✓');
    });

    test('a failed draft save holds the update back, keeps the input, and a retry updates', async ({ page, context, problems }) => {
      await openReady(page, tool);
      await TOOLS[tool].typeInput(page);
      const input = page.locator(TOOLS[tool].input);
      await stageUpdate(page, context, tool);
      const oldController = await page.evaluate(() => navigator.serviceWorker.controller.scriptURL);
      await page.evaluate(() => { globalThis.__marker = 'same page'; });

      const typed = await breakStorage(page, tool);
      await page.locator('#btn-update').click();
      await expect(page.locator('#update-problem')).toContainText('Update nicht ausgeführt');
      // nothing happened: same page, input kept, new worker still waiting, old cache in use
      expect(await marker(page)).toBe('same page');
      await expect(input).toHaveValue(typed);
      const held = await swInfo(page, tool);
      expect(held.waiting).toBe(true);
      expect(held.caches.length).toBe(2);
      expect(oldController).not.toContain('sw.js?v2');
      expect(await page.evaluate(() => navigator.serviceWorker.controller.scriptURL)).toBe(oldController);

      // storage works again: the retry saves the draft, then the update goes through
      await restoreStorage(page);
      await page.locator('#btn-update-retry').click();
      await expect.poll(() => marker(page), { timeout: 30_000 }).toBeUndefined(); // reloaded
      await expect(page.locator('#st-offline')).toHaveText('offline bereit ✓', { timeout: 30_000 });
      expect(await page.evaluate(() => navigator.serviceWorker.controller.scriptURL)).toContain('sw.js?v2');
      // the half-typed input came back from the saved draft
      await expect.poll(() => page.evaluate(TOOLS[tool].ready)).toBe(true);
      await expect(page.locator(TOOLS[tool].input)).toHaveValue(typed);
      expectSaveErrors(problems);
    });

    test('"Trotzdem aktualisieren" is the explicit way past a failing save', async ({ page, context, problems }) => {
      await openReady(page, tool);
      await TOOLS[tool].typeInput(page);
      await stageUpdate(page, context, tool);
      await breakStorage(page, tool);
      await page.evaluate(() => { globalThis.__marker = 'same page'; });
      await page.locator('#btn-update').click();
      await expect(page.locator('#update-problem')).toBeVisible();
      page.once('dialog', d => d.dismiss());
      await page.locator('#btn-update-anyway').click();
      await expect(page.locator('#update-problem')).toBeVisible();
      expect(await marker(page)).toBe('same page');
      page.once('dialog', d => d.accept());
      await page.locator('#btn-update-anyway').click();
      await expect.poll(() => marker(page), { timeout: 30_000 }).toBeUndefined();
      expectSaveErrors(problems);
    });

    test('an update from another tab: the tab with an unsaved draft is not reloaded', async ({ page, context, problems }) => {
      await openReady(page, tool);
      await TOOLS[tool].typeInput(page);
      const input = page.locator(TOOLS[tool].input);
      await stageUpdate(page, context, tool);
      await page.evaluate(() => { globalThis.__marker = 'same page'; });
      const typed = await breakStorage(page, tool);

      // a second tab (list view, nothing to save) takes the update
      const other = await context.newPage();
      await other.goto(TOOLS[tool].path);
      await expect(other.locator('#btn-update')).toBeVisible({ timeout: 30_000 });
      await other.evaluate(() => { globalThis.__marker = 'other'; });
      await other.locator('#btn-update').click();
      await expect.poll(() => marker(other), { timeout: 30_000 }).toBeUndefined();

      // this tab saw the controller change but could not save: it stays
      await expect(page.locator('#update-problem')).toContainText('Neuladen nicht ausgeführt', { timeout: 15_000 });
      // it says that this page runs old code under the new worker
      await expect(page.locator('#update-problem')).toContainText('alten Version');
      expect(await marker(page)).toBe('same page');
      await expect(input).toHaveValue(typed);
      await restoreStorage(page);
      await page.locator('#btn-update-retry').click();
      await expect.poll(() => marker(page), { timeout: 30_000 }).toBeUndefined();
      expectSaveErrors(problems);
    });

    test('a waiting version replaced by a newer install, or a failed newer one, is no "Update fehlgeschlagen"', async ({ page, context }) => {
      await openReady(page, tool);
      await stageUpdate(page, context, tool);
      // v3 supersedes the waiting v2 (v2 becomes redundant)
      await registerVersion(page, 'v3');
      await expect.poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).waiting?.scriptURL), { timeout: 30_000 }).toContain('sw.js?v3');
      await expect(page.locator('#st-update')).toBeHidden();
      await expect(page.locator('#btn-update')).toBeVisible();
      // a broken v4 fails, but a good waiting version is still on offer
      await context.route(`**/tools/${tool}/precache.js`, route => route.fulfill(scriptJs(GARBAGE)));
      await registerVersion(page, 'v4');
      await page.waitForTimeout(1500);
      await expect(page.locator('#st-update')).toBeHidden();
      await expect(page.locator('#btn-update')).toBeVisible();
    });

    test('a service worker that does not answer the first status request is asked again', async ({ page }) => {
      await page.addInitScript(() => {
        // the first 'version' message gets lost (a worker the browser had stopped)
        let dropped = false;
        const post = ServiceWorker.prototype.postMessage;
        ServiceWorker.prototype.postMessage = function (msg, ...rest) {
          if (msg === 'version' && !dropped) { dropped = true; return undefined; }
          return post.call(this, msg, ...rest);
        };
      });
      await page.goto(TOOLS[tool].path);
      await expect(page.locator('#st-offline')).toHaveText('offline bereit ✓', { timeout: 45_000 });
    });

    test('a resumed tab offers the update it missed', async ({ page, context }) => {
      await openReady(page, tool);
      await stageUpdate(page, context, tool);
      // as if the page had been frozen while the version arrived: no button
      await page.evaluate(() => { document.querySelector('#btn-update').hidden = true; });
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await expect(page.locator('#btn-update')).toBeVisible();
    });
  });
}

// An update must not overtake a draft write that is still running (reload
// mid-write): the hook waits for it. The drafts store is held busy by a
// transaction of the test, so the app's write is in flight for ~2.5 s.
test('confirm: the update waits for a draft write in flight and the draft survives', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'service workers: Chromium only');
  await openReady(page, 'confirm');
  await TOOLS.confirm.typeInput(page);
  await stageUpdate(page, context, 'confirm');
  await page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open('oe1ebg-confirm');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('drafts', 'readwrite');
      const st = tx.objectStore('drafts');
      const end = Date.now() + 2500;
      const spin = () => { if (Date.now() < end) st.get('none').onsuccess = spin; };
      spin();
      tx.oncomplete = () => db.close();
      resolve();
    };
  }));
  await page.locator('#f-call').fill('OE1ABCX');
  await page.waitForTimeout(600); // the debounce has fired: the write is queued behind the busy store
  await page.evaluate(() => { globalThis.__marker = 'same page'; });
  await page.locator('#btn-update').click();
  await page.waitForTimeout(600);
  expect(await marker(page)).toBe('same page'); // still waiting for the write
  await expect.poll(() => marker(page), { timeout: 30_000 }).toBeUndefined(); // then reloaded
  await expect.poll(() => page.evaluate(TOOLS.confirm.ready)).toBe(true);
  await expect(page.locator('#f-call')).toHaveValue('OE1ABCX');
});

// notfunk: an older edit draft held back for review is stored already, so it
// is not "unsaved input": the update goes through; what is typed after it is.
test('notfunk: a held-back older draft does not block the update, new input does', async ({ page, context, browserName, problems }) => {
  test.skip(browserName !== 'chromium', 'service workers: Chromium only');
  await openReady(page, 'notfunk');
  await page.getByRole('button', { name: '+ Neuer Einsatz' }).click();
  await page.locator('#n-name').fill('E2E Held');
  await page.locator('#n-prefix').fill('h1');
  await page.locator('#n-operator').fill('oe1ebg');
  await page.getByRole('button', { name: 'Einsatz anlegen' }).click();
  await expect(page.locator('#view-book')).toBeVisible();
  await page.locator('#m-from').fill('Lichtinsel 2');
  await page.locator('#m-peer').fill('OE1ABC');
  await page.locator('#m-subject').fill('Wasser');
  await page.locator('#m-text').fill('old text');
  await page.locator('#m-readback').check();
  await page.locator('#btn-save').click();
  await expect(page.locator('#book-body')).toContainText('Wasser');
  await page.locator('#book-body a', { hasText: 'H1-001' }).click();
  await page.getByRole('button', { name: 'Bearbeiten' }).click();
  await page.locator('#m-subject').fill('Wasser dringend');
  await page.waitForTimeout(1000);
  // the draft as written before bases were kept, and the message changed after it
  await page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open('oe1ebg-notfunk');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(['drafts', 'messages'], 'readwrite');
      const drafts = tx.objectStore('drafts');
      const msgs = tx.objectStore('messages');
      drafts.getAll().onsuccess = ev => {
        const d = ev.target.result[0];
        delete d.base;
        delete d.updated;
        drafts.put(d);
        msgs.getAll().onsuccess = ev2 => {
          const m = ev2.target.result[0];
          m.text = 'new text from tab B';
          m.updated = new Date(Date.parse(d.saved) - 60000).toISOString();
          msgs.put(m);
        };
      };
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
  }));
  await page.reload();
  await expect(page.locator('#banner')).toContainText('ENTWURF PRÜFEN');
  await stageUpdate(page, context, 'notfunk');
  await page.evaluate(() => { globalThis.__marker = 'same page'; });
  // something typed after the notice is not stored: held back, with the reason
  await page.locator('#m-subject').fill('Wasser sehr dringend');
  await page.locator('#btn-update').click();
  await expect(page.locator('#update-problem')).toContainText('Ein älterer Entwurf wartet');
  expect(await marker(page)).toBe('same page');
  // back to what the held-back draft shows: nothing is at risk, the update goes through
  await page.locator('#m-subject').fill('Wasser dringend');
  await page.locator('#btn-update-retry').click();
  await expect.poll(() => marker(page), { timeout: 30_000 }).toBeUndefined();
  expectSaveErrors(problems);
});
