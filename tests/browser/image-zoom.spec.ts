import { test, expect, type CDPSession, type Page } from '@playwright/test';

const origin = 'http://localhost:4174';
test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });

async function openImage(page: Page) {
  await page.goto(origin);
  await expect(page.locator('.sync-state')).toHaveAttribute('title', 'Connected');
  await page.getByRole('button', { name: 'Take a note…', exact: true }).click();
  await page.getByRole('textbox', { name: 'Note title', exact: true }).fill('Return barcode');
  const bytes = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 1800; canvas.height = 1200;
    const context = canvas.getContext('2d')!;
    context.fillStyle = 'white'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = 'black';
    for (let x = 300; x < 1500; x += 17) context.fillRect(x, 450, x % 3 + 4, 300);
    return [...Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]), c => c.charCodeAt(0))];
  });
  const editor = page.getByRole('dialog', { name: 'Edit note', exact: true });
  await editor.locator('input[type=file]').setInputFiles({ name: 'barcode.png', mimeType: 'image/png', buffer: Buffer.from(bytes) });
  await expect(editor.getByRole('img', { name: 'barcode.png', exact: true })).toBeVisible();
  await editor.getByRole('button', { name: 'Open original: barcode.png', exact: true }).click();
  const viewer = page.getByRole('dialog', { name: 'Original image: barcode.png', exact: true });
  await expect(viewer.getByRole('img', { name: 'barcode.png', exact: true })).toBeVisible();
  await expect(viewer.getByRole('button', { name: 'Fit image', exact: true })).toHaveText('100%');
  expect(await viewer.getByRole('img', { name: 'barcode.png', exact: true }).evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(1800);
  return viewer;
}

async function touch(session: CDPSession, type: 'touchStart' | 'touchMove' | 'touchEnd' | 'touchCancel', points: { id: number; x: number; y: number }[]) {
  await session.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(point => ({ ...point, radiusX: 1, radiusY: 1 })) });
}

test.beforeEach(async ({ context }, info) => {
  await context.addCookies([{ name: 'stow_test_user', value: `image-zoom-${info.testId}`, url: origin }]);
});

test('trusted two-finger input zooms the original around the fingers, then pans without zooming the page', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'CDP provides trusted multi-touch input in Chromium.');
  const viewer = await openImage(page), image = viewer.getByRole('img', { name: 'barcode.png', exact: true });
  const viewport = viewer.getByRole('region', { name: 'Zoomable image' });
  const original = (await image.boundingBox())!, area = (await viewport.boundingBox())!;
  const cx = area.x + area.width / 2 + 20, cy = area.y + area.height / 2;
  const session = await context.newCDPSession(page);
  const two = (radius: number) => [{ id: 1, x: cx - radius, y: cy }, { id: 2, x: cx + radius, y: cy }];
  await touch(session, 'touchStart', two(30));
  for (const radius of [45, 60, 90, 120]) await touch(session, 'touchMove', two(radius));
  await expect(viewer.getByRole('button', { name: 'Fit image' })).toHaveText('400%');
  const zoomed = (await image.boundingBox())!;
  expect(zoomed.width / original.width).toBeCloseTo(4, 2);
  expect(zoomed.x + zoomed.width * ((cx - original.x) / original.width)).toBeCloseTo(cx, 0);
  // Keep one finger down after the pinch; it should become a pan without a jump.
  await touch(session, 'touchEnd', [two(120)[0]]);
  const afterLift = (await image.boundingBox())!;
  expect(afterLift.x).toBeCloseTo(zoomed.x, 1);
  await touch(session, 'touchMove', [{ id: 2, x: cx + 150, y: cy + 35 }]);
  await expect.poll(async () => (await image.boundingBox())!.x - afterLift.x).toBeCloseTo(30, 0);
  await expect.poll(async () => (await image.boundingBox())!.y - afterLift.y).toBeCloseTo(35, 0);
  await touch(session, 'touchEnd', []);
  expect(await page.evaluate(() => visualViewport!.scale)).toBe(1);
  await expect(viewer).toBeVisible();
  await touch(session, 'touchStart', two(120));
  for (const radius of [90, 60, 30, 10]) await touch(session, 'touchMove', two(radius));
  await touch(session, 'touchEnd', []);
  await expect(viewer.getByRole('button', { name: 'Fit image' })).toHaveText('100%');
  expect((await image.boundingBox())!.width).toBeCloseTo(original.width, 1);
  await touch(session, 'touchStart', two(50));
  await touch(session, 'touchMove', two(100));
  await touch(session, 'touchCancel', []);
  const canceled = (await image.boundingBox())!;
  await touch(session, 'touchStart', [{ id: 3, x: cx, y: cy }]);
  await touch(session, 'touchMove', [{ id: 3, x: cx - 30, y: cy }]);
  await touch(session, 'touchEnd', []);
  await expect.poll(async () => (await image.boundingBox())!.x - canceled.x).toBeCloseTo(-30, 0);
  await viewer.getByRole('button', { name: 'Close image' }).click();
  await expect(page.getByRole('dialog', { name: 'Edit note', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open original: barcode.png' })).toBeFocused();
});

test('zoom controls, mouse panning, rotation, focus, and offline reopening retain a usable viewer', async ({ page, context }) => {
  const viewer = await openImage(page), image = viewer.getByRole('img', { name: 'barcode.png', exact: true });
  const viewport = viewer.getByRole('region', { name: 'Zoomable image' });
  await expect(viewer.getByRole('button', { name: 'Zoom out' })).toBeDisabled();
  await viewer.getByRole('button', { name: 'Zoom in' }).click();
  await expect(viewer.getByRole('button', { name: 'Fit image' })).toHaveText('150%');
  await viewport.focus();
  await page.keyboard.press('+');
  await expect(viewer.getByRole('button', { name: 'Fit image' })).toHaveText('225%');
  const area = (await viewport.boundingBox())!, before = (await image.boundingBox())!;
  await page.mouse.move(area.x + area.width / 2, area.y + area.height / 2);
  await page.mouse.down(); await page.mouse.move(area.x + area.width / 2 - 45, area.y + area.height / 2, { steps: 5 }); await page.mouse.up();
  expect((await image.boundingBox())!.x - before.x).toBeCloseTo(-45, 0);
  await page.keyboard.press('ArrowRight');
  expect((await image.boundingBox())!.x - before.x).toBeCloseTo(-85, 0);
  await page.setViewportSize({ width: 844, height: 390 });
  await expect(viewer.getByRole('button', { name: 'Close image' })).toBeInViewport();
  await expect(viewer.getByRole('button', { name: 'Fit image' })).toBeInViewport();
  await viewport.focus();
  await page.keyboard.press('0');
  await expect(viewer.getByRole('button', { name: 'Fit image' })).toHaveText('100%');
  for (let i = 0; i < 7; i++) await page.keyboard.press('+');
  await expect(viewer.getByRole('button', { name: 'Zoom in' })).toBeDisabled();
  await expect(viewer.getByRole('button', { name: 'Fit image' })).toHaveText('800%');
  await page.keyboard.press('Escape');
  await expect(viewer).toHaveCount(0);
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Open original: barcode.png' }).click();
  await expect(image).toBeVisible();
  await expect(viewer.getByRole('button', { name: 'Fit image' })).toHaveText('100%');
  await expect(viewer.getByRole('button', { name: 'Close image' })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(viewer.getByRole('button', { name: 'Zoom in' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(viewer.getByRole('button', { name: 'Close image' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(viewport).toBeFocused();
});
