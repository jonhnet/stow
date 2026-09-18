import * as Y from 'yjs';
import type { PendingEdit } from './history-types';
import type { PersistenceConnection } from './persistence-database';
import { applyStoredUpdates } from './yjs-updates';
import { enforcePermanentDeletions } from './deletion';
import { redactPendingEdit } from './edit-draft';
import { redactUndo, retainUndo, type SavedUndo } from './persistent-undo';

export interface PersistenceWrite {
  batch: Uint8Array[];
  forceCompact: boolean;
  vector: Uint8Array;
  edit?: { owner: string; draft: PendingEdit | null };
  retired: string[];
  undo?: { owner: string; state: SavedUndo };
  // The requesting page holds each owner's exclusive lock until this commits.
  undoCleanup?: { owner: string; state?: SavedUndo }[];
}
export interface CompactionMetrics { totalMs: number; applyMs: number; encodeMs: number; inputBytes: number; outputBytes: number }
export interface PersistenceWriteResult { correction?: Uint8Array; compaction?: CompactionMetrics }
export interface PersistenceWriter {
  write(db: PersistenceConnection, request: PersistenceWrite, compacting: () => void): Promise<PersistenceWriteResult>;
  close(): void;
}

/** The worker owns this atomic append/replace transaction. Another tab's write
 * occurs wholly before or after it; completion always means the commit finished. */
export async function writePersistenceBatch(db: PersistenceConnection, request: PersistenceWrite, onCompacting: () => void = () => {}): Promise<PersistenceWriteResult> {
  const { batch, retired, edit } = request;
  const transaction = db.transaction(['updates', 'pendingEdits', 'maintenance', 'undo'], 'readwrite');
  const updatesStore = transaction.objectStore('updates'), editsStore = transaction.objectStore('pendingEdits'), maintenance = transaction.objectStore('maintenance');
  const done = transaction.done; void done.catch(() => {});
  const result: PersistenceWriteResult = {};
  try {
    await Promise.all(batch.map(update => updatesStore.add(update)));
    if (request.undo) await transaction.objectStore('undo').put(request.undo.state, request.undo.owner);
    for (const entry of request.undoCleanup ?? []) {
      if (entry.state) await transaction.objectStore('undo').put(entry.state, entry.owner);
      else await transaction.objectStore('undo').delete(entry.owner);
    }
    if (edit) {
      // Pending recovery contains source timestamps only. A stale writer cannot
      // retain historical text; recovery rereads durable current-state deletions.
      if (edit.draft) await editsStore.put(edit.draft, edit.owner);
      else await editsStore.delete(edit.owner);
    }
    for (const owner of retired) await editsStore.delete(owner);
    if (request.forceCompact || retired.length || await updatesStore.count() >= 500) {
      onCompacting();
      const start = performance.now(), updates = await updatesStore.getAll(), compacting = new Y.Doc({ gc: false });
      try {
        const applyStart = performance.now();
        applyStoredUpdates(compacting, updates); enforcePermanentDeletions(compacting);
        const applyMs = performance.now() - applyStart, deleted = compacting.getMap('deletedNotes');
        const undoStore = transaction.objectStore('undo');
        const histories = await undoStore.getAll(), historyOwners = await undoStore.getAllKeys();
        for (let index = 0; index < histories.length; index++) {
          const kept = redactUndo(histories[index], deleted);
          retainUndo(compacting, kept);
          await undoStore.put(kept, historyOwners[index]);
        }
        Y.tryGc(Y.createDeleteSetFromStructStore(compacting.store), compacting.store, compacting.gcFilter);
        const drafts = await editsStore.getAll(), owners = await editsStore.getAllKeys();
        await Promise.all(drafts.map((saved, index) => {
          const kept = redactPendingEdit(saved, deleted);
          return kept ? editsStore.put(kept, owners[index]) : editsStore.delete(owners[index]);
        }));
        const encodeStart = performance.now(), compacted = Y.encodeStateAsUpdate(compacting);
        result.correction = Y.encodeStateAsUpdate(compacting, request.vector);
        const encodeMs = performance.now() - encodeStart;
        await updatesStore.clear();
        const tail = await updatesStore.add(compacted);
        await maintenance.put(tail, 'validatedThrough');
        result.compaction = { totalMs: performance.now() - start, applyMs, encodeMs,
          inputBytes: updates.reduce((sum, value) => sum + value.byteLength, 0), outputBytes: compacted.byteLength };
      } finally { compacting.destroy(); }
    }
    await done; return result;
  } catch (error) {
    try { transaction.abort(); } catch { /* Already aborted or complete. */ }
    await done.catch(() => {}); throw error;
  }
}
/** Also used to drain an existing browser connection during an exclusive upgrade. */
export const inlinePersistenceWriter: PersistenceWriter = { write: writePersistenceBatch, close() {} };
