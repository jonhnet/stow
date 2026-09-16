import { test, expect } from '@playwright/test';
import { card, connected, createNote, edit, origin, syncFaults, workerGate } from './support/sync-faults';

for (const boundary of ['session', 'sync', 'upload', 'done', 'blackhole'] as const) {
  test(`three devices retain edits across a reconnect interrupted at ${boundary}`, async ({ page, context, browser }, info) => {
    const user = `schedule-${info.testId}-${info.repeatEachIndex}@example.test`;
    const peers = await Promise.all([browser.newContext(), browser.newContext()]);
    const all = [context, ...peers];
    await Promise.all(all.map(client => client.addCookies([{ name: 'stow_test_user', value: user, url: origin }])));
    const faults = await syncFaults(page, info);
    try {
      await page.goto(origin); await connected(page); await createNote(page);
      await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
      const others = await Promise.all(peers.map(client => client.newPage()));
      await Promise.all(others.map(async peer => { await peer.goto(origin); await expect(card(peer)).toBeVisible(); await connected(peer); }));
      await context.setOffline(true);
      await edit(page, text => text + ' OFFLINE-A');
      await expect(page.locator('.sync-state')).toHaveAttribute('title', 'Offline — notes stored on this device');
      await edit(others[0], text => 'REMOTE-B ' + text);
      await createNote(others[1], 'Third device', 'Unrelated C survives');
      faults.arm(boundary);
      if (boundary === 'blackhole') await page.clock.install();
      await context.setOffline(false); await faults.held();
      await edit(page, text => text + ' DURING-RECONNECT');
      if (boundary === 'blackhole') {
        await page.clock.runFor(61_000);
        await expect.poll(() => faults.events.some(event => (event as { reason?: string }).reason === 'retry')).toBe(true);
      }
      if (boundary === 'blackhole') { await faults.release(); await page.clock.resume(); }
      else { faults.disconnect(); await faults.release(false); }
      await connected(page);
      for (const peer of [page, ...others]) {
        for (const text of ['Baseline 🦀', 'OFFLINE-A', 'REMOTE-B', 'DURING-RECONNECT']) await expect(card(peer)).toContainText(text);
        await expect(card(peer, 'Third device')).toContainText('Unrelated C survives');
        const text = await card(peer).textContent();
        for (const marker of ['OFFLINE-A', 'REMOTE-B', 'DURING-RECONNECT']) expect(text!.split(marker).length - 1).toBe(1);
      }
      // A fresh cache cannot be repaired by this browser's IndexedDB or broadcasts.
      const fresh = await browser.newContext();
      try {
        await fresh.addCookies([{ name: 'stow_test_user', value: user, url: origin }]);
        const reader = await fresh.newPage(); await reader.goto(origin);
        for (const text of ['OFFLINE-A', 'REMOTE-B', 'DURING-RECONNECT']) await expect(card(reader)).toContainText(text);
      } finally { await fresh.close(); }
    } finally { await faults.release(false); await faults.save(); await Promise.all(peers.map(peer => peer.close())); }
  });
}

