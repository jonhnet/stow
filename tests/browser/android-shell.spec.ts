import { test, expect, type Page } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { createNote, connected, card } from './support/sync-faults';
const origin = 'http://localhost:4174';

async function signal(page: Page, message: object) {
  await page.evaluate(message => window.dispatchEvent(new CustomEvent('stow-shell', { detail: message })), message);
}
const activations = (page: Page) => page.evaluate(() => (window as any).shellMessages.filter((m: any) => m.type === 'activate'));

test.beforeEach(async ({ context }, info) => {
  await context.addCookies([{ name: 'stow_test_user', value: `shell-${info.testId}`, url: origin }]);
  const verifier = randomBytes(32).toString('hex');
  const pairing = await (await context.request.post(origin + '/native/device/start', { data: { name: 'Browser shell test', challenge: createHash('sha256').update(verifier).digest('hex') } })).json();
  expect((await context.request.post(origin + '/api/devices/approve', { data: { requestId: pairing.requestId, code: pairing.code } })).status()).toBe(200);
  const grant = await (await context.request.post(origin + '/native/device/token', { data: { requestId: pairing.requestId, verifier } })).json();
  await context.addCookies([{ name: 'stow_device', value: grant.token, domain: 'localhost', path: '/native/', httpOnly: true, sameSite: 'Strict' }]);
  await context.addInitScript(account => {
    Object.assign(window, { __STOW_SHELL__: { api: 1, version: 1, release: 'a'.repeat(64), account }, shellMessages: [], StowShell: { postMessage(message: string) { (window as any).shellMessages.push(JSON.parse(message)); } } });
  }, grant.account);
});

test('the installed shell uses its update UI instead of offering an APK download in Settings', async ({ page }) => {
  let checks = 0;
  await page.route('**/native/release.json', route => { checks++; return route.fulfill({ json: { android: null } }); });
  await page.goto(origin); await connected(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Connected Android devices', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Get Android app', exact: true })).toHaveCount(0);
  expect(checks).toBe(0);
});

test('updates wait for editor, composition, pointer, selection and modal to finish; restart saves and restores the filtered view', async ({ page, context }) => {
  await page.goto(origin); await connected(page); await createNote(page, 'Flight plan');
  await signal(page, { type: 'updates', pending: 'b'.repeat(64) });
  await card(page, 'Flight plan').click();
  await signal(page, { type: 'hidden' }); expect(await activations(page)).toEqual([]);
  await expect(page.getByRole('button', { name: 'Restart', exact: true })).toBeDisabled();
  const body = page.getByRole('textbox', { name: 'Note text', exact: true }); await body.focus();
  await context.setOffline(true); await body.fill('Offline edits survive installing new JavaScript');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await signal(page, { type: 'hidden' }); expect(await activations(page)).toEqual([]);
  await page.keyboard.press('Escape');
  await card(page, 'Flight plan').getByRole('button', { name: 'Select note', exact: true }).click();
  await signal(page, { type: 'hidden' }); expect(await activations(page)).toEqual([]);
  await page.getByRole('button', { name: 'Clear selection', exact: true }).click();
  await page.locator('body').dispatchEvent('dragstart');
  await signal(page, { type: 'hidden' }); expect(await activations(page)).toEqual([]);
  await page.locator('body').dispatchEvent('dragend');
  await page.locator('body').dispatchEvent('compositionstart');
  await signal(page, { type: 'hidden' }); expect(await activations(page)).toEqual([]);
  await page.locator('body').dispatchEvent('compositionend');
  await page.locator('body').dispatchEvent('pointerdown', { pointerId: 41 });
  await signal(page, { type: 'hidden' }); expect(await activations(page)).toEqual([]);
  await page.locator('body').dispatchEvent('pointercancel', { pointerId: 41 });
  await page.getByRole('searchbox').fill('Flight');
  await page.getByRole('button', { name: 'Restart', exact: true }).click();
  await expect.poll(() => activations(page)).toEqual([{ type: 'activate', automatic: false }]);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem(`stow-shell-view:${(window as any).__STOW_SHELL__.account.vaultId}`)!));
  expect(saved.search).toBe('Flight');
  // This browser harness has no native asset interceptor; reconnect only to load
  // the bundle. Force the account request to fail to prove IDB restoration.
  await context.setOffline(false); await page.route('**/native/api/session', route => route.abort());
  await page.reload();
  await expect(page.getByRole('searchbox')).toHaveValue('Flight');
  await expect(card(page, 'Flight plan')).toContainText('Offline edits survive installing new JavaScript');
  await expect.poll(() => page.evaluate(() => localStorage.getItem(`stow-shell-view:${(window as any).__STOW_SHELL__.account.vaultId}`))).toBeNull();
});

