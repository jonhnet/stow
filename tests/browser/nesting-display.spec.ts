import { test, expect } from '@playwright/test';

const ORIGIN = 'http://localhost:4174';

for (const width of [1280, 390]) test(`checklist groups display and toggle in cards and retain history indentation at ${width}px`, async ({ page, context }) => {
  await page.setViewportSize({ width, height: 900 });
  await context.addCookies([{ name: 'stow_test_user', value: `nesting-display-${width}@example.test`, url: ORIGIN }]);
  await page.goto(ORIGIN);
  await expect(page.locator('.sync-state')).toHaveAttribute('title', 'Connected');
  await page.getByRole('button', { name: 'New checklist', exact: true }).click();
  await page.getByRole('textbox', { name: 'Note title', exact: true }).fill('Camping gear');
  for (const text of ['Pack', 'Lantern', 'Batteries']) await page.getByRole('textbox', { name: 'New list item', exact: true }).fill(text);
  for (const text of ['Lantern', 'Batteries']) {
    const row = page.locator('[data-check-row]').filter({ has: page.getByRole('checkbox', { name: `Complete ${text}`, exact: true }) });
    await row.getByRole('textbox', { name: 'List item text', exact: true }).click();
    await page.keyboard.press('Tab');
  }
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  const card = page.getByRole('article', { name: 'Open note: Camping gear', exact: true });
  await expect(card.locator('[data-check-depth="1"]')).toHaveCount(2);
  const parent = card.getByRole('checkbox', { name: 'Pack', exact: true });
  const child = card.getByRole('checkbox', { name: 'Lantern', exact: true });
  const parentBox = await parent.boundingBox(), childBox = await child.boundingBox();
  expect(childBox!.x - parentBox!.x).toBeCloseTo(24, 0);
  await child.check();
  await expect(parent).not.toBeChecked();
  await expect(child).toBeChecked();
  await expect(card.locator('[data-check-depth="1"]')).toHaveCount(2);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await parent.click();
  await expect(card).toContainText('3 completed items');
  await expect(card.getByRole('checkbox')).toHaveCount(0);
  await page.keyboard.press('Control+z');
  await expect(parent).not.toBeChecked();
  await expect(child).toBeChecked();
  await expect(card.getByRole('checkbox', { name: 'Batteries', exact: true })).not.toBeChecked();
  await card.getByRole('heading', { name: 'Camping gear', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Edit note', exact: true });
  await editor.getByRole('button', { name: 'More note actions' }).click();
  await editor.getByRole('button', { name: 'Version history', exact: true }).click();
  const history = page.getByRole('dialog', { name: 'Version history', exact: true });
  await history.getByRole('button', { name: 'Preview version', exact: true }).first().click();
  await expect(history.locator('.revision-preview [data-check-depth="1"]')).toHaveCount(2);
  await expect(history.locator('.revision-preview')).toContainText('Lantern');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath(`nested-history-${width}.png`) });
  await history.getByRole('button', { name: 'Restore copy', exact: true }).first().click();
  await expect(editor).toBeVisible();
  await editor.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(card).toHaveCount(2);
  for (const copy of await card.all()) await expect(copy.locator('[data-check-depth="1"]')).toHaveCount(2);
});
