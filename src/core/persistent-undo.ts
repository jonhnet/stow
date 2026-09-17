import * as Y from 'yjs';

type StackItem = Y.UndoManager['undoStack'][number];
export interface SavedUndo {
  version: 1;
  updatedAt: number;
  undoStack: StackItem[];
  redoStack: StackItem[];
  // Yjs updates encode CRDT content, but not the links made by UndoManager.
  redone: { id: Y.ID; length: number; target: Y.ID }[];
}

export function saveUndo(manager: Y.UndoManager): SavedUndo {
  const redone: SavedUndo['redone'] = [];
  if (manager.canUndo() || manager.canRedo()) for (const structs of manager.doc.store.clients.values()) {
    for (const item of structs) if (item instanceof Y.Item && item.redone) {
      redone.push({ id: item.id, length: item.length, target: item.redone });
    }
  }
  // Stack metadata includes Maps and Sets, and is still edited by the next
  // keystroke. Freeze this write's view before handing it to the worker.
  return structuredClone({ version: 1, updatedAt: Date.now(), undoStack: manager.undoStack, redoStack: manager.redoStack, redone });
}

export function redactUndo(saved: SavedUndo, deleted: { has(id: string): boolean }): SavedUndo {
  if (saved.version !== 1) throw new Error('This browser has an unsupported Undo storage format.');
  const keep = (item: StackItem) => ![...(item.meta.get('stow-source-ids') as Set<string> ?? [])].some(id => deleted.has(id));
  return { ...saved, undoStack: saved.undoStack.filter(keep), redoStack: saved.redoStack.filter(keep) };
}

/** Call after loading with gc disabled, before collecting the local log. Only
 * Undo's deleted ranges and their parents need their original content retained. */
export function retainUndo(doc: Y.Doc, saved: SavedUndo, origin?: unknown) {
  doc.transact(transaction => {
    for (const entry of [...saved.undoStack, ...saved.redoStack]) {
      Y.iterateDeletedStructs(transaction, entry.deletions, struct => {
        if (!(struct instanceof Y.Item) || struct.content instanceof Y.ContentDeleted) {
          throw new Error('Local Undo data is incomplete. Keep this page open and export your notes.');
        }
        let item: Y.Item | null = struct;
        while (item && !item.keep) {
          item.keep = true;
          item = (item.parent as Y.AbstractType<any>)._item;
        }
      });
    }
  }, origin);
}

export function restoreUndo(manager: Y.UndoManager, saved: SavedUndo, origin?: unknown) {
  const doc = manager.doc;
  const kept = redactUndo(saved, doc.getMap('deletedNotes'));
  retainUndo(doc, kept, origin);
  doc.transact(transaction => {
    for (const link of kept.redone) {
      // Old links whose content was collected no longer serve any stack entry.
      if (Y.getState(doc.store, link.id.client) <= link.id.clock) continue;
      const end = link.id.clock + link.length;
      let clock = link.id.clock;
      while (clock < end) {
        const item = Y.getItemCleanStart(transaction, Y.createID(link.id.client, clock));
        if (item instanceof Y.Item) {
          Y.getItemCleanEnd(transaction, doc.store, Y.createID(link.id.client, Math.min(clock + item.length, end) - 1));
          item.redone = Y.createID(link.target.client, link.target.clock + clock - link.id.clock);
        }
        clock += item.length;
      }
    }
  }, origin);
  manager.undoStack = kept.undoStack;
  manager.redoStack = kept.redoStack;
  manager.stopCapturing();
}
