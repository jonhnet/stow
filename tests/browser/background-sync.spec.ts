import { test, expect, type BrowserContext } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const origin = 'http://localhost:4173';
async function result(context: BrowserContext, vaultId: string) {
  const worker = context.serviceWorkers().find(worker => worker.url() === `${origin}/sw.js`);
  if (!worker) return undefined;
  return worker.evaluate(async vaultId => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('stow-background-v1'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    try { return await new Promise<any>((resolve, reject) => {
      const request = db.transaction('results').objectStore('results').get(vaultId);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    }); } finally { db.close(); }
  }, vaultId);
}

test('periodic sync fetches a remote note with every Stow window closed, then opens it offline', async ({ playwright, browserName }, info) => {
  test.skip(browserName !== 'chromium', 'Periodic Background Sync and its test dispatch are Chromium APIs.');
  const context = await playwright.chromium.launchPersistentContext(info.outputPath('background-profile'), { ...info.project.use.launchOptions });
  const writer = await playwright.chromium.launch({ ...info.project.use.launchOptions });
  try {
    const control = context.pages()[0];
    const cdp = await context.newCDPSession(control);
    await cdp.send('Browser.setPermission', { origin, permission: { name: 'periodic-background-sync' }, setting: 'granted' });
    const registrations: { registrationId: string; scopeURL: string }[] = [];
    cdp.on('ServiceWorker.workerRegistrationUpdated', event => registrations.push(...event.registrations));
    await cdp.send('ServiceWorker.enable');
    const page = await context.newPage();
    await page.goto(origin);
    await expect(page.locator('.sync-state')).toHaveAttribute('title', 'Connected');
    const account = await page.evaluate(() => JSON.parse(localStorage.getItem('stow-account-v1')!));
    await expect.poll(() => page.evaluate(async () => {
      const r = await navigator.serviceWorker.ready;
      return (r as any).periodicSync.getTags();
    })).toContain('stow-notes');
    await page.close();
    await expect.poll(() => registrations.find(r => r.scopeURL === `${origin}/`)?.registrationId).toBeTruthy();
    const id = registrations.find(r => r.scopeURL === `${origin}/`)!.registrationId;
    const remote = await writer.newPage(); await remote.goto(origin);
    await expect(remote.locator('.sync-state')).toHaveAttribute('title', 'Connected');
    await remote.getByRole('button', { name: 'Take a note…', exact: true }).click();
    await remote.getByRole('textbox', { name: 'Note title', exact: true }).fill('Background flight plan');
    await remote.getByRole('textbox', { name: 'Note text', exact: true }).focus();
    await remote.getByRole('textbox', { name: 'Note text', exact: true }).fill('Ready before departure');
    await remote.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(remote.locator('.sync-state')).toHaveAttribute('title', 'Connected');
    await cdp.send('ServiceWorker.stopAllWorkers');
    await cdp.send('ServiceWorker.dispatchPeriodicSyncEvent', { origin, registrationId: id, tag: 'stow-notes' });
    await expect.poll(async () => (await result(context, account.vaultId))?.completedAt).toBeTruthy();
    // The worker uploads its evidence while all Stow documents remain closed.
    await expect.poll(async () => {
      const response = await context.request.get(`${origin}/api/diagnostics/background`, { headers: { 'X-Stow-Vault': account.vaultId } });
      const reports = await response.json();
      return reports.devices.some((device: any) => device.lastBackgroundAt && device.events.some((event: any) => event.kind === 'success'));
    }).toBe(true);
    const stored = await (await context.request.get(`${origin}/api/diagnostics/background`, { headers: { 'X-Stow-Vault': account.vaultId } })).json();
    const device = stored.devices.find((device: any) => device.lastBackgroundAt);
    expect(device.lastUploadBuild).toMatch(/^[0-9a-f]{40}$/);
    expect(device.events.every((event: any) => event.build === device.lastUploadBuild)).toBe(true);
    expect(context.pages().map(page => page.url())).toEqual(['about:blank']);
    await context.setOffline(true);
    const offline = await context.newPage(); await offline.goto(origin);
    await expect(offline.getByRole('article', { name: 'Open note: Background flight plan', exact: true })).toContainText('Ready before departure');
    await expect(offline.locator('.sync-state')).toHaveAttribute('title', 'Offline — notes stored on this device');
    await offline.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(offline.getByText(/Last synced on this device:/)).toHaveCount(0);
    await offline.getByRole('button', { name: 'Sync diagnostics', exact: true }).click();
    await expect(offline.getByText(/Last synced on this device:/)).toBeVisible();
    const downloaded = offline.waitForEvent('download');
    await offline.getByRole('button', { name: 'Download background log', exact: true }).click();
    const text = await readFile((await (await downloaded).path())!, 'utf8');
    const log = JSON.parse(text);
    expect(log.events.some((event: any) => event.kind === 'registration' && event.availability === 'enabled')).toBe(true);
    const wake = log.events.filter((event: any) => ['wake', 'started', 'success'].includes(event.kind));
    expect(wake.map((event: any) => event.kind)).toEqual(['wake', 'started', 'success']);
    expect(new Set(wake.map((event: any) => event.runId)).size).toBe(1);
    expect(wake[2].receivedBytes).toBeGreaterThan(0);
    expect(log.vaultId).toBe(account.vaultId);
    expect(log.deviceId).toBeTruthy();
    expect(wake.every((event: any) => event.build === log.build.commit)).toBe(true);
    expect(text).not.toContain('Background flight plan');
  } finally { await context.close(); await writer.close(); }
});

