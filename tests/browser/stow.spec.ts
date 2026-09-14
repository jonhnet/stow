import { test, expect, type Page } from '@playwright/test';

const card = (page: Page, title: string) => page.getByRole('article', { name: `Open note: ${title}`, exact: true });
async function createText(page: Page, title: string, body: string) {
  await page.getByRole('button', { name: 'Take a note…', exact: true }).click();
  await page.getByRole('textbox', { name: 'Note title', exact: true }).fill(title);
  await page.getByRole('textbox', { name: 'Note text', exact: true }).focus();
  await page.getByRole('textbox', { name: 'Note text', exact: true }).fill(body);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(card(page, title)).toBeVisible();
}
async function ready(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Take a note…', exact: true })).toBeVisible();
  await expect(page.locator('.sync-state')).toHaveClass(/sync-online/);
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
}

test('capture, edit, link, search, archive, undo, and durable history', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await ready(page);
  await createText(page, 'Reading queue', 'Read https://example.com\nWrite something worth keeping.');
  await expect(card(page, 'Reading queue').getByRole('link')).toHaveCount(0);
  await card(page, 'Reading queue').click();
  await expect(page.getByRole('dialog').getByRole('link')).toHaveAttribute('href', 'https://example.com/');
  await page.getByRole('dialog').getByRole('textbox', { name: 'Note text', exact: true }).focus();
  await page.getByRole('dialog').getByRole('textbox', { name: 'Note text', exact: true }).fill('Read https://example.com\nUpdated reading list.');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('searchbox', { name: 'Search notes' }).fill('updated reading');
  await expect(card(page, 'Reading queue')).toBeVisible();
  await page.getByRole('button', { name: 'Clear search' }).click();
  await card(page, 'Reading queue').hover();
  await card(page, 'Reading queue').getByRole('button', { name: 'Archive note', exact: true }).click();
  await expect(card(page, 'Reading queue')).toHaveCount(0);
  await page.locator('header').getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(card(page, 'Reading queue')).toBeVisible();
  await page.reload();
  await expect(card(page, 'Reading queue')).toBeVisible();
  await card(page, 'Reading queue').click();
  await page.getByRole('button', { name: 'More note actions' }).click();
  await page.getByRole('button', { name: 'Version history', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Version history' })).toBeVisible();
  const revision = page.locator('.revision-card').first();
  await revision.getByRole('button', { name: 'Restore copy' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(card(page, 'Reading queue')).toHaveCount(2);
  expect(errors).toEqual([]);
});

test('separate devices merge notes and recover offline checkbox edits after a full offline reload', async ({ page, browser }) => {
  await ready(page);
  await page.getByRole('button', { name: 'New checklist' }).click();
  await page.getByRole('textbox', { name: 'Note title', exact: true }).fill('Packing list');
  await page.getByRole('textbox', { name: 'New list item', exact: true }).fill('Passport');
  await page.keyboard.press('Enter');
  await page.getByRole('textbox', { name: 'List item text', exact: true }).last().fill('Charger');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await createText(page, 'Trip details', 'Train at 09:30');
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const mobile = await phone.newPage();
  await ready(mobile);
  await expect(card(mobile, 'Packing list')).toBeVisible();
  await phone.setOffline(true);
  await card(mobile, 'Packing list').getByRole('checkbox', { name: 'Passport' }).click();
  await expect(card(mobile, 'Packing list')).toContainText('1 completed item');
  await expect(mobile.locator('.sync-state')).toHaveAttribute('title', 'Offline — notes stored on this device');
  await mobile.reload();
  await expect(card(mobile, 'Packing list')).toContainText('1 completed item');
  await card(page, 'Packing list').hover();
  await card(page, 'Packing list').getByRole('button', { name: 'Select note', exact: true }).click();
  await card(page, 'Trip details').hover();
  await card(page, 'Trip details').getByRole('button', { name: 'Select note', exact: true }).click();
  await page.getByRole('button', { name: 'Merge notes' }).click();
  await page.getByRole('dialog').getByRole('textbox', { name: 'Note text', exact: true }).focus();
  await expect(page.getByRole('dialog').getByRole('textbox', { name: 'Note text', exact: true })).toHaveValue('Trip details\n\n\n\nTrain at 09:30');
  await page.keyboard.press('Escape');
  await phone.setOffline(false);
  await expect(card(page, 'Packing list')).toContainText('1 completed item');
  await expect(card(mobile, 'Packing list')).toContainText('Train at 09:30');
  await expect(card(mobile, 'Trip details')).toHaveCount(0);
  await mobile.screenshot({ path: test.info().outputPath('stow-phone.png'), fullPage: true });
  await page.screenshot({ path: test.info().outputPath('stow-desktop.png'), fullPage: true });
  await phone.close();
});

test('new notes autosave before closing the editor and a new checklist row survives Escape', async ({ page }) => {
  await ready(page);
  await page.getByRole('button', { name: 'Take a note…', exact: true }).click();
  await page.getByRole('textbox', { name: 'Note title', exact: true }).fill('Unclosed draft');
  await page.getByRole('textbox', { name: 'Note text', exact: true }).focus();
  await page.getByRole('textbox', { name: 'Note text', exact: true }).fill('This must survive a reload.');
  await expect(page.locator('.sync-state')).toHaveAttribute('title', 'Connected');
  await page.reload();
  await expect(card(page, 'Unclosed draft')).toContainText('This must survive a reload.');
  await card(page, 'Unclosed draft').click();
  await page.getByRole('dialog').getByRole('textbox', { name: 'Note text', exact: true }).focus();
  await page.getByRole('dialog').getByRole('textbox', { name: 'Note text', exact: true }).fill('An edit to undo.');
  await page.keyboard.press('Control+z');
  await expect(page.getByRole('dialog').getByRole('textbox', { name: 'Note text', exact: true })).toHaveValue('This must survive a reload.');
  await page.getByRole('button', { name: 'Add checklist', exact: true }).click();
  await page.getByRole('textbox', { name: 'New list item', exact: true }).pressSequentially('A fast new item', { delay: 5 });
  await page.keyboard.press('Escape');
  await expect(card(page, 'Unclosed draft')).toContainText('A fast new item');
  await expect(card(page, 'Unclosed draft').getByRole('checkbox')).toHaveCount(1);
});

test('images transfer to another device and remain visible after reopening offline', async ({ page, browser }) => {
  await ready(page);
  await createText(page, 'Image cache check', 'A picture to keep offline.');
  await card(page, 'Image cache check').click();
  await page.getByRole('dialog').locator('input[type=file]').setInputFiles({ name: 'pixel.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4////fwAJ+wP9CNHoHgAAAABJRU5ErkJggg==', 'base64') });
  await expect(page.getByRole('dialog').getByRole('img', { name: 'pixel.png' })).toBeVisible();
  await page.keyboard.press('Escape');
  const second = await browser.newContext();
  const remote = await second.newPage();
  await ready(remote);
  await expect(card(remote, 'Image cache check').getByRole('img', { name: 'pixel.png' })).toBeVisible();
  await expect.poll(() => card(remote, 'Image cache check').getByRole('img', { name: 'pixel.png' }).evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1);
  await second.setOffline(true);
  await remote.reload();
  await expect(card(remote, 'Image cache check').getByRole('img', { name: 'pixel.png' })).toBeVisible();
  await second.close();
});

test('a local storage write failure is visible and keeps the active editor usable', async ({ page }) => {
  await page.addInitScript(() => {
    const NativeWorker = Worker;
    (window as any).__failPersistenceWrites = false;
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        if (options?.name !== 'stow-persistence') return;
        const post = this.postMessage.bind(this);
        this.postMessage = (request: { id: number }) => {
          if (!(window as any).__failPersistenceWrites) { post(request); return; }
          queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', {
            data: { id: request.id, error: { name: 'QuotaExceededError', message: 'Simulated full disk' } },
          })));
        };
      }
    };
  });
  await page.goto('/');
  await expect(page.locator('.sync-state')).toHaveAttribute('title', 'Connected');
  await page.evaluate(() => { (window as any).__failPersistenceWrites = true; });
  await page.getByRole('button', { name: 'Take a note…', exact: true }).click();
  await page.getByRole('textbox', { name: 'Note title', exact: true }).fill('Unsaved note');
  await expect(page.getByText(/Local storage failed/).first()).toBeVisible();
  await expect(page.locator('.toast')).toContainText(/Local storage failed/);
  await expect(page.locator('.toast').getByRole('button', { name: 'Undo', exact: true })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Note title', exact: true })).toBeVisible();
});
