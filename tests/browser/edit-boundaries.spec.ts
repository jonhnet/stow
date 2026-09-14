import type { HistoryExport } from '../../src/core/server-history-types';
import { test, expect, type Page, type Locator } from '@playwright/test';
import * as Y from 'yjs';
import { Vault } from '../../src/core/vault';

const ORIGIN = 'http://localhost:4174';
const editor = (page: Page) => page.getByRole('dialog', { name: 'Edit note', exact: true });
const body = (page: Page) => editor(page).getByRole('textbox', { name: 'Note text', exact: true });
const title = (page: Page) => editor(page).getByRole('textbox', { name: 'Note title', exact: true });
const item = (page: Page) => editor(page).getByRole('textbox', { name: 'List item text', exact: true });

async function savedDoc(page: Page): Promise<Y.Doc> {
  const updates = await page.evaluate(async () => {
    const session = await (await fetch('/api/session')).json();
    return new Promise<number[][]>((resolve, reject) => {
      const request = indexedDB.open(`stow-notes-${session.vaultId}`);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result, transaction = db.transaction('updates', 'readonly');
        const read = transaction.objectStore('updates').getAll();
        transaction.oncomplete = () => { db.close(); resolve(read.result.map((update: Uint8Array) => [...update])); };
        transaction.onabort = () => { db.close(); reject(transaction.error); };
      };
    });
  });
  const doc = new Y.Doc();
  for (const update of updates) Y.applyUpdate(doc, new Uint8Array(update));
  return doc;
}

async function historyCount(page: Page): Promise<number> {
  const session = await (await page.request.get(`${ORIGIN}/api/session`)).json();
  const response = await page.request.get(`${ORIGIN}/api/history/export`, { headers: { 'X-Stow-Vault': session.vaultId } });
  expect(response.ok()).toBe(true);
  return (await response.json()).versions.length;
}

async function expectSavedBody(page: Page, expected: string, title = 'Boundary note') {
  await expect.poll(async () => {
    const session = await (await page.request.get(`${ORIGIN}/api/session`)).json();
    const response = await page.request.get(`${ORIGIN}/api/history/export`, { headers: { 'X-Stow-Vault': session.vaultId } });
    expect(response.ok()).toBe(true);
    const history: HistoryExport = await response.json();
    return history.versions.some(version => Object.values(version.state.sources).some(source => source.title === title && source.body === expected));
  }, { timeout: 2000 }).toBe(true);
}

async function savedItems(page: Page): Promise<string[]> {
  const doc = await savedDoc(page);
  const items = [...doc.getMap<Y.Map<unknown>>('items').values()].map(item => String(item.get('text')));
  doc.destroy();
  return items;
}

async function expectHistory(page: Page, count: number) {
  // An explicit boundary must publish promptly, before the five-second idle seal.
  await expect.poll(() => historyCount(page), { timeout: 2000 }).toBe(count);
}

async function append(field: Locator, text: string) {
  await field.focus(); await field.press('Control+End');
  await field.pressSequentially(text, { delay: 5 });
}

test.beforeEach(async ({ page, context }, info) => {
  await context.addCookies([{ name: 'stow_test_user', value: `boundaries-${info.testId}-${info.retry}@example.test`, url: ORIGIN }]);
  const session = await (await context.request.get(`${ORIGIN}/api/session`)).json();
  const vault = new Vault();
  const id = vault.createNote('checklist', { title: 'Boundary note', body: 'Original body' });
  vault.addItem(id, 'Original item');
  const update = [...Y.encodeStateAsUpdate(vault.doc)];
  vault.destroy();
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
  await page.goto(ORIGIN);
  await expect(page.locator('.sync-state')).toHaveClass(/sync-online/);
  await page.getByRole('article', { name: 'Open note: Boundary note', exact: true }).click();
});

