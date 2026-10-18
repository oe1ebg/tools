// The screenshots of the manuals (see shots.config.mjs). Each block sets up
// example data through the UI, the way a user would, and saves PNGs into
// docs/img/ (committed). Re-run after visible changes to a tool.
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';

const IMG = fileURLToPath(new URL('../../docs/img/', import.meta.url));
const at = iso => new Date(iso);

// The header is sticky: in a picture of the whole page (or of an element
// further down) it would sit across the content wherever the page happens
// to be scrolled. For the pictures it stays at the top (set through the
// element's style: the pages' CSP blocks an injected style sheet).
async function staticHeader(page, run) {
  await page.evaluate(() => { const h = document.querySelector('#site-header'); if (h) h.style.position = 'static'; });
  try {
    await run();
  } finally {
    await page.evaluate(() => { const h = document.querySelector('#site-header'); if (h) h.style.position = ''; });
  }
}

async function shot(target, name) {
  await staticHeader(target.page(), () => target.screenshot({ path: `${IMG}${name}.png`, animations: 'disabled', caret: 'hide' }));
}

// One picture of several elements (the box around all of them), taken
// from the whole page.
async function shotAround(page, selectors, name, pad = 8) {
  await staticHeader(page, async () => {
    const boxes = await page.evaluate(sels => sels.map(sel => {
      const r = document.querySelector(sel).getBoundingClientRect();
      return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height };
    }), selectors);
    const x = Math.max(0, Math.min(...boxes.map(b => b.x)) - pad);
    const y = Math.max(0, Math.min(...boxes.map(b => b.y)) - pad);
    const clip = { x, y, width: Math.max(...boxes.map(b => b.x + b.w)) + pad - x, height: Math.max(...boxes.map(b => b.y + b.h)) + pad - y };
    await page.screenshot({ path: `${IMG}${name}.png`, clip, fullPage: true, animations: 'disabled', caret: 'hide' });
  });
}

