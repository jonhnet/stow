import { test, expect, type Locator, type Page } from '@playwright/test';

async function createList(page: Page, title: string, items: string[]) {
  await page.goto('/');
  await expect(page.locator('.sync-state')).toHaveAttribute('title', 'Connected');
  await page.getByRole('button', { name: 'New checklist', exact: true }).click();
  await page.getByRole('textbox', { name: 'Note title', exact: true }).fill(title);
  for (const text of items) await page.getByRole('textbox', { name: 'New list item', exact: true }).fill(text);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('article', { name: `Open note: ${title}`, exact: true }).getByRole('heading').click();
  return page.getByRole('dialog', { name: 'Edit note', exact: true });
}

const row = (dialog: Locator, text: string) => dialog.locator('[data-check-row]').filter({ has: dialog.page().getByRole('button', { name: `Reorder ${text}`, exact: true }) });
const grip = (dialog: Locator, text: string) => dialog.getByRole('button', { name: `Reorder ${text}`, exact: true });
const order = (dialog: Locator) => dialog.locator('[data-check-row] .item-drag-handle').evaluateAll(handles => handles.map(handle => handle.getAttribute('aria-label')!.slice('Reorder '.length)));
async function indent(page: Page, dialog: Locator, text: string) {
  await row(dialog, text).getByRole('textbox').click();
  await page.keyboard.press('Tab');
  await expect(row(dialog, text)).toHaveClass(/is-child/);
}
async function drag(page: Page, handle: Locator, target: Locator, dx = 0, release = true) {
  await handle.click({ trial: true });
  const start = await handle.boundingBox(), end = await target.boundingBox();
  expect(start).not.toBeNull(); expect(end).not.toBeNull();
  await page.mouse.move(start!.x + start!.width / 2, start!.y + start!.height / 2);
  await page.mouse.down();
  await page.mouse.move(start!.x + start!.width / 2 + dx, end!.y + end!.height - 3, { steps: 10 });
  if (release) await page.mouse.up();
}

test('keyboard nesting preserves the source field and selection, permits focus navigation, and enters sibling children', async ({ page }) => {
  const dialog = await createList(page, 'Keyboard nesting', ['Parent', 'Child text', 'Last']);
  const field = row(dialog, 'Child text').getByRole('textbox');
  await field.click();
  const source = await field.elementHandle();
  await source!.evaluate(element => (element as HTMLTextAreaElement).setSelectionRange(2, 5));
  await page.keyboard.press('Tab');
  await expect(row(dialog, 'Child text')).toHaveClass(/is-child/);
  expect(await source!.evaluate(element => ({ connected: element.isConnected, focused: document.activeElement === element, start: (element as HTMLTextAreaElement).selectionStart, end: (element as HTMLTextAreaElement).selectionEnd }))).toEqual({ connected: true, focused: true, start: 2, end: 5 });
  await expect(field).toHaveValue('Child text');
  await page.keyboard.press('Tab');
  await expect(row(dialog, 'Child text').getByRole('button', { name: 'Delete list item' })).toBeFocused();
  await field.click();
  await page.keyboard.press('Shift+Tab');
  await expect(row(dialog, 'Child text')).not.toHaveClass(/is-child/);
  await expect(field).toBeFocused();
  await grip(dialog, 'Child text').focus();
  await page.keyboard.press('ArrowRight');
  await expect(row(dialog, 'Child text')).toHaveClass(/is-child/);
  await grip(dialog, 'Parent').focus();
  await page.keyboard.press('ArrowRight');
  await expect(dialog.getByRole('status')).toHaveText('A group with child items cannot be nested.');
  await expect(row(dialog, 'Parent')).not.toHaveClass(/is-child/);

  // A checked child remains in its active family. Empty Backspace follows visible rows,
  // including a checked previous sibling, rather than filtering by checkbox state.
  await row(dialog, 'Child text').getByRole('checkbox').check();
  await field.click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  const empty = row(dialog, 'list item');
  await expect(empty).toHaveClass(/is-child/);
  await expect(empty.getByRole('textbox')).toBeFocused();
  await page.keyboard.press('Backspace');
  await expect(empty).toHaveCount(0);
  await expect(field).toBeFocused();
  await grip(dialog, 'Child text').focus();
  await page.keyboard.press('ArrowLeft');
  await expect(row(dialog, 'Child text')).not.toHaveClass(/is-child/);
});

