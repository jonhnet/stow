import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import * as Y from 'yjs';
import { Vault } from '../../src/core/vault';

const origin = 'http://localhost:4174';
const card = (page: Page, title: string) => page.getByRole('article', { name: `Open note: ${title}`, exact: true });

async function seed(page: Page, context: BrowserContext, user: string, vault: Vault) {
  await context.addCookies([{ name: 'stow_test_user', value: user, url: origin }]);
  const session = await (await context.request.get(`${origin}/api/session`)).json();
  await page.goto(`${origin}/api/health`);
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
  }, { update: [...Y.encodeStateAsUpdate(vault.doc)], vaultId: session.vaultId });
  vault.destroy();
  return session.vaultId as string;
}

async function holdInitialSync(page: Page) {
  let paused = true, received = 0;
  const held: (() => void)[] = [];
  await page.routeWebSocket(/\/sync\?/, socket => {
    const server = socket.connectToServer();
    server.onMessage(message => {
      received++;
      if (paused) held.push(() => socket.send(message));
      else socket.send(message);
    });
  });
  return { received: () => received, release() { paused = false; for (const send of held.splice(0)) send(); } };
}

test('a fresh device waits for its populated server vault instead of flashing No notes', async ({ page, context }) => {
  await context.addCookies([{ name: 'stow_test_user', value: 'owner@example.test', url: origin }]);
  const sync = await holdInitialSync(page);
  await page.goto(origin);
  await expect.poll(sync.received).toBeGreaterThan(0);
  await expect(page.getByRole('status', { name: 'Loading notes', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No notes', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Take a note…', exact: true })).toHaveCount(0);
  sync.release();
  await expect(card(page, 'Existing owner note')).toBeVisible();
  await expect(page.locator('.sync-state')).toHaveAttribute('title', 'Connected');
  await expect(page.getByRole('status', { name: 'Loading notes', exact: true })).toHaveCount(0);
});

test('an empty account is shown only after initial sync and remains usable on an offline reload', async ({ page, context }) => {
  await context.addCookies([{ name: 'stow_test_user', value: 'initially-empty@example.test', url: origin }]);
  const sync = await holdInitialSync(page);
  await page.goto(origin);
  await expect.poll(sync.received).toBeGreaterThan(0);
  await expect(page.getByRole('status', { name: 'Loading notes', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No notes', exact: true })).toHaveCount(0);
  sync.release();
  await expect(page.locator('.sync-state')).toHaveAttribute('title', 'Connected');
  await expect(page.getByRole('heading', { name: 'No notes', exact: true })).toBeVisible();
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'No notes', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Take a note…', exact: true })).toBeVisible();
});

test('interrupted first download reports missing local data and recovers on reconnect', async ({ page, context }) => {
  await context.addCookies([{ name: 'stow_test_user', value: 'owner@example.test', url: origin }]);
  const sync = await holdInitialSync(page);
  await page.goto(origin);
  await expect.poll(sync.received).toBeGreaterThan(0);
  await expect(page.getByRole('status', { name: 'Loading notes', exact: true })).toBeVisible();
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await context.setOffline(true);
  await expect(page.getByText('Connect to finish downloading your notes.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No notes', exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByText('Connect to finish downloading your notes.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No notes', exact: true })).toHaveCount(0);
  sync.release();
  await context.setOffline(false);
  await expect(card(page, 'Existing owner note')).toBeVisible();
});

test('cached notes stay available while the initial server reply is delayed', async ({ page, context }) => {
  const fixture = new Vault();
  fixture.createNote('text', { title: 'Cached while reconnecting', body: 'Already on this device.' });
  await seed(page, context, 'initial-sync-cached@example.test', fixture);
  const sync = await holdInitialSync(page);
  await page.goto(origin);
  await expect.poll(sync.received).toBeGreaterThan(0);
  await expect(card(page, 'Cached while reconnecting')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Take a note…', exact: true })).toBeVisible();
  await expect(page.getByRole('status', { name: 'Loading notes', exact: true })).toHaveCount(0);
  sync.release();
});

test('typing during cooperative indexing keeps the previous view until complete results are ready', async ({ page, context }) => {
  const fixture = new Vault();
  for (let i = 0; i < 120; i++) fixture.createNote('text', { title: `Cooperative ${i}`, body: `**Unique needle ${i}.**` });
  await seed(page, context, 'cooperative-search@example.test', fixture);
  // Hold zero-delay cooperative tasks, leaving input, network, rendering, and
  // longer application timers running. This makes the otherwise brief race deterministic.
  await page.addInitScript(() => {
    const original = window.setTimeout.bind(window);
    const held: (() => void)[] = [];
    let paused = true, id = -1;
    window.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
      if (paused && delay === 0 && typeof handler === 'function') {
        held.push(() => handler(...args));
        return id--;
      }
      return original(handler, delay, ...args);
    }) as typeof window.setTimeout;
    Object.assign(window, {
      heldSearchTasks: () => held.length,
      releaseSearchTasks: () => { paused = false; for (const run of held.splice(0)) original(run, 0); },
    });
  });
  const firstUpload = page.waitForResponse(response => response.url().endsWith('/api/diagnostics/startup') && response.request().method() === 'POST' && response.request().postDataJSON().reason === 'ready');
  await page.goto(`${origin}/?startup-profile=1`);
  await expect(page.locator('.note-card').first()).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as unknown as { heldSearchTasks(): number }).heldSearchTasks())).toBeGreaterThan(0);
  const search = page.getByRole('searchbox', { name: 'Search notes' });
  await search.fill('Unique needle 1.');
  await search.fill('Unique needle 119.');
  await expect(search).toHaveValue('Unique needle 119.');
  await expect(page.locator('.search-summary')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'No matching notes' })).toHaveCount(0);
  await expect(page.locator('.note-card').first()).toBeVisible();
  const initial = (await firstUpload).request().postDataJSON();
  expect(initial.marks.some((mark: { name: string }) => mark.name === 'search-build-start')).toBe(true);
  expect(initial.marks.some((mark: { name: string }) => mark.name === 'search-build-end')).toBe(false);
  const completedUpload = page.waitForResponse(response => response.url().endsWith('/api/diagnostics/startup') && response.request().method() === 'POST' && response.request().postDataJSON().marks.some((mark: { name: string }) => mark.name === 'search-build-end'));
  await page.evaluate(() => (window as unknown as { releaseSearchTasks(): void }).releaseSearchTasks());
  const completed = (await completedUpload).request().postDataJSON();
  expect(completed.id).toBe(initial.id);
  expect(completed.counters.searchIndexedNotes).toBe(120);
  expect(completed.marks.find((mark: { name: string }) => mark.name === 'notes-frame')).toEqual(initial.marks.find((mark: { name: string }) => mark.name === 'notes-frame'));
  await expect(page.locator('.search-summary')).toHaveText('1 result for “Unique needle 119.”');
  await expect(card(page, 'Cooperative 119')).toBeVisible();
  await expect(page.locator('.note-card')).toHaveCount(1);
  await card(page, 'Cooperative 119').click();
  const body = page.getByRole('dialog').getByRole('textbox', { name: 'Note text', exact: true });
  await body.focus(); await body.fill('Replacement needle');
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'No matching notes' })).toBeVisible();
  await search.fill('Replacement needle');
  await expect(card(page, 'Cooperative 119')).toBeVisible();
});

