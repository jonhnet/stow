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
async function columnX(handle: Locator, depth: 'root' | 'nested') {
  return handle.evaluate((element, depth) => {
    const group = element.closest('[data-check-group]')!;
    const selector = depth === 'root' ? '[data-check-row]:not([data-parent-id])' : '[data-check-row][data-parent-id]';
    const checkbox = group.querySelector(`${selector} input[type="checkbox"]`)!.getBoundingClientRect();
    return depth === 'root' ? checkbox.right + 1 : checkbox.left + checkbox.width / 2;
  }, depth);
}
async function drag(page: Page, handle: Locator, target: Locator, depth: 'root' | 'nested' = 'root', release = true) {
  await handle.click({ trial: true });
  const start = await handle.boundingBox(), end = await target.boundingBox();
  expect(start).not.toBeNull(); expect(end).not.toBeNull();
  const x = await columnX(handle, depth);
  await page.mouse.move(start!.x + start!.width / 2, start!.y + start!.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, end!.y + end!.height - 3, { steps: 10 });
  if (release) await page.mouse.up();
}

for (const method of ['horizontal drag', 'Tab', 'ArrowRight'] as const) {
  test(`${method} indents a parent beside its existing child without changing row order`, async ({ page }) => {
    const dialog = await createList(page, `Graphical nesting with ${method}`, ['A', 'B', 'C', 'D']);
    const ids = await dialog.locator('[data-check-row]').evaluateAll(rows => rows.map(element => element.getAttribute('data-check-row')));
    await indent(page, dialog, 'C');
    await expect(row(dialog, 'C')).toHaveAttribute('data-parent-id', ids[1]!);

    if (method === 'horizontal drag') {
      const handle = grip(dialog, 'B');
      await handle.click({ trial: true });
      const box = (await handle.boundingBox())!;
      const x = box.x + box.width / 2, y = box.y + box.height / 2;
      const targetX = await columnX(handle, 'nested');
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(targetX, y, { steps: 10 });
      await expect(page.locator('.check-drag-preview')).not.toHaveClass(/invalid-drop/);
      await page.mouse.up();
    } else if (method === 'Tab') {
      await row(dialog, 'B').getByRole('textbox').click();
      await page.keyboard.press('Tab');
      await expect(row(dialog, 'B').getByRole('textbox')).toBeFocused();
    } else {
      await grip(dialog, 'B').focus();
      await page.keyboard.press('ArrowRight');
      await expect(grip(dialog, 'B')).toBeFocused();
    }

    for (const text of ['B', 'C']) await expect(row(dialog, text)).toHaveAttribute('data-parent-id', ids[0]!);
    await expect(row(dialog, 'D')).not.toHaveClass(/is-child/);
    await expect.poll(() => order(dialog)).toEqual(['A', 'B', 'C', 'D']);
    await expect.poll(() => dialog.locator('[data-check-row]').evaluateAll(rows => rows.map(element => element.getAttribute('data-check-row')))).toEqual(ids);
    await expect(dialog.getByRole('checkbox', { checked: true })).toHaveCount(0);

    await grip(dialog, 'B').focus();
    await page.keyboard.press('Control+z');
    await expect(row(dialog, 'B')).not.toHaveClass(/is-child/);
    await expect(row(dialog, 'C')).toHaveAttribute('data-parent-id', ids[1]!);
    await expect.poll(() => order(dialog)).toEqual(['A', 'B', 'C', 'D']);
    await page.keyboard.press('Control+Shift+z');
    for (const text of ['B', 'C']) await expect(row(dialog, text)).toHaveAttribute('data-parent-id', ids[0]!);
    await expect.poll(() => order(dialog)).toEqual(['A', 'B', 'C', 'D']);
  });
}

