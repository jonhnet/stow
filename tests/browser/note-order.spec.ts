import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import * as Y from 'yjs';
import { Vault } from '../../src/core/vault';

const ORIGIN = 'http://localhost:4174';
const card = (page: Page, title: string) => page.getByRole('article', { name: `Open note: ${title}`, exact: true });
const order = (page: Page) => page.locator('.windowed-card .note-card h2').allTextContents();

async function seed(page: Page, context: BrowserContext, count = 5) {
  const session = await (await context.request.get(`${ORIGIN}/api/session`)).json();
  const vault = new Vault();
  for (let index = 0; index < count; index++) {
    const id = vault.createNote(index === 0 ? 'checklist' : 'text', { title: `Order note ${String(index).padStart(3, '0')}`, body: 'A short note to move around.' });
    if (index === 0) vault.addItem(id, 'Keep this checkbox usable');
  }
  const titles = vault.getNotes().map(note => note.title);
  const update = [...Y.encodeStateAsUpdate(vault.doc)];
  vault.doc.destroy();
  await page.goto(`${ORIGIN}/api/health`);
  await page.evaluate(async ({ update, vaultId }) => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(`stow-notes-${vaultId}`, 1);
      request.onupgradeneeded = () => { request.result.createObjectStore('updates', { autoIncrement: true }); request.result.createObjectStore('pendingEdits'); request.result.createObjectStore('maintenance'); };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result, transaction = db.transaction('updates', 'readwrite');
        transaction.objectStore('updates').add(new Uint8Array(update));
        transaction.oncomplete = () => { db.close(); resolve(); };
        transaction.onabort = () => { db.close(); reject(transaction.error); };
      };
    });
  }, { update, vaultId: session.vaultId });
  await page.goto(ORIGIN);
  await expect(page.locator('.sync-state')).toHaveAttribute('title', 'Connected');
  await expect(card(page, titles[0])).toBeVisible();
  return titles;
}

