import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { buildInfo } from '../../scripts/build-info';
import { sourceDir } from '../../paths';
import * as Y from 'yjs';
import { PERSISTENCE_VERSION } from '../../src/core/persistence-database';
import { SYNC_PROTOCOL_VERSION } from '../../src/core/protocol-version';
import { card, connected, createNote, origin, workerGate } from './support/sync-faults';

const notice = (page: Page) => page.getByRole('alert', { name: 'Sync stopped' });
const expectBody = (page: Page, value: string) => expect.poll(() => page.locator('[aria-label="Note text"]').evaluate(element => element instanceof HTMLTextAreaElement ? element.value : element.textContent)).toBe(value);

async function sessionCompatibility(page: Page) {
  const control = { reject: false };
  // Exercise the actual Rust compatibility response, retaining real auth and IDB.
  await page.route('**/api/session', route => route.continue({ headers: {
    ...route.request().headers(), ...(control.reject ? { 'x-stow-sync-protocol': '2' } : {}),
  } }));
  return control;
}

async function websocketCompatibility(page: Page) {
  await page.addInitScript(() => {
    const Original = WebSocket;
    const control = {
      reject: false,
      attempts: 0,
      rejections: [] as unknown[],
      closes: [] as number[],
    };
    Object.assign(window, { syncHandshake: control });
    window.WebSocket = class extends Original {
      constructor(url: string | URL, protocols?: string | string[]) {
        const target = new URL(url);
        const sync = target.pathname === '/sync';
        if (sync && control.reject) target.searchParams.set('protocol', '0');
        super(target, protocols);
        if (!sync) return;
        control.attempts++;
        this.addEventListener('message', event => {
          if (typeof event.data !== 'string') return;
          const message = JSON.parse(event.data);
          if (message.type === 'sync-rejection') control.rejections.push(message.rejection);
        });
        this.addEventListener('close', event => { control.closes.push(event.code); });
      }
    };
  });
}

test.beforeEach(async ({ context }, info) => {
  await context.addCookies([{ name: 'stow_test_user', value: `update-${info.testId}-${info.repeatEachIndex}@example.test`, url: origin }]);
});

test('update drains a stopped worker, freezes editing, preserves the open note and cannot reload in a loop', async ({ page, context }) => {
  await workerGate(page); const version = await sessionCompatibility(page);
  // Opening/closing notes now navigates within the document. Count only actual
  // page loads when checking the automatic-reload limit.
  let loads = 0; page.on('load', () => { loads++; });
  await page.goto(origin); await connected(page); await createNote(page);
  await page.clock.install();
  await context.setOffline(true);
  await page.evaluate(() => { (window as any).syncWorkerGate.pause = true; });
  await card(page).getByRole('heading').click();
  const body = page.getByRole('textbox', { name: 'Note text', exact: true });
  await body.focus();
  await body.fill('Offline edit must survive the update');
  await expect.poll(() => page.evaluate(() => (window as any).syncWorkerGate.held)).toBeGreaterThan(0);
  // Composition was already active when the rejection arrived.
  await body.dispatchEvent('compositionstart');
  version.reject = true; await context.setOffline(false);
  await expect(notice(page)).toContainText('Reload Stow');
  // Closing the worker must drain its retained batch without waiting for it.
  await expect(page.locator('.app')).toHaveAttribute('inert', '');
  await expect(notice(page).getByRole('button', { name: 'Reload', exact: true })).toBeEnabled();
  await page.clock.fastForward(6000); expect(loads).toBe(1);
  await page.locator('[aria-label="Note text"]').dispatchEvent('compositionend');
  await page.clock.fastForward(4000);
  await page.keyboard.press('Control+z');
  await expectBody(page, 'Offline edit must survive the update');
  await page.clock.fastForward(4000); expect(loads).toBe(1);
  await page.clock.fastForward(1500); await expect.poll(() => loads).toBe(2);
  await expect(notice(page)).toContainText('Automatic reload is paused');
  await page.clock.fastForward(30000); expect(loads).toBe(2);
  version.reject = false;
  await notice(page).getByRole('button', { name: 'Reload', exact: true }).click();
  await expect(page.locator('.note-editor')).toBeVisible();
  await expectBody(page, 'Offline edit must survive the update');
  await connected(page); expect(loads).toBe(3); await expect(notice(page)).toHaveCount(0);
  await body.focus(); await page.keyboard.press('Control+z');
  await expectBody(page, 'Baseline 🦀');
});

