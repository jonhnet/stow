import { test, expect, type Page } from '@playwright/test';

const ORIGIN = 'http://localhost:4174';
const editor = (page: Page) => page.getByRole('dialog', { name: 'Edit note', exact: true });
const card = (page: Page) => page.getByRole('article', { name: 'Open note: PWA checklist', exact: true });
const action = (page: Page, name: string) => editor(page).getByRole('toolbar', { name: 'Edit history' }).getByRole('button', { name, exact: true });
test.use({ viewport: { width: 360, height: 740 }, hasTouch: true });

test.beforeEach(async ({ context, page }, info) => {
  await context.addCookies([{ name: 'stow_test_user', value: `pwa-${info.testId}-${info.retry}@example.test`, url: ORIGIN }]);
  // A real preceding entry detects accidentally leaving the application and
  // phantom entries left by repeatedly opening and closing notes.
  await page.goto(`${ORIGIN}/api/health`);
  await page.goto(ORIGIN);
  await expect(page.locator('.sync-state')).toHaveAttribute('title', 'Connected');
});

async function checklist(page: Page) {
  await page.getByRole('button', { name: 'New checklist', exact: true }).tap();
  await editor(page).getByRole('textbox', { name: 'Note title', exact: true }).fill('PWA checklist');
  for (const value of ['First', 'Second', 'Third']) {
    const input = editor(page).getByRole('textbox', { name: 'New list item', exact: true });
    await input.fill(value);
  }
  await editor(page).getByRole('button', { name: 'Close', exact: true }).tap();
  await expect(editor(page)).toHaveCount(0);
  await card(page).tap();
}

test('touch Undo/Redo stays visible with the keyboard viewport and survives a closed page', async ({ page, context }) => {
  await checklist(page);
  // The same checklist reorder operation used by touch drag, with deterministic
  // keyboard placement; taps exercise the visible actions without an overflow menu.
  const handle = editor(page).getByRole('button', { name: 'Reorder Second', exact: true });
  await handle.focus(); await handle.press('ArrowUp');
  const order = (target: Page) => editor(target).locator('[data-check-row] .item-drag-handle').evaluateAll(elements => elements.map(element => element.getAttribute('aria-label')));
  await expect.poll(() => order(page)).toEqual(['Reorder Second', 'Reorder First', 'Reorder Third']);
  await page.evaluate(() => {
    Object.defineProperties(visualViewport!, { height: { configurable: true, value: 330 }, offsetTop: { configurable: true, value: 40 } });
    visualViewport!.dispatchEvent(new Event('resize'));
  });
  for (const name of ['Undo', 'Redo']) {
    await expect(action(page, name)).toBeVisible();
    await expect.poll(() => action(page, name).evaluate(element => {
      const rect = element.getBoundingClientRect();
      return rect.height >= 44 && rect.top >= 40 && rect.bottom <= 370 && rect.left >= 0 && rect.right <= innerWidth;
    })).toBe(true);
  }
  await action(page, 'Undo').tap();
  await expect.poll(() => order(page)).toEqual(['Reorder First', 'Reorder Second', 'Reorder Third']);
  await expect(page.locator('.sync-state')).toHaveAttribute('title', 'Connected');
  await page.close();
  const reopened = await context.newPage(); await reopened.goto(ORIGIN); await card(reopened).tap();
  await expect(action(reopened, 'Redo')).toBeEnabled(); await action(reopened, 'Redo').tap();
  await expect.poll(() => order(reopened)).toEqual(['Reorder Second', 'Reorder First', 'Reorder Third']);
  await reopened.reload();
  await expect(editor(reopened)).toBeVisible();
  await action(reopened, 'Undo').tap();
  await expect.poll(() => order(reopened)).toEqual(['Reorder First', 'Reorder Second', 'Reorder Third']);
  await reopened.screenshot({ path: test.info().outputPath('stow-pwa-undo.png') });
});

test('native Back closes the note, Forward reopens it, and Close leaves no extra navigation step', async ({ page }) => {
  await checklist(page);
  await page.goBack();
  await expect(editor(page)).toHaveCount(0); await expect(card(page)).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/');
  await page.goForward(); await expect(editor(page)).toBeVisible();
  await page.reload(); await expect(editor(page)).toBeVisible();
  await page.goBack(); await expect(editor(page)).toHaveCount(0);
  for (let index = 0; index < 3; index++) {
    await card(page).tap();
    await editor(page).getByRole('button', { name: 'Close', exact: true }).tap();
    await expect(editor(page)).toHaveCount(0);
  }
  await page.goBack(); await expect(page).toHaveURL(`${ORIGIN}/api/health`);
});

test('Back from a blank new note creates no note and does not trap navigation', async ({ page }) => {
  await page.getByRole('button', { name: 'Take a note…', exact: true }).tap();
  await expect(action(page, 'Undo')).toBeDisabled(); await expect(action(page, 'Redo')).toBeDisabled();
  await page.goBack(); await expect(editor(page)).toHaveCount(0);
  await expect(page.getByRole('article')).toHaveCount(0);
  await page.goBack(); await expect(page).toHaveURL(`${ORIGIN}/api/health`);
});

test('pending offline changes and Undo survive reload without contacting the server', async ({ page, context }) => {
  await checklist(page);
  await context.setOffline(true);
  const first = editor(page).getByRole('textbox', { name: 'List item text', exact: true }).first();
  await first.focus(); await first.fill('Offline change');
  // Unacknowledged server requests can remain pending offline; "Offline"
  // (rather than "Saving…") means this edit has committed to local storage.
  await expect(page.locator('.sync-state')).toHaveText('Offline');
  await page.reload(); await expect(editor(page)).toBeVisible();
  await first.focus(); await expect(first).toHaveValue('Offline change');
  await action(page, 'Undo').tap(); await first.focus(); await expect(first).toHaveValue('First');
});
