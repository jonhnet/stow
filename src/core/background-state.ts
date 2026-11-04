import { openDB, type DBSchema } from 'idb';
import { assertAccountScope, type Account } from './account';

export const BACKGROUND_TAG = 'stow-notes';
export const BACKGROUND_INTERVAL = 60 * 60 * 1000;
export interface BackgroundResult { attemptedAt: number; completedAt?: number; error?: string }
export type BackgroundAvailability = 'enabled' | 'unavailable' | 'not-permitted' | 'error' | 'native';
export const BACKGROUND_LOG_LIMIT = 200;
export type BackgroundDetail =
  | { kind: 'native'; trigger: string; shellVersion: number; nativeAt: number; message: string }
  | { kind: 'registration-check'; standalone: boolean }
  | { kind: 'registration'; availability: BackgroundAvailability; standalone: boolean; permission?: PermissionState; message?: string }
  | { kind: 'wake' | 'started'; runId: string }
  | { kind: 'skipped'; runId: string; message: string }
  | { kind: 'success'; runId: string; durationMs: number; receivedBytes: number }
  | { kind: 'failure'; runId: string; durationMs: number; message: string };
// Older queued events have no build; leave their provenance unknown.
export type BackgroundEvent = BackgroundDetail & { at: number; vaultId: string; build?: string | null };
interface BackgroundDatabase extends DBSchema {
  account: { key: string; value: Account };
  results: { key: string; value: BackgroundResult };
  events: { key: number; value: BackgroundEvent; indexes: { vaultId: string } };
  metadata: { key: string; value: string };
}
export async function openBackgroundDatabase() {
  const db = await openDB<BackgroundDatabase>('stow-background-v1', 2, {
    upgrade(db, oldVersion) {
      if (oldVersion < 1) { db.createObjectStore('account'); db.createObjectStore('results'); }
      if (oldVersion < 2) {
        db.createObjectStore('events', { autoIncrement: true }).createIndex('vaultId', 'vaultId');
        db.createObjectStore('metadata');
      }
    },
    blocking() { db.close(); },
  });
  return db;
}

/** Only a foreground session verification selects the account eligible for refresh. */
export async function rememberBackgroundAccount(account: Account) {
  assertAccountScope(account);
  const db = await openBackgroundDatabase();
  try { await db.put('account', account, 'active'); } finally { db.close(); }
}

/** Read diagnostics for this private account, without changing refresh eligibility. */
export async function readBackgroundResult(account: Account): Promise<BackgroundResult | null> {
  assertAccountScope(account);
  const db = await openBackgroundDatabase();
  try { return await db.get('results', account.vaultId) ?? null; } finally { db.close(); }
}

/** Durable before doing the work, so termination leaves a wake/start without a
 * completion. Keep diagnostic storage bounded and free of note contents. */
export async function recordBackgroundEvent(account: Account, detail: BackgroundDetail, build: string | null) {
  assertAccountScope(account);
  const db = await openBackgroundDatabase();
  try {
    const tx = db.transaction(['events', 'metadata'], 'readwrite');
    const metadata = tx.objectStore('metadata');
    if (!await metadata.get('deviceId')) await metadata.put(crypto.randomUUID(), 'deviceId');
    const events = tx.objectStore('events');
    const bounded = 'message' in detail && detail.message ? { ...detail, message: detail.message.slice(0, 1000) } : detail;
    // Capture the producing tab/worker's build now, not the later uploader's.
    await events.add({ ...bounded, at: Date.now(), vaultId: account.vaultId, build });
    const keys = await events.index('vaultId').getAllKeys(account.vaultId);
    const removed = keys.slice(0, -BACKGROUND_LOG_LIMIT);
    const uploaded = Number(await metadata.get(`uploaded:${account.vaultId}`) ?? 0);
    const dropped = removed.filter(key => key > uploaded).length;
    if (dropped) await metadata.put(String(Number(await metadata.get(`dropped:${account.vaultId}`) ?? 0) + dropped), `dropped:${account.vaultId}`);
    for (const key of removed) await events.delete(key);
    await tx.done;
  } finally { db.close(); }
}

export async function readBackgroundLog(account: Account) {
  assertAccountScope(account);
  const db = await openBackgroundDatabase();
  try {
    const tx = db.transaction(['events', 'metadata', 'results'], 'readonly');
    const [deviceId, result, events, uploadedThrough, lastUploadedAt, droppedUnacknowledged] = await Promise.all([
      tx.objectStore('metadata').get('deviceId'),
      tx.objectStore('results').get(account.vaultId),
      tx.objectStore('events').index('vaultId').getAll(account.vaultId),
      tx.objectStore('metadata').get(`uploaded:${account.vaultId}`),
      tx.objectStore('metadata').get(`uploadedAt:${account.vaultId}`),
      tx.objectStore('metadata').get(`dropped:${account.vaultId}`),
    ]);
    await tx.done;
    return { schema: 1, deviceId, vaultId: account.vaultId, result: result ?? null, events,
      uploadedThrough: Number(uploadedThrough ?? 0), lastUploadedAt: lastUploadedAt ? Number(lastUploadedAt) : null,
      droppedUnacknowledged: Number(droppedUnacknowledged ?? 0) };
  } finally { db.close(); }
}
