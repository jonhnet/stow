import { navigationFields, resourceFields, type StartupCounter, type StartupMark, type StartupReport } from './startup-report';

// Development reloads report automatically. Production captures require an explicit URL flag.
// This module is also imported by persistence in Node tests, where it stays inactive.
const enabled = typeof window !== 'undefined' && window.isSecureContext &&
  (import.meta.env?.DEV || new URLSearchParams(location.search).get('startup-profile') === '1');
const marks = new Map<StartupMark, number>();
const counters: StartupReport['counters'] = {};
const frameGaps: StartupReport['frameGaps'] = [];
let account: string | undefined;
let id: string;
let finished = false;
let readyReported = false;
let started = false;
let observer: MutationObserver | undefined;
let frame = 0;
let waitingTimer: ReturnType<typeof setTimeout> | undefined;
let completionTimer: ReturnType<typeof setTimeout> | undefined;

function finish() {
  finished = true;
  clearTimeout(completionTimer);
}

export function startupMark(name: StartupMark) {
  if (enabled && !finished && !marks.has(name)) marks.set(name, performance.now());
  if (enabled && !finished && readyReported && name === 'search-build-end') {
    // The caller records build counters immediately after the end mark.
    queueMicrotask(() => { report('ready'); finish(); });
  }
}
export function startupCount(name: StartupCounter, value: number) {
  if (enabled && !finished && Number.isFinite(value)) counters[name] = value;
}
export function startupAccount(vaultId: string) {
  if (enabled && !account) account = vaultId;
}

function numericTimings(values: Record<string, unknown>): Record<string, number> {
  // Cached worker resources can report negative durations. Omit invalid readings
  // so one browser timing anomaly cannot discard the rest of the startup report.
  return Object.fromEntries(Object.entries(values).filter((entry): entry is [string, number] =>
    typeof entry[1] === 'number' && Number.isFinite(entry[1]) && entry[1] >= 0 && entry[1] <= Number.MAX_SAFE_INTEGER));
}

function report(reason: StartupReport['reason']) {
  if (!enabled || !account || finished) return;
  const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
  const resources = (performance.getEntriesByType('resource') as PerformanceResourceTiming[])
    .filter(entry => { const url = new URL(entry.name); return url.origin === location.origin &&
      (url.pathname === '/api/session' || /\.(?:[cm]?js|tsx?|css)$/.test(url.pathname)); })
    .slice(0, 80).map(entry => {
      const values = Object.fromEntries(resourceFields.filter(key => key !== 'serverMs').map(key => [key, entry[key as keyof PerformanceResourceTiming]]));
      return { name: new URL(entry.name).pathname.slice(0, 200), ...numericTimings({ ...values,
        serverMs: entry.serverTiming?.find(timing => timing.name === 'session')?.duration ?? 0 }) };
    });
  const payload: StartupReport = {
    schema: 1, id, startedAt: performance.timeOrigin, reason,
    marks: [...marks].map(([name, at]) => ({ name, at })), counters,
    navigation: navigation ? numericTimings(Object.fromEntries(navigationFields.map(key => [key, navigation[key]]))) : {},
    resources, frameGaps,
  };
  // Reports never block startup, and their failure never changes vault state.
  void fetch('/api/diagnostics/startup', {
    method: 'POST', redirect: 'manual', keepalive: true,
    headers: { 'Content-Type': 'application/json', 'X-Stow-Vault': account },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(10000),
  }).then(response => { if (!response.ok) console.warn('Startup timing report was not accepted:', response.status); })
    .catch(() => { console.warn('Startup timing report could not reach the server.'); });
}

export function startStartupDiagnostics() {
  if (!enabled || started) return;
  started = true;
  id = crypto.randomUUID();
  startupMark('main-executing');
  startupCount('viewportWidth', innerWidth); startupCount('viewportHeight', innerHeight);
  startupCount('pixelRatio', devicePixelRatio); startupCount('hardwareConcurrency', navigator.hardwareConcurrency);
  startupCount('visibleAtStart', document.visibilityState === 'visible' ? 1 : 0);
  let previous = performance.now();
  const tick = (now: number) => {
    const duration = now - previous;
    counters.frameMaxMs = Math.max(counters.frameMaxMs ?? 0, duration);
    if (duration >= 50 && frameGaps.length < 20) frameGaps.push({ start: previous, duration });
    previous = now;
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
  observer = new MutationObserver(() => {
    const root = document.getElementById('root');
    const app = root?.querySelector('.app');
    const loading = !app || !!app.querySelector('.main-content > .loading-state');
    if (loading && root?.querySelector('.spinning')) startupMark('spinner-dom');
    if (loading || marks.has('notes-dom')) return;
    startupMark('notes-dom');
    observer?.disconnect();
    // The second animation frame is a presentation approximation, not a paint API.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      startupMark('notes-frame');
      cancelAnimationFrame(frame);
      clearTimeout(waitingTimer);
      setTimeout(() => {
        report('ready');
        readyReported = true;
        if (marks.has('search-build-start') && !marks.has('search-build-end')) {
          // Keep the presentation timing, then replace this report when the
          // cooperative build finishes. Bound collection even if it never does.
          completionTimer = setTimeout(() => { report('ready'); finish(); }, 12000);
        } else finish();
      }, 1000);
    }));
  });
  observer.observe(document.getElementById('root')!, { childList: true, subtree: true });
  waitingTimer = setTimeout(() => report('waiting'), 12000);
  window.addEventListener('pagehide', () => { report('pagehide'); finish(); observer?.disconnect(); cancelAnimationFrame(frame); clearTimeout(waitingTimer); }, { once: true });
}
