import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { PendingEdit } from './history-types';
import type { SavedUndo } from './persistent-undo';

export interface PersistenceDatabase extends DBSchema {
  updates: { key: number; value: Uint8Array };
  pendingEdits: { key: string; value: PendingEdit };
  maintenance: { key: string; value: number };
  undo: { key: string; value: SavedUndo };
}
export type PersistenceConnection = IDBPDatabase<PersistenceDatabase>;
export const PERSISTENCE_VERSION = 2;
const schemaError = () => new Error('This browser has an older Stow storage format. Clear this account’s local cache before opening a freshly imported vault.');

/** The current-only v1 cache gains local Undo storage without changing its data.
 * Earlier replicated-history caches remain incompatible. */
export async function openPersistenceDatabase(name: string, blocking?: () => void, terminated?: () => void) {
  let incompatible = false;
  try {
    const db = await openDB<PersistenceDatabase>(name, PERSISTENCE_VERSION, {
      upgrade(db, oldVersion, _newVersion, transaction) {
        if (oldVersion === 0) {
          db.createObjectStore('updates', { autoIncrement: true });
          db.createObjectStore('pendingEdits');
          db.createObjectStore('maintenance');
        } else if (db.objectStoreNames.length !== 3 || !(['updates', 'pendingEdits', 'maintenance'] as const).every(name => db.objectStoreNames.contains(name))) {
          incompatible = true; void transaction.done.catch(() => {}); transaction.abort(); return;
        }
        db.createObjectStore('undo');
      }, blocking, terminated,
    });
    if (db.objectStoreNames.length !== 4 || !(['updates', 'pendingEdits', 'maintenance', 'undo'] as const).every(name => db.objectStoreNames.contains(name))) {
      db.close(); throw schemaError();
    }
    return db;
  } catch (error) { throw incompatible || (error instanceof Error && error.name === 'VersionError') ? schemaError() : error; }
}