test('Notfunk-Meldebuch', async ({ page }) => {
  await page.clock.setFixedTime(at('2026-10-08T11:58:00Z'));
  await page.goto('tools/notfunk/');
  await expect.poll(() => page.evaluate(() => globalThis.NOTFUNK_READY === true)).toBe(true);
  await page.evaluate(() => { globalThis.print = () => {}; });

  // a new operation
  await page.getByRole('button', { name: '+ Neuer Einsatz' }).click();
  await page.locator('#n-name').fill('Übung Blackout Wien');
  await page.locator('#n-prefix').fill('W1');
  await page.locator('#n-call').fill('OE1XKS');
  await page.locator('#n-station').fill('Lichtinsel 12 Floridsdorf');
  await page.locator('#n-operator').fill('OE1EBG');
  await page.locator('#n-home').fill('Stab');
  await page.locator('#n-freq').fill('145,5');
  await page.locator('#n-freq').press('Tab');
  await shotAround(page, ['#new-op'], 'notfunk-einsatz-neu');
  await page.getByRole('button', { name: 'Einsatz anlegen' }).click();
  await expect(page.locator('#view-book')).toBeVisible();

  // three messages
  const msg = async ({ time, dir = 'in', from, to, peer, subject, text, prio, loc, readBack = true }) => {
    await page.clock.setFixedTime(at(time));
    if (dir === 'out') await page.locator('label[for="m-dir-out"]').click();
    await page.locator('#m-from').fill(from);
    if (to) await page.locator('#m-to').fill(to);
    await page.locator('#m-peer').fill(peer);
    await page.locator('#m-subject').fill(subject);
    if (loc) {
      await page.locator('#m-loc').fill(loc);
      await expect(page.locator('#m-loc-info')).toContainText('✓', { timeout: 30_000 });
      await page.locator('#m-loc').press('Escape');
    }
    await page.locator('#m-text').fill(text);
    if (prio) await page.locator(`label[for="m-prio-${prio}"]`).click();
    if (readBack) await page.locator('#m-readback').check();
  };
  await msg({
    time: '2026-10-08T12:05:00Z', from: 'FF Floridsdorf, Einsatzleiter', peer: 'OE1ABC',
    subject: 'Stromausfall Pflegeheim, Notstrom nur bis 18 Uhr', loc: 'Brünner Straße 68', prio: 'priority',
    text: 'Pflegeheim Brünner Straße 68, 42 Bewohner, davon 6 beatmet. Notstromaggregat läuft, Diesel reicht bis ca. 18:00. Benötigen Dieselnachschub 200 Liter. Ansprechperson vor Ort: Frau Huber, Pflegedienstleitung.',
  });
  await page.waitForTimeout(300);
  await shotAround(page, ['#msg-form'], 'notfunk-meldung');
  await page.locator('#m-text').press('Shift+Enter');
  await expect(page.locator('#book-body')).toContainText('W1-001');

  await msg({
    time: '2026-10-08T12:20:00Z', from: 'Lichtinsel 7 Stammersdorf', peer: '', readBack: false,
    subject: 'Lage Lichtinsel 7', text: 'Lichtinsel 7 besetzt, 2 Personen. Funk und Notstrom in Ordnung. Ca. 30 Personen aus der Umgebung vor Ort, keine Verletzten.',
  });
  await page.locator('#m-text').press('Shift+Enter');
  await expect(page.locator('#warn-bar')).toBeVisible();
  await shotAround(page, ['#msg-form .radio-row', '#warn-bar'], 'notfunk-hinweis');
  await page.locator('#m-text').press('Shift+Enter');
  await expect(page.locator('#book-body')).toContainText('W1-002');

  await msg({
    time: '2026-10-08T12:31:00Z', dir: 'out', from: 'Stab', to: 'FF Floridsdorf, Einsatzleiter', peer: 'OE1ABC', readBack: false,
    subject: 'Antwort: Diesel', text: 'Tankwagen mit 200 Liter Diesel ist unterwegs, Ankunft ca. 15:30.',
  });
  await page.locator('#m-more > summary').click();
  await page.locator('#m-ref').fill('W1-001');
  await page.locator('#m-text').press('Shift+Enter');
  await expect(page.locator('#book-body')).toContainText('W1-003');

  // W1-001 handed over, taken over, reference reported back
  await page.clock.setFixedTime(at('2026-10-08T12:40:00Z'));
  await page.locator('#book-body a', { hasText: 'W1-001' }).click();
  await page.getByLabel('Übergeben an').fill('Meldesammelstelle');
  await page.getByLabel('Übergabezeitpunkt').fill('14:10');
  await page.getByRole('button', { name: 'Übergabe eintragen' }).click();
  await expect(page.locator('#msg-detail')).toContainText('an Meldesammelstelle');
  await page.getByLabel('Übernommen durch').fill('S6 Huber');
  await page.getByLabel('Zeitpunkt (leer = jetzt)', { exact: true }).fill('14:12');
  await page.getByRole('button', { name: 'Übernahme eintragen' }).click();
  await expect(page.locator('#msg-detail')).toContainText('durch S6 Huber');
  await page.getByLabel('Referenz / Geschäftsbuch-Nr.').fill('GZ 0412');
  await page.getByRole('button', { name: 'Referenz eintragen' }).click();
  await expect(page.locator('#msg-detail .detail-tags')).toContainText('GZ 0412');
  await shotAround(page, ['#view-msg'], 'notfunk-meldung-detail');

  // the printout
  await page.getByRole('button', { name: 'Ausdruck / PDF' }).click();
  await expect(page.locator('#print-dlg')).toBeVisible();
  await shot(page.locator('#print-dlg'), 'notfunk-druckhinweis');
  await page.locator('#print-dlg-ok').click();
  await page.setViewportSize({ width: 794, height: 1123 });
  await page.emulateMedia({ media: 'print' });
  await shot(page.locator('#print-sheet .pf-sheet'), 'notfunk-ausdruck');
  await page.emulateMedia({ media: 'screen' });
  await page.setViewportSize({ width: 1200, height: 860 });

  // the book
  await page.getByRole('button', { name: '← Meldebuch' }).click();
  await page.locator('#book-body a', { hasText: 'W1-003' }).waitFor();
  await page.getByRole('button', { name: 'W1-003 übertragen' }).click();
  await expect(page.locator('#book-body tr', { hasText: 'W1-003' })).toContainText('übertragen');
  await shotAround(page, ['#book-summary', '#view-book .filter-bar', '#view-book .table-wrap'], 'notfunk-meldebuch');

  // the map of the book's messages
  await page.getByRole('button', { name: 'Karte' }).click();
  await expect(page.locator('#map .map-pin').first()).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(500); // the fit animation
  await shotAround(page, ['#view-book .filter-bar', '#map-panel'], 'notfunk-karte');
  await page.getByRole('button', { name: 'Karte' }).click();

  // the help
  await page.locator('#m-from').focus();
  await page.keyboard.press('F1');
  await expect(page.locator('#help-dlg')).toBeVisible();
  await shot(page.locator('#help-dlg'), 'notfunk-hilfe');
  await page.keyboard.press('Escape');
});

