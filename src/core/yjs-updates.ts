import * as Y from 'yjs';
import { assertCurrentSchema } from './current-schema';

/** Yjs V1 encoding with neither structs nor a delete set. Deletion-only updates are real work. */
export function isEmptyUpdate(update: Uint8Array): boolean {
  return update.length === 2 && update[0] === 0 && update[1] === 0;
}

/** Decode the log once. Observers see the complete state, including late dependencies. */
export function applyStoredUpdates(doc: Y.Doc, updates: Uint8Array[], origin?: unknown): void {
  Y.transact(doc, () => {
    for (const update of updates) if (!isEmptyUpdate(update)) Y.applyUpdate(doc, update, origin);
  }, origin, false);
  assertCurrentSchema(doc);
}
