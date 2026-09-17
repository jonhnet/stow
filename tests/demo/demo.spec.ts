import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildDir } from '../../paths';

const origin = 'http://localhost:4175';
const notice = (page: Page) => page.getByRole('complementary', { name: 'Demo: edits are not saved' });
const card = (page: Page, title: string) => page.getByRole('article', { name: `Open note: ${title}`, exact: true });
const packing = 'Packing for a diplomatic mission to the refrigerator';
const committee = 'Minutes of the emergency kitten committee';

async function guardSideEffects(page: Page) {
  await page.addInitScript(() => {
    const attempts: string[] = [];
    Object.assign(window, { demoAttempts: attempts });
    const deny = (name: string) => function () { attempts.push(name); throw new Error(`Demo attempted ${name}`); };
    window.fetch = deny('fetch');
    window.WebSocket = deny('WebSocket') as unknown as typeof WebSocket;
    window.Worker = deny('Worker') as unknown as typeof Worker;
    window.BroadcastChannel = deny('BroadcastChannel') as unknown as typeof BroadcastChannel;
    indexedDB.open = deny('IndexedDB');
    Storage.prototype.setItem = deny('persistent storage');
    // Yjs/lib0 reads these optional logging flags at module initialization.
    // Any account, note, or UI-preference lookup is still forbidden.
    Storage.prototype.getItem = function (key) {
      if (['production', 'node_env', 'no-color', 'log'].includes(key)) return null;
      return deny(`persistent storage read: ${key}`)();
    };
    navigator.sendBeacon = deny('beacon');
    navigator.serviceWorker.register = deny('service worker');
  });
}

