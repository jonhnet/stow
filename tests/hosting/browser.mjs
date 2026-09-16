import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

const origin = process.env.STOW_TEST_ORIGIN;
const password = process.env.STOW_TEST_PASSWORD;
const phase = process.env.STOW_TEST_PHASE;
assert(origin && password && ['seed', 'recover'].includes(phase));

// This disposable container has its own browser trust store. No certificate
// bypass flags are used, and the host's trust stores are never modified.
mkdirSync('/root/.pki/nssdb', { recursive: true });
execFileSync('certutil', ['-N', '--empty-password', '-d', 'sql:/root/.pki/nssdb']);
execFileSync('certutil', ['-A', '-n', 'Stow home test CA', '-t', 'C,,', '-i', '/stow-ca.crt', '-d', 'sql:/root/.pki/nssdb']);

const context = await chromium.launchPersistentContext('/profile', {
  executablePath: '/usr/bin/chromium', headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
  viewport: { width: 390, height: 844 },
});
context.setDefaultTimeout(15000);
const page = await context.newPage();
const failures = [];
page.on('pageerror', error => failures.push(error.message));
page.on('console', message => { if (message.type() === 'error') console.error(message.text()); });
page.on('requestfailed', request => console.error('Request failed:', request.url(), request.failure()?.errorText));
page.on('response', response => { if (response.status() >= 400) console.error('HTTP failure:', response.status(), response.url()); });

async function waitFor(check, message) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(message);
}
async function connected() {
  await waitFor(() => page.locator('.sync-state').getAttribute('title').then(value => value === 'Connected'), 'WebSocket sync did not connect through HTTPS');
}
const note = () => page.getByRole('article', { name: 'Open note: Home setup test', exact: true });
async function edit(value) {
  await note().getByRole('heading', { name: 'Home setup test', exact: true }).click();
  const field = page.getByRole('textbox', { name: 'Note text', exact: true });
  await field.focus();
  await field.fill(value);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
}

try {
  if (phase === 'recover') await context.setOffline(true);
  await page.goto(origin);
  assert.equal(await page.evaluate(() => isSecureContext && !!crypto.subtle), true);
  if (phase === 'seed') {
    await page.getByLabel('Server password', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await connected();
    assert((await context.cookies()).some(cookie => cookie.secure && cookie.httpOnly));
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.getByRole('button', { name: 'Take a note…', exact: true }).click();
    await page.getByRole('textbox', { name: 'Note title', exact: true }).fill('Home setup test');
    const field = page.getByRole('textbox', { name: 'Note text', exact: true });
    await field.focus();
    await field.fill('Saved before update');
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    // A fresh browser replica proves that this edit reached the actual server.
    const peer = await context.browser().newContext();
    const other = await peer.newPage();
    await other.goto(origin);
    await other.getByLabel('Server password', { exact: true }).fill(password);
    await other.getByRole('button', { name: 'Sign in', exact: true }).click();
    await other.getByRole('article', { name: 'Open note: Home setup test', exact: true }).waitFor();
    await peer.close();
    await context.setOffline(true);
    await edit('Offline edit survives the server update');
    await page.reload();
    await waitFor(() => note().textContent().then(value => value.includes('Offline edit survives')), 'Offline edit was lost on reload');
  } else {
    await waitFor(() => note().textContent().then(value => value.includes('Offline edit survives')), 'Offline startup lost the pending edit');
    await context.setOffline(false);
    await connected();
    const imported = page.getByRole('article', { name: 'Open note: Imported Keep note', exact: true });
    await imported.waitFor();
    assert.equal(await imported.count(), 1);
    assert((await imported.textContent()).includes('Takeout body with *literal stars* and 日本語'));
    assert((await imported.textContent()).includes('From Keep'));
    await waitFor(() => imported.locator('img').evaluateAll(images => images.length === 1 && images.every(image => image.complete && image.naturalWidth > 0)), 'Imported image thumbnail did not load');
    const checklist = page.getByRole('article', { name: 'Open note: Imported Keep checklist', exact: true });
    assert.equal(await checklist.count(), 1);
    assert((await checklist.textContent()).includes('Buy milk'));
    const peer = await context.browser().newContext();
    const other = await peer.newPage();
    await other.goto(origin);
    await other.getByLabel('Server password', { exact: true }).fill(password);
    await other.getByRole('button', { name: 'Sign in', exact: true }).click();
    await waitFor(() => other.getByRole('article', { name: 'Open note: Home setup test', exact: true }).textContent().then(value => value.includes('Offline edit survives')), 'Pending edit did not sync after the server update');
    await peer.close();
  }
  assert.deepEqual(failures, []);
  console.log(`Home browser ${phase} passed with a trusted local CA and no TLS exceptions.`);
} catch (error) {
  console.error('Sync status:', await page.locator('.sync-state').getAttribute('title').catch(() => 'unavailable'));
  console.error('Page errors:', failures);
  throw error;
} finally {
  await context.close();
}
