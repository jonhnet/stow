import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import * as Y from 'yjs';
import { Vault } from '../../src/core/vault';

const ORIGIN = 'http://localhost:4174';

test('imported audio stays a downloadable file and labels display and search offline', async ({ page, context }) => {
  await context.addCookies([{ name: 'stow_test_user', value: 'imported-attachments@example.test', url: ORIGIN }]);
  const session = await (await context.request.get(`${ORIGIN}/api/session`)).json();
  const fixture = new Vault();
  const id = fixture.createNote('text', { title: 'Imported recording', body: 'A retained attachment.' });
  fixture.notes.get(id)!.set('labels', ['Voice memos', 'Travel plans', 'Voice memos']);
  const originals = ['synthetic recording bytes', 'another uncached recording'];
  const files = originals.map((bytes, index) => ({ id: `audio-${index}`, noteId: id, hash: createHash('sha256').update(bytes).digest('hex'), name: `voice-memo-${index + 1}.3gp`, type: 'audio/3gp', size: Buffer.byteLength(bytes) }));
  for (let index = 0; index < files.length; index++) {
    fixture.addAttachment(files[index]);
    const response = await context.request.put(`${ORIGIN}/api/blobs/${files[index].hash}`, { data: Buffer.from(originals[index]), headers: { 'X-Stow-Vault': session.vaultId, 'Content-Type': 'application/octet-stream' } });
    expect(response.status()).toBe(204);
  }
  const update = [...Y.encodeStateAsUpdate(fixture.doc)];
  fixture.doc.destroy();
  await page.goto(`${ORIGIN}/api/health`);
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
  }, { update, vaultId: session.vaultId });
  const requests: string[] = [];
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/blobs/')) requests.push(request.url()); });
  await page.goto(ORIGIN);
  await expect(page.locator('.sync-state')).toHaveAttribute('title', 'Connected');
  const card = page.getByRole('article', { name: 'Open note: Imported recording', exact: true });
  await expect(card.getByRole('button', { name: 'Open attachment: voice-memo-1.3gp', exact: true })).toBeVisible();
  await expect(card.locator('img, audio, video')).toHaveCount(0);
  await expect(card.getByRole('list', { name: 'Note labels' }).getByRole('listitem')).toHaveText(['Voice memos', 'Travel plans']);
  await page.getByRole('searchbox', { name: 'Search notes' }).fill('TRAVEL PLANS');
  await expect(card).toBeVisible();
  await card.getByRole('heading', { name: 'Imported recording', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Edit note', exact: true });
  await expect(editor.getByRole('list', { name: 'Note labels' }).getByRole('listitem')).toHaveText(['Voice memos', 'Travel plans']);
  await editor.getByRole('button', { name: 'More note actions' }).click();
  await editor.getByRole('button', { name: 'Version history', exact: true }).click();
  const history = page.getByRole('dialog', { name: 'Version history', exact: true });
  await history.getByRole('button', { name: 'Preview version' }).first().click();
  await expect(history.locator('.revision-preview').getByRole('list', { name: 'Note labels' })).toContainText('Travel plans');
  await page.keyboard.press('Escape');
  await editor.getByRole('button', { name: 'Close', exact: true }).click();
  expect(requests).toEqual([]);

  await card.getByRole('button', { name: 'Open attachment: voice-memo-1.3gp', exact: true }).click();
  const attachment = page.getByRole('dialog', { name: 'Attachment: voice-memo-1.3gp', exact: true });
  const link = attachment.getByRole('link', { name: 'Download voice-memo-1.3gp', exact: true });
  await expect(link).toBeVisible();
  await expect(attachment.locator('img, audio, video')).toHaveCount(0);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toBe(`${ORIGIN}/api/blobs/${files[0].hash}`);
  const downloaded = page.waitForEvent('download');
  await link.click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe(files[0].name);
  expect(await readFile((await download.path())!)).toEqual(Buffer.from(originals[0]));
  await page.keyboard.press('Escape');
  await expect(card.getByRole('button', { name: 'Open attachment: voice-memo-1.3gp', exact: true })).toBeFocused();
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await context.setOffline(true);
  await page.reload();
  await page.getByRole('searchbox', { name: 'Search notes' }).fill('Voice memos');
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'Open attachment: voice-memo-1.3gp', exact: true }).click();
  await expect(link).toBeVisible();
  await page.getByRole('button', { name: 'Close attachment', exact: true }).click();
  await card.getByRole('button', { name: 'Open attachment: voice-memo-2.3gp', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Connect to download it.');
  await expect(page.getByRole('dialog').getByRole('link')).toHaveCount(0);
  expect(requests).toHaveLength(1);
});
