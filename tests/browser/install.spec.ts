import { test, expect, type Page } from '@playwright/test';

type InstallHarness = {
  requests: number;
  activated: boolean;
  prevented: boolean;
  offer(fail?: boolean): void;
  finish(outcome: 'accepted' | 'dismissed'): void;
  browserMode(value: boolean): void;
};
declare global { interface Window { installTest: InstallHarness } }

async function mockInstall(page: Page, early = false, standalone = false) {
  await page.addInitScript(({ early, standalone }) => {
    // Native install UI cannot be driven in headless Chromium. Model only its
    // event contract; all Stow UI, entry-point loading and click handling are real.
    window.addEventListener('beforeinstallprompt', event => {
      if (event.isTrusted) { event.preventDefault(); event.stopImmediatePropagation(); }
    });
    const matchMedia = window.matchMedia.bind(window);
    const media = matchMedia('(display-mode: browser)');
    let browser = !standalone;
    Object.defineProperty(media, 'matches', { get: () => browser });
    window.matchMedia = query => query === media.media ? media : matchMedia(query);
    let finish: (value: { outcome: 'accepted' | 'dismissed' }) => void;
    const harness: InstallHarness = window.installTest = {
      requests: 0, activated: false, prevented: false,
      offer(fail = false) {
        const event = new Event('beforeinstallprompt', { cancelable: true });
        Object.assign(event, { prompt() {
          harness.requests++;
          harness.activated = navigator.userActivation.isActive;
          if (fail) return Promise.reject(new Error('Browser refused the prompt'));
          return new Promise(resolve => { finish = resolve; });
        } });
        window.dispatchEvent(event);
        harness.prevented = event.defaultPrevented;
      },
      finish(outcome) { finish({ outcome }); },
      browserMode(value) { browser = value; media.dispatchEvent(new Event('change')); },
    };
    if (early) {
      // Deliver an offer as soon as the entry point installs its listener,
      // before the lazy App import or any React Settings component can mount.
      const add = window.addEventListener;
      window.addEventListener = function (this: Window, ...args: Parameters<typeof add>) {
        add.apply(this, args);
        if (args[0] === 'beforeinstallprompt') {
          window.addEventListener = add;
          harness.offer();
        }
      } as typeof add;
    }
  }, { early, standalone });
}
async function settings(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  return page.getByRole('button', { name: 'Install Stow', exact: true });
}
test.beforeEach(async ({ page, context }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await context.addCookies([{ name: 'stow_test_user', value: `install-${info.testId}@example.test`, url: 'http://localhost:4174' }]);
});

test('an early install offer survives lazy loading and opens only from the Settings action', async ({ page }) => {
  await mockInstall(page, true);
  await page.goto('http://localhost:4174');
  const install = await settings(page);
  await expect(install).toBeVisible();
  expect(await page.evaluate(() => window.installTest.requests)).toBe(0);
  expect(await page.evaluate(() => window.installTest.prevented)).toBe(true);
  const bounds = (await install.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
  await install.click();
  expect(await page.evaluate(() => window.installTest.requests)).toBe(1);
  expect(await page.evaluate(() => window.installTest.activated)).toBe(true);
  await expect(await settings(page)).toHaveCount(0);
  // Dismissal consumes this offer. Only a fresh browser offer permits retry.
  await page.evaluate(() => window.installTest.finish('dismissed'));
  await expect(install).toHaveCount(0);
  await page.evaluate(() => window.installTest.offer());
  await expect(install).toBeVisible();
  await install.click();
  expect(await page.evaluate(() => window.installTest.requests)).toBe(2);
  await page.evaluate(() => {
    window.installTest.finish('accepted');
    window.dispatchEvent(new Event('appinstalled'));
  });
  await expect(await settings(page)).toHaveCount(0);
});

test('Settings waits for browser eligibility and clears an offer installed through browser UI', async ({ page }) => {
  await mockInstall(page);
  await page.goto('http://localhost:4174');
  const install = await settings(page);
  await expect(install).toHaveCount(0);
  await page.evaluate(() => window.installTest.offer());
  await expect(install).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('appinstalled')));
  await expect(install).toHaveCount(0);
  expect(await page.evaluate(() => window.installTest.requests)).toBe(0);
});

