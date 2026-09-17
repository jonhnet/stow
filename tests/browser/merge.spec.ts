import { test, expect, type Locator, type Page } from '@playwright/test';
import * as Y from 'yjs';
import { Vault } from '../../src/core/vault';

const ORIGIN = 'http://localhost:4174';
const card = (page: Page, title: string) => page.getByRole('article', { name: `Open note: ${title}`, exact: true });
const editor = (page: Page) => page.getByRole('dialog', { name: 'Edit note', exact: true });
const row = (dialog: Locator, text: string) => dialog.locator('[data-check-row]').filter({ has: dialog.page().getByRole('button', { name: `Reorder ${text}`, exact: true }) });
const itemOrder = (dialog: Locator) => dialog.locator('.item-drag-handle').evaluateAll(handles => handles.map(handle => handle.getAttribute('aria-label')!.slice('Reorder '.length)));

async function create(page: Page, title: string, body: string, item: string) {
  await page.getByRole('button', { name: 'New checklist', exact: true }).click();
  const draft = page.getByRole('dialog', { name: 'Edit note', exact: true });
  await draft.getByRole('textbox', { name: 'Note title', exact: true }).fill(title);
  const text = draft.getByRole('textbox', { name: 'Note text', exact: true });
  await text.focus(); await text.fill(body);
  await draft.getByRole('textbox', { name: 'New list item', exact: true }).fill(item);
  await draft.getByRole('button', { name: 'Close', exact: true }).click();
}

async function drag(page: Page, dialog: Locator, text: string, target: string, side: 'before' | 'after') {
  const start = (await dialog.getByRole('button', { name: `Reorder ${text}`, exact: true }).boundingBox())!;
  const end = (await row(dialog, target).boundingBox())!;
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(start.x + start.width / 2, side === 'before' ? end.y + 3 : end.y + end.height - 3, { steps: 10 });
  await page.mouse.up();
}

test.beforeEach(async ({ context }, testInfo) => {
  await context.addCookies([{ name: 'stow_test_user', value: `flat-merge-${testInfo.testId}@example.test`, url: ORIGIN }]);
});

test('selection order produces one ordinary note with freely movable items and editable, searchable, copyable text', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto(ORIGIN);
  await create(page, 'Title A', 'Body A removable', 'Item A');
  await create(page, 'Title B', 'Body B', 'Item B');
  await create(page, 'Title C', 'Body C', 'Item C');
  for (const title of ['Title B', 'Title A', 'Title C']) await card(page, title).getByRole('button', { name: 'Select note', exact: true }).click();
  await page.getByRole('button', { name: 'Merge notes', exact: true }).click();
  const dialog = editor(page);
  await expect(dialog.getByRole('textbox', { name: 'Note title', exact: true })).toHaveValue('Title B');
  await expect(dialog.locator('.editor-title-row')).toHaveCount(1);
  await expect(dialog.locator('.editor-checklist')).toHaveCount(1);
  await expect(page.locator('.merged-badge, .secondary-section')).toHaveCount(0);
  const text = dialog.getByRole('textbox', { name: 'Note text', exact: true });
  const combined = 'Title A\nTitle C\n\nBody B\n\nBody A removable\n\nBody C';
  await text.focus(); await expect(text).toHaveValue(combined);
  await expect.poll(() => itemOrder(dialog)).toEqual(['Item B', 'Item A', 'Item C']);
  await drag(page, dialog, 'Item C', 'Item B', 'before');
  await expect.poll(() => itemOrder(dialog)).toEqual(['Item C', 'Item B', 'Item A']);
  await row(dialog, 'Item B').getByRole('textbox').focus();
  await page.keyboard.press('Tab');
  await expect(row(dialog, 'Item B')).toHaveClass(/is-child/);
  await drag(page, dialog, 'Item C', 'Item A', 'after');
  await expect.poll(() => itemOrder(dialog)).toEqual(['Item A', 'Item C', 'Item B']);
  await expect(row(dialog, 'Item B')).toHaveClass(/is-child/);
  await page.screenshot({ path: test.info().outputPath('flat-merged-note.png') });

  await text.focus(); await text.fill('Unified replacement\n\n**All together**');
  await page.keyboard.press('Control+z');
  await expect(text).toHaveValue(combined);
  await page.keyboard.press('Control+Shift+z');
  await expect(text).toHaveValue('Unified replacement\n\n**All together**');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.locator('.note-card')).toHaveCount(1);
  await card(page, 'Title B').getByRole('button', { name: 'Select note', exact: true }).click();
  await page.keyboard.press('Control+c');
  await expect(page.locator('.toast')).toContainText('Copied note to clipboard.');
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain('Unified replacement'); expect(copied).toContain('All together');
  expect(copied).not.toContain('Title A'); expect(copied).not.toContain('removable');
  await page.getByRole('button', { name: 'Clear selection', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Search notes' }).fill('removable');
  await expect(page.locator('.note-card')).toHaveCount(0);
  await page.getByRole('searchbox', { name: 'Search notes' }).fill('all together');
  await expect(card(page, 'Title B')).toBeVisible();
  await page.getByRole('button', { name: 'Clear search', exact: true }).click();
  await page.reload();
  await card(page, 'Title B').click();
  await expect.poll(() => itemOrder(editor(page))).toEqual(['Item A', 'Item C', 'Item B']);
  await editor(page).getByRole('textbox', { name: 'Note text', exact: true }).focus();
  await expect(editor(page).getByRole('textbox', { name: 'Note text', exact: true })).toHaveValue('Unified replacement\n\n**All together**');
});

test('existing graph-only merges open as one field and checklist, then retain edits after reload', async ({ page, context }) => {
  const session = await (await context.request.get(`${ORIGIN}/api/session`)).json();
  const vault = new Vault();
  const a = vault.createNote('checklist', { title: 'Legacy first', body: 'Legacy first body' });
  const b = vault.createNote('checklist', { title: 'Legacy second', body: 'Legacy second body' });
  vault.addItem(a, 'Legacy item A'); vault.addItem(b, 'Legacy item B');
  vault.notes.get(a)!.set('createdAt', 100); vault.notes.get(b)!.set('createdAt', 200);
  vault.notes.get(a)!.delete('unifiedChecklist'); vault.notes.get(b)!.delete('unifiedChecklist');
  vault.merges.set('old-merge-edge', { a, b });
  const update = [...Y.encodeStateAsUpdate(vault.doc)];
  vault.destroy();
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
  await card(page, 'Legacy first').click();
  const dialog = editor(page), text = dialog.getByRole('textbox', { name: 'Note text', exact: true });
  await expect(dialog.locator('.editor-title-row')).toHaveCount(1);
  await expect(dialog.locator('.editor-checklist')).toHaveCount(1);
  await text.focus();
  await expect(text).toHaveValue('Legacy second\n\nLegacy first body\n\nLegacy second body');
  await drag(page, dialog, 'Legacy item B', 'Legacy item A', 'before');
  await expect.poll(() => itemOrder(dialog)).toEqual(['Legacy item B', 'Legacy item A']);
  // Re-enter through a real click after the drag's deferred Markdown blur.
  await text.click(); await text.fill('Edited across the former note boundaries.');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await page.reload();
  await card(page, 'Legacy first').click();
  await editor(page).getByRole('textbox', { name: 'Note text', exact: true }).focus();
  await expect(editor(page).getByRole('textbox', { name: 'Note text', exact: true })).toHaveValue('Edited across the former note boundaries.');
  await expect.poll(() => itemOrder(editor(page))).toEqual(['Legacy item B', 'Legacy item A']);
});
