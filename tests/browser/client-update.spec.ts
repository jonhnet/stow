import { test, expect, type Page } from '@playwright/test';
import { buildInfo } from '../../scripts/build-info';
import { sourceDir } from '../../paths';
import { card, connected, createNote, origin, workerGate } from './support/sync-faults';

const notice = (page: Page) => page.getByRole('alert', { name: 'Sync stopped' });

async function olderClient(page: Page) {
  const control = { reject: false };
  // Exercise the actual Rust compatibility response, retaining real auth and IDB.
  await page.route('**/api/session', route => route.continue({ headers: {
    ...route.request().headers(), ...(control.reject ? { 'x-stow-sync-protocol': '2' } : {}),
  } }));
  return control;
}

test.beforeEach(async ({ context }, info) => {
  await context.addCookies([{ name: 'stow_test_user', value: `update-${info.testId}-${info.repeatEachIndex}@example.test`, url: origin }]);
});

test('update waits for local writes, composition and idle; offline edits survive and reloads cannot loop', async ({ page, context }) => {
  await workerGate(page); const version = await olderClient(page);
  let loads = 0; page.on('framenavigated', frame => { if (frame === page.mainFrame()) loads++; });
  await page.goto(origin); await connected(page); await createNote(page);
  await page.clock.install();
  await context.setOffline(true);
  await page.evaluate(() => { (window as any).syncWorkerGate.pause = true; });
  await card(page).getByRole('heading').click();
  const body = page.getByRole('textbox', { name: 'Note text', exact: true });
  await body.focus();
  await body.fill('Offline edit must survive the update');
  await expect.poll(() => page.evaluate(() => (window as any).syncWorkerGate.held)).toBeGreaterThan(0);
  // Composition was already active when the rejection arrived.
  await body.dispatchEvent('compositionstart');
  version.reject = true; await context.setOffline(false);
  await expect(notice(page)).toContainText('Reload Stow');
  await expect(notice(page)).toContainText('Waiting for your edits to save');
  await expect(notice(page).getByRole('button', { name: 'Reload', exact: true })).toBeDisabled();
  await page.clock.fastForward(6000); expect(loads).toBe(1);
  await page.evaluate(() => (window as any).syncWorkerGate.release());
  await expect(notice(page).getByRole('button', { name: 'Reload', exact: true })).toBeEnabled();
  await page.clock.fastForward(6000); expect(loads).toBe(1);
  await body.dispatchEvent('compositionend');
  await page.clock.fastForward(4000); await body.fill('Offline edit must survive the update, including the last keystroke');
  await page.clock.fastForward(4000); expect(loads).toBe(1);
  await page.clock.fastForward(1500); await expect.poll(() => loads).toBe(2);
  await expect(notice(page)).toContainText('Automatic reload is paused');
  await page.clock.fastForward(30000); expect(loads).toBe(2);
  version.reject = false;
  await notice(page).getByRole('button', { name: 'Reload', exact: true }).click();
  await expect(card(page)).toContainText('Offline edit must survive the update, including the last keystroke');
  await connected(page); expect(loads).toBe(3); await expect(notice(page)).toHaveCount(0);
});

test('a failed local write blocks the automatic update and keeps the unsaved note visible', async ({ page, context }) => {
  await page.addInitScript(() => {
    Object.assign(window, { failStowWrites: false });
    const Original = Worker;
    window.Worker = class extends Original {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        if (options?.name !== 'stow-persistence') return;
        const post = this.postMessage.bind(this);
        this.postMessage = value => {
          if ((window as any).failStowWrites) queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: { id: value.id, error: { name: 'QuotaExceededError', message: 'Scheduled full disk' } } })));
          else post(value);
        };
      }
    };
  });
  const version = await olderClient(page);
  await page.goto(origin); await connected(page); await createNote(page); await page.clock.install();
  await context.setOffline(true);
  await page.evaluate(() => { (window as any).failStowWrites = true; });
  await card(page).getByRole('heading').click();
  const body = page.getByRole('textbox', { name: 'Note text', exact: true }); await body.focus(); await body.fill('Keep this unsaved content');
  await expect(page.locator('.error-banner')).toContainText('Local storage failed');
  version.reject = true; await context.setOffline(false);
  await expect(notice(page)).toContainText('Local storage failed'); await page.clock.fastForward(20000);
  await expect(body).toHaveValue('Keep this unsaved content');
  await expect(notice(page).getByRole('button', { name: 'Reload', exact: true })).toBeDisabled();
});

test('a phone sees a persistent rejection before any incompatible vault is opened', async ({ page }) => {
  await page.setViewportSize({ width: 412, height: 915 });
  const version = await olderClient(page); version.reject = true;
  await page.goto(origin); await expect(notice(page)).toBeVisible();
  await page.clock.install();
  // Input keeps the notice alive beyond the transient-toast timeout.
  await page.evaluate(() => window.dispatchEvent(new Event('compositionstart')));
  await page.clock.fastForward(10000); await expect(notice(page)).toBeVisible();
  expect(await page.evaluate(async () => (await indexedDB.databases()).filter(db => db.name?.startsWith('stow-notes-')))).toEqual([]);
  const bounds = await notice(page).boundingBox(); expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(412);
});

test('an account change takes priority over a reload instruction', async ({ page, context }) => {
  const version = await olderClient(page); await page.goto(origin); await connected(page); await createNote(page);
  version.reject = true;
  await context.addCookies([{ name: 'stow_test_user', value: 'other-update-account@example.test', url: origin }]);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.getByRole('alert')).toContainText('Your signed-in account changed');
  await expect(notice(page)).toHaveCount(0);
});

test('a terminal sync failure keeps the server message visible without requesting a reload', async ({ page }) => {
  let reject!: () => void;
  await page.routeWebSocket(/\/sync\?/, socket => {
    socket.connectToServer();
    reject = () => socket.send(JSON.stringify({ type: 'failure', code: 'limit', message: 'This vault exceeds the server sync limit.' }));
  });
  await page.goto(origin); await connected(page); await createNote(page); await page.clock.install();
  reject(); await expect(notice(page)).toContainText('This vault exceeds the server sync limit.');
  await page.clock.fastForward(20000); await expect(notice(page)).toBeVisible();
  await expect(notice(page).getByRole('button')).toHaveCount(0);
  await expect(card(page)).toContainText('Baseline');
});

test('settings identifies the running bundle with commit hash and commit date', async ({ page }) => {
  await page.goto(origin); await connected(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const row = page.getByLabel('Running build'); const version = buildInfo(sourceDir);
  await expect(row).toContainText(version.commit!.slice(0, 10));
  await expect(row.locator('code')).toHaveAttribute('title', version.commit!);
  await expect(row.locator('time')).toHaveAttribute('datetime', version.committedAt!);
  await expect(row.getByRole('button')).toHaveCount(0);
});