test('a deployment between session and WebSocket stops retries and preserves pending edits through reload', async ({ page, context, browser }) => {
  await workerGate(page); await websocketCompatibility(page);
  const sessions: { status: number; rejection: unknown; protocol: string | undefined }[] = [];
  page.on('response', async response => {
    if (new URL(response.url()).pathname !== '/api/session') return;
    const payload = await response.json();
    sessions.push({ status: response.status(), rejection: payload.syncRejection, protocol: response.request().headers()['x-stow-sync-protocol'] });
  });
  let loads = 0; page.on('load', () => { loads++; });
  await page.goto(origin); await connected(page); await createNote(page);
  await page.clock.install();
  await context.setOffline(true);
  await expect(page.locator('.sync-state')).toHaveAttribute('title', 'Offline — notes stored on this device');
  await page.evaluate(() => { (window as any).syncWorkerGate.pause = true; (window as any).syncHandshake.reject = true; });
  await card(page).getByRole('heading').click();
  const body = page.getByRole('textbox', { name: 'Note text', exact: true });
  await body.focus(); await body.fill('Offline edit must survive the WebSocket rejection');
  await expect.poll(() => page.evaluate(() => (window as any).syncWorkerGate.held)).toBeGreaterThan(0);

  const beforeReconnect = sessions.length;
  await context.setOffline(false);
  await expect(notice(page)).toContainText('Reload Stow');
  await expect(notice(page).getByRole('button', { name: 'Reload', exact: true })).toBeEnabled();
  await page.evaluate(() => window.dispatchEvent(new Event('compositionstart')));
  await expect.poll(() => sessions.length).toBeGreaterThan(beforeReconnect);
  // The current client passed the real session preflight. Only its subsequent
  // WebSocket query is incompatible, reproducing a deployment between the two.
  expect(sessions.at(-1)).toEqual({ status: 200, rejection: undefined, protocol: SYNC_PROTOCOL_VERSION });
  await expect.poll(() => page.evaluate(() => (window as any).syncHandshake.rejections)).toEqual([
    expect.objectContaining({ action: 'reload', message: expect.stringContaining('Reload Stow') }),
  ]);
  await expect.poll(() => page.evaluate(() => (window as any).syncHandshake.closes)).toContain(1008);
  const attempts = await page.evaluate(() => (window as any).syncHandshake.attempts);
  const sessionCount = sessions.length;
  await page.clock.runFor(65_000);
  await page.evaluate(() => { window.dispatchEvent(new Event('online')); document.dispatchEvent(new Event('visibilitychange')); });
  await page.clock.runFor(65_000);
  expect(loads).toBe(1);
  expect(sessions.length).toBe(sessionCount);
  expect(await page.evaluate(() => (window as any).syncHandshake.attempts)).toBe(attempts);
  await expectBody(page, 'Offline edit must survive the WebSocket rejection');

  await page.evaluate(() => { (window as any).syncHandshake.reject = false; window.dispatchEvent(new Event('compositionend')); });
  await expect(notice(page).getByRole('button', { name: 'Reload', exact: true })).toBeEnabled();
  await notice(page).getByRole('button', { name: 'Reload', exact: true }).click();
  await connected(page); await expect(notice(page)).toHaveCount(0);
  await expect(card(page)).toContainText('Offline edit must survive the WebSocket rejection');
  expect(loads).toBe(2);

  // A separate browser cache can recover this edit only from the server.
  const fresh = await browser.newContext();
  try {
    await fresh.addCookies(await context.cookies(origin));
    const reader = await fresh.newPage(); await reader.goto(origin); await connected(reader);
    await expect(card(reader)).toContainText('Offline edit must survive the WebSocket rejection');
  } finally { await fresh.close(); }
});

