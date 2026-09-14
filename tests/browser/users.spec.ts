import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import * as Y from 'yjs';
import { Vault } from '../../src/core/vault';
import { createHmac } from 'node:crypto';
// Independent expectation for the deterministic browser fixture's account IDs.
const vaultIdentity = (secret: Buffer, mode: string, user: string) => createHmac('sha256', secret).update(`stow-vault\0${mode}\0${user}`).digest('hex');

const ORIGIN = 'http://localhost:4174';
async function setUser(context: BrowserContext, user: string) {
  await context.addCookies([{ name: 'stow_test_user', value: encodeURIComponent(user), url: ORIGIN }]);
}
async function userContext(browser: Browser, user: string) {
  const context = await browser.newContext();
  await setUser(context, user);
  return context;
}
const card = (page: Page, title: string) => page.getByRole('article', { name: `Open note: ${title}`, exact: true });
async function ready(page: Page) {
  await page.goto(ORIGIN);
  await expect(page.locator('.sync-state')).toHaveAttribute('title', 'Connected');
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
}
async function note(page: Page, title: string, body: string) {
  await page.getByRole('button', { name: 'Take a note…', exact: true }).click();
  await page.getByRole('textbox', { name: 'Note title', exact: true }).fill(title);
  await page.getByRole('textbox', { name: 'Note text', exact: true }).focus();
  await page.getByRole('textbox', { name: 'Note text', exact: true }).fill(body);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(card(page, title)).toBeVisible();
}
async function obsoleteCache(context: BrowserContext, title: string, databaseName = 'stow-v1-durable', imagesDatabaseName = 'stow-images-v1') {
  const vault = new Vault();
  vault.createNote('text', { title, body: 'An edit left on an old offline device.' });
  const update = [...Y.encodeStateAsUpdate(vault.doc)];
  vault.doc.destroy();
  // Seed once on a same-origin JSON page. No application code runs until both
  // database transactions commit, and later reloads cannot rewrite the fixtures.
  const seed = await context.newPage();
  try {
    await seed.goto(`${ORIGIN}/api/health`);
    await seed.evaluate(async ({ bytes, databaseName, imagesDatabaseName }) => {
      const write = (name: string, store: string, value: unknown) => new Promise<void>((resolve, reject) => {
        const open = indexedDB.open(name, 1);
        open.onupgradeneeded = () => { open.result.createObjectStore(store, store === 'blobs' ? { keyPath: 'hash' } : { autoIncrement: true }); if (store === 'updates') { open.result.createObjectStore('pendingEdits'); open.result.createObjectStore('maintenance'); } };
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction(store, 'readwrite');
          tx.objectStore(store).put(value);
          tx.oncomplete = () => { db.close(); resolve(); };
          tx.onabort = () => { db.close(); reject(tx.error); };
        };
      });
      await Promise.all([
        write(databaseName, 'updates', new Uint8Array(bytes)),
        write(imagesDatabaseName, 'blobs', { hash: 'a'.repeat(64), blob: new Blob(['obsolete private image'], { type: 'image/png' }), uploaded: true }),
      ]);
    }, { bytes: update, databaseName, imagesDatabaseName });
  } finally { await seed.close(); }
}

async function watchDatabaseOpens(context: BrowserContext) {
  await context.addInitScript(() => {
    const opened: string[] = [];
    Object.assign(window, { stowOpenedDatabases: opened });
    const open = indexedDB.open.bind(indexedDB);
    indexedDB.open = (name, version) => { opened.push(name); return open(name, version); };
  });
}

async function expectOnlyCurrentDatabases(page: Page, vaultId: string) {
  await expect.poll(() => page.evaluate(() => [...new Set<string>(Reflect.get(window, 'stowOpenedDatabases'))].sort()))
    .toEqual([`stow-images-${vaultId}`, `stow-notes-${vaultId}`]);
}

test('different users isolate notes, images, and live broadcasts; same user syncs across devices', async ({ browser }) => {
  const first = await userContext(browser, 'alice@example.test');
  const second = await userContext(browser, 'bob@example.test');
  const twin = await userContext(browser, 'alice@example.test');
  try {
    const a = await first.newPage(), b = await second.newPage(), same = await twin.newPage();
    await Promise.all([ready(a), ready(b), ready(same)]);
    await note(a, 'Alice private', 'Visible only to Alice.');
    await card(a, 'Alice private').click();
    await a.getByRole('dialog').locator('input[type=file]').setInputFiles({ name: 'alice.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4////fwAJ+wP9CNHoHgAAAABJRU5ErkJggg==', 'base64') });
    await a.keyboard.press('Escape');
    await expect(card(same, 'Alice private').getByRole('img', { name: 'alice.png' })).toBeVisible();
    await note(b, 'Bob private', 'Visible only to Bob.');
    await expect(card(b, 'Alice private')).toHaveCount(0);
    await expect(card(a, 'Bob private')).toHaveCount(0);
    await b.reload();
    await expect(card(b, 'Bob private')).toBeVisible();
    await expect(card(b, 'Alice private')).toHaveCount(0);
    await twin.setOffline(true);
    await same.reload();
    await expect(card(same, 'Alice private').getByRole('img', { name: 'alice.png' })).toBeVisible();
  } finally { await Promise.all([first.close(), second.close(), twin.close()]); }
});

