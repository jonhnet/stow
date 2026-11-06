// Disposable Android shell regression. No production hosts, accounts, or devices.
import { chromium, expect, _android } from '@playwright/test';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import path from 'node:path';
import sharp from 'sharp';
import { faultProxy } from './proxy.mjs';

const { values } = parseArgs({ options: { serial: { type: 'string', default: 'emulator-5580' }, observe: { type: 'string', default: '0' } } });
if (!/^emulator-\d+$/.test(values.serial)) throw new Error('Use an isolated emulator.');
const pkg = 'net.stowapp.android';
const build = path.resolve('../build/android-shell'); mkdirSync(build, { recursive: true });
const trial = mkdtempSync(path.join(build, 'trial-')); cpSync('../build/dist', path.join(trial, 'web'), { recursive: true });
const report = { startedAt: new Date().toISOString(), events: [] };
const record = (event, detail = {}) => { const item = { at: new Date().toISOString(), event, ...detail }; report.events.push(item); console.log(JSON.stringify(item)); writeFileSync(path.join(trial, 'result.json'), JSON.stringify(report, null, 2)); };
const adb = (...args) => execFileSync('adb', ['-s', values.serial, ...args], { encoding: 'utf8', timeout: 30000 }).trim();
const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
const control = (command, extras = {}) => adb('shell', `am broadcast -n ${pkg}/.EmulatorControl --es command ${quote(command)} ${Object.entries(extras).map(([k, v]) => `--es ${k} ${quote(v)}`).join(' ')}`);
const workState = () => { control('inspect'); return JSON.parse(adb('shell', `run-as ${pkg} cat files/emulator-work.json`)); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const server = spawn('../build/cargo-target/debug/stow-test-driver', ['serve'], { stdio: ['pipe', 'pipe', 'inherit'] });
server.stdin.write(JSON.stringify({ host: '127.0.0.1', port: 0, dataDir: path.join(trial, 'data'), staticDir: path.join(trial, 'web'), password: '', authMode: 'password' }) + '\n');
const lines = createInterface({ input: server.stdout });
const address = await new Promise((resolve, reject) => { lines.once('line', line => resolve(JSON.parse(line))); server.once('exit', code => reject(new Error(`Server exited ${code}`))); });
// Use the forwarded loopback address directly: Android can cache a failed
// localhost lookup while its radios are off, even after the forwarding returns.
const port = 4276; const proxy = await faultProxy(port, address.port); const origin = `http://127.0.0.1:${port}`;

function network(online) {
  adb('shell', 'svc', 'wifi', online ? 'enable' : 'disable'); adb('shell', 'svc', 'data', online ? 'enable' : 'disable');
  if (online) adb('reverse', `tcp:${port}`, `tcp:${port}`); else adb('reverse', '--remove', `tcp:${port}`);
  for (const command of ['iptables', 'ip6tables']) {
    const rule = `OUTPUT -p tcp --dport ${port} -m comment --comment stow-shell-test -j REJECT --reject-with tcp-reset`;
    if (!online) adb('shell', `${command} -w 5 -I ${rule}`);
    else adb('shell', `if ${command} -w 5 -C ${rule} 2>/dev/null; then ${command} -w 5 -D ${rule}; fi`);
  }
  record(online ? 'network-online' : 'network-offline');
}
    async function nativeButton(label) {
      let hit;
      await expect.poll(() => {
        adb('shell', 'uiautomator', 'dump', '/sdcard/stow-test-window.xml');
        const xml = adb('shell', 'cat', '/sdcard/stow-test-window.xml');
        const nodes = xml.match(/<node[^>]+>/g) ?? [];
        hit = nodes.find(node => node.includes(`text="${label}"`) || node.includes(`text="${label.toUpperCase()}"`) || node.includes(`content-desc="${label}"`) || node.includes(`content-desc="${label}, `));
        return !!hit;
      }, { timeout: 20000 }).toBeTruthy();
      const bounds = hit.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/).slice(1).map(Number);
      adb('shell', 'input', 'tap', String(Math.floor((bounds[0] + bounds[2]) / 2)), String(Math.floor((bounds[1] + bounds[3]) / 2)));
    }
let remote, android;
// These Google companion apps launch Play-services repair activities or
// notifications after reboot, stealing real touch events. Disable them along
// with Play services in this isolated test; restore their original state below.
const disabledPackages = ['com.google.android.gms', 'com.google.android.googlequicksearchbox', 'com.google.android.apps.messaging', 'com.google.android.apps.wellbeing']
  .filter(name => adb('shell', 'pm', 'list', 'packages', '-e', name).includes(`package:${name}`));