for (const method of ['horizontal drag', 'Shift+Tab', 'ArrowLeft'] as const) {
  for (const item of ['B', 'C']) {
    test(`${method} outdents ${item} in place and keeps following rows as its children`, async ({ page }) => {
      const texts = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
      const dialog = await createList(page, `Graphical outdent ${item} with ${method}`, texts);
      for (const child of ['B', 'C', 'D']) await indent(page, dialog, child);
      const ids = await dialog.locator('[data-check-row]').evaluateAll(rows => rows.map(element => element.getAttribute('data-check-row')));
      const position = texts.indexOf(item), following = texts[position + 1];
      if (method === 'horizontal drag') {
        const handle = grip(dialog, item);
        await handle.click({ trial: true });
        const box = (await handle.boundingBox())!;
        const x = box.x + box.width / 2, y = box.y + box.height / 2;
        const targetX = await columnX(handle, 'root');
        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.mouse.move(targetX, y, { steps: 10 });
        await expect(page.locator('.check-drag-preview')).not.toHaveClass(/invalid-drop/);
        await expect(row(dialog, following)).toHaveClass(/insert-before/);
        await expect(row(dialog, 'D')).not.toHaveClass(/insert-after/);
        await page.mouse.up();
      } else if (method === 'Shift+Tab') {
        await row(dialog, item).getByRole('textbox').click();
        await page.keyboard.press('Shift+Tab');
        await expect(row(dialog, item).getByRole('textbox')).toBeFocused();
      } else {
        await grip(dialog, item).focus();
        await page.keyboard.press('ArrowLeft');
        await expect(grip(dialog, item)).toBeFocused();
      }

      await expect(row(dialog, item)).not.toHaveClass(/is-child/);
      for (const child of texts.slice(position + 1, 4)) await expect(row(dialog, child)).toHaveAttribute('data-parent-id', ids[position]!);
      for (const child of texts.slice(1, position)) await expect(row(dialog, child)).toHaveAttribute('data-parent-id', ids[0]!);
      for (const root of ['A', 'E', 'F', 'G']) await expect(row(dialog, root)).not.toHaveClass(/is-child/);
      await expect.poll(() => order(dialog)).toEqual(texts);
      await expect.poll(() => dialog.locator('[data-check-row]').evaluateAll(rows => rows.map(element => element.getAttribute('data-check-row')))).toEqual(ids);
      await expect(dialog.getByRole('checkbox', { checked: true })).toHaveCount(0);

      await grip(dialog, item).focus();
      await page.keyboard.press('Control+z');
      for (const child of ['B', 'C', 'D']) await expect(row(dialog, child)).toHaveAttribute('data-parent-id', ids[0]!);
      await expect.poll(() => order(dialog)).toEqual(texts);
      await page.keyboard.press('Control+Shift+z');
      await expect(row(dialog, item)).not.toHaveClass(/is-child/);
      for (const child of texts.slice(position + 1, 4)) await expect(row(dialog, child)).toHaveAttribute('data-parent-id', ids[position]!);
      await expect.poll(() => order(dialog)).toEqual(texts);
    });
  }
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
  await expect(row(dialog, 'Parent')).not.toHaveClass(/is-child/);
  await expect(grip(dialog, 'Parent')).toBeFocused();

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

test('dragging a parent moves only that row and leaves its children beneath the preceding root', async ({ page, browser }) => {
  const dialog = await createList(page, 'Single row drag', ['A', 'B', 'C', 'D', 'E']);
  await indent(page, dialog, 'B');
  await indent(page, dialog, 'D');
  const aId = (await row(dialog, 'A').getAttribute('data-check-row'))!;
  const cId = (await row(dialog, 'C').getAttribute('data-check-row'))!;
  const remote = await browser.newContext();
  try {
    const other = await remote.newPage();
    await other.goto('/');
    const card = other.getByRole('article', { name: 'Open note: Single row drag', exact: true });
    await expect(card.locator('[data-check-depth="1"]')).toHaveCount(2);
    await drag(page, grip(dialog, 'C'), row(dialog, 'E'), 'root', false);
    await expect(dialog.locator('.drag-source')).toHaveCount(1);
    await expect(row(dialog, 'C')).toHaveClass(/drag-source/);
    await expect(page.locator('.check-drag-preview')).toHaveText('C');
    expect(await order(dialog)).toEqual(['A', 'B', 'C', 'D', 'E']);
    await page.screenshot({ path: test.info().outputPath('single-parent-row-drag.png') });
    await page.mouse.up();
    await expect.poll(() => order(dialog)).toEqual(['A', 'B', 'D', 'E', 'C']);
    await expect(row(dialog, 'C')).not.toHaveClass(/is-child/);
    for (const text of ['B', 'D']) await expect(row(dialog, text)).toHaveAttribute('data-parent-id', aId);
    await expect.poll(() => card.locator('.check-row span').allTextContents()).toEqual(['A', 'B', 'D', 'E', 'C']);
    await expect(card.locator('[data-check-depth="1"]')).toHaveCount(2);
    await page.keyboard.press('Control+z');
    await expect.poll(() => order(dialog)).toEqual(['A', 'B', 'C', 'D', 'E']);
    await expect(row(dialog, 'D')).toHaveAttribute('data-parent-id', cId);
    await page.keyboard.press('Control+Shift+z');
    await expect.poll(() => order(dialog)).toEqual(['A', 'B', 'D', 'E', 'C']);
    await expect(row(dialog, 'D')).toHaveAttribute('data-parent-id', aId);
  } finally { await remote.close(); }
});

test('dragging the first root promotes its first remaining child and moves the root alone', async ({ page }) => {
  const dialog = await createList(page, 'Move first root', ['A', 'B', 'C', 'D']);
  await indent(page, dialog, 'B');
  await indent(page, dialog, 'C');
  const aId = (await row(dialog, 'A').getAttribute('data-check-row'))!;
  const bId = (await row(dialog, 'B').getAttribute('data-check-row'))!;
  await drag(page, grip(dialog, 'A'), row(dialog, 'D'));
  await expect.poll(() => order(dialog)).toEqual(['B', 'C', 'D', 'A']);
  await expect(row(dialog, 'B')).not.toHaveClass(/is-child/);
  await expect(row(dialog, 'C')).toHaveAttribute('data-parent-id', bId);
  await expect(row(dialog, 'A')).not.toHaveClass(/is-child/);
  await page.keyboard.press('Control+z');
  await expect.poll(() => order(dialog)).toEqual(['A', 'B', 'C', 'D']);
  for (const text of ['B', 'C']) await expect(row(dialog, text)).toHaveAttribute('data-parent-id', aId);
});

for (const depth of ['root', 'nested'] as const) test(`the ${depth} drop column is fixed when grabbing either edge of the handle`, async ({ page }) => {
  const dialog = await createList(page, `Fixed ${depth} column`, ['A', 'B', 'C', 'D']);
  await indent(page, dialog, 'B');
  const aId = (await row(dialog, 'A').getAttribute('data-check-row'))!;
  const x = await columnX(grip(dialog, 'D'), depth);
  for (const side of ['left', 'right']) {
    const handle = grip(dialog, 'D');
    await handle.click({ trial: true });
    const box = (await handle.boundingBox())!, target = (await row(dialog, 'B').boundingBox())!;
    await page.mouse.move(side === 'left' ? box.x + 1 : box.x + box.width - 1, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(x, target.y + target.height - 3, { steps: 10 });
    await expect(dialog.locator('.drag-source')).toHaveCount(1);
    await expect(page.locator('.check-drag-preview')).not.toHaveClass(/invalid-drop/);
    if (depth === 'root') {
      await expect(page.locator('.check-drag-preview')).not.toHaveClass(/nested-drop/);
      await expect(row(dialog, 'C')).toHaveClass(/insert-before/);
    } else {
      await expect(page.locator('.check-drag-preview')).toHaveClass(/nested-drop/);
      await expect(row(dialog, 'B')).toHaveClass(/insert-after/);
    }
    await page.mouse.up();
    await expect.poll(() => order(dialog)).toEqual(['A', 'B', 'D', 'C']);
    if (depth === 'root') await expect(row(dialog, 'D')).not.toHaveClass(/is-child/);
    else await expect(row(dialog, 'D')).toHaveAttribute('data-parent-id', aId);
    await page.keyboard.press('Control+z');
    await expect.poll(() => order(dialog)).toEqual(['A', 'B', 'C', 'D']);
    await expect(row(dialog, 'D')).not.toHaveClass(/is-child/);
  }
});

test('touch horizontal gestures nest and outdent long wrapping text without toggling its checkbox', async ({ browser }) => {
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const page = await phone.newPage();
    const text = 'A long child item with several words and https://example.test/an/extremely/long/path/to/check/wrapping/without/horizontal/overflow';
    const dialog = await createList(page, 'Touch nesting', ['Parent', 'Existing child', text, 'Other']);
    await indent(page, dialog, 'Existing child');
    const input = await phone.newCDPSession(page);
    async function touchDrag(depth: 'root' | 'nested') {
      const handle = grip(dialog, text);
      await handle.click({ trial: true });
      const box = await handle.boundingBox();
      const start = { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
      const targetX = await columnX(handle, depth);
      await input.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] });
      await input.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: targetX, y: start.y }] });
      await input.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    }
    await touchDrag('nested');
    await expect(row(dialog, text)).toHaveClass(/is-child/);
    const parentBox = await row(dialog, 'Parent').getByRole('checkbox').boundingBox();
    const childBox = await row(dialog, text).getByRole('checkbox').boundingBox();
    expect(childBox!.x).toBeGreaterThan(parentBox!.x + parentBox!.width);
    await expect(dialog.getByRole('checkbox', { checked: true })).toHaveCount(0);
    expect(await row(dialog, text).getByRole('textbox').evaluate(element => element.scrollWidth <= element.clientWidth + 1 && element.getBoundingClientRect().height > 40)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath('nested-checklist-phone.png') });
    await touchDrag('root');
    await expect(row(dialog, text)).not.toHaveClass(/is-child/);
    await expect(dialog.getByRole('checkbox', { checked: true })).toHaveCount(0);
  } finally { await phone.close(); }
});

