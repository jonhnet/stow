import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Attachment } from './types';

export const ORIGINAL_CACHE_BYTES = 50 * 1024 * 1024;
export const THUMBNAIL_DIGEST_HEADER = 'X-Stow-Thumbnail-SHA256';
export type ImageLease = { url: string; release(): void };
type Original = { hash: string; blob: Blob; uploaded?: boolean };
type Metadata = { hash: string; size: number; uploaded: 0 | 1; lastViewed: number; thumbnailReady: boolean; previewable?: boolean; uploadGeneration?: string };
interface ImageDatabase extends DBSchema {
  blobs: { key: string; value: Original };
  metadata: { key: string; value: Metadata; indexes: { uploaded: number; lastViewed: number } };
  thumbnails: { key: string; value: { hash: string; blob: Blob } };
}
export type ImageProgress = { pendingUploads: number; thumbnailsRemaining: number; originalBytes: number };
export type ImageOptions = {
  vaultId: string;
  assertAccount(): void;
  isOnline(): boolean;
  signal: AbortSignal;
  onAuthError(message: string): void;
  onError(message: string | null): void;
  onChange?(): void;
  budgetBytes?: number;
  concurrency?: number;
  fetch?: typeof fetch;
  makeThumbnail?: (blob: Blob) => Promise<Blob>;
};

export function isImageAttachment(attachment: Pick<Attachment, 'type'>) {
  return attachment.type.toLowerCase().startsWith('image/');
}

/** The supported browser path also makes newly attached images browseable offline. */
export async function browserThumbnail(blob: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  try {
    const scale = Math.min(1, 512 / Math.max(bitmap.width, bitmap.height));
    const canvas = new OffscreenCanvas(Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale)));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('This browser could not create an image preview.');
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return await canvas.convertToBlob({ type: 'image/webp', quality: 0.75 });
  } finally { bitmap.close(); }
}

async function digest(bytes: ArrayBuffer) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

class WorkQueue {
  private active = 0;
  private waiting: { priority: number; start(): void }[] = [];
  constructor(private readonly limit: number) {}
  run<T>(priority: number, operation: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.waiting.push({ priority, start: () => {
        this.active++;
        void operation().then(resolve, reject).finally(() => { this.active--; this.drain(); });
      } });
      this.drain();
    });
  }
  private drain() {
    while (this.active < this.limit && this.waiting.length) {
      let next = 0;
      for (let i = 1; i < this.waiting.length; i++) if (this.waiting[i].priority > this.waiting[next].priority) next = i;
      this.waiting.splice(next, 1)[0].start();
    }
  }
}

/** One verified account, one database, and one queue for preview and original work. */
export class ImageStore {
  readonly ready: Promise<void>;
  readonly progress: ImageProgress = { pendingUploads: 0, thumbnailsRemaining: 0, originalBytes: 0 };
  private db!: IDBPDatabase<ImageDatabase>;
  private closed = false;
  private abort = new AbortController();
  private queue: WorkQueue;
  private loads = new Map<string, Promise<Blob | undefined>>();
  private urls = new Map<string, { url: string; references: number }>();
  private syncTask?: Promise<void>;
  private budget: number;
  private preparingCachedPreviews = true;
  private deletedBlobs = new Set<string>();
  private additions = new Map<string, number>();

  constructor(private readonly options: ImageOptions) {
    if (!/^[a-zA-Z0-9_-]{16,128}$/.test(options.vaultId)) throw new Error('Image storage requires a verified vault identity.');
    this.budget = options.budgetBytes ?? ORIGINAL_CACHE_BYTES;
    const concurrency = options.concurrency ?? 4;
    if (!Number.isFinite(this.budget) || this.budget < 0 || !Number.isInteger(concurrency) || concurrency < 1) throw new Error('Invalid image cache configuration.');
    this.queue = new WorkQueue(concurrency);
    options.signal.addEventListener('abort', () => this.close(), { once: true });
    this.ready = this.initialize();
    void this.ready.catch(error => this.report(error));
  }

  private check() {
    this.options.assertAccount();
    if (this.closed || this.options.signal.aborted) throw new Error('The image account is closed. Reload Stow to continue.');
  }
  private changed() { this.options.onChange?.(); }
  private report(error: unknown) {
    if (!this.closed) this.options.onError(error instanceof Error ? error.message : 'Image storage or transfer failed. Stow will retry.');
  }
  private async attempt<T>(operation: () => Promise<T>): Promise<T> {
    try { this.check(); await this.ready; this.check(); return await operation(); }
    catch (error) { this.report(error); throw error; }
  }

