// Service worker installation and updates (issue #13), for the offline
// tools (confirm, notfunk, netlog). Chromium only, like the other service worker tests. The tools'
// precache.js is replaced through context.route(), which also intercepts
// the worker's own importScripts().
//   - a broken or missing manifest fails the install (first install: not
//     "ready", nothing cached; later: the working installation stays),
//   - development mode is only the explicit stub,
//   - a failed update check is shown (an older check finishing late does
//     not clear it),
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
  netlog: {
    path: 'tools/netlog/',
    ready: () => globalThis.NETLOG_READY === true,
    input: '#det-qth',
    // a station detail being typed (committed when the field is left)
    async typeInput(page) {
      await page.locator('#btn-new-session').click();
      await page.locator('#session-form button[type=submit]').click();
      await expect(page.locator('#view-live')).toBeVisible();
      await page.locator('#checkin-call').fill('OE0QXA');
      await page.locator('#checkin-name').press('Enter');
      await expect(page.locator('#station-call')).toHaveText('OE0QXA');
      await page.locator('#btn-edit-identity').click();
      await page.locator('#det-qth').fill('Halb getippter QTH');
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

// The workers keep fetching precache.js in the background (update checks,
// installs started by another tab), so a route handler can still be in
// flight when a test ends; it then fails with "Test ended" or "Response has
// been disposed", in that test or the next one (#36). What the browser does
// after the test is not part of it: drop the routes without waiting.
test.afterEach(({ context }) => context.unrouteAll({ behavior: 'ignoreErrors' }));

// The longest file (about 180 s of the Chromium run on the CI runner): its
// tests spread over the workers instead of keeping one of them for the whole
// file while the other runs out of work (#36). Each test has its own context
// (its own service workers, caches and routes), so the order does not matter.
test.describe.configure({ mode: 'parallel' });

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
async function breakStorage(page, tool, type = true) {
  await page.evaluate(() => {
    globalThis.__tx = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function () { throw new DOMException('quota', 'QuotaExceededError'); };
  });
  if (!type) return null;
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

    // WebKit may already report the claiming worker as the page's controller
    // when that worker's 'installed' statechange arrives: the first install
    // looked like a waiting update and showed "Update verfügbar", which also
    // moved the page (#36). Chromium reports it only later, so the test makes
    // controller return the registration's waiting worker meanwhile.
    test('the first install offers no update, even with the controller reported early', async ({ page }) => {
      await page.addInitScript(() => {
        const proto = ServiceWorkerContainer.prototype;
        const controller = Object.getOwnPropertyDescriptor(proto, 'controller').get;
        const register = proto.register;
        let reg = null;
        proto.register = function (...args) { return register.apply(this, args).then(r => { reg = r; return r; }); };
        Object.defineProperty(proto, 'controller', { configurable: true, get() { return controller.call(this) || reg?.waiting || null; } });
      });
      await openReady(page, tool);
      expect((await swInfo(page, tool)).active).toBe('activated');
      await expect(page.locator('#btn-update')).toBeHidden();
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

    test('an older update check finishing late does not clear a newer failure', async ({ page }) => {
      await openReady(page, tool);
      // the first check is slow and succeeds, the second fails at once
      await page.evaluate(() => {
        let n = 0;
        globalThis.__slowDone = false;
        ServiceWorkerRegistration.prototype.update = () => (++n === 1
          ? new Promise(r => setTimeout(() => { globalThis.__slowDone = true; r(); }, 400))
          : Promise.reject(new TypeError('Failed to update a ServiceWorker')));
        const real = Date.now;
        Date.now = () => real() + 120e3;
        window.dispatchEvent(new Event('online'));
        Date.now = () => real() + 240e3;
        window.dispatchEvent(new Event('online'));
      });
      await expect(page.locator('#st-update')).toHaveText('Update-Prüfung fehlgeschlagen');
      await expect.poll(() => page.evaluate(() => globalThis.__slowDone)).toBe(true);
      await expect(page.locator('#st-update')).toHaveText('Update-Prüfung fehlgeschlagen');
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

    // #41: the waiting worker gets skipWaiting, but activates only once the
    // old worker has served its requests; a newer version that finishes
    // installing meanwhile replaces it, and the click must go on with that one.
    test('an update clicked while a newer version installs goes on with the newer one', async ({ page, context }) => {
      await openReady(page, tool);
      await stageUpdate(page, context, tool);
      await page.evaluate(() => { globalThis.__marker = 'same page'; });

      // keep the old worker busy: a precached file it has to fetch, held
      const file = new URL('style.css', page.url()).href;
      await page.evaluate(async f => {
        for (const k of await caches.keys()) await (await caches.open(k)).delete(f);
      }, file);
      let release;
      const held = new Promise(r => { release = r; });
      let arrived;
      const busy = new Promise(r => { arrived = r; });
      let first = true;
      await context.route(file, async route => {
        if (first) {
          first = false;
          arrived();
          await held;
        }
        await route.continue();
      });
      const pending = page.evaluate(f => fetch(f).then(r => r.status), file);
      await busy;

      await page.locator('#btn-update').click();
      await registerVersion(page, 'v3');
      await expect.poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).waiting?.scriptURL), { timeout: 30_000 }).toContain('sw.js?v3');
      release();
      expect(await pending).toBe(200);

      await expect.poll(() => marker(page), { timeout: 30_000 }).toBeUndefined(); // reloaded
      await expect(page.locator('#st-offline')).toHaveText('offline bereit ✓', { timeout: 30_000 });
      expect(await page.evaluate(() => navigator.serviceWorker.controller.scriptURL)).toContain('sw.js?v3');
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

    test('a repeated failure keeps focus on the used button and does not re-announce the same text', async ({ page, context, problems }) => {
      await openReady(page, tool);
      await TOOLS[tool].typeInput(page);
      await stageUpdate(page, context, tool);
      await breakStorage(page, tool);
      await page.locator('#btn-update').click();
      await expect(page.locator('#update-problem')).toBeVisible();
      await expect(page.locator('#update-problem-title')).toBeFocused();
      await page.evaluate(() => {
        globalThis.__mut = 0;
        new MutationObserver(r => { globalThis.__mut += r.length; }).observe(document.querySelector('#update-problem'), { childList: true, characterData: true, subtree: true });
      });
      await page.locator('#btn-update-retry').click();
      await page.waitForTimeout(800); // the check ran and failed again
      await expect(page.locator('#btn-update-retry')).toBeFocused();
      expect(await page.evaluate(() => globalThis.__mut)).toBe(0);
      expectSaveErrors(problems);
    });

    test('"Trotzdem aktualisieren" without a controllerchange does not stay armed', async ({ page, context, problems }) => {
      await openReady(page, tool);
      await TOOLS[tool].typeInput(page);
      await stageUpdate(page, context, tool);
      await breakStorage(page, tool);
      // the new worker never takes over (no controllerchange follows)
      await page.evaluate(async () => { (await navigator.serviceWorker.getRegistration()).waiting.postMessage = () => {}; });
      await page.locator('#btn-update').click();
      await expect(page.locator('#update-problem')).toBeVisible();
      page.once('dialog', d => d.accept());
      await page.locator('#btn-update-anyway').click();
      await expect(page.locator('#update-problem')).toBeHidden();
      // asking again consults the hook again: it still fails
      await page.locator('#btn-update').click();
      await expect(page.locator('#update-problem')).toBeVisible();
      expectSaveErrors(problems);
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

// A held-back older edit draft (no base) for message H1-001 is open in the page.
async function heldBackDraft(page) {
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
}

// notfunk: an older edit draft held back for review is stored already, so it
// is not "unsaved input": the update goes through; what is typed after it is.
test('notfunk: a held-back older draft does not block the update, new input does', async ({ page, context, browserName, problems }) => {
  test.skip(browserName !== 'chromium', 'service workers: Chromium only');
  await heldBackDraft(page);
  await stageUpdate(page, context, 'notfunk');
  await page.evaluate(() => { globalThis.__marker = 'same page'; });
  // something typed after the notice is not stored: held back, with the reason
  await page.locator('#m-subject').fill('Wasser sehr dringend');
  await page.locator('#btn-update').click();
  await expect(page.locator('#update-problem')).toContainText('Ein älterer Entwurf zu H1-001');
  expect(await marker(page)).toBe('same page');
  // back to what the held-back draft shows: nothing is at risk, the update goes through
  await page.locator('#m-subject').fill('Wasser dringend');
  await page.locator('#btn-update-retry').click();
  await expect.poll(() => marker(page), { timeout: 30_000 }).toBeUndefined();
  expectSaveErrors(problems);
});

test('notfunk: the held-back draft choices are in the update banner and the update then goes on', async ({ page, context, browserName, problems }) => {
  test.skip(browserName !== 'chromium', 'service workers: Chromium only');
  await heldBackDraft(page);
  await stageUpdate(page, context, 'notfunk');
  await page.evaluate(() => { globalThis.__marker = 'same page'; });
  await page.locator('#m-subject').fill('Wasser sehr dringend');
  await page.locator('#btn-update').click();
  await expect(page.locator('#update-problem')).toContainText('Ein Update wartet');
  await expect(page.locator('#btn-update')).toHaveText('Update wartet: Eingabe klären');
  await expect(page.locator('#btn-update-action-0')).toContainText('auf die aktuelle Fassung anwenden');
  await expect(page.locator('#btn-update-action-1')).toContainText('Entwurf verwerfen');
  // the notice in the page is shown again too
  await expect(page.locator('#banner')).toContainText('ENTWURF PRÜFEN');
  await page.locator('#btn-update-action-0').click(); // saves the text, then the update continues by itself
  await expect.poll(() => marker(page), { timeout: 30_000 }).toBeUndefined();
  await expect(page.locator('#m-subject')).toHaveValue('Wasser sehr dringend');
  expectSaveErrors(problems);
});

// Two tabs with different drafts (a draft is a message not saved yet).
async function draftConflict(context) {
  const a = await context.newPage();
  await openReady(a, 'notfunk');
  await a.getByRole('button', { name: '+ Neuer Einsatz' }).click();
  await a.locator('#n-name').fill('E2E Konflikt');
  await a.locator('#n-prefix').fill('k1');
  await a.locator('#n-operator').fill('oe1ebg');
  await a.getByRole('button', { name: 'Einsatz anlegen' }).click();
  await expect(a.locator('#view-book')).toBeVisible();
  const b = await context.newPage();
  await b.goto(a.url());
  await expect.poll(() => b.evaluate(() => globalThis.NOTFUNK_READY === true)).toBe(true);
  await expect(b.locator('#book-title')).toHaveText('E2E Konflikt');
  await a.locator('#m-from').fill('Tab A');
  await expect(a.locator('#draft-status')).toContainText('Entwurf gesichert');
  await b.locator('#m-from').fill('Tab B');
  await expect(b.locator('#banner')).toContainText('ENTWURF NICHT GESICHERT');
  await a.close();
  await b.waitForTimeout(1000); // what closing a tab itself causes has settled
  return b;
}

for (const [choice, index, kept] of [['my text', 0, 'Tab B'], ['the other window\'s draft', 1, 'Tab A']]) {
  test(`notfunk: draft conflict, update from this tab: choosing ${choice} in the update banner completes the update`, async ({ context, browserName }) => {
    test.skip(browserName !== 'chromium', 'service workers: Chromium only');
    const b = await draftConflict(context);
    await stageUpdate(b, context, 'notfunk');
    await b.evaluate(() => { globalThis.__marker = 'same page'; });
    await b.locator('#btn-update').click();
    const banner = b.locator('#update-problem');
    await expect(banner).toContainText('Zwei Fenster haben für diesen Einsatz verschiedene Entwürfe');
    await expect(banner).toContainText('Ein Update wartet');
    await expect(b.locator('#btn-update-action-0')).toContainText('Meinen Text sichern');
    await expect(b.locator('#btn-update-action-1')).toContainText('Entwurf des anderen Fensters laden');
    expect(await marker(b)).toBe('same page');
    await b.locator(`#btn-update-action-${index}`).click(); // no further click needed
    await expect.poll(() => marker(b), { timeout: 30_000 }).toBeUndefined();
    await expect.poll(() => b.evaluate(TOOLS.notfunk.ready)).toBe(true);
    await expect(b.locator('#m-from')).toHaveValue(kept);
  });
}

test('notfunk: update started in another tab while this tab has a draft conflict: this tab offers the choice', async ({ context, browserName }) => {
  test.skip(browserName !== 'chromium', 'service workers: Chromium only');
  const b = await draftConflict(context);
  await stageUpdate(b, context, 'notfunk');
  await b.evaluate(() => { globalThis.__marker = 'same page'; });
  const c = await context.newPage();
  await c.goto(TOOLS.notfunk.path);
  await expect(c.locator('#btn-update')).toBeVisible({ timeout: 30_000 });
  await c.locator('#btn-update').click();
  // nobody clicked in b: it shows what is needed, with the choices
  const banner = b.locator('#update-problem');
  await expect(banner).toContainText('Ein anderes Fenster dieses Werkzeugs hat ein Update installiert', { timeout: 30_000 });
  await expect(banner).toContainText('verschiedene Entwürfe');
  expect(await marker(b)).toBe('same page');
  await b.locator('#btn-update-action-0').click();
  await expect.poll(() => marker(b), { timeout: 30_000 }).toBeUndefined();
  await expect.poll(() => b.evaluate(TOOLS.notfunk.ready)).toBe(true);
  await expect(b.locator('#m-from')).toHaveValue('Tab B');
});

test('"Trotzdem aktualisieren" names what is lost in this case', async ({ context, browserName }) => {
  test.skip(browserName !== 'chromium', 'service workers: Chromium only');
  const b = await draftConflict(context);
  await stageUpdate(b, context, 'notfunk');
  await b.locator('#btn-update').click();
  await expect(b.locator('#update-problem')).toBeVisible();
  let text = '';
  b.once('dialog', d => { text = d.message(); d.dismiss(); });
  await b.locator('#btn-update-anyway').click();
  expect(text).toContain('Ihr aktueller Text in diesem Fenster geht verloren; der Entwurf aus dem anderen Fenster bleibt.');
});

test('confirm: a storage failure offers to copy the text and names what is lost', async ({ page, context, browserName, problems }) => {
  test.skip(browserName !== 'chromium', 'service workers: Chromium only');
  await openReady(page, 'confirm');
  await TOOLS.confirm.typeInput(page);
  await stageUpdate(page, context, 'confirm');
  await breakStorage(page, 'confirm');
  await page.locator('#btn-update').click();
  await expect(page.locator('#update-problem')).toContainText('Die halb getippte Zeile');
  await expect(page.locator('#btn-update-action-0')).toHaveText('Eingabe in die Zwischenablage kopieren');
  let text = '';
  page.once('dialog', d => { text = d.message(); d.dismiss(); });
  await page.locator('#btn-update-anyway').click();
  expect(text).toContain('Die halb getippte Zeile geht verloren.');
  expectSaveErrors(problems);
});

test('confirm: copying fails (clipboard and execCommand): nothing is claimed as copied, the text is offered', async ({ page, context, browserName, problems }) => {
  test.skip(browserName !== 'chromium', 'service workers: Chromium only');
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new Error('denied')) }, configurable: true });
    document.execCommand = () => false;
  });
  await openReady(page, 'confirm');
  await TOOLS.confirm.typeInput(page);
  await stageUpdate(page, context, 'confirm');
  await breakStorage(page, 'confirm');
  await page.locator('#btn-update').click();
  await page.locator('#btn-update-action-0').click();
  await expect(page.locator('#update-problem-note')).toContainText('Kopieren nicht möglich');
  await expect(page.locator('#update-problem-copy')).toBeVisible();
  await expect(page.locator('#update-problem-copy')).toBeFocused();
  await expect(page.locator('#update-problem-copy')).toHaveValue(/"line"/);
  await expect(page.locator('#update-problem')).toBeVisible(); // not treated as done
  expectSaveErrors(problems);
});

test('confirm: the text of "Trotzdem aktualisieren" names only what failed (header only)', async ({ page, context, browserName, problems }) => {
  test.skip(browserName !== 'chromium', 'service workers: Chromium only');
  await openReady(page, 'confirm');
  await TOOLS.confirm.typeInput(page);
  await page.waitForTimeout(800); // the draft is stored
  await stageUpdate(page, context, 'confirm');
  await breakStorage(page, 'confirm', false);
  await page.locator('#log-title').fill('Anderer Titel');
  await page.locator('#btn-update').click();
  await expect(page.locator('#update-problem-text')).toContainText('Der Kopf des Logs');
  let text = '';
  page.once('dialog', d => { text = d.message(); d.dismiss(); });
  await page.locator('#btn-update-anyway').click();
  expect(text).toContain('Änderungen am Kopf');
  expect(text).not.toContain('halb getippte Zeile');
  expectSaveErrors(problems);
});

test('notfunk: typing while a draft conflict is open does not re-show the notice; a double click runs the action once', async ({ context, browserName }) => {
  test.skip(browserName !== 'chromium', 'service workers: Chromium only');
  const b = await draftConflict(context);
  // (closing tab A rewrote its draft: the first flush after that is a new conflict and shows its notice once)
  await b.locator('#m-from').fill('Tab B, weiter');
  await b.waitForTimeout(1500);
  await b.evaluate(() => {
    globalThis.__mut = 0;
    globalThis.__mutlog = [];
    new MutationObserver(r => { for (const m of r) globalThis.__mutlog.push(`${m.type} ${m.attributeName || ''} ${m.target.id || m.target.nodeName}`); }).observe(document.querySelector('#banner'), { childList: true, subtree: true, attributes: true });
  });
  await b.locator('#m-from').fill('Tab B, weiter getippt');
  await b.locator('#m-from').press('End');
  await b.keyboard.type(' und mehr');
  await b.waitForTimeout(1800); // several debounced draft writes, all in conflict
  expect(await b.evaluate(() => globalThis.__mutlog)).toEqual([]);
  // the update asks: the notice is shown again and the banner offers the choice
  await stageUpdate(b, context, 'notfunk');
  await b.locator('#btn-update').click();
  await expect(b.locator('#btn-update-action-0')).toBeVisible();
  await b.evaluate(() => {
    sessionStorage.setItem('puts', '0');
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...a) {
      if (this.name === 'drafts') sessionStorage.setItem('puts', String(+sessionStorage.getItem('puts') + 1));
      return put.apply(this, a);
    };
  });
  await b.locator('#btn-update-action-0').dblclick();
  await expect.poll(() => b.evaluate(() => globalThis.__mut).catch(() => undefined), { timeout: 30_000 }).toBeUndefined();
  await expect.poll(() => b.evaluate(TOOLS.notfunk.ready)).toBe(true);
  expect(+(await b.evaluate(() => sessionStorage.getItem('puts')))).toBeLessThanOrEqual(3); // one run: save, re-check, pagehide; a second run would add two more
});

// The browser can clear the Cache Storage: the page then repairs the offline
// copy (the worker fetches its own version's files again) when it is online.
for (const tool of Object.keys(TOOLS)) {
  test(`${tool}: an emptied cache is repaired online and the tool works offline again`, async ({ page, context, browserName }) => {
    test.skip(browserName !== 'chromium', 'service workers: Chromium only');
    await openReady(page, tool);
    await page.evaluate(async tool => { for (const k of await caches.keys()) if (k.startsWith(`tools-${tool}-`)) await caches.delete(k); }, tool);
    await page.reload();
    await expect(page.locator('#st-offline')).toHaveText('offline bereit ✓', { timeout: 45_000 });
    await context.setOffline(true);
    await page.reload();
    await expect(page.locator('#st-offline')).toHaveText('offline bereit ✓', { timeout: 20_000 });
    await expect.poll(() => page.evaluate(TOOLS[tool].ready)).toBe(true);
    await context.setOffline(false);
  });
}

// The repair never mixes releases: with a cache of release A and a server that
// publishes B (before, or during the download), nothing is written and the
// page points to the update.
const cacheState = (page, tool) => page.evaluate(async tool => {
  const names = (await caches.keys()).filter(k => k.startsWith(`tools-${tool}-`));
  const main = names.filter(k => !k.endsWith('-staging'));
  const urls = main.length ? (await (await caches.open(main[0])).keys()).map(r => new URL(r.url).pathname) : [];
  return { staging: names.filter(k => k.endsWith('-staging')), hasApp: urls.some(u => u.endsWith('/js/app.js')), count: urls.length };
}, tool);
const dropApp = (page, tool) => page.evaluate(async tool => {
  const name = (await caches.keys()).find(k => k.startsWith(`tools-${tool}-`));
  const cache = await caches.open(name);
  for (const r of await cache.keys()) if (new URL(r.url).pathname.endsWith('/js/app.js')) await cache.delete(r);
}, tool);

for (const tool of Object.keys(TOOLS)) {
  test(`${tool}: repair is refused while the server publishes another release`, async ({ page, context, browserName }) => {
    test.skip(browserName !== 'chromium', 'service workers: Chromium only');
    await openReady(page, tool);
    await dropApp(page, tool);
    const before = await cacheState(page, tool);
    await serveNewVersion(context, tool);
    await page.reload();
    await expect(page.locator('#st-offline')).toHaveText('Neue Version auf dem Server – bitte aktualisieren', { timeout: 30_000 });
    const after = await cacheState(page, tool);
    expect(after).toEqual({ ...before, staging: [] });
    expect(after.hasApp).toBe(false); // nothing of release B was committed as A
  });

  test(`${tool}: a release change during the repair download is rolled back`, async ({ page, context, browserName }) => {
    test.skip(browserName !== 'chromium', 'service workers: Chromium only');
    await openReady(page, tool);
    await dropApp(page, tool);
    const before = await cacheState(page, tool);
    let flipped = false;
    // the deployment changes while the worker downloads the missing module
    await context.route(`**/tools/${tool}/js/app.js`, route => { flipped = true; return route.continue(); });
    await context.route(`**/tools/${tool}/precache.js`, async route => {
      if (!flipped) return route.continue();
      const res = await route.fetch();
      await route.fulfill({ response: res, body: (await res.text()).replace(/version: "([^"]+)"/, 'version: "$1x"') });
    });
    await page.reload();
    await expect(page.locator('#st-offline')).toHaveText('Neue Version auf dem Server – bitte aktualisieren', { timeout: 30_000 });
    const after = await cacheState(page, tool);
    expect(after).toEqual({ ...before, staging: [] });
  });
}
