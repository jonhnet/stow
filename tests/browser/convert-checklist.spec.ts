import { test, expect, type Locator, type Page } from '@playwright/test';

const ORIGIN = 'http://localhost:4174';
const editor = (page: Page) => page.getByRole('dialog', { name: 'Edit note', exact: true });
const card = (page: Page, title: string) => page.getByRole('article', { name: `Open note: ${title}`, exact: true });
const body = (dialog: Locator) => dialog.getByRole('textbox', { name: 'Note text', exact: true });
const row = (dialog: Locator, text: string) => dialog.locator('[data-check-row]').filter({ has: dialog.page().getByRole('button', { name: `Reorder ${text}`, exact: true }) });
const itemOrder = (dialog: Locator) => dialog.locator('.item-drag-handle').evaluateAll(handles => handles.map(handle => handle.getAttribute('aria-label')!.slice('Reorder '.length)));

async function create(page: Page, title: string, text: string, checklist = false) {
  await page.getByRole('button', { name: checklist ? 'New checklist' : 'Take a note…', exact: true }).click();
  const dialog = editor(page);
  await dialog.getByRole('textbox', { name: 'Note title', exact: true }).fill(title);
  await body(dialog).focus();
  await body(dialog).fill(text);
  return dialog;
}

async function convert(dialog: Locator) {
  await dialog.getByRole('button', { name: 'More note actions', exact: true }).click();
  await dialog.getByRole('button', { name: 'Convert to checklist', exact: true }).click();
  await expect(dialog.locator('.editor-menu')).toHaveCount(0);
}

async function expectEmptyBody(dialog: Locator) {
  await body(dialog).focus();
  await expect(body(dialog)).toHaveValue('');
}

test.beforeEach(async ({ page, context }, testInfo) => {
  await context.addCookies([{ name: 'stow_test_user', value: `convert-checklist-${testInfo.testId}-${testInfo.retry}@example.test`, url: ORIGIN }]);
  await page.goto(ORIGIN);
  await expect(page.locator('.sync-state')).toHaveAttribute('title', 'Connected');
});

