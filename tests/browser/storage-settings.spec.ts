import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import * as Y from 'yjs';
import { Vault } from '../../src/core/vault';
import type { VaultStorage } from '../../src/core/storage-types';

const ORIGIN = 'http://localhost:4174';
const policyLabel = 'Discard history after archived notes have been unchanged for 7 days';
const settings = (page: Page) => page.getByRole('dialog', { name: 'Storage and history', exact: true });
const confirmation = (page: Page, name: string) => page.getByRole('alertdialog', { name, exact: true });
const card = (page: Page, title: string) => page.getByRole('article', { name: `Open note: ${title}`, exact: true });

async function seed(page: Page, context: BrowserContext, liveEdits = 0) {
  const vault = new Vault();
  const live = vault.createNote('text', { title: 'Live note', body: 'Live contents stay here.' });
  for (let i = 0; i < liveEdits; i++) { vault.setNoteText(live, 'body', `Live version ${i}`); vault.finishEdit(); }
  const first = vault.createNote('text', { title: 'Archived note', body: 'Earlier archived contents.' });
  vault.setNoteText(first, 'body', 'Current archived contents.');
  vault.setNoteMeta(first, { archived: true });
  const second = vault.createNote('text', { title: 'Another archive', body: 'Second archived contents.' });
  vault.setNoteMeta(second, { archived: true });
  const update = [...Y.encodeStateAsUpdate(vault.doc)];
  vault.destroy();
  const { vaultId } = await (await context.request.get(`${ORIGIN}/api/session`)).json();
  await page.goto(`${ORIGIN}/api/health`);
  await page.evaluate(async ({ vaultId, update }) => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(`stow-notes-${vaultId}`, 1);
    request.onupgradeneeded = () => { request.result.createObjectStore('updates', { autoIncrement: true }); request.result.createObjectStore('pendingEdits'); request.result.createObjectStore('maintenance'); };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result, transaction = db.transaction('updates', 'readwrite');
      transaction.objectStore('updates').add(new Uint8Array(update));
      transaction.oncomplete = () => { db.close(); resolve(); };
      transaction.onabort = () => { db.close(); reject(transaction.error); };
    };
  }), { vaultId, update });
  await page.goto(ORIGIN);
  await expect(page.locator('.sync-state')).toHaveAttribute('title', 'Connected');
  await expect(card(page, 'Live note')).toBeVisible();
  return vaultId as string;
}

async function openSettings(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Storage and history', exact: true }).click();
  await expect(settings(page).getByRole('checkbox', { name: policyLabel, exact: true })).toBeVisible();
  return settings(page);
}

async function serverStorage(context: BrowserContext, vaultId: string): Promise<VaultStorage> {
  const response = await context.request.get(`${ORIGIN}/api/storage`, { headers: { 'X-Stow-Vault': vaultId } });
  expect(response.ok()).toBe(true);
  return response.json();
}

async function navigate(page: Page, view: 'Notes' | 'Archive') {
  if (page.viewportSize()!.width < 900) await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  await page.getByRole('button', { name: view, exact: true }).click();
}

test.beforeEach(async ({ context }, info) => {
  await context.addCookies([{ name: 'stow_test_user', value: `storage-${info.testId}-${info.retry}@example.test`, url: ORIGIN }]);
});

