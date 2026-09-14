import { test, expect, type Page } from '@playwright/test';

async function createList(page: Page, title: string, text: string) {
  await page.goto('/');
  await expect(page.locator('.sync-state')).toHaveAttribute('title', 'Connected');
  await page.getByRole('button', { name: 'New checklist', exact: true }).click();
  await page.getByRole('textbox', { name: 'Note title', exact: true }).fill(title);
  await page.getByRole('textbox', { name: 'New list item', exact: true }).fill(text);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  return page.getByRole('article', { name: `Open note: ${title}`, exact: true });
}

const longItem = 'This checklist item has enough words to wrap onto several lines while every word remains visible and editable. '.repeat(3);

test('phone checklist text wraps in the card and editor; compact grips do not overlap checkboxes', async ({ browser }) => {
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const page = await phone.newPage();
    const card = await createList(page, 'Wrapped phone checklist', longItem);
    const preview = card.locator('.check-row > span').first();
    const cardText = await preview.evaluate(element => ({
      height: element.getBoundingClientRect().height,
      lineHeight: parseFloat(getComputedStyle(element).lineHeight),
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
    expect(cardText.height).toBeGreaterThan(cardText.lineHeight * 3);
    expect(cardText.scrollWidth).toBeLessThanOrEqual(cardText.clientWidth + 1);
    await card.getByRole('heading', { name: 'Wrapped phone checklist' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('textbox', { name: 'List item text', exact: true }).first().focus();
    const field = dialog.locator('textarea[data-item-id]').first();
    await field.click({ trial: true });
    await expect(field).toHaveValue(longItem);
    await expect.poll(() => field.evaluate(element => element.scrollHeight <= element.clientHeight + 1 && element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    const dimensions = await field.evaluate(element => ({ height: element.getBoundingClientRect().height, lineHeight: parseFloat(getComputedStyle(element).lineHeight) }));
    expect(dimensions.height).toBeGreaterThan(dimensions.lineHeight * 3);

    const row = dialog.locator('[data-check-row]').first();
    const grip = await row.locator('.item-drag-handle').boundingBox();
    const checkbox = await row.getByRole('checkbox').boundingBox();
    const text = await field.boundingBox();
    expect(grip!.width).toBe(16);
    expect(checkbox!.x - grip!.x - grip!.width).toBeGreaterThanOrEqual(4);
    expect(text!.x - checkbox!.x - checkbox!.width).toBeGreaterThanOrEqual(4);
    await expect(row.getByRole('checkbox')).not.toBeChecked();

    await field.press('Control+End');
    await field.press('Shift+Enter');
    await page.keyboard.insertText('Second paragraph within the same item.');
    await expect(dialog.locator('[data-check-row]')).toHaveCount(1);
    await expect(field).toHaveValue(`${longItem}\nSecond paragraph within the same item.`);
    await expect(row.getByRole('checkbox')).not.toBeChecked();
    await page.screenshot({ path: test.info().outputPath('stow-checklist-wrapping-phone.png'), fullPage: true });
  } finally { await phone.close(); }
});

test('checklist text reflows after narrowing and expands back without stale height', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 900 });
  const card = await createList(page, 'Responsive checklist', longItem);
  await card.click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'List item text', exact: true }).first().focus();
  const field = dialog.locator('textarea[data-item-id]').first();
  await field.click({ trial: true });
  const initialHeight = await field.evaluate(element => element.getBoundingClientRect().height);
  const grip = await dialog.locator('.item-drag-handle').first().boundingBox();
  expect(grip!.width).toBe(14);

  await page.setViewportSize({ width: 350, height: 900 });
  await expect.poll(() => field.evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThan(initialHeight);
  await expect.poll(() => field.evaluate(element => element.scrollHeight <= element.clientHeight + 1 && element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await expect(field).toHaveValue(longItem);

  await page.setViewportSize({ width: 1100, height: 900 });
  await expect.poll(() => field.evaluate(element => element.getBoundingClientRect().height)).toBe(initialHeight);
  await field.fill('Short again');
  await expect.poll(() => field.evaluate(element => element.getBoundingClientRect().height)).toBeLessThan(initialHeight);
});

test('same-line typing preserves editor geometry and closing releases sizing resources', async ({ page }) => {
  const card = await createList(page, 'Stable editor height', 'A short row');
  await card.click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'List item text', exact: true }).first().focus();
  const field = dialog.locator('textarea[data-item-id]').first();
  await expect(field).toHaveValue('A short row');
  await field.evaluate(element => {
    const observer = new MutationObserver(records => { (window as any).__editorHeightChanges.push(...records.map(record => record.oldValue)); });
    (window as any).__editorHeightChanges = [];
    (window as any).__stopEditorHeightObserver = () => observer.disconnect();
    observer.observe(element, { attributes: true, attributeFilter: ['style'], attributeOldValue: true });
  });
  await field.press('End'); await field.pressSequentially(' with text');
  expect(await page.evaluate(() => (window as any).__editorHeightChanges)).toEqual([]);
  await expect(field).toHaveValue('A short row with text');
  await page.evaluate(() => (window as any).__stopEditorHeightObserver());
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.locator('body > textarea[aria-hidden="true"]')).toHaveCount(0);
});

test('Enter creates and focuses one new item; IME confirmation does not create a row', async ({ page }) => {
  const card = await createList(page, 'Multiline keyboard semantics', 'Original item');
  await card.click();
  const dialog = page.getByRole('dialog');
  const first = dialog.locator('[data-check-row]').first().getByRole('textbox', { name: 'List item text', exact: true });
  await first.focus();
  const originalId = await first.getAttribute('data-item-id');
  const prevented = await first.evaluate(element => {
    const event = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, bubbles: true, cancelable: true });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(prevented).toBe(false);
  await expect(dialog.locator('[data-check-row]')).toHaveCount(1);
  await expect(first).toHaveValue('Original item');

  await first.press('End');
  await first.press('Enter');
  await expect(dialog.locator('[data-check-row]')).toHaveCount(2);
  const second = dialog.locator('[data-check-row]').nth(1).getByRole('textbox', { name: 'List item text', exact: true });
  await expect(second).toBeFocused();
  await page.keyboard.insertText('Next item');
  await expect(second).toHaveValue('Next item');
  await expect(first).toHaveAttribute('data-item-id', originalId!);
  await expect(first).toHaveText('Original item');

  await second.press('Enter');
  await expect(dialog.locator('[data-check-row]')).toHaveCount(3);
  await page.keyboard.press('Backspace');
  await expect(dialog.locator('[data-check-row]')).toHaveCount(2);
  await expect(second).toBeFocused();
});
