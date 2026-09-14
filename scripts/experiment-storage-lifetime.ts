/** Reproducible current-only lifetime experiment. No user content or deployed data. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import path from 'node:path';
import * as Y from 'yjs';
import { Vault } from '../src/core/vault.ts';
import { applyImport, type ImportedNote } from '../src/core/import.ts';
import { assertCurrentSchema, CURRENT_SCHEMA } from '../src/core/current-schema.ts';
import { nativeCommand, nativeResult } from './native-command.ts';
import { fingerprint } from './storage-lab/fingerprint.ts';
import { buildDir } from '../paths.ts';

const { values } = parseArgs({ options: { 'max-actions': { type: 'string', default: '100000' }, output: { type: 'string' } } });
const maximum = Number(values['max-actions']); assert(Number.isSafeInteger(maximum) && maximum > 0);
process.env.STOW_SERVER_BIN ??= path.join(buildDir, 'cargo-target', 'release', 'stow-server');
const output = path.resolve(values.output ?? path.join(buildDir, 'storage-lifetime-current'));
assert(output.startsWith(`${buildDir}${path.sep}`), 'Experiment output belongs under build/.');
// Refuse reuse: a report must describe a fresh fixture, never previous results.
await mkdir(output);
const report = { schema: 2, currentSchema: CURRENT_SCHEMA, nativeBackend: process.env.STOW_SERVER_BIN, ...await fingerprint(), node: process.version, growth: [] as object[], drafts: [] as object[] };
const save = () => writeFile(path.join(output, 'measurements.json'), JSON.stringify(report, null, 2) + '\n');
const quantiles = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return { median: sorted[Math.floor(sorted.length / 2)], p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * .95))], max: sorted.at(-1) };
};
function imported(items: number): ImportedNote {
  return { id: 'fixture-note', title: 'Lifetime checklist', body: '', kind: 'checklist', color: 'default', pinned: false,
    archived: false, trashed: false, createdAt: 1, updatedAt: 1, images: [], items: Array.from({ length: items }, (_, i) => ({
      id: `item-${i}`, noteId: 'fixture-note', text: `Unchanged checklist item ${i}`, checked: false, deleted: false, rank: i,
    })) };
}
for (const size of [10, 1000, 5000]) {
  const vault = new Vault(); applyImport(vault, { id: 'fixture', manifestHash: '0'.repeat(64), notes: [imported(size)], replaceSourceIds: [] });
  for (const field of ['body', 'item'] as const) {
    const times: number[] = [], pendingBytes: number[] = [];
    for (let i = 0; i < 101; i++) {
      const start = performance.now();
      if (field === 'body') vault.setNoteText('fixture-note', 'body', `Typing sample ${i}`);
      else vault.setItemText('item-0', `Typing sample ${i}`);
      const pending = vault.getPendingEdit();
      times.push(performance.now() - start); pendingBytes.push(Buffer.byteLength(JSON.stringify(pending)));
      assert.deepEqual(Object.keys(pending!), ['modifiedAt']);
    }
    report.drafts.push({ items: size, field, inputs: 100, ms: quantiles(times.slice(1)), pendingBytes: quantiles(pendingBytes.slice(1)) });
    vault.finishEdit();
  }
  vault.destroy(); await save();
}
const vault = new Vault(new Y.Doc()); vault.doc.clientID = 0x40000001;
const historyDirectory = path.join(output, 'history');
let historyInfo: { count: number; bytes: number }, nativeTiming: { openMs: number; operationMs: number };
const history = (method: string, options: object = {}) => {
  const reply = nativeCommand({ op: 'history', directory: historyDirectory, method, ...options });
  historyInfo = reply.info; nativeTiming = reply.timing; return nativeResult(reply.result);
};
const id = vault.createNote('text', { title: 'Long-lived note' });
const milestones = [...new Set([1000, 10000, 100000, maximum].filter(n => n <= maximum))].sort((a, b) => a - b);
const start = performance.now();
for (let action = 1; action <= maximum; action++) {
  vault.setNoteText(id, 'body', `Completed edit ${action}: same visible note, different saved version.`); vault.finishEdit();
  history('capture', { state: vault.captureHistoryState([id]), boundary: { sourceIds: [id], editedAt: action }, now: action });
  vault.undoManager.clear();
  if (!milestones.includes(action)) continue;
  const bytes = Y.encodeStateAsUpdate(vault.doc), doc = new Y.Doc(), loadStart = performance.now(); Y.applyUpdate(doc, bytes);
  const loaded = new Vault(doc), loadMs = performance.now() - loadStart; assertCurrentSchema(doc);
  const previews: number[] = [], nativeOpens: number[] = [];
  for (const version of history('list', { sourceIds: [id], limit: 100 }).versions) {
    history('get', { id: version.id });
    previews.push(nativeTiming!.operationMs); nativeOpens.push(nativeTiming!.openMs);
  }
  const row = { actions: action, elapsedMs: performance.now() - start, retained: historyInfo!.count, encodedBytes: bytes.byteLength,
    serverHistoryBytes: historyInfo!.bytes, crdtStructs: [...doc.store.clients.values()].reduce((sum, structs) => sum + structs.length, 0),
    crdtAuthors: doc.store.clients.size, loadMs, nativePreviewReadMs: quantiles(previews), nativeHistoryOpenMs: quantiles(nativeOpens),
    rssBytes: process.memoryUsage().rss, fixtureHash: createHash('sha256').update(bytes).digest('hex') };
  assert(row.retained <= 100); assert.equal(loaded.getNote(id)!.body, vault.getNote(id)!.body);
  report.growth.push(row); await writeFile(path.join(output, `active-${action}.yjs`), bytes); await save();
  console.log(JSON.stringify(row)); loaded.destroy();
}
vault.destroy(); console.log(JSON.stringify({ output, drafts: report.drafts }));