test('storage permission is requested only by an explicit settings action, never by reload', async ({ page, context }) => {
  await context.addInitScript(() => {
    Object.defineProperty(navigator.storage, 'persisted', { value: async () => sessionStorage.getItem('test-protected') === 'yes' });
    Object.defineProperty(navigator.storage, 'persist', { value: () => {
      sessionStorage.setItem('test-protection-requests', String(Number(sessionStorage.getItem('test-protection-requests') ?? 0) + 1));
      return new Promise<boolean>(resolve => { (window as any).grantProtection = () => { sessionStorage.setItem('test-protected', 'yes'); resolve(true); }; });
    } });
  });
  await seed(page, context);
  for (let i = 0; i < 2; i++) { await page.reload(); await expect(card(page, 'Live note')).toBeVisible(); }
  expect(await page.evaluate(() => sessionStorage.getItem('test-protection-requests'))).toBeNull();
  const dialog = await openSettings(page);
  expect(await page.evaluate(() => sessionStorage.getItem('test-protection-requests'))).toBeNull();
  await dialog.getByRole('button', { name: 'Protect local storage', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Waiting for browser permission…', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => sessionStorage.getItem('test-protection-requests'))).toBe('1');
  await page.evaluate(() => (window as any).grantProtection());
  await expect(dialog).toContainText('Protected from automatic eviction');
  await page.reload(); await expect(card(page, 'Live note')).toBeVisible();
  await openSettings(page);
  await expect(settings(page)).toContainText('Protected from automatic eviction');
  expect(await page.evaluate(() => sessionStorage.getItem('test-protection-requests'))).toBe('1');
});

test('automatic cleanup requires consent, persists its setting, and leaves a new archive history intact', async ({ page, context }) => {
  const vaultId = await seed(page, context), dialog = await openSettings(page);
  const policy = dialog.getByRole('checkbox', { name: policyLabel, exact: true });
  await expect(policy).not.toBeChecked();
  await expect(dialog.getByRole('heading', { name: 'Server storage', exact: true })).toBeVisible();
  for (const label of ['Current notes (synced to devices)', 'Saved history (server only)', 'Vault files on disk', 'Original attachments', 'Thumbnails']) {
    await expect(dialog.getByText(label, { exact: true })).toBeVisible();
  }
  const before = await serverStorage(context, vaultId);
  expect(before.historyBytes).toBeGreaterThan(0);
  await policy.click();
  const consent = confirmation(page, 'Enable automatic history cleanup?');
  await expect(consent).toContainText('Existing archived notes get a full 7 days');
  await expect(consent).toContainText('Discarded history cannot be restored');
  await expect(consent.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(consent).toHaveCount(0);
  await expect(policy).not.toBeChecked();
  expect((await serverStorage(context, vaultId)).retention.enabled).toBe(false);
  await policy.click();
  await consent.getByRole('button', { name: 'Enable cleanup', exact: true }).click();
  await expect(consent).toHaveCount(0);
  await expect(policy).toBeChecked();
  expect((await serverStorage(context, vaultId)).historyBytes).toBe(before.historyBytes);
  await expect(page.locator('.toast')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Close storage settings', exact: true }).click();
  await page.reload();
  await openSettings(page);
  await expect(policy).toBeChecked();
  await policy.click();
  await expect(policy).not.toBeChecked();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  expect((await serverStorage(context, vaultId)).retention.enabled).toBe(false);
});

test('manual discard confirms its note count, removes old history, and shows a dated history notice', async ({ page, context }) => {
  const vaultId = await seed(page, context), dialog = await openSettings(page);
  const before = await serverStorage(context, vaultId);
  await dialog.getByRole('button', { name: 'Discard archived history now…', exact: true }).click();
  const discard = confirmation(page, 'Discard archived history now?');
  await expect(discard).toContainText('2 archived notes');
  await expect(discard).toContainText('without the 7-day wait');
  await expect(discard.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await discard.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect((await serverStorage(context, vaultId)).historyBytes).toBe(before.historyBytes);
  await dialog.getByRole('button', { name: 'Discard archived history now…', exact: true }).click();
  await discard.getByRole('button', { name: 'Discard history', exact: true }).click();
  await expect(discard).toHaveCount(0);
  expect((await serverStorage(context, vaultId)).historyBytes).toBeLessThan(before.historyBytes);
  await expect(page.locator('.toast')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Close storage settings', exact: true }).click();
  await expect(card(page, 'Live note')).toContainText('Live contents stay here.');
  await navigate(page, 'Archive');
  await expect(card(page, 'Archived note')).toContainText('Current archived contents.');
  await expect(card(page, 'Another archive')).toContainText('Second archived contents.');
  await card(page, 'Archived note').getByRole('heading').click();
  await page.getByRole('button', { name: 'More note actions', exact: true }).click();
  await page.getByRole('button', { name: 'Version history', exact: true }).click();
  const history = page.getByRole('dialog', { name: 'Version history', exact: true });
  await expect(history).toContainText('Earlier history discarded on');
  await expect(history.locator('.history-discarded time')).toHaveAttribute('datetime', /^\d{4}-\d{2}-\d{2}T/);
  await expect(history).toContainText('No saved changes');
  await expect(history).not.toContainText('Earlier archived contents.');
});

test('phone settings fit the viewport and report a rejected cleanup without claiming success', async ({ page, context }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const vaultId = await seed(page, context), dialog = await openSettings(page);
  const bounds = (await dialog.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(844);
  await page.screenshot({ path: info.outputPath('phone-storage-settings.png') });
  const before = await serverStorage(context, vaultId);
  await page.route('**/api/history-retention/cleanup', route => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'The selected archived notes changed. Refresh storage information and try again.' }) }));
  await dialog.getByRole('button', { name: 'Discard archived history now…', exact: true }).click();
  const discard = confirmation(page, 'Discard archived history now?');
  await discard.getByRole('button', { name: 'Discard history', exact: true }).click();
  await expect(discard.getByRole('alert')).toContainText('selected archived notes changed');
  await expect(discard.getByRole('button', { name: 'Cancel', exact: true })).toBeEnabled();
  expect((await serverStorage(context, vaultId)).historyBytes).toBe(before.historyBytes);
  await expect(page.locator('.toast')).toHaveCount(0);
  await discard.getByRole('button', { name: 'Cancel', exact: true }).click();
  await dialog.getByRole('button', { name: 'Close storage settings', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeFocused();
});


test('history compression defaults on and its setting persists independently of archive cleanup', async ({ page, context }) => {
  const vaultId = await seed(page, context), dialog = await openSettings(page);
  const live = dialog.getByRole('checkbox', { name: 'Compress older note history', exact: true });
  const archive = dialog.getByRole('checkbox', { name: policyLabel, exact: true });
  await expect(live).toBeChecked(); await expect(archive).not.toBeChecked();
  await live.click(); await expect(live).not.toBeChecked();
  await live.click();
  const consent = confirmation(page, 'Compress older note history?');
  await expect(consent).toContainText('newest 50 versions and 25 older versions');
  await expect(consent).toContainText('Current edits and local Undo are preserved');
  await consent.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect((await serverStorage(context, vaultId)).compression.enabled).toBe(false);
  await live.click(); await consent.getByRole('button', { name: 'Enable cleanup', exact: true }).click();
  await expect(live).toBeChecked(); await expect(archive).not.toBeChecked();
  await dialog.getByRole('button', { name: 'Close storage settings', exact: true }).click();
  await page.reload(); await openSettings(page);
  await expect(live).toBeChecked(); await expect(archive).not.toBeChecked();
  await live.click(); await expect(live).not.toBeChecked();
  expect((await serverStorage(context, vaultId)).compression.enabled).toBe(false);
  await dialog.getByRole('button', { name: 'Close storage settings', exact: true }).click();
  await card(page, 'Live note').getByRole('heading').click();
  await page.getByRole('button', { name: 'More note actions', exact: true }).click();
  await page.getByRole('button', { name: 'Version history', exact: true }).click();
  const history = page.getByRole('dialog', { name: 'Version history', exact: true });
  await expect(history).toContainText('Live note');
});
