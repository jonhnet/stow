import { test, expect, type Page } from '@playwright/test';
import * as Y from 'yjs';

const ORIGIN = 'http://localhost:4174';
const field = (page: Page) => page.getByRole('textbox', { name: 'Note text', exact: true });

test.beforeEach(async ({ page, context }, info) => {
  await context.addCookies([{ name: 'stow_test_user', value: `worker-${info.testId}-${info.retry}@example.test`, url: ORIGIN }]);
  await context.addInitScript(() => {
    const NativeWorker = Worker;
    const held: (() => void)[] = [];
    const control = { mode: '', crashed: 0, commits: 0, compactions: 0, requests: 0, terminated: 0, release() { control.mode = ''; for (const send of held.splice(0)) send(); } };
    (window as any).__workerTest = control;
    window.Worker = class extends NativeWorker {
      terminate() { control.terminated++; super.terminate(); }
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        if (options?.name !== 'stow-persistence') return;
        const crash = () => {
          if (control.mode !== 'fail-writes') control.mode = '';
          control.crashed++; this.terminate();
          this.dispatchEvent(new ErrorEvent('error', { cancelable: true, message: 'Injected storage worker crash' }));
        };
        this.addEventListener('message', event => {
          if (event.data.compacting) control.compactions++;
          if (event.data.result) control.commits++;
          if ((control.mode === 'during-compaction' && event.data.compacting) || (control.mode === 'after-commit' && event.data.result)) {
            event.stopImmediatePropagation(); crash();
          }
        });
        const post = this.postMessage.bind(this);
        this.postMessage = (value: any) => {
          control.requests++;
          if (control.mode === 'hold') { held.push(() => post(value)); return; }
          if (control.mode === 'before-write' || control.mode === 'fail-writes') { queueMicrotask(crash); return; }
          post(value);
        };
      }
    };
  });
  await page.goto(ORIGIN);
  await expect(page.locator('.sync-state')).toHaveClass(/sync-online/);
  await page.getByText('Take a note…', { exact: true }).click();
  await page.getByRole('textbox', { name: 'Note title', exact: true }).fill('Worker recovery');
  await field(page).click(); await field(page).fill('initial durable');
  await expect.poll(() => page.evaluate(() => (window as any).__workerTest.commits)).toBeGreaterThan(0);
  await expect(page.locator('.sync-state')).toHaveAttribute('title', 'Connected');
});

test('parking waits for pending writes before releasing the worker, and restores through a durable reload', async ({ page, context }) => {
  await context.setOffline(true);
  await page.evaluate(() => { (window as any).__workerTest.mode = 'hold'; });
  await field(page).fill('last input before navigation');
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  expect(await page.evaluate(() => (window as any).__workerTest.terminated)).toBe(0);
  expect(await savedText(page)).not.toContain('last input before navigation');
  await page.evaluate(() => (window as any).__workerTest.release());
  await expect.poll(() => page.evaluate(() => (window as any).__workerTest.terminated)).toBe(1);
  expect(await savedText(page)).toContain('last input before navigation');
  await Promise.all([
    page.waitForEvent('framenavigated'),
    page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))),
  ]);
  await expect(page.getByRole('article', { name: 'Open note: Worker recovery', exact: true })).toContainText('last input before navigation');
});

test('a failed departing-page write keeps unsaved data available for backup on return', async ({ page, context }) => {
  await context.setOffline(true);
  await page.evaluate(() => { (window as any).__workerTest.mode = 'fail-writes'; });
  await field(page).fill('unsaved departure survives in memory');
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  await expect.poll(() => page.evaluate(() => (window as any).__workerTest.crashed)).toBeGreaterThan(0);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await expect(page.getByRole('alert')).toContainText('Your unsaved notes remain in this page');
  await expect(page.getByRole('button', { name: 'Reload Stow', exact: true })).toBeDisabled();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download vault backup', exact: true }).click();
  const exported = await download, stream = await exported.createReadStream(), chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  expect(Buffer.concat(chunks).toString()).toContain('unsaved departure survives in memory');
});

async function savedText(page: Page) {
  const updates = await page.evaluate(async () => {
    const name = (await indexedDB.databases()).find(value => value.name?.startsWith('stow-notes-'))!.name!;
    return new Promise<number[][]>((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result, tx = db.transaction('updates'); const read = tx.objectStore('updates').getAll();
        tx.oncomplete = () => { db.close(); resolve(read.result.map((bytes: Uint8Array) => [...bytes])); };
      };
    });
  });
  const doc = new Y.Doc(); for (const update of updates) Y.applyUpdate(doc, new Uint8Array(update));
  const values = [...doc.getMap<Y.Map<unknown>>('notes').values()].map(note => String(note.get('body'))); doc.destroy(); return values;
}

