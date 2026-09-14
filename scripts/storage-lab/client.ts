/** Loaded only by the isolated laboratory build, never by the shipped bundle. */
import type { HistoryPage, SavedVersion } from '../../src/core/server-history-types';
import type { Vault } from '../../src/core/vault';
import type { LocalPersistence } from '../../src/core/persistence';
import { warmReloads, inputRepetitions, editRepetitions, stagesPerFixture } from './progress';

type Store = { fetchHistoryVersions(id: string): Promise<HistoryPage>; fetchHistoryVersion(id: string): Promise<SavedVersion>; whenSynchronized(): Promise<void>; vault: Vault; persistence?: LocalPersistence; getSnapshot(): { ready: boolean; status: string; pending: number; error: string | null }; subscribe(fn: () => void): () => void };
type Sample = { name: string; startMs: number; durationMs: number; bytes?: number; count?: number };
const scenarios = ['fresh', 'aged', 'archive', 'live', 'both'];
const namespace = '/' + location.pathname.split('/')[1];
const scenario = location.pathname.split('/')[2];
if (!scenarios.includes(scenario)) throw new Error('Unknown isolated storage fixture.');
const query = new URLSearchParams(location.search), runId = query.get('run') ?? crypto.randomUUID();
const automatic = query.get('auto') === '1', warm = Number(query.get('warm') ?? 0);
const totalStages = scenarios.length * stagesPerFixture;
const progressKey = `stow-lab-progress:${namespace}:${runId}`;
if (!Number.isInteger(warm) || warm < 0 || warm > warmReloads) throw new Error('Invalid trial reload count.');
if (!/^[a-f0-9-]{36}$/.test(runId)) throw new Error('Invalid laboratory run identity.');
query.set('run', runId); history.replaceState(null, '', `${location.pathname}?${query}`);
const prefix = `${namespace}/${scenario}/${runId}`, originalFetch = window.fetch.bind(window);
window.fetch = (input: RequestInfo | URL, init?: RequestInit) => originalFetch(typeof input === 'string' && input.startsWith('/api/') ? prefix + input : input, init);
const NativeSocket = WebSocket;
window.WebSocket = class extends NativeSocket {
  constructor(address: string | URL, protocols?: string | string[]) {
    const url = new URL(address); if (url.origin.replace(/^ws/, 'http') === location.origin && url.pathname === '/sync') url.pathname = prefix + url.pathname;
    super(url, protocols);
  }
};
const samples: Sample[] = [];
const record = (value: Sample) => { if (samples.length < 2000) samples.push(value); };
// Retain visibility history across the startup/action report boundary. A report
// that contains a hidden interval is provisional even if its timings look fast.
const visibility: Sample[] = [];
const recordVisibility = () => {
  if (visibility.length < 100) visibility.push({ name: `visibility-${document.visibilityState}`, startMs: performance.now(), durationMs: 0 });
};
recordVisibility(); document.addEventListener('visibilitychange', recordVisibility);
const NativeWorker = Worker;
window.Worker = class extends NativeWorker {
  constructor(url: string | URL, options?: WorkerOptions) {
    super(url, options); if (options?.name !== 'stow-persistence') return;
    const pending = new Map<number, { start: number; bytes: number; count: number }>(), post = this.postMessage.bind(this);
    this.postMessage = (value: any) => {
      const request = value.request;
      const bytes = request.batch.reduce((sum: number, value: Uint8Array) => sum + value.byteLength, 0) +
        (request.edit ? new TextEncoder().encode(JSON.stringify(request.edit)).byteLength : 0);
      pending.set(value.id, { start: performance.now(), bytes, count: request.batch.length }); post(value);
    };
    this.addEventListener('message', event => {
      if (!event.data.result) return;
      const start = pending.get(event.data.id); if (!start) return; pending.delete(event.data.id);
      record({ name: 'worker-write', startMs: start.start, durationMs: performance.now() - start.start, bytes: start.bytes, count: start.count });
      const compact = event.data.result.compaction;
      if (compact) record({ name: 'worker-compaction', startMs: start.start, durationMs: compact.totalMs, bytes: compact.outputBytes, count: compact.inputBytes });
    });
  }
};
const frame = () => new Promise<number>(resolve => requestAnimationFrame(resolve));
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
let store: Store | undefined, running = false;
let savedStages = Number(sessionStorage.getItem(progressKey) ?? 0), actionFraction = 0;
let phase = 'startup', iteration = 0;
let detail = warm ? `Reload ${warm}/${warmReloads}` : 'Initial load';
const status = document.createElement('div'); status.id = 'storage-lab-controls';
status.style.cssText = 'position:fixed;bottom:12px;right:12px;z-index:9999;padding:12px;background:white;color:#111;border:1px solid #888;border-radius:8px;font:14px sans-serif;box-shadow:0 2px 8px #888;width:280px;max-width:calc(100vw - 24px);box-sizing:border-box;contain:layout style';
const title = document.createElement('strong'); title.textContent = 'Storage trial'; title.style.cssText = 'display:block;font-size:18px;margin-bottom:6px';
const provenance = document.createElement('div'); provenance.textContent = namespace; provenance.style.cssText = 'font-size:12px;margin-bottom:8px;overflow-wrap:anywhere';
const label = document.createElement('div'); label.textContent = `Isolated ${scenario} fixture`;
label.setAttribute('role', 'status');
const overall = document.createElement('strong'); overall.style.display = 'block'; overall.hidden = !automatic;
const progress = document.createElement('progress'); progress.max = totalStages; progress.style.width = '100%'; progress.hidden = !automatic;
progress.setAttribute('aria-label', 'Overall trial progress');
const renderProgress = () => {
  const percent = Math.min(savedStages === totalStages ? 100 : 99, Math.floor((savedStages + actionFraction) / totalStages * 100));
  status.dataset.percent = String(percent); status.dataset.savedStages = String(savedStages); status.dataset.phase = phase;
  overall.textContent = `${percent}% overall · ${savedStages}/${totalStages} stages saved`;
  progress.value = savedStages + actionFraction;
  label.textContent = `${scenario} (${scenarios.indexOf(scenario) + 1}/${scenarios.length}): ${document.hidden ? 'Paused while screen is hidden' : detail}`;
};
const actionProgress = (nextPhase: string, description: string, fraction: number) => {
  phase = nextPhase; detail = description; actionFraction = fraction; renderProgress();
};
const button = document.createElement('button'); button.textContent = 'Run measurements'; button.disabled = true;
const full = document.createElement('button'); full.textContent = 'Run full device trial'; full.style.display = 'block';
full.onclick = () => { location.href = `${namespace}/fresh/?startup-profile=1&auto=1`; };
const next = document.createElement('a'); next.textContent = 'Next fixture'; next.style.marginLeft = '12px';
next.href = `${namespace}/${scenarios[(scenarios.indexOf(scenario) + 1) % scenarios.length]}/?startup-profile=1&run=${runId}`;
status.append(title, overall, progress, label, provenance, button, next, full); document.body.append(status);
if (automatic) { button.hidden = true; next.hidden = true; full.disabled = true; }
renderProgress(); document.addEventListener('visibilitychange', () => { if (title.textContent === 'Storage trial') renderProgress(); });
async function settled() {
  const deadline = performance.now() + 120000;
  while (!store?.getSnapshot().ready || store.getSnapshot().status !== 'online' || store.getSnapshot().pending) {
    if (performance.now() > deadline) throw new Error('The fixture did not finish syncing.'); await delay(50);
  }
  await store.persistence?.whenDurable();
  await store.whenSynchronized();
  if (store.getSnapshot().error) throw new Error(store.getSnapshot().error!);
}
type Failure = { message: string; phase: string; iteration: number; percent: number; field: string; focus: string; dialog: boolean };
async function report(failure?: Failure) {
  const account = await (await fetch('/api/session')).json();
  if (!failure && samples.length + visibility.length > 2000) throw new Error('Measurement buffer full; this run cannot be reported as complete.');
  const result = { schema: 1, id: crypto.randomUUID(), scenario, runId, startedAt: performance.timeOrigin, samples: [...visibility, ...samples].slice(0, 2000), ...(failure ? { failure } : {}) };
  const response = await fetch('/api/lab/report', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Stow-Vault': account.vaultId }, body: JSON.stringify(result) });
  if (!response.ok) throw new Error(`Could not save measurements (${response.status}).`);
  const saved = await response.json();
  provenance.textContent = `${saved.namespace} · build ${saved.buildSha256.slice(0, 12)} · run ${runId.slice(0, 8)}`;
  if (automatic && !failure) {
    if (!Number.isInteger(saved.savedStages) || saved.savedStages < 0 || saved.savedStages > totalStages) throw new Error('The server returned an invalid trial progress count.');
    savedStages = saved.savedStages; sessionStorage.setItem(progressKey, String(savedStages));
    actionFraction = 0; renderProgress();
  }
  return result;
}
const dialogSelector = '[role="dialog"][aria-label="Edit note"]';
const bodySelector = `${dialogSelector} [aria-label="Note text"]`;
async function bodyInput() {
  let waited = 0;
  while (waited < 5000) {
    if (document.hidden) {
      await new Promise<void>(resolve => document.addEventListener('visibilitychange', () => resolve(), { once: true }));
      continue;
    }
    const body = document.querySelector<HTMLElement>(bodySelector);
    if (body instanceof HTMLTextAreaElement && document.activeElement === body) return body;
    if (!document.querySelector(dialogSelector)) throw new Error('The performance checklist editor closed during the trial.');
    // Markdown fields become previews on blur. Focus the current field and wait
    // for React to mount its source editor instead of assuming one frame suffices.
    body?.focus({ preventScroll: true });
    const start = performance.now(); await frame(); waited += performance.now() - start;
  }
  throw new Error('The body editor did not become ready within five seconds.');
}
async function showFailure(error: unknown) {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 250);
  const field = document.querySelector(bodySelector), active = document.activeElement;
  const failure: Failure = { message, phase, iteration, percent: Number(status.dataset.percent), field: field?.tagName ?? 'NONE',
    focus: active === field ? 'body' : active?.getAttribute('aria-label') === 'Note title' ? 'title' : 'other', dialog: !!document.querySelector(dialogSelector) };
  title.textContent = 'Trial stopped'; label.textContent = `${detail}: ${message}`;
  full.disabled = false; full.textContent = 'Start a new trial'; button.disabled = true;
  try { await report(failure); label.textContent += ' Diagnostic saved.'; }
  catch { label.textContent += ' Could not save the diagnostic.'; }
}
async function padCompaction() {
  const account = await (await fetch('/api/session')).json();
  await new Promise<void>((resolve, reject) => {
    const open = indexedDB.open(`stow-notes-${account.vaultId}`); open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result, tx = db.transaction('updates', 'readwrite'), updates = tx.objectStore('updates'), count = updates.count();
      count.onsuccess = () => { for (let i = count.result; i < 499; i++) updates.add(Uint8Array.of(0, 0)); };
      tx.oncomplete = () => { db.close(); resolve(); }; tx.onabort = () => { db.close(); reject(tx.error); };
    };
  });
}
async function run() {
  if (running) throw new Error('Measurements are already running.');
  let animation = 0;
  running = true; button.disabled = true; actionProgress('preview', 'Checking history preview', 0);
  try {
    await settled(); samples.length = 0;
    const vault = store!.vault, note = vault.getNote('lab-note-0')!;
    if (!note || note.title !== 'Performance checklist') throw new Error('The expected isolated fixture is missing.');
    const startPreview = performance.now();
    const preview = (await store!.fetchHistoryVersions(note.id)).versions[0];
    if (preview) await store!.fetchHistoryVersion(preview.id);
    record({ name: 'cold-preview', startMs: startPreview, durationMs: performance.now() - startPreview });
    actionProgress('editor', 'Opening the editor', .05);
    const card = document.querySelector<HTMLElement>('[aria-label="Open note: Performance checklist"]');
    card?.click(); await frame(); await frame();
    if (!document.querySelector('[role="dialog"][aria-label="Edit note"]')) throw new Error('Could not open the performance checklist.');
    await bodyInput();
    let previous: number | undefined, stopFrames = false;
    const tick = (now: number) => {
      if (previous !== undefined && now >= previous && document.visibilityState === 'visible') record({ name: 'frame', startMs: previous, durationMs: now - previous });
      previous = now; if (!stopFrames) animation = requestAnimationFrame(tick);
    };
    animation = requestAnimationFrame(tick);
    await store!.persistence?.whenDurable(); await padCompaction();
    actionProgress('typing', `Typing 0/${inputRepetitions}`, .1);
    for (let i = 0; i < inputRepetitions; i++) {
      iteration = i;
      let input = document.querySelector<HTMLTextAreaElement>(`${dialogSelector} textarea[aria-label="Note text"]`);
      if (!input || document.activeElement !== input) {
        const start = performance.now(); input = await bodyInput();
        record({ name: 'editor-refocus', startMs: start, durationMs: performance.now() - start });
      }
      const value = `${note.body}\nTyping sample ${i}`, start = performance.now();
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: String(i) }));
      if (vault.getNote(note.id)!.body !== value) throw new Error('The input event did not reach the editor.');
      const core = performance.now() - start;
      record({ name: 'input-core', startMs: start, durationMs: core });
      await frame(); record({ name: 'input-frame', startMs: start, durationMs: performance.now() - start });
      if ((i + 1) % 10 === 0) actionProgress('typing', `Typing ${i + 1}/${inputRepetitions}`, .1 + .6 * (i + 1) / inputRepetitions);
      await delay(16);
    }
    let start = performance.now(); vault.finishEdit(); record({ name: 'finish-edit', startMs: start, durationMs: performance.now() - start });
    actionProgress('edits', `Completed edits 0/${editRepetitions}`, .7);
    for (let i = 0; i < editRepetitions; i++) {
      iteration = i;
      start = performance.now(); vault.setItemText('lab-item-0-0', `Completed trial edit ${i}`); vault.finishEdit();
      record({ name: 'completed-edit', startMs: start, durationMs: performance.now() - start }); await frame();
      if ((i + 1) % 5 === 0) actionProgress('edits', `Completed edits ${i + 1}/${editRepetitions}`, .7 + .2 * (i + 1) / editRepetitions);
      await delay(16);
    }
    actionProgress('sync', 'Waiting for durable sync', .9);
    await settled(); await delay(1500); await settled(); stopFrames = true;
    actionProgress('report', 'Saving measurements', .95);
    const result = await report(); label.textContent = `${scenario}: measurements saved`; return result;
  } finally { cancelAnimationFrame(animation); running = false; button.disabled = false; }
}
async function automaticTrial() {
  await settled();
  record({ name: 'startup-ready', startMs: 0, durationMs: performance.now(), count: warm });
  renderProgress();
  button.disabled = true; full.disabled = true;
  await delay(1800); await report();
  if (warm < warmReloads) {
    query.set('warm', String(warm + 1)); location.replace(`${location.pathname}?${query}`); return;
  }
  await run();
  const index = scenarios.indexOf(scenario);
  if (index < scenarios.length - 1) {
    location.href = `${namespace}/${scenarios[index + 1]}/?startup-profile=1&auto=1&run=${runId}`;
  } else {
    if (savedStages !== totalStages) throw new Error(`Only ${savedStages}/${totalStages} stages were saved. Start a new trial to run every fixture and reload.`);
    title.textContent = 'Trial complete';
    label.textContent = 'All five fixtures measured and saved. All 35 reports are on the server. You can close this tab.';
    status.style.cssText += ';top:50%;left:50%;bottom:auto;right:auto;transform:translate(-50%,-50%);width:calc(100vw - 48px);max-width:360px;padding:24px;box-sizing:border-box';
    button.hidden = true; next.hidden = true;
    full.textContent = 'Run another trial'; full.disabled = false; full.style.marginTop = '12px';
  }
}
button.onclick = () => { void run().catch(showFailure); };
const lab = { namespace, scenario, runId, samples, run, settled,
  attach(value: Store) {
    store = value; void settled().then(() => {
      if (automatic) return automaticTrial();
      button.disabled = false;
    }).catch(showFailure);
  },
};
declare global { interface Window { __storageLab: typeof lab } }
window.__storageLab = lab;
