import { test, expect, type BrowserContext } from '@playwright/test';

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
    expect(context.pages().map(page => page.url())).toEqual(['about:blank']);
    await context.setOffline(true);
    const offline = await context.newPage(); await offline.goto(origin);
    await expect(offline.getByRole('article', { name: 'Open note: Background flight plan', exact: true })).toContainText('Ready before departure');
    await expect(offline.locator('.sync-state')).toHaveAttribute('title', 'Offline — notes stored on this device');
    await offline.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(offline.getByText(/Last synced on this device:/)).toBeVisible();
  } finally { await context.close(); await writer.close(); }
});

test('settings distinguishes background registration from attempts, failures, and success', async ({ browser }, info) => {
  const context = await browser.newContext();
  try {
    await context.addCookies([{ name: 'stow_test_user', value: `background-status-${info.testId}`, url: 'http://localhost:4174' }]);
    const page = await context.newPage(); await page.goto('http://localhost:4174');
    await expect(page.locator('.sync-state')).toHaveAttribute('title', 'Connected');
    const settings = page.getByRole('button', { name: 'Settings', exact: true });
    await settings.click();
    await expect(page.getByText('Background refresh: no attempts recorded on this device.', { exact: true })).toBeVisible();
    await settings.click();
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
    await expect(page.getByText(/^Last background attempt:/)).toBeVisible();
    await expect(page.getByText(/^Last background success:/)).toBeVisible();
    await expect(page.getByText('Last background error: Background session rejected (HTTP 401)', { exact: true })).toBeVisible();
  } finally { await context.close(); }
});
