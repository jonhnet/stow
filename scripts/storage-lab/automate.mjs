/** Host browser measurements; never presented as the user's desktop or phone. */
import { chromium } from '@playwright/test';
import { mkdir, writeFile, readdir, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { cpus, loadavg } from 'node:os';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import path from 'node:path';
const { values } = parseArgs({ options: { mobile: { type: 'boolean', default: false }, 'gc-log': { type: 'boolean', default: false }, automatic: { type: 'boolean', default: false }, memory: { type: 'boolean', default: false }, profile: { type: 'boolean', default: false }, engine: { type: 'string', default: 'chromium' }, 'firefox-bin': { type: 'string', default: '/usr/bin/firefox' }, geckodriver: { type: 'string', default: 'geckodriver' }, origin: { type: 'string', default: 'http://localhost:4180' }, base: { type: 'string', default: '/storage-lab' }, scenarios: { type: 'string', default: 'fresh,aged,archive,live,both' }, warm: { type: 'string', default: '5' } } });
if (values.mobile && values.engine !== 'chromium') throw new Error('Mobile layout verification uses Chromium.');
const namespace = values.base;
if (!/^\/[a-z][a-z0-9-]*$/.test(namespace)) throw new Error('Invalid laboratory namespace.');
const origin = new URL(values.origin).origin, scenarios = values.scenarios.split(','), run = randomUUID();
const directory = new URL('../../../build/storage-lab/', import.meta.url).pathname;
await mkdir(directory, { recursive: true });
let page, version, closeBrowser, captureMemory, captureGC;
if (values.engine === 'chromium') {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext(values.mobile ? { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true } : { viewport: { width: 1440, height: 1000 } });
  await context.addCookies([{ name: 'stow_lab_user', value: 'host-chromium@storage-lab.test', url: origin }]);
  page = await context.newPage(); page.setDefaultTimeout(180000);
  page.on('pageerror', error => console.error('Browser error:', error.message));
  version = browser.version(); closeBrowser = () => browser.close();
} else if (values.engine === 'firefox') {
  const profiles = path.join(directory, 'firefox-profiles'); await mkdir(profiles, { recursive: true });
  const driver = spawn(values.geckodriver, ['--host', '127.0.0.1', '--port', '5290', '--profile-root', profiles, '--log', 'error'], { stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, ...(values.profile ? {
    MOZ_PROFILER_STARTUP: '1', MOZ_PROFILER_STARTUP_FILTERS: 'GeckoMain,DOM Worker', MOZ_PROFILER_STARTUP_INTERVAL: '1',
    MOZ_PROFILER_STARTUP_ENTRIES: '8000000', MOZ_PROFILER_SHUTDOWN: path.join(directory, `host-firefox-profile-${run}.json`),
  } : {}) } });
  const command = async (route, body, method = 'POST') => {
    const response = await fetch('http://127.0.0.1:5290' + route, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json(); if (!response.ok) throw new Error(JSON.stringify(result.value)); return result.value;
  };
  for (let i = 0; ; i++) { try { await command('/status', undefined, 'GET'); break; } catch (error) { if (i === 100) throw error; await new Promise(resolve => setTimeout(resolve, 100)); } }
  const session = await command('/session', { capabilities: { alwaysMatch: { browserName: 'firefox', 'moz:firefoxOptions': { binary: values['firefox-bin'], args: ['-headless', ...(values.memory ? ['--remote-allow-system-access'] : [])], prefs: { 'app.update.auto': false } }, timeouts: { script: 180000, pageLoad: 180000 } } } });
  const base = '/session/' + session.sessionId;
  version = session.capabilities.browserVersion;
  const evaluate = async fn => {
    const result = await command(base + '/execute/async', { script: `const done = arguments[arguments.length - 1]; Promise.resolve().then(${fn.toString()}).then(done, error => done({__webdriverError:String(error), stack:error.stack}));`, args: [] });
    if (result?.__webdriverError) throw new Error(result.__webdriverError + '\n' + result.stack); return result;
  };
  if (values.memory) captureMemory = async label => {
    await command(base + '/moz/context', { context: 'chrome' });
    try {
      const reports = await evaluate(() => new Promise(resolve => {
        const reports = [];
        const manager = Components.classes['@mozilla.org/memory-reporter-manager;1'].getService(Components.interfaces.nsIMemoryReporterManager);
        manager.getReports((process, path, kind, units, amount) => reports.push({ process, path, kind, units, amount }), null, () => resolve(reports), null, false);
      }));
      await writeFile(path.join(directory, `memory-${run}-${label}.json`), JSON.stringify(reports));
    } finally { await command(base + '/moz/context', { context: 'content' }); }
  };
  if (values.memory && values['gc-log']) captureGC = async () => {
    await command(base + '/moz/context', { context: 'chrome' });
    try {
      const files = await evaluate(() => new Promise(resolve => {
        const files = [], dumper = Components.classes['@mozilla.org/memory-info-dumper;1'].getService(Components.interfaces.nsIMemoryInfoDumper);
        dumper.dumpGCAndCCLogsToFile('', true, true, { onDump(gc, cc) { files.push({ gc: gc.path, cc: cc.path }); }, onFinish() { resolve(files); } });
      }));
      console.log(JSON.stringify({ gcFiles: files }));
    } finally { await command(base + '/moz/context', { context: 'content' }); }
  };
  page = { goto: url => command(base + '/url', { url }), reload: () => command(base + '/refresh', {}), evaluate,
    waitForTimeout: ms => new Promise(resolve => setTimeout(resolve, ms)),
    async waitForFunction(fn) { for (let i = 0; i < 3600; i++) { if (await evaluate(fn)) return; await new Promise(resolve => setTimeout(resolve, 50)); } throw new Error('Browser did not become ready.'); } };
  await page.goto(origin + namespace + '/');
  await command(base + '/cookie', { cookie: { name: 'stow_lab_user', value: 'host-firefox@storage-lab.test', path: '/' } });
  await command(base + '/window/rect', { width: 1440, height: 1000 });
  closeBrowser = async () => { await command(base, undefined, 'DELETE').catch(() => {}); driver.kill('SIGTERM'); };
} else throw new Error('Use --engine chromium or firefox.');
const result = { schema: 1, device: `development host; headless ${values.engine}${values.mobile ? '; mobile layout verification (not phone hardware)' : ''}`, browser: version, cpu: cpus()[0]?.model, initialLoadAverage: loadavg(), profiled: !!values.profile, memoryReports: !!values.memory, run, results: [] };
const summary = values => {
  const sorted = [...values].sort((a,b) => a-b);
  return { n: sorted.length, median: sorted[Math.floor(sorted.length / 2)], p95: sorted[Math.floor(sorted.length * .95)], max: sorted.at(-1) };
};
try {
  if (values.automatic) {
    const reportDirectory = path.join(directory, 'reports'), seen = new Set(await readdir(reportDirectory)), reports = [];
    await page.goto(`${origin}${namespace}/fresh/?startup-profile=1&auto=1&run=${run}`);
    for (let poll = 0; poll < 180; poll++) {
      await page.waitForTimeout(5000);
      for (const name of await readdir(reportDirectory)) if (!seen.has(name)) {
        let report; try { report = JSON.parse(await readFile(path.join(reportDirectory, name), 'utf8')); } catch { continue; }
        seen.add(name);
        if (report.runId === run) {
          reports.push(report); console.log(JSON.stringify({ scenario: report.scenario, startup: report.samples.find(sample => sample.name === 'startup-ready'), reports: reports.length }));
          if (report.failure) throw new Error(`${report.scenario}: ${JSON.stringify(report.failure)}`);
        }
      }
      if (captureMemory && poll % 6 === 5) await captureMemory(`automatic-${poll}`);
      if (reports.length === 35) {
        await page.waitForFunction(() => document.querySelector('#storage-lab-controls')?.textContent?.includes('All five fixtures measured and saved'));
        const file = path.join(directory, `automatic-${values.engine}-${run}.json`);
        const cohorts = await Promise.all(['fresh', 'aged', 'archive', 'live', 'both'].map(async scenario => {
          const base = `${origin}${namespace}/${scenario}/${run}/api`, headers = { Cookie: `stow_lab_user=host-${values.engine}@storage-lab.test` };
          const account = await (await fetch(base + '/session', { headers })).json();
          const startup = await (await fetch(base + '/diagnostics/startup', { headers: { ...headers, 'X-Stow-Vault': account.vaultId } })).json();
          return { scenario, startup };
        }));
        await writeFile(file, JSON.stringify({ ...result, reports, cohorts }, null, 2) + '\n');
        console.log(JSON.stringify({ file, reports: reports.length })); break;
      }
      if (poll === 179) throw new Error('Automatic browser trial did not finish.');
    }
  } else for (const scenario of scenarios) {
    await page.goto(`${origin}${namespace}/${scenario}/?startup-profile=1&run=${run}`);
    const cohort = { scenario, initialLoadAverage: loadavg(), reloads: [], actions: undefined };
    for (let i = 0; i <= Number(values.warm); i++) {
      if (i) await page.reload();
      await page.waitForFunction(() => !!window.__storageLab);
      const readyMs = await page.evaluate(async () => { await window.__storageLab.settled(); return performance.now(); });
      await page.waitForTimeout(1600);
      const reports = await page.evaluate(async () => {
        const account = await (await fetch('/api/session')).json();
        return (await (await fetch('/api/diagnostics/startup', { headers: { 'X-Stow-Vault': account.vaultId } })).json()).reports;
      });
      cohort.reloads.push({ cohort: i ? 'warm' : 'empty-browser-storage', readyMs, startup: reports.at(-1) });
      console.log(JSON.stringify({ scenario, reload: i, readyMs }));
      if (captureMemory && (i === 0 || i === Number(values.warm))) await captureMemory(`${scenario}-${i}`);
    }
    cohort.actions = await page.evaluate(() => window.__storageLab.run());
    console.log(JSON.stringify({ scenario, inputCore: summary(cohort.actions.samples.filter(s => s.name === 'input-core').map(s => s.durationMs)),
      inputFrame: summary(cohort.actions.samples.filter(s => s.name === 'input-frame').map(s => s.durationMs)),
      compactions: cohort.actions.samples.filter(s => s.name === 'worker-compaction') }));
    result.results.push(cohort);
    await writeFile(path.join(directory, `host-${values.engine}-${run}.json`), JSON.stringify(result, null, 2) + '\n');
  }
  if (captureGC) await captureGC();
} finally { await closeBrowser(); }