test('a concurrent new child stays behind while the parent drag remains active', async ({ page, browser }) => {
  const dialog = await createList(page, 'Concurrent drag membership', ['Parent', 'Child', 'Candidate', 'Other']);
  await indent(page, dialog, 'Child');
  const remote = await browser.newContext();
  try {
    const other = await remote.newPage();
    await other.goto('/');
    await other.getByRole('article', { name: 'Open note: Concurrent drag membership', exact: true }).getByRole('heading').click();
    const otherDialog = other.getByRole('dialog', { name: 'Edit note', exact: true });
    await expect(row(otherDialog, 'Child')).toHaveClass(/is-child/);
    await drag(page, grip(dialog, 'Parent'), row(dialog, 'Other'), 'root', false);
    await expect(page.locator('.check-drag-preview')).toBeVisible();
    await indent(other, otherDialog, 'Candidate');
    await expect(row(dialog, 'Candidate')).toHaveClass(/is-child/);
    await expect(page.locator('.check-drag-preview')).toBeVisible();
    await expect(dialog.locator('.drag-source')).toHaveCount(1);
    await page.mouse.up();
    await expect.poll(() => order(dialog)).toEqual(['Child', 'Candidate', 'Other', 'Parent']);
    await expect(row(dialog, 'Child')).not.toHaveClass(/is-child/);
    await expect(row(dialog, 'Candidate')).toHaveAttribute('data-parent-id', (await row(dialog, 'Child').getAttribute('data-check-row'))!);
    await expect(row(dialog, 'Parent')).not.toHaveClass(/is-child/);
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
  await expect(completed.locator('[data-check-row]')).toHaveCount(4);
  await expect(source).toBeFocused();
  await expect.poll(() => source.evaluate(element => ({ start: (element as HTMLTextAreaElement).selectionStart, end: (element as HTMLTextAreaElement).selectionEnd, direction: (element as HTMLTextAreaElement).selectionDirection }))).toEqual({ start: 2, end: 6, direction: 'backward' });
  await expect(row(dialog, 'Source child')).not.toHaveClass(/is-child/);
  for (const text of ['Grip child', 'Pointer child']) await expect(row(dialog, text)).toHaveAttribute('data-parent-id', (await row(dialog, 'Source child').getAttribute('data-check-row'))!);
  await grip(dialog, 'Source child').focus();
  await page.keyboard.press('Control+z');
  await expect(completed.locator('[data-check-row]')).toHaveCount(1);
  await dialog.getByRole('button', { name: '1 completed item', exact: true }).click();
  await grip(dialog, 'Grip child').focus();
  await page.keyboard.press('ArrowLeft');
  await expect(completed.locator('[data-check-row]')).toHaveCount(3);
  await expect(grip(dialog, 'Grip child')).toBeFocused();
  await expect(row(dialog, 'Pointer child')).toHaveAttribute('data-parent-id', (await row(dialog, 'Grip child').getAttribute('data-check-row'))!);
  await page.keyboard.press('Control+z');
  await expect(completed.locator('[data-check-row]')).toHaveCount(1);
  await dialog.getByRole('button', { name: '1 completed item', exact: true }).click();
  await drag(page, grip(dialog, 'Pointer child'), row(dialog, 'Pointer child'), 'root');
  await expect(completed.locator('[data-check-row]')).toHaveCount(2);
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
