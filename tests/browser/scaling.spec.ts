import { test, expect, type Page } from '@playwright/test';
import * as Y from 'yjs';
import { Vault } from '../../src/core/vault';

const ORIGIN = 'http://localhost:4174';
const card = (page: Page, title: string) => page.getByRole('article', { name: `Open note: ${title}`, exact: true });

test('a large offline collection mounts nearby cards and searches current active and archived text', async ({ page, context }) => {
  await context.addCookies([{ name: 'stow_test_user', value: 'windowed-collection@example.test', url: ORIGIN }]);
  const session = await (await context.request.get(`${ORIGIN}/api/session`)).json();
  const fixture = new Vault();
  for (let index = 0; index < 600; index++) fixture.createNote('text', { title: `Window note ${String(index).padStart(4, '0')}`, body: `A short synthetic note. Searchable phrase ${index}.` });
  const archived = fixture.createNote('text', { title: 'Archived window note', body: 'Offline archive needle' });
  fixture.setNoteMeta(archived, { archived: true });
  const live = fixture.getNotes().filter(note => !note.archived);
  const firstTitle = live[0].title, lastTitle = live[live.length - 1].title;
  const update = [...Y.encodeStateAsUpdate(fixture.doc)];
  fixture.doc.destroy();
  await page.goto(`${ORIGIN}/api/health`);
  await page.evaluate(async ({ update, vaultId }) => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(`stow-notes-${vaultId}`, 1);
      request.onupgradeneeded = () => { request.result.createObjectStore('updates', { autoIncrement: true }); request.result.createObjectStore('pendingEdits'); request.result.createObjectStore('maintenance'); };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result, transaction = db.transaction('updates', 'readwrite');
        transaction.objectStore('updates').add(new Uint8Array(update));
        transaction.oncomplete = () => { db.close(); resolve(); };
        transaction.onabort = () => { db.close(); reject(transaction.error); };
      };
    });
  }, { update, vaultId: session.vaultId });
  await page.goto(ORIGIN);
  await expect(page.locator('.sync-state')).toHaveAttribute('title', 'Connected');
  await expect(card(page, firstTitle)).toBeVisible();
  await expect(card(page, lastTitle)).toHaveCount(0);
  expect(await page.locator('.note-card').count()).toBeLessThan(100);
  await expect.poll(async () => {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    return card(page, lastTitle).count();
  }).toBe(1);
  await expect(card(page, lastTitle)).toBeVisible();
  expect(await page.locator('.note-card').count()).toBeLessThan(100);
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(card(page, firstTitle)).toBeVisible();
  await card(page, firstTitle).focus();
  for (let step = 0; step < 20; step++) await page.keyboard.press('ArrowDown');
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  expect(await page.evaluate(() => document.activeElement?.classList.contains('note-card'))).toBe(true);
  expect(await page.locator('.note-card').count()).toBeLessThan(100);
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await context.setOffline(true);
  await page.reload();
  await page.getByRole('searchbox', { name: 'Search notes' }).fill('Offline archive needle');
  await expect(card(page, 'Archived window note')).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search notes' }).fill('Searchable phrase 599.');
  await expect(card(page, 'Window note 0599')).toBeVisible();
  await card(page, 'Window note 0599').click();
  const body = page.getByRole('dialog').getByRole('textbox', { name: 'Note text', exact: true });
  await body.focus(); await body.fill('Replacement phrase retained offline.');
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'No matching notes' })).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search notes' }).fill('Replacement phrase');
  await expect(card(page, 'Window note 0599')).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('stow-windowed-search.png'), fullPage: true });
});