test('Enter on a parent inserts and focuses its first child while Enter on a leaf keeps a root sibling', async ({ page }) => {
  const title = 'Enter above existing children';
  const dialog = await createList(page, title, ['Parent', 'Child one', 'Child two', 'Leaf']);
  await indent(page, dialog, 'Child one');
  await indent(page, dialog, 'Child two');
  const parentId = (await row(dialog, 'Parent').getAttribute('data-check-row'))!;
  const existingIds = await Promise.all(['Child one', 'Child two'].map(text => row(dialog, text).getAttribute('data-check-row')));
  await row(dialog, 'Parent').getByRole('textbox').click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  const empty = row(dialog, 'list item');
  await expect(empty).toHaveAttribute('data-parent-id', parentId);
  await expect(empty.getByRole('textbox')).toBeFocused();
  await expect.poll(() => order(dialog)).toEqual(['Parent', 'list item', 'Child one', 'Child two', 'Leaf']);
  await empty.getByRole('textbox').fill('First child');
  const newChildId = (await row(dialog, 'First child').getAttribute('data-check-row'))!;

  await row(dialog, 'Leaf').getByRole('textbox').click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await expect(empty).not.toHaveClass(/is-child/);
  await expect(empty.getByRole('textbox')).toBeFocused();
  await empty.getByRole('textbox').fill('Next root');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.locator('.sync-state')).toHaveAttribute('title', 'Connected');
  await page.reload();
  await page.getByRole('article', { name: `Open note: ${title}`, exact: true }).getByRole('heading').click();
  await expect.poll(() => order(dialog)).toEqual(['Parent', 'First child', 'Child one', 'Child two', 'Leaf', 'Next root']);
  await expect(row(dialog, 'First child')).toHaveAttribute('data-check-row', newChildId);
  for (const text of ['First child', 'Child one', 'Child two']) await expect(row(dialog, text)).toHaveAttribute('data-parent-id', parentId);
  for (const [index, text] of ['Child one', 'Child two'].entries()) await expect(row(dialog, text)).toHaveAttribute('data-check-row', existingIds[index]!);
  await expect(row(dialog, 'Next root')).not.toHaveClass(/is-child/);
});

test('completion keeps mixed families together and deleting a parent promotes children with undo', async ({ page }) => {
  const dialog = await createList(page, 'Nested completion', ['Parent', 'Child one', 'Child two', 'Other']);
  await indent(page, dialog, 'Child one');
  await indent(page, dialog, 'Child two');
  const active = dialog.getByRole('list', { name: 'Checklist items', exact: true });
  const completed = dialog.getByRole('list', { name: 'Completed checklist items', exact: true });
  await row(dialog, 'Child one').getByRole('checkbox').check();
  await expect(active.locator('[data-check-row]')).toHaveCount(4);
  await expect(completed).toHaveCount(0);
  await row(dialog, 'Parent').getByRole('checkbox').click();
  await expect(completed.locator('[data-check-row]')).toHaveCount(3);
  await expect(completed.getByRole('checkbox', { checked: true })).toHaveCount(3);
  await row(dialog, 'Child two').getByRole('checkbox').click();
  await expect(active.locator('[data-check-row]')).toHaveCount(4);
  await expect(row(dialog, 'Parent').getByRole('checkbox')).toBeChecked();
  // A parent click follows its checkbox state even when a child was independently unchecked.
  await row(dialog, 'Parent').getByRole('checkbox').click();
  await expect(active.getByRole('checkbox', { checked: false })).toHaveCount(4);
  await row(dialog, 'Parent').getByRole('checkbox').click();
  await expect(completed.getByRole('checkbox', { checked: true })).toHaveCount(3);
  await row(dialog, 'Parent').getByRole('checkbox').click();
  await expect(active.getByRole('checkbox', { checked: false })).toHaveCount(4);
  await row(dialog, 'Parent').getByRole('button', { name: 'Delete list item' }).click();
  await expect.poll(() => order(dialog)).toEqual(['Child one', 'Child two', 'Other']);
  await expect(dialog.locator('.is-child')).toHaveCount(0);
  await grip(dialog, 'Child one').focus();
  await page.keyboard.press('Control+z');
  await expect.poll(() => order(dialog)).toEqual(['Parent', 'Child one', 'Child two', 'Other']);
  await expect(dialog.locator('.is-child')).toHaveCount(2);
});

