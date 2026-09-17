import { test, expect, type Locator, type Page } from '@playwright/test';

const ORIGIN = 'http://localhost:4174';
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4////fwAJ+wP9CNHoHgAAAABJRU5ErkJggg==', 'base64');
const editor = (page: Page) => page.getByRole('dialog', { name: 'Edit note', exact: true });
const toolbarActions = (dialog: Locator) => dialog.locator('.editor-toolbar button').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label')));

test.beforeEach(async ({ page, context }, testInfo) => {
  await context.addCookies([{ name: 'stow_test_user', value: `creation-${testInfo.testId}-${testInfo.retry}@example.test`, url: ORIGIN }]);
  await page.goto(ORIGIN);
  await expect(page.locator('.sync-state')).toHaveAttribute('title', 'Connected');
});

test('creating and reopening a note share the editor and first typing preserves the focused field', async ({ page }) => {
  await page.getByRole('button', { name: 'Take a note…', exact: true }).click();
  const dialog = editor(page);
  const body = dialog.getByRole('textbox', { name: 'Note text', exact: true });
  await expect(body).toBeFocused();
  await dialog.evaluate(element => element.setAttribute('data-test-editor-instance', 'original'));
  await body.evaluate(element => element.setAttribute('data-test-input-instance', 'original'));
  await page.keyboard.insertText('First words');
  await expect(dialog).toHaveAttribute('data-test-editor-instance', 'original');
  await expect(body).toHaveAttribute('data-test-input-instance', 'original');
  await expect(body).toBeFocused();
  await page.keyboard.insertText(' keep flowing.');
  await expect(body).toHaveValue('First words keep flowing.');
  await dialog.getByRole('textbox', { name: 'Note title', exact: true }).fill('One editor');
  const actions = await toolbarActions(dialog);
  expect(actions).toEqual(['Close', 'Undo', 'Redo', 'Edit labels', 'Background color', 'Add image', 'Add checklist', 'Archive note', 'More note actions']);

  await page.locator('.modal-backdrop').click({ position: { x: 4, y: 4 } });
  await expect(dialog).toHaveCount(0);
  const card = page.getByRole('article', { name: 'Open note: One editor', exact: true });
  await expect(card).toContainText('First words keep flowing.');
  await card.click();
  expect(await toolbarActions(dialog)).toEqual(actions);
  await body.focus();
  await expect(body).toHaveValue('First words keep flowing.');
  await body.fill('Edited in the same place.');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(card).toContainText('Edited in the same place.');
  await expect(page.getByRole('article')).toHaveCount(1);
});

test('undoing a new note while viewing its history leaves a usable blank editor', async ({ page }) => {
  await page.getByRole('button', { name: 'Take a note…', exact: true }).click();
  const dialog = editor(page);
  const body = dialog.getByRole('textbox', { name: 'Note text', exact: true });
  await expect(body).toBeFocused();
  await page.keyboard.insertText('Original draft');
  await dialog.getByRole('button', { name: 'More note actions', exact: true }).click();
  await dialog.getByRole('button', { name: 'Version history', exact: true }).click();
  const history = page.getByRole('dialog', { name: 'Version history', exact: true });
  await expect(history).toBeVisible();

  // Undo both the initial edit and note creation, independently of their grouping.
  const undo = page.locator('header').getByRole('button', { name: 'Undo', exact: true });
  for (let count = 0; count < 4 && await undo.isEnabled(); count++) await page.keyboard.press('Control+z');
  await expect(undo).toBeDisabled();
  await expect(history).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await body.focus();
  await expect(body).toBeEditable();
  await expect(body).toHaveValue('');
  await page.keyboard.insertText('Replacement draft');
  await expect(history).toHaveCount(0);
  await expect(body).toHaveValue('Replacement draft');
  await expect(body).toBeFocused();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('article')).toHaveCount(1);
  await expect(page.getByRole('article')).toContainText('Replacement draft');
});

test('the image launcher opens the shared editor and dropping another image edits that note', async ({ page }) => {
  const choice = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'New note with image', exact: true }).click();
  await (await choice).setFiles({ name: 'first.png', mimeType: 'image/png', buffer: pixel });
  const dialog = editor(page);
  await expect(dialog.getByRole('img', { name: 'first.png', exact: true })).toBeVisible();
  await dialog.getByRole('textbox', { name: 'Note title', exact: true }).fill('Image entry');
  const files = await page.evaluateHandle(bytes => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(bytes)], 'second.png', { type: 'image/png' }));
    return transfer;
  }, [...pixel]);
  await dialog.dispatchEvent('drop', { dataTransfer: files });
  await files.dispose();
  await expect(dialog.locator('.editor-images img')).toHaveCount(2);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('article')).toHaveCount(1);
  await page.getByRole('article', { name: 'Open note: Image entry', exact: true }).click();
  await expect(dialog.getByRole('img', { name: 'first.png', exact: true })).toBeVisible();
  await expect(dialog.getByRole('img', { name: 'second.png', exact: true })).toBeVisible();
});

test('dropping or pasting an image onto the launcher opens the shared editor', async ({ page }) => {
  for (const action of ['drop', 'paste'] as const) {
    const files = await page.evaluateHandle(({ bytes, action }) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array(bytes)], `${action}.png`, { type: 'image/png' }));
      return transfer;
    }, { bytes: [...pixel], action });
    const launcher = page.locator('.composer');
    if (action === 'drop') await launcher.dispatchEvent('drop', { dataTransfer: files });
    else {
      // Playwright dispatchEvent creates a plain Event for paste, which drops
      // clipboardData. Supply the browser's actual clipboard event interface.
      await launcher.evaluate((element, clipboardData) => element.dispatchEvent(new ClipboardEvent('paste', {
        clipboardData, bubbles: true, cancelable: true,
      })), files);
    }
    await files.dispose();
    const dialog = editor(page);
    await expect(dialog.getByRole('img', { name: `${action}.png`, exact: true })).toBeVisible();
    await dialog.getByRole('textbox', { name: 'Note title', exact: true }).fill(`${action} entry`);
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(page.getByRole('article', { name: `Open note: ${action} entry`, exact: true }).getByRole('img', { name: `${action}.png`, exact: true })).toBeVisible();
  }
  await expect(page.getByRole('article')).toHaveCount(2);
});
