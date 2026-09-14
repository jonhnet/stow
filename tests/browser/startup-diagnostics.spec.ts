import { test, expect } from '@playwright/test';

test('invalid browser resource timings do not discard the startup report', async ({ page }) => {
  await page.addInitScript(() => {
    const entries = performance.getEntriesByType.bind(performance);
    performance.getEntriesByType = type => {
      const result = entries(type);
      if (type !== 'resource') return result;
      // Chrome has emitted negative durations for cached persistence workers.
      return [...result, {
        name: location.origin + '/assets/timing-fixture.js', startTime: 17, duration: -3,
        requestStart: NaN, responseStart: Infinity, responseEnd: 14,
        transferSize: 0, encodedBodySize: Number.MAX_SAFE_INTEGER + 1, decodedBodySize: 20,
        serverTiming: [{ name: 'session', duration: -2 }],
      } as unknown as PerformanceEntry];
    };
  });
  const uploaded = page.waitForResponse(response => response.url().endsWith('/api/diagnostics/startup') &&
    response.request().method() === 'POST' && response.request().postDataJSON().reason === 'ready');
  await page.goto('/?startup-profile=1');
  const response = await uploaded;
  expect(response.status()).toBe(201);
  const resource = response.request().postDataJSON().resources.find((entry: { name: string }) => entry.name === '/assets/timing-fixture.js');
  expect(resource).toEqual({ name: '/assets/timing-fixture.js', startTime: 17, responseEnd: 14, transferSize: 0, decodedBodySize: 20 });
  await expect(page.locator('.sync-state')).toHaveClass(/sync-online/);
});

test('a reload reports the real session delay and local startup checkpoints', async ({ page }) => {
  await page.goto('/?startup-profile=1');
  await expect(page.locator('.app')).toBeVisible();
  await expect(page.locator('.sync-state')).toHaveClass(/sync-online/);
  await page.route('**/api/session', async route => {
    await new Promise(resolve => setTimeout(resolve, 500));
    await route.continue();
  });
  const started = Date.now();
  const uploaded = page.waitForResponse(response => {
    if (!response.url().endsWith('/api/diagnostics/startup') || response.request().method() !== 'POST') return false;
    const report = response.request().postDataJSON();
    return report.reason === 'ready' && report.startedAt >= started - 10;
  });
  await page.reload();
  await expect(page.locator('.app')).toBeVisible();
  expect((await uploaded).status()).toBe(201);
  const result = await page.evaluate(async () => {
    const session = await (await fetch('/api/session')).json();
    return (await fetch('/api/diagnostics/startup', { headers: { 'X-Stow-Vault': session.vaultId } })).json();
  });
  const report = result.reports.filter((entry: { startedAt: number }) => entry.startedAt >= started - 10).at(-1);
  expect(report).toBeTruthy();
  expect(report.reason).toBe('ready');
  const marks = Object.fromEntries(report.marks.map((entry: { name: string; at: number }) => [entry.name, entry.at]));
  expect(marks['spinner-dom']).toBeGreaterThan(0);
  expect(marks['session-response'] - marks['session-start']).toBeGreaterThanOrEqual(450);
  expect(marks['account-verified']).toBeGreaterThanOrEqual(marks['session-response']);
  expect(marks['idb-open-start']).toBeGreaterThanOrEqual(marks['account-verified']);
  expect(marks['idb-read-end']).toBeGreaterThanOrEqual(marks['idb-open-start']);
  expect(marks['notes-frame']).toBeGreaterThanOrEqual(marks['account-opened']);
  expect(report.counters.updateCount).toBeGreaterThanOrEqual(0);
  expect(report.resources.some((entry: { name: string }) => entry.name === '/api/session')).toBe(true);
});
