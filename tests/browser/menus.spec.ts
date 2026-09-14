import { test, expect, type Locator, type Page } from '@playwright/test';

const ORIGIN = 'http://localhost:4174';

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
test.beforeEach(async ({ page, context }, testInfo) => {
  await context.addCookies([{ name: 'stow_test_user', value: `menus-${testInfo.testId}-${testInfo.retry}@example.test`, url: ORIGIN }]);
  await page.goto(ORIGIN);
  await expect(page.locator('.sync-state')).toHaveAttribute('title', 'Connected');
});

async function compose(page: Page) {
  await page.getByRole('button', { name: 'New checklist', exact: true }).tap();
  const creationEditor = page.getByRole('dialog', { name: 'Edit note', exact: true });
  await creationEditor.getByRole('textbox', { name: 'Note title', exact: true }).fill('Menu interactions');
  await creationEditor.getByRole('textbox', { name: 'Note text', exact: true }).click();
  await creationEditor.getByRole('textbox', { name: 'Note text', exact: true }).fill('Body to edit');
  await creationEditor.getByRole('textbox', { name: 'New list item', exact: true }).fill('Task to edit');
  return creationEditor;
}

async function note(page: Page) {
  const creationEditor = await compose(page);
  await creationEditor.getByRole('button', { name: 'Close', exact: true }).tap();
  const card = page.getByRole('article', { name: 'Open note: Menu interactions', exact: true });
  await expect(card).toBeVisible();
  return card;
}

async function dismissByInteraction(trigger: Locator, popup: Locator, field: Locator, exposedLeftEdge = false) {
  await trigger.tap();
  await expect(popup).toBeVisible();
  // Editor menus cover the middle of the note; other popups leave the field exposed.
  const bounds = (await field.boundingBox())!;
  await field.tap({ position: { x: exposedLeftEdge ? 8 : bounds.width / 2, y: bounds.height / 2 } });
  await expect(popup).toHaveCount(0);
  await expect(field).toBeFocused();
  // Keyboard focus movement has the same effect, without a pointer event.
  await trigger.tap();
  await expect(popup).toBeVisible();
  await field.focus();
  await expect(popup).toHaveCount(0);
  await expect(field).toBeFocused();
}

test('note menus dismiss before editing, toggle closed, and Escape keeps the note open', async ({ page }) => {
  await (await note(page)).tap();
  const editor = page.getByRole('dialog', { name: 'Edit note', exact: true });
  const menus = [
    { trigger: editor.getByRole('button', { name: 'More note actions', exact: true }), popup: editor.locator('.editor-menu') },
    { trigger: editor.getByRole('button', { name: 'Background color', exact: true }), popup: editor.getByRole('group', { name: 'Note background color', exact: true }) },
    { trigger: editor.getByRole('button', { name: 'Edit labels', exact: true }), popup: editor.getByRole('group', { name: 'Edit labels', exact: true }) },
  ];
  for (const { trigger, popup } of menus) {
    const title = editor.getByRole('textbox', { name: 'Note title', exact: true });
    await dismissByInteraction(trigger, popup, title, true);
    await trigger.tap();
    await expect(popup).toBeVisible();
    await trigger.tap();
    await expect(popup).toHaveCount(0);
    await trigger.tap();
    await page.keyboard.press('Escape');
    await expect(popup).toHaveCount(0);
    await expect(editor).toBeVisible();
    await expect(trigger).toBeFocused();
  }
  const kebab = menus[0];
  for (const name of ['Note text', 'List item text']) {
    await kebab.trigger.tap();
    const field = editor.getByRole('textbox', { name, exact: true });
    await field.tap({ position: { x: 8, y: 8 } });
    await expect(kebab.popup).toHaveCount(0);
    await expect(editor.locator('textarea:focus')).toHaveAttribute('aria-label', name);
    await page.keyboard.insertText(' changed');
    await expect(editor.getByRole('textbox', { name, exact: true })).toHaveValue(/ changed/);
  }
  await kebab.trigger.tap();
  // Clicking non-focusable space is also a dismissal, regardless of focus.
  await editor.locator('.editor-date').tap({ position: { x: 3, y: 3 } });
  await expect(kebab.popup).toHaveCount(0);
  await expect(editor).toBeVisible();
});

test('settings, tile palettes, and selection export dismiss when interaction leaves them', async ({ page }) => {
  await dismissByInteraction(page.getByRole('button', { name: 'Settings', exact: true }), page.locator('.settings-menu'), page.getByRole('searchbox', { name: 'Search notes', exact: true }));
  const card = await note(page);
  // Keyboard focus exposes tile controls without entering selection mode.
  await card.focus();
  await card.getByRole('button', { name: 'Background color', exact: true }).tap();
  await expect(card.getByRole('group', { name: 'Note background color', exact: true })).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search notes', exact: true }).tap();
  await expect(card.getByRole('group')).toHaveCount(0);
  await card.focus();
  await page.keyboard.press('Tab');
  await expect(card.getByRole('button', { name: 'Select note', exact: true })).toBeFocused();
  await page.keyboard.press('Space');
  const exportButton = page.getByRole('button', { name: 'Export notes', exact: true });
  const exportMenu = page.getByRole('menu', { name: 'Export format', exact: true });
  await exportButton.tap();
  await expect(exportMenu).toBeVisible();
  await page.locator('.selection-count').tap();
  await expect(exportMenu).toHaveCount(0);
  await exportButton.tap();
  await page.getByRole('button', { name: 'Clear selection', exact: true }).focus();
  await expect(exportMenu).toHaveCount(0);
  await expect(page.locator('.selection-count')).toHaveText('1 selected');
});

test('portaled label colors keep internal interactions and dismiss on outside focus or taps', async ({ page }) => {
  const creationEditor = await compose(page);
  await creationEditor.getByRole('button', { name: 'Edit labels', exact: true }).tap();
  const labels = creationEditor.getByRole('group', { name: 'Edit labels', exact: true });
  await labels.getByRole('textbox', { name: 'Find or create label', exact: true }).fill('Travel');
  await expect(labels).toBeVisible();
  await labels.getByRole('button', { name: 'Create label “Travel”', exact: true }).tap();
  await labels.getByRole('button', { name: 'Done', exact: true }).tap();
  await creationEditor.getByRole('button', { name: 'Close', exact: true }).tap();
  await page.getByRole('button', { name: 'Open navigation', exact: true }).tap();
  await page.getByRole('button', { name: 'Labels', exact: true }).tap();
  const trigger = page.getByRole('button', { name: 'Color for Travel', exact: true });
  const colors = page.getByRole('group', { name: 'Label color for Travel', exact: true });
  const outside = page.getByRole('button', { name: 'Labels', exact: true });
  await trigger.tap();
  await colors.getByRole('button', { name: 'Mint', exact: true }).focus();
  await expect(colors).toBeVisible();
  await outside.focus();
  await expect(colors).toHaveCount(0);
  await trigger.tap();
  await page.locator('.sidebar').tap({ position: { x: 20, y: 460 } });
  await expect(colors).toHaveCount(0);
  await trigger.tap();
  await trigger.tap();
  await expect(colors).toHaveCount(0);
  await trigger.tap();
  await page.keyboard.press('Escape');
  await expect(colors).toHaveCount(0);
  await expect(trigger).toBeFocused();
});