test('an account change preserves offline edits and never uploads them to the new account', async ({ browser }) => {
  const context = await userContext(browser, 'switch-a@example.test');
  try {
    const page = await context.newPage();
    await ready(page);
    await note(page, 'Before switch', 'A owns this note.');
    await context.setOffline(true);
    await note(page, 'Pending A edit', 'Created offline under A.');
    await page.reload();
    await expect(card(page, 'Pending A edit')).toBeVisible();
    await setUser(context, 'switch-b@example.test');
    await context.setOffline(false);
    await expect(page.getByText(/account.*changed/i).first()).toBeVisible();
    await expect(card(page, 'Pending A edit')).toHaveCount(0);
    await page.reload();
    await expect(page.locator('.sync-state')).toHaveAttribute('title', 'Connected');
    await expect(card(page, 'Before switch')).toHaveCount(0);
    await expect(card(page, 'Pending A edit')).toHaveCount(0);
    await note(page, 'B after switch', 'This is B.');
    await setUser(context, 'switch-a@example.test');
    await page.reload();
    await expect(card(page, 'Pending A edit')).toBeVisible();
    await expect(card(page, 'B after switch')).toHaveCount(0);
    const remote = await userContext(browser, 'switch-a@example.test');
    try {
      const other = await remote.newPage();
      await ready(other);
      await expect(card(other, 'Pending A edit')).toBeVisible();
    } finally { await remote.close(); }
  } finally { await context.close(); }
});

test('a new account in another tab closes the previous account and its editor', async ({ browser }) => {
  const context = await userContext(browser, 'tabs-a@example.test');
  try {
    const old = await context.newPage();
    await ready(old);
    await note(old, 'Hidden on switch', 'Do not leave the old editor visible.');
    await card(old, 'Hidden on switch').click();
    await setUser(context, 'tabs-b@example.test');
    const next = await context.newPage();
    await ready(next);
    await expect(old.getByText(/account.*changed/i).first()).toBeVisible();
    await expect(old.getByRole('dialog')).toHaveCount(0);
    await expect(card(old, 'Hidden on switch')).toHaveCount(0);
    await expect(card(next, 'Hidden on switch')).toHaveCount(0);
  } finally { await context.close(); }
});

test('existing private notes remain available while every user ignores old shared vaults', async ({ browser }) => {
  const stranger = await userContext(browser, 'new-user@example.test');
  const owner = await userContext(browser, 'owner@example.test');
  try {
    await obsoleteCache(stranger, 'Old shared browser secret');
    await obsoleteCache(owner, 'Old shared browser secret');
    await watchDatabaseOpens(stranger);
    await watchDatabaseOpens(owner);
    const strangerSession = await (await stranger.request.get(`${ORIGIN}/api/session`)).json();
    const ownerSession = await (await owner.request.get(`${ORIGIN}/api/session`)).json();
    const other = await stranger.newPage(), mine = await owner.newPage();
    await ready(other);
    await expect(card(other, 'Existing owner note')).toHaveCount(0);
    await ready(mine);
    await expect(card(mine, 'Existing owner note')).toBeVisible();
    for (const [page, context, session] of [[other, stranger, strangerSession], [mine, owner, ownerSession]] as const) {
      await expectOnlyCurrentDatabases(page, session.vaultId);
      await expect(card(page, 'Old shared server note')).toHaveCount(0);
      await expect(card(page, 'Old shared browser secret')).toHaveCount(0);
      await page.reload();
      await expect(page.locator('.sync-state')).toHaveAttribute('title', 'Connected');
      await expectOnlyCurrentDatabases(page, session.vaultId);
      await expect(card(page, 'Old shared server note')).toHaveCount(0);
      await expect(card(page, 'Old shared browser secret')).toHaveCount(0);
      await context.setOffline(true);
      await page.reload();
      await expect(page.getByRole('button', { name: 'Take a note…', exact: true })).toBeVisible();
      await expectOnlyCurrentDatabases(page, session.vaultId);
      await expect(card(page, 'Old shared server note')).toHaveCount(0);
      await expect(card(page, 'Old shared browser secret')).toHaveCount(0);
    }
    await expect(card(mine, 'Existing owner note')).toHaveCount(1);
  } finally { await Promise.all([stranger.close(), owner.close()]); }
});