test('dragging a parent moves its children together and a child can join another family', async ({ page, browser }) => {
  const dialog = await createList(page, 'Group drag', ['Before', 'Parent', 'Child A', 'Child B', 'After', 'Tail']);
  await indent(page, dialog, 'Child A');
  await indent(page, dialog, 'Child B');
  const remote = await browser.newContext();
  try {
    const other = await remote.newPage();
    await other.goto('/');
    const card = other.getByRole('article', { name: 'Open note: Group drag', exact: true });
    await expect(card.locator('[data-check-depth="1"]')).toHaveCount(2);
    await drag(page, grip(dialog, 'Parent'), row(dialog, 'After'), 0, false);
    await expect(dialog.locator('.drag-source')).toHaveCount(3);
    await expect(page.locator('.check-drag-preview')).toContainText('2 child items');
    expect(await order(dialog)).toEqual(['Before', 'Parent', 'Child A', 'Child B', 'After', 'Tail']);
    await page.screenshot({ path: test.info().outputPath('nested-parent-drag.png') });
    await page.mouse.up();
    await expect.poll(() => order(dialog)).toEqual(['Before', 'After', 'Parent', 'Child A', 'Child B', 'Tail']);
    await expect.poll(() => card.locator('.check-row span').allTextContents()).toEqual(['Before', 'After', 'Parent', 'Child A', 'Child B', 'Tail']);
    await page.keyboard.press('Control+z');
    await expect.poll(() => order(dialog)).toEqual(['Before', 'Parent', 'Child A', 'Child B', 'After', 'Tail']);
    await drag(page, grip(dialog, 'Parent'), row(dialog, 'After'), 32, false);
    await expect(page.locator('.check-drag-preview')).toHaveClass(/invalid-drop/);
    await page.mouse.up();
    await expect(dialog.getByRole('status')).toHaveText('A group with child items cannot be nested.');
    await drag(page, grip(dialog, 'Child A'), row(dialog, 'After'));
    await expect(row(dialog, 'Child A')).toHaveAttribute('data-parent-id', (await row(dialog, 'After').getAttribute('data-check-row'))!);
    await expect.poll(() => order(dialog)).toEqual(['Before', 'Parent', 'Child B', 'After', 'Child A', 'Tail']);
    await drag(page, grip(dialog, 'Child A'), row(dialog, 'Child A'), -24);
    await expect(row(dialog, 'Child A')).not.toHaveClass(/is-child/);
    await expect.poll(() => order(dialog)).toEqual(['Before', 'Parent', 'Child B', 'After', 'Child A', 'Tail']);
  } finally { await remote.close(); }
});

test('touch horizontal gestures nest and outdent long wrapping text without toggling its checkbox', async ({ browser }) => {
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const page = await phone.newPage();
    const text = 'A long child item with several words and https://example.test/an/extremely/long/path/to/check/wrapping/without/horizontal/overflow';
    const dialog = await createList(page, 'Touch nesting', ['Parent', text, 'Other']);
    const input = await phone.newCDPSession(page);
    async function touchDrag(dx: number) {
      const handle = grip(dialog, text);
      await handle.click({ trial: true });
      const box = await handle.boundingBox();
      const start = { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
      await input.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] });
      await input.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: start.x + dx, y: start.y }] });
      await input.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    }
    await touchDrag(28);
    await expect(row(dialog, text)).toHaveClass(/is-child/);
    const parentBox = await row(dialog, 'Parent').getByRole('checkbox').boundingBox();
    const childBox = await row(dialog, text).getByRole('checkbox').boundingBox();
    expect(childBox!.x - parentBox!.x).toBeCloseTo(24, 0);
    await expect(dialog.getByRole('checkbox', { checked: true })).toHaveCount(0);
    expect(await row(dialog, text).getByRole('textbox').evaluate(element => element.scrollWidth <= element.clientWidth + 1 && element.getBoundingClientRect().height > 40)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath('nested-checklist-phone.png') });
    await touchDrag(-24);
    await expect(row(dialog, text)).not.toHaveClass(/is-child/);
    await expect(dialog.getByRole('checkbox', { checked: true })).toHaveCount(0);
  } finally { await phone.close(); }
});

