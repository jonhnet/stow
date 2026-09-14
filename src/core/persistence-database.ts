import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { PendingEdit } from './history-types';

export interface PersistenceDatabase extends DBSchema {
  updates: { key: number; value: Uint8Array };
  pendingEdits: { key: string; value: PendingEdit };
  maintenance: { key: string; value: number };
}
export type PersistenceConnection = IDBPDatabase<PersistenceDatabase>;
export const PERSISTENCE_VERSION = 1;
const schemaError = () => new Error('This browser has an older Stow storage format. Clear this account’s local cache before opening a freshly imported vault.');

/** Fresh current-only schema. Old caches are rejected, never silently migrated. */
export async function openPersistenceDatabase(name: string, blocking?: () => void, terminated?: () => void) {
  try {
    const db = await openDB<PersistenceDatabase>(name, PERSISTENCE_VERSION, {
      upgrade(db) {
        db.createObjectStore('updates', { autoIncrement: true });
        db.createObjectStore('pendingEdits');
        db.createObjectStore('maintenance');
      }, blocking, terminated,
    });
    if (db.objectStoreNames.length !== 3 || !(['updates', 'pendingEdits', 'maintenance'] as const).every(name => db.objectStoreNames.contains(name))) {
      db.close(); throw schemaError();
    }
    return db;
  } catch (error) { throw error instanceof Error && error.name === 'VersionError' ? schemaError() : error; }
}
