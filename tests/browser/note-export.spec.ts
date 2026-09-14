import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const ORIGIN = 'http://localhost:4174';
const card = (page: Page, title: string) => page.getByRole('article', { name: `Open note: ${title}`, exact: true });
const editor = (page: Page) => page.getByRole('dialog', { name: 'Edit note', exact: true });

async function createNote(page: Page, title: string, body: string) {
  await page.getByRole('button', { name: 'Take a note…', exact: true }).click();
  const creationEditor = page.getByRole('dialog', { name: 'Edit note', exact: true });
  await creationEditor.getByRole('textbox', { name: 'Note title', exact: true }).fill(title);
  const field = creationEditor.getByRole('textbox', { name: 'Note text', exact: true });
  await field.focus(); await field.fill(body);
  await creationEditor.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(card(page, title)).toBeVisible();
}

async function clipboard(page: Page) {
  return page.evaluate(async () => {
    const values = await navigator.clipboard.read();
    return Promise.all(values.map(async item => Object.fromEntries(await Promise.all(item.types.map(async type => [type, await (await item.getType(type)).text()])))));
  });
}

test.beforeEach(async ({ page, context }, testInfo) => {
  await context.addCookies([{ name: 'stow_test_user', value: `export-${testInfo.testId}@example.test`, url: ORIGIN }]);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto(ORIGIN);
  await expect(page.locator('.sync-state')).toHaveAttribute('title', 'Connected');
});

test('selected copy publishes plain and rich text in visual order, supports Ctrl+C, and leaves native editor copying intact', async ({ page }) => {
  await createNote(page, 'First visual note', '**Bold** [destination](https://example.test/path)');
  await card(page, 'First visual note').getByRole('button', { name: 'Pin note', exact: true }).click();
  await createNote(page, 'Second visual note', 'Second selected content');
  await createNote(page, 'Not selected', 'SECRET UNSELECTED CONTENT');
  // Select in the opposite order to the pinned-first visual order.
  await card(page, 'Second visual note').getByRole('button', { name: 'Select note', exact: true }).click();
  await card(page, 'First visual note').getByRole('button', { name: 'Select note', exact: true }).click();
  await page.getByRole('button', { name: 'Copy selected notes', exact: true }).click();
  await expect(page.locator('.toast')).toContainText('Copied 2 notes to clipboard.');
  const values = await clipboard(page);
  expect(values).toHaveLength(1);
  expect(Object.keys(values[0]).sort()).toEqual(['text/html', 'text/plain']);
  const text = values[0]['text/plain'];
  expect(text).toContain('Bold destination (https://example.test/path)');
  expect(text.indexOf('First visual note')).toBeLessThan(text.indexOf('Second visual note'));
  expect(text).not.toContain('SECRET');
  expect(values[0]['text/html']).toContain('<strong>Bold</strong>');
  expect(values[0]['text/html']).toContain('href="https://example.test/path"');
  await expect(page.getByRole('button', { name: 'Deselect note', exact: true })).toHaveCount(2);

  await page.getByRole('button', { name: 'Clear selection', exact: true }).click();
  await card(page, 'First visual note').getByRole('button', { name: 'Select note', exact: true }).click();
  await page.keyboard.press('Control+c');
  await expect(page.locator('.toast')).toContainText('Copied note to clipboard.');
  expect((await clipboard(page))[0]['text/plain']).not.toContain('Second visual note');
  await page.getByRole('button', { name: 'Clear selection', exact: true }).click();
  await page.getByRole('button', { name: 'Dismiss notification', exact: true }).click();
  await card(page, 'First visual note').getByRole('heading', { name: 'First visual note', exact: true }).click();
  const field = editor(page).getByRole('textbox', { name: 'Note text', exact: true });
  await field.focus();
  await field.evaluate(element => (element as HTMLTextAreaElement).setSelectionRange(2, 6));
  await page.keyboard.press('Control+c');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('Bold');
  await expect(page.locator('.toast')).toHaveCount(0);
  await expect(field).toHaveValue('**Bold** [destination](https://example.test/path)');
});

