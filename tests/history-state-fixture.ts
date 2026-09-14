import assert from 'node:assert/strict';
import type * as Y from 'yjs';
import { Vault } from '../src/core/vault';
import { historyNotes } from '../src/core/history-view';
import type { HistoryBoundary, HistoryState } from '../src/core/history-types';

const observed = new WeakMap<Vault, HistoryBoundary[]>();
export function observeBoundaries(vault: Vault) {
  let events = observed.get(vault);
  if (!events) {
    events = []; observed.set(vault, events);
    vault.onHistoryBoundary(boundary => events!.push(structuredClone(boundary)));
  }
  return events;
}
export function latestBoundary(vault: Vault) {
  const value = observeBoundaries(vault).at(-1); assert(value, 'Expected a completed action boundary'); return value;
}

/** A snapshot is explicit test data, independently serializable from the CRDT. */
export function captureSnapshot(vault: Vault, id: string) {
  vault.finishEdit();
  const state = structuredClone(vault.captureHistoryState(vault.getNote(id)?.sourceIds ?? [id]));
  return { state, note: historyNotes(state)[0] };
}

export function assertNoReplicatedHistory(doc: Y.Doc) {
  for (const name of ['revisions', 'revisionBuckets', 'deletedRevisionIds', 'historyCuts', 'historyEpochs']) {
    assert.equal(doc.share.has(name), false, `${name} must not be replicated to clients`);
  }
}

export const snapshotNote = (state: HistoryState) => historyNotes(state)[0];
