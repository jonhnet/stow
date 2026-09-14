import { test, expect, type Locator, type Page } from '@playwright/test';
import type { HistoryExport } from '../../src/core/server-history-types';

const ORIGIN = 'http://localhost:4174';
const card = (page: Page, title: string) => page.getByRole('article', { name: `Open note: ${title}`, exact: true });
const editor = (page: Page) => page.getByRole('dialog', { name: 'Edit note', exact: true });
const chips = (scope: Locator) => scope.getByRole('list', { name: 'Note labels', exact: true }).getByRole('listitem');
const chip = (scope: Locator, name: string) => chips(scope).filter({ hasText: new RegExp(`^${name}$`) });
const labelRow = (page: Page, name: string) => page.locator('.label-nav-row').filter({ has: page.getByRole('button', { name: `Show label ${name}`, exact: true }) });
const chipAppearance = (locator: Locator) => locator.evaluate(element => {
  const style = getComputedStyle(element);
  return { background: style.backgroundColor, padding: style.padding, radius: style.borderRadius, fontSize: style.fontSize };
});

async function ready(page: Page) {
  await page.goto(ORIGIN);
  await expect(page.locator('.sync-state')).toHaveAttribute('title', 'Connected');
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
}

async function labels(scope: Locator) {
  await scope.getByRole('button', { name: 'Edit labels', exact: true }).click();
  return scope.getByRole('group', { name: 'Edit labels', exact: true });
}

async function labelColors(page: Page, name: string) {
  const row = labelRow(page, name);
  await row.hover();
  await row.getByRole('button', { name: `Color for ${name}`, exact: true }).click();
  return page.getByRole('group', { name: `Label color for ${name}`, exact: true });
}

async function createLabel(picker: Locator, name: string, input = name) {
  await picker.getByRole('textbox', { name: 'Find or create label', exact: true }).fill(input);
  await picker.getByRole('button', { name: `Create label “${name}”`, exact: true }).click();
  await expect(picker.getByRole('checkbox', { name, exact: true })).toBeChecked();
}

async function createNote(page: Page, title: string, body = '', label?: string) {
  await page.getByRole('button', { name: 'Take a note…', exact: true }).click();
  const creationEditor = page.getByRole('dialog', { name: 'Edit note', exact: true });
  await creationEditor.getByRole('textbox', { name: 'Note title', exact: true }).fill(title);
  if (body) {
    const field = creationEditor.getByRole('textbox', { name: 'Note text', exact: true });
    await field.focus();
    await field.fill(body);
  }
  if (label) {
    const picker = await labels(creationEditor);
    await picker.getByRole('textbox', { name: 'Find or create label', exact: true }).fill(label);
    const existing = picker.getByRole('checkbox', { name: label, exact: true });
    if (await existing.count()) await existing.check();
    else await createLabel(picker, label);
    await picker.getByRole('button', { name: 'Done', exact: true }).click();
  }
  await creationEditor.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(card(page, title)).toBeVisible();
}

test.beforeEach(async ({ page, context }, testInfo) => {
  await context.addCookies([{ name: 'stow_test_user', value: `labels-${testInfo.testId}@example.test`, url: ORIGIN }]);
  await ready(page);
});

test('labels are explicit metadata: create, attach, uncheck, remove, and search without parsing hashtags', async ({ page }) => {
  await page.getByRole('button', { name: 'Take a note…', exact: true }).click();
  const creationEditor = page.getByRole('dialog', { name: 'Edit note', exact: true });
  const emptyPicker = await labels(creationEditor);
  await emptyPicker.getByRole('button', { name: 'Done', exact: true }).click();
  await creationEditor.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('article')).toHaveCount(0);

  await page.getByRole('button', { name: 'Take a note…', exact: true }).click();
  await creationEditor.getByRole('textbox', { name: 'Note title', exact: true }).fill('Apartment details');
  const body = creationEditor.getByRole('textbox', { name: 'Note text', exact: true });
  await body.focus();
  await body.fill('Apartment #C3 belongs in ordinary prose.');
  const picker = await labels(creationEditor);
  await expect(picker.getByRole('checkbox')).toHaveCount(0);
  await createLabel(picker, 'Errands', '  Errands  ');
  await createLabel(picker, 'Home');
  await picker.getByRole('textbox', { name: 'Find or create label', exact: true }).fill('');
  await picker.getByRole('checkbox', { name: 'Errands', exact: true }).uncheck();
  await picker.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(chips(creationEditor)).toHaveText(['Home']);
  await creationEditor.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(chips(card(page, 'Apartment details'))).toHaveText(['Home']);
  await expect(card(page, 'Apartment details')).toContainText('Apartment #C3 belongs in ordinary prose.');

  await page.getByRole('searchbox', { name: 'Search notes' }).fill('Home');
  await expect(card(page, 'Apartment details')).toBeVisible();
  await page.getByRole('button', { name: 'Clear search' }).click();
  await card(page, 'Apartment details').getByRole('heading').click();
  await editor(page).getByRole('button', { name: 'Remove label Home', exact: true }).click();
  await expect(chips(editor(page))).toHaveCount(0);
  await editor(page).getByRole('button', { name: 'Close', exact: true }).click();
  await page.reload();
  await expect(chips(card(page, 'Apartment details'))).toHaveCount(0);
  await expect(card(page, 'Apartment details')).toContainText('Apartment #C3');
});