test('an installed window never offers installation, including after a display-mode change', async ({ page }) => {
  await mockInstall(page, true, true);
  await page.goto('http://localhost:4174');
  const install = await settings(page);
  await expect(install).toHaveCount(0);
  await page.evaluate(() => { window.installTest.browserMode(true); window.installTest.offer(); });
  await expect(install).toBeVisible();
  await page.evaluate(() => window.installTest.browserMode(false));
  await expect(install).toHaveCount(0);
  await page.evaluate(() => window.installTest.browserMode(true));
  await expect(install).toHaveCount(0);
});

test('a failed browser prompt reports the problem without reusing the consumed offer', async ({ page }) => {
  await mockInstall(page);
  await page.goto('http://localhost:4174');
  await page.evaluate(() => window.installTest.offer(true));
  await (await settings(page)).click();
  await expect(page.getByText('Could not open the install prompt. Try installing Stow from your browser menu.', { exact: true })).toBeVisible();
  await expect(await settings(page)).toHaveCount(0);
  expect(await page.evaluate(() => window.installTest.requests)).toBe(1);
});

test('the production manifest has usable Android icons and caches them for offline launch', async ({ playwright }, info) => {
  // Playwright's default contexts are incognito, which Chrome cannot install
  // from. A disposable ordinary profile exercises real installability checks.
  const context = await playwright.chromium.launchPersistentContext(info.outputPath('profile'), {
    ...info.project.use.launchOptions, viewport: { width: 390, height: 844 },
  });
  try {
    const page = context.pages()[0];
    await page.goto('http://localhost:4173');
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    const manifest = await page.evaluate(async () => {
      const link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]')!;
      return (await fetch(link.href)).json();
    });
    expect(manifest.display).toBe('standalone');
    for (const size of [192, 512]) {
      expect(manifest.icons).toContainEqual(expect.objectContaining({ sizes: `${size}x${size}`, type: 'image/png', purpose: 'any' }));
    }
    expect(manifest.icons).toContainEqual(expect.objectContaining({ type: 'image/png', purpose: 'maskable' }));
    const devtools = await context.newCDPSession(page);
    // Exercise Chrome's real manifest/icon checks independently of the mocked UI.
    await expect.poll(async () => (await devtools.send('Page.getInstallabilityErrors')).installabilityErrors).toEqual([]);
    await context.setOffline(true);
    for (const icon of manifest.icons.filter((icon: { type: string }) => icon.type === 'image/png')) {
      const result = await page.evaluate(async (url: string) => {
        const response = await fetch(url);
        const bitmap = await createImageBitmap(await response.blob());
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width; canvas.height = bitmap.height;
        const ctx = canvas.getContext('2d')!; ctx.drawImage(bitmap, 0, 0);
        const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let opaque = true, safeMark = true, markPixels = 0;
        for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
          const offset = (y * canvas.width + x) * 4;
          if (pixels[offset + 3] !== 255) opaque = false;
          // White strokes must survive every Android launcher mask's safe circle.
          if (pixels[offset] > 230 && pixels[offset + 1] > 230 && pixels[offset + 2] > 230 && pixels[offset + 3] > 200) {
            markPixels++;
            if (Math.hypot(x - canvas.width / 2, y - canvas.height / 2) > canvas.width * .4) safeMark = false;
          }
        }
        const result = { ok: response.ok, width: bitmap.width, height: bitmap.height, opaque, safeMark, markPixels };
        bitmap.close(); return result;
      }, icon.src);
      expect(result.ok).toBe(true);
      expect(`${result.width}x${result.height}`).toBe(icon.sizes);
      expect(result.markPixels).toBeGreaterThan(0);
      if (icon.purpose === 'maskable') { expect(result.opaque).toBe(true); expect(result.safeMark).toBe(true); }
    }
    await page.reload();
    await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
  } finally { await context.close(); }
});