test('two shared tabs compact while a remote device edits and a local write is held', async ({ page, context, browser }, info) => {
  const user = `schedule-${info.testId}-${info.repeatEachIndex}@example.test`;
  await context.addCookies([{ name: 'stow_test_user', value: user, url: origin }]);
  await workerGate(page); await page.goto(origin); await connected(page); await createNote(page);
  const tab = await context.newPage(); await tab.goto(origin); await expect(card(tab)).toBeVisible();
  const remote = await browser.newContext();
  try {
    await remote.addCookies([{ name: 'stow_test_user', value: user, url: origin }]);
    const phone = await remote.newPage(); await phone.goto(origin); await expect(card(phone)).toBeVisible();
    await context.setOffline(true);
    await page.evaluate(async () => {
      const name = (await indexedDB.databases()).find(entry => entry.name?.startsWith('stow-notes-'))!.name!;
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open(name);
        request.onsuccess = () => {
          const db = request.result, tx = db.transaction('updates', 'readwrite'), store = tx.objectStore('updates');
          const count = store.count();
          count.onsuccess = () => { for (let i = count.result; i < 499; i++) store.add(Uint8Array.of(0, 0)); };
          tx.oncomplete = () => { db.close(); resolve(); }; tx.onabort = () => { db.close(); reject(tx.error); };
        }; request.onerror = () => reject(request.error);
      });
      (window as any).syncWorkerGate.pause = true;
    });
    await edit(page, text => text + ' HELD-FIRST-TAB');
    await expect.poll(() => page.evaluate(() => (window as any).syncWorkerGate.held)).toBeGreaterThan(0);
    await expect(card(tab)).toContainText('HELD-FIRST-TAB');
    await edit(tab, text => text + ' SECOND-TAB');
    await expect.poll(() => tab.evaluate(async () => {
      const name = (await indexedDB.databases()).find(entry => entry.name?.startsWith('stow-notes-'))!.name!;
      return new Promise<number>((resolve, reject) => {
        const request = indexedDB.open(name);
        request.onsuccess = () => {
          const db = request.result, count = db.transaction('updates').objectStore('updates').count();
          count.onsuccess = () => { db.close(); resolve(count.result); }; count.onerror = () => { db.close(); reject(count.error); };
        }; request.onerror = () => reject(request.error);
      });
    })).toBeLessThan(499);
    await edit(phone, text => 'REMOTE-PHONE ' + text);
    await page.evaluate(() => (window as any).syncWorkerGate.release());
    await expect(page.locator('.sync-state')).toHaveAttribute('title', 'Offline — notes stored on this device');
    await context.setOffline(false);
    for (const client of [page, tab, phone]) for (const marker of ['HELD-FIRST-TAB', 'SECOND-TAB', 'REMOTE-PHONE']) await expect(card(client)).toContainText(marker);
    await connected(page); await tab.close(); await context.setOffline(true); await page.reload();
    for (const marker of ['HELD-FIRST-TAB', 'SECOND-TAB', 'REMOTE-PHONE']) await expect(card(page)).toContainText(marker);
  } finally { await remote.close(); }
});

for (const committed of [false, true]) test(`renderer crash ${committed ? 'after' : 'before'} local commit obeys the durability boundary`, async ({ page, context, browserName }, info) => {
  test.skip(browserName !== 'chromium', 'Renderer termination uses the Chromium DevTools protocol; the other schedules run on Firefox too.');
  await context.addCookies([{ name: 'stow_test_user', value: `schedule-${info.testId}-${info.repeatEachIndex}@example.test`, url: origin }]);
  await workerGate(page); await page.goto(origin); await connected(page); await createNote(page);
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  await context.setOffline(true);
  if (!committed) await page.evaluate(() => { (window as any).syncWorkerGate.pause = true; });
  await edit(page, text => text + ' LAST-OFFLINE-EDIT');
  if (committed) await expect(page.locator('.sync-state')).toHaveAttribute('title', 'Offline — notes stored on this device');
  else await expect.poll(() => page.evaluate(() => (window as any).syncWorkerGate.held)).toBeGreaterThan(0);
  const debugging = await context.newCDPSession(page);
  const crashed = page.waitForEvent('crash');
  void debugging.send('Page.crash').catch(() => {}); await crashed;
  await page.close();
  const reopened = await context.newPage(); await reopened.goto(origin);
  await expect(card(reopened)).toContainText('Baseline 🦀');
  if (committed) await expect(card(reopened)).toContainText('LAST-OFFLINE-EDIT');
  // The uncommitted edit may be absent. Never require an ambiguous write to be lost.
});