for (const responseStatus of [200, 503]) test(`a session already in flight cannot reopen sync after a terminal WebSocket rejection (HTTP ${responseStatus})`, async ({ page }) => {
  let holdSession = false, held = false, sessions = 0, sockets = 0;
  let releaseSession!: () => void, rejectSocket!: () => void;
  const sessionGate = new Promise<void>(resolve => { releaseSession = resolve; });
  await page.route('**/api/session', async route => {
    sessions++;
    if (!holdSession) return route.continue();
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    expect((await response.json()).syncRejection).toBeUndefined();
    held = true;
    await sessionGate;
    if (responseStatus === 200) await route.fulfill({ response });
    else await route.fulfill({ status: responseStatus, json: { error: 'Scheduled temporary outage' } });
  });
  await page.routeWebSocket(/\/sync\?/, socket => {
    sockets++;
    socket.connectToServer();
    rejectSocket = () => socket.send(JSON.stringify({ type: 'sync-rejection', rejection: {
      code: 'update-required', message: 'Reload Stow to continue syncing.', action: 'reload', target: 'in-flight-session-test',
    } }));
  });
  try {
    await page.goto(origin); await connected(page); await createNote(page); await page.clock.install();
    // Keep the rejection visible while the pending authenticated request finishes.
    await page.evaluate(() => window.dispatchEvent(new Event('compositionstart')));
    holdSession = true;
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect.poll(() => held).toBe(true);
    rejectSocket(); await expect(notice(page)).toContainText('Reload Stow');
    const attempts = { sessions, sockets };
    const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/session');
    releaseSession();
    const received = await response;
    expect(received.status()).toBe(responseStatus);
    // Unavailable responses are deliberately canceled by the client; Playwright
    // does not report response.finished() for that canceled body.
    if (responseStatus === 200) await received.finished();
    await page.clock.runFor(30_000);
    expect({ sessions, sockets }).toEqual(attempts);
    await expect(page.locator('.sync-state')).toHaveClass(/sync-error/);
    await expect(notice(page)).toContainText('Reload Stow');
    await expect(card(page)).toContainText('Baseline');
  } finally { releaseSession(); }
});

test('a failed local write blocks the automatic update and keeps the unsaved note visible', async ({ page, context }) => {
  await page.addInitScript(() => {
    Object.assign(window, { failStowWrites: false });
    const add = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add = function (...args) {
      if ((window as any).failStowWrites && this.name === 'updates') throw new DOMException('Scheduled full disk', 'QuotaExceededError');
      return add.apply(this, args);
    };
    const Original = Worker;
    window.Worker = class extends Original {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        if (options?.name !== 'stow-persistence') return;
        const post = this.postMessage.bind(this);
        this.postMessage = value => {
          if ((window as any).failStowWrites) queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: { id: value.id, error: { name: 'QuotaExceededError', message: 'Scheduled full disk' } } })));
          else post(value);
        };
      }
    };
  });
  const version = await sessionCompatibility(page);
  await page.goto(origin); await connected(page); await createNote(page); await page.clock.install();
  await context.setOffline(true);
  await page.evaluate(() => { (window as any).failStowWrites = true; });
  await card(page).getByRole('heading').click();
  const body = page.getByRole('textbox', { name: 'Note text', exact: true }); await body.focus(); await body.fill('Keep this unsaved content');
  await expect(page.locator('.error-banner')).toContainText('Local storage failed');
  version.reject = true; await context.setOffline(false);
  await expect(notice(page)).toContainText('Local storage failed'); await page.clock.fastForward(20000);
  await expectBody(page, 'Keep this unsaved content');
  await expect(notice(page).getByRole('button', { name: 'Reload', exact: true })).toBeDisabled();
  await expect(notice(page).getByRole('button', { name: 'Export current notes' })).toBeEnabled();
  const exported = page.waitForEvent('download');
  await notice(page).getByRole('button', { name: 'Export current notes' }).click();
  const download = await exported;
  expect(await readFile((await download.path())!, 'utf8')).toContain('Keep this unsaved content');
});

