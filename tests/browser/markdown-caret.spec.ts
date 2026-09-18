import { test, expect, type Locator, type Page } from '@playwright/test';

const ORIGIN = 'http://localhost:4174';
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Edit note', exact: true });
const body = (page: Page) => dialog(page).getByRole('textbox', { name: 'Note text', exact: true });
const title = (page: Page) => dialog(page).getByRole('textbox', { name: 'Note title', exact: true });

test.beforeEach(async ({ page, context }, testInfo) => {
  await context.addCookies([{ name: 'stow_test_user', value: `caret-${testInfo.testId}-${testInfo.retry}@example.test`, url: ORIGIN }]);
  await page.goto(ORIGIN);
  await expect(page.locator('.sync-state')).toHaveAttribute('title', 'Connected');
});

async function openRenderedNote(page: Page, source: string) {
  await page.getByRole('button', { name: 'Take a note…', exact: true }).click();
  await title(page).fill('Caret placement');
  await body(page).focus();
  await body(page).fill(source);
  await dialog(page).getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('article', { name: 'Open note: Caret placement', exact: true }).click();
  await expect(body(page)).toHaveAttribute('aria-readonly', 'true');
  await body(page).click({ trial: true });
}

// Click inside the left/right part of a rendered glyph, away from the ambiguous
// halfway point. DOM Range geometry also follows wrapped lines and nested markup.
async function glyphPoint(target: Locator, text: string, character = 0, after = false) {
  await target.scrollIntoViewIfNeeded();
  return target.evaluate((element, { text, character, after }) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    while (walker.nextNode()) nodes.push(walker.currentNode as Text);
    const rendered = nodes.map(node => node.data).join('');
    let offset = rendered.indexOf(text);
    if (offset < 0) throw new Error(`Cannot find ${JSON.stringify(text)} in ${JSON.stringify(rendered)}`);
    offset += character;
    for (const node of nodes) {
      if (offset >= node.length) { offset -= node.length; continue; }
      const range = document.createRange();
      range.setStart(node, offset);
      range.setEnd(node, offset + 1);
      const rect = range.getBoundingClientRect();
      if (!rect.width || !rect.height) throw new Error('Expected a visible rendered character');
      return { x: rect.left + rect.width * (after ? 0.8 : 0.2), y: rect.top + rect.height / 2 };
    }
    throw new Error('Rendered character was outside the field');
  }, { text, character, after });
}

async function expectInsertion(page: Page, field: Locator, source: string, offset: number) {
  await expect(field).toBeFocused();
  await expect(field).toHaveValue(source);
  expect(await field.evaluate((input: HTMLTextAreaElement) => [input.selectionStart, input.selectionEnd])).toEqual([offset, offset]);
  await page.keyboard.insertText('X');
  await expect(field).toHaveValue(source.slice(0, offset) + 'X' + source.slice(offset));
}

async function bottomSpace(page: Page) {
  await dialog(page).locator('.editor-date').click({ trial: true });
  const bounds = (await dialog(page).locator('.editor-date').boundingBox())!;
  return { x: bounds.x + 24, y: bounds.y + bounds.height - 5 };
}

test('clicks distinguish repeated words across headings, paragraphs, and list items', async ({ page }) => {
  const source = '# echo\n\nFirst echo has **echo**.\n\nAnother echo.\n\n- echo\n- **echo** and end';
  await openRenderedNote(page, source);
  const cases = [
    { target: () => body(page).locator('h1'), offset: source.indexOf('echo') + 2 },
    { target: () => body(page).locator('strong').first(), offset: source.indexOf('**echo**') + 4 },
    { target: () => body(page).locator('p').filter({ hasText: 'Another echo.' }), offset: source.indexOf('Another echo') + 10 },
    { target: () => body(page).locator('li').first(), offset: source.indexOf('- echo') + 4 },
    { target: () => body(page).locator('li strong'), offset: source.lastIndexOf('**echo**') + 4 },
  ];
  for (const entry of cases) {
    const point = await glyphPoint(entry.target(), 'echo', 2);
    await page.mouse.click(point.x, point.y);
    await expectInsertion(page, body(page), source, entry.offset);
    await body(page).fill(source);
    await title(page).focus();
  }
});

test('escaped punctuation, HTML entities, and inline code map to their original source', async ({ page }) => {
  const source = 'Literal \\*stars\\* &amp; tea; encoded &#x41; and ` a  b `.';
  await openRenderedNote(page, source);
  const cases = [
    { text: 'stars', character: 2, offset: source.indexOf('stars') + 2 },
    { text: '&', after: true, offset: source.indexOf('&amp;') + '&amp;'.length },
    { text: 'tea', character: 1, offset: source.indexOf('tea') + 1 },
    { text: 'A', after: true, offset: source.indexOf('&#x41;') + '&#x41;'.length },
    { text: 'b', code: true, offset: source.indexOf('b `') },
  ];
  for (const entry of cases) {
    const point = await glyphPoint(entry.code ? body(page).locator('code') : body(page), entry.text, entry.character, entry.after);
    await page.mouse.click(point.x, point.y);
    await expectInsertion(page, body(page), source, entry.offset);
    await body(page).fill(source);
    await title(page).focus();
  }
});

