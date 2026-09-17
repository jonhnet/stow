import { test, expect, type Page } from '@playwright/test';

const origin = 'http://localhost:4174';
const editor = (page: Page) => page.getByRole('dialog', { name: 'Edit note', exact: true });
const connected = (page: Page) => expect(page.locator('.sync-state')).toHaveAttribute('title', 'Connected');
async function create(page: Page, title: string) {
  await page.getByRole('button', { name: 'Take a note…', exact: true }).click();
  await editor(page).getByRole('textbox', { name: 'Note title', exact: true }).fill(title);
  const body = editor(page).getByRole('textbox', { name: 'Note text', exact: true });
  await body.focus(); await body.fill('Saved content');
  await editor(page).getByRole('button', { name: 'Close', exact: true }).click();
  await connected(page);
}

test('real owner locks protect week-idle live tabs, then permit cleanup after a tab closes', async ({ page, context }, info) => {
  await context.addCookies([{ name: 'stow_test_user', value: `retention-${info.testId}@example.test`, url: origin }]);
  await page.goto(origin); await connected(page); await create(page, 'Live owner');
  const other = await context.newPage();
  await other.goto(origin); await connected(other); await create(other, 'Closed owner');
  const firstOwner = await page.evaluate(() => history.state.stowUndo.owner as string);
  const closedOwner = await other.evaluate(() => history.state.stowUndo.owner as string);
  expect(firstOwner).not.toBe(closedOwner);
  await page.evaluate(async () => {
    const request = indexedDB.open(history.state.stowUndo.databaseName);
    await new Promise<void>((resolve, reject) => {
      request.onsuccess = () => {
        const db = request.result, transaction = db.transaction('undo', 'readwrite');
        const cursor = transaction.objectStore('undo').openCursor();
        cursor.onsuccess = () => {
          if (!cursor.result) return;
          cursor.result.update({ ...cursor.result.value, updatedAt: Date.now() - 8 * 24 * 60 * 60 * 1000 });
          cursor.result.continue();
        };
        transaction.oncomplete = () => { db.close(); resolve(); }; transaction.onabort = () => reject(transaction.error);
      };
      request.onerror = () => reject(request.error);
    });
  });
  const newcomer = await context.newPage(); await newcomer.goto(origin); await connected(newcomer);
  const owners = () => newcomer.evaluate(async () => {
    const request = indexedDB.open(history.state.stowUndo.databaseName);
    return new Promise<string[]>((resolve, reject) => {
      request.onsuccess = () => {
        const db = request.result, keys = db.transaction('undo').objectStore('undo').getAllKeys();
        keys.onsuccess = () => { db.close(); resolve(keys.result as string[]); }; keys.onerror = () => reject(keys.error);
      };
      request.onerror = () => reject(request.error);
    });
  });
  await expect.poll(owners).toEqual([firstOwner, closedOwner].sort());
  await other.close(); await newcomer.reload(); await connected(newcomer);
  await expect.poll(owners).toEqual([firstOwner]);
  await expect(newcomer.locator('header').getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await expect(newcomer.getByRole('article', { name: 'Open note: Closed owner', exact: true })).toContainText('Saved content');
  await page.locator('header').getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('.toast')).toContainText('Undid:');
  await expect(page.getByRole('article', { name: 'Open note: Live owner', exact: true })).not.toContainText('Saved content');
});