test('devices automatically upload, retry a lost acknowledgment without duplicates, and send periodic heartbeats', async ({ browser }, info) => {
  const host = 'http://localhost:4174';
  const a = await browser.newContext(), b = await browser.newContext();
  try {
    for (const context of [a, b]) await context.addCookies([{ name: 'stow_test_user', value: `log-upload-${info.testId}`, url: host }]);
    const page = await a.newPage();
    await page.clock.install();
    let loseResponse = true;
    await page.route('**/api/diagnostics/background', async route => {
      if (route.request().method() === 'POST' && loseResponse) {
        await route.fetch(); // Committed by the server, but not acknowledged locally.
        await route.abort('failed');
      } else await route.continue();
    });
    await page.goto(host);
    await expect(page.locator('.sync-state')).toHaveAttribute('title', 'Connected');
    const account = await page.evaluate(() => JSON.parse(localStorage.getItem('stow-account-v1')!));
    const reports = async () => (await (await a.request.get(`${host}/api/diagnostics/background`, { headers: { 'X-Stow-Vault': account.vaultId } })).json()).devices;
    await expect.poll(async () => (await reports()).length).toBe(1);
    const first = (await reports())[0];
    expect(first.events.some((event: any) => event.kind === 'registration')).toBe(true);
    expect(first.lastUploadBuild).toMatch(/^[0-9a-f]{40}$/);
    expect(first.events.every((event: any) => event.build === first.lastUploadBuild)).toBe(true);
    const second = await b.newPage(); await second.goto(host);
    await expect.poll(async () => (await reports()).length).toBe(2);
    expect(new Set((await reports()).map((device: any) => device.deviceId)).size).toBe(2);
    loseResponse = false;
    const retry = page.waitForResponse(response => response.url().endsWith('/api/diagnostics/background') && response.request().method() === 'POST');
    await page.clock.fastForward(5 * 60 * 1000 + 1000);
    expect((await retry).status()).toBe(201);
    const after = (await reports()).find((device: any) => device.deviceId === first.deviceId);
    expect(after.events).toEqual(first.events);
    // A response arriving is earlier than its durable local acknowledgment.
    await expect.poll(() => page.evaluate(async vaultId => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('stow-background-v1'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      try { return await new Promise<number>((resolve, reject) => {
        const request = db.transaction('metadata').objectStore('metadata').get(`uploaded:${vaultId}`);
        request.onsuccess = () => resolve(Number(request.result)); request.onerror = () => reject(request.error);
      }); } finally { db.close(); }
    }, account.vaultId)).toBe(first.through);
    const heartbeat = page.waitForResponse(response => response.url().endsWith('/api/diagnostics/background') && response.request().method() === 'POST');
    await page.clock.fastForward(5 * 60 * 1000 + 1000);
    const response = await heartbeat;
    expect(response.status()).toBe(201);
    expect(response.request().postDataJSON().events).toEqual([]);
    expect(response.request().postDataJSON().source).toBe('foreground');
    expect(after.browser).toBeTruthy();
  } finally { await a.close(); await b.close(); }
});

test('sync diagnostics keeps background status out of Settings and preserves readable failures and log export', async ({ browser }, info) => {
  const context = await browser.newContext();
  try {
    await context.addCookies([{ name: 'stow_test_user', value: `background-status-${info.testId}`, url: 'http://localhost:4174' }]);
    const page = await context.newPage(); await page.goto('http://localhost:4174');
    await page.setViewportSize({ width: 390, height: 600 });
    await expect(page.locator('.sync-state')).toHaveAttribute('title', 'Connected');
    await page.getByRole('searchbox').fill('flight');
    const settings = page.getByRole('button', { name: 'Settings', exact: true });
    await settings.click();
    await expect(page.getByText(/^Last synced|^Last background|^Background refresh:/)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Download background log', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Sync diagnostics', exact: true }).click();
    await expect(page.getByText('Background refresh: no attempts recorded on this device.', { exact: true })).toBeVisible();
    const dialog = page.getByRole('dialog', { name: 'Sync diagnostics', exact: true });
    const bounds = (await dialog.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(600);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(settings).toBeFocused();
    await expect(page.getByRole('searchbox')).toHaveValue('flight');
    await page.evaluate(async () => {
      const account = JSON.parse(localStorage.getItem('stow-account-v1')!);
      const request = indexedDB.open('stow-background-v1');
      const db = await new Promise<IDBDatabase>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      try {
        await new Promise<void>((resolve, reject) => {
          const transaction = db.transaction('results', 'readwrite');
          transaction.objectStore('results').put({ attemptedAt: 2000, completedAt: 1000, error: 'Background session rejected (HTTP 401)' }, account.vaultId);
          transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(transaction.error);
        });
      } finally { db.close(); }
    });
    // Foreground sync must not erase the last background failure.
    await page.reload(); await expect(page.locator('.sync-state')).toHaveAttribute('title', 'Connected');
    await settings.click();
    await page.getByRole('button', { name: 'Sync diagnostics', exact: true }).click();
    await expect(page.getByText(/^Last background attempt:/)).toBeVisible();
    await expect(page.getByText(/^Last background success:/)).toBeVisible();
    await expect(page.getByText('Last background error: Background session rejected (HTTP 401)', { exact: true })).toBeVisible();
    const downloaded = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download background log', exact: true }).click();
    const log = JSON.parse(await readFile((await (await downloaded).path())!, 'utf8'));
    expect(log.events.some((event: any) => event.kind === 'registration')).toBe(true);
    expect(log.result.error).toContain('HTTP 401');
    expect(log.events.some((event: any) => event.kind === 'wake')).toBe(false);
  } finally { await context.close(); }
});
