import { test, expect, type Page } from '@playwright/test';

const note = (page: Page, title: string) => page.getByRole('article', { name: `Open note: ${title}`, exact: true });
const source = '# A heading\n\n**Bold** and *italic* with ~~old~~ and `code`.\nNext line stays separate.\n\n> A quotation\n\n- First bullet\n- Second bullet\n\n| Name | Value |\n| --- | --- |\n| Tea | 2 |\n\n```js\nconst value = 1;\n```\n\nRead https://example.com/article. Or [a named link](https://example.com/named).';
async function ready(page: Page) {
  await page.goto('/');
  await expect(page.locator('.sync-state')).toHaveAttribute('title', 'Connected');
}

test('a whole text field edits Markdown source and renders on blur, with durable source and undo', async ({ page, browser }) => {
  await ready(page);
  await page.getByRole('button', { name: 'Take a note…', exact: true }).click();
  const title = page.getByRole('textbox', { name: 'Note title', exact: true });
  await title.fill('Markdown note');
  const body = page.getByRole('textbox', { name: 'Note text', exact: true });
  await body.focus();
  await body.fill(source);
  await expect(body).toHaveValue(source);
  await title.focus();
  const creationEditor = page.getByRole('dialog', { name: 'Edit note', exact: true });
  await expect(creationEditor.getByRole('heading', { name: 'A heading', exact: true })).toBeVisible();
  await expect(creationEditor.locator('strong')).toHaveText('Bold');
  await expect(creationEditor.locator('em')).toHaveText('italic');
  await expect(creationEditor.locator('s')).toHaveText('old');
  await expect(creationEditor.locator('blockquote')).toHaveText('A quotation');
  await expect(creationEditor.getByRole('table')).toContainText('Tea');
  await expect(creationEditor.locator('pre code')).toHaveText('const value = 1;\n');
  await page.screenshot({ path: test.info().outputPath('stow-markdown-preview.png'), fullPage: true });
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  const card = note(page, 'Markdown note');
  await expect(card.locator('strong')).toHaveText('Bold');
  await card.getByRole('heading', { name: 'Markdown note', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const editor = dialog.getByRole('textbox', { name: 'Note text', exact: true });
  await editor.click();
  await expect(editor).toHaveValue(source);
  await editor.fill(source.replace('**Bold**', '**Changed**'));
  await page.keyboard.press('Control+z');
  await expect(editor).toHaveValue(source);
  await editor.evaluate((field: HTMLTextAreaElement) => field.setSelectionRange(4, 11));
  await dialog.getByRole('textbox', { name: 'Note title', exact: true }).focus();
  await editor.focus();
  expect(await editor.evaluate((field: HTMLTextAreaElement) => [field.selectionStart, field.selectionEnd])).toEqual([4, 11]);
  await page.keyboard.press('Escape');
  await page.reload();
  await expect(note(page, 'Markdown note').locator('strong')).toHaveText('Bold');
  const other = await browser.newContext();
  try {
    const remote = await other.newPage();
    await ready(remote);
    await note(remote, 'Markdown note').getByRole('heading', { name: 'Markdown note', exact: true }).click();
    const text = remote.getByRole('dialog').getByRole('textbox', { name: 'Note text', exact: true });
    await text.focus();
    await expect(text).toHaveValue(source);
  } finally { await other.close(); }
});

test('closed checklist text opens the tile while editor links keep their destination behavior', async ({ page, context }) => {
  await context.route('https://example.com/**', route => route.fulfill({ contentType: 'text/html', body: '<title>Destination</title>Link destination' }));
  await ready(page);
  await page.getByRole('button', { name: 'New checklist', exact: true }).click();
  await page.getByRole('textbox', { name: 'Note title', exact: true }).fill('Formatted checklist');
  const item = 'Buy **coffee** and *tea* at https://example.com/shop.';
  await page.getByRole('textbox', { name: 'New list item', exact: true }).fill(item);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  const card = note(page, 'Formatted checklist');
  await expect(card.locator('strong')).toHaveText('coffee');
  await expect(card.locator('em')).toHaveText('tea');
  await expect(card.getByRole('link')).toHaveCount(0);
  await expect(card.getByRole('checkbox')).not.toBeChecked();
  await card.locator('.markdown-inline').click();
  const dialog = page.getByRole('dialog');
  const link = dialog.getByRole('link', { name: 'https://example.com/shop', exact: true });
  await expect(link).toHaveAttribute('href', 'https://example.com/shop');
  const popupPromise = page.waitForEvent('popup');
  await link.click();
  const popup = await popupPromise;
  await expect(popup).toHaveURL('https://example.com/shop');
  await popup.close();
  await expect(dialog.getByRole('checkbox')).not.toBeChecked();
  await expect(dialog.locator('.item-text strong')).toHaveText('coffee');
  const editor = dialog.getByRole('textbox', { name: 'List item text', exact: true });
  await editor.getByText('coffee', { exact: true }).click();
  await expect(editor).toHaveValue(item);
  await editor.fill('**Keep me**\n# This remains inline text');
  await dialog.getByRole('textbox', { name: 'Note title', exact: true }).focus();
  await expect(dialog.locator('.item-text strong')).toHaveText('Keep me');
  await expect(editor).toContainText('# This remains inline text');
  await expect(editor.getByRole('heading')).toHaveCount(0);
  await expect(dialog.getByRole('checkbox')).not.toBeChecked();
});

test('Markdown does not execute HTML or fetch remote images', async ({ page }) => {
  const remoteRequests: string[] = [];
  page.on('request', request => { if (request.url().startsWith('https://untrusted.example/')) remoteRequests.push(request.url()); });
  await ready(page);
  await page.getByRole('button', { name: 'Take a note…', exact: true }).click();
  await page.getByRole('textbox', { name: 'Note title', exact: true }).fill('Safe Markdown');
  const editor = page.getByRole('textbox', { name: 'Note text', exact: true });
  await editor.focus();
  await editor.fill('<img src="https://untrusted.example/pixel" onerror="window.markdownExecuted=true">\n\n[bad](javascript:alert(1))\n\n![External picture](https://untrusted.example/image.png)');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  const card = note(page, 'Safe Markdown');
  await expect(card).toContainText('<img src=');
  await expect(card.locator('.markdown-body img')).toHaveCount(0);
  await expect(card.getByRole('link', { name: 'bad', exact: true })).toHaveCount(0);
  await expect(card.getByRole('link')).toHaveCount(0);
  await expect(card).toContainText('External picture');
  await card.getByRole('heading', { name: 'Safe Markdown', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('link', { name: 'External picture', exact: true })).toHaveAttribute('href', 'https://untrusted.example/image.png');
  expect(await page.evaluate(() => Reflect.get(window, 'markdownExecuted'))).toBeUndefined();
  expect(remoteRequests).toEqual([]);
});

test('swiping rendered note text scrolls on a phone without entering source mode', async ({ browser }) => {
  const phone = await browser.newContext({ viewport: { width: 390, height: 720 }, isMobile: true, hasTouch: true });
  try {
    const page = await phone.newPage();
    await ready(page);
    await page.getByRole('button', { name: 'Take a note…', exact: true }).click();
    await page.getByRole('textbox', { name: 'Note title', exact: true }).fill('Scrolling Markdown');
    const body = page.getByRole('textbox', { name: 'Note text', exact: true });
    await body.focus();
    await body.fill('A **formatted** paragraph with enough words to read while scrolling.\n\n'.repeat(25));
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await note(page, 'Scrolling Markdown').getByRole('heading', { name: 'Scrolling Markdown', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('textbox', { name: 'Note title', exact: true }).click({ trial: true });
    const scroller = dialog.locator('.editor-scroll');
    const box = (await scroller.boundingBox())!;
    const x = box.x + box.width / 2, y = box.y + Math.min(box.height - 30, 300);
    const input = await phone.newCDPSession(page);
    await input.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await input.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - 60 }] });
    await input.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - 150 }] });
    await input.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    await expect(dialog.getByRole('textbox', { name: 'Note text', exact: true })).toHaveAttribute('aria-readonly', 'true');
  } finally { await phone.close(); }
});