test('obsolete password-cache import hints cannot import notes during startup or offline reload', async ({ browser }) => {
  const owner = await userContext(browser, 'owner@example.test');
  try {
    const session = await (await owner.request.get(`${ORIGIN}/api/session`)).json();
    expect(session).not.toHaveProperty('legacyImport');
    expect(session).not.toHaveProperty('legacyVaultId');
    const formerPasswordId = vaultIdentity(Buffer.alloc(32, 7), 'password', 'owner');
    expect(formerPasswordId).not.toBe(session.vaultId);
    await obsoleteCache(owner, 'Password mode pending edit', `stow-notes-${formerPasswordId}`, `stow-images-${formerPasswordId}`);
    await watchDatabaseOpens(owner);
    // An older client may have persisted these hints. They are not authority to
    // copy another database, online or when reopening the verified vault offline.
    await owner.addInitScript(account => { localStorage.setItem('stow-account-v1', JSON.stringify(account)); }, { ...session, legacyImport: true, legacyVaultId: formerPasswordId });
    const page = await owner.newPage();
    await ready(page);
    await expect(card(page, 'Existing owner note')).toBeVisible();
    await expect(card(page, 'Password mode pending edit')).toHaveCount(0);
    await expectOnlyCurrentDatabases(page, session.vaultId);
    await page.reload();
    await expect(page.locator('.sync-state')).toHaveAttribute('title', 'Connected');
    await expectOnlyCurrentDatabases(page, session.vaultId);
    await expect(card(page, 'Password mode pending edit')).toHaveCount(0);
    await owner.setOffline(true);
    await page.reload();
    await expect(card(page, 'Existing owner note')).toBeVisible();
    await expectOnlyCurrentDatabases(page, session.vaultId);
    await expect(card(page, 'Password mode pending edit')).toHaveCount(0);
  } finally { await owner.close(); }
});

for (const status of [500, 502, 503, 504]) test(`HTTP ${status} during session verification retries without opening the cached account`, async ({ browser }) => {
  const context = await userContext(browser, `retry-session-${status}@example.test`);
  try {
    const page = await context.newPage();
    await ready(page);
    await note(page, 'Await verified session', 'Only reopen after the account is verified.');
    await watchDatabaseOpens(context);
    let unavailable = true, requests = 0;
    await page.route('**/api/session', route => {
      requests++;
      return unavailable ? route.fulfill({ status, contentType: 'text/html', body: '<html>Backend unavailable</html>' }) : route.continue();
    });
    await page.reload();
    await expect(page.getByText(`The server is temporarily unavailable (HTTP ${status}). Retrying…`)).toBeVisible();
    await expect.poll(() => requests).toBeGreaterThanOrEqual(2);
    expect(await page.evaluate(() => Reflect.get(window, 'stowOpenedDatabases'))).toEqual([]);
    await expect(card(page, 'Await verified session')).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem('stow-account-v1'))).not.toBeNull();
    unavailable = false;
    await expect(page.locator('.sync-state')).toHaveAttribute('title', 'Connected');
    await expect(card(page, 'Await verified session')).toBeVisible();
    await expect(page.getByText(/temporarily unavailable/)).toHaveCount(0);
  } finally { await context.close(); }
});

test('session unavailability preserves an open vault but verifies a changed account before reconnecting', async ({ browser }) => {
  const context = await userContext(browser, 'retry-open-vault-a@example.test');
  try {
    const page = await context.newPage();
    await ready(page);
    await note(page, 'Keep A private', 'A temporary error must not revoke this verified session.');
    let unavailable = true;
    await page.route('**/api/session', route => unavailable
      ? route.fulfill({ status: 503, body: 'Restarting' }) : route.continue());
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(page.locator('.error-banner')).toContainText('temporarily unavailable');
    await expect(card(page, 'Keep A private')).toBeVisible();
    await setUser(context, 'retry-open-vault-b@example.test');
    unavailable = false;
    await expect(page.getByText(/signed-in account changed/)).toBeVisible();
    await expect(card(page, 'Keep A private')).toHaveCount(0);
    await page.reload();
    await expect(page.locator('.sync-state')).toHaveAttribute('title', 'Connected');
    await expect(card(page, 'Keep A private')).toHaveCount(0);
  } finally { await context.close(); }
});

for (const denial of ['missing identity', 'login redirect', 'malformed session']) test(`a ${denial} response never opens the cached account`, async ({ browser }) => {
  const context = await userContext(browser, `denied-${denial.replaceAll(' ', '-')}@example.test`);
  try {
    const page = await context.newPage();
    await ready(page);
    await note(page, 'Cached but locked', 'A denied session must not use the offline path.');
    await context.addInitScript(() => {
      const opened: string[] = [];
      Object.assign(window, { stowOpenedDatabases: opened });
      const open = indexedDB.open.bind(indexedDB);
      indexedDB.open = (name, version) => { opened.push(name); return open(name, version); };
    });
    if (denial === 'missing identity') await context.clearCookies();
    else if (denial === 'login redirect') await page.route('**/api/session', route => route.fulfill({ status: 302, headers: { Location: 'https://login.example.invalid/signin' } }));
    else await page.route('**/api/session', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<html>Unexpected response</html>' }));
    await page.reload();
    await expect(page.getByRole('button', { name: 'Take a note…', exact: true })).toHaveCount(0);
    await expect(card(page, 'Cached but locked')).toHaveCount(0);
    await expect(page.getByText(/proxy|authentication|sign in/i).first()).toBeVisible();
    expect(await page.evaluate(() => Reflect.get(window, 'stowOpenedDatabases'))).toEqual([]);
    expect(await page.evaluate(async () => (await indexedDB.databases()).some(db => db.name?.startsWith('stow-notes-')))).toBe(true);
  } finally { await context.close(); }
});
