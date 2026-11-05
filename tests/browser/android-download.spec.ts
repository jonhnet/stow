import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { connected, createNote, card } from './support/sync-faults';

const origin = 'http://localhost:4174';
const apk = '/native/android/stow-1-test.apk';
const release = { android: { version: 1, minSdk: 28, url: apk, sha256: 'a'.repeat(64) } };

test.beforeEach(async ({ context }, info) => {
  await context.addCookies([{ name: 'stow_test_user', value: `android-download-${info.testId}`, url: origin }]);
});

test('Settings discovers and downloads the published APK without leaving the notes', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let checks = 0;
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/release') checks++; });
  await page.goto(origin); await connected(page); await createNote(page, 'Keep this note open');
  expect(checks).toBe(0);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const link = page.getByRole('link', { name: 'Get Android app', exact: true });
  await expect(link).toHaveAttribute('href', apk);
  const bounds = (await link.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
  const downloaded = page.waitForEvent('download');
  await link.click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe('stow-1-test.apk');
  expect(await readFile((await download.path())!, 'utf8')).toBe('test APK download');
  await expect(page.locator('.settings-menu')).toHaveCount(0);
  await expect(card(page, 'Keep this note open')).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/');
});

test('an unpublished APK appears after publication when Settings is reopened', async ({ page }) => {
  let published = false;
  await page.route('**/api/release', route => route.fulfill({ json: published ? release : { android: null } }));
  await page.goto(origin); await connected(page);
  const checked = page.waitForResponse('**/api/release');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await checked;
  await expect(page.getByRole('link', { name: 'Get Android app', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  published = true;
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Get Android app', exact: true })).toBeVisible();
});

test('an unavailable or invalid download does not interrupt notes and can be checked again', async ({ page }) => {
  await page.route('**/api/release', route => route.fulfill({ json: { android: { ...release.android, url: 'https://other.example/app.apk' } } }));
  await page.goto(origin); await connected(page);
  const invalid = page.waitForEvent('console', message => message.text().includes('Android download unavailable:'));
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await invalid;
  await expect(page.getByRole('link', { name: 'Get Android app', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.route('**/api/release', route => route.abort());
  const unavailable = page.waitForEvent('console', message => message.text().includes('Android download unavailable:'));
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await unavailable;
  await page.keyboard.press('Escape');
  await createNote(page, 'Still editable');
  await expect(card(page, 'Still editable')).toBeVisible();
  await page.route('**/api/release', route => route.fulfill({ json: release }));
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Get Android app', exact: true })).toBeVisible();
});
