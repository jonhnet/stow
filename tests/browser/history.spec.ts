import { SyncTransfer } from '../../src/core/sync-transfer';
import { test, expect, type Page } from '@playwright/test';

const ORIGIN = 'http://localhost:4174';
const card = (page: Page, title: string) => page.getByRole('article', { name: `Open note: ${title}`, exact: true });
async function createText(page: Page, title: string, body: string) {
  await page.getByRole('button', { name: 'Take a note…', exact: true }).click();
  await page.getByRole('textbox', { name: 'Note title', exact: true }).fill(title);
  const text = page.getByRole('textbox', { name: 'Note text', exact: true });
  await text.focus(); await text.fill(body);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
}
async function history(page: Page) {
  await page.getByRole('dialog', { name: 'Edit note', exact: true }).getByRole('button', { name: 'More note actions' }).click();
  await page.getByRole('button', { name: 'Version history', exact: true }).click();
  return page.getByRole('dialog', { name: 'Version history', exact: true });
}

test('offline edits stay usable; reconnect saves the observed state and history stays out of the client vault', async ({ page, context }) => {
  await context.addCookies([{ name: 'stow_test_user', value: 'history-actions@example.test', url: ORIGIN }]);
  await page.goto(ORIGIN);
  await expect(page.locator('.sync-state')).toHaveAttribute('title', 'Connected');
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await createText(page, 'Unrelated private timeline', 'This must not appear in the selected history.');
  await page.getByRole('button', { name: 'New checklist' }).click();
  await page.getByRole('textbox', { name: 'Note title', exact: true }).fill('Saturday errands');
  await page.getByRole('textbox', { name: 'New list item', exact: true }).fill('Buy lemons');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await card(page, 'Saturday errands').click();
  await context.setOffline(true);
  const checkbox = page.getByRole('checkbox', { name: 'Complete Buy lemons', exact: true });
  await checkbox.check(); await checkbox.uncheck(); await checkbox.check();
  const item = page.getByRole('textbox', { name: 'List item text', exact: true });
  await item.focus(); await item.fill('Buy oranges');
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await page.reload();
  await card(page, 'Saturday errands').click();
  const timeline = await history(page);
  await expect(timeline).toContainText('Connect to view version history.');
  await expect(timeline.locator('.revision-card')).toHaveCount(0);
  await context.setOffline(false);
  await expect(page.locator('.sync-state')).toHaveAttribute('title', 'Connected');
  await expect(timeline.locator('.revision-card').first()).toBeVisible();
  await expect(timeline).not.toContainText('Unrelated private timeline');
  const check = timeline.locator('.revision-card').first();
  await expect(check.locator('time')).toHaveText(/\d{1,2}:\d{2}:\d{2}/);
  await check.getByRole('button', { name: 'Preview version' }).click();
  await expect(check.getByLabel('Saved version preview')).toContainText('Buy oranges');
  await expect(check.getByLabel('Saved version preview').getByLabel('Checked', { exact: true })).toBeVisible();
  const roots = await page.evaluate(async () => {
    const session = await (await fetch('/api/session')).json();
    const request = indexedDB.open(`stow-notes-${session.vaultId}`);
    return new Promise<string[]>((resolve, reject) => {
      request.onerror = () => reject(request.error);
      request.onsuccess = () => { const db = request.result; const stores = [...db.objectStoreNames]; db.close(); resolve(stores); };
    });
  });
  expect(roots.sort()).toEqual(['maintenance', 'pendingEdits', 'updates']);
  await page.screenshot({ path: test.info().outputPath('stow-note-history.png'), fullPage: true });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Edit note', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'More note actions' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(card(page, 'Saturday errands')).toContainText('1 completed item');
  await expect(page.getByRole('button', { name: 'History', exact: true })).toHaveCount(0);
});

test('history follows merged sources through archive and trash and restores a copy', async ({ page, context }) => {
  await context.addCookies([{ name: 'stow_test_user', value: 'history-merged@example.test', url: ORIGIN }]);
  await page.goto(ORIGIN);
  await expect(page.locator('.sync-state')).toHaveAttribute('title', 'Connected');
  await createText(page, 'Travel checklist', 'Tickets');
  await createText(page, 'Hotel details', 'Reservation 42');
  for (const title of ['Travel checklist', 'Hotel details']) {
    await card(page, title).hover();
    await card(page, title).getByRole('button', { name: 'Select note', exact: true }).click();
  }
  await page.getByRole('button', { name: 'Merge notes' }).click();
  let timeline = await history(page);
  await expect(timeline.locator('.history-source-title').filter({ hasText: 'Travel checklist' }).first()).toBeVisible();
  await expect(timeline.locator('.history-source-title').filter({ hasText: 'Hotel details' }).first()).toBeVisible();
  await timeline.getByRole('button', { name: 'Back to note' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Archive note', exact: true }).click();
  await page.getByRole('button', { name: 'Archive', exact: true }).click();
  await card(page, 'Travel checklist').click();
  timeline = await history(page);
  await expect(timeline.locator('.revision-card')).not.toHaveCount(0);
  await timeline.getByRole('button', { name: 'Back to note' }).click();
  await page.getByRole('button', { name: 'More note actions' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Move to trash', exact: true }).click();
  await page.getByRole('button', { name: 'Trash', exact: true }).click();
  await card(page, 'Travel checklist').click();
  timeline = await history(page);
  const latest = timeline.locator('.revision-card').first();
  await latest.getByRole('button', { name: 'Preview version' }).click();
  await expect(latest.getByLabel('Saved version preview')).toContainText('Reservation 42');
  await latest.getByRole('button', { name: 'Restore copy' }).click();
  await expect(page.getByRole('dialog', { name: 'Edit note', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toContainText('Reservation 42');
  await page.keyboard.press('Escape');
  await expect(card(page, 'Travel checklist')).toBeVisible();
  await page.getByRole('button', { name: 'Trash', exact: true }).click();
  await expect(card(page, 'Travel checklist')).toBeVisible();
});

test('an incompatible server is rejected before its vault data enters the client', async ({ page, context }) => {
  await context.addCookies([{ name: 'stow_test_user', value: 'history-old-server@example.test', url: ORIGIN }]);
  await page.routeWebSocket('**/sync?**', socket => {
    // A checksummed binary snapshot from a server without the current schema
    // marker must be rejected before any of its Yjs bytes are applied.
    const transfer = new SyncTransfer({ bufferedAmount: 0,
      send: value => socket.send(typeof value === 'string' ? value : Buffer.from(value)),
      close: (code, reason) => socket.close({ code, reason }),
    }, { onFailure() {}, onMessage(kind) {
      if (kind === 'sync-request') void transfer.send('sync', Uint8Array.of(0, 0, 0, 1, 0, 0, 0)).catch(() => {});
    } });
    socket.onMessage(raw => transfer.receive(typeof raw === 'string' ? raw : new Uint8Array(raw)));
    socket.onClose(() => transfer.close());
  });
  await page.goto(ORIGIN);
  await expect(page.getByRole('alert')).toContainText('incompatible vault format');
  await expect(page.getByRole('button', { name: 'Take a note…', exact: true })).toHaveCount(0);
});