test('a label color is shared across notes and survives reload while note backgrounds and accounts stay independent', async ({ page, context }) => {
  await createNote(page, 'Colored travel note', 'Tickets', 'Travel');
  await card(page, 'Colored travel note').getByRole('heading').click();
  await editor(page).getByRole('button', { name: 'Background color', exact: true }).click();
  await editor(page).getByRole('group', { name: 'Note background color', exact: true }).getByRole('button', { name: 'Coral', exact: true }).click();
  await editor(page).getByRole('button', { name: 'Close', exact: true }).click();
  await createNote(page, 'Plain travel note', 'Hotel', 'Travel');
  await page.getByRole('button', { name: 'Labels', exact: true }).click();
  const navigation = page.getByRole('button', { name: 'Show label Travel', exact: true });
  await navigation.click();
  const colors = await labelColors(page, 'Travel');
  await colors.getByRole('button', { name: 'Mint', exact: true }).click();
  await expect(colors).toHaveCount(0);
  await expect(labelRow(page, 'Travel').getByRole('button', { name: 'Color for Travel', exact: true })).toBeFocused();
  await expect(navigation.locator('.label-chip')).toHaveCSS('background-color', 'rgb(226, 246, 211)');
  await expect(chip(card(page, 'Colored travel note'), 'Travel')).toHaveCSS('background-color', 'rgb(226, 246, 211)');
  await card(page, 'Plain travel note').getByRole('heading').click();
  const picker = await labels(editor(page));
  await expect(picker.getByRole('button', { name: /^(Color for|Delete label) / })).toHaveCount(0);
  const pickerChip = picker.locator('.label-option .label-chip').filter({ hasText: /^Travel$/ });
  await expect(pickerChip).toBeVisible();
  await expect(navigation).toHaveAttribute('aria-current', 'page');
  await expect(chip(editor(page), 'Travel')).toHaveCSS('background-color', 'rgb(226, 246, 211)');
  const appearance = await chipAppearance(chip(editor(page), 'Travel'));
  for (const matching of [pickerChip, navigation.locator('.label-chip'), chip(card(page, 'Colored travel note'), 'Travel')]) {
    await expect.poll(() => chipAppearance(matching)).toEqual(appearance);
  }
  await page.screenshot({ path: test.info().outputPath('label-picker-chips.png'), fullPage: true });
  await picker.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(chip(editor(page), 'Travel')).toHaveCSS('background-color', 'rgb(226, 246, 211)');
  await expect(editor(page)).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await editor(page).getByRole('button', { name: 'Close', exact: true }).click();
  await page.reload();
  for (const title of ['Colored travel note', 'Plain travel note']) {
    await expect(chip(card(page, title), 'Travel')).toHaveCSS('background-color', 'rgb(226, 246, 211)');
  }
  await expect(card(page, 'Colored travel note')).toHaveCSS('background-color', 'rgb(250, 175, 168)');
  await expect(card(page, 'Plain travel note')).toHaveCSS('background-color', 'rgb(255, 255, 255)');

  const originalCookies = await context.cookies(ORIGIN);
  await context.addCookies([{ name: 'stow_test_user', value: 'labels-color-isolation@example.test', url: ORIGIN }]);
  await ready(page);
  await expect(page.getByRole('article')).toHaveCount(0);
  await page.getByRole('button', { name: 'Labels', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Labels', exact: true }).getByRole('button')).toHaveCount(0);
  await createNote(page, 'Other account travel note', 'A separate vault may use the same label name.', 'Travel');
  const otherColors = await labelColors(page, 'Travel');
  await expect(otherColors.getByRole('button', { name: 'Default', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await otherColors.getByRole('button', { name: 'Coral', exact: true }).click();
  await expect(chip(card(page, 'Other account travel note'), 'Travel')).toHaveCSS('background-color', 'rgb(250, 175, 168)');
  await context.addCookies(originalCookies);
  await ready(page);
  await expect(card(page, 'Other account travel note')).toHaveCount(0);
  await expect(chip(card(page, 'Colored travel note'), 'Travel')).toHaveCSS('background-color', 'rgb(226, 246, 211)');
  await expect(chip(card(page, 'Plain travel note'), 'Travel')).toHaveCSS('background-color', 'rgb(226, 246, 211)');
});

test('removing a label is undoable and the saved note history shows timestamped label changes', async ({ page }) => {
  const session = await (await page.request.get(`${ORIGIN}/api/session`)).json();
  const savedVersions = async () => {
    const response = await page.request.get(`${ORIGIN}/api/history/export`, { headers: { 'X-Stow-Vault': session.vaultId } });
    expect(response.ok()).toBe(true);
    return (await response.json() as HistoryExport).versions;
  };
  await createNote(page, 'Label history', 'A note with a remembered label.');
  // History saves server-observed states. Establish each baseline before the next
  // mutation so this test exercises the label diff rather than transport timing.
  await expect.poll(async () => (await savedVersions()).some(version => Object.values(version.state.sources).some(source =>
    source.title === 'Label history' && source.body === 'A note with a remembered label.' && !source.labels?.length))).toBe(true);
  await card(page, 'Label history').getByRole('heading').click();
  const picker = await labels(editor(page));
  await createLabel(picker, 'Memorable');
  await picker.getByRole('button', { name: 'Done', exact: true }).click();
  await expect.poll(async () => (await savedVersions()).some(version => version.label === 'Label: added “Memorable”')).toBe(true);
  await editor(page).getByRole('button', { name: 'Remove label Memorable', exact: true }).click();
  await expect(chips(editor(page))).toHaveCount(0);
  await expect.poll(async () => (await savedVersions()).some(version => version.label === 'Label: removed “Memorable”')).toBe(true);
  await editor(page).getByRole('button', { name: 'Close', exact: true }).click();
  await page.locator('header').getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(chips(card(page, 'Label history'))).toHaveText(['Memorable']);
  await page.reload();
  await card(page, 'Label history').getByRole('heading').click();
  await editor(page).getByRole('button', { name: 'More note actions', exact: true }).click();
  await page.getByRole('button', { name: 'Version history', exact: true }).click();
  const history = page.getByRole('dialog', { name: 'Version history', exact: true });
  const added = history.locator('.revision-card').filter({ has: page.getByRole('heading', { name: 'Label: added “Memorable”', exact: true }) });
  const removed = history.locator('.revision-card').filter({ has: page.getByRole('heading', { name: 'Label: removed “Memorable”', exact: true }) });
  await expect(added).toHaveCount(1);
  await expect(removed).toHaveCount(1);
  await expect(removed.locator('time')).toHaveAttribute('datetime', /^\d{4}-\d\d-\d\dT/);
  await added.getByRole('button', { name: 'Preview version', exact: true }).click();
  await expect(chips(added.getByLabel('Saved version preview', { exact: true }))).toHaveText(['Memorable']);
  await removed.getByRole('button', { name: 'Preview version', exact: true }).click();
  await expect(chips(removed.getByLabel('Saved version preview', { exact: true }))).toHaveCount(0);
});

test('two offline devices keep their independent first label additions after reconnecting', async ({ page, browser, context }) => {
  await createNote(page, 'Offline label convergence', 'Labels from both devices should survive.');
  const second = await browser.newContext();
  try {
    await second.addCookies(await context.cookies(ORIGIN));
    const remote = await second.newPage();
    await ready(remote);
    await expect(card(remote, 'Offline label convergence')).toBeVisible();
    await context.setOffline(true);
    await second.setOffline(true);
    for (const [device, name] of [[page, 'Desktop'], [remote, 'Phone']] as const) {
      await card(device, 'Offline label convergence').getByRole('heading').click();
      const picker = await labels(editor(device));
      await createLabel(picker, name);
      await picker.getByRole('button', { name: 'Done', exact: true }).click();
      await editor(device).getByRole('button', { name: 'Close', exact: true }).click();
      await device.reload();
      await expect(chips(card(device, 'Offline label convergence'))).toHaveText([name]);
    }
    await context.setOffline(false);
    await second.setOffline(false);
    for (const device of [page, remote]) {
      await expect(chips(card(device, 'Offline label convergence'))).toHaveText(['Desktop', 'Phone']);
    }
  } finally { await second.close(); }
});

test.describe('on a touch device', () => {
test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

test('label popups fit the viewport, note editing stays local, and sidebar actions work without hover', async ({ page }) => {
  const name = 'A long label for a trip with many destinations';
  await createNote(page, 'Phone labels', 'A compact editor.', name);
  await card(page, 'Phone labels').getByRole('heading').click();
  const picker = await labels(editor(page));
  const fitsViewport = async (popup: Locator) => {
    await expect(popup).toBeVisible();
    const bounds = await popup.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(391);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(845);
  };
  await fitsViewport(picker);
  await expect(picker.getByRole('button', { name: /^(Color for|Delete label) / })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(picker).toHaveCount(0);
  await expect(editor(page)).toBeVisible();
  await expect(editor(page).getByRole('button', { name: 'Edit labels', exact: true })).toBeFocused();
  await expect(chips(editor(page))).toHaveText([name]);
  const reopened = await labels(editor(page));
  await reopened.getByRole('button', { name: 'Done', exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(reopened).toHaveCount(0);
  await expect(editor(page).getByRole('button', { name: 'Background color', exact: true })).toBeFocused();
  await expect(editor(page)).toBeVisible();
  await editor(page).getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  await page.getByRole('button', { name: 'Labels', exact: true }).click();
  expect(await page.evaluate(() => matchMedia('(hover: none)').matches)).toBe(true);
  const row = labelRow(page, name);
  await expect(row.locator('.label-row-actions')).toHaveCSS('opacity', '1');
  await expect(row.getByRole('button', { name: `Delete label ${name}`, exact: true })).toBeVisible();
  const colorButton = row.getByRole('button', { name: `Color for ${name}`, exact: true });
  await colorButton.tap();
  const colors = page.getByRole('group', { name: `Label color for ${name}`, exact: true });
  await fitsViewport(colors);
  await page.keyboard.press('Escape');
  await expect(colors).toHaveCount(0);
  await expect(colorButton).toBeFocused();
  await colorButton.tap();
  await colors.getByRole('button', { name: 'Mint', exact: true }).tap();
  await expect(row.locator('.label-chip')).toHaveCSS('background-color', 'rgb(226, 246, 211)');
  await expect(page.getByRole('button', { name: 'Close navigation', exact: true })).toBeVisible();
});
});

test('the collapsed label sidebar filters exact metadata including archive and orders labels by latest note edit', async ({ page }) => {
  await createNote(page, 'Older labeled note', 'Original details', 'Older');
  await createNote(page, 'Newer archived note', 'An archived destination', 'Newer');
  await card(page, 'Newer archived note').getByRole('heading').click();
  await editor(page).getByRole('button', { name: 'Archive note', exact: true }).click();
  await createNote(page, 'Unlabeled Older Newer', 'Mentioning Older and Newer does not attach either label.');
  const toggle = page.getByRole('button', { name: 'Labels', exact: true });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  const group = page.getByRole('group', { name: 'Labels', exact: true });
  await expect(group.locator('.label-nav-item')).toHaveText(['Newer', 'Older']);
  await page.getByRole('button', { name: 'Take a note…', exact: true }).click();
  const creationEditor = page.getByRole('dialog', { name: 'Edit note', exact: true });
  const draftPicker = await labels(creationEditor);
  await expect(draftPicker.locator('.label-option .label-chip')).toHaveText(['Newer', 'Older']);
  await draftPicker.getByRole('button', { name: 'Done', exact: true }).click();
  await creationEditor.getByRole('button', { name: 'Close', exact: true }).click();
  await group.getByRole('button', { name: 'Show label Newer', exact: true }).click();
  await expect(card(page, 'Newer archived note')).toBeVisible();
  await expect(card(page, 'Older labeled note')).toHaveCount(0);
  await expect(card(page, 'Unlabeled Older Newer')).toHaveCount(0);
  await group.getByRole('button', { name: 'Show label Older', exact: true }).click();
  await expect(card(page, 'Older labeled note')).toBeVisible();
  await expect(card(page, 'Newer archived note')).toHaveCount(0);
  await card(page, 'Older labeled note').getByRole('heading').click();
  const originalPicker = await labels(editor(page));
  await expect(originalPicker.locator('.label-option .label-chip')).toHaveText(['Newer', 'Older']);
  await originalPicker.getByRole('button', { name: 'Done', exact: true }).click();
  const body = editor(page).getByRole('textbox', { name: 'Note text', exact: true });
  await body.focus();
  await body.fill('The older label now has the most recently edited note.');
  const reorderedPicker = await labels(editor(page));
  await expect(reorderedPicker.locator('.label-option .label-chip')).toHaveText(['Older', 'Newer']);
  await reorderedPicker.getByRole('textbox', { name: 'Find or create label', exact: true }).fill('ER');
  await expect(reorderedPicker.locator('.label-option .label-chip')).toHaveText(['Older', 'Newer']);
  await reorderedPicker.getByRole('button', { name: 'Done', exact: true }).click();
  await editor(page).getByRole('button', { name: 'Close', exact: true }).click();
  await expect(group.locator('.label-nav-item')).toHaveText(['Older', 'Newer']);
  await page.getByRole('searchbox', { name: 'Search notes' }).fill('destination');
  await expect(page.getByRole('article')).toHaveCount(0);
  await page.getByRole('button', { name: 'Notes', exact: true }).click();
  await page.getByRole('button', { name: 'Take a note…', exact: true }).click();
  const reorderedDraftPicker = await labels(creationEditor);
  await expect(reorderedDraftPicker.locator('.label-option .label-chip')).toHaveText(['Older', 'Newer']);
  await reorderedDraftPicker.getByRole('button', { name: 'Done', exact: true }).click();
  await creationEditor.getByRole('button', { name: 'Close', exact: true }).click();
});

test('global label deletion removes it from live, archived, and trashed notes and one undo restores its color and note assignments', async ({ page }) => {
  await createNote(page, 'Live note to retain', 'Keep this live text.', 'Retire');
  await card(page, 'Live note to retain').getByRole('heading').click();
  const picker = await labels(editor(page));
  await createLabel(picker, 'Kept');
  await picker.getByRole('button', { name: 'Done', exact: true }).click();
  await editor(page).getByRole('button', { name: 'Background color', exact: true }).click();
  await editor(page).getByRole('group', { name: 'Note background color', exact: true }).getByRole('button', { name: 'Sand', exact: true }).click();
  await editor(page).getByRole('button', { name: 'Close', exact: true }).click();
  await createNote(page, 'Archived note to retain', 'Keep this archived text.', 'Retire');
  await card(page, 'Archived note to retain').getByRole('heading').click();
  await editor(page).getByRole('button', { name: 'Archive note', exact: true }).click();
  await createNote(page, 'Trashed note to retain', 'Keep this trashed text.', 'Retire');
  await card(page, 'Trashed note to retain').getByRole('heading').click();
  await editor(page).getByRole('button', { name: 'More note actions', exact: true }).click();
  await editor(page).getByRole('button', { name: 'Move to trash', exact: true }).click();
  await page.getByRole('button', { name: 'Labels', exact: true }).click();
  const colors = await labelColors(page, 'Retire');
  await colors.getByRole('button', { name: 'Mint', exact: true }).click();
  await page.getByRole('button', { name: 'Show label Retire', exact: true }).click();
  await expect(card(page, 'Archived note to retain')).toBeVisible();
  await labelRow(page, 'Retire').hover();
  await labelRow(page, 'Retire').getByRole('button', { name: 'Delete label Retire', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Notes', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('button', { name: 'Show label Retire', exact: true })).toHaveCount(0);
  await expect(chips(card(page, 'Live note to retain'))).toHaveText(['Kept']);
  await expect(card(page, 'Live note to retain')).toContainText('Keep this live text.');
  await expect(card(page, 'Live note to retain')).toHaveCSS('background-color', 'rgb(255, 248, 184)');
  const toast = page.locator('.toast');
  await expect(toast).toHaveCount(0);
  await page.locator('header').getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(toast).toContainText(/^Undid: /);
  await expect(toast).toContainText('Retire');
  await expect(toast.getByRole('button', { name: 'Undo', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Show label Retire', exact: true }).click();
  for (const title of ['Live note to retain', 'Archived note to retain']) {
    await expect(chip(card(page, title), 'Retire')).toHaveCSS('background-color', 'rgb(226, 246, 211)');
  }
  await page.getByRole('button', { name: 'Trash', exact: true }).click();
  await expect(chip(card(page, 'Trashed note to retain'), 'Retire')).toHaveCSS('background-color', 'rgb(226, 246, 211)');
  await expect(card(page, 'Trashed note to retain')).toContainText('Keep this trashed text.');

  // Repeat the same global operation, then prove deletion persists across a fresh load.
  await labelRow(page, 'Retire').hover();
  await labelRow(page, 'Retire').getByRole('button', { name: 'Delete label Retire', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: 'Labels', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Show label Retire', exact: true })).toHaveCount(0);
  await expect(chips(card(page, 'Live note to retain'))).toHaveText(['Kept']);
  await expect(card(page, 'Live note to retain')).toHaveCSS('background-color', 'rgb(255, 248, 184)');
  await card(page, 'Live note to retain').getByRole('heading').click();
  const afterDelete = await labels(editor(page));
  await expect(afterDelete.getByRole('checkbox', { name: 'Retire', exact: true })).toHaveCount(0);
  await expect(afterDelete.getByRole('checkbox', { name: 'Kept', exact: true })).toBeChecked();
  await afterDelete.getByRole('button', { name: 'Done', exact: true }).click();
  await editor(page).getByRole('button', { name: 'Close', exact: true }).click();
  for (const [view, title, body] of [
    ['Archive', 'Archived note to retain', 'Keep this archived text.'],
    ['Trash', 'Trashed note to retain', 'Keep this trashed text.'],
  ]) {
    await page.getByRole('button', { name: view, exact: true }).click();
    await expect(card(page, title)).toContainText(body);
    await expect(chips(card(page, title))).toHaveCount(0);
  }
});

test('sidebar label actions appear only on the hovered or focused row and are keyboard accessible', async ({ page }) => {
  await createNote(page, 'Home label controls', 'Home details', 'Home');
  await createNote(page, 'Work label controls', 'Work details', 'Work');
  await page.getByRole('button', { name: 'Labels', exact: true }).click();
  const home = labelRow(page, 'Home'), work = labelRow(page, 'Work');
  const actions = (row: Locator) => row.locator('.label-row-actions');
  const away = page.getByRole('button', { name: 'Take a note…', exact: true });
  await away.hover();
  await page.getByRole('searchbox', { name: 'Search notes' }).focus();
  await expect(actions(home)).toHaveCSS('opacity', '0');
  await expect(actions(work)).toHaveCSS('opacity', '0');
  await expect(actions(home)).toHaveCSS('pointer-events', 'none');
  await home.hover();
  await expect(actions(home)).toHaveCSS('opacity', '1');
  await expect(actions(home)).toHaveCSS('pointer-events', 'auto');
  await expect(actions(work)).toHaveCSS('opacity', '0');
  await away.hover();
  await page.getByRole('button', { name: 'Labels', exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(work.getByRole('button', { name: 'Show label Work', exact: true })).toBeFocused();
  await expect(actions(work)).toHaveCSS('opacity', '1');
  await expect(actions(home)).toHaveCSS('opacity', '0');
  await page.keyboard.press('Tab');
  const colorButton = work.getByRole('button', { name: 'Color for Work', exact: true });
  await expect(colorButton).toBeFocused();
  await page.keyboard.press('Enter');
  const colors = page.getByRole('group', { name: 'Label color for Work', exact: true });
  await expect(colors).toBeVisible();
  await expect(actions(work)).toHaveCSS('opacity', '1');
  await colors.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(colors).toHaveCount(0);
  await expect(colorButton).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(work.getByRole('button', { name: 'Delete label Work', exact: true })).toBeFocused();
  await expect(page.getByRole('article')).toHaveCount(2);
});