test('Bestätigungsverkehr', async ({ page }) => {
  await page.clock.setFixedTime(at('2026-10-08T17:00:00Z'));
  await page.goto('tools/confirm/');
  await expect.poll(() => page.evaluate(() => globalThis.CONFIRM_READY === true)).toBe(true);
  await page.getByRole('button', { name: '+ Neues Log' }).click();
  await page.locator('#new-event input[name="title"]').fill('Rundspruch OE1 – Bestätigungsverkehr');
  await page.locator('#new-header-operator').fill('OE1EBG');
  await page.locator('#new-header-station').fill('OE1XKS');
  await page.locator('#new-header-myGrid').fill('JN88ef');
  await page.locator('#new-header label[data-value="FM"]').click();
  await page.locator('#new-header label[data-value="rpt"]').click();
  await page.locator('#new-header-repeaterCall').fill('OE1XUU');
  await page.locator('#new-header-repeaterCall').press('Tab');
  await shotAround(page, ['#new-event'], 'confirm-log-neu');
  await page.getByRole('button', { name: /Log anlegen/ }).click();
  await expect(page.locator('#view-log')).toBeVisible();

  const checkin = async (time, call, qth, note) => {
    await page.clock.setFixedTime(at(time));
    await page.locator('#f-call').fill(call);
    await page.locator('#f-call').press('Tab');
    if (qth) {
      const loc = page.locator('#f-fields input[name="f_qth"]');
      await loc.fill(qth);
      await page.waitForTimeout(800);
    }
    if (note) await page.locator('#f-note').fill(note);
    await page.locator('#f-call').press('Shift+Enter');
    await expect(page.locator('#log-body')).toContainText(call);
  };
  await checkin('2026-10-08T17:02:00Z', 'OE1ABC', 'Brünner Straße 68');
  await checkin('2026-10-08T17:03:00Z', 'OE3XYZ', 'Wolkersdorf');
  await checkin('2026-10-08T17:04:00Z', 'OE1DEF', 'Stephansplatz', 'über Handfunkgerät');
  // an operator comment
  await page.clock.setFixedTime(at('2026-10-08T17:06:00Z'));
  await page.locator('#f-call').fill('!Netz kurz unterbrochen, Relais neu gestartet');
  await page.locator('#f-ctext').press('Shift+Enter');
  await checkin('2026-10-08T17:09:00Z', 'OE1ABC');

  // the highlight of new rows fades after 2.5 s: how many still have it
  // would depend on the machine's speed
  await expect(page.locator('#log-body tr.fresh')).toHaveCount(0);

  // typing a callsign: the suggestions
  await page.locator('#f-call').fill('oe1x');
  await expect(page.locator('#call-suggest')).toBeVisible();
  await shotAround(page, ['#entry-form', '#call-suggest'], 'confirm-eingabe');
  await page.locator('#f-call').fill('');
  await page.locator('#f-call').press('Escape');

  await shotAround(page, ['#view-log .table-wrap'], 'confirm-log');
  await page.locator('#hdr-panel > summary').click();
  await shotAround(page, ['#hdr-panel'], 'confirm-kopfdaten');
  await page.locator('#hdr-panel > summary').click();

  await page.getByRole('button', { name: 'Hilfe' }).click();
  await expect(page.locator('#help-dlg')).toBeVisible();
  await shot(page.locator('#help-dlg'), 'confirm-hilfe');
  await page.keyboard.press('Escape');

  await page.locator('#btn-export-menu').click();
  await shotAround(page, ['#view-log .log-bar', '#export-list'], 'confirm-export');
  await page.keyboard.press('Escape');

  await page.locator('#btn-map').click();
  await expect(page.locator('#map-panel')).toBeVisible();
  await page.waitForTimeout(1500);
  await shotAround(page, ['#map-panel'], 'confirm-karte');
  await page.locator('#btn-map').click();

  await page.locator('#btn-loc').click();
  await page.locator('#loc-q').fill('Lainzer Krankenhaus');
  await page.waitForTimeout(1500);
  await shotAround(page, ['#loc-panel'], 'confirm-standortsuche');
});