test('a concurrent new child cancels a parent drag before it can commit a different family', async ({ page, browser }) => {
  const dialog = await createList(page, 'Concurrent drag membership', ['Parent', 'Child', 'Candidate', 'Other']);
  await indent(page, dialog, 'Child');
  const remote = await browser.newContext();
  try {
    const other = await remote.newPage();
    await other.goto('/');
    await other.getByRole('article', { name: 'Open note: Concurrent drag membership', exact: true }).getByRole('heading').click();
    const otherDialog = other.getByRole('dialog', { name: 'Edit note', exact: true });
    await expect(row(otherDialog, 'Child')).toHaveClass(/is-child/);
    await drag(page, grip(dialog, 'Parent'), row(dialog, 'Other'), 0, false);
    await expect(page.locator('.check-drag-preview')).toBeVisible();
    await indent(other, otherDialog, 'Candidate');
    await expect(page.locator('.check-drag-preview')).toHaveCount(0);
    await page.mouse.up();
    await expect(dialog.getByRole('status')).toHaveText('Reordering Parent canceled.');
    await expect.poll(() => order(dialog)).toEqual(['Parent', 'Child', 'Candidate', 'Other']);
    await expect(row(dialog, 'Candidate')).toHaveClass(/is-child/);
  } finally { await remote.close(); }
});

test('outdenting checked children reveals the completed bucket and retains source selection or grip focus', async ({ page }) => {
  const dialog = await createList(page, 'Nesting across completed buckets', ['Parent', 'Source child', 'Grip child', 'Pointer child', 'Done']);
  for (const text of ['Source child', 'Grip child', 'Pointer child']) {
    await indent(page, dialog, text);
    await row(dialog, text).getByRole('checkbox').check();
  }
  await row(dialog, 'Done').getByRole('checkbox').click();
  const completed = dialog.getByRole('list', { name: 'Completed checklist items', exact: true });
  await dialog.getByRole('button', { name: '1 completed item', exact: true }).click();
  await expect(completed).toHaveCount(0);
  const source = row(dialog, 'Source child').getByRole('textbox');
  await source.click();
  await source.evaluate(element => (element as HTMLTextAreaElement).setSelectionRange(2, 6, 'backward'));
  await page.keyboard.press('Shift+Tab');
  await expect(completed.locator('[data-check-row]')).toHaveCount(2);
  await expect(source).toBeFocused();
  await expect.poll(() => source.evaluate(element => ({ start: (element as HTMLTextAreaElement).selectionStart, end: (element as HTMLTextAreaElement).selectionEnd, direction: (element as HTMLTextAreaElement).selectionDirection }))).toEqual({ start: 2, end: 6, direction: 'backward' });
  await expect(row(dialog, 'Source child')).not.toHaveClass(/is-child/);
  await dialog.getByRole('button', { name: '2 completed items', exact: true }).click();
  await grip(dialog, 'Grip child').focus();
  await page.keyboard.press('ArrowLeft');
  await expect(completed.locator('[data-check-row]')).toHaveCount(3);
  await expect(grip(dialog, 'Grip child')).toBeFocused();
  await dialog.getByRole('button', { name: '3 completed items', exact: true }).click();
  await drag(page, grip(dialog, 'Pointer child'), row(dialog, 'Pointer child'), -24);
  await expect(completed.locator('[data-check-row]')).toHaveCount(4);
  await expect(grip(dialog, 'Pointer child')).toBeFocused();
  await expect(row(dialog, 'Pointer child')).not.toHaveClass(/is-child/);
});

test('Backspace on the last unchecked child reveals and focuses the newly completed family', async ({ page }) => {
  const dialog = await createList(page, 'Backspace completes family', ['Parent', 'Child', 'Done']);
  await indent(page, dialog, 'Child');
  await row(dialog, 'Parent').getByRole('checkbox').click();
  await row(dialog, 'Done').getByRole('checkbox').click();
  await row(dialog, 'Child').getByRole('textbox').click();
  await page.keyboard.press('Enter');
  const empty = row(dialog, 'list item');
  await expect(empty.getByRole('textbox')).toBeFocused();
  await expect(row(dialog, 'Parent').getByRole('checkbox')).toBeChecked();
  await dialog.getByRole('button', { name: '1 completed item', exact: true }).click();
  const completed = dialog.getByRole('list', { name: 'Completed checklist items', exact: true });
  await expect(completed).toHaveCount(0);
  await empty.getByRole('textbox').click();
  await page.keyboard.press('Backspace');
  await expect(empty).toHaveCount(0);
  await expect(completed.locator('[data-check-row]')).toHaveCount(3);
  await expect(row(dialog, 'Child').getByRole('textbox')).toBeFocused();
  await expect(row(dialog, 'Child').getByRole('textbox')).toHaveValue('Child');
});