async function attach() {
  android = (await _android.devices({ omitDriverInstall: true })).find(device => device.serial() === values.serial);
  if (!android) throw new Error('Emulator is not available to Playwright.');
  const view = await android.webView({ pkg }, { timeout: 30000 });
  const initial = await view.page();
  const context = initial.context();
  const foreground = () => context.pages().find(page => page.url().endsWith('/index.html'));
  await expect.poll(() => !!foreground(), { timeout: 30000 }).toBeTruthy();
  return foreground();
}
async function addNote(page, title) {
  await page.getByRole('button', { name: 'Take a note…', exact: true }).click();
  await page.getByRole('textbox', { name: 'Note title', exact: true }).fill(title);
  await page.getByRole('textbox', { name: 'Note text', exact: true }).click();
  await page.getByRole('textbox', { name: 'Note text', exact: true }).fill('Available offline after a closed-app refresh.');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.locator('.sync-state')).toHaveAttribute('title', 'Connected');
}
try {
  adb('wait-for-device');
  adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'); adb('shell', 'wm', 'dismiss-keyguard');
  network(true);
  adb('shell', 'settings', 'put', 'secure', 'show_ime_with_hard_keyboard', '1');
  for (const name of disabledPackages) adb('shell', 'pm', 'disable-user', '--user', '0', name);
  record('google-play-services-disabled');
  adb('shell', 'am', 'force-stop', pkg); adb('shell', 'pm', 'clear', pkg);
  // AndroidWebView discovery polls ADB; don't attach to the terminated process.
  await sleep(1500);
  adb('shell', 'am', 'start', '-W', '-n', `${pkg}/.MainActivity`);
  adb('shell', 'uiautomator', 'dump', '/sdcard/stow-test-window.xml');
  const setupTree = adb('shell', 'cat', '/sdcard/stow-test-window.xml');
  const serverField = setupTree.match(/class="android.widget.EditText"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/).slice(1).map(Number);
  adb('shell', 'input', 'tap', String(Math.floor((serverField[0] + serverField[2]) / 2)), String(Math.floor((serverField[1] + serverField[3]) / 2)));
  adb('shell', 'input', 'text', origin);
  await nativeButton('Sign in with browser');
  await expect.poll(() => {
    adb('shell', 'uiautomator', 'dump', '/sdcard/stow-test-window.xml');
    return adb('shell', 'cat', '/sdcard/stow-test-window.xml');
  }).toContain('Pairing code:');
  const pairingCode = adb('shell', 'cat', '/sdcard/stow-test-window.xml').match(/Pairing code: ([A-F0-9]{8})/)[1];
  const registry = JSON.parse(readFileSync(path.join(trial, 'data/device-access.json'), 'utf8'));
  const requestId = Object.keys(registry.pending)[0];
  await nativeButton('Open sign-in page');
  await expect.poll(() => adb('shell', 'dumpsys', 'activity', 'activities').match(/topResumedActivity=.*$/m)?.[0] ?? '', { timeout: 15000 }).toMatch(/(?:com\.android\.chrome|org\.chromium\.chrome)/);
  // Approve in a real authenticated browser. The Android browser may be on its
  // first-run screen in a fresh emulator; Google browser setup is not our auth.
  remote = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const approval = await remote.newPage(); await approval.goto(origin + '/device.html?request=' + requestId);
  await approval.getByLabel('Pairing code').fill(pairingCode);
  await approval.getByRole('button', { name: 'Connect device' }).click();
  await expect(approval.getByText('Device connected. Return to the Android app.')).toBeVisible();
  await approval.close();
  const grant = { account: await (await fetch(origin + '/api/session')).json() };
  adb('shell', 'am', 'start', '-W', '-n', `${pkg}/.MainActivity`);
  let page = await attach();
  page.on('console', message => { if (message.type() === 'error') console.log('WEB', message.text()); });
  await expect(page.locator('.sync-state')).toHaveAttribute('title', 'Connected', { timeout: 45000 });
  record('paired-and-opened', { webview: await page.evaluate(() => navigator.userAgent) });
  const writer = await remote.newPage(); await writer.goto(origin); await expect(writer.locator('.sync-state')).toHaveAttribute('title', 'Connected');
  await addNote(writer, 'Initial cached note'); await expect(page.getByRole('article', { name: 'Open note: Initial cached note' })).toBeVisible();
  await android.close(); android = undefined;
  adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
  adb('shell', `kill -9 $(pidof ${pkg})`);
  record('activity-closed-process-killed');
  await addNote(writer, 'Flight plan from desktop');
  const before = Date.now();
  const diagnostics = async () => {
    const response = await fetch(origin + '/api/diagnostics/background', { headers: { 'X-Stow-Vault': grant.account.vaultId } });
    expect(response.ok).toBeTruthy(); return response.json();
  };
  const seen = new Set((await diagnostics()).devices.flatMap(device => device.events.filter(event => event.kind === 'success').map(event => event.runId)));
  control('refresh');
  await expect.poll(async () => (await diagnostics()).devices.some(device => device.browser.includes('StowAndroid') && device.events.some(event => event.kind === 'success' && !seen.has(event.runId))), { timeout: 120000, intervals: [1000] }).toBeTruthy();
  const initialDiagnostics = await diagnostics();
  const nativeEvents = initialDiagnostics.devices.filter(device => device.browser.includes('StowAndroid')).flatMap(device => device.events.filter(event => event.kind === 'native'));
  expect(nativeEvents.some(event => event.trigger === 'network' && event.shellVersion === 1 && /^[a-f0-9]{40}$/.test(event.build))).toBe(true);
  expect(nativeEvents.some(event => event.trigger === 'emulator-request' && event.shellVersion === 1)).toBe(true);
  writeFileSync(path.join(trial, 'diagnostics.json'), JSON.stringify(initialDiagnostics, null, 2));
  record('closed-app-refresh-durable', { elapsedMs: Date.now() - before });
  network(false);
  adb('shell', `kill -9 $(pidof ${pkg})`);
  const opened = Date.now(); adb('shell', 'am', 'start', '-W', '-n', `${pkg}/.MainActivity`);
  page = await attach();
  await expect(page.getByRole('article', { name: 'Open note: Flight plan from desktop' })).toBeVisible({ timeout: 10000 });
  expect(await page.evaluate(async () => { try { await fetch('/native/api/session', { signal: AbortSignal.timeout(1000) }); return true; } catch { return false; } })).toBe(false);
  record('flight-plan-readable-offline', { launchAndAttachMs: Date.now() - opened });
  if (Number(values.observe) > 0) {
    network(true);
    await android.close(); android = undefined;
    adb('shell', 'input', 'keyevent', 'KEYCODE_HOME'); adb('shell', `kill -9 $(pidof ${pkg})`);
    await addNote(writer, 'Naturally scheduled flight plan');
    const baseline = new Set((await diagnostics()).devices.flatMap(device => device.events.filter(event => event.kind === 'success').map(event => event.runId)));
    const until = Date.now() + Number(values.observe) * 1000;
    record('natural-periodic-observation-started');
    let natural = false;
    while (Date.now() < until) {
      await sleep(30000);
      const logs = await diagnostics();
      natural = logs.devices.some(device => device.browser.includes('StowAndroid') && device.events.some(event => event.kind === 'success' && !baseline.has(event.runId)));
      record('natural-periodic-observation', { completed: natural, remainingSeconds: Math.round((until - Date.now()) / 1000) });
      if (natural) { writeFileSync(path.join(trial, 'natural-diagnostics.json'), JSON.stringify(logs, null, 2)); break; }
    }
    expect(natural).toBeTruthy();
    network(false); adb('shell', `if pidof ${pkg}; then kill -9 $(pidof ${pkg}); fi`);
    adb('shell', 'am', 'start', '-W', '-n', `${pkg}/.MainActivity`); page = await attach();
    await expect(page.getByRole('article', { name: 'Open note: Naturally scheduled flight plan' })).toBeVisible();
    record('natural-periodic-note-readable-offline');
  }
  if (Number(values.observe) === 0) {
    // Keep an unuploaded local edit through two different failed background
    // transfers, then let a normal reconnect merge both sides.
    await page.getByRole('button', { name: 'Take a note…', exact: true }).click();
    await page.getByRole('textbox', { name: 'Note title', exact: true }).fill('Pending offline edit');
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(page.locator('.sync-state')).toHaveAttribute('title', 'Offline — notes stored on this device');
    await android.close(); android = undefined; adb('shell', 'input', 'keyevent', 'KEYCODE_HOME'); adb('shell', `kill -9 $(pidof ${pkg})`);
    await addNote(writer, 'Remote note after interrupted refresh');
    for (const boundary of ['session', 'sync']) {
      proxy.fault[boundary] = true; proxy.fault.hits = 0;
      network(true); control('refresh');
      await expect.poll(() => proxy.fault.hits, { timeout: 45000 }).toBeGreaterThan(0);
      network(false); control('cancel');
      proxy.fault[boundary] = false;
      adb('shell', `if pidof ${pkg}; then kill -9 $(pidof ${pkg}); fi`);
      adb('shell', 'am', 'start', '-W', '-n', `${pkg}/.MainActivity`); page = await attach();
      await expect(page.getByRole('article', { name: 'Open note: Pending offline edit' })).toBeVisible();
      await expect(page.getByRole('article', { name: 'Open note: Remote note after interrupted refresh' })).toHaveCount(0);
      record('interrupted-refresh-preserved-local-edit', { boundary });
      await android.close(); android = undefined; adb('shell', 'input', 'keyevent', 'KEYCODE_HOME'); adb('shell', `kill -9 $(pidof ${pkg})`);
    }
    // No explicit refresh here: the persisted connectivity PendingIntent must
    // wake a dead application when a network becomes available.
    const prior = new Set((await diagnostics()).devices.flatMap(d => d.events.filter(e => e.kind === 'success').map(e => e.runId)));
    network(true);
    await expect.poll(async () => (await diagnostics()).devices.some(d => d.browser.includes('StowAndroid') && d.events.some(e => e.kind === 'success' && !prior.has(e.runId))), { timeout: 120000, intervals: [1000] }).toBeTruthy();
    record('network-reconnection-woke-closed-app');
    adb('shell', 'am', 'start', '-W', '-n', `${pkg}/.MainActivity`); page = await attach();
    await expect(page.getByRole('article', { name: 'Open note: Remote note after interrupted refresh' })).toBeVisible();
    await expect(writer.getByRole('article', { name: 'Open note: Pending offline edit' })).toBeVisible({ timeout: 20000 });
    record('foreground-reconciled-pending-edit');
    // A failed periodic poll finishes its opportunity, retaining failure and
    // last-success evidence, and remains eligible at the normal next interval.
    // The test uses the production 15-minute request, not a shortened timer.
    proxy.fault.unavailable = true;
    const beforeFailure = workState().events.at(-1)?.sequence ?? 0;
    control('periodic');
    await expect.poll(() => workState().events.some(event => event.sequence > beforeFailure && event.trigger === 'periodic' && event.message.startsWith('worker refresh failed')), { timeout: 30000 }).toBe(true);
    let failedPoll;
    await expect.poll(() => {
      failedPoll = workState();
      return failedPoll.periodic.some(job => job.state === 'ENQUEUED' && job.attempt === 0 && job.nextAt > failedPoll.at);
    }).toBe(true);
    expect(failedPoll.lastSuccess).toBe(0);
    const nextPoll = failedPoll.periodic.find(job => job.state === 'ENQUEUED');
    expect(nextPoll.nextAt - failedPoll.at).toBeLessThanOrEqual(15 * 60 * 1000);
    const failedEvidence = failedPoll.events.findLast(event => event.message.startsWith('worker refresh failed'));
    const environment = JSON.parse(failedEvidence.message.split(' | state=')[1]);
    expect(environment.network.blocked).toBe(false);
    expect(environment.network.validated).toBe(true);
    proxy.fault.unavailable = false;
    record('failed-poll-retained-error-without-exponential-backoff', { nextDelayMs: nextPoll.nextAt - failedPoll.at, environment });
    // Schedule before killing the process. Starting it with a test broadcast
    // inside Doze would itself wake the app and bypass JobScheduler deferral.
    control('deferred');
    await android.close(); android = undefined; adb('shell', 'input', 'keyevent', 'KEYCODE_HOME'); adb('shell', `kill -9 $(pidof ${pkg})`);
    adb('shell', 'dumpsys', 'battery', 'unplug'); adb('shell', 'input', 'keyevent', 'KEYCODE_SLEEP');
    adb('shell', 'dumpsys', 'deviceidle', 'force-idle');
    expect(adb('shell', 'dumpsys', 'deviceidle', 'get', 'deep')).toBe('IDLE');
    const dozePrior = new Set((await diagnostics()).devices.flatMap(d => d.events.filter(e => e.kind === 'success').map(e => e.runId)));
    await addNote(writer, 'Flight plan during Doze');
    await sleep(12000);
    expect((await diagnostics()).devices.some(d => d.events.some(e => e.kind === 'success' && !dozePrior.has(e.runId)))).toBe(false);
    record('doze-deferred-refresh');
    // Advance the idle controller into a maintenance window. Do not turn on
    // the screen, start Stow, broadcast a refresh, or force a JobScheduler job.
    expect(adb('shell', 'dumpsys', 'deviceidle', 'step', 'deep')).toContain('IDLE_MAINTENANCE');
    await expect.poll(async () => (await diagnostics()).devices.some(d => d.browser.includes('StowAndroid') && d.events.some(e => e.kind === 'success' && !dozePrior.has(e.runId))), { timeout: 120000, intervals: [1000] }).toBeTruthy();
    expect(adb('shell', 'dumpsys', 'power')).toContain('mWakefulness=Asleep');
    const maintenanceEvents = workState().events;
    const savedInWindow = maintenanceEvents.findLast(event => event.message.startsWith('worker refresh saved'));
    const windowState = JSON.parse(savedInWindow.message.split(' | state=')[1]);
    expect(windowState.interactive).toBe(false);
    expect(windowState.charging).toBe(false);
    expect(windowState.idle).toBe(false); // Restrictions lifted for maintenance.
    expect(windowState.network.blocked).toBe(false);
    const reportedWindow = await diagnostics();
    const reportedNative = reportedWindow.devices.filter(device => device.browser.includes('StowAndroid')).flatMap(device => device.events.filter(event => event.kind === 'native'));
    // Opening maintenance can also release a pending network callback. Either
    // eligible job may win the worker lock; inspect the one that actually saved.
    const reportedStart = reportedNative.findLast(event => event.trigger === savedInWindow.trigger && event.nativeAt <= savedInWindow.at && event.message.startsWith('worker started'));
    expect(reportedStart, 'The maintenance worker start must reach server diagnostics').toBeTruthy();
    const reportedState = JSON.parse(reportedStart.message.split(' | state=')[1]);
    expect(reportedState.charging).toBe(false); expect(reportedState.interactive).toBe(false);
    const reportedFailure = reportedNative.findLast(event => event.trigger === 'periodic' && event.message.startsWith('worker refresh failed'));
    expect(JSON.parse(reportedFailure.message.split(' | state=')[1]).network.validated).toBe(true);
    writeFileSync(path.join(trial, 'maintenance-diagnostics.json'), JSON.stringify(reportedWindow, null, 2));
    record('screen-off-maintenance-saved-notes', { environment: windowState });
    // Disconnect before waking; merely catching up on wake cannot pass this.
    network(false); adb('shell', `kill -9 $(pidof ${pkg})`); adb('shell', 'am', 'start', '-W', '-n', `${pkg}/.MainActivity`); page = await attach();
    adb('shell', 'dumpsys', 'deviceidle', 'unforce'); adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'); adb('shell', 'wm', 'dismiss-keyguard');
    await expect(page.getByRole('article', { name: 'Open note: Flight plan during Doze' })).toBeVisible();
    record('maintenance-copy-readable-after-offline-wake');
    const original = JSON.parse(readFileSync(path.join(trial, 'web/release.json'), 'utf8'));
    const index = readFileSync(path.join(trial, 'web/index.html'), 'utf8');
    function release(number) {
      const contents = Buffer.from(index + `<!-- release test ${number} -->`);
      const manifest = structuredClone(original);
      manifest.files['/index.html'] = { bytes: contents.length, sha256: createHash('sha256').update(contents).digest('hex') };
      manifest.release = createHash('sha256').update(JSON.stringify(manifest.files)).digest('hex');
      writeFileSync(path.join(trial, 'web/index.html'), contents);
      writeFileSync(path.join(trial, 'web/release.json'), JSON.stringify(manifest)); return manifest.release;
    }
    const installed = () => JSON.parse(adb('shell', `run-as ${pkg} cat files/web-releases/installed.json`));
    const old = installed().active; const next = release(2);
    proxy.fault.assets = true; proxy.fault.hits = 0; network(true);
    await page.evaluate(() => window.StowShell.postMessage(JSON.stringify({ type: 'check-updates' })));
    await expect.poll(() => proxy.fault.hits).toBeGreaterThan(0);
    expect(installed().active).toBe(old);
    await android.close(); android = undefined; adb('shell', 'input', 'keyevent', 'KEYCODE_HOME'); adb('shell', `kill -9 $(pidof ${pkg})`);
    network(false); proxy.fault.assets = false;
    adb('shell', 'am', 'start', '-W', '-n', `${pkg}/.MainActivity`); page = await attach();
    await expect(page.getByRole('article', { name: 'Open note: Pending offline edit' })).toBeVisible();
    expect(await page.evaluate(() => window.__STOW_SHELL__.release)).toBe(old);
    expect(adb('shell', `run-as ${pkg} ls files/web-releases`)).not.toContain('stage-');
    record('terminated-update-kept-complete-installed-release');
    network(true); await page.evaluate(() => window.StowShell.postMessage(JSON.stringify({ type: 'check-updates' })));
    await expect(page.getByRole('button', { name: 'Restart', exact: true })).toBeVisible({ timeout: 30000 });
    await page.getByRole('article', { name: 'Open note: Pending offline edit' }).click();
    adb('shell', 'input', 'keyevent', 'KEYCODE_HOME'); await sleep(1000);
    expect(installed().active).toBe(old);
    adb('shell', 'am', 'start', '-W', '-n', `${pkg}/.MainActivity`);
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    network(false); await page.getByRole('button', { name: 'Restart', exact: true }).click();
    await android.close(); android = undefined; page = await attach();
    await expect(page.getByRole('article', { name: 'Open note: Pending offline edit' })).toBeVisible();
    expect(await page.evaluate(() => window.__STOW_SHELL__.release)).toBe(next);
    record('staged-web-update-restarted-offline');
    const automatic = release(3); network(true);
    await page.evaluate(() => window.StowShell.postMessage(JSON.stringify({ type: 'check-updates' })));
    await expect(page.getByRole('button', { name: 'Restart', exact: true })).toBeVisible({ timeout: 30000 });
    await page.getByRole('searchbox').fill('Flight');
    network(false); adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
    await expect.poll(() => installed().active).toBe(automatic);
    await android.close(); android = undefined;
    adb('shell', 'am', 'start', '-W', '-n', `${pkg}/.MainActivity`); page = await attach();
    await expect(page.getByRole('searchbox')).toHaveValue('Flight');
    await expect(page.getByRole('article', { name: 'Open note: Flight plan during Doze' })).toBeVisible();
    record('hidden-web-update-restored-filter-offline');
    // Offer a real newer APK, cancel the installer once, then approve it. The
    // install itself must preserve the offline account and notes.
    const androidRelease = JSON.parse(readFileSync(path.join(build, 'updates/release.json'), 'utf8'));
    const apkName = androidRelease.url.split('/').at(-1);
    const apk = readFileSync(path.join(build, 'updates', apkName));
    mkdirSync(path.join(trial, 'data/android-release'), { recursive: true });
    writeFileSync(path.join(trial, 'data/android-release', apkName), apk);
    const manifest = JSON.parse(readFileSync(path.join(trial, 'web/release.json'), 'utf8'));
    manifest.android = androidRelease;
    writeFileSync(path.join(trial, 'data/android-release/release.json'), JSON.stringify(manifest.android));
    network(true);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Get updated Android app', exact: true })).toBeEnabled();
    adb('shell', 'appops', 'set', pkg, 'REQUEST_INSTALL_PACKAGES', 'allow');
    await page.getByRole('button', { name: 'Get updated Android app', exact: true }).click(); await nativeButton('Cancel');
    expect(adb('shell', 'dumpsys', 'package', pkg)).toContain('versionCode=1 ');
    record('apk-cancel-kept-installed-app');
    adb('shell', 'am', 'start', '-W', '-n', `${pkg}/.MainActivity`);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Get updated Android app', exact: true }).click(); await nativeButton('Update');
    await expect.poll(() => adb('shell', 'dumpsys', 'package', pkg), { timeout: 30000 }).toContain('versionCode=2 ');
    await nativeButton('Open');
    await android.close(); android = undefined;
    network(false); page = await attach();
    expect(await page.evaluate(() => window.__STOW_SHELL__.version)).toBe(2);
    await expect(page.getByRole('article', { name: 'Open note: Flight plan during Doze' })).toBeVisible();
    record('signed-apk-update-preserved-offline-vault');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Check for Android updates', exact: true })).toBeEnabled();
    network(true);
    await page.getByRole('button', { name: 'Check for Android updates', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Android app is up-to-date', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    record('android-settings-update-status-verified');
    network(false);
    // Reboot is different from killing a process: registrations must be restored
    // by the boot receiver, and an offline launch must still read the cache.
    await android.close(); android = undefined; adb('reboot');
    adb('wait-for-device');
    await expect.poll(() => adb('shell', 'getprop', 'sys.boot_completed'), { timeout: 120000, intervals: [1000] }).toBe('1');
    adb('root'); adb('wait-for-device');
    adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'); adb('shell', 'wm', 'dismiss-keyguard');
    // ADB reverse is gone across reboot; assert unreachable before the launch.
    adb('shell', 'am', 'start', '-W', '-n', `${pkg}/.MainActivity`); page = await attach();
    await expect(page.getByRole('article', { name: 'Open note: Flight plan during Doze' })).toBeVisible();
    expect(await page.evaluate(async () => { try { await fetch('/native/api/session', { signal: AbortSignal.timeout(1000) }); return true; } catch { return false; } })).toBe(false);
    expect(adb('shell', 'dumpsys', 'jobscheduler')).toContain(`${pkg}/androidx.work.impl.background.systemjob.SystemJobService`);
    record('reboot-restored-offline-vault-and-scheduled-work');
    const stoppedPrior = new Set((await diagnostics()).devices.flatMap(d => d.events.filter(e => e.kind === 'success').map(e => e.runId)));
    control('age'); await android.close(); android = undefined;
    adb('shell', 'am', 'force-stop', pkg);
    await addNote(writer, 'After explicit force stop'); network(true);
    await sleep(10000);
    expect((await diagnostics()).devices.some(d => d.events.some(e => e.kind === 'success' && !stoppedPrior.has(e.runId)))).toBe(false);
    record('force-stop-suppressed-background-work');
    adb('shell', 'am', 'start', '-W', '-n', `${pkg}/.MainActivity`); page = await attach();
    await page.getByRole('searchbox').fill('');
    await expect(page.getByRole('article', { name: 'Open note: After explicit force stop' })).toBeVisible({ timeout: 20000 });
    record('manual-open-recovered-after-force-stop');
    network(false);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Page.crash').catch(() => {});
    await nativeButton('Reopen Stow');
    await android.close(); android = undefined; page = await attach();
    await expect(page.getByRole('article', { name: 'Open note: After explicit force stop' })).toBeVisible();
    record('renderer-crash-recovered-offline');
    adb('shell', 'uiautomator', 'dump', '/sdcard/stow-test-window.xml');
    const nativeTree = adb('shell', 'cat', '/sdcard/stow-test-window.xml');
    const webviewBounds = nativeTree.match(/class="android.webkit.WebView"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/).slice(1).map(Number);
    expect(webviewBounds[1]).toBeGreaterThan(0);
    await page.getByRole('article', { name: 'Open note: After explicit force stop' }).click();
    expect(await page.evaluate(() => document.activeElement.tagName)).not.toBe('TEXTAREA');
    const beforeKeyboard = await page.evaluate(() => innerHeight);
    const scale = await page.evaluate(() => devicePixelRatio);
    const tapWeb = async locator => {
      await expect(locator).toBeInViewport();
      const box = await locator.boundingBox();
      adb('shell', 'input', 'tap', String(Math.floor(webviewBounds[0] + (box.x + box.width / 2) * scale)), String(Math.floor(webviewBounds[1] + (box.y + box.height / 2) * scale)));
    };
    await tapWeb(page.getByRole('textbox', { name: 'Note text', exact: true }));
    await expect.poll(() => page.evaluate(() => innerHeight), { timeout: 10000 }).toBeLessThan(beforeKeyboard - 100);
    await expect.poll(() => adb('shell', 'dumpsys', 'input_method').includes('mInputShown=true'), { timeout: 10000 }).toBeTruthy();
    const toolbar = await page.locator('.editor-toolbar').boundingBox();
    expect(toolbar.y + toolbar.height).toBeLessThanOrEqual(await page.evaluate(() => innerHeight) + 1);
    writeFileSync(path.join(trial, 'keyboard.png'), execFileSync('adb', ['-s', values.serial, 'exec-out', 'screencap', '-p'], { maxBuffer: 16 * 1024 * 1024 }));
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    record('native-bars-and-keyboard-leave-editor-visible');

    // Use Android's document picker, not CDP setInputFiles: selected content://
    // URIs must reach the WebView and the ordinary image upload path.
    network(true);
    const imageName = 'stow-shell-image.png';
    const bars = Array.from({ length: 70 }, (_, i) => `<rect x="${300 + i * 17}" y="450" width="${4 + i % 3}" height="300"/>`).join('');
    writeFileSync(path.join(trial, imageName), await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1800" height="1200"><rect width="1800" height="1200" fill="white"/>${bars}</svg>`)).png().toBuffer());
    adb('push', path.join(trial, imageName), `/sdcard/Download/${imageName}`);
    adb('shell', 'am', 'broadcast', '-a', 'android.intent.action.MEDIA_SCANNER_SCAN_FILE', '-d', `file:///sdcard/Download/${imageName}`);
    await page.getByRole('article', { name: 'Open note: After explicit force stop' }).click();
    const uploaded = page.waitForResponse(response => response.request().method() === 'PUT' && /\/native\/api\/blobs\/[a-f0-9]{64}$/.test(new URL(response.url()).pathname));
    uploaded.catch(() => {}); // Preserve the native UI failure if it precedes the request.
    await page.getByRole('button', { name: 'Add image', exact: true }).click();
    await nativeButton('More'); await nativeButton('Browse…');
    await nativeButton(imageName);
    expect((await uploaded).status()).toBe(204);
    await expect(page.getByRole('dialog', { name: 'Edit note', exact: true }).getByRole('img', { name: imageName, exact: true })).toBeVisible();
    await page.getByRole('button', { name: `Open original: ${imageName}`, exact: true }).click();
    const imageViewer = page.getByRole('dialog', { name: `Original image: ${imageName}`, exact: true });
    const originalImage = imageViewer.getByRole('img', { name: imageName, exact: true });
    await expect(originalImage).toBeVisible();
    const imageViewport = await imageViewer.getByRole('region', { name: 'Zoomable image' }).boundingBox();
    const fitted = await originalImage.boundingBox();
    const cx = imageViewport.x + imageViewport.width / 2, cy = imageViewport.y + imageViewport.height / 2;
    const touchSession = await page.context().newCDPSession(page);
    const touch = (type, touchPoints) => touchSession.send('Input.dispatchTouchEvent', { type, touchPoints });
    const fingers = radius => [{ id: 1, x: cx - radius, y: cy }, { id: 2, x: cx + radius, y: cy }];
    await touch('touchStart', fingers(30));
    for (const radius of [45, 60, 90, 120]) await touch('touchMove', fingers(radius));
    await touch('touchEnd', []);
    await expect(imageViewer.getByRole('button', { name: 'Fit image' })).toHaveText('400%');
    expect((await originalImage.boundingBox()).width / fitted.width).toBeCloseTo(4, 1);
    const enlarged = await originalImage.boundingBox();
    await touch('touchStart', [{ id: 3, x: cx, y: cy }]);
    await touch('touchMove', [{ id: 3, x: cx - 40, y: cy }]);
    await touch('touchEnd', []);
    await expect.poll(async () => (await originalImage.boundingBox()).x - enlarged.x).toBeCloseTo(-40, 0);
    expect(await page.evaluate(() => visualViewport.scale)).toBe(1);
    writeFileSync(path.join(trial, 'image-zoom.png'), execFileSync('adb', ['-s', values.serial, 'exec-out', 'screencap', '-p'], { maxBuffer: 16 * 1024 * 1024 }));
    await imageViewer.getByRole('button', { name: 'Fit image' }).click();
    await expect(imageViewer.getByRole('button', { name: 'Fit image' })).toHaveText('100%');
    await imageViewer.getByRole('button', { name: 'Close image' }).click();
    record('native-original-image-pinched-and-panned');
    expect(await page.evaluate(() => document.body.style.overflow)).toBe('hidden');
    await page.getByRole('button', { name: `Open original: ${imageName}`, exact: true }).click();
    await expect(imageViewer).toBeVisible();
    // Android Back closes the note's history entry, unmounting both dialogs.
    adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe('');
    await tapWeb(page.getByRole('button', { name: 'Settings', exact: true }));
    await expect(page.locator('.settings-menu')).toBeVisible();
    await tapWeb(page.getByRole('button', { name: 'Settings', exact: true }));
    await tapWeb(page.getByRole('article', { name: 'Open note: After explicit force stop' }));
    const reopened = page.getByRole('dialog', { name: 'Edit note', exact: true });
    await expect(reopened).toBeVisible();
    await tapWeb(reopened.getByRole('button', { name: 'Archive note', exact: true }));
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('article', { name: 'Open note: After explicit force stop' })).toHaveCount(0);
    for (let i = 0; i < 16; i++) await addNote(page, `Scroll after viewing image ${i}`);
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeGreaterThan(await page.evaluate(() => innerHeight));
    const scrollStart = await page.evaluate(() => scrollY);
    await touch('touchStart', [{ id: 4, x: 100, y: 600 }]);
    for (const y of [550, 500, 450, 400, 350]) await touch('touchMove', [{ id: 4, x: 100, y }]);
    await touch('touchEnd', []);
    await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(scrollStart + 100);
    record('native-back-from-image-and-archive-restore-overview-taps-and-scroll');
    adb('shell', 'rm', `/sdcard/Download/${imageName}`);
    record('native-file-picker-uploaded-image');

    writeFileSync(path.join(trial, 'overview.png'), execFileSync('adb', ['-s', values.serial, 'exec-out', 'screencap', '-p'], { maxBuffer: 16 * 1024 * 1024 }));
  }
  report.passed = true;
} catch (error) {
  record('FAILED', { error: String(error), stack: error.stack });
  writeFileSync(path.join(trial, 'failure.png'), execFileSync('adb', ['-s', values.serial, 'exec-out', 'screencap', '-p'], { maxBuffer: 16 * 1024 * 1024 }));
  writeFileSync(path.join(trial, 'activity-log.txt'), adb('logcat', '-d', '-s', 'ActivityTaskManager:I'));
  throw error;
}
finally {
  for (const name of disabledPackages) adb('shell', 'pm', 'enable', name);
  network(true); adb('shell', 'dumpsys', 'deviceidle', 'unforce'); adb('shell', 'dumpsys', 'battery', 'reset');
  await android?.close(); await remote?.close(); proxy.close(); server.stdin.end('{"op":"close"}\n');
  writeFileSync(path.join(trial, 'logcat.txt'), adb('logcat', '-d', '-s', 'StowRefresh:I', 'StowWeb:I', 'StowControl:E', 'AndroidRuntime:E'));
  record('finished', { passed: !!report.passed, directory: trial });
}
