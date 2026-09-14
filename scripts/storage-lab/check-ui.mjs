/** Functional mobile-layout checks against a production laboratory bundle.
 * These deliberately move focus; they are not phone performance measurements. */
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
const { values } = parseArgs({ options: { 'full-only': { type: 'boolean', default: false }, origin: { type: 'string', default: 'http://localhost:4180' }, base: { type: 'string', default: '/storage-lab' } } });
const origin = new URL(values.origin).origin, base = values.base;
const directory = new URL('../../../build/storage-lab/', import.meta.url).pathname;
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true, args: ['--no-sandbox'] });
async function contextFor(test) {
  const context = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });
  await context.addCookies([{ name: 'stow_lab_user', value: `ui-${test}@storage-lab.test`, url: origin }]);
  return context;
}
try {
  if (!values['full-only']) {
  // The old harness failed after exactly one input when this field lost focus.
  const focusContext = await contextFor('focus');
  try {
    const page = await focusContext.newPage(), run = randomUUID();
    await page.goto(`${origin}${base}/fresh/?startup-profile=1&run=${run}`);
    await page.waitForFunction(() => window.__storageLab && !document.querySelector('#storage-lab-controls button').disabled);
    const report = await page.evaluate(async () => {
      let moved = false;
      const listener = event => {
        if (event.target?.getAttribute('aria-label') !== 'Note text' || moved) return;
        moved = true;
        setTimeout(() => document.querySelector('[aria-label="Edit note"] [aria-label="Note title"]')?.focus(), 0);
      };
      document.addEventListener('input', listener);
      try { const report = await window.__storageLab.run(); return { moved, report }; }
      finally { document.removeEventListener('input', listener); }
    });
    assert.equal(report.moved, true);
    assert.equal(report.report.samples.filter(s => s.name === 'input-frame').length, 120);
    assert.equal(report.report.samples.filter(s => s.name === 'completed-edit').length, 40);
    assert.ok(report.report.samples.some(s => s.name === 'editor-refocus'));
    console.log('PASS: focus movement remounts the editor and preserves all 120 inputs and 40 completed edits');
  } finally { await focusContext.close(); }

  const errorContext = await contextFor('error');
  try {
    await errorContext.addInitScript(() => {
      let closed = false;
      document.addEventListener('input', event => {
        if (event.target?.getAttribute('aria-label') !== 'Note text' || closed) return;
        closed = true;
        setTimeout(() => [...document.querySelectorAll('[aria-label="Edit note"] button')].find(button => button.textContent === 'Close')?.click(), 0);
      });
    });
    const page = await errorContext.newPage(), run = randomUUID();
    const failureResponse = page.waitForResponse(response => response.url().endsWith('/api/lab/report') && !!response.request().postDataJSON()?.failure, { timeout: 120000 });
    await page.goto(`${origin}${base}/fresh/?startup-profile=1&auto=1&run=${run}`);
    const response = await failureResponse;
    assert.equal(response.status(), 201);
    const failure = response.request().postDataJSON().failure;
    assert.equal(failure.phase, 'typing'); assert.equal(failure.dialog, false);
    assert.match(failure.message, /editor closed/); assert.ok(failure.percent < 100);
    await page.waitForFunction(() => document.querySelector('#storage-lab-controls')?.textContent.includes('Diagnostic saved'));
    const progress = await page.locator('#storage-lab-controls').getAttribute('data-saved-stages');
    assert.equal(progress, '6');
    await page.screenshot({ path: directory + 'trial-stopped-mobile.png' });
    console.log('PASS: a closed editor saves a diagnostic and stops at six saved stages, without claiming completion');
  } finally { await errorContext.close(); }
  }

  // Verify progress across every navigation, all 30 loads and all five action sets.
  const fullContext = await contextFor('full');
  try {
    await fullContext.addInitScript(() => {
      const observe = () => {
        const panel = document.querySelector('#storage-lab-controls'); if (!panel) return;
        discovery.disconnect();
        const record = () => {
          const row = { percent: Number(panel.dataset.percent), saved: Number(panel.dataset.savedStages), phase: panel.dataset.phase };
          const rows = JSON.parse(sessionStorage.getItem('trial-progress-check') || '[]'), last = rows.at(-1);
          if (!last || JSON.stringify(last) !== JSON.stringify(row)) {
            rows.push(row); sessionStorage.setItem('trial-progress-check', JSON.stringify(rows));
          }
        };
        new MutationObserver(record).observe(panel, { attributes: true, attributeFilter: ['data-percent', 'data-saved-stages', 'data-phase'] }); record();
      };
      const discovery = new MutationObserver(observe); discovery.observe(document, { childList: true, subtree: true }); observe();
    });
    const page = await fullContext.newPage(), run = randomUUID(), reports = [], acknowledgements = [];
    // Read the acknowledgement before permitting the next navigation; Chromium
    // can release a response body immediately when the document navigates away.
    await page.route('**/api/lab/report', async route => {
      const response = await route.fetch();
      assert.equal(response.status(), 201);
      reports.push(route.request().postDataJSON()); acknowledgements.push(await response.json());
      await route.fulfill({ response });
    });
    await page.goto(`${origin}${base}/fresh/?startup-profile=1&auto=1&run=${run}`);
    await page.waitForFunction(() => document.querySelector('#storage-lab-controls strong')?.textContent === 'Trial complete', {}, { timeout: 600000 });
    const rows = await page.evaluate(() => JSON.parse(sessionStorage.getItem('trial-progress-check')));
    assert.equal(reports.length, 35); assert.equal(acknowledgements.length, 35);
    assert.deepEqual(acknowledgements.map(row => row.savedStages), Array.from({ length: 35 }, (_, index) => index + 1));
    assert.equal(rows[0].percent, 0); assert.equal(rows.at(-1).percent, 100); assert.equal(rows.at(-1).saved, 35);
    for (let i = 1; i < rows.length; i++) {
      assert.ok(rows[i].percent >= rows[i - 1].percent, 'progress went backwards across a reload');
      assert.ok(rows[i].percent < 100 || rows[i].saved === 35, 'premature completion');
    }
    assert.deepEqual([...new Set(rows.map(row => row.saved))], Array.from({ length: 36 }, (_, index) => index));
    assert.ok(rows.some(row => row.phase === 'typing')); assert.ok(rows.some(row => row.phase === 'edits'));
    const bounds = await page.locator('#storage-lab-controls').boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 412 && bounds.y >= 0 && bounds.y + bounds.height <= 915);
    await page.screenshot({ path: directory + 'trial-complete-mobile.png' });
    const savedReports = [];
    for (const name of await readdir(directory + 'reports')) {
      let report; try { report = JSON.parse(await readFile(directory + 'reports/' + name, 'utf8')); } catch { continue; }
      if (report.runId === run) savedReports.push(report);
    }
    assert.equal(savedReports.length, 35);
    await writeFile(directory + `automatic-ui-${run}.json`, JSON.stringify({ run, device: 'development host; mobile layout and progress verification, not phone hardware', browser: browser.version(), reports: savedReports, acknowledgements, progress: rows }, null, 2));
    console.log(JSON.stringify({ result: 'PASS: 0–100% across all 35 saved stages, including reloads, typing and completed edits', run }));
  } finally { await fullContext.close(); }
} finally { await browser.close(); }