  private async initialize() {
    this.check();
    const db = await openDB<ImageDatabase>(`stow-images-${this.options.vaultId}`, 2, {
      upgrade(database, version, _next, transaction) {
        if (version === 0) database.createObjectStore('blobs', { keyPath: 'hash' });
        const metadata = database.createObjectStore('metadata', { keyPath: 'hash' });
        metadata.createIndex('uploaded', 'uploaded');
        metadata.createIndex('lastViewed', 'lastViewed');
        database.createObjectStore('thumbnails', { keyPath: 'hash' });
        if (version === 1) {
          // Upgrade only this account's existing records. A cursor never materializes
          // the complete original-image collection in one JavaScript array.
          void (async () => {
            let cursor = await transaction.objectStore('blobs').openCursor();
            while (cursor) {
              const { hash, blob, uploaded } = cursor.value;
              await metadata.put({ hash, size: blob.size, uploaded: uploaded ? 1 : 0, lastViewed: 0, thumbnailReady: false });
              await cursor.update({ hash, blob });
              cursor = await cursor.continue();
            }
          })().catch(() => transaction.abort());
        }
      },
      blocked: () => this.options.onError('Close other Stow tabs to finish upgrading this account’s image cache.'),
      blocking: () => { this.close(); this.options.onError('Image storage was upgraded in another tab. Reload Stow.'); },
      terminated: () => this.options.onError('The browser closed image storage. Reload Stow before adding images.'),
    });
    if (this.closed) { db.close(); return; }
    this.db = db;
    await this.trim();
  }

