import { test, expect, type Locator, type Page } from '@playwright/test';

async function createList(page: Page, title: string, items: string[]) {
  await page.goto('/');
  await expect(page.locator('.sync-state')).toHaveAttribute('title', 'Connected');
  await page.getByRole('button', { name: 'New checklist', exact: true }).click();
  await page.getByRole('textbox', { name: 'Note title', exact: true }).fill(title);
  for (const text of items) await page.getByRole('textbox', { name: 'New list item', exact: true }).fill(text);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  return page.getByRole('article', { name: `Open note: ${title}`, exact: true });
}

const order = (container: Locator) => container.locator('[data-check-row] .item-drag-handle').evaluateAll(handles => handles.map(handle => handle.getAttribute('aria-label')!.slice('Reorder '.length)));

async function dragAfter(page: Page, handle: Locator, target: Locator, release = true) {
  await handle.click({ trial: true });
  const start = await handle.boundingBox(), end = await target.boundingBox();
  expect(start).not.toBeNull(); expect(end).not.toBeNull();
  await page.mouse.move(start!.x + start!.width / 2, start!.y + start!.height / 2);
  await page.mouse.down();
  await page.mouse.move(start!.x + start!.width / 2, end!.y + end!.height - 3, { steps: 10 });
  if (release) await page.mouse.up();
}

test('only the checkbox completes an item; row text and whitespace open the note', async ({ page }) => {
  const card = await createList(page, 'Checkbox hit targets', ['Milk', 'Bread']);
  await card.getByText('Milk', { exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit note' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('checkbox', { name: 'Complete Milk' })).not.toBeChecked();
  await dialog.getByRole('textbox', { name: 'List item text', exact: true }).first().click();
  await expect(dialog.getByRole('checkbox', { name: 'Complete Milk' })).not.toBeChecked();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  const row = card.locator('.check-row').filter({ hasText: 'Milk' });
  const box = await row.getByRole('checkbox').boundingBox();
  // The gap immediately beside the square belongs to the note, not the checkbox.
  await page.mouse.click(box!.x + box!.width + 4, box!.y + box!.height / 2);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('checkbox', { name: 'Complete Milk' })).not.toBeChecked();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await card.getByRole('checkbox', { name: 'Milk', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(card).toContainText('1 completed item');
});

test('empty checklist rows stay blank on the card and remain editable', async ({ page }) => {
  const card = await createList(page, 'Blank checklist row', ['Temporary text']);
  await card.click();
  const dialog = page.getByRole('dialog', { name: 'Edit note' });
  const row = dialog.locator('[data-check-row]').first();
  const field = row.getByRole('textbox', { name: 'List item text', exact: true });
  await field.click();
  await field.fill('');
  await expect(field).not.toHaveAttribute('placeholder', /\S/);
  await dialog.getByRole('textbox', { name: 'Note title', exact: true }).click();
  await expect(field).toHaveText('');
  await expect(row.getByRole('checkbox')).toBeVisible();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(card.locator('.check-row')).toHaveText('');
  await expect(card.getByRole('checkbox', { name: 'List item', exact: true })).toBeVisible();
  await card.click();
  await field.click();
  await field.fill('Timber');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(card.locator('.check-row')).toHaveText('Timber');
});

test('the grip reorders on drop, preserves text, syncs, and is one undo action', async ({ page, browser }) => {
  const card = await createList(page, 'Grip reorder', ['First', 'Second', 'Third', 'Fourth']);
  const other = await browser.newContext();
  try {
    const remote = await other.newPage();
    await remote.goto('/');
    const remoteCard = remote.getByRole('article', { name: 'Open note: Grip reorder', exact: true });
    await expect(remoteCard).toContainText('Fourth');
    await card.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('button', { name: 'Move item up', exact: true })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Move item down', exact: true })).toHaveCount(0);
    const handle = dialog.getByRole('button', { name: 'Reorder First', exact: true });
    const target = dialog.locator('.editor-check-row').filter({ has: page.getByRole('button', { name: 'Reorder Third', exact: true }) });
    await dragAfter(page, handle, target, false);
    expect(await order(dialog)).toEqual(['First', 'Second', 'Third', 'Fourth']);
    await page.mouse.up();
    await expect.poll(() => order(dialog)).toEqual(['Second', 'Third', 'First', 'Fourth']);
    await expect.poll(() => remoteCard.locator('.check-row span').allTextContents()).toEqual(['Second', 'Third', 'First', 'Fourth']);
    await page.keyboard.press('Control+z');
    await expect.poll(() => order(dialog)).toEqual(['First', 'Second', 'Third', 'Fourth']);
    await page.screenshot({ path: test.info().outputPath('stow-checklist-grips.png'), fullPage: true });
  } finally { await other.close(); }
});

test('Escape cancels a grip drag without closing the editor; focused grips support keyboard reorder', async ({ page }) => {
  const card = await createList(page, 'Cancel reorder', ['Alpha', 'Beta', 'Gamma']);
  await card.click();
  const dialog = page.getByRole('dialog');
  const handle = dialog.getByRole('button', { name: 'Reorder Alpha', exact: true });
  const target = dialog.locator('.editor-check-row').filter({ has: page.getByRole('button', { name: 'Reorder Gamma', exact: true }) });
  await dragAfter(page, handle, target, false);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(dialog).toBeVisible();
  expect(await order(dialog)).toEqual(['Alpha', 'Beta', 'Gamma']);
  await handle.focus();
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => order(dialog)).toEqual(['Beta', 'Alpha', 'Gamma']);
  await page.keyboard.press('ArrowUp');
  await expect.poll(() => order(dialog)).toEqual(['Alpha', 'Beta', 'Gamma']);
});

test('touch can drag the grip without checking an item', async ({ browser }) => {
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const page = await phone.newPage();
    const card = await createList(page, 'Touch reorder', ['One', 'Two', 'Three']);
    await card.click();
    const dialog = page.getByRole('dialog');
    const handle = dialog.getByRole('button', { name: 'Reorder One', exact: true });
    const target = dialog.locator('.editor-check-row').filter({ has: page.getByRole('button', { name: 'Reorder Three', exact: true }) });
    // Raw CDP coordinates must be sampled after the modal finishes moving.
    await handle.click({ trial: true });
    const start = await handle.boundingBox(), end = await target.boundingBox();
    const input = await phone.newCDPSession(page);
    await input.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: start!.x + start!.width / 2, y: start!.y + start!.height / 2 }] });
    await input.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: start!.x + start!.width / 2, y: end!.y + end!.height - 3 }] });
    await input.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(() => order(dialog)).toEqual(['Two', 'Three', 'One']);
    await expect(dialog.getByRole('checkbox', { checked: true })).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath('stow-checklist-grips-phone.png'), fullPage: true });
  } finally { await phone.close(); }
});