test('a lost image upload response survives offline reload and retries with its note reference intact', async ({ page, context, browser }, info) => {
  const user = `schedule-${info.testId}-${info.repeatEachIndex}@example.test`;
  await context.addCookies([{ name: 'stow_test_user', value: user, url: origin }]);
  await page.goto(origin); await connected(page); await createNote(page);
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  let held = false, resume!: () => void;
  const release = new Promise<void>(resolve => { resume = resolve; });
  await page.route('**/api/blobs/*', async route => {
    if (route.request().method() !== 'PUT' || held) return route.continue();
    const response = await route.fetch();
    expect(response.status()).toBe(204); // The server has durably stored the bytes.
    held = true;
    await release;
    await route.abort('failed').catch(() => {}); // Lose the HTTP acknowledgment.
  });
  const remote = await browser.newContext();
  try {
    await context.setOffline(true);
    await card(page).click();
    await page.getByRole('dialog').locator('input[type=file]').setInputFiles({ name: 'scheduled.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4////fwAJ+wP9CNHoHgAAAABJRU5ErkJggg==', 'base64') });
    await expect(page.getByRole('dialog').getByRole('img', { name: 'scheduled.png', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await context.setOffline(false); await expect.poll(() => held).toBe(true);
    await context.setOffline(true); resume();
    // End HTTP interception before exercising the browser's real offline navigation.
    await page.unrouteAll({ behavior: 'wait' });
    await page.reload();
    await expect(card(page).getByRole('img', { name: 'scheduled.png', exact: true })).toBeVisible();
    await context.setOffline(false); await connected(page);
    await remote.addCookies([{ name: 'stow_test_user', value: user, url: origin }]);
    const reader = await remote.newPage(); await reader.goto(origin);
    const image = card(reader).getByRole('img', { name: 'scheduled.png', exact: true });
    await expect(image).toBeVisible();
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(1);
    await edit(reader, text => text + ' REMOTE AFTER UPLOAD');
    await expect(card(page)).toContainText('REMOTE AFTER UPLOAD');
  } finally { resume(); await remote.close(); }
});

test('callbacks retained by an old socket cannot disrupt its replacement connection', async ({ page, context, browser }, info) => {
  const user = `schedule-${info.testId}-${info.repeatEachIndex}@example.test`;
  await context.addCookies([{ name: 'stow_test_user', value: user, url: origin }]);
  await page.addInitScript(() => {
    const NativeSocket = WebSocket, sockets: WebSocket[] = [], held: (() => void)[] = [];
    const control = { pause: false, held: 0, replace() { control.pause = false; sockets.splice(0).forEach(socket => socket.close(1000)); }, replay() { held.splice(0).forEach(deliver => deliver()); } };
    Object.assign(window, { syncSocketCallbacks: control });
    window.WebSocket = class extends NativeSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols); sockets.push(this);
        this.addEventListener('message', event => {
          if (!control.pause) return;
          event.stopImmediatePropagation(); control.held++;
          held.push(() => this.dispatchEvent(new MessageEvent('message', { data: event.data })));
        });
      }
    };
  });
  const remote = await browser.newContext();
  try {
    await page.goto(origin); await connected(page); await createNote(page);
    await remote.addCookies([{ name: 'stow_test_user', value: user, url: origin }]);
    const other = await remote.newPage(); await other.goto(origin); await expect(card(other)).toBeVisible();
    await context.setOffline(true);
    await page.evaluate(() => { (window as any).syncSocketCallbacks.pause = true; });
    await context.setOffline(false);
    await expect.poll(() => page.evaluate(() => (window as any).syncSocketCallbacks.held)).toBeGreaterThan(0);
    await edit(other, text => text + ' NEWER REMOTE STATE');
    await page.evaluate(() => (window as any).syncSocketCallbacks.replace());
    await connected(page); await expect(card(page)).toContainText('NEWER REMOTE STATE');
    await page.evaluate(() => (window as any).syncSocketCallbacks.replay());
    await edit(page, text => text + ' NEW SOCKET WRITE');
    await expect(card(other)).toContainText('NEW SOCKET WRITE'); await connected(page);
    await expect(page.locator('.error-banner')).toHaveCount(0);
  } finally { await remote.close(); }
});