test('body lines become unchecked items with source text preserved, in one undo and redo', async ({ page }) => {
  const title = 'Typed in the wrong field';
  const source = '\n**First task**\n\n  *Second task*  \n \t \nVisit https://example.com\n';
  const lines = ['**First task**', '  *Second task*  ', 'Visit https://example.com'];
  const dialog = await create(page, title, source);
  await convert(dialog);

  await expect.poll(() => itemOrder(dialog)).toEqual(lines);
  await expect(dialog.locator('[data-check-row].is-child')).toHaveCount(0);
  await expect(dialog.locator('[data-check-row] input[type=checkbox]:checked')).toHaveCount(0);
  await expectEmptyBody(dialog);
  await expect(dialog.getByRole('textbox', { name: 'Note title', exact: true })).toHaveValue(title);
  for (const [index, line] of lines.entries()) {
    const text = dialog.locator('[data-check-row]').nth(index).getByRole('textbox', { name: 'List item text', exact: true });
    await text.focus();
    await expect(text).toHaveValue(line);
  }
  await body(dialog).focus();
  await expect(dialog.locator('[data-check-row]').nth(0).locator('strong')).toHaveText('First task');
  await expect(dialog.locator('[data-check-row]').nth(1).locator('em')).toHaveText('Second task');

  await page.keyboard.press('Control+z');
  await expect(body(dialog)).toHaveValue(source);
  await expect(dialog.locator('[data-check-row]')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Add checklist', exact: true })).toBeVisible();
  await page.keyboard.press('Control+Shift+z');
  await expectEmptyBody(dialog);
  await expect.poll(() => itemOrder(dialog)).toEqual(lines);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(card(page, title).getByRole('checkbox')).toHaveCount(lines.length);
});

test('converted lines precede existing checklist families without changing their identities or completion', async ({ page }) => {
  const source = 'New first\nNew second';
  const dialog = await create(page, 'Prepend to existing checklist', source, true);
  for (const text of ['Existing parent', 'Existing child', 'Existing last']) {
    await dialog.getByRole('textbox', { name: 'New list item', exact: true }).fill(text);
  }
  await row(dialog, 'Existing child').getByRole('textbox', { name: 'List item text', exact: true }).focus();
  await page.keyboard.press('Tab');
  await row(dialog, 'Existing child').getByRole('checkbox').check();
  await expect(row(dialog, 'Existing child')).toHaveClass(/is-child/);
  await dialog.getByRole('button', { name: 'Pin note', exact: true }).click();
  const originalRows = await dialog.locator('[data-check-row]').evaluateAll(rows => rows.map(element => ({
    id: element.getAttribute('data-check-row'), root: element.getAttribute('data-root-id'),
    parent: element.getAttribute('data-parent-id'), checked: element.querySelector<HTMLInputElement>('input[type=checkbox]')!.checked,
  })));
  const expectExistingRows = async () => {
    for (const original of originalRows) {
      const existing = dialog.locator(`[data-check-row="${original.id}"]`);
      await expect(existing).toHaveAttribute('data-root-id', original.root!);
      expect(await existing.getAttribute('data-parent-id')).toBe(original.parent);
      if (original.checked) await expect(existing.getByRole('checkbox')).toBeChecked();
      else await expect(existing.getByRole('checkbox')).not.toBeChecked();
    }
    await expect(dialog.getByRole('button', { name: 'Unpin note', exact: true })).toBeVisible();
  };

  await convert(dialog);
  await expect.poll(() => itemOrder(dialog)).toEqual(['New first', 'New second', 'Existing parent', 'Existing child', 'Existing last']);
  await expectExistingRows();
  for (const text of ['New first', 'New second']) {
    await expect(row(dialog, text)).not.toHaveClass(/is-child/);
    await expect(row(dialog, text).getByRole('checkbox')).not.toBeChecked();
  }
  await expectEmptyBody(dialog);
  await page.keyboard.press('Control+z');
  await expect(body(dialog)).toHaveValue(source);
  await expect.poll(() => itemOrder(dialog)).toEqual(['Existing parent', 'Existing child', 'Existing last']);
  await expectExistingRows();
  await page.keyboard.press('Control+Shift+z');
  await expectEmptyBody(dialog);
  await expect.poll(() => itemOrder(dialog)).toEqual(['New first', 'New second', 'Existing parent', 'Existing child', 'Existing last']);
  await expectExistingRows();
});

test('conversion while disconnected survives a full offline reload', async ({ page, context }) => {
  const title = 'Offline conversion';
  const dialog = await create(page, title, 'One\nTwo\nThree');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await context.setOffline(true);
  await card(page, title).getByRole('heading', { name: title, exact: true }).click();
  await convert(dialog);
  await expectEmptyBody(dialog);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.locator('.sync-state')).toHaveAttribute('aria-label', 'Offline — notes stored on this device');
  await page.reload();
  await card(page, title).getByRole('heading', { name: title, exact: true }).click();
  await expect.poll(() => itemOrder(dialog)).toEqual(['One', 'Two', 'Three']);
  await expectEmptyBody(dialog);
  await expect(dialog.locator('[data-check-row] input[type=checkbox]:checked')).toHaveCount(0);
  await context.setOffline(false);
  await expect(page.locator('.sync-state')).toHaveAttribute('title', 'Connected');
});

test('conversion is disabled without nonblank body lines and absent from trashed notes', async ({ page }) => {
  const title = 'No body to convert';
  const dialog = await create(page, title, '');
  for (const text of ['', '\n  \t\n']) {
    await body(dialog).click();
    await body(dialog).fill(text);
    await dialog.getByRole('button', { name: 'More note actions', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Convert to checklist', exact: true })).toBeDisabled();
  }
  await body(dialog).click();
  await body(dialog).fill('Text in the trash stays text');
  await dialog.getByRole('button', { name: 'More note actions', exact: true }).click();
  await dialog.getByRole('button', { name: 'Move to trash', exact: true }).click();
  await page.getByRole('button', { name: 'Trash', exact: true }).click();
  await card(page, title).getByRole('heading', { name: title, exact: true }).click();
  await dialog.getByRole('button', { name: 'More note actions', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Convert to checklist', exact: true })).toHaveCount(0);
});
