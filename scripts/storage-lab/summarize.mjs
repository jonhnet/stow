/** Aggregate saved numeric reports without contacting or changing a running trial. */
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  input: { type: 'string' }, run: { type: 'string' }, device: { type: 'string' }, output: { type: 'string' },
} });
if (!values.input) throw new Error('Specify --input REPORTS_DIRECTORY_OR_AUTOMATION_JSON; use --run for a reports directory.');
let reports, metadata = {}, cohorts = [];
if ((await stat(values.input)).isDirectory()) {
  if (!values.run) throw new Error('A reports directory requires --run to keep device trials separate.');
  reports = [];
  for (const name of await readdir(values.input)) {
    if (!name.endsWith('.json')) continue;
    const report = JSON.parse(await readFile(path.join(values.input, name), 'utf8'));
    if (report.runId === values.run) reports.push(report);
  }
} else {
  const data = JSON.parse(await readFile(values.input, 'utf8'));
  reports = data.reports; cohorts = data.cohorts ?? [];
  for (const key of ['device', 'browser', 'cpu', 'initialLoadAverage', 'profiled', 'memoryReports']) if (data[key] !== undefined) metadata[key] = data[key];
}
if (!Array.isArray(reports) || !reports.length) throw new Error('No matching saved reports.');
const unique = field => [...new Set(reports.map(field))];
if (unique(r => r.runId).length !== 1 || unique(r => r.build.sha256).length !== 1 || unique(r => r.browser).length !== 1 || unique(r => r.namespace).length !== 1) {
  throw new Error('Refusing to combine different runs, builds, or browsers.');
}
const round = n => Math.round(n * 100) / 100;
const summarize = numbers => {
  if (!numbers.length) return null;
  const sorted = [...numbers].sort((a, b) => a - b), n = sorted.length;
  return { count: n, min: round(sorted[0]), median: round((sorted[Math.floor((n - 1) / 2)] + sorted[Math.floor(n / 2)]) / 2),
    p95: round(sorted[Math.ceil(n * .95) - 1]), max: round(sorted.at(-1)) };
};
const stagePairs = {
  idbRead: ['idb-read-start', 'idb-read-end'], applyUpdates: ['updates-apply-start', 'updates-apply-end'],
  projection: ['snapshot-start', 'snapshot-end'], searchBuild: ['search-build-start', 'search-build-end'],
};
const results = [];
for (const scenario of ['fresh', 'aged', 'archive', 'live', 'both']) {
  const rows = reports.filter(r => r.scenario === scenario && !r.failure);
  if (!rows.length) continue;
  if (new Set(rows.map(r => r.fixture.sha256)).size !== 1) throw new Error(`Mixed ${scenario} fixtures.`);
  const starts = rows.flatMap(r => r.samples.filter(s => s.name === 'startup-ready').map(s => ({ ...s, startedAt: r.startedAt }))).sort((a, b) => a.count - b.count);
  const actionRows = rows.filter(r => r.samples.some(s => s.name === 'input-core'));
  if (new Set(starts.map(s => s.count)).size !== starts.length || actionRows.length > 1) throw new Error(`Duplicate ${scenario} measurements.`);
  const samples = actionRows.flatMap(r => r.samples), timings = {};
  for (const name of ['cold-preview', 'input-core', 'input-frame', 'finish-edit', 'completed-edit', 'worker-write', 'worker-compaction', 'frame', 'editor-refocus']) {
    const selected = samples.filter(s => s.name === name);
    timings[name] = summarize(selected.map(s => s.durationMs));
    if (name === 'worker-compaction') timings.compactions = selected.map(s => ({ durationMs: round(s.durationMs), inputBytes: s.count, outputBytes: s.bytes }));
  }
  const inputs = samples.filter(s => s.name === 'input-frame');
  if (inputs.length) {
    const from = Math.min(...inputs.map(s => s.startMs)), to = Math.max(...inputs.map(s => s.startMs + s.durationMs));
    timings.framesDuringTyping = summarize(samples.filter(s => s.name === 'frame' && s.startMs < to && s.startMs + s.durationMs > from).map(s => s.durationMs));
  }
  const startupReports = rows.flatMap(r => r.startup?.reports ?? []).concat(cohorts.find(c => c.scenario === scenario)?.startup?.reports ?? []);
  const warmStages = {};
  for (const [name, [from, to]] of Object.entries(stagePairs)) {
    const durations = starts.filter(s => s.count > 0).flatMap(s => {
      const match = startupReports.filter(r => Math.abs(r.startedAt - s.startedAt) < 1).sort((a, b) => b.marks.length - a.marks.length)[0];
      const a = match?.marks.find(m => m.name === from)?.at, b = match?.marks.find(m => m.name === to)?.at;
      return a !== undefined && b !== undefined ? [b - a] : [];
    });
    if (durations.length) warmStages[name] = { samplesMs: durations.map(round), ...summarize(durations) };
  }
  const warm = starts.filter(s => s.count > 0).map(s => s.durationMs), warmSummary = summarize(warm);
  // Five reloads support median/range, not an input-style tail percentile.
  if (warmSummary) delete warmSummary.p95;
  results.push({ scenario, complete: starts.length === 6 && actionRows.length === 1,
    fixture: rows[0].fixture, initialMs: starts.find(s => s.count === 0)?.durationMs ?? null,
    warm: { samplesMs: warm.map(round), ...warmSummary }, warmStages, timings });
}
const result = { schema: 1, run: reports[0].runId, ...metadata, ...(values.device ? { device: values.device } : {}),
  namespace: reports[0].namespace ?? null,
  visibility: {
    recorded: reports.every(r => r.samples.some(s => s.name.startsWith('visibility-'))),
    interruptedReports: reports.filter(r => r.samples.some(s => s.name === 'visibility-hidden')).map(r => ({
      id: r.id, scenario: r.scenario, startedAt: r.startedAt,
      phase: r.samples.some(s => s.name === 'startup-ready') ? 'startup' : 'actions',
    })),
  },
  userAgent: reports[0].browser, build: reports[0].build, reportCount: reports.length,
  savedStageCount: reports.filter(r => !r.failure).length,
  failures: reports.filter(r => r.failure).map(r => ({ id: r.id, scenario: r.scenario, ...r.failure })),
  complete: !reports.some(r => r.failure) && results.length === 5 && results.every(r => r.complete),
  metric: 'startup-ready includes local readiness and settled sync; input uses scripted DOM events; durations are milliseconds', results };
const json = JSON.stringify(result, null, 2) + '\n';
if (values.output) { await writeFile(values.output, json); console.log(`${result.reportCount} reports; complete=${result.complete}; saved ${values.output}`); }
else process.stdout.write(json);