test('real editing, checklist Undo, search and export work with all persistence and sync unavailable', async ({ page }, info) => {
  await guardSideEffects(page);
  const requests: { path: string; method: string }[] = [];
  page.on('request', request => requests.push({ path: new URL(request.url()).pathname, method: request.method() }));
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/?startup-profile=1');
  await expect(notice(page)).toContainText('never saved on the server or synchronized');
  await expect(card(page, packing)).toBeVisible();
  await page.screenshot({ path: info.outputPath('demo-desktop.png') });
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  const check = card(page, packing).getByRole('checkbox').first();
  const checked = await check.isChecked(); await check.click();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(card(page, packing).getByRole('checkbox').first()).toBeChecked({ checked });
  await card(page, committee).getByRole('heading').click();
  await page.getByRole('textbox', { name: 'Note title', exact: true }).fill('My disposable committee');
  const body = page.getByRole('textbox', { name: 'Note text', exact: true }); await body.focus(); await body.fill('The aubergine has requested diplomatic immunity.');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Search notes' }).fill('aubergine');
  await expect(card(page, 'My disposable committee')).toBeVisible();
  await page.getByRole('button', { name: 'Clear search', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.locator('.settings-sync')).toContainText('not saved or synchronized');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export current notes', exact: true }).click();
  const file = await download; const filePath = info.outputPath('demo-export.md'); await file.saveAs(filePath);
  expect(readFileSync(filePath, 'utf8')).toContain('The aubergine has requested diplomatic immunity.');
  await page.clock.install(); await page.clock.fastForward(3_600_000);
  await expect(card(page, 'My disposable committee')).toBeVisible(); // No timer expires the demo.
  expect(await page.evaluate(() => (window as any).demoAttempts)).toEqual([]);
  expect(errors).toEqual([]);
  expect(requests.every(request => request.method === 'GET' && !/^\/(api|sync)(\/|$)/.test(request.path))).toBe(true);
});

test('new tabs are independent and refresh, Start fresh, and returning via history discard edits', async ({ page, context }) => {
  await page.goto('/'); await card(page, committee).getByRole('heading').click();
  await page.getByRole('textbox', { name: 'Note title', exact: true }).fill('Private to this tab');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  const other = await context.newPage(); await other.goto(origin);
  await expect(card(other, committee)).toBeVisible(); await expect(card(other, 'Private to this tab')).toHaveCount(0);
  await page.reload(); await expect(card(page, committee)).toBeVisible(); await expect(card(page, 'Private to this tab')).toHaveCount(0);
  await card(page, committee).getByRole('heading').click();
  await page.getByRole('textbox', { name: 'Note title', exact: true }).fill('Discard by reset');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await notice(page).getByRole('button', { name: 'Start fresh' }).click();
  await expect(card(page, committee)).toBeVisible(); await expect(card(page, 'Discard by reset')).toHaveCount(0);
  await card(page, committee).getByRole('heading').click();
  await page.getByRole('textbox', { name: 'Note title', exact: true }).fill('Discard on leaving');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.goto('/icon.svg'); await page.goBack();
  await expect(card(page, committee)).toBeVisible(); await expect(card(page, 'Discard on leaving')).toHaveCount(0);
  expect(await context.cookies()).toEqual([]);
  expect(await page.evaluate(async () => ({ databases: await indexedDB.databases(), local: localStorage.length, session: sessionStorage.length, workers: (await navigator.serviceWorker.getRegistrations()).length }))).toEqual({ databases: [], local: 0, session: 0, workers: 0 });
  await other.close();
});

test('kitten images open from bundled files and unsupported features explain the demo limits', async ({ page }) => {
  await guardSideEffects(page); await page.goto('/');
  await expect(page.getByRole('button', { name: 'New note with image', exact: true })).toBeDisabled();
  const picture = page.locator('.card-images img').first(); await expect(picture).toBeVisible();
  await expect.poll(() => picture.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  const url = await picture.getAttribute('src'); expect(url).toMatch(/^\/assets\/\d\d-.*\.webp$/);
  await picture.click();
  await expect(page.getByRole('dialog', { name: /^Original image:/ }).locator('img')).toHaveAttribute('src', url!);
  await page.getByRole('button', { name: 'Close image', exact: true }).click();
  await card(page, committee).getByRole('heading').click();
  await expect(page.getByRole('button', { name: 'Add image', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'More note actions', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Version history', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Version history', exact: true })).toHaveAttribute('title', /unavailable in the demo/);
  await page.keyboard.press('Escape'); await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Storage and history', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Download vault backup', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Install Stow', exact: true })).toHaveCount(0);
  await expect(notice(page).getByRole('link', { name: 'Install Stow' })).toHaveAttribute('href', 'https://github.com/jonhnet/stow#readme');
  expect(await page.evaluate(() => (window as any).demoAttempts)).toEqual([]);
});

test('the warning stays visible on phones, including collapsed and while editing', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/');
  await expect(notice(page)).toContainText('Keep your real notes elsewhere');
  await page.screenshot({ path: info.outputPath('demo-phone-expanded.png') });
  await notice(page).getByRole('button', { name: /DEMO/ }).click();
  await expect(notice(page)).toContainText('Changes aren’t saved or synced');
  await expect(notice(page)).not.toContainText('Keep your real notes elsewhere');
  await card(page, committee).getByRole('heading').click();
  await expect(notice(page)).toBeVisible();
  const banner = await notice(page).boundingBox(), editor = await page.getByRole('dialog', { name: 'Edit note' }).boundingBox();
  expect(banner!.x).toBeGreaterThanOrEqual(0); expect(banner!.width).toBeLessThanOrEqual(390);
  expect(editor!.y).toBeGreaterThanOrEqual(banner!.y + banner!.height);
  await expect(page.locator('.modal-backdrop')).toHaveCSS('opacity', '1');
  await page.screenshot({ path: info.outputPath('demo-phone.png') });
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await notice(page).getByRole('button', { name: /DEMO/ }).click();
  await page.locator('.card-images img').first().click();
  const close = page.getByRole('button', { name: 'Close image', exact: true });
  await expect(close).toBeVisible();
  const expandedBanner = await notice(page).boundingBox(), closeButton = await close.boundingBox();
  expect(closeButton!.y).toBeGreaterThanOrEqual(expandedBanner!.y + expandedBanner!.height);
  await close.click();
});

test('pasting or dropping images is rejected without creating notes or attachments', async ({ page }) => {
  await guardSideEffects(page); await page.goto('/');
  await expect(card(page, committee)).toBeVisible();
  const count = await page.getByRole('article').count();
  for (const action of ['paste', 'drop'] as const) {
    await page.locator('.composer').evaluate((element, action) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(['not uploaded'], 'private.png', { type: 'image/png' }));
      // Firefox strips files from a constructed, untrusted ClipboardEvent.
      // Supply the same clipboardData a real OS paste delivers to the handler.
      const event = new Event(action, { bubbles: true, cancelable: true });
      Object.defineProperty(event, action === 'paste' ? 'clipboardData' : 'dataTransfer', { value: transfer });
      element.dispatchEvent(event);
    }, action);
    await expect(page.getByRole('status').filter({ hasText: 'Image uploads are unavailable in the demo' })).toBeVisible();
    await expect(page.getByRole('article')).toHaveCount(count);
    await expect(page.getByRole('dialog', { name: 'Edit note' })).toHaveCount(0);
  }
  await card(page, committee).getByRole('heading').click();
  const editor = page.getByRole('dialog', { name: 'Edit note' });
  // Also exercise the callback behind the disabled chooser, so a UI regression
  // cannot accidentally fall through to the normal image service.
  await editor.locator('input[type=file]').setInputFiles({ name: 'private.png', mimeType: 'image/png', buffer: Buffer.from('not uploaded') });
  await expect(page.getByRole('status').filter({ hasText: 'Image uploads are unavailable in the demo' })).toBeVisible();
  await expect(editor.locator('.note-image')).toHaveCount(0);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => (window as any).demoAttempts)).toEqual([]);
});