test('clicking after a link does not confuse visible text with its hidden destination', async ({ page }) => {
  const source = 'alpha [beta](https://example.com/alpha) alpha';
  await openRenderedNote(page, source);
  const point = await glyphPoint(body(page), 'beta alpha', 'beta '.length + 2);
  await page.mouse.click(point.x, point.y);
  await expectInsertion(page, body(page), source, source.lastIndexOf('alpha') + 2);
});

test('clicking whitespace beside a rendered line places the caret at that line end', async ({ page }) => {
  const source = 'First **line** here.\nSecond line stays separate.';
  await openRenderedNote(page, source);
  const point = await glyphPoint(body(page), 'here.', 4, true);
  const bounds = (await body(page).boundingBox())!;
  const whitespaceX = Math.min(point.x + 60, bounds.x + bounds.width - 10);
  expect(whitespaceX - point.x).toBeGreaterThan(20);
  await page.mouse.click(whitespaceX, point.y);
  await expectInsertion(page, body(page), source, source.indexOf('\n'));
});

test('clicking below rendered text appends after trailing Markdown and blank lines', async ({ page }) => {
  const source = 'Last **word**\n\n';
  await openRenderedNote(page, source);
  const field = (await body(page).boundingBox())!;
  const rendered = (await body(page).locator('.markdown-body').boundingBox())!;
  const bottom = rendered.y + rendered.height;
  expect(field.y + field.height - bottom).toBeGreaterThan(2);
  await page.mouse.click(field.x + 20, (bottom + field.y + field.height) / 2);
  await expectInsertion(page, body(page), source, source.length);
});

test('clicking the bottom blank space appends instead of restoring an earlier selection', async ({ page }) => {
  const source = 'First line.\nLast **word**\n\n';
  await openRenderedNote(page, source);
  await body(page).focus();
  await body(page).evaluate((input: HTMLTextAreaElement) => input.setSelectionRange(0, 5));
  await title(page).focus();
  const point = await bottomSpace(page);
  await page.mouse.click(point.x, point.y);
  await expectInsertion(page, body(page), source, source.length);
});

test('a pointer chooses a new caret while programmatic focus preserves the saved selection', async ({ page }) => {
  const source = 'Before **coffee** and after.';
  await openRenderedNote(page, source);
  await body(page).focus();
  await body(page).evaluate((input: HTMLTextAreaElement) => input.setSelectionRange(0, 6));
  await title(page).focus();
  await body(page).focus();
  expect(await body(page).evaluate((input: HTMLTextAreaElement) => [input.selectionStart, input.selectionEnd])).toEqual([0, 6]);
  await title(page).focus();
  const point = await glyphPoint(body(page).locator('strong'), 'coffee', 3);
  await page.mouse.click(point.x, point.y);
  await expectInsertion(page, body(page), source, source.indexOf('coffee') + 3);
});

test('clicking formatted checklist text edits the clicked character without checking the item', async ({ page }) => {
  const source = 'Buy **coffee** then `tea` and coffee';
  await openRenderedNote(page, 'Groceries');
  await dialog(page).getByRole('button', { name: 'Add checklist', exact: true }).click();
  await dialog(page).getByRole('textbox', { name: 'New list item', exact: true }).fill(source);
  await title(page).focus();
  const item = dialog(page).getByRole('textbox', { name: 'List item text', exact: true });
  const point = await glyphPoint(item.locator('strong'), 'coffee', 2);
  await page.mouse.click(point.x, point.y);
  await expectInsertion(page, item, source, source.indexOf('coffee') + 2);
  await expect(dialog(page).getByRole('checkbox')).not.toBeChecked();
});

test.describe('phone taps', () => {
  test.use({ viewport: { width: 390, height: 720 }, isMobile: true, hasTouch: true });

  test('tapping the bottom blank space starts typing at the end of the free text', async ({ page }) => {
    const source = 'Last **word**\n\n';
    await openRenderedNote(page, source);
    const point = await bottomSpace(page);
    await page.touchscreen.tap(point.x, point.y);
    await expectInsertion(page, body(page), source, source.length);
  });

  test('a tap on wrapped rendered text places the source caret at that text', async ({ page }) => {
    const source = '**Start** with enough words to wrap this paragraph onto several lines before the destination appears here.';
    await openRenderedNote(page, source);
    const point = await glyphPoint(body(page), 'destination', 4);
    const bounds = (await body(page).boundingBox())!;
    expect(point.y - bounds.y).toBeGreaterThan(35);
    await page.touchscreen.tap(point.x, point.y);
    await expectInsertion(page, body(page), source, source.indexOf('destination') + 4);
  });
});