async function dragTo(page: Page, source: string, target: string, position: 'before' | 'after') {
  const a = (await card(page, source).boundingBox())!;
  const b = (await card(page, target).boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + 40);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 12, a.y + 40);
  await expect(page.locator('.note-drag-ghost')).toBeVisible();
  await page.mouse.move(b.x + b.width * (position === 'before' ? .25 : .75), b.y + 40, { steps: 10 });
  await expect(page.locator('.note-drop-marker')).toHaveAttribute('data-drop-position', position);
  await page.mouse.up();
  await expect(page.locator('.note-drag-ghost')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

test.beforeEach(async ({ context }, testInfo) => {
  await context.addCookies([{ name: 'stow_test_user', value: `note-order-${testInfo.testId}-${testInfo.retry}@example.test`, url: ORIGIN }]);
});

test('closing a mouse-opened note clears its controls, including after returning to the tab', async ({ page, context }) => {
  const titles = await seed(page, context, 2);
  const note = card(page, titles[1]);
  const controls = ['.select-note', '.card-pin', '.card-actions'];
  for (const close of ['button', 'backdrop', 'escape']) {
    await note.hover();
    for (const selector of controls) await expect(note.locator(selector)).toHaveCSS('opacity', '1');
    await note.click();
    const editor = page.getByRole('dialog', { name: 'Edit note', exact: true });
    await expect(editor).toBeVisible();
    await expect(editor.getByRole('textbox', { name: 'Note title', exact: true })).toBeFocused();
    if (close === 'button') await editor.getByRole('button', { name: 'Close', exact: true }).click();
    else if (close === 'backdrop') await page.locator('.modal-backdrop').click({ position: { x: 5, y: 5 } });
    else await page.keyboard.press('Escape');
    await page.mouse.move(0, 0);
    await expect(editor).toHaveCount(0);
    await expect(page.locator('.main-content')).toBeFocused();
    for (const selector of controls) await expect(note.locator(selector)).toHaveCSS('opacity', '0');
    const other = await context.newPage();
    await other.goto('about:blank'); await other.bringToFront(); await page.bringToFront();
    for (const selector of controls) await expect(note.locator(selector)).toHaveCSS('opacity', '0');
    await other.close();
  }
  await note.hover();
  for (const selector of controls) await expect(note.locator(selector)).toHaveCSS('opacity', '1');
});

test('keyboard navigation still reveals card controls and restores focus after closing a note', async ({ page, context }) => {
  const titles = await seed(page, context, 2);
  const note = card(page, titles[1]);
  await page.mouse.move(0, 0);
  await note.focus(); await page.keyboard.press('Tab');
  await expect(note.getByRole('button', { name: 'Select note', exact: true })).toBeFocused();
  await expect(note.locator('.card-actions')).toHaveCSS('opacity', '1');
  await page.keyboard.press('Shift+Tab');
  await expect(note).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Edit note', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog').getByRole('textbox', { name: 'Note title', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(note).toBeFocused();
  for (const selector of ['.select-note', '.card-pin', '.card-actions']) await expect(note.locator(selector)).toHaveCSS('opacity', '1');
});

test('selection actions and the export menu fit narrow phone screens', async ({ page, context }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const titles = await seed(page, context, 3);
  for (const title of titles.slice(0, 2)) await card(page, title).getByRole('button', { name: 'Select note', exact: true }).click();
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.getByRole('button', { name: 'Export notes', exact: true }).focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('menu', { name: 'Export format' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Markdown (.md)' })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('menuitem', { name: 'Plain text (.txt)' })).toBeFocused();
    const bounds = await page.locator('header.selection-topbar').evaluate(header => [...header.querySelectorAll('button,[role="menu"]')].map(element => {
      const rect = element.getBoundingClientRect();
      return { name: element.getAttribute('aria-label') || element.textContent, left: rect.left, right: rect.right };
    }));
    await test.info().attach(`selection-bounds-${width}`, { body: JSON.stringify({ width, documentWidth: await page.evaluate(() => document.documentElement.scrollWidth), bounds }), contentType: 'application/json' });
    await page.screenshot({ path: test.info().outputPath(`selection-export-${width}.png`) });
    for (const bound of bounds) {
      expect.soft(bound.left, `${width}px ${bound.name} left edge`).toBeGreaterThanOrEqual(0);
      expect.soft(bound.right, `${width}px ${bound.name} right edge`).toBeLessThanOrEqual(width);
    }
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu', { name: 'Export format' })).toHaveCount(0);
    await expect(page.locator('.selection-count')).toHaveText('2 selected');
  }
});

test('dragging before and after tiles persists, syncs, and supports undo without opening a note', async ({ page, context }) => {
  const titles = await seed(page, context);
  const peer = await context.newPage();
  await peer.goto(ORIGIN);
  await expect.poll(() => order(peer)).toEqual(titles);
  await dragTo(page, titles[4], titles[0], 'before');
  const moved = [titles[4], ...titles.slice(0, 4)];
  await expect.poll(() => order(page)).toEqual(moved);
  await expect.poll(() => order(peer)).toEqual(moved);
  await page.locator('header').getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => order(page)).toEqual(titles);
  await page.locator('header').getByRole('button', { name: 'Redo', exact: true }).click();
  await expect.poll(() => order(page)).toEqual(moved);
  await dragTo(page, titles[4], titles[3], 'after');
  await expect.poll(() => order(page)).toEqual(titles);
  await expect.poll(() => order(peer)).toEqual(titles);
  await page.reload();
  await expect.poll(() => order(page)).toEqual(titles);
  await peer.close();
});

test('taps, checkboxes, and the selection knob retain their behavior and selection disables dragging', async ({ page, context }) => {
  const titles = await seed(page, context);
  const checklist = card(page, 'Order note 000');
  // Completing the item immediately removes its overview checkbox.
  await checklist.getByRole('checkbox', { name: 'Keep this checkbox usable' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.note-drag-ghost')).toHaveCount(0);
  await expect(checklist).toContainText('1 completed item');
  const afterCheck = await order(page);
  await card(page, titles[1]).locator('.card-body').click();
  await expect(page.getByRole('dialog', { name: 'Edit note' })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await card(page, titles[1]).getByRole('button', { name: 'Select note', exact: true }).click();
  await expect(card(page, titles[1])).toHaveClass(/selected/);
  const a = (await card(page, titles[1]).boundingBox())!;
  const b = (await card(page, titles[2]).boundingBox())!;
  await page.mouse.move(a.x + 40, a.y + 40); await page.mouse.down();
  await page.mouse.move(b.x + 40, b.y + 40, { steps: 8 }); await page.mouse.up();
  await expect(page.locator('.note-drag-ghost')).toHaveCount(0);
  await expect.poll(() => order(page)).toEqual(afterCheck);
  await page.getByRole('button', { name: 'Clear selection', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('plain arrows navigate, Alt arrows reorder the focused tile, and drags cannot cross pin groups', async ({ page, context }) => {
  const titles = await seed(page, context);
  await page.getByRole('button', { name: 'List view', exact: true }).click();
  await card(page, titles[1]).focus();
  await page.keyboard.press('ArrowDown');
  await expect(card(page, titles[2])).toBeFocused();
  await expect.poll(() => order(page)).toEqual(titles);
  await page.keyboard.press('Alt+ArrowUp');
  const moved = [titles[0], titles[2], titles[1], ...titles.slice(3)];
  await expect.poll(() => order(page)).toEqual(moved);
  await expect(card(page, titles[2])).toBeFocused();
  await page.keyboard.press('Alt+ArrowDown');
  await expect.poll(() => order(page)).toEqual(titles);
  await card(page, titles[2]).getByRole('button', { name: 'Pin note', exact: true }).click();
  await expect(card(page, titles[2]).getByRole('button', { name: 'Unpin note', exact: true })).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(card(page, titles[2])).toBeInViewport({ ratio: 1 });
  const pinned = (await card(page, titles[2]).boundingBox())!;
  const unpinned = (await card(page, titles[0]).boundingBox())!;
  await page.mouse.move(pinned.x + 40, pinned.y + 40); await page.mouse.down();
  await page.mouse.move(unpinned.x + 40, unpinned.y + 40, { steps: 8 });
  await expect(page.locator('.note-drag-ghost')).toBeVisible();
  await expect(page.locator('.note-drop-marker')).toHaveCount(0);
  await page.mouse.up();
  await expect(card(page, titles[2]).getByRole('button', { name: 'Unpin note', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test.describe('touch note gestures', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  async function touchscreen(page: Page, context: BrowserContext) {
    expect(await page.evaluate(() => matchMedia('(hover: none)').matches)).toBe(true);
    const cdp = await context.newCDPSession(page);
    const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd' | 'touchCancel', x = 0, y = 0) => cdp.send('Input.dispatchTouchEvent', {
      type, touchPoints: type === 'touchEnd' || type === 'touchCancel' ? [] : [{ x, y }]
    });
    return { touch, close: () => cdp.detach() };
  }

  async function expectCircles(page: Page, visible: boolean) {
    const circles = page.locator('.note-card .select-note');
    expect(await circles.count()).toBeGreaterThan(1);
    await expect.poll(() => circles.evaluateAll((elements, show) => elements.every(element => getComputedStyle(element).opacity === (show ? '1' : '0')), visible)).toBe(true);
  }

  test('quick swipes scroll and cancel the hold; taps, checkboxes, and buttons remain active', async ({ page, context }) => {
    const titles = await seed(page, context, 30);
    const { touch, close } = await touchscreen(page, context);
    await expectCircles(page, false);
    const scrollCard = (await card(page, titles[4]).boundingBox())!;
    const x = scrollCard.x + 45, y = Math.min(680, scrollCard.y + 45);
    await touch('touchStart', x, y);
    for (let step = 1; step <= 5; step++) await touch('touchMove', x, y - step * 40);
    // Release a stationary finger to avoid a fling affecting the next gesture.
    await page.waitForTimeout(200);
    await touch('touchEnd');
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(50);
    await page.waitForTimeout(500);
    await expect(page.locator('.selection-count')).toHaveCount(0);
    await expect(page.locator('.note-drag-ghost')).toHaveCount(0);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expectCircles(page, false);

    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const checklist = card(page, 'Order note 000');
    const checkbox = checklist.getByRole('checkbox', { name: 'Keep this checkbox usable' });
    await checkbox.scrollIntoViewIfNeeded();
    const checkBounds = (await checkbox.boundingBox())!;
    await touch('touchStart', checkBounds.x + checkBounds.width / 2, checkBounds.y + checkBounds.height / 2);
    await page.waitForTimeout(550);
    await expect(page.locator('.selection-count')).toHaveCount(0);
    await expect(page.locator('.note-drag-ghost')).toHaveCount(0);
    await touch('touchEnd');
    await expect(checklist).toContainText('1 completed item');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expectCircles(page, false);

    const colorButton = checklist.getByRole('button', { name: 'Background color', exact: true });
    const colorBounds = (await colorButton.boundingBox())!;
    await touch('touchStart', colorBounds.x + colorBounds.width / 2, colorBounds.y + colorBounds.height / 2);
    await page.waitForTimeout(550);
    await expect(page.locator('.selection-count')).toHaveCount(0);
    await touch('touchEnd');
    await expect(checklist.getByRole('group', { name: 'Note background color' })).toBeVisible();
    await colorButton.tap();
    await checklist.locator('.card-body').tap();
    await expect(page.getByRole('dialog', { name: 'Edit note' })).toBeVisible();
    await close();
  });

  test('a still hold tolerates jitter, selects without dragging, and reveals secondary selection circles', async ({ page, context }) => {
    const titles = await seed(page, context, 5);
    const { touch, close } = await touchscreen(page, context);
    await expectCircles(page, false);
    await page.screenshot({ path: test.info().outputPath('touch-before-selection.png') });
    const first = card(page, titles[0]);
    const a = (await first.boundingBox())!;
    const x = a.x + 45, y = a.y + 40;
    await touch('touchStart', x, y);
    await touch('touchMove', x + 4, y + 3);
    await touch('touchMove', x + 8, y + 5);
    await expect(first).toHaveClass(/selected/);
    await expect(page.locator('.selection-count')).toHaveText('1 selected');
    await expect(page.locator('.note-drag-ghost')).toHaveCount(0);
    await expectCircles(page, true);
    await touch('touchMove', x + 5, y + 6);
    await expect(page.locator('.note-drag-ghost')).toHaveCount(0);
    await touch('touchEnd');
    await expect(page.locator('.selection-count')).toHaveText('1 selected');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect.poll(() => order(page)).toEqual(titles);
    await page.screenshot({ path: test.info().outputPath('touch-after-long-press.png') });

    const second = card(page, titles[1]);
    await second.getByRole('button', { name: 'Select note', exact: true }).tap();
    await expect(page.locator('.selection-count')).toHaveText('2 selected');
    await first.getByRole('button', { name: 'Deselect note', exact: true }).tap();
    await expect(page.locator('.selection-count')).toHaveText('1 selected');
    await expectCircles(page, true);
    await second.getByRole('button', { name: 'Deselect note', exact: true }).tap();
    await expect(page.locator('.selection-count')).toHaveCount(0);
    // Touch leaves a sticky hover/focus on the last knob; it must still disappear.
    await expectCircles(page, false);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await close();
  });

  test('moving beyond the held radius starts a drag and clears only the provisional selection', async ({ page, context }) => {
    const titles = await seed(page, context, 5);
    const { touch, close } = await touchscreen(page, context);
    const a = (await card(page, titles[0]).boundingBox())!, b = (await card(page, titles[3]).boundingBox())!;
    await touch('touchStart', a.x + 45, a.y + 40);
    await expect(page.locator('.selection-count')).toHaveText('1 selected');
    await expect(page.locator('.note-drag-ghost')).toHaveCount(0);
    await touch('touchMove', a.x + 57, a.y + 40);
    await expect(page.locator('.note-drag-ghost')).toBeVisible();
    await expect(page.locator('.selection-count')).toHaveCount(0);
    await touch('touchMove', b.x + b.width * .75, b.y + 40);
    await expect(page.locator('.note-drop-marker')).toHaveAttribute('data-drop-position', 'after');
    await touch('touchEnd');
    await expect(page.locator('.note-drag-ghost')).toHaveCount(0);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect.poll(() => order(page)).toEqual([titles[1], titles[2], titles[3], titles[0], titles[4]]);
    await expectCircles(page, false);

    // A separately completed long press enters regular selection mode; later holds
    // cannot reorder its selection or start dragging other cards.
    const selected = (await card(page, titles[1]).boundingBox())!;
    await touch('touchStart', selected.x + 45, selected.y + 40);
    await expect(page.locator('.selection-count')).toHaveText('1 selected');
    await touch('touchEnd');
    const other = (await card(page, titles[2]).boundingBox())!;
    await touch('touchStart', other.x + 45, other.y + 40);
    await page.waitForTimeout(550);
    await touch('touchMove', other.x + 65, other.y + 40);
    await touch('touchEnd');
    await expect(page.locator('.note-drag-ghost')).toHaveCount(0);
    await expect.poll(() => order(page)).toEqual([titles[1], titles[2], titles[3], titles[0], titles[4]]);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await close();
  });

  test('an image-only card can be selected by holding its preview while a quick tap still opens the image', async ({ page, context }) => {
    await seed(page, context, 3);
    const { touch, close } = await touchscreen(page, context);
    await page.getByRole('button', { name: 'Take a note…', exact: true }).tap();
    const bytes = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 48;
      const drawing = canvas.getContext('2d')!; drawing.fillStyle = '#00a0c0'; drawing.fillRect(0, 0, 64, 48);
      return Array.from(atob(canvas.toDataURL('image/png').split(',')[1]), character => character.charCodeAt(0));
    });
    await page.getByRole('dialog', { name: 'Edit note', exact: true }).locator('input[type=file]').setInputFiles({ name: 'touch-drawing.png', mimeType: 'image/png', buffer: Buffer.from(bytes) });
    await expect(page.getByRole('dialog', { name: 'Edit note', exact: true }).locator('img')).toHaveCount(1);
    await page.getByRole('button', { name: 'Close', exact: true }).tap();
    const imageCard = card(page, 'Untitled note');
    const preview = imageCard.getByRole('button', { name: 'Open original: touch-drawing.png', exact: true });
    await expect(preview.getByRole('img')).toBeVisible();
    await expectCircles(page, false);
    const bounds = (await preview.boundingBox())!;
    await touch('touchStart', bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await expect(imageCard).toHaveClass(/selected/);
    await expect(page.locator('.selection-count')).toHaveText('1 selected');
    await expect(page.locator('.note-drag-ghost')).toHaveCount(0);
    await touch('touchEnd');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expectCircles(page, true);
    await page.getByRole('button', { name: 'Clear selection', exact: true }).tap();
    await expectCircles(page, false);
    await preview.tap();
    await expect(page.getByRole('dialog', { name: 'Original image: touch-drawing.png', exact: true }).getByRole('img', { name: 'touch-drawing.png', exact: true })).toBeVisible();
    await close();
  });

  test('losing native pointer capture cancels the held selection without opening or moving the note', async ({ page, context }) => {
    const titles = await seed(page, context, 5);
    const { touch, close } = await touchscreen(page, context);
    const grid = page.locator('.windowed-notes');
    await grid.evaluate(element => element.addEventListener('gotpointercapture', event => {
      if (event.target === element) (element as HTMLElement).dataset.testPointer = String((event as PointerEvent).pointerId);
    }));
    const a = (await card(page, titles[0]).boundingBox())!;
    const x = a.x + 45, y = a.y + 40;
    await touch('touchStart', x, y);
    await expect(page.locator('.selection-count')).toHaveText('1 selected');
    await touch('touchMove', x + 2, y + 1);
    await expect(grid).toHaveAttribute('data-test-pointer', /\d+/);
    await grid.evaluate(element => element.releasePointerCapture(Number((element as HTMLElement).dataset.testPointer)));
    await touch('touchMove', x + 3, y + 1);
    await expect(page.locator('.selection-count')).toHaveCount(0);
    await touch('touchEnd');
    await expect(page.locator('.note-drag-ghost')).toHaveCount(0);
    await expectCircles(page, false);
    await expect.poll(() => order(page)).toEqual(titles);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await close();
  });

  test('cancelled touches do not leave a pending hold or a provisional selection', async ({ page, context }) => {
    const titles = await seed(page, context, 5);
    const { touch, close } = await touchscreen(page, context);
    const a = (await card(page, titles[0]).boundingBox())!;
    await touch('touchStart', a.x + 45, a.y + 40);
    await touch('touchCancel');
    await page.waitForTimeout(550);
    await expect(page.locator('.selection-count')).toHaveCount(0);
    await touch('touchStart', a.x + 45, a.y + 40);
    await expect(page.locator('.selection-count')).toHaveText('1 selected');
    await touch('touchCancel');
    await expect(page.locator('.selection-count')).toHaveCount(0);
    await expect(page.locator('.note-drag-ghost')).toHaveCount(0);
    await expectCircles(page, false);
    await expect.poll(() => order(page)).toEqual(titles);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await close();
  });
});

test('edge scrolling retains the dragged virtual tile and Escape cancels without changing order', async ({ page, context }) => {
  const titles = await seed(page, context, 300);
  const first = (await card(page, titles[0]).boundingBox())!;
  await page.mouse.move(first.x + 60, first.y + 45); await page.mouse.down();
  await page.mouse.move(first.x + 60, page.viewportSize()!.height - 8, { steps: 6 });
  await expect(page.locator('.note-drag-ghost')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.scrollY), { timeout: 8000 }).toBeGreaterThan(1400);
  await expect(card(page, titles[0])).toHaveCount(1);
  expect(await page.locator('.note-card').count()).toBeLessThan(100);
  await page.keyboard.press('Escape'); await page.mouse.up();
  await expect(page.locator('.note-drag-ghost')).toHaveCount(0);
  await expect(page.locator('.note-drop-marker')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect.poll(async () => (await order(page)).slice(0, 5)).toEqual(titles.slice(0, 5));
});