// --- notices (docs/notfunk-anleitung.md, docs/confirm-anleitung.md) ---

async function notfunkOp(page, name, prefix) {
  await page.goto('tools/notfunk/');
  await expect.poll(() => page.evaluate(() => globalThis.NOTFUNK_READY === true)).toBe(true);
  await page.getByRole('button', { name: '+ Neuer Einsatz' }).click();
  await page.locator('#n-name').fill(name);
  await page.locator('#n-prefix').fill(prefix);
  await page.locator('#n-operator').fill('OE1EBG');
  await page.getByRole('button', { name: 'Einsatz anlegen' }).click();
  await expect(page.locator('#view-book')).toBeVisible();
}

test('Notfunk-Meldebuch: Konflikt- und Entwurfshinweise', async ({ page, context }) => {
  await page.clock.setFixedTime(at('2026-10-08T12:05:00Z'));
  await notfunkOp(page, 'Übung Blackout Wien', 'W1');
  await page.locator('#m-from').fill('FF Floridsdorf, Einsatzleiter');
  await page.locator('#m-peer').fill('OE1ABC');
  await page.locator('#m-subject').fill('Stromausfall Pflegeheim');
  await page.locator('#m-text').fill('Notstromaggregat läuft, Diesel reicht bis ca. 18:00.');
  await page.locator('#m-readback').check();
  await page.locator('#btn-save').click();
  await expect(page.locator('#book-body')).toContainText('W1-001');

  // NICHT GESPEICHERT: another tab changed the message while this one edited it
  await page.locator('#book-body a', { hasText: 'W1-001' }).click();
  const detailUrl = page.url();
  await page.getByRole('button', { name: 'Bearbeiten' }).click();
  await page.locator('#m-subject').fill('Stromausfall Pflegeheim, dringend');
  const b = await context.newPage();
  await b.goto(detailUrl);
  await expect.poll(() => b.evaluate(() => globalThis.NOTFUNK_READY === true)).toBe(true);
  await b.getByLabel('Übergeben an').fill('Meldesammelstelle');
  await b.getByRole('button', { name: 'Übergabe eintragen' }).click();
  await expect(b.locator('#msg-detail')).toContainText('an Meldesammelstelle');
  await expect(page.locator('#book-body tr', { hasText: 'W1-001' })).toContainText('übergeben');
  await page.locator('#btn-save').click();
  await expect(page.locator('#banner')).toContainText('NICHT GESPEICHERT');
  await shot(page.locator('#banner'), 'notfunk-nicht-gespeichert');
  await b.close();

  // ENTWURF NICHT GESICHERT: two tabs, two drafts
  await notfunkOp(page, 'Übung Entwurf', 'E1');
  const c = await context.newPage();
  await c.goto(page.url());
  await expect.poll(() => c.evaluate(() => globalThis.NOTFUNK_READY === true)).toBe(true);
  await page.locator('#m-from').fill('FF Floridsdorf, Einsatzleiter');
  await expect(page.locator('#draft-status')).toContainText('Entwurf gesichert');
  await c.locator('#m-from').fill('Lichtinsel 7 Stammersdorf');
  await expect(c.locator('#banner')).toContainText('ENTWURF NICHT GESICHERT');
  await shot(c.locator('#banner'), 'notfunk-entwurf-nicht-gesichert');
  await c.close();
});

