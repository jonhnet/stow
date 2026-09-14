import * as Y from 'yjs';
import { openPersistenceDatabase, type PersistenceConnection } from './persistence-database';
import { browserPersistenceWriter } from './persistence-worker-client';
import type { PersistenceWriter } from './persistence-write';
import { startupCount, startupMark } from './startup-diagnostics';
import { enforcePermanentDeletions, PERMANENT_DELETION_ORIGIN } from './deletion';
import { isEmptyUpdate, applyStoredUpdates } from './yjs-updates';
import type { PendingEdit } from './history-types';
import type { EditOwnership } from './edit-ownership';
import { redactPendingEdit } from './edit-draft';

export interface EditRecovery {
  owner: string;
  ownership: EditOwnership;
  getPending(): PendingEdit | null;
  onPendingChange(listener: () => void): () => void;
  recover(pending: PendingEdit): void;
}

interface PersistenceOptions {
  onError: (error: Error) => void;
  onPending?: (count: number) => void;
  databaseName: string;
  edits?: EditRecovery;
  writer?: PersistenceWriter;
}

/** Append CRDT updates locally, reporting durability only after transaction completion. */
export class LocalPersistence {
  readonly ready: Promise<void>;
  private synchronized = false;
  get hasSynchronized() { return this.synchronized; }
  private db?: PersistenceConnection;
  private writer: PersistenceWriter;
  private pending: Uint8Array[] = [];
  private initialized = false;
  private destroyed = false;
  private writing?: Promise<void>;
  private closing?: Promise<void>;
  private flushScheduled = false;
  private compactRequested = 0;
  private compactCompleted = 0;
  private draft: PendingEdit | null = null;
  private draftVersion = 0;
  private draftCompleted = 0;
  private retired = new Set<string>();
  private releaseOwner?: () => void;
  private stopDrafts?: () => void;

  constructor(private readonly doc: Y.Doc, private readonly options: PersistenceOptions) {
    this.writer = options.writer ?? browserPersistenceWriter(options.databaseName);
    this.doc.on('afterTransactionCleanup', this.prepareUpdate);
    if (options.edits) {
      this.draft = options.edits.getPending();
      if (this.draft) this.draftVersion++;
      this.stopDrafts = options.edits.onPendingChange(() => {
        this.draft = options.edits!.getPending();
        this.draftVersion++;
        this.notifyPending();
        this.scheduleFlush();
      });
    }
    // Preserve any state the caller created before constructing this adapter, too.
    const initial = Y.encodeStateAsUpdate(doc);
    if (!isEmptyUpdate(initial)) {
      this.pending.push(initial);
    }
    this.notifyPending();
    this.ready = this.initialize();
    // Keep a rejection observable by callers without creating an unhandled rejection
    // if their UI subscribes after IndexedDB has already failed.
    void this.ready.catch(() => {});
  }

  private notifyPending() {
    try { this.options.onPending?.(this.pending.length + Number(this.draftVersion > this.draftCompleted || this.retired.size > 0)); } catch { /* UI callbacks cannot interrupt writes. */ }
  }

  private report(reason: unknown): Error {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    try { this.options.onError(error); } catch { /* Preserve the storage failure itself. */ }
    return error;
  }

  private prepareUpdate = (transaction: Y.Transaction) => {
    // Yjs checks update listeners immediately after afterTransactionCleanup.
    // Suppress serialization of our own load, while retaining normal updates
    // from observer-triggered transactions (including deletion enforcement).
    if (transaction.origin === this || this.destroyed) this.doc.off('update', this.onUpdate);
    else this.doc.on('update', this.onUpdate);
  };

  private onUpdate = (update: Uint8Array, origin: unknown, _doc: Y.Doc, transaction: Y.Transaction) => {
    if (origin === this || this.destroyed) return;
    const deletedNotes = this.doc.share.get('deletedNotes');
    if (origin === PERMANENT_DELETION_ORIGIN || (deletedNotes && transaction.changed.has(deletedNotes))) this.compactRequested++;
    this.pending.push(update.slice());
    this.notifyPending();
    this.scheduleFlush();
  };

