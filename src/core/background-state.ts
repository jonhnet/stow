import { openDB, type DBSchema } from 'idb';
import type { Account } from './account';

export const BACKGROUND_TAG = 'stow-notes';
export const BACKGROUND_INTERVAL = 60 * 60 * 1000;
export interface BackgroundResult { attemptedAt: number; completedAt?: number; error?: string }
interface BackgroundDatabase extends DBSchema {
  account: { key: string; value: Account };
  results: { key: string; value: BackgroundResult };
}
export async function openBackgroundDatabase() {
  return openDB<BackgroundDatabase>('stow-background-v1', 1, {
    upgrade(db) { db.createObjectStore('account'); db.createObjectStore('results'); },
  });
}

/** Only a foreground session verification selects the account eligible for refresh. */
export async function rememberBackgroundAccount(account: Account) {
  const db = await openBackgroundDatabase();
  try { await db.put('account', account, 'active'); } finally { db.close(); }
}