test('Notfunk-Meldebuch: älterer Entwurf prüfen', async ({ page }) => {
  await page.clock.setFixedTime(at('2026-10-08T12:05:00Z'));
  await notfunkOp(page, 'Übung Blackout Wien', 'W1');
  await page.locator('#m-from').fill('FF Floridsdorf, Einsatzleiter');
  await page.locator('#m-peer').fill('OE1ABC');
  await page.locator('#m-subject').fill('Stromausfall Pflegeheim');
  await page.locator('#m-text').fill('Notstromaggregat läuft.');
  await page.locator('#m-readback').check();
  await page.locator('#btn-save').click();
  await expect(page.locator('#book-body')).toContainText('W1-001');
  await page.locator('#book-body a', { hasText: 'W1-001' }).click();
  await page.getByRole('button', { name: 'Bearbeiten' }).click();
  await page.locator('#m-subject').fill('Stromausfall Pflegeheim, dringend');
  await expect(page.locator('#draft-status')).toContainText('Entwurf gesichert');
  // an edit draft of an older version (no base) and a change made meanwhile
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
          m.text = 'Notstromaggregat läuft, Diesel reicht bis ca. 18:00.';
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
  await shot(page.locator('#banner'), 'notfunk-entwurf-pruefen');
});

// The update banner: a new version waits and saving the input fails.
// Every test has its own browser context, so the extra service worker
// registration (sw.js?v2) and the stubbed storage never reach another shot.
async function updateBanner(page, context, tool, typeInput, input, name) {
  await page.clock.setFixedTime(at('2026-10-08T12:05:00Z'));
  await page.goto(`tools/${tool}/`);
  await expect(page.locator('#st-offline')).toHaveText('offline bereit ✓', { timeout: 45_000 });
  await typeInput();
  await context.route(`**/tools/${tool}/precache.js`, async route => {
    const res = await route.fetch();
    await route.fulfill({ response: res, body: (await res.text()).replace(/version: "([^"]+)"/, 'version: "$1x"') });
  });
  await page.evaluate(() => navigator.serviceWorker.register('sw.js?v2').then(() => {}, () => {}));
  await expect(page.locator('#btn-update')).toBeVisible({ timeout: 30_000 });
  await page.evaluate(() => {
    IDBDatabase.prototype.transaction = function () { throw new DOMException('quota', 'QuotaExceededError'); };
  });
  await page.locator(input).fill(`${await page.locator(input).inputValue()} und mehr`);
  await page.locator('#btn-update').click();
  await expect(page.locator('#update-problem')).toBeVisible();
  await expect(page.locator('#btn-update')).toHaveText('Update wartet: Eingabe klären');
  await shotAround(page, ['#site-header', '#update-problem'], name);
}

test('Notfunk-Meldebuch: Update wartet', async ({ page, context }) => {
  await updateBanner(page, context, 'notfunk', async () => {
    await page.getByRole('button', { name: '+ Neuer Einsatz' }).click();
    await page.locator('#n-name').fill('Übung Blackout Wien');
    await page.locator('#n-prefix').fill('W1');
    await page.locator('#n-operator').fill('OE1EBG');
    await page.getByRole('button', { name: 'Einsatz anlegen' }).click();
    await page.locator('#m-text').fill('Halb getippte Meldung');
  }, '#m-text', 'notfunk-update-wartet');
});

test('Bestätigungsverkehr: Update wartet', async ({ page, context }) => {
  await updateBanner(page, context, 'confirm', async () => {
    await page.getByRole('button', { name: '+ Neues Log' }).click();
    await page.locator('#new-event input[name="title"]').fill('Rundspruch OE1 – Bestätigungsverkehr');
    await page.getByRole('button', { name: /Log anlegen/ }).click();
    await expect(page.locator('#view-log')).toBeVisible();
    await page.locator('#f-call').fill('OE1ABC');
  }, '#f-call', 'confirm-update-wartet');
});
