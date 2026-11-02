import * as Y from 'yjs';
import { assertAccountScope, parseAccount, type Account } from './account';
import { assertCurrentSchema, CURRENT_SCHEMA } from './current-schema';
import { SYNC_PROTOCOL_VERSION } from './protocol-version';
import { openPersistenceDatabase } from './persistence-database';
import { writePersistenceBatch } from './persistence-write';
import { applyStoredUpdates } from './yjs-updates';
import { SyncTransfer, TransferError, unpackSync } from './sync-transfer';
import { tabChannelName } from './tab-sync';
import { openBackgroundDatabase, recordBackgroundEvent } from './background-state';
import { uploadBackgroundLog } from './background-upload';

/** Download only: pending edits and Undo belong to foreground writers. The same
 * atomic append/compaction used by those writers preserves concurrent changes. */
export async function refreshBackgroundAccount(account: Account, origin: string, signal: AbortSignal) {
  assertAccountScope(account);
  const response = await fetch(new URL('/api/session', origin), {
    credentials: 'include', cache: 'no-store', redirect: 'manual', signal,
    headers: { 'X-Stow-Schema': CURRENT_SCHEMA, 'X-Stow-Sync-Protocol': SYNC_PROTOCOL_VERSION },
  });
  if (!response.ok) throw new Error(`Background sync could not verify the account (HTTP ${response.status}). Open Stow to sign in.`);
  const session = await response.json();
  const verified = parseAccount(session);
  assertAccountScope(verified);
  if (session.authenticated !== true || session.syncRejection || verified.vaultId !== account.vaultId || verified.user !== account.user || verified.authMode !== account.authMode) {
    throw new Error('Background sync account or version changed. Open Stow to continue.');
  }
  signal.throwIfAborted();
  const db = await openPersistenceDatabase(`stow-notes-${account.vaultId}`, () => db.close());
  const doc = new Y.Doc({ gc: false });
  let receivedBytes = 0;
  try {
    // Never bootstrap an account in the background; it must have opened normally.
    if (await db.get('maintenance', 'initialSyncComplete') !== 1) throw new Error('Open Stow online once before background sync.');
    applyStoredUpdates(doc, await db.getAll('updates')); assertCurrentSchema(doc);
    const url = new URL('/sync', origin); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.search = new URLSearchParams({ schema: CURRENT_SCHEMA, protocol: SYNC_PROTOCOL_VERSION, vaultId: account.vaultId }).toString();
    await download(url.href, Y.encodeStateVector(doc), signal, async update => {
      signal.throwIfAborted();
      Y.applyUpdate(doc, update); assertCurrentSchema(doc);
      const result = await writePersistenceBatch(db, {
        batch: [update], vector: Y.encodeStateVector(doc), retired: [],
        forceCompact: doc.getMap('deletedNotes').size > 0,
      });
      // Durable before acknowledging the snapshot or notifying an open tab.
      // No edit/Undo owner is acquired or retired by this worker.
      await db.put('maintenance', Date.now(), 'lastSyncAt');
      const channel = new BroadcastChannel(tabChannelName(account.vaultId));
      try { channel.postMessage(result.correction ? Y.mergeUpdates([update, result.correction]) : update); }
      finally { channel.close(); }
      receivedBytes += update.byteLength;
    });
    return { receivedBytes };
  } finally { db.close(); doc.destroy(); }
}

function download(url: string, vector: Uint8Array, signal: AbortSignal, save: (update: Uint8Array) => Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const socket = new WebSocket(url); socket.binaryType = 'arraybuffer';
    let finished = false;
    let saving: Promise<void> | undefined;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      signal.removeEventListener('abort', abort);
      transfer.close(); socket.close();
      // Do not let an abort release the worker lifetime or close IndexedDB while
      // an already-started atomic write is still committing.
      void Promise.resolve(saving).then(() => { if (error) reject(error); else resolve(); }, reject);
    };
    const abort = () => finish(new Error('Background sync timed out or was interrupted.'));
    const transfer = new SyncTransfer(socket, {
      onFailure: error => finish(error),
      async onMessage(kind, data) {
        if (kind === 'sync') {
          const { update, vector } = unpackSync(data); Y.decodeStateVector(vector);
          saving = save(update);
          try { await saving; }
          catch (error) { throw new TransferError('storage', error instanceof Error ? error.message : 'Background storage failed.'); }
          // Let SyncTransfer acknowledge the complete response before closing.
          setTimeout(() => finish(), 0);
        } else if (kind !== 'update' && kind !== 'history-changed' && kind !== 'history-failure') throw new Error('Unexpected background sync response.');
      },
    });
    signal.addEventListener('abort', abort, { once: true });
    socket.onopen = () => { void transfer.send('sync-request', vector).catch(error => finish(error)); };
    socket.onmessage = event => transfer.receive(typeof event.data === 'string' ? event.data : new Uint8Array(event.data));
    socket.onerror = () => finish(new Error('Background sync could not connect.'));
    socket.onclose = () => finish(new Error('Background sync disconnected before receiving notes.'));
  });
}

/** One bounded attempt per browser opportunity; no timer loop or hidden retries. */
export async function runBackgroundSync(origin: string, build: string | null) {
  const db = await openBackgroundDatabase();
  try {
    const account = await db.get('account', 'active'); if (!account) return;
    const runId = crypto.randomUUID();
    await recordBackgroundEvent(account, { kind: 'wake', runId }, build);
    try { await navigator.locks.request('stow-background-sync', { ifAvailable: true }, async lock => {
      if (!lock) {
        await recordBackgroundEvent(account, { kind: 'skipped', runId, message: 'Another background refresh is running.' }, build);
        return;
      }
      const previous = await db.get('results', account.vaultId);
      const result = { attemptedAt: Date.now(), completedAt: previous?.completedAt };
      const started = performance.now();
      await db.put('results', result, account.vaultId);
      await recordBackgroundEvent(account, { kind: 'started', runId }, build);
      try {
        const { receivedBytes } = await refreshBackgroundAccount(account, origin, AbortSignal.timeout(45_000));
        await db.put('results', { ...result, completedAt: Date.now() }, account.vaultId);
        await recordBackgroundEvent(account, { kind: 'success', runId, durationMs: performance.now() - started, receivedBytes }, build);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await db.put('results', { ...result, error: message }, account.vaultId);
        await recordBackgroundEvent(account, { kind: 'failure', runId, durationMs: performance.now() - started, message }, build);
        throw error;
      }
    }); } finally {
      // Upload failures must not change a completed refresh into a sync failure.
      // Failed authentication keeps the evidence queued for a later signed-in visit.
      await uploadBackgroundLog(account, origin, 'background', build)
        .catch(error => console.warn('Background diagnostics remain on this device:', error));
    }
  } finally { db.close(); }
}
