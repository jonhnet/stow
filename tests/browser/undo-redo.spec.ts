import { test, expect, type Locator, type Page } from '@playwright/test';

const ORIGIN = 'http://localhost:4174';
const card = (page: Page, title: string) => page.getByRole('article', { name: `Open note: ${title}`, exact: true });
const editor = (page: Page) => page.getByRole('dialog', { name: 'Edit note', exact: true });
const toolbar = (page: Page, name: 'Undo' | 'Redo') => page.locator('header').getByRole('button', { name, exact: true });

async function createNote(page: Page, title: string, body: string, label?: string) {
  await page.getByRole('button', { name: 'Take a note…', exact: true }).click();
  const creationEditor = page.getByRole('dialog', { name: 'Edit note', exact: true });
  await creationEditor.getByRole('textbox', { name: 'Note title', exact: true }).fill(title);
  const text = creationEditor.getByRole('textbox', { name: 'Note text', exact: true });
  await text.focus(); await text.fill(body);
  if (label) {
    await creationEditor.getByRole('button', { name: 'Edit labels', exact: true }).click();
    const picker = creationEditor.getByRole('group', { name: 'Edit labels', exact: true });
    await picker.getByRole('textbox', { name: 'Find or create label', exact: true }).fill(label);
    const existing = picker.getByRole('checkbox', { name: label, exact: true });
    if (await existing.count()) await existing.check();
    else await picker.getByRole('button', { name: `Create label “${label}”`, exact: true }).click();
    await picker.getByRole('button', { name: 'Done', exact: true }).click();
  }
  await creationEditor.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(card(page, title)).toBeVisible();
  await expect(page.locator('.toast')).toHaveCount(0);
}

async function expectActionToast(page: Page, prefix: 'Undid' | 'Redid', snippet: string) {
  const toast = page.locator('.toast');
  await expect(toast).toBeVisible();
  await expect(toast).toContainText(new RegExp(`^${prefix}: `));
  await expect(toast).toContainText(snippet);
  await expect(toast.getByRole('button')).toHaveCount(1);
  await expect(toast.getByRole('button', { name: 'Dismiss notification', exact: true })).toBeVisible();
  await expect(toast.getByRole('button', { name: 'Undo', exact: true })).toHaveCount(0);
  return (await toast.locator(':scope > span').innerText()).slice(prefix.length + 2);
}

async function openHistory(page: Page, title: string) {
  await card(page, title).getByRole('heading', { name: title, exact: true }).click();
  await editor(page).getByRole('button', { name: 'More note actions', exact: true }).click();
  await editor(page).getByRole('button', { name: 'Version history', exact: true }).click();
  return page.getByRole('dialog', { name: 'Version history', exact: true });
}

test.beforeEach(async ({ page, context }, testInfo) => {
  await context.addCookies([{ name: 'stow_test_user', value: `undo-redo-${testInfo.testId}-${testInfo.retry}@example.test`, url: ORIGIN }]);
  await page.goto(ORIGIN);
  await expect(page.locator('.sync-state')).toHaveAttribute('title', 'Connected');
});

test('grouped typing uses the same descriptive toast for keyboard undo, both redo shortcuts, and toolbar actions', async ({ page }) => {
  const title = 'Typing group', before = 'Original paragraph.', addition = ' Added together';
  await createNote(page, title, before);
  await expect(toolbar(page, 'Undo')).toHaveAttribute('title', /Ctrl\+Z/);
  await expect(toolbar(page, 'Redo')).toHaveAttribute('title', /Ctrl\+Shift\+Z/);
  await expect(toolbar(page, 'Redo')).toHaveAttribute('title', /Ctrl\+Y/);
  expect(await toolbar(page, 'Undo').evaluate(button => button.nextElementSibling?.getAttribute('aria-label'))).toBe('Redo');
  await card(page, title).getByRole('heading', { name: title, exact: true }).click();
  const body = editor(page).getByRole('textbox', { name: 'Note text', exact: true });
  await body.focus();
  await body.press('Control+End');
  await body.pressSequentially(addition, { delay: 8 });
  await expect(body).toHaveValue(before + addition);
  await expect(page.locator('.toast')).toHaveCount(0);

  await body.press('Control+z');
  await expect(body).toHaveValue(before);
  const description = await expectActionToast(page, 'Undid', 'Added together');
  await expect(editor(page).getByRole('textbox', { name: 'Note title', exact: true })).toHaveValue(title);
  await body.press('Control+Shift+z');
  await expect(body).toHaveValue(before + addition);
  expect(await expectActionToast(page, 'Redid', 'Added together')).toBe(description);

  await body.press('Control+z');
  await expect(body).toHaveValue(before);
  await body.press('Control+y');
  await expect(body).toHaveValue(before + addition);
  expect(await expectActionToast(page, 'Redid', 'Added together')).toBe(description);
  await editor(page).getByRole('button', { name: 'Close', exact: true }).click();
  await toolbar(page, 'Undo').click();
  expect(await expectActionToast(page, 'Undid', 'Added together')).toBe(description);
  await expect(card(page, title).locator('.card-body')).toHaveText(before);
  await toolbar(page, 'Redo').click();
  expect(await expectActionToast(page, 'Redid', 'Added together')).toBe(description);
  await expect(card(page, title).locator('.card-body')).toHaveText(before + addition);
  await page.locator('.toast').getByRole('button', { name: 'Dismiss notification', exact: true }).click();
  await expect(page.locator('.toast')).toHaveCount(0);
});