  private async request(hash: string, thumbnail: boolean, init: RequestInit = {}) {
    this.check();
    const headers = new Headers(init.headers);
    headers.set('X-Stow-Vault', this.options.vaultId);
    const response = await (this.options.fetch ?? fetch)(`/api/blobs/${hash}${thumbnail ? '/thumbnail' : ''}`, {
      ...init, headers, redirect: 'manual', signal: AbortSignal.any([this.abort.signal, this.options.signal, AbortSignal.timeout(30000)]),
    });
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400) || [401, 403, 409].includes(response.status)) {
      const message = 'Your image account could not be verified. Your pending images remain in this account. Reload after signing in.';
      this.options.onAuthError(message);
      throw new Error(message);
    }
    this.check();
    return response;
  }

  private async saveThumbnail(hash: string, blob: Blob) {
    this.check();
    if (this.deletedBlobs.has(hash)) return;
    const transaction = this.db.transaction(['thumbnails', 'metadata'], 'readwrite');
    const done = transaction.done;
    void done.catch(() => {});
    try {
      await transaction.objectStore('thumbnails').put({ hash, blob });
      const metadata = await transaction.objectStore('metadata').get(hash);
      if (metadata) await transaction.objectStore('metadata').put({ ...metadata, thumbnailReady: true });
      await done;
      if (metadata?.uploaded) await this.trim();
    } catch (error) { try { transaction.abort(); } catch { /* Already completed/aborted. */ } throw error; }
  }

  private loadThumbnail(attachment: Attachment, foreground = false): Promise<Blob | undefined> {
    return this.load(`thumbnail:${attachment.hash}`, foreground ? 2 : 0, async () => {
      if (this.deletedBlobs.has(attachment.hash)) return undefined;
      const cached = await this.db.get('thumbnails', attachment.hash);
      this.check();
      if (this.deletedBlobs.has(attachment.hash)) return undefined;
      if (cached) return cached.blob;
      // Existing same-account originals and pending uploads can provide previews
      // offline. Blob MIME types from the old cache are intentionally not trusted.
      const original = await this.db.get('blobs', attachment.hash);
      this.check();
      let blob: Blob;
      if (original) blob = await (this.options.makeThumbnail ?? browserThumbnail)(original.blob);
      else {
        if (!this.options.isOnline()) return undefined;
        const response = await this.request(attachment.hash, true);
        if (this.deletedBlobs.has(attachment.hash)) return undefined;
        if (!response.ok) throw new Error(response.status === 404 ? `The image “${attachment.name}” is not yet stored on the server.` : 'An image preview could not download. Stow will retry.');
        const expected = response.headers.get(THUMBNAIL_DIGEST_HEADER);
        if (!expected || !/^[a-f0-9]{64}$/.test(expected)) throw new Error('An image preview did not include its integrity checksum.');
        const bytes = await response.arrayBuffer();
        if (bytes.byteLength > 2 * 1024 * 1024 || await digest(bytes) !== expected) throw new Error('An image preview failed its integrity check.');
        blob = new Blob([bytes], { type: 'image/webp' });
      }
      this.check();
      if (this.deletedBlobs.has(attachment.hash)) return undefined;
      await this.saveThumbnail(attachment.hash, blob);
      return this.deletedBlobs.has(attachment.hash) ? undefined : blob;
    });
  }

  private load(key: string, priority: number, operation: () => Promise<Blob | undefined>) {
    const existing = this.loads.get(key);
    if (existing) return existing;
    const promise = this.queue.run(priority, async () => { this.check(); return await operation(); });
    this.loads.set(key, promise);
    void promise.finally(() => this.loads.delete(key)).catch(() => {});
    return promise;
  }

  private lease(key: string, blob: Blob): ImageLease {
    this.check();
    let entry = this.urls.get(key);
    if (!entry) { entry = { url: URL.createObjectURL(blob), references: 0 }; this.urls.set(key, entry); }
    entry.references++;
    let released = false;
    return { url: entry.url, release: () => {
      if (released) return;
      released = true;
      if (--entry.references === 0 && this.urls.get(key) === entry) {
        URL.revokeObjectURL(entry.url); this.urls.delete(key);
        if (key.startsWith('original:') && !this.closed) void this.trim().catch(error => this.report(error));
      }
    } };
  }

  thumbnailUrl(attachment: Attachment): Promise<ImageLease | undefined> {
    return this.attempt(async () => {
      if (!isImageAttachment(attachment)) throw new Error('This attachment does not have an image preview.');
      const blob = await this.loadThumbnail(attachment, true);
      return blob && !this.deletedBlobs.has(attachment.hash) ? this.lease(`thumbnail:${attachment.hash}`, blob) : undefined;
    });
  }

  originalUrl(attachment: Attachment): Promise<ImageLease | undefined> {
    return this.attempt(async () => {
      const blob = await this.load(`original:${attachment.hash}`, 3, async () => {
        if (this.deletedBlobs.has(attachment.hash)) return undefined;
        const cached = await this.db.get('blobs', attachment.hash);
        this.check();
        if (this.deletedBlobs.has(attachment.hash)) return undefined;
        if (cached) return cached.blob;
        if (!this.options.isOnline()) return undefined;
        const response = await this.request(attachment.hash, false);
        if (this.deletedBlobs.has(attachment.hash)) return undefined;
        if (!response.ok) throw new Error('The original file could not download. Try again when the server is available.');
        const bytes = await response.arrayBuffer();
        if (bytes.byteLength > 20 * 1024 * 1024 || await digest(bytes) !== attachment.hash) throw new Error('An original file failed its integrity check.');
        this.check();
        if (this.deletedBlobs.has(attachment.hash)) return undefined;
        const original = new Blob([bytes], { type: attachment.type });
        const thumbnailReady = !!await this.db.getKey('thumbnails', attachment.hash);
        if (this.deletedBlobs.has(attachment.hash)) return undefined;
        const transaction = this.db.transaction(['blobs', 'metadata'], 'readwrite');
        const done = transaction.done; void done.catch(() => {});
        try {
          const metadata = transaction.objectStore('metadata');
          const existing = await metadata.get(attachment.hash);
          await transaction.objectStore('blobs').put({ hash: attachment.hash, blob: original });
          // A local add may have saved these same bytes while the GET ran.
          // Downloading an older attachment does not acknowledge that new
          // source's pending upload or replace its durable generation.
          await metadata.put(existing?.uploaded === 0 ? { ...existing, lastViewed: Date.now() } :
            { hash: attachment.hash, size: original.size, uploaded: 1, lastViewed: Date.now(), thumbnailReady: existing?.thumbnailReady ?? thumbnailReady, previewable: isImageAttachment(attachment) });
          await done;
        } catch (error) { try { transaction.abort(); } catch { /* Already aborted. */ } throw error; }
        return original;
      });
      if (!blob || this.deletedBlobs.has(attachment.hash)) return undefined;
      this.check();
      const transaction = this.db.transaction('metadata', 'readwrite');
      const metadata = await transaction.store.get(attachment.hash);
      if (metadata) await transaction.store.put({ ...metadata, lastViewed: Date.now(), previewable: isImageAttachment(attachment) });
      await transaction.done;
      if (this.deletedBlobs.has(attachment.hash)) return undefined;
      const lease = this.lease(`original:${attachment.hash}`, blob);
      try { await this.trim(); return lease; } catch (error) { lease.release(); throw error; }
    });
  }

  add(file: File, publish?: (attachment: Pick<Attachment, 'hash' | 'name' | 'type' | 'size'>) => void): Promise<Pick<Attachment, 'hash' | 'name' | 'type' | 'size'>> {
    return this.attempt(() => this.queue.run(3, async () => {
      this.check();
      if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'].includes(file.type)) throw new Error('Choose a PNG, JPEG, GIF, WebP, or AVIF image.');
      if (!file.size || file.size > 20 * 1024 * 1024) throw new Error('Images must be nonempty and no larger than 20 MB.');
      const hash = await digest(await file.arrayBuffer());
      this.additions.set(hash, (this.additions.get(hash) ?? 0) + 1);
      try {
        const thumbnail = await (this.options.makeThumbnail ?? browserThumbnail)(file);
        this.check();
        // Keep fresh bytes reserved through publication of their source, even
        // when deletion cleanup runs while the local disk write is in flight.
        this.deletedBlobs.delete(hash);
        const transaction = this.db.transaction(['blobs', 'metadata', 'thumbnails'], 'readwrite');
        const done = transaction.done; void done.catch(() => {});
        try {
          await transaction.objectStore('blobs').put({ hash, blob: file });
          // A previous upload can have been reclaimed while this device was
          // offline. Every explicit add publishes ownership and bytes again.
          await transaction.objectStore('metadata').put({ hash, size: file.size, uploaded: 0, uploadGeneration: crypto.randomUUID(), lastViewed: Date.now(), thumbnailReady: true, previewable: true });
          await transaction.objectStore('thumbnails').put({ hash, blob: thumbnail });
          await done;
        } catch (error) { try { transaction.abort(); } catch { /* Already aborted. */ } throw error; }
        const attachment = { hash, name: file.name, type: file.type, size: file.size };
        publish?.(attachment);
        await this.trim();
        return attachment;
      } finally {
        const remaining = this.additions.get(hash)! - 1;
        if (remaining) this.additions.set(hash, remaining); else this.additions.delete(hash);
      }
    }));
  }

  sync(attachments: Iterable<Attachment>): Promise<void> {
    if (this.syncTask) return this.syncTask;
    const owners = new Map<string, Set<string>>();
    const references = new Map<string, Attachment>();
    for (const attachment of attachments) {
      references.set(attachment.hash, attachment);
      const sources = owners.get(attachment.hash) ?? new Set<string>();
      sources.add(attachment.noteId); owners.set(attachment.hash, sources);
    }
    const task = this.attempt(async () => {
      const pending = (await this.db.getAllFromIndex('metadata', 'uploaded', 0)).filter(metadata => references.has(metadata.hash) && !this.deletedBlobs.has(metadata.hash));
      const thumbnails = new Set(await this.db.getAllKeys('thumbnails'));
      // Convert every existing account-local original to a preview before first
      // eviction, including images no longer referenced by a live note/history.
      const unpreviewed = this.preparingCachedPreviews
        ? (await this.db.getAll('metadata')).filter(entry => !entry.thumbnailReady && entry.previewable !== false && !this.deletedBlobs.has(entry.hash))
        : [];
      const candidates = new Map([...references.values()].filter(isImageAttachment).map(attachment => [attachment.hash, attachment]));
      // The earlier cache accepted only images, including blobs without a MIME
      // type. Keep those previews, but never decode a known non-image attachment.
      for (const entry of unpreviewed) if (!references.has(entry.hash)) candidates.set(entry.hash, {
        id: entry.hash, hash: entry.hash, noteId: '', name: 'Saved image', type: '', size: entry.size,
      });
      const missing = [...candidates.values()].filter(attachment => !thumbnails.has(attachment.hash) && !this.deletedBlobs.has(attachment.hash));
      this.progress.pendingUploads = pending.length;
      this.progress.thumbnailsRemaining = missing.length;
      this.changed();
      const tasks: Promise<unknown>[] = [];
      if (this.options.isOnline()) for (const { hash, uploadGeneration } of pending) tasks.push(this.queue.run(2, async () => {
        this.check();
        if (this.deletedBlobs.has(hash)) return;
        const entry = await this.db.get('blobs', hash);
        if (this.deletedBlobs.has(hash)) return;
        if (!entry) throw new Error('A pending original file is missing from local storage.');
        const response = await this.request(hash, false, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'X-Stow-Blob-Sources': JSON.stringify([...owners.get(hash)!]) }, body: entry.blob });
        if (this.deletedBlobs.has(hash)) return;
        if (!response.ok) throw new Error('A file is saved locally but could not upload. Stow will retry.');
        const transaction = this.db.transaction('metadata', 'readwrite');
        const metadata = await transaction.store.get(hash);
        // Identical bytes can be explicitly added to a new source while this
        // request runs, including in another tab. That add still needs its own
        // ownership upload; this acknowledgement covers only the saved version
        // selected when this sync batch began. Older records have no generation.
        const acknowledged = metadata?.uploaded === 0 && metadata.uploadGeneration === uploadGeneration;
        if (acknowledged) await transaction.store.put({ ...metadata, uploaded: 1 });
        await transaction.done;
        if (acknowledged) { this.progress.pendingUploads--; this.changed(); }
      }));
      for (const attachment of missing) tasks.push(this.loadThumbnail(attachment).then(blob => {
        if (blob) { this.progress.thumbnailsRemaining--; this.changed(); }
      }));
      const results = await Promise.allSettled(tasks);
      // A corrupt acknowledged cached original cannot permanently defeat the
      // cache budget. Its decode error stays visible; server originals are intact.
      this.preparingCachedPreviews = false;
      await this.trim();
      const failed = results.find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      this.options.onError(null);
    });
    this.syncTask = task;
    void task.finally(() => { if (this.syncTask === task) this.syncTask = undefined; }).catch(() => {});
    return task;
  }

  /** Invalidate work immediately; durable removal is retried by normal image sync. */
  setDeletedBlobs(candidates: ReadonlySet<string>, retained: ReadonlySet<string>) {
    this.deletedBlobs = new Set([...candidates].filter(hash => !retained.has(hash)));
    for (const [key, entry] of this.urls) if (this.deletedBlobs.has(key.slice(key.indexOf(':') + 1))) {
      URL.revokeObjectURL(entry.url); this.urls.delete(key);
    }
  }

  pruneDeleted(): Promise<void> {
    if (!this.deletedBlobs.size) return Promise.resolve();
    return this.attempt(async () => {
      const transaction = this.db.transaction(['blobs', 'metadata', 'thumbnails'], 'readwrite');
      const done = transaction.done; void done.catch(() => {});
      try {
        for (const hash of this.deletedBlobs) {
          if (!this.deletedBlobs.has(hash) || this.additions.has(hash)) continue;
          await transaction.objectStore('blobs').delete(hash);
          await transaction.objectStore('metadata').delete(hash);
          await transaction.objectStore('thumbnails').delete(hash);
        }
        await done;
      } catch (error) { try { transaction.abort(); } catch { /* Already aborted. */ } throw error; }
      await this.trim();
    });
  }

  /** Pending uploads are never replaceable. Object URLs retain their own Blob. */
  private async trim() {
    this.check();
    const transaction = this.db.transaction(['metadata', 'blobs'], 'readwrite');
    const done = transaction.done; void done.catch(() => {});
    try {
      const entries = await transaction.objectStore('metadata').index('lastViewed').getAll();
      let bytes = entries.reduce((sum, entry) => sum + (entry.uploaded ? entry.size : 0), 0);
      for (const entry of entries) {
        if (bytes <= this.budget) break;
        if (!entry.uploaded || (this.preparingCachedPreviews && !entry.thumbnailReady && entry.previewable !== false)) continue;
        await transaction.objectStore('blobs').delete(entry.hash);
        await transaction.objectStore('metadata').delete(entry.hash);
        bytes -= entry.size;
      }
      await done;
      this.progress.originalBytes = bytes;
      this.progress.pendingUploads = entries.filter(entry => !entry.uploaded).length;
      this.changed();
    } catch (error) { try { transaction.abort(); } catch { /* Already aborted. */ } throw error; }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.abort.abort();
    this.db?.close();
    for (const entry of this.urls.values()) URL.revokeObjectURL(entry.url);
    this.urls.clear();
  }
}
