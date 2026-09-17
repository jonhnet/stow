import { test, expect, type Locator, type Page } from '@playwright/test';

const textbox = (scope: Locator, name: string) => scope.getByRole('textbox', { name, exact: true });
const itemRow = (scope: Locator, text: string) => scope.locator('[data-check-row]').filter({ has: scope.page().getByRole('button', { name: `Reorder ${text}`, exact: true }) });
const itemText = (scope: Locator, text: string) => textbox(itemRow(scope, text), 'List item text');
const noteCard = (page: Page, title: string) => page.getByRole('article', { name: `Open note: ${title}`, exact: true });

async function ready(page: Page) {
  await page.goto('/');
  await expect(page.locator('.sync-state')).toHaveAttribute('title', 'Connected');
}

async function openChecklist(page: Page, title: string, items: string[]) {
  await ready(page);
  await page.getByRole('button', { name: 'New checklist', exact: true }).click();
  await page.getByRole('textbox', { name: 'Note title', exact: true }).fill(title);
  for (const text of items) await page.getByRole('textbox', { name: 'New list item', exact: true }).fill(text);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await noteCard(page, title).getByRole('heading').click();
  return page.getByRole('dialog', { name: 'Edit note', exact: true });
}

async function caret(field: Locator, position: number | 'end') {
  await field.focus();
  await expect(field).toBeFocused();
  await field.evaluate((element: HTMLInputElement | HTMLTextAreaElement, offset) => {
    const index = offset === 'end' ? element.value.length : offset;
    element.setSelectionRange(index, index);
  }, position);
}

const selection = (field: Locator) => field.evaluate((element: HTMLInputElement | HTMLTextAreaElement) => ({ start: element.selectionStart, end: element.selectionEnd }));