test('Undo and Redo stay adjacent and usable on a narrow screen without success notifications', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await createNote(page, 'Phone action', 'A compact toolbar.');
  const undo = toolbar(page, 'Undo'), redo = toolbar(page, 'Redo');
  await expect(undo).toBeVisible(); await expect(redo).toBeVisible();
  expect(await undo.evaluate(button => button.nextElementSibling?.getAttribute('aria-label'))).toBe('Redo');
  const a = (await undo.boundingBox())!, b = (await redo.boundingBox())!;
  expect(a.x).toBeGreaterThanOrEqual(0);
  expect(b.x + b.width).toBeLessThanOrEqual(390);
  expect(b.x).toBeGreaterThanOrEqual(a.x + a.width - 1);
  expect(Math.abs(a.y - b.y)).toBeLessThanOrEqual(2);

  await card(page, 'Phone action').getByRole('button', { name: 'Pin note', exact: true }).click();
  await expect(page.locator('.toast')).toHaveCount(0);
  await undo.click();
  await expectActionToast(page, 'Undid', 'pinned');
  await expect(card(page, 'Phone action').getByRole('button', { name: 'Pin note', exact: true })).toBeVisible();
  await redo.click();
  await expectActionToast(page, 'Redid', 'pinned');
  await expect(card(page, 'Phone action').getByRole('button', { name: 'Unpin note', exact: true })).toBeVisible();
  await page.locator('.toast').getByRole('button', { name: 'Dismiss notification', exact: true }).click();
  await card(page, 'Phone action').getByRole('button', { name: 'Archive note', exact: true }).click();
  await expect(card(page, 'Phone action')).toHaveCount(0);
  await expect(page.locator('.toast')).toHaveCount(0);
  await undo.click();
  await expectActionToast(page, 'Undid', 'archived');
  await expect(card(page, 'Phone action')).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('undo-redo-phone.png'), fullPage: true });
});

test('Mac toolbar tooltips advertise Command undo and redo', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' }));
  await page.reload();
  await expect(toolbar(page, 'Undo')).toHaveAttribute('title', /Cmd\+Z/);
  await expect(toolbar(page, 'Redo')).toHaveAttribute('title', /Cmd\+Shift\+Z/);
});

test('the narrow editor exposes descriptive Undo and Redo without closing the note', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  const title = 'Open phone note', before = 'Original sentence.', addition = ' Mobile addition';
  await createNote(page, title, before);
  await card(page, title).getByRole('heading', { name: title, exact: true }).click();
  const dialog = editor(page), body = dialog.getByRole('textbox', { name: 'Note text', exact: true });
  await body.focus(); await body.press('Control+End');
  await body.pressSequentially(addition, { delay: 8 });
  await dialog.getByRole('button', { name: 'More note actions', exact: true }).click();
  const undo = dialog.getByRole('button', { name: 'Undo last change', exact: true });
  await expect(undo).toHaveAttribute('title', /Ctrl\+Z/);
  await undo.click();
  await expect(dialog).toBeVisible(); await expect(body).toHaveText(before);
  const description = await expectActionToast(page, 'Undid', 'Mobile addition');

  await dialog.getByRole('button', { name: 'More note actions', exact: true }).click();
  const redo = dialog.getByRole('button', { name: 'Redo last change', exact: true });
  await expect(redo).toHaveAttribute('title', /Ctrl\+Shift\+Z/);
  await expect(redo).toHaveAttribute('title', /Ctrl\+Y/);
  await redo.click();
  await expect(dialog).toBeVisible(); await expect(body).toHaveText(before + addition);
  expect(await expectActionToast(page, 'Redid', 'Mobile addition')).toBe(description);
  await page.locator('.toast').getByRole('button', { name: 'Dismiss notification', exact: true }).click();
  await expect(dialog).toBeVisible();
});