test('a safely hidden view requests activation; a shell update uses the same edit barrier', async ({ page }) => {
  await page.goto(origin); await connected(page); await createNote(page, 'Trip');
  await signal(page, { type: 'updates', android: { version: 2, minSdk: 28 }, pending: 'b'.repeat(64) });
  await card(page, 'Trip').click();
  await expect(page.getByRole('button', { name: 'Update', exact: true })).toBeDisabled();
  await signal(page, { type: 'hidden' }); expect(await activations(page)).toEqual([]);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await signal(page, { type: 'hidden' });
  await expect.poll(() => activations(page)).toEqual([{ type: 'activate', automatic: true }]);
});

test('activation restores the visible note and scroll position after the new page lays out', async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 700 });
  await page.goto(origin); await connected(page);
  for (let index = 0; index < 12; index++) await createNote(page, `Scroll note ${index}`, 'A long paragraph. '.repeat(30));
  await signal(page, { type: 'updates', pending: 'b'.repeat(64) });
  await page.evaluate(() => window.scrollTo(0, 1300));
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(1300);
  await signal(page, { type: 'hidden' });
  await expect.poll(() => activations(page)).toEqual([{ type: 'activate', automatic: true }]);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem(`stow-shell-view:${window.__STOW_SHELL__!.account.vaultId}`)!));
  expect(saved.anchor).toBeTruthy();
  await page.reload();
  await expect.poll(() => page.evaluate(() => localStorage.getItem(`stow-shell-view:${window.__STOW_SHELL__!.account.vaultId}`))).toBeNull();
  const anchor = page.locator(`[data-note-id="${saved.anchor.id}"]`);
  expect(Math.abs((await anchor.boundingBox())!.y - saved.anchor.offset)).toBeLessThan(2);
});

test('browser pairing shows the account, requires the displayed code, and can revoke a device', async ({ page, context }) => {
  const verifier = randomBytes(32).toString('hex');
  const pairing = await (await context.request.post(origin + '/native/device/start', { data: { name: 'New tablet', challenge: createHash('sha256').update(verifier).digest('hex') } })).json();
  await page.goto(origin + pairing.approvalPath);
  await expect(page.getByRole('heading', { name: 'Connect Android Stow' })).toBeVisible();
  await page.getByLabel('Pairing code').fill('WRONG'); await page.getByRole('button', { name: 'Connect device' }).click();
  await expect(page.getByRole('alert')).toContainText('does not match');
  await page.getByLabel('Pairing code').fill(pairing.code); await page.getByRole('button', { name: 'Connect device' }).click();
  await expect(page.getByText('Device connected. Return to the Android app.')).toBeVisible();
  const grant = await (await context.request.post(origin + '/native/device/token', { data: { requestId: pairing.requestId, verifier } })).json();
  await page.goto(origin + '/device.html');
  await page.getByRole('button', { name: 'Revoke New tablet' }).click();
  await expect(page.getByRole('button', { name: 'Revoke New tablet' })).toHaveCount(0);
  expect((await context.request.get(origin + '/native/api/session', { headers: { Authorization: `StowDevice ${grant.token}` } })).status()).toBe(401);
});