test('Markdown, plain text and HTML downloads contain only selected notes and include collapsed completed items and nested children', async ({ page }) => {
  const body = '**Source formatting** [reference](https://example.test/reference)\n\n<script>alert(1)</script> [bad](javascript:alert(2))';
  await createNote(page, 'Export checklist', body);
  await card(page, 'Export checklist').getByRole('heading').click();
  const dialog = editor(page);
  await dialog.getByRole('button', { name: 'Add checklist', exact: true }).click();
  for (const text of ['Parent', 'Nested child', 'Completed root']) await dialog.getByRole('textbox', { name: 'New list item', exact: true }).fill(text);
  const row = (text: string) => dialog.locator('[data-check-row]').filter({ has: page.getByRole('button', { name: `Reorder ${text}`, exact: true }) });
  await row('Nested child').getByRole('textbox').click(); await page.keyboard.press('Tab');
  await expect(row('Nested child')).toHaveClass(/is-child/);
  await row('Completed root').getByRole('checkbox').check();
  await dialog.getByRole('button', { name: '1 completed item', exact: true }).click();
  await expect(row('Completed root')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await createNote(page, 'Also selected', 'Additional exported text');
  await createNote(page, 'Excluded export', 'MUST STAY OUT');
  await card(page, 'Export checklist').getByRole('button', { name: 'Select note', exact: true }).click();
  await card(page, 'Also selected').getByRole('button', { name: 'Select note', exact: true }).click();
  const visualTitles = await page.locator('article.note-card.selected h2').allTextContents();
  for (const [option, extension] of [['Markdown (.md)', 'md'], ['Plain text (.txt)', 'txt'], ['HTML (.html)', 'html']]) {
    await page.getByRole('button', { name: 'Export notes', exact: true }).click();
    const pending = page.waitForEvent('download');
    await page.getByRole('menu', { name: 'Export format', exact: true }).getByRole('menuitem', { name: option, exact: true }).click();
    const download = await pending;
    expect(download.suggestedFilename()).toBe(`stow-2-notes.${extension}`);
    const content = await readFile((await download.path())!, 'utf8');
    expect(content).not.toContain('MUST STAY OUT');
    expect(content).toContain('Completed root'); expect(content).toContain('Nested child');
    expect(content.indexOf(visualTitles[0])).toBeLessThan(content.indexOf(visualTitles[1]));
    if (extension === 'md') { expect(content).toContain(body); expect(content).toContain('    - [ ] Nested child'); expect(content).toContain('- [x] Completed root'); }
    if (extension === 'txt') { expect(content).toContain('Source formatting reference (https://example.test/reference)'); expect(content).toContain('    - [ ] Nested child'); }
    if (extension === 'html') {
      expect(content).toMatch(/^<!doctype html>/);
      expect(content).not.toMatch(/<script|href="javascript:/);
      const structure = await page.evaluate(html => {
        const parsed = new DOMParser().parseFromString(html, 'text/html');
        return { articles: parsed.querySelectorAll('article').length, nested: parsed.querySelector('ul > li > ul > li')?.textContent, checked: parsed.querySelector('[aria-label="Checked"]')?.parentElement?.textContent };
      }, content);
      expect(structure).toEqual({ articles: 2, nested: '☐ Nested child', checked: '☑ Completed root' });
    }
  }
  await expect(page.getByRole('button', { name: 'Deselect note', exact: true })).toHaveCount(2);
});

test('clipboard rejection displays its error without reporting success or attempting another clipboard API', async ({ page }) => {
  await createNote(page, 'Denied copy', 'Retained text');
  await page.evaluate(() => {
    Object.defineProperty(navigator.clipboard, 'write', { value: async () => { throw new Error('Clipboard access denied for this test'); } });
    Object.defineProperty(navigator.clipboard, 'writeText', { value: async () => { throw new Error('Unexpected alternate clipboard API'); } });
  });
  await card(page, 'Denied copy').getByRole('button', { name: 'Select note', exact: true }).click();
  await page.getByRole('button', { name: 'Copy selected notes', exact: true }).click();
  await expect(page.locator('.toast')).toContainText('Clipboard access denied for this test');
  await expect(page.locator('.toast')).not.toContainText('Copied');
  await expect(card(page, 'Denied copy').getByRole('button', { name: 'Deselect note', exact: true })).toBeVisible();
});