test('same-account offline tabs exchange edits and unchanged reloads leave shared storage untouched', async ({ page, context }) => {
  const fixture = new Vault();
  fixture.createNote('text', { title: 'Shared offline note', body: 'Original body' });
  const vaultId = await seed(page, context, 'offline-tab-sync@example.test', fixture);
  await page.goto(origin);
  await expect(page.locator('.sync-state')).toHaveClass(/sync-online/);
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await context.setOffline(true);
  const peer = await context.newPage();
  const errors: string[] = [];
  for (const tab of [page, peer]) tab.on('pageerror', error => errors.push(error.message));
  await peer.goto(origin);
  await expect(card(peer, 'Shared offline note')).toBeVisible();
  await card(page, 'Shared offline note').click();
  let body = page.getByRole('dialog').getByRole('textbox', { name: 'Note text', exact: true });
  await body.focus(); await body.fill('Edit from the first offline tab');
  await page.keyboard.press('Escape');
  await expect(card(peer, 'Shared offline note')).toContainText('Edit from the first offline tab');
  await card(peer, 'Shared offline note').click();
  body = peer.getByRole('dialog').getByRole('textbox', { name: 'Note text', exact: true });
  await body.focus(); await body.fill('Reply from the second offline tab');
  await peer.keyboard.press('Escape');
  await expect(card(page, 'Shared offline note')).toContainText('Reply from the second offline tab');
  await expect(page.locator('.sync-state')).toHaveAttribute('title', 'Offline — notes stored on this device');
  await expect(peer.locator('.sync-state')).toHaveAttribute('title', 'Offline — notes stored on this device');
  await peer.close();
  const records = () => page.evaluate(async vaultId => {
    return new Promise<number[]>((resolve, reject) => {
      const request = indexedDB.open(`stow-notes-${vaultId}`);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result, transaction = db.transaction('updates', 'readonly');
        const read = transaction.objectStore('updates').getAll();
        transaction.oncomplete = () => { db.close(); resolve(read.result.map((bytes: Uint8Array) => bytes.byteLength)); };
        transaction.onabort = () => { db.close(); reject(transaction.error); };
      };
    });
  }, vaultId);
  const before = await records();
  for (let i = 0; i < 2; i++) {
    await page.reload();
    await expect(card(page, 'Shared offline note')).toContainText('Reply from the second offline tab');
    expect(await records()).toEqual(before);
  }
  expect(errors).toEqual([]);
});
