import { test, expect, type Browser, type Page, type Response } from '@playwright/test';
import { startDevServer } from '../../scripts/dev-server-fixture.ts';

const filename = 'dev-upload.png';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4////fwAJ+wP9CNHoHgAAAABJRU5ErkJggg==', 'base64');
const editor = (page: Page) => page.getByRole('dialog', { name: 'Edit note', exact: true });
const card = (page: Page, title: string) => page.getByRole('article', { name: `Open note: ${title}`, exact: true });
const upload = (response: Response) => response.request().method() === 'PUT' && /^\/api\/blobs\/[a-f0-9]{64}$/.test(new URL(response.url()).pathname);

async function createNote(page: Page, origin: string, title: string) {
  await page.goto(origin);
  await expect(page.locator('.sync-state')).toHaveAttribute('title', 'Connected');
  await page.getByRole('button', { name: 'Take a note…', exact: true }).click();
  await editor(page).getByRole('textbox', { name: 'Note title', exact: true }).fill(title);
}

async function dropImage(page: Page) {
  const transfer = await page.evaluateHandle(({ bytes, name }) => {
    const files = new DataTransfer();
    files.items.add(new File([new Uint8Array(bytes)], name, { type: 'image/png' }));
    return files;
  }, { bytes: [...png], name: filename });
  try { await editor(page).dispatchEvent('drop', { dataTransfer: transfer }); }
  finally { await transfer.dispose(); }
}

async function cachedImage(page: Page, vaultId: string, hash: string) {
  return await page.evaluate(async ({ vaultId, hash }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(`stow-images-${vaultId}`);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const transaction = db.transaction(['metadata', 'blobs'], 'readonly');
      const read = <T,>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const [metadata, original] = await Promise.all([
        read(transaction.objectStore('metadata').get(hash)),
        read(transaction.objectStore('blobs').get(hash)),
      ]);
      return { uploaded: metadata?.uploaded, bytes: original ? [...new Uint8Array(await original.blob.arrayBuffer())] : null };
    } finally { db.close(); }
  }, { vaultId, hash });
}

async function verifyOnAnotherDevice(browser: Browser, origin: string, title: string, blobUrl: string) {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const thumbnail = page.waitForResponse(response => response.request().method() === 'GET' && response.url() === `${blobUrl}/thumbnail`);
    await page.goto(origin);
    expect((await thumbnail).status()).toBe(200);
    await expect(card(page, title).getByRole('img', { name: filename, exact: true })).toBeVisible();
    const original = page.waitForResponse(response => response.request().method() === 'GET' && response.url() === blobUrl);
    await card(page, title).getByRole('button', { name: `Open original: ${filename}`, exact: true }).click();
    const downloaded = await original;
    expect(downloaded.status()).toBe(200);
    expect(await downloaded.body()).toEqual(png);
    await expect(page.getByRole('dialog', { name: `Original image: ${filename}`, exact: true }).getByRole('img', { name: filename, exact: true })).toBeVisible();
  } finally { await context.close(); }
}

test('image uploads through the actual Vite proxy preserve the browser origin and remain usable after reload', async ({ page, browser }) => {
  const server = await startDevServer();
  try {
    const title = 'Image through development proxy';
    await createNote(page, server.origin, title);
    const uploaded = page.waitForResponse(upload);
    const chooser = page.waitForEvent('filechooser');
    await editor(page).getByRole('button', { name: 'Add image', exact: true }).click();
    await (await chooser).setFiles({ name: filename, mimeType: 'image/png', buffer: png });
    const response = await uploaded;
    expect(await response.request().headerValue('origin')).toBe(server.origin);
    expect(response.status()).toBe(204);
    await expect(editor(page).getByRole('img', { name: filename, exact: true })).toBeVisible();
    await editor(page).getByRole('textbox', { name: 'Note title', exact: true }).fill(`${title} still editable`);
    await editor(page).getByRole('button', { name: 'Close', exact: true }).click();
    await expect(card(page, `${title} still editable`)).toBeVisible();
    await page.reload();
    await expect(card(page, `${title} still editable`).getByRole('img', { name: filename, exact: true })).toBeVisible();
    await expect(page.locator('.sync-state')).toHaveAttribute('title', 'Connected');
    await verifyOnAnotherDevice(browser, server.origin, `${title} still editable`, response.url());
  } finally { await server.close(); }
});

test('a locally retained image rejected by the old proxy uploads after fixing the proxy and reloading', async ({ page, browser }) => {
  const server = await startDevServer();
  try {
    const title = 'Recover pending development image';
    await server.setApiChangeOrigin(true);
    await createNote(page, server.origin, title);
    const { vaultId } = await (await page.request.get(`${server.origin}/api/session`)).json();
    const rejected = page.waitForResponse(upload);
    await dropImage(page);
    const response = await rejected;
    expect(response.status()).toBe(403);
    // Blocking the image account aborts its fetch before CDP can read the body.
    // The HTTP regression checks the server's exact origin-rejection response.
    expect(await response.request().headerValue('origin')).toBe(server.origin);
    await expect(page.getByRole('heading', { name: 'Your account changed', exact: true })).toBeVisible();
    const hash = new URL(response.url()).pathname.split('/').at(-1)!;
    expect(await cachedImage(page, vaultId, hash)).toEqual({ uploaded: 0, bytes: [...png] });

    // Reload alone cannot repair the bad proxy, but it must retain the upload.
    const rejectedAgain = page.waitForResponse(upload);
    await page.getByRole('button', { name: 'Reload Stow', exact: true }).click();
    expect((await rejectedAgain).status()).toBe(403);
    await expect(page.getByRole('heading', { name: 'Your account changed', exact: true })).toBeVisible();
    expect(await cachedImage(page, vaultId, hash)).toEqual({ uploaded: 0, bytes: [...png] });

    // Restore the repository's real configuration, keeping the same server vault
    // and browser databases. Recovery must not require clearing local storage.
    // Leave first so Vite's automatic reload cannot race this explicit navigation.
    await page.goto('about:blank');
    await server.setApiChangeOrigin(undefined);
    const recovered = page.waitForResponse(upload);
    await page.goto(server.origin);
    const uploaded = await recovered;
    expect(uploaded.url()).toBe(response.url());
    expect(uploaded.status()).toBe(204);
    await expect(card(page, title).getByRole('img', { name: filename, exact: true })).toBeVisible();
    await expect(page.locator('.sync-state')).toHaveAttribute('title', 'Connected');
    await expect.poll(() => cachedImage(page, vaultId, hash)).toEqual({ uploaded: 1, bytes: [...png] });
    expect((await (await page.request.get(`${server.origin}/api/session`)).json()).vaultId).toBe(vaultId);
    await verifyOnAnotherDevice(browser, server.origin, title, uploaded.url());
  } finally { await server.close(); }
});
