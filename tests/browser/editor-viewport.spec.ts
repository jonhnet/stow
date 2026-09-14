import { test, expect, type Page } from '@playwright/test';

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

// Desktop Chromium has no Android keyboard. Reproduce its observable behavior:
// the visual viewport shrinks/pans while the layout viewport keeps its full height.
async function keyboardViewport(page: Page, height: number, offsetTop: number) {
  await page.evaluate(({ height, offsetTop }) => {
    Object.defineProperties(window.visualViewport, {
      height: { configurable: true, value: height },
      offsetTop: { configurable: true, value: offsetTop },
    });
    window.visualViewport!.dispatchEvent(new Event('resize'));
    window.visualViewport!.dispatchEvent(new Event('scroll'));
  }, { height, offsetTop });
}

async function createNote(page: Page, title: string, body: string, checklist = false) {
  await page.goto('/');
  await expect(page.locator('.sync-state')).toHaveAttribute('title', 'Connected');
  await page.getByRole('button', { name: checklist ? 'New checklist' : 'Take a note…', exact: true }).click();
  await page.getByRole('textbox', { name: 'Note title', exact: true }).fill(title);
  await page.getByRole('textbox', { name: 'Note text', exact: true }).focus();
  await page.locator('textarea[aria-label="Note text"]').fill(body);
  if (checklist) await page.getByRole('textbox', { name: 'New list item', exact: true }).fill('A checklist item');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('article', { name: `Open note: ${title}`, exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Edit note', exact: true })).toBeVisible();
}

test('open note fits a keyboard-sized visual viewport and follows a caret in long text', async ({ page }) => {
  const body = Array.from({ length: 40 }, (_, index) => `Line ${index + 1}`).join('\n');
  await createNote(page, 'Keyboard viewport text', body);
  const dialog = page.getByRole('dialog', { name: 'Edit note', exact: true });
  await expect.poll(() => dialog.evaluate(element => element.getAnimations().filter(animation => animation.playState === 'running').length)).toBe(0);
  const originalHeight = (await dialog.boundingBox())!.height;
  const layoutHeight = await page.evaluate(() => innerHeight);
  const pageScroll = await page.evaluate(() => scrollY);
  await keyboardViewport(page, 380, 64);
  await expect.poll(() => dialog.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return rect.top >= 64 && rect.bottom <= 444;
  })).toBe(true);
  expect(await page.evaluate(() => innerHeight)).toBe(layoutHeight);
  await expect(dialog.getByRole('textbox', { name: 'Note title', exact: true })).toBeFocused();

  await dialog.getByRole('textbox', { name: 'Note text', exact: true }).focus();
  const source = dialog.locator('textarea[aria-label="Note text"]');
  await expect(source).toBeFocused();
  const endVisible = () => source.evaluate(element => element.getBoundingClientRect().bottom <= element.closest('.editor-scroll')!.getBoundingClientRect().bottom + 1);
  await expect.poll(endVisible).toBe(true);
  const extra = '\nAnother line'.repeat(8);
  await page.keyboard.insertText(extra);
  await expect(source).toHaveValue(body + extra);
  await expect.poll(endVisible).toBe(true);

  // Moving back to the beginning reveals that caret, rather than always pinning
  // the bottom of a textarea that is taller than the visible part of the note.
  await source.evaluate(element => (element as HTMLTextAreaElement).setSelectionRange(0, 0));
  await expect.poll(() => source.evaluate(element => element.getBoundingClientRect().top >= element.closest('.editor-scroll')!.getBoundingClientRect().top - 1)).toBe(true);
  expect(await page.evaluate(() => scrollY)).toBe(pageScroll);

  await keyboardViewport(page, layoutHeight, 0);
  await expect.poll(async () => (await dialog.boundingBox())!.height).toBe(originalHeight);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toHaveCount(0);
});

test('short checklist fields and the close toolbar stay above the keyboard', async ({ page }) => {
  await createNote(page, 'Keyboard viewport checklist', 'Context\n'.repeat(12), true);
  const dialog = page.getByRole('dialog', { name: 'Edit note', exact: true });
  await dialog.getByRole('textbox', { name: 'List item text', exact: true }).focus();
  const field = dialog.locator('textarea[data-item-id]').first();
  await keyboardViewport(page, 330, 90);
  await expect.poll(() => field.evaluate(element => {
    const rect = element.getBoundingClientRect();
    const visible = element.closest('.editor-scroll')!.getBoundingClientRect();
    return rect.top >= visible.top && rect.bottom <= visible.bottom;
  })).toBe(true);
  await expect(field).toBeFocused();
  await expect.poll(() => dialog.locator('.editor-toolbar').evaluate(element => element.getBoundingClientRect().bottom <= 420)).toBe(true);

  // A later viewport pan has to move the fitted editor too, without stealing focus.
  await keyboardViewport(page, 330, 130);
  await expect.poll(() => dialog.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return rect.top >= 130 && rect.bottom <= 460;
  })).toBe(true);
  await expect(field).toBeFocused();
  await page.keyboard.insertText(' updated');
  await expect(field).toHaveValue('A checklist item updated');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toHaveCount(0);
});