test('another tab upgrades storage only after pending edits drain and the old tab isolates itself', async ({ page, context }) => {
  await workerGate(page); await websocketCompatibility(page);
  let sessions = 0;
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/session') sessions++; });
  await page.goto(origin); await connected(page); await createNote(page); await page.clock.install();
  await card(page).getByRole('heading').click();
  const body = page.getByRole('textbox', { name: 'Note text', exact: true });
  await page.evaluate(() => { (window as any).syncWorkerGate.pause = true; });
  await body.focus(); await body.fill('Pending when another tab upgrades');
  await expect.poll(() => page.evaluate(() => (window as any).syncWorkerGate.held)).toBeGreaterThan(0);
  await body.dispatchEvent('compositionstart');
  const newer = await context.newPage();
  try {
    await newer.goto(`${origin}/api/health`);
    const updates = await newer.evaluate(async version => {
      const name = (await indexedDB.databases()).find(db => db.name?.startsWith('stow-notes-'))!.name!;
      const request = indexedDB.open(name, version);
      const db = await new Promise<IDBDatabase>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      const read = db.transaction('updates').objectStore('updates').getAll();
      const values = await new Promise<Uint8Array[]>((resolve, reject) => { read.onsuccess = () => resolve(read.result); read.onerror = () => reject(read.error); });
      db.close(); return values.map(value => [...value]);
    }, PERSISTENCE_VERSION + 1);
    const doc = new Y.Doc();
    try {
      for (const update of updates) Y.applyUpdate(doc, Uint8Array.from(update));
      const notes = doc.getMap<Y.Map<unknown>>('notes');
      expect([...notes.values()].some(note => String(note.get('body')) === 'Pending when another tab upgrades')).toBe(true);
    } finally { doc.destroy(); }
    await expect(notice(page)).toContainText('Another version of Stow');
    await expect(page.locator('.app')).toHaveAttribute('inert', '');
    await expect(notice(page).getByRole('button', { name: 'Reload', exact: true })).toBeEnabled();
    const attempts = { sessions, sockets: await page.evaluate(() => (window as any).syncHandshake.attempts) };
    await page.evaluate(() => { window.dispatchEvent(new Event('online')); document.dispatchEvent(new Event('visibilitychange')); });
    await page.clock.fastForward(65_000);
    expect({ sessions, sockets: await page.evaluate(() => (window as any).syncHandshake.attempts) }).toEqual(attempts);
    await page.keyboard.press('Control+z'); await expectBody(page, 'Pending when another tab upgrades');
    // A stale bundle restarted offline must not reopen or rewrite the new cache.
    await context.setOffline(true); await page.reload();
    await expect(notice(page)).toContainText('Another version of Stow');
    await expect(notice(page).getByRole('button', { name: 'Reload', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Take a note…', exact: true })).toHaveCount(0);
  } finally { await newer.close(); }
});

test('compatible tabs converge without closing the editor and ignore the legacy broadcast channel', async ({ page, context }) => {
  await page.goto(origin); await connected(page); await createNote(page);
  await card(page).getByRole('heading').click();
  let loads = 0; page.on('load', () => { loads++; });
  const peer = await context.newPage();
  try {
    await peer.goto(origin); await connected(peer);
    await card(peer).getByRole('heading').click();
    const body = peer.getByRole('textbox', { name: 'Note text', exact: true });
    await body.focus(); await body.fill('Edit from a compatible tab');
    await expectBody(page, 'Edit from a compatible tab');
    await expect(notice(page)).toHaveCount(0); expect(loads).toBe(0);
    await peer.evaluate(async () => {
      const name = (await indexedDB.databases()).find(db => db.name?.startsWith('stow-notes-'))!.name!;
      const legacy = new BroadcastChannel(`stow-vault-${name.slice('stow-notes-'.length)}`);
      Object.assign(window, { legacyMessages: [], legacyChannel: legacy });
      legacy.onmessage = event => (window as any).legacyMessages.push(event.data);
      legacy.postMessage({ type: 'hello' });
      legacy.postMessage(new Uint8Array([255])); // Would fail decoding if the current tab consumed it.
      const open = indexedDB.open(name, 2);
      await new Promise<void>((resolve, reject) => {
        open.onerror = () => open.error?.name === 'VersionError' ? resolve() : reject(open.error);
        open.onsuccess = () => { open.result.close(); reject(new Error('Legacy storage reopened')); };
      });
    });
    await body.fill('Still compatible after the legacy hello');
    await expectBody(page, 'Still compatible after the legacy hello');
    expect(await peer.evaluate(() => (window as any).legacyMessages)).toEqual([]);
    await expect(page.locator('.error-banner')).toHaveCount(0);
    await expect(notice(page)).toHaveCount(0); expect(loads).toBe(0);
  } finally { await peer.close(); }
});

test('a phone sees a persistent rejection before any incompatible vault is opened', async ({ page }) => {
  await page.setViewportSize({ width: 412, height: 915 });
  const version = await sessionCompatibility(page); version.reject = true;
  await page.goto(origin); await expect(notice(page)).toBeVisible();
  await page.clock.install();
  // Input keeps the notice alive beyond the transient-toast timeout.
  await page.evaluate(() => window.dispatchEvent(new Event('compositionstart')));
  await page.clock.fastForward(10000); await expect(notice(page)).toBeVisible();
  expect(await page.evaluate(async () => (await indexedDB.databases()).filter(db => db.name?.startsWith('stow-notes-')))).toEqual([]);
  const bounds = await notice(page).boundingBox(); expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(412);
});

test('an account change takes priority over a reload instruction', async ({ page, context }) => {
  const version = await sessionCompatibility(page); await page.goto(origin); await connected(page); await createNote(page);
  version.reject = true;
  await context.addCookies([{ name: 'stow_test_user', value: 'other-update-account@example.test', url: origin }]);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.getByRole('alert')).toContainText('Your signed-in account changed');
  await expect(notice(page)).toHaveCount(0);
});

test('a terminal sync failure keeps the server message visible without requesting a reload', async ({ page }) => {
  let reject!: () => void;
  await page.routeWebSocket(/\/sync\?/, socket => {
    socket.connectToServer();
    reject = () => socket.send(JSON.stringify({ type: 'failure', code: 'limit', message: 'This vault exceeds the server sync limit.' }));
  });
  await page.goto(origin); await connected(page); await createNote(page); await page.clock.install();
  reject(); await expect(notice(page)).toContainText('This vault exceeds the server sync limit.');
  await page.clock.fastForward(20000); await expect(notice(page)).toBeVisible();
  await expect(notice(page).getByRole('button')).toHaveCount(0);
  await expect(card(page)).toContainText('Baseline');
});

test('settings identifies the running bundle with commit hash and commit date', async ({ page }) => {
  await page.goto(origin); await connected(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const row = page.getByLabel('Running build'); const version = buildInfo(sourceDir);
  await expect(row).toContainText(version.commit!.slice(0, 10));
  await expect(row.locator('code')).toHaveAttribute('title', version.commit!);
  await expect(row.locator('time')).toHaveAttribute('datetime', version.committedAt!);
  await expect(row.getByRole('button')).toHaveCount(0);
});
