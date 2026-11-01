import { test, expect } from '@playwright/test';

const origin = 'http://localhost:4174';
const title = 'Available without a check-in';

test.beforeEach(async ({ page, context }, info) => {
  await context.addCookies([{ name: 'stow_test_user', value: `cached-start-${info.testId}`, url: origin }]);
  await page.goto(origin);
  await expect(page.locator('.sync-state')).toHaveAttribute('title', 'Connected');
  await page.getByRole('button', { name: 'Take a note…', exact: true }).click();
  await page.getByRole('textbox', { name: 'Note title', exact: true }).fill(title);
  const body = page.getByRole('textbox', { name: 'Note text', exact: true });
  await body.focus(); await body.fill('Already saved on this device');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.locator('.sync-state')).toHaveAttribute('title', 'Connected');
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
});

for (const identity of ['same', 'different']) test(`cached notes open and save before a delayed ${identity}-account verification`, async ({ page, context }, info) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let requests = 0, sockets = 0;
  page.on('websocket', () => sockets++);
  await page.route('**/api/session', async route => { requests++; await gate; await route.continue(); });
  try {
    await page.reload({ waitUntil: 'domcontentloaded' });
    const card = page.getByRole('article', { name: `Open note: ${title}`, exact: true });
    await expect(card).toBeVisible({ timeout: 2000 });
    await card.click();
    const body = page.getByRole('textbox', { name: 'Note text', exact: true });
    await body.focus(); await body.fill('Written before the server answered');
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(card).toContainText('Written before the server answered');
    expect(requests).toBeGreaterThan(0);
    expect(sockets).toBe(0);
    if (identity === 'different') {
      await context.addCookies([{ name: 'stow_test_user', value: `other-${info.testId}`, url: origin }]);
    }
    release();
    if (identity === 'same') {
      await expect(page.locator('.sync-state')).toHaveAttribute('title', 'Connected');
      await page.reload();
      await expect(card).toContainText('Written before the server answered');
    } else {
      await expect(page.getByText(/signed-in account changed/)).toBeVisible();
      expect(sockets).toBe(0);
      await page.reload();
      await expect(page.locator('.sync-state')).toHaveAttribute('title', 'Connected');
      await expect(card).toHaveCount(0);
    }
  } finally { release(); }
});

test('a cached application shell opens without waiting for navigation fetch', async ({ page, context }) => {
  const worker = context.serviceWorkers().find(worker => worker.url() === `${origin}/sw.js`)!;
  // Hold only the worker's network navigation request. Cached responses, API
  // calls, and actual application/IndexedDB code all run normally.
  await worker.evaluate(() => {
    const network = globalThis.fetch.bind(globalThis);
    globalThis.fetch = (input, init) => input instanceof Request && input.mode === 'navigate'
      ? new Promise<Response>(() => {}) : network(input, init);
  });
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 2000 });
  await expect(page.getByRole('article', { name: `Open note: ${title}`, exact: true })).toBeVisible({ timeout: 2000 });
});

test('an explicit client update fetches a fresh shell and preserves navigation state', async ({ page, context }) => {
  const worker = context.serviceWorkers().find(worker => worker.url() === `${origin}/sw.js`)!;
  await worker.evaluate(() => {
    const network = globalThis.fetch.bind(globalThis);
    globalThis.fetch = async (input, init) => {
      const response = await network(input, init);
      if (!(input instanceof Request) || input.mode !== 'navigate') return response;
      const html = (await response.text()).replace('<head>', '<head><meta name="fresh-shell-test" content="network">');
      return new Response(html, { headers: { 'Content-Type': 'text/html' } });
    };
  });
  await page.evaluate(() => {
    const url = new URL(location.href); url.searchParams.set('stow-update', '1');
    history.replaceState({ ...history.state, updateTest: 'preserved' }, '', url);
  });
  await page.reload();
  await expect(page.locator('meta[name="fresh-shell-test"]')).toHaveAttribute('content', 'network');
  expect(await page.evaluate(() => history.state.updateTest)).toBe('preserved');
  expect(new URL(page.url()).searchParams.has('stow-update')).toBe(false);
  await expect(page.getByRole('article', { name: `Open note: ${title}`, exact: true })).toBeVisible();
});

test('the cached shell does not intercept a same-origin authentication page', async ({ page }) => {
  await page.route('**/authentication/sign-in', route => route.fulfill({ contentType: 'text/html', body: '<h1>Authentication page</h1>' }));
  await page.goto(`${origin}/authentication/sign-in`);
  await expect(page.getByRole('heading', { name: 'Authentication page' })).toBeVisible();
});
