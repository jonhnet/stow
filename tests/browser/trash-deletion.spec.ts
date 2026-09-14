import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import * as Y from 'yjs';
import { Vault } from '../../src/core/vault';

const ORIGIN = 'http://localhost:4174';
const titles = { live: 'Still here', archive: 'Saved archive', first: 'Delete this note', second: 'Delete another note', third: 'Delete final note' };
const oldBody = 'Obsolete private paragraph';
const currentBody = 'Current private paragraph';
const card = (page: Page, title: string) => page.getByRole('article', { name: `Open note: ${title}`, exact: true });
const editor = (page: Page) => page.getByRole('dialog', { name: 'Edit note', exact: true });
const confirm = (page: Page, title: string) => page.getByRole('alertdialog', { name: title, exact: true });

function fixture() {
  const vault = new Vault();
  const live = vault.createNote('text', { title: titles.live, body: 'Keep this live content.' });
  const archive = vault.createNote('text', { title: titles.archive, body: 'Keep this archived content.' });
  vault.setNoteMeta(archive, { archived: true });
  const first = vault.createNote('checklist', { title: titles.first, body: oldBody });
  const item = vault.addItem(first, 'Private checklist item');
  vault.setNoteText(first, 'body', currentBody);
  vault.setNoteMeta(first, { trashed: true });
  const second = vault.createNote('text', { title: titles.second, body: 'Other discarded content.' });
  vault.setNoteMeta(second, { trashed: true });
  const third = vault.createNote('text', { title: titles.third, body: 'Last discarded content.' });
  vault.setNoteMeta(third, { trashed: true });
  const update = [...Y.encodeStateAsUpdate(vault.doc)];
  vault.destroy();
  return { update, live, archive, first, second, third, item };
}

async function ready(page: Page) {
  await page.goto(ORIGIN);
  await expect(page.locator('.sync-state')).toHaveAttribute('title', 'Connected');
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
}

async function seed(page: Page, context: BrowserContext, data: ReturnType<typeof fixture>) {
  const { vaultId } = await (await context.request.get(`${ORIGIN}/api/session`)).json();
  await page.goto(`${ORIGIN}/api/health`);
  await page.evaluate(async ({ vaultId, update }) => {
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
  }, { vaultId, update: data.update });
  await ready(page);
  await expect(card(page, titles.live)).toBeVisible();
  return vaultId as string;
}

/** Read committed browser data without constructing a Vault that could repair it. */
async function saved(page: Page, vaultId: string) {
  const updates = await page.evaluate(async vaultId => new Promise<number[][]>((resolve, reject) => {
    const request = indexedDB.open(`stow-notes-${vaultId}`);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result, transaction = db.transaction('updates', 'readonly');
      const all = transaction.objectStore('updates').getAll();
      transaction.oncomplete = () => { db.close(); resolve(all.result.map((bytes: Uint8Array) => [...bytes])); };
      transaction.onabort = () => { db.close(); reject(transaction.error); };
    };
  }), vaultId);
  const doc = new Y.Doc();
  try {
    for (const update of updates) Y.applyUpdate(doc, new Uint8Array(update));
    // All vault roots are maps; establish their types before serializing content.
    for (const name of doc.share.keys()) doc.getMap(name);
    return {
      noteIds: [...doc.getMap('notes').keys()],
      trashedIds: [...doc.getMap<Y.Map<unknown>>('notes')].filter(([, note]) => note.get('trashed')).map(([id]) => id),
      itemIds: [...doc.getMap('items').keys()],
      history: JSON.stringify([...doc.share.keys()].filter(name => /revision|history/i.test(name))),
      content: JSON.stringify(doc.toJSON()),
    };
  } finally { doc.destroy(); }
}

async function expectPurged(page: Page, vaultId: string, data: ReturnType<typeof fixture>, both = false) {
  const deleted = both ? [data.first, data.second, data.third] : [data.first];
  await expect.poll(async () => {
    const state = await saved(page, vaultId);
    return {
      remainingDeletedNotes: state.noteIds.filter(id => deleted.includes(id)),
      remainingDeletedItems: state.itemIds.filter(id => id === data.item),
      historyHasDeletedSource: deleted.some(id => state.history.includes(id)),
      hasHistoricalText: state.content.includes(oldBody),
      hasCurrentText: state.content.includes(currentBody),
      liveAndArchive: [data.live, data.archive].every(id => state.noteIds.includes(id)),
    };
  }).toEqual({ remainingDeletedNotes: [], remainingDeletedItems: [], historyHasDeletedSource: false,
    hasHistoricalText: false, hasCurrentText: false, liveAndArchive: true });
}

async function navigate(page: Page, view: 'Notes' | 'Archive' | 'Trash') {
  if (page.viewportSize()!.width < 900) await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  await page.getByRole('button', { name: view, exact: true }).click();
}

