import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { PendingEdit } from './history-types';
import type { SavedUndo } from './persistent-undo';
import { SYNC_PROTOCOL_VERSION } from './protocol-version';

export interface PersistenceDatabase extends DBSchema {
  updates: { key: number; value: Uint8Array };
  pendingEdits: { key: string; value: PendingEdit };
  maintenance: { key: string; value: number };
  undo: { key: string; value: SavedUndo };
}
export type PersistenceConnection = IDBPDatabase<PersistenceDatabase>;
export const PERSISTENCE_VERSION = Number(SYNC_PROTOCOL_VERSION);
export class StorageUpdateRequired extends Error {
  constructor(readonly version?: number) { super('Another version of Stow has upgraded this account’s local storage. Reload Stow to continue. Your saved edits will be kept.'); }
}
const schemaError = () => new Error('This browser has an older Stow storage format. Clear this account’s local cache before opening a freshly imported vault.');

/** Upgrade this account's existing cache in place. The compatibility epoch also
 * fences older connections; ordinary releases keep the same database version.
 * Earlier replicated-history caches remain incompatible. */
export async function openPersistenceDatabase(name: string, blocking?: (version: number) => void, terminated?: () => void) {
  let incompatible = false;
  try {
    const db = await openDB<PersistenceDatabase>(name, PERSISTENCE_VERSION, {
      upgrade(db, oldVersion, _newVersion, transaction) {
        if (oldVersion === 0) {
          db.createObjectStore('updates', { autoIncrement: true });
          db.createObjectStore('pendingEdits');
          db.createObjectStore('maintenance');
        } else if (db.objectStoreNames.length !== (oldVersion === 1 ? 3 : 4) || !(['updates', 'pendingEdits', 'maintenance'] as const).every(name => db.objectStoreNames.contains(name)) || (oldVersion > 1 && !db.objectStoreNames.contains('undo'))) {
          incompatible = true; void transaction.done.catch(() => {}); transaction.abort(); return;
        }
        if (oldVersion < 2) db.createObjectStore('undo');
      }, blocking(_oldVersion, newVersion) { blocking?.(newVersion ?? PERSISTENCE_VERSION + 1); }, terminated,
    });
    if (db.objectStoreNames.length !== 4 || !(['updates', 'pendingEdits', 'maintenance', 'undo'] as const).every(name => db.objectStoreNames.contains(name))) {
      db.close(); throw schemaError();
    }
    return db;
  } catch (error) {
    if (error instanceof Error && error.name === 'VersionError') throw new StorageUpdateRequired();
    throw incompatible ? schemaError() : error;
  }
}
