import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyHistory, diffHistory } from '../src/core/history';
import type { HistoryPatch, HistorySource, HistoryState } from '../src/core/history-types';

const before: Required<HistorySource> = {
  title: 'old', body: 'old body', kind: 'text', color: 'default', pinned: false,
  archived: false, trashed: false, createdAt: 1, updatedAt: 1, sortOrderDate: 1,
  unifiedChecklist: false, items: {}, images: {}, labels: ['tag'], labelGenerations: { tag: 'g1' },
};
// Every schema field must have a distinct changed value, even optional fields.
const changed: Required<HistorySource> = {
  title: 'new', body: 'new body', kind: 'checklist', color: 'sage', pinned: true,
  archived: true, trashed: true, createdAt: 2, updatedAt: 3, sortOrderDate: 4,
  unifiedChecklist: true, items: { i: { text: 'row', checked: false, rank: 1 } },
  images: { image: { id: 'image', noteId: 'n', hash: 'a'.repeat(64), name: 'image', type: 'image/png', size: 1 } },
  labels: ['tag', 'new'], labelGenerations: { tag: 'g2' },
};
const state = (source: HistorySource): HistoryState => ({ sources: { n: source }, groups: [['n']] });

test('every history source field independently survives diff and reconstruction', () => {
  for (const field of Object.keys(changed) as (keyof HistorySource)[]) {
    const after = { ...before, [field]: changed[field] };
    const patches = diffHistory(state(before), state(after));
    assert(patches.length, `${field} must not silently disappear`);
    assert.deepEqual(applyHistory(state(before), patches), state(after), field);
    assert.deepEqual(applyHistory(state(after), diffHistory(state(after), state(before))), state(before), `reverse ${field}`);
  }
});

test('unknown history operations fail instead of returning an apparently reconstructed state', () => {
  const base = state(before), original = structuredClone(base);
  assert.throws(() => applyHistory(base, [
    { op: 'text', sourceId: 'n', field: 'body', index: 0, remove: 0, insert: 'partial ' },
    { op: 'future-operation', sourceId: 'n' } as unknown as HistoryPatch,
  ]), /unsupported change/);
  assert.deepEqual(base, original, 'a failed reconstruction must not mutate its base');
});
