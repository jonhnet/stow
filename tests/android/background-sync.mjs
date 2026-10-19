// Run against an isolated emulator and the disposable browser-test server.
// See README.md here. Never point this script at a personal device or vault.
import { chromium, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { writeFileSync } from 'node:fs';

const { values } = parseArgs({ options: {
  serial: { type: 'string' }, cdp: { type: 'string', default: 'http://localhost:9223' },
  port: { type: 'string', default: '4173' },
  'observe-seconds': { type: 'string', default: '0' }, output: { type: 'string' },
} });
if (!values.serial?.startsWith('emulator-')) throw new Error('--serial must name an isolated Android emulator.');
const observeSeconds = Number(values['observe-seconds']);
if (!Number.isFinite(observeSeconds) || observeSeconds < 0) throw new Error('Invalid observation duration.');
const adb = (...args) => execFileSync('adb', ['-s', values.serial, ...args], { encoding: 'utf8' }).trim();
const port = Number(values.port);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid test server port.');
const origin = `http://localhost:${port}`, tag = 'stow-notes';
const report = { mode: observeSeconds ? 'natural-scheduling' : 'forced-event', startedAt: new Date().toISOString(), events: [] };
function record(event, details = {}) {
  const entry = { at: new Date().toISOString(), event, ...details };
  report.events.push(entry); console.log(JSON.stringify(entry));
  if (values.output) writeFileSync(values.output, JSON.stringify(report, null, 2) + '\n');
}
function network(online) {
  adb('shell', 'svc', 'wifi', online ? 'enable' : 'disable');
  adb('shell', 'svc', 'data', online ? 'enable' : 'disable');
  // ADB reverse would otherwise bypass the disabled Android radios.
  if (online) adb('reverse', `tcp:${port}`, `tcp:${port}`);
  else adb('reverse', '--remove', `tcp:${port}`);
  // Removing reverse stops new tunnels but existing keep-alive connections can
  // survive it. Block only this test port inside the isolated rooted emulator.
  for (const command of ['iptables', 'ip6tables']) {
    const rule = ['OUTPUT', '-p', 'tcp', '--dport', String(port), '-m', 'comment', '--comment', 'stow-offline-test', '-j', 'REJECT', '--reject-with', 'tcp-reset'];
    if (!online) adb('shell', command, '-I', ...rule);
    else {
      const exists = execFileSync('adb', ['-s', values.serial, 'shell', `${command} -C ${rule.join(' ')} >/dev/null 2>&1; echo $?`], { encoding: 'utf8' }).trim() === '0';
      if (exists) adb('shell', command, '-D', ...rule);
    }
  }
  record(online ? 'network-enabled' : 'network-disabled');
}
async function readResult(page, vaultId) {
  return page.evaluate(async vaultId => {
    const db = await new Promise((resolve, reject) => {
      const r = indexedDB.open('stow-background-v1'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
    });
    try { return await new Promise((resolve, reject) => {
      const r = db.transaction('results').objectStore('results').get(vaultId);
      r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
    }); } finally { db.close(); }
  }, vaultId);
}

network(true);
let android = await chromium.connectOverCDP(values.cdp);
const writer = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
try {
  const context = android.contexts()[0];
  const page = context.pages().find(p => p.url().startsWith(origin)) ?? await context.newPage();
  const control = await context.newPage();
  const cdp = await context.newCDPSession(control);
  const registrations = new Map();
  cdp.on('ServiceWorker.workerRegistrationUpdated', ({ registrations: rows }) => rows.forEach(row => registrations.set(row.scopeURL, row.registrationId)));
  await cdp.send('ServiceWorker.enable');
  // Regression mode overrides only eligibility, not the worker or its network/storage.
  // Observation mode must use the real installed-app permission and scheduler.
  if (!observeSeconds) await cdp.send('Browser.setPermission', { origin, permission: { name: 'periodic-background-sync' }, setting: 'granted' });
  else await cdp.send('Browser.resetPermissions');
  await page.goto(origin);
  await expect(page.locator('.sync-state')).toHaveAttribute('title', 'Connected');
  await page.evaluate(() => navigator.serviceWorker.ready);
  const account = await page.evaluate(() => JSON.parse(localStorage.getItem('stow-account-v1')));
  const permission = await page.evaluate(() => navigator.permissions.query({ name: 'periodic-background-sync' }).then(p => p.state));
  record('browser', { version: android.version(), permission });
  if (permission !== 'granted') throw new Error('Install Stow, launch it from its home-screen icon, and interact with it before observing natural scheduling.');
  await expect.poll(() => page.evaluate(async () => (await navigator.serviceWorker.ready).periodicSync.getTags())).toContain(tag);
  const before = await readResult(page, account.vaultId);
  for (const client of context.pages()) if (client.url().startsWith(origin)) await client.close();
  record('all-stow-windows-closed');
  const remote = await writer.newPage(); await remote.goto(origin);
  await expect(remote.locator('.sync-state')).toHaveAttribute('title', 'Connected');
  const title = `Android flight plan ${Date.now()}`;
  await remote.getByRole('button', { name: 'Take a note…', exact: true }).click();
  await remote.getByRole('textbox', { name: 'Note title', exact: true }).fill(title);
  await remote.getByRole('textbox', { name: 'Note text', exact: true }).focus();
  await remote.getByRole('textbox', { name: 'Note text', exact: true }).fill('Background arrival before departure');
  await remote.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(remote.locator('.sync-state')).toHaveAttribute('title', 'Connected');
  const started = Date.now();
  if (observeSeconds) {
    // Disconnect DevTools too: it can extend worker lifetimes. Do not change
    // Chrome's scheduling intervals, engagement scores or Android job deadlines.
    await android.close(); android = undefined;
    network(false); await new Promise(r => setTimeout(r, 5000)); network(true);
    record('observation-started', { seconds: observeSeconds });
    await new Promise(r => setTimeout(r, observeSeconds * 1000));
    network(false);
    android = await chromium.connectOverCDP(values.cdp);
  } else {
    // Closing a standalone Android activity can leave Chrome itself suspended.
    // Keep only a blank Chrome control tab foreground for deterministic CDP
    // dispatch. There is still no Stow document to perform foreground syncing.
    const browserPackage = (await (await fetch(`${values.cdp}/json/version`)).json())['Android-Package'];
    if (typeof browserPackage !== 'string') throw new Error('Expected an Android browser debugging endpoint.');
    adb('shell', 'am', 'start', '-n', `${browserPackage}/com.google.android.apps.chrome.Main`, '-d', 'about:blank');
    expect(context.pages().some(p => p.url().startsWith(origin))).toBe(false);
    await cdp.send('ServiceWorker.stopAllWorkers');
    await cdp.send('ServiceWorker.dispatchPeriodicSyncEvent', { origin, registrationId: registrations.get(`${origin}/`), tag });
    record('periodic-event-dispatched');
    await expect.poll(async () => {
      const worker = context.serviceWorkers().find(w => w.url() === `${origin}/sw.js`);
      return worker && (await readResult(worker, account.vaultId))?.completedAt;
    }).toBeGreaterThanOrEqual(started);
    network(false);
  }
  const offline = await android.contexts()[0].newPage(); await offline.goto(origin);
  await expect(offline.locator('.sync-state')).toHaveAttribute('title', 'Offline — notes stored on this device');
  expect(await offline.evaluate(() => fetch('/api/session').then(() => true, () => false))).toBe(false);
  const outcome = await readResult(offline, account.vaultId);
  const refreshed = (outcome?.completedAt ?? 0) >= started;
  record('offline-result', { before, outcome, refreshed });
  if (!observeSeconds || refreshed) await expect(offline.getByRole('article', { name: `Open note: ${title}`, exact: true })).toContainText('Background arrival before departure');
  else record('no-natural-wake-observed', { seconds: observeSeconds });
  record('passed');
} finally {
  network(true);
  await android?.close(); await writer.close();
}