test.beforeEach(async ({ context }, testInfo) => {
  await context.addCookies([{ name: 'stow_test_user', value: `trash-deletion-${testInfo.testId}-${testInfo.retry}@example.test`, url: ORIGIN }]);
});

test('card deletion requires confirmation, survives offline reload, and cannot be undone', async ({ page, context, browser }) => {
  const data = fixture(), vaultId = await seed(page, context, data);
  // An unrelated undo entry must remain useful after the destructive action.
  await card(page, titles.live).hover();
  await card(page, titles.live).getByRole('button', { name: 'Pin note', exact: true }).click();
  await navigate(page, 'Trash');
  const deleteButton = card(page, titles.first).getByRole('button', { name: 'Delete forever', exact: true });
  await card(page, titles.first).hover();
  await deleteButton.click();
  const dialog = confirm(page, 'Delete note forever?');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(card(page, titles.first)).toBeVisible();
  expect((await saved(page, vaultId)).history).toBe('[]');
  await deleteButton.click();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(card(page, titles.first)).toBeVisible();

  await context.setOffline(true);
  await deleteButton.click();
  await dialog.getByRole('button', { name: 'Delete forever', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(card(page, titles.first)).toHaveCount(0);
  await expect(card(page, titles.second)).toBeVisible();
  await expectPurged(page, vaultId, data);
  await expect(page.locator('header').getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
  await page.keyboard.press('Control+z');
  await navigate(page, 'Notes');
  await expect(card(page, titles.live).getByRole('button', { name: 'Pin note', exact: true })).toBeVisible();
  await page.keyboard.press('Control+Shift+z');
  await expect(card(page, titles.live).getByRole('button', { name: 'Unpin note', exact: true })).toBeVisible();
  await navigate(page, 'Trash');
  await expect(card(page, titles.first)).toHaveCount(0);
  await page.reload();
  await navigate(page, 'Trash');
  await expect(card(page, titles.first)).toHaveCount(0);
  await expect(card(page, titles.second)).toBeVisible();
  await expectPurged(page, vaultId, data);

  await context.setOffline(false);
  await expect(page.locator('.sync-state')).toHaveAttribute('title', 'Connected');
  const fresh = await browser.newContext();
  try {
    await fresh.addCookies(await context.cookies(ORIGIN));
    const remote = await fresh.newPage();
    await ready(remote);
    await navigate(remote, 'Trash');
    await expect(card(remote, titles.second)).toBeVisible();
    await expect(card(remote, titles.first)).toHaveCount(0);
    await expectPurged(remote, vaultId, data);
  } finally { await fresh.close(); }
});

test('phone editor and whole-can deletion are accessible and preserve live and archived notes', async ({ page, context }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const data = fixture(), vaultId = await seed(page, context, data);
  await navigate(page, 'Trash');
  await card(page, titles.first).getByRole('heading').click();
  await editor(page).getByRole('button', { name: 'Delete forever', exact: true }).click();
  const single = confirm(page, 'Delete note forever?');
  await expect(single.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  const bounds = (await single.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(844);
  await page.screenshot({ path: testInfo.outputPath('phone-permanent-deletion.png') });
  await single.getByRole('button', { name: 'Delete forever', exact: true }).click();
  await expect(single).toHaveCount(0);
  await expect(editor(page)).toHaveCount(0);
  await expect(card(page, titles.first)).toHaveCount(0);
  await expectPurged(page, vaultId, data);

  const emptyButton = page.getByRole('button', { name: 'Empty trash', exact: true });
  await emptyButton.click();
  const all = confirm(page, 'Empty trash?');
  await expect(all.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await all.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(card(page, titles.second)).toBeVisible();
  await expect(card(page, titles.third)).toBeVisible();
  await emptyButton.click();
  await all.getByRole('button', { name: 'Empty trash', exact: true }).click();
  await expect(page.getByRole('article')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Trash is empty', exact: true })).toBeVisible();
  await expectPurged(page, vaultId, data, true);
  await page.reload();
  await navigate(page, 'Notes');
  await expect(card(page, titles.live)).toBeVisible();
  await navigate(page, 'Archive');
  await expect(card(page, titles.archive)).toBeVisible();
});

test('deletion wins over a stale device restore and edit without crossing accounts or losing unrelated offline edits', async ({ page, context, browser }) => {
  const data = fixture(), vaultId = await seed(page, context, data);
  const stale = await browser.newContext(), otherAccount = await browser.newContext();
  try {
    await stale.addCookies(await context.cookies(ORIGIN));
    // Identical source IDs make this a direct check of account-scoped deletion.
    await otherAccount.addCookies([{ name: 'stow_test_user', value: `other-${test.info().testId}-${test.info().retry}@example.test`, url: ORIGIN }]);
    const remote = await stale.newPage(), other = await otherAccount.newPage();
    await ready(remote);
    const otherVaultId = await seed(other, otherAccount, data);
    await navigate(remote, 'Trash');
    await expect(card(remote, titles.first)).toBeVisible();
    await stale.setOffline(true);
    await card(remote, titles.first).hover();
    await card(remote, titles.first).getByRole('button', { name: 'Restore note', exact: true }).click();
    await navigate(remote, 'Notes');
    await card(remote, titles.first).getByRole('heading').click();
    const text = editor(remote).getByRole('textbox', { name: 'Note text', exact: true });
    await text.focus();
    await text.fill('A stale offline change must not recreate this note.');
    await editor(remote).getByRole('button', { name: 'Close', exact: true }).click();
    await card(remote, titles.live).getByRole('heading').click();
    const retained = editor(remote).getByRole('textbox', { name: 'Note text', exact: true });
    await retained.focus();
    await retained.fill('An unrelated offline edit that must survive.');
    await editor(remote).getByRole('button', { name: 'Close', exact: true }).click();

    await navigate(page, 'Trash');
    await card(page, titles.first).hover();
    await card(page, titles.first).getByRole('button', { name: 'Delete forever', exact: true }).click();
    await confirm(page, 'Delete note forever?').getByRole('button', { name: 'Delete forever', exact: true }).click();
    await expectPurged(page, vaultId, data);
    await stale.setOffline(false);
    await expect(remote.locator('.sync-state')).toHaveAttribute('title', 'Connected');
    await expect(card(remote, titles.first)).toHaveCount(0);
    await expect(card(remote, titles.live)).toContainText('An unrelated offline edit that must survive.');
    await expectPurged(remote, vaultId, data);
    await page.reload();
    await expect(card(page, titles.live)).toContainText('An unrelated offline edit that must survive.');
    await expectPurged(page, vaultId, data);
    expect((await saved(page, vaultId)).content).not.toContain('A stale offline change must not recreate this note.');

    await other.reload();
    await navigate(other, 'Trash');
    await expect(card(other, titles.first)).toBeVisible();
    await expect(card(other, titles.second)).toBeVisible();
    const untouched = await saved(other, otherVaultId);
    expect(untouched.noteIds).toContain(data.first);
    expect(untouched.history).toBe('[]');
    await remote.reload();
    await navigate(remote, 'Trash');
    await expect(card(remote, titles.first)).toHaveCount(0);
    await expect(card(remote, titles.second)).toBeVisible();
  } finally { await Promise.all([stale.close(), otherAccount.close()]); }
});

test('confirmation rejects remotely restored notes and never expands to notes trashed after it opened', async ({ page, context, browser }) => {
  const data = fixture(), vaultId = await seed(page, context, data);
  const peerContext = await browser.newContext();
  try {
    await peerContext.addCookies(await context.cookies(ORIGIN));
    const peer = await peerContext.newPage();
    await ready(peer);
    await navigate(page, 'Trash');
    await navigate(peer, 'Trash');
    await page.getByRole('button', { name: 'Empty trash', exact: true }).click();
    const dialog = confirm(page, 'Empty trash?');
    await expect(dialog).toContainText('3 notes');

    await card(peer, titles.first).hover();
    await card(peer, titles.first).getByRole('button', { name: 'Restore note', exact: true }).click();
    await expect.poll(async () => (await saved(page, vaultId)).trashedIds.includes(data.first)).toBe(false);
    await dialog.getByRole('button', { name: 'Empty trash', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('selected notes have changed');
    await expect.poll(async () => (await saved(page, vaultId)).noteIds.sort()).toEqual(
      [data.live, data.archive, data.first, data.second, data.third].sort(),
    );
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();

    await page.getByRole('button', { name: 'Empty trash', exact: true }).click();
    await expect(dialog).toContainText('2 notes');
    await navigate(peer, 'Notes');
    await card(peer, titles.live).hover();
    await card(peer, titles.live).getByRole('button', { name: 'Move to trash', exact: true }).click();
    await expect.poll(async () => (await saved(page, vaultId)).trashedIds.includes(data.live)).toBe(true);
    await expect(dialog).toContainText('2 notes');
    await dialog.getByRole('button', { name: 'Empty trash', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(card(page, titles.second)).toHaveCount(0);
    await expect(card(page, titles.third)).toHaveCount(0);
    await expect(card(page, titles.live)).toBeVisible();
    await expect.poll(async () => (await saved(page, vaultId)).noteIds.sort()).toEqual([data.live, data.archive, data.first].sort());
    await navigate(page, 'Notes');
    await expect(card(page, titles.first)).toBeVisible();
    await navigate(page, 'Archive');
    await expect(card(page, titles.archive)).toBeVisible();
  } finally { await peerContext.close(); }
});