test('title, body and checklist blur each seal once; closing and reload do not duplicate history', async ({ page }) => {
  const baseline = await historyCount(page);
  await append(title(page), ' amended');
  expect(await historyCount(page)).toBe(baseline);
  await body(page).focus();
  await expectHistory(page, baseline + 1);
  await append(body(page), ' amended');
  await item(page).focus();
  await expectHistory(page, baseline + 2);
  await append(item(page), ' amended');
  await editor(page).getByRole('button', { name: 'Close', exact: true }).click();
  await expectHistory(page, baseline + 3);
  await page.reload();
  await expect(page.getByRole('article', { name: 'Open note: Boundary note amended', exact: true })).toContainText('Original item amended');
  await expectHistory(page, baseline + 3);
});

test('caret navigation and pointer relocation split Undo without sealing history', async ({ page }) => {
  const baseline = await historyCount(page), field = body(page);
  await append(field, ' ABC');
  await field.press('ArrowLeft');
  await field.pressSequentially('!');
  await expect(field).toHaveValue('Original body AB!C');
  expect(await historyCount(page)).toBe(baseline);
  await field.press('Control+z');
  await expect(field).toHaveValue('Original body ABC');
  await field.press('Control+z');
  await expect(field).toHaveValue('Original body');
  await field.press('Control+Shift+z');
  await expect(field).toHaveValue('Original body ABC');

  await field.click({ position: { x: 8, y: 10 } });
  await field.pressSequentially('prefix ');
  await field.press('Control+z');
  await expect(field).toHaveValue('Original body ABC');
  await field.press('Control+z');
  await expect(field).toHaveValue('Original body');
  await field.press('Control+Shift+z');
  await expect(field).toHaveValue('Original body ABC');

  // The Android editing menu emits beforeinput instead of a keydown shortcut.
  const cancelled = await field.evaluate(element => !element.dispatchEvent(new InputEvent('beforeinput', {
    bubbles: true, cancelable: true, inputType: 'historyUndo',
  })));
  expect(cancelled).toBe(true);
  await expect(field).toHaveValue('Original body');
  await field.evaluate(element => element.dispatchEvent(new InputEvent('beforeinput', {
    bubbles: true, cancelable: true, inputType: 'historyRedo',
  })));
  await expect(field).toHaveValue('Original body ABC');
  await editor(page).getByRole('button', { name: 'Close', exact: true }).click();
  await page.locator('header').getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('.card-body')).toHaveText('Original body');
});

test('paste and cut save their observed endpoints while preserving every fine Undo step', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const baseline = await historyCount(page), field = body(page);
  await append(field, ' typed');
  await page.evaluate(() => navigator.clipboard.writeText(' pasted'));
  await field.press('Control+v');
  await expect(field).toHaveValue('Original body typed pasted');
  // Completion and paste occur in one event; their hints may coalesce, but the
  // observed pasted endpoint must save promptly and fine Undo stays separate.
  await expectSavedBody(page, 'Original body typed pasted');
  await field.pressSequentially(' after');
  await field.press('Control+a');
  await field.press('Control+x');
  await expect(field).toHaveValue('');
  await expectSavedBody(page, '');
  await field.pressSequentially('replacement');
  await editor(page).getByRole('button', { name: 'Close', exact: true }).click();
  await expectSavedBody(page, 'replacement');
  const undo = page.locator('header').getByRole('button', { name: 'Undo', exact: true });
  await undo.click();
  await expect(page.locator('.card-body')).toHaveCount(0);
  await undo.click();
  await expect(page.locator('.card-body')).toHaveText('Original body typed pasted after');
  await undo.click();
  await expect(page.locator('.card-body')).toHaveText('Original body typed pasted');
  await undo.click();
  await expect(page.locator('.card-body')).toHaveText('Original body typed');
  await undo.click();
  await expect(page.locator('.card-body')).toHaveText('Original body');
});