  private scheduleFlush() {
    if (this.initialized && !this.flushScheduled) {
      this.flushScheduled = true;
      // A current edit and its completed modification time can be separate
      // synchronous transactions. Persist their complete batch together.
      queueMicrotask(() => {
        this.flushScheduled = false;
        if (!this.destroyed && this.hasPendingWork()) void this.flush().catch(() => {});
      });
    }
  }

  private async initialize() {
    try {
      if (this.options.edits) {
        this.releaseOwner = await this.options.edits.ownership.acquire(this.options.edits.owner, false) ?? undefined;
        if (!this.releaseOwner) throw new Error('Could not acquire this page’s edit recovery lock.');
      }
      startupMark('idb-open-start');
      this.db = await openPersistenceDatabase(this.options.databaseName,
        () => { this.db?.close(); this.report(new Error('Local storage needs to upgrade. Reload Stow before editing further.')); },
        () => this.report(new Error('The browser closed local storage. Reload Stow to reconnect.')));
      startupMark('idb-open-end');
      startupMark('idb-read-start');
      const transaction = this.db.transaction(['updates', 'maintenance'], 'readonly');
      const done = transaction.done;
      void done.catch(() => {});
      const updatesStore = transaction.objectStore('updates');
      const updates = await updatesStore.getAll();
      const tail = (await updatesStore.openKeyCursor(null, 'prev'))?.key;
      const validated = tail === undefined || tail === await transaction.objectStore('maintenance').get('validatedThrough');
      this.synchronized = await transaction.objectStore('maintenance').get('initialSyncComplete') === 1;
      await done;
      startupMark('idb-read-end');
      startupCount('updateCount', updates.length);
      startupCount('updateBytes', updates.reduce((bytes, update) => bytes + update.byteLength, 0));
      if (updates.length) {
        startupMark('updates-apply-start');
        applyStoredUpdates(this.doc, updates, this);
        startupMark('updates-apply-end');
      }
      // A stale tab may have appended erased payloads after another tab's
      // deletion snapshot. Reopening sanitizes that log before reporting ready.
      if (this.doc.getMap('deletedNotes').size && !validated) this.compactRequested++;

      await this.recoverOrphans();

      // Updates may arrive during opening/loading, including from another tab.
      // Drain them before ready resolves; the final check and flag are synchronous.
      startupMark('idb-drain-start');
      do { await this.writePending(); } while (this.hasPendingWork());
      startupMark('idb-drain-end');
      this.initialized = true;
    } catch (reason) {
      this.db?.close();
      this.releaseOwner?.(); this.releaseOwner = undefined;
      throw this.report(reason instanceof Error && reason.name === 'VersionError' ? new Error('This browser has an older Stow storage format. Clear this account’s local cache before opening a freshly imported vault.') : reason);
    }
  }

  private hasPendingWork() { return this.pending.length > 0 || this.compactRequested > this.compactCompleted || this.draftVersion > this.draftCompleted || this.retired.size > 0; }

  private async loadStoredUpdates() {
    const updates = await this.db!.getAll('updates');
    if (updates.length) applyStoredUpdates(this.doc, updates, this);
  }

  private async recoverOrphans() {
    const recovery = this.options.edits;
    if (!recovery) return;
    for (const owner of await this.db!.getAllKeys('pendingEdits')) {
      if (owner === recovery.owner) continue;
      const release = await recovery.ownership.acquire(owner, true);
      if (!release) continue;
      try {
        // The writer may have finished while we were acquiring its lock. Read
        // again, and include durable deletions/edits from other tabs first.
        await this.loadStoredUpdates();
        const draft = await this.db!.get('pendingEdits', owner);
        if (!draft) continue;
        const kept = redactPendingEdit(draft, this.doc.getMap('deletedNotes'));
        if (kept) recovery.recover(kept);
        this.retired.add(owner);
        this.notifyPending();
        // Recovered modification times and retirement commit together before
        // releasing ownership. Failed transactions retain the original metadata.
        await this.writePending();
      } finally { release(); }
    }
  }