test('failed local writes keep cross-tab updates queued until a successful retry', async ({ page, context }) => {
  const second = await context.newPage();
  await second.goto(ORIGIN); await expect(second.locator('.sync-state')).toHaveClass(/sync-online/);
  await context.setOffline(true);
  await page.evaluate(() => { (window as any).__workerTest.mode = 'before-write'; });
  await field(page).fill('first unpublished replacement');
  await expect(page.locator('.error-banner')).toContainText('Local storage failed');
  const other = second.getByRole('article', { name: 'Open note: Worker recovery', exact: true });
  await expect(other).toContainText('initial durable');
  await expect(other).not.toContainText('first unpublished replacement');
  await field(page).fill('first unpublished replacement and retry');
  await expect(other).toContainText('first unpublished replacement and retry');
  await expect(page.locator('.error-banner')).toHaveCount(0);
});

for (const phase of ['before-write', 'during-compaction', 'after-commit']) test(`worker crash ${phase} retains pending input and retries with exact recovery`, async ({ page }) => {
  // Keep automatic sync from immediately supplying another write to retry the
  // deliberately failed local batch before we have inspected its pending state.
  await page.context().setOffline(true);
  if (phase === 'during-compaction') await page.evaluate(async () => {
    // Resolve the database by its actual name; no production data is touched.
    const name = (await indexedDB.databases()).find(value => value.name?.startsWith('stow-notes-'))!.name!;
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(name); request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result, tx = db.transaction('updates', 'readwrite'), store = tx.objectStore('updates'), count = store.count();
        count.onsuccess = () => { for (let i = count.result; i < 499; i++) store.add(Uint8Array.of(0, 0)); };
        tx.oncomplete = () => { db.close(); resolve(); }; tx.onabort = () => reject(tx.error);
      };
    });
  });
  await page.evaluate(mode => { (window as any).__workerTest.mode = mode; }, phase);
  await field(page).fill('pending through worker crash');
  await expect.poll(() => page.evaluate(() => (window as any).__workerTest.crashed)).toBe(1);
  await expect(page.locator('.error-banner').getByText(/Local storage failed/)).toBeVisible();
  await field(page).fill('pending through worker crash and retry');
  await expect.poll(() => savedText(page)).toContain('pending through worker crash and retry');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('article', { name: 'Open note: Worker recovery', exact: true })).toContainText('pending through worker crash and retry');
  await page.context().setOffline(false);
  await expect(page.locator('.sync-state')).toHaveClass(/sync-online/);
});

test('two real workers serialize threshold compaction with another tab’s unpublished draft', async ({ page, context }) => {
  const second = await context.newPage();
  await second.goto(ORIGIN); await expect(second.locator('.sync-state')).toHaveClass(/sync-online/);
  await second.getByText('Take a note…', { exact: true }).click();
  await second.getByRole('textbox', { name: 'Note title', exact: true }).fill('Other worker');
  await field(second).click(); await field(second).fill('other initial');
  await expect.poll(() => savedText(second)).toContain('other initial');
  await context.setOffline(true);
  await page.evaluate(async () => {
    const name = (await indexedDB.databases()).find(value => value.name?.startsWith('stow-notes-'))!.name!;
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open(name);
      open.onsuccess = () => {
        const db = open.result, tx = db.transaction('updates', 'readwrite'), updates = tx.objectStore('updates'), count = updates.count();
        count.onsuccess = () => { for (let i = count.result; i < 499; i++) updates.add(Uint8Array.of(0, 0)); };
        tx.oncomplete = () => { db.close(); resolve(); }; tx.onabort = () => reject(tx.error);
      };
      open.onerror = () => reject(open.error);
    });
  });
  await Promise.all([page, second].map(tab => tab.evaluate(() => { (window as any).__workerTest.mode = 'hold'; })));
  await field(page).fill('first draft through concurrent compaction');
  await field(second).fill('second draft through concurrent compaction');
  await Promise.all([page, second].map(tab => tab.evaluate(() => { (window as any).__workerTest.release(); })));
  await expect.poll(() => savedText(page)).toEqual(expect.arrayContaining([
    'first draft through concurrent compaction', 'second draft through concurrent compaction',
  ]));
  const compactions = await Promise.all([page, second].map(tab => tab.evaluate(() => (window as any).__workerTest.compactions as number)));
  expect(compactions.reduce((sum, count) => sum + count, 0)).toBeGreaterThan(0);
  await expect(page.locator('.error-banner')).toHaveCount(0); await expect(second.locator('.error-banner')).toHaveCount(0);
  await context.setOffline(false);
  await expect(page.locator('.sync-state')).toHaveAttribute('title', 'Connected');
  await second.close(); await page.reload();
  await expect(page.getByRole('article', { name: 'Open note: Worker recovery', exact: true })).toContainText('first draft through concurrent compaction');
  await expect(page.getByRole('article', { name: 'Open note: Other worker', exact: true })).toContainText('second draft through concurrent compaction');
  await page.getByRole('dialog', { name: 'Edit note', exact: true }).locator('.editor-toolbar').getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByRole('article', { name: 'Open note: Worker recovery', exact: true })).toContainText('initial durable');
  await expect(page.getByRole('article', { name: 'Open note: Other worker', exact: true })).toContainText('second draft through concurrent compaction');
});