test('window blur seals focused typing once without ending the editor', async ({ page }) => {
  const baseline = await historyCount(page), field = body(page);
  await append(field, ' before switching apps');
  await page.evaluate(() => { window.dispatchEvent(new Event('blur')); window.dispatchEvent(new Event('blur')); });
  await expectHistory(page, baseline + 1);
  await expect(field).toBeFocused();
  await field.pressSequentially(' and back');
  await field.press('Control+z');
  await expect(field).toHaveValue('Original body before switching apps');
  await field.press('Control+z');
  await expect(field).toHaveValue('Original body');
});

test('IME stays one Undo action across a pending blur boundary', async ({ page, context }) => {
  const baseline = await historyCount(page), field = body(page);
  await field.focus(); await field.press('Control+End');
  const cdp = await context.newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: 'に', selectionStart: 1, selectionEnd: 1 });
  await expect(field).toHaveValue('Original bodyに');
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  // A pause longer than ordinary fine Undo grouping must not split an IME.
  await page.waitForTimeout(650);
  await cdp.send('Input.imeSetComposition', { text: '日本', selectionStart: 2, selectionEnd: 2 });
  expect(await historyCount(page)).toBe(baseline);
  await cdp.send('Input.insertText', { text: '日本語' });
  await expect(field).toHaveValue('Original body日本語');
  await expectHistory(page, baseline + 1);
  await field.press('Control+z');
  await expect(field).toHaveValue('Original body');
  await field.press('Control+Shift+z');
  await expect(field).toHaveValue('Original body日本語');
  await cdp.detach();
});

test('new checklist rows retain their composing input until the first entry commits', async ({ page, context }) => {
  const field = editor(page).getByRole('textbox', { name: 'New list item', exact: true });
  await field.focus();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: 'に', selectionStart: 1, selectionEnd: 1 });
  await expect(field).toBeFocused();
  await expect(field).toHaveValue('に');
  await expect(item(page)).toHaveCount(1);
  await expect.poll(() => savedItems(page), { timeout: 2000 }).toContain('に');
  await cdp.send('Input.imeSetComposition', { text: '日本', selectionStart: 2, selectionEnd: 2 });
  await expect(field).toBeFocused();
  await expect.poll(() => savedItems(page), { timeout: 2000 }).toContain('日本');
  await cdp.send('Input.insertText', { text: '日本語' });
  const added = item(page).last();
  await expect(added).toHaveValue('日本語');
  await expect(added).toBeFocused();
  await expect(item(page)).toHaveCount(2);
  await added.press('Control+z');
  await expect(item(page)).toHaveCount(1);
  await cdp.detach();
});

test('the first composing checklist entry creates durable data without remounting its input', async ({ page, context }) => {
  await editor(page).getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'New checklist', exact: true }).click();
  const field = editor(page).getByRole('textbox', { name: 'New list item', exact: true });
  await expect(field).toBeFocused();
  const source = (await field.elementHandle())!;
  const cdp = await context.newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: 'に', selectionStart: 1, selectionEnd: 1 });
  await expect.poll(() => savedItems(page), { timeout: 2000 }).toContain('に');
  expect(await source.evaluate(element => element === document.activeElement)).toBe(true);
  await cdp.send('Input.imeSetComposition', { text: '日本', selectionStart: 2, selectionEnd: 2 });
  await expect.poll(() => savedItems(page), { timeout: 2000 }).toContain('日本');
  expect(await source.evaluate(element => element === document.activeElement)).toBe(true);
  await cdp.send('Input.insertText', { text: '日本語' });
  const added = item(page);
  await expect(added).toHaveValue('日本語');
  await expect(added).toBeFocused();
  await added.press('Control+z');
  await expect(item(page)).toHaveCount(0);
  await cdp.detach();
});

