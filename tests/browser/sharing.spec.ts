import { workerGate } from './support/sync-faults';
import { test, expect, type Browser, type Page } from '@playwright/test';
const ORIGIN = 'http://localhost:4174';
const card = (page: Page, title: string) => page.getByRole('article', { name: `Open note: ${title}`, exact: true });
const editor = (page: Page) => page.getByRole('dialog', { name: 'Edit note', exact: true });
const connected = (page: Page) => expect(page.locator('.sync-state')).toHaveAttribute('title', 'Connected');
async function participant(browser: Browser, user?: string) {
  const context = await browser.newContext();
  if (user) await context.addCookies([{ name: 'stow_test_user', value: user, url: ORIGIN }]);
  return { context, page: await context.newPage() };
}
async function publish(page: Page, title: string) {
  await page.goto(ORIGIN); await connected(page);
  await page.getByRole('button', { name: 'New checklist', exact: true }).click();
  await editor(page).getByRole('textbox', { name: 'Note title', exact: true }).fill(title);
  await editor(page).getByRole('textbox', { name: 'New list item', exact: true }).fill('Milk');
  await editor(page).getByRole('button', { name: 'Close', exact: true }).click();
  await connected(page); await card(page, title).click();
  await editor(page).getByRole('button', { name: 'More note actions', exact: true }).click();
  await page.getByRole('button', { name: 'Share note', exact: true }).click();
  await page.getByRole('button', { name: 'Create sharing link', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Sharing link', exact: true });
  await expect(input).toBeVisible(); const url = await input.inputValue();
  await page.getByRole('dialog', { name: 'Share note', exact: true }).getByRole('button', { name: 'Done', exact: true }).click();
  return url;
}
test('publication, explicit add, personal metadata, guest edit, offline reload, and remote-safe undo', async ({ browser }, info) => {
  const alice = await participant(browser, `sharing-alice-${info.testId}`);
  const jeremy = await participant(browser, `sharing-jeremy-${info.testId}`);
  const guest = await participant(browser);
  try {
    const url = await publish(alice.page, 'Shared errands');
    await jeremy.page.goto(url); await connected(jeremy.page);
    await expect(card(jeremy.page, 'Shared errands')).toBeVisible();
    // Merely opening a link does not add it to a collection.
    const personal = await jeremy.context.newPage(); await personal.goto(ORIGIN); await connected(personal);
    await expect(personal.getByRole('article')).toHaveCount(0); await personal.close();
    await jeremy.page.getByRole('button', { name: 'Add to my notes', exact: true }).click();
    await expect(jeremy.page).toHaveURL(`${ORIGIN}/`); await connected(jeremy.page);
    await card(jeremy.page, 'Shared errands').click();
    await editor(jeremy.page).getByRole('button', { name: 'Pin note', exact: true }).click();
    await editor(jeremy.page).getByRole('button', { name: 'Close', exact: true }).click();
    await guest.page.goto(url); await connected(guest.page);
    await expect(card(guest.page, 'Shared errands')).toBeVisible();
    await card(guest.page, 'Shared errands').click();
    await editor(guest.page).getByRole('checkbox', { name: 'Complete Milk', exact: true }).check();
    await editor(guest.page).getByRole('button', { name: 'Close', exact: true }).click();
    await expect(card(alice.page, 'Shared errands')).toContainText('1 completed item');
    await card(alice.page, 'Shared errands').click();
    await expect(editor(alice.page).getByRole('button', { name: 'Pin note', exact: true })).toBeVisible();
    await alice.page.evaluate(async () => { await navigator.serviceWorker.ready; });
    await alice.context.setOffline(true);
    await editor(alice.page).getByRole('textbox', { name: 'Note title', exact: true }).fill('Offline errands');
    await editor(alice.page).getByRole('button', { name: 'Close', exact: true }).click();
    await alice.page.reload();
    await expect(card(alice.page, 'Offline errands')).toBeVisible();
    await alice.context.setOffline(false); await connected(alice.page);
    await expect(card(jeremy.page, 'Offline errands')).toBeVisible();
    await alice.page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(card(alice.page, 'Shared errands')).toContainText('1 completed item');
    await expect(card(jeremy.page, 'Shared errands')).toBeVisible();
  } finally { await alice.context.close(); await jeremy.context.close(); await guest.context.close(); }
});

test('shared images and history survive reference removal, re-add, and restoring a private copy', async ({ browser }, info) => {
  const alice = await participant(browser, `images-alice-${info.testId}`), guest = await participant(browser);
  try {
    const url = await publish(alice.page, 'Photographic evidence');
    await card(alice.page, 'Photographic evidence').click();
    // setInputFiles bypasses the disabled Add image button during shared-scope startup.
    await expect(editor(alice.page).getByRole('button', { name: 'Add image', exact: true })).toBeEnabled();
    await editor(alice.page).locator('input[type=file]').setInputFiles({ name: 'evidence.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4////fwAJ+wP9CNHoHgAAAABJRU5ErkJggg==', 'base64') });
    await expect(editor(alice.page).locator('img').first()).toBeVisible();
    await editor(alice.page).getByRole('button', { name: 'Close', exact: true }).click(); await connected(alice.page);
    await guest.page.goto(url); await connected(guest.page);
    await expect(card(guest.page, 'Photographic evidence').locator('img')).toBeVisible();
    await card(alice.page, 'Photographic evidence').click();
    await editor(alice.page).getByRole('button', { name: 'More note actions', exact: true }).click();
    await editor(alice.page).getByRole('button', { name: 'Move to trash', exact: true }).click();
    await alice.page.getByRole('button', { name: 'Trash', exact: true }).click();
    await card(alice.page, 'Photographic evidence').hover();
    await card(alice.page, 'Photographic evidence').getByRole('button', { name: 'Delete forever', exact: true }).click();
    await alice.page.getByRole('alertdialog', { name: 'Delete note forever?', exact: true }).getByRole('button', { name: 'Delete forever', exact: true }).click();
    await expect(alice.page.getByRole('article')).toHaveCount(0); await connected(alice.page);
    await alice.page.goto(url); await connected(alice.page);
    await alice.page.getByRole('button', { name: 'Add to my notes', exact: true }).click();
    await expect(alice.page).toHaveURL(`${ORIGIN}/`); await connected(alice.page);
    await card(alice.page, 'Photographic evidence').click();
    await expect(editor(alice.page).locator('img')).toBeVisible();
    await editor(alice.page).getByRole('textbox', { name: 'Note title', exact: true }).fill('Re-added evidence');
    await editor(alice.page).getByRole('button', { name: 'Close', exact: true }).click();
    await expect(card(guest.page, 'Re-added evidence')).toBeVisible();
    await card(alice.page, 'Re-added evidence').click();
    await editor(alice.page).getByRole('button', { name: 'More note actions', exact: true }).click();
    await editor(alice.page).getByRole('button', { name: 'Version history', exact: true }).click();
    const history = alice.page.getByRole('dialog', { name: 'Version history', exact: true });
    await history.getByRole('button', { name: 'Restore copy', exact: true }).first().click();
    await expect(editor(alice.page)).toBeVisible();
    await expect(editor(alice.page).locator('img')).toBeVisible();
    await expect(editor(alice.page).getByLabel('Shared note participants')).toHaveCount(0);
    await expect(card(guest.page, 'Re-added evidence')).toBeVisible();
  } finally { await alice.context.close(); await guest.context.close(); }
});

test('invalid links explain the error without opening an account, and a changed account cannot reuse shared offline storage', async ({ browser }, info) => {
  const alice = await participant(browser, `isolation-alice-${info.testId}`);
  try {
    await alice.page.goto(`${ORIGIN}/share#broken`);
    await expect(alice.page.getByRole('alert')).toContainText('Invalid');
    const url = await publish(alice.page, 'Account-scoped sharing');
    await alice.page.goto(url); await connected(alice.page);
    await alice.context.addCookies([{ name: 'stow_test_user', value: `isolation-bob-${info.testId}`, url: ORIGIN }]);
    // Going visible forces the normal account recheck; HTTP uses the new identity.
    await alice.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(alice.page.getByRole('alert')).toContainText('account changed');
    await alice.page.reload(); await connected(alice.page);
    await expect(card(alice.page, 'Account-scoped sharing')).toBeVisible();
    const databases = await alice.page.evaluate(async () => (await indexedDB.databases()).map(db => db.name).filter(name => name?.includes('share_') && name.startsWith('stow-notes-')));
    expect(databases).toHaveLength(2);
  } finally { await alice.context.close(); }
});

test('cancelling preparation is read-only and a lost publication response retries the same identity', async ({ browser }, info) => {
  const alice = await participant(browser, `retry-alice-${info.testId}`);
  try {
    await alice.page.goto(ORIGIN); await connected(alice.page);
    await alice.page.getByRole('button', { name: 'Take a note…', exact: true }).click();
    await editor(alice.page).getByRole('textbox', { name: 'Note title', exact: true }).fill('Retry publication');
    await editor(alice.page).getByRole('button', { name: 'Close', exact: true }).click();
    await card(alice.page, 'Retry publication').click();
    const prepare = async () => {
      await editor(alice.page).getByRole('button', { name: 'More note actions', exact: true }).click();
      await alice.page.getByRole('button', { name: 'Share note', exact: true }).click();
    };
    const capabilities: string[] = [];
    await alice.page.route('**/api/shares/publish', async route => {
      capabilities.push(route.request().postDataJSON().capability);
      if (capabilities.length === 1) { await route.fetch(); await route.abort('failed'); }
      else await route.continue();
    });
    await prepare();
    await alice.page.getByRole('dialog', { name: 'Share note', exact: true }).getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(capabilities).toHaveLength(0);
    await prepare();
    await alice.page.getByRole('button', { name: 'Create sharing link', exact: true }).click();
    await expect(alice.page.getByRole('dialog', { name: 'Share note', exact: true }).getByRole('alert')).toBeVisible();
    await alice.page.getByRole('button', { name: 'Create sharing link', exact: true }).click();
    await expect(alice.page.getByRole('textbox', { name: 'Sharing link', exact: true })).toBeVisible();
    expect(capabilities).toHaveLength(2); expect(capabilities[0]).toBe(capabilities[1]);
    await alice.page.getByRole('dialog', { name: 'Share note', exact: true }).getByRole('button', { name: 'Done', exact: true }).click();
    await expect(alice.page.getByRole('article')).toHaveCount(1);
    await expect(card(alice.page, 'Retry publication').getByLabel('Shared note participants')).toBeVisible();
  } finally { await alice.context.close(); }
});

test('a private-scope update rejection waits for a shared-scope pending local write before automatic reload', async ({ browser }, info) => {
  const alice = await participant(browser, `reload-alice-${info.testId}`);
  try {
    await workerGate(alice.page);
    let reject = false, loads = 0;
    alice.page.on('load', () => loads++);
    await alice.page.route('**/api/session', route => route.continue({ headers: {
      ...route.request().headers(), ...(reject && !route.request().headers()['x-stow-share'] ? { 'x-stow-sync-protocol': '0' } : {}),
    } }));
    await publish(alice.page, 'Wait for shared save'); await connected(alice.page);
    await alice.page.clock.install();
    await alice.context.setOffline(true);
    await alice.page.evaluate(() => { (window as any).syncWorkerGate.pause = true; });
    await card(alice.page, 'Wait for shared save').click();
    await editor(alice.page).getByRole('textbox', { name: 'Note title', exact: true }).fill('Shared save survives reload');
    await expect.poll(() => alice.page.evaluate(() => (window as any).syncWorkerGate.held)).toBeGreaterThan(0);
    reject = true; await alice.context.setOffline(false);
    const notice = alice.page.getByRole('alert', { name: 'Sync stopped' });
    await expect(notice).toContainText('Reload Stow');
    await expect(notice.getByRole('button', { name: 'Reload', exact: true })).toBeDisabled();
    await alice.page.clock.fastForward(6000); expect(loads).toBe(1);
    reject = false;
    await alice.page.evaluate(() => { (window as any).syncWorkerGate.release(); });
    await expect(notice.getByRole('button', { name: 'Reload', exact: true })).toBeEnabled();
    await alice.page.clock.fastForward(6000); await expect.poll(() => loads).toBe(2);
    await connected(alice.page);
    await expect(card(alice.page, 'Shared save survives reload')).toBeVisible();
  } finally { await alice.context.close(); }
});

test('member avatars follow saved references, including offline removal and reconnect', async ({ browser }, info) => {
  const aliceName = `members-alice-${info.testId}`, bobName = `members-bob-${info.testId}`;
  const alice = await participant(browser, aliceName), bob = await participant(browser, bobName), guest = await participant(browser);
  const title = 'Retained membership';
  const avatars = () => card(alice.page, title).locator('.participant-avatar');
  try {
    const url = await publish(alice.page, title);
    await expect(avatars()).toHaveCount(1);
    await bob.page.goto(url); await connected(bob.page);
    await guest.page.goto(url); await connected(guest.page);
    await expect(avatars()).toHaveCount(1);
    await expect(avatars().first()).toHaveAttribute('aria-label', aliceName);
    await bob.page.getByRole('button', { name: 'Add to my notes', exact: true }).click();
    await expect(bob.page).toHaveURL(`${ORIGIN}/`); await connected(bob.page);
    // No owner navigation or content edit is needed to refresh the roster.
    await expect(avatars()).toHaveCount(2);
    await expect(avatars().filter({ hasNotText: '🐔' })).toHaveCount(2);
    await card(bob.page, title).click();
    await editor(bob.page).getByRole('button', { name: 'More note actions', exact: true }).click();
    await editor(bob.page).getByRole('button', { name: 'Move to trash', exact: true }).click();
    await connected(bob.page); await expect(avatars()).toHaveCount(2);
    await bob.context.setOffline(true);
    await bob.page.getByRole('button', { name: 'Trash', exact: true }).click();
    await card(bob.page, title).hover();
    await card(bob.page, title).getByRole('button', { name: 'Delete forever', exact: true }).click();
    await bob.page.getByRole('alertdialog', { name: 'Delete note forever?', exact: true }).getByRole('button', { name: 'Delete forever', exact: true }).click();
    await expect(bob.page.getByRole('article')).toHaveCount(0);
    await expect(avatars()).toHaveCount(2); // Server has not received the removal.
    await bob.context.setOffline(false); await connected(bob.page);
    await expect(avatars()).toHaveCount(1);
    await expect(avatars().first()).toHaveAttribute('aria-label', aliceName);
    await alice.context.setOffline(true);
    await bob.page.goto(url); await connected(bob.page);
    await bob.page.getByRole('button', { name: 'Add to my notes', exact: true }).click();
    await expect(bob.page).toHaveURL(`${ORIGIN}/`); await connected(bob.page);
    await alice.context.setOffline(false); await connected(alice.page);
    await expect(avatars()).toHaveCount(2);
  } finally { await Promise.all([alice.context.close(), bob.context.close(), guest.context.close()]); }
});