test('imported literal text and spacing render and search accurately while wrapping on a phone', async ({ page, context }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await ready(page);
  const bodySource = '&#32;&#32;&#32;&#32;Indented   words\nSecond  line\n&#32;&#32;Third\n\na\\_b \\*literal\\* &amp;lt; **visible** *phrase* ' + 'Averylongunbrokenword'.repeat(12);
  const itemSource = '&#32;&#32;Item   item\\_name \\*asterisk\\* &amp;lt; ' + 'Anotherlongunbrokenword'.repeat(10) + '\nSecond  item line';
  await page.getByRole('button', { name: 'Take a note…', exact: true }).click();
  await page.getByRole('textbox', { name: 'Note title', exact: true }).fill('Imported literal spacing');
  const body = page.getByRole('textbox', { name: 'Note text', exact: true });
  await body.focus(); await body.fill(bodySource);
  await page.getByRole('dialog', { name: 'Edit note', exact: true }).getByRole('button', { name: 'Add checklist', exact: true }).click();
  await page.getByRole('textbox', { name: 'New list item', exact: true }).fill('Pending item');
  const item = page.getByRole('dialog', { name: 'Edit note', exact: true }).getByRole('textbox', { name: 'List item text', exact: true });
  await item.focus(); await item.fill(itemSource);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  const card = note(page, 'Imported literal spacing');
  const paragraph = card.locator('.card-body>p').first();
  await expect(paragraph.locator('br')).toHaveCount(2);
  const spaces = await paragraph.evaluate(element => {
    const text = element.firstChild!;
    const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 1);
    const one = range.getBoundingClientRect().width;
    range.setEnd(text, 4);
    return { first: text.textContent, one, four: range.getBoundingClientRect().width, height: element.getBoundingClientRect().height, lineHeight: parseFloat(getComputedStyle(element).lineHeight), whitespace: getComputedStyle(element).whiteSpace };
  });
  expect(spaces.first).toBe('    Indented   words');
  expect(spaces.whitespace).toBe('pre-wrap');
  expect(spaces.one).toBeGreaterThan(0);
  expect(spaces.four).toBeGreaterThanOrEqual(spaces.one * 3.9);
  expect(spaces.height).toBeLessThanOrEqual(spaces.lineHeight * 3 + 2);
  await expect(card.locator('.check-row .markdown-inline')).toContainText('Item   item_name *asterisk* &lt;');
  for (const query of ['a_b', '*literal*', '&lt;', 'visible phrase', 'item_name', '*asterisk*']) {
    await page.getByRole('searchbox', { name: 'Search notes' }).fill(query);
    await expect(card).toBeVisible();
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await card.getByRole('heading', { name: 'Imported literal spacing', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit note', exact: true });
  await expect(dialog.locator('.editor-body .markdown-body>p').first()).toHaveText('    Indented   wordsSecond  line  Third');
  const renderedItem = dialog.locator('.item-text .markdown-inline');
  await expect(renderedItem).toHaveCSS('white-space', 'pre-wrap');
  expect(await renderedItem.evaluate(element => element.getBoundingClientRect().width <= element.parentElement!.getBoundingClientRect().width + 1)).toBe(true);
  const editor = dialog.getByRole('textbox', { name: 'Note text', exact: true });
  await editor.focus();
  await expect(editor).toHaveValue(bodySource);
  expect(await editor.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await context.setOffline(true); await page.reload();
  await page.getByRole('searchbox', { name: 'Search notes' }).fill('a_b');
  await expect(card).toBeVisible();
  await expect(card.locator('.card-body>p').first().locator('br')).toHaveCount(2);
});