test('history exposes title, body and item edits and global label colors as nonrestorable settings', async ({ page }) => {
  await createNote(page, 'Orchard title', 'Cobalt paragraph', 'Research');
  await createNote(page, 'Other labeled note', 'This body stays unchanged.', 'Research');
  await createNote(page, 'Unrelated settings note', 'No label color entry belongs here.');
  await card(page, 'Orchard title').getByRole('heading', { name: 'Orchard title', exact: true }).click();
  await editor(page).getByRole('textbox', { name: 'Note title', exact: true }).fill('Harbor title');
  const body = editor(page).getByRole('textbox', { name: 'Note text', exact: true });
  await body.focus(); await body.fill('Copper paragraph');
  await editor(page).getByRole('button', { name: 'Add checklist', exact: true }).click();
  await editor(page).getByRole('textbox', { name: 'New list item', exact: true }).fill('Mango task');
  const item = editor(page).getByRole('textbox', { name: 'List item text', exact: true });
  await item.focus(); await item.fill('Papaya task');
  await editor(page).getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.locator('.toast')).toHaveCount(0);

  await page.getByRole('button', { name: 'Labels', exact: true }).click();
  const row = page.locator('.label-nav-row').filter({ has: page.getByRole('button', { name: 'Show label Research', exact: true }) });
  await row.hover();
  await row.getByRole('button', { name: 'Color for Research', exact: true }).click();
  await page.getByRole('group', { name: 'Label color for Research', exact: true }).getByRole('button', { name: 'Mint', exact: true }).click();
  await expect(page.locator('.toast')).toHaveCount(0);
  // Saved history is best effort. Wait for this server boundary before tearing
  // down the page whose hint is queued after the durable current upload.
  await expect.poll(async () => {
    const session = await (await page.request.get(`${ORIGIN}/api/session`)).json();
    const response = await page.request.get(`${ORIGIN}/api/history/export`, { headers: { 'X-Stow-Vault': session.vaultId } });
    expect(response.ok()).toBe(true);
    return (await response.json()).versions.some((version: { kind?: string; labelChange?: { name: string } }) => version.kind === 'label' && version.labelChange?.name === 'Research');
  }).toBe(true);
  await page.reload();

  const settingsRows = (timeline: Locator) => timeline.locator('.revision-card').filter({ has: page.getByRole('heading', { name: /color.*Research|Research.*color/i }) });
  const timeline = await openHistory(page, 'Harbor title');
  for (const [from, to] of [['Orchard', 'Harbor'], ['Cobalt', 'Copper'], ['Mango', 'Papaya']]) {
    const change = timeline.locator('.revision-card').filter({ hasText: from }).filter({ hasText: to });
    await expect(change).toHaveCount(1);
    await expect(change.getByRole('heading')).toContainText(from);
    await expect(change.getByRole('heading')).toContainText(to);
  }
  const setting = settingsRows(timeline);
  await expect(setting).toHaveCount(1);
  await expect(setting).toContainText(/Mint/i);
  await expect(setting.getByRole('img', { name: 'Before: Research, Default', exact: true })).toBeVisible();
  await expect(setting.getByRole('img', { name: 'After: Research, Mint', exact: true })).toBeVisible();
  await expect(setting.locator('time')).toBeVisible();
  await expect(setting.getByRole('button', { name: 'Preview version', exact: true })).toHaveCount(0);
  await expect(setting.getByRole('button', { name: 'Restore copy', exact: true })).toHaveCount(0);
  await timeline.getByRole('button', { name: 'Back to note', exact: true }).click();
  await editor(page).getByRole('button', { name: 'Close', exact: true }).click();

  const other = await openHistory(page, 'Other labeled note');
  await expect(settingsRows(other)).toHaveCount(1);
  await other.getByRole('button', { name: 'Back to note', exact: true }).click();
  await editor(page).getByRole('button', { name: 'Close', exact: true }).click();
  const unrelated = await openHistory(page, 'Unrelated settings note');
  await expect(settingsRows(unrelated)).toHaveCount(0);
});
