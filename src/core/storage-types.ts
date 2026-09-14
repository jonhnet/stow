/** Measurements describe this account's server storage, not the browser cache. */
export interface VaultStorage {
  crdtBytes: number;
  durableBytes: number;
  /** Independent server snapshots; never included in the client CRDT. */
  historyBytes: number;
  historyCount: number;
  originalsBytes: number;
  thumbnailsBytes: number;
  archivedNoteCount: number;
  archivedSourceIds: string[];
  archivedSelectionToken: string;
  retention: { enabled: boolean; graceDays: 7; scanHours: 4 };
  compression: { enabled: boolean; limit: number; recent: number; older: number };
}

export interface ArchivedHistoryCleanup {
  storage: VaultStorage;
  cleanedNoteCount: number;
}
