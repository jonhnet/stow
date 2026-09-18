import { test, expect, type Page } from '@playwright/test';

const ORIGIN = 'http://localhost:4174';
const card = (page: Page) => page.getByRole('article', { name: 'Open note: Image viewing policy', exact: true });

test('overview images open their note; originals open on a second click and remain available offline', async ({ browser }) => {
  const author = await browser.newContext(), reader = await browser.newContext();
  try {
    for (const context of [author, reader]) await context.addCookies([{ name: 'stow_test_user', value: 'media-viewing@example.test', url: ORIGIN }]);
    const page = await author.newPage();
    await page.goto(ORIGIN);
    await expect(page.locator('.sync-state')).toHaveAttribute('title', 'Connected');
    await page.getByRole('button', { name: 'Take a note…', exact: true }).click();
    await page.getByRole('textbox', { name: 'Note title', exact: true }).fill('Image viewing policy');
    const images = await page.evaluate(() => ['#00a0c0', '#f0a000'].map(color => {
      const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 48;
      const context = canvas.getContext('2d')!; context.fillStyle = color; context.fillRect(0, 0, 64, 48);
      return Array.from(atob(canvas.toDataURL('image/png').split(',')[1]), character => character.charCodeAt(0));
    }));
    await page.getByRole('dialog', { name: 'Edit note', exact: true }).locator('input[type=file]').setInputFiles(images.map((bytes, index) => ({ name: `drawing-${index + 1}.png`, mimeType: 'image/png', buffer: Buffer.from(bytes) })));
    await expect(page.getByRole('dialog', { name: 'Edit note', exact: true }).locator('img')).toHaveCount(2);
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(page.locator('.sync-state')).toHaveAttribute('title', 'Connected');
    const remote = await reader.newPage();
    const originalRequests: string[] = [];
    remote.on('request', request => { if (request.method() === 'GET' && /^\/api\/blobs\/[a-f0-9]{64}$/.test(new URL(request.url()).pathname)) originalRequests.push(request.url()); });
    await remote.goto(ORIGIN);
    await expect(card(remote).getByRole('img', { name: 'drawing-1.png', exact: true })).toBeVisible();
    await expect(card(remote).getByRole('img', { name: 'drawing-2.png', exact: true })).toBeVisible();
    expect(originalRequests).toEqual([]);
    await card(remote).getByRole('img', { name: 'drawing-1.png', exact: true }).click();
    const editor = remote.getByRole('dialog', { name: 'Edit note', exact: true });
    const original = remote.getByRole('dialog', { name: 'Original image: drawing-1.png', exact: true });
    await expect(editor).toBeVisible();
    await expect(original).toHaveCount(0);
    expect(originalRequests).toEqual([]);
    await editor.getByRole('button', { name: 'Open original: drawing-1.png', exact: true }).click();
    await expect(original.getByRole('img', { name: 'drawing-1.png', exact: true })).toBeVisible();
    await expect.poll(() => originalRequests.length).toBe(1);
    await remote.keyboard.press('Escape');
    await expect(original).toHaveCount(0);
    await expect(editor).toBeVisible();
    await editor.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(remote.getByRole('dialog')).toHaveCount(0);
    await card(remote).getByRole('button', { name: 'Select note', exact: true }).click();
    await expect(card(remote)).toHaveClass(/selected/);
    await card(remote).getByRole('img', { name: 'drawing-1.png', exact: true }).click();
    await expect(card(remote)).not.toHaveClass(/selected/);
    await expect(remote.getByRole('dialog')).toHaveCount(0);
    await remote.evaluate(async () => { await navigator.serviceWorker.ready; });
    await reader.setOffline(true);
    await remote.reload();
    await expect(card(remote).getByRole('img', { name: 'drawing-1.png', exact: true })).toBeVisible();
    await card(remote).getByRole('img', { name: 'drawing-1.png', exact: true }).click();
    await expect(editor).toBeVisible();
    await expect(original).toHaveCount(0);
    await editor.getByRole('button', { name: 'Open original: drawing-1.png', exact: true }).click();
    await expect(original.getByRole('img', { name: 'drawing-1.png', exact: true })).toBeVisible();
    await remote.getByRole('button', { name: 'Close image' }).click();
    await editor.getByRole('button', { name: 'Open original: drawing-2.png', exact: true }).click();
    const unavailable = remote.getByRole('dialog', { name: 'Original image: drawing-2.png', exact: true });
    await expect(unavailable).toContainText('Connect to download it.');
    await expect(unavailable.locator('img')).toHaveCount(0);
    expect(originalRequests).toHaveLength(1);
  } finally { await Promise.all([author.close(), reader.close()]); }
});

test('offline image removal keeps the original available to Undo after reload without saved history', async ({ page, context }) => {
  await context.addCookies([{ name: 'stow_test_user', value: 'image-undo-offline@example.test', url: ORIGIN }]);
  await page.goto(ORIGIN);
  await expect(page.locator('.sync-state')).toHaveAttribute('title', 'Connected');
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.getByRole('button', { name: 'Take a note…', exact: true }).click();
  await page.getByRole('textbox', { name: 'Note title', exact: true }).fill('Offline image undo');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.locator('.sync-state')).toHaveAttribute('title', 'Connected');
  await context.setOffline(true);
  await page.getByRole('article', { name: 'Open note: Offline image undo', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Edit note', exact: true });
  const bytes = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 40; canvas.height = 30;
    const ctx = canvas.getContext('2d')!; ctx.fillStyle = '#652ab1'; ctx.fillRect(0, 0, 40, 30);
    return Array.from(atob(canvas.toDataURL('image/png').split(',')[1]), c => c.charCodeAt(0));
  });
  await editor.locator('input[type=file]').setInputFiles({ name: 'offline.png', mimeType: 'image/png', buffer: Buffer.from(bytes) });
  await expect(editor.getByRole('img', { name: 'offline.png', exact: true })).toBeVisible();
  await editor.getByRole('button', { name: 'Remove offline.png', exact: true }).click();
  await expect(editor.locator('img')).toHaveCount(0);
  // Allow the asynchronous image-pruning pass to finish before exercising Undo.
  await page.waitForTimeout(1200);
  await page.reload();
  await editor.locator('.editor-toolbar').getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(editor.getByRole('img', { name: 'offline.png', exact: true })).toBeVisible();
  await editor.getByRole('button', { name: 'Open original: offline.png', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Original image: offline.png', exact: true }).getByRole('img', { name: 'offline.png', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close image', exact: true }).click();
  await editor.getByRole('button', { name: 'Close', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('article', { name: 'Open note: Offline image undo', exact: true }).getByRole('img', { name: 'offline.png', exact: true })).toBeVisible();
});
