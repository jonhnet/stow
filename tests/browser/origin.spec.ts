import { test, expect } from '@playwright/test';

test('HTTP outside localhost stops before opening the vault or connecting sync', async ({ page }) => {
  const errors: string[] = [];
  const apiRequests: string[] = [];
  const sockets: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) apiRequests.push(request.url()); });
  page.on('websocket', socket => sockets.push(socket.url()));
  await page.goto('http://stow.test:4173');
  expect(await page.evaluate(() => isSecureContext)).toBe(false);
  await expect(page.getByRole('heading', { name: 'Open Stow over HTTPS' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Take a note…' })).toHaveCount(0);
  expect(await page.evaluate(() => indexedDB.databases())).toEqual([]);
  expect(apiRequests).toEqual([]);
  expect(sockets).toEqual([]);
  expect(errors).toEqual([]);
});