test('a checklist always exposes its empty free text, including after clearing it and reloading', async ({ page }) => {
  await ready(page);
  await page.getByRole('button', { name: 'New checklist', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Edit note', exact: true });
  await expect(textbox(editor, 'Note text')).toBeVisible();
  await textbox(editor, 'New list item').fill('A durable checklist item');
  await textbox(editor, 'Note title').fill('Checklist with optional prose');
  await expect(textbox(editor, 'Note text')).toBeVisible();
  await editor.getByRole('button', { name: 'Close', exact: true }).click();
  await noteCard(page, 'Checklist with optional prose').getByRole('heading').click();
  const body = textbox(editor, 'Note text');
  await body.focus();
  await expect(body).toHaveValue('');
  await body.fill('Temporary description');
  await body.fill('');
  await textbox(editor, 'Note title').focus();
  await expect(body).toBeVisible();
  await editor.getByRole('button', { name: 'Close', exact: true }).click();
  await page.reload();
  await noteCard(page, 'Checklist with optional prose').getByRole('heading').click();
  await expect(body).toBeVisible();
  await body.focus();
  await body.fill('Description added after reopening an empty field');
  await editor.getByRole('button', { name: 'Close', exact: true }).click();
  await page.reload();
  const card = noteCard(page, 'Checklist with optional prose');
  await expect(card).toContainText('Description added after reopening an empty field');
  await expect(card.getByRole('checkbox', { name: 'A durable checklist item', exact: true })).not.toBeChecked();
});

test('a new checklist navigates title, empty body, and the new-item input before and after its first edit', async ({ page }) => {
  await ready(page);
  await page.getByRole('button', { name: 'New checklist', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Edit note', exact: true });
  const title = textbox(editor, 'Note title');
  const body = textbox(editor, 'Note text');
  const add = textbox(editor, 'New list item');
  await expect(add).toBeFocused();
  await add.press('ArrowUp');
  await expect(body).toBeFocused();
  await body.press('ArrowUp');
  await expect(title).toBeFocused();
  await title.press('ArrowDown');
  await expect(body).toBeFocused();
  await body.press('ArrowDown');
  await expect(add).toBeFocused();
  await expect(editor.locator('[data-check-row]')).toHaveCount(0);

  // The first edit persists the note without changing its editor or field order.
  await title.fill('Navigation after note creation');
  await title.press('ArrowDown');
  await expect(body).toBeFocused();
  await body.press('ArrowDown');
  await expect(add).toBeFocused();
  await add.press('ArrowUp');
  await expect(body).toBeFocused();
  await body.press('ArrowUp');
  await expect(title).toBeFocused();
  await expect(editor.locator('[data-check-row]')).toHaveCount(0);
});

test('closing untouched text and checklist editors leaves no note or undo action', async ({ page, context }, info) => {
  const origin = 'http://localhost:4174';
  await context.addCookies([{ name: 'stow_test_user', value: `untouched-${info.testId}-${info.repeatEachIndex}@example.test`, url: origin }]);
  await page.goto(origin);
  await expect(page.locator('.sync-state')).toHaveAttribute('title', 'Connected');
  const notes = page.locator('.note-card');
  const undo = page.locator('header').getByRole('button', { name: 'Undo', exact: true });
  await expect(notes).toHaveCount(0);
  await expect(undo).toBeDisabled();
  for (const launcher of ['Take a note…', 'New checklist']) {
    await page.getByRole('button', { name: launcher, exact: true }).click();
    const editor = page.getByRole('dialog', { name: 'Edit note', exact: true });
    await expect(editor).toBeVisible();
    await expect(textbox(editor, launcher === 'New checklist' ? 'New list item' : 'Note text')).toBeFocused();
    await editor.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(editor).toHaveCount(0);
    await expect(notes).toHaveCount(0);
    await expect(undo).toBeDisabled();
  }
  await page.reload();
  await expect(page.locator('.sync-state')).toHaveAttribute('title', 'Connected');
  await expect(notes).toHaveCount(0);
  await expect(undo).toBeDisabled();
});

test('adding a checklist preserves prose in the shared editor', async ({ page }) => {
  await ready(page);
  const title = 'Prose plus checklist';
  const prose = '**Context stays here**\nWith a second line.';
  await page.getByRole('button', { name: 'Take a note…', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Edit note', exact: true });
  await textbox(editor, 'Note title').fill(title);
  const body = textbox(editor, 'Note text');
  await body.focus();
  await body.fill(prose);
  await editor.getByRole('button', { name: 'Add checklist', exact: true }).click();
  await expect(textbox(editor, 'New list item')).toBeFocused();
  await body.focus();
  await expect(body).toHaveValue(prose);
  await textbox(editor, 'New list item').fill('An accompanying task');
  await editor.getByRole('button', { name: 'Close', exact: true }).click();
  const card = noteCard(page, title);
  await expect(card.locator('strong')).toHaveText('Context stays here');
  await expect(card.getByRole('checkbox', { name: 'An accompanying task', exact: true })).not.toBeChecked();
  await card.getByRole('heading').click();
  await body.focus();
  await expect(body).toHaveValue(prose);
  await textbox(editor, 'List item text').focus();
  await expect(textbox(editor, 'List item text')).toHaveValue('An accompanying task');
});

test('Ctrl and Cmd Enter close checklist editors without inserting an extra item', async ({ page }) => {
  await ready(page);
  await page.getByRole('button', { name: 'New checklist', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Edit note', exact: true });
  const title = 'Checklist close shortcuts';
  const card = noteCard(page, title);
  await textbox(editor, 'Note title').fill(title);
  await textbox(editor, 'New list item').fill('The only checklist item');

  for (const modifier of ['Control', 'Meta']) {
    for (const field of ['List item text', 'New list item']) {
      await textbox(editor, field).press(`${modifier}+Enter`);
      await expect(editor).toHaveCount(0);
      await expect(card.getByRole('checkbox')).toHaveCount(1);
      await card.getByRole('heading').click();
      await expect(editor.locator('[data-check-row]')).toHaveCount(1);
      await textbox(editor, 'List item text').focus();
      await expect(textbox(editor, 'List item text')).toHaveValue('The only checklist item');
      await expect(textbox(editor, 'New list item')).toHaveValue('');
    }
  }
});

test('arrows follow displayed checklist families and skip collapsed completed rows without changing them', async ({ page }) => {
  const editor = await openChecklist(page, 'Navigation through checklist families', ['Parent', 'Checked child', 'Other', 'Done']);
  await itemText(editor, 'Checked child').focus();
  await page.keyboard.press('Tab');
  await expect(itemRow(editor, 'Checked child')).toHaveClass(/is-child/);
  await itemRow(editor, 'Checked child').getByRole('checkbox').check();
  await itemRow(editor, 'Done').getByRole('checkbox').check();
  const title = textbox(editor, 'Note title');
  const body = textbox(editor, 'Note text');
  await body.focus();
  await body.fill('Checklist context');
  const fields = [title, body, itemText(editor, 'Parent'), itemText(editor, 'Checked child'), itemText(editor, 'Other'), textbox(editor, 'New list item'), itemText(editor, 'Done')];
  for (let index = 0; index < fields.length - 1; index++) {
    await caret(fields[index], 'end');
    await fields[index].press('ArrowDown');
    await expect(fields[index + 1]).toBeFocused();
    expect(await selection(fields[index + 1])).toEqual({ start: 0, end: 0 });
  }
  for (let index = fields.length - 1; index > 0; index--) {
    await caret(fields[index], 0);
    await fields[index].press('ArrowUp');
    await expect(fields[index - 1]).toBeFocused();
    const previousLength = await fields[index - 1].evaluate((element: HTMLInputElement | HTMLTextAreaElement) => element.value.length);
    expect(await selection(fields[index - 1])).toEqual({ start: previousLength, end: previousLength });
  }
  const visibleRows = editor.locator('[data-check-row] .item-drag-handle');
  // Checked state must not filter a child out of its family.
  expect(await visibleRows.evaluateAll(handles => handles.map(handle => handle.getAttribute('aria-label')))).toEqual(['Reorder Parent', 'Reorder Checked child', 'Reorder Other', 'Reorder Done']);
  await expect(itemRow(editor, 'Parent').getByRole('checkbox')).not.toBeChecked();
  await expect(itemRow(editor, 'Checked child').getByRole('checkbox')).toBeChecked();
  await expect(itemRow(editor, 'Other').getByRole('checkbox')).not.toBeChecked();
  await expect(itemRow(editor, 'Done').getByRole('checkbox')).toBeChecked();

  await editor.getByRole('button', { name: '1 completed item', exact: true }).click();
  await expect(itemRow(editor, 'Done')).toHaveCount(0);
  const add = textbox(editor, 'New list item');
  await add.focus();
  await add.press('ArrowDown');
  await expect(add).toBeFocused();
  await add.press('ArrowUp');
  await expect(itemText(editor, 'Other')).toBeFocused();
});

test('hard line breaks retain native cursor movement and leave fields only at the first or last line', async ({ page }) => {
  const editor = await openChecklist(page, 'Hard line navigation', ['First item', 'Following item']);
  const title = textbox(editor, 'Note title');
  const body = textbox(editor, 'Note text');
  const first = editor.locator('[data-check-row]').first().getByRole('textbox', { name: 'List item text', exact: true });
  const next = itemText(editor, 'Following item');
  const text = 'First line\nMiddle line\nLast line';
  await title.fill(text);
  await body.focus();
  await body.fill(text);
  // The new-item input is single-line; authored newlines belong in the item's textarea.
  await first.focus();
  await first.fill(text);
  await expect(first).toHaveValue(text);
  const fields = [title, body, first, next];
  for (let index = 0; index < fields.length - 1; index++) {
    const field = fields[index];
    await caret(field, 13);
    await field.press('ArrowDown');
    await expect(field).toBeFocused();
    expect((await selection(field)).start).toBeGreaterThan(13);
    await caret(field, 13);
    await field.press('ArrowUp');
    await expect(field).toBeFocused();
    expect((await selection(field)).start).toBeLessThan(13);
    // These are interior character offsets on the boundary lines, not text endpoints.
    await caret(field, text.length - 3);
    await field.press('ArrowDown');
    await expect(fields[index + 1]).toBeFocused();
    await caret(fields[index + 1], 3);
    await fields[index + 1].press('ArrowUp');
    await expect(field).toBeFocused();
  }
  // A trailing newline has a real empty last line; the preceding text is not a boundary.
  const trailing = 'Line before a trailing newline\n';
  await body.focus();
  await body.fill(trailing);
  await caret(body, trailing.length - 3);
  await body.press('ArrowDown');
  await expect(body).toBeFocused();
  expect(await selection(body)).toEqual({ start: trailing.length, end: trailing.length });
  await body.press('ArrowDown');
  await expect(first).toBeFocused();
  await expect(editor.locator('[data-check-row]')).toHaveCount(2);
  await expect(editor.getByRole('checkbox', { checked: true })).toHaveCount(0);
});

test('soft-wrapped title, prose, and checklist fields use visual line boundaries', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const text = '🔧 Several words make this field wrap across multiple visible lines without containing any explicit line break. '.repeat(3);
  const editor = await openChecklist(page, 'Wrapped navigation', [text, 'After wrapped item']);
  const title = textbox(editor, 'Note title');
  const body = textbox(editor, 'Note text');
  await title.fill(text);
  await body.focus();
  await body.fill(text);
  const fields = [title, body, editor.locator('[data-check-row]').first().getByRole('textbox', { name: 'List item text', exact: true }), itemText(editor, 'After wrapped item')];
  for (let index = 0; index < fields.length - 1; index++) {
    const field = fields[index];
    await caret(field, 3);
    expect(await field.evaluate(element => element.getBoundingClientRect().height / parseFloat(getComputedStyle(element).lineHeight))).toBeGreaterThan(3);
    await field.press('ArrowDown');
    await expect(field).toBeFocused();
    expect((await selection(field)).start).toBeGreaterThan(3);
    await caret(field, text.length - 3);
    await field.press('ArrowUp');
    await expect(field).toBeFocused();
    expect((await selection(field)).start).toBeLessThan(text.length - 3);
    await caret(field, text.length - 3);
    await field.press('ArrowDown');
    await expect(fields[index + 1]).toBeFocused();
    await caret(fields[index + 1], 3);
    await fields[index + 1].press('ArrowUp');
    await expect(field).toBeFocused();
  }
  await expect(editor.locator('[data-check-row]')).toHaveCount(2);
  await expect(editor.getByRole('checkbox', { checked: true })).toHaveCount(0);
});

test('selection, modified arrows, and IME arrows retain their native editing behavior', async ({ page }) => {
  const editor = await openChecklist(page, 'Selection navigation', ['Selection stays here', 'Next item']);
  const body = textbox(editor, 'Note text');
  await body.focus();
  await body.fill('Selection stays here');
  for (const field of [textbox(editor, 'Note title'), body, itemText(editor, 'Selection stays here')]) {
    await field.focus();
    await field.evaluate((element: HTMLInputElement | HTMLTextAreaElement) => element.setSelectionRange(2, 6));
    await field.press('ArrowDown');
    await expect(field).toBeFocused();
    await caret(field, 'end');
    await field.press('Shift+ArrowUp');
    await expect(field).toBeFocused();
    const selected = await selection(field);
    expect(selected.start).not.toBe(selected.end);
    await caret(field, 'end');
    await field.press('Control+ArrowDown');
    await expect(field).toBeFocused();
    await caret(field, 0);
    await field.press('Meta+ArrowUp');
    await expect(field).toBeFocused();
    const prevented = await field.evaluate(element => {
      const event = new KeyboardEvent('keydown', { key: 'ArrowUp', code: 'ArrowUp', isComposing: true, bubbles: true, cancelable: true });
      element.dispatchEvent(event);
      return event.defaultPrevented;
    });
    expect(prevented).toBe(false);
    await expect(field).toBeFocused();
  }
  expect(await editor.locator('[data-check-row] .item-drag-handle').evaluateAll(handles => handles.map(handle => handle.getAttribute('aria-label')))).toEqual(['Reorder Selection stays here', 'Reorder Next item']);
  await expect(editor.getByRole('checkbox', { checked: true })).toHaveCount(0);
});