test('archive, restore and permanent deletion work without persistence', async ({ page }) => {
  await guardSideEffects(page); await page.goto('/');
  await card(page, committee).hover();
  await card(page, committee).getByRole('button', { name: 'Archive note', exact: true }).click();
  await page.getByRole('button', { name: 'Archive', exact: true }).click();
  await expect(card(page, committee)).toBeVisible();
  await page.getByRole('button', { name: 'Trash', exact: true }).click();
  const discarded = 'Shopping list for an imaginary dragon';
  await card(page, discarded).hover();
  await card(page, discarded).getByRole('button', { name: 'Restore note', exact: true }).click();
  await expect(card(page, discarded)).toHaveCount(0);
  await page.getByRole('button', { name: 'Empty trash', exact: true }).click();
  await page.getByRole('alertdialog', { name: 'Empty trash?' }).getByRole('button', { name: 'Empty trash', exact: true }).click();
  await expect(page.getByRole('article')).toHaveCount(0);
  await page.getByRole('button', { name: 'Notes', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Search notes' }).fill(discarded);
  await expect(card(page, discarded)).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Trash', exact: true }).click();
  await expect(page.getByRole('article')).toHaveCount(3);
  expect(await page.evaluate(() => (window as any).demoAttempts)).toEqual([]);
});

test('the browser policy blocks network APIs even for readable same-origin files', async ({ page }) => {
  await page.goto('/'); await expect(notice(page)).toBeVisible();
  expect(await page.evaluate(async () => {
    try { await fetch('/icon.svg'); return 'unexpected network access'; }
    catch { return 'blocked'; }
  })).toBe('blocked');
});

test('the static artifact has no offline installer and the host exposes no writable routes', async ({ request }) => {
  const html = await request.get('/'); expect(html.status()).toBe(200);
  expect(await html.text()).toContain("connect-src 'none'");
  expect(await html.text()).not.toContain('manifest.webmanifest');
  for (const route of ['/api/session', '/api/blobs/test', '/sync', '/sw.js', '/manifest.webmanifest', '/.env']) expect((await request.get(route)).status()).toBe(404);
  expect((await request.post('/api/session', { data: 'do not store me' })).status()).toBe(405);
  expect((await request.put('/assets/notes', { data: 'do not store me' })).status()).toBe(405);
  const code = readFileSync(path.join(buildDir, 'demo/index.html'), 'utf8'); expect(code).not.toContain('/src/');
});