  private async writePending() {
    if (!this.db) throw new Error('Local storage is not open.');
    while (this.hasPendingWork()) {
      const batch = this.pending.slice();
      const compactVersion = this.compactRequested;
      const forceCompact = compactVersion > this.compactCompleted;
      const draftVersion = this.draftVersion, draft = this.draft;
      const retired = [...this.retired];
      const result = await this.writer.write(this.db, {
        batch, forceCompact, vector: Y.encodeStateVector(this.doc), retired,
        ...(this.options.edits && draftVersion > this.draftCompleted ? { edit: {
          owner: this.options.edits.owner,
          draft: draft && redactPendingEdit(draft, this.doc.getMap('deletedNotes')),
        } } : {}),
      }, () => startupMark('idb-compact-start'));
      if (result.compaction) startupMark('idb-compact-end');
      if (result.correction && !isEmptyUpdate(result.correction)) Y.applyUpdate(this.doc, result.correction, this);
      // Keep failed batches queued, and count in-flight writes until commit.
      this.pending.splice(0, batch.length);
      this.draftCompleted = draftVersion;
      retired.forEach(owner => this.retired.delete(owner));
      // A cleanup update arriving during this transaction requests another
      // compaction; acknowledging this one cannot consume that newer request.
      this.compactCompleted = compactVersion;
      this.notifyPending();
    }
  }

  private flush(): Promise<void> {
    if (this.writing) return this.writing;
    let failed = false;
    const task = (async () => {
      try { await this.writePending(); }
      catch (reason) { failed = true; throw this.report(reason); }
      finally {
        this.writing = undefined;
        // An update may have arrived after the drain's final check, while its
        // promise was settling. Do not leave that update waiting for another edit.
        if (!failed && this.hasPendingWork() && !this.destroyed) void this.flush().catch(() => {});
      }
    })();
    this.writing = task;
    void task.catch(() => {});
    return task;
  }

  /** Wait until all edits observed so far are committed. */
  async whenDurable(): Promise<void> {
    await this.ready;
    do { await this.flush(); } while (this.hasPendingWork());
  }

  /** Remember a complete server snapshot, including a legitimately empty vault.
   * This local marker follows durable current data and never appends a CRDT edit. */
  async markSynchronized(): Promise<void> {
    await this.whenDurable();
    if (this.synchronized) return;
    try {
      const transaction = this.db!.transaction('maintenance', 'readwrite');
      const done = transaction.done; void done.catch(() => {});
      // Another tab may already have committed the same account-scoped marker.
      if (await transaction.store.get('initialSyncComplete') !== 1) await transaction.store.put(1, 'initialSyncComplete');
      await done;
      this.synchronized = true;
    } catch (reason) { throw this.report(reason); }
  }

  /** Stop listening, flush captured edits, then close; reject if durability failed. */
  destroy(): Promise<void> {
    this.closing ??= (async () => {
      try {
        // Startup may still be recovering another writer. Keep observing its
        // modification timestamps until ready: retirement must not commit alone.
        await this.ready;
        this.destroyed = true;
        this.doc.off('afterTransactionCleanup', this.prepareUpdate);
        this.doc.off('update', this.onUpdate);
        this.stopDrafts?.();
        do { await this.flush(); } while (this.hasPendingWork());
      } finally {
        this.destroyed = true;
        this.doc.off('afterTransactionCleanup', this.prepareUpdate);
        this.doc.off('update', this.onUpdate);
        this.stopDrafts?.();
        this.writer.close(); this.db?.close();
        this.releaseOwner?.(); this.releaseOwner = undefined;
      }
    })();
    void this.closing.catch(() => {});
    return this.closing;
  }
}