test('the first composing prose edit creates a note without remounting its focused field', async ({ page, context }) => {
  await editor(page).getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Take a note…', exact: true }).click();
  const field = body(page);
  await expect(field).toBeFocused();
  const source = (await field.elementHandle())!;
  const cdp = await context.newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: 'に', selectionStart: 1, selectionEnd: 1 });
  await expect(field).toHaveValue('に');
  expect(await source.evaluate(element => element === document.activeElement)).toBe(true);
  await cdp.send('Input.imeSetComposition', { text: '日本', selectionStart: 2, selectionEnd: 2 });
  await expect(field).toHaveValue('日本');
  expect(await source.evaluate(element => element === document.activeElement)).toBe(true);
  await cdp.send('Input.insertText', { text: '日本語' });
  await expect(field).toHaveValue('日本語');
  expect(await source.evaluate(element => element === document.activeElement)).toBe(true);
  await field.press('Control+z');
  await expect(field).toHaveValue('');
  await field.press('Control+Shift+z');
  await expect(field).toHaveValue('日本語');
  await editor(page).getByRole('button', { name: 'Close', exact: true }).click();
  await expectSavedBody(page, '日本語', '');
  await page.reload();
  await expect(page.getByRole('article', { name: 'Open note: Untitled note', exact: true })).toContainText('日本語');
  await cdp.detach();
});

test('a checklist composition finishing after blur preserves the newly focused field', async ({ page }) => {
  const field = editor(page).getByRole('textbox', { name: 'New list item', exact: true });
  await field.focus();
  const source = (await field.elementHandle())!;
  await source.evaluate(element => {
    element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, '仕');
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertCompositionText', data: '仕', isComposing: true }));
  });
  await expect(field).toHaveValue('仕');
  await title(page).focus();
  await source.evaluate(element => {
    element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '仕事' }));
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, '仕事');
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '仕事' }));
  });
  await expect(title(page)).toBeFocused();
  await expect(item(page).last()).toHaveText('仕事');
  await expect.poll(() => savedItems(page), { timeout: 2000 }).toContain('仕事');
});

test('closing a composing Markdown field waits for its final input instead of unmounting it', async ({ page }) => {
  const baseline = await historyCount(page), field = body(page);
  await field.focus();
  const source = (await field.elementHandle())!;
  // Explicit events keep composition pending across focus loss; real IMEs may
  // commit on blur themselves, which would not exercise the delayed-close path.
  await source.evaluate(element => {
    element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(element, 'Original body仕');
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertCompositionText', data: '仕', isComposing: true }));
  });
  await expect(field).toHaveValue('Original body仕');
  await editor(page).getByRole('button', { name: 'Close', exact: true }).click();
  await expect(editor(page)).toBeVisible();
  expect(await source.evaluate(element => element.isConnected)).toBe(true);
  expect(await historyCount(page)).toBe(baseline);
  await source.evaluate(element => {
    element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '仕事' }));
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(element, 'Original body仕事');
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '仕事' }));
  });
  await expect(editor(page)).toHaveCount(0);
  await expect(page.locator('.card-body')).toHaveText('Original body仕事');
  await expectHistory(page, baseline + 1);
  await page.locator('header').getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('.card-body')).toHaveText('Original body');
});

test('a newly created note seals title, body and checklist edits at their field boundaries', async ({ page }) => {
  await editor(page).getByRole('button', { name: 'Close', exact: true }).click();
  const baseline = await historyCount(page);
  await page.getByRole('button', { name: 'Take a note…', exact: true }).click();
  await append(title(page), 'New note boundary');
  await body(page).focus();
  await expectHistory(page, baseline + 2); // Creation plus the title session.
  await append(body(page), 'New note body');
  await editor(page).getByRole('button', { name: 'Add checklist', exact: true }).click();
  // Body blur and format change share one event and may yield one snapshot.
  await expectSavedBody(page, 'New note body', 'New note boundary');
  const beforeItem = await historyCount(page);
  await editor(page).getByRole('textbox', { name: 'New list item', exact: true }).fill('New note item');
  const field = item(page);
  await append(field, ' amended');
  await editor(page).getByRole('button', { name: 'Close', exact: true }).click();
  await expect.poll(() => historyCount(page), { timeout: 2000 }).toBeGreaterThan(beforeItem);
  await expect(page.getByRole('article', { name: 'Open note: New note boundary', exact: true })).toContainText('New note item amended');
});
