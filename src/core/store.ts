import { SyncTransfer, TransferError, unpackSync } from './sync-transfer';
import { SYNC_PROTOCOL_VERSION } from './protocol-version';
import { CURRENT_SCHEMA } from './current-schema';
import { IdleUpdateReload, parseSyncRejection, type SyncRejection } from './client-update';
import { useSyncExternalStore } from 'react';
import * as Y from 'yjs';
import { LocalPersistence } from './persistence';
import { browserEditOwnership } from './edit-ownership';
import { TabSync } from './tab-sync';
import { Vault } from './vault';
import { ImageStore, type ImageProgress } from './images';
import { getPermanentDeletionBlobCandidates, PERMANENT_DELETION_ORIGIN } from './deletion';
import { ACCOUNT_KEY, cachedAccount, parseAccount, rememberAccount, type Account, type AuthMode } from './account';
import type { Attachment, Label, Note, SyncStatus } from './types';
import type { ArchivedHistoryCleanup, VaultStorage } from './storage-types';
import type { HistoryBoundary, HistoryPage, SavedVersion, HistoryExport } from './server-history-types';
import { startupAccount, startupCount, startupMark } from './startup-diagnostics';

type Access = 'opening' | 'ready' | 'locked' | 'blocked';
export interface Snapshot {
  notes: Note[]; labels: Label[]; historyVersion: number; status: SyncStatus; ready: boolean;
  access: Access; authMode?: AuthMode; user?: string; canReload: boolean;
  error: string | null; historyError: string | null; accessMessage: string | null;
  canUndo: boolean; canRedo: boolean; pending: number; localPending: number;
  images: ImageProgress;
  syncRejection: SyncRejection | null; automaticReload: boolean;
}
class SessionError extends Error {
  constructor(message: string, readonly authMode?: AuthMode, readonly locked = false) { super(message); }
}
class NetworkError extends Error {}
class ServerUnavailableError extends Error {}
const encode = (bytes: Uint8Array) => {
  let text = '';
  for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(text);
};
const decode = (text: string) => Uint8Array.from(atob(text), c => c.charCodeAt(0));

class StowStore {
  // This document remains bound to one account for the entire page lifetime.
  vault = new Vault();
  private account?: Account;
  private access: Access = 'opening';
  private authMode?: AuthMode;
  private accessMessage: string | null = null;
  private listeners = new Set<() => void>();
  private status: SyncStatus = 'connecting';
  private ready = false;
  private error: string | null = null;
  private historyError: string | null = null;
  private historyVersion = 0;
  private historyBoundaries: HistoryBoundary[] = [];
  private historyPreviews = new Map<symbol, Attachment[]>();
  private localError: string | null = null;
  private imageError: string | null = null;
  private localPending = 0;
  private imageWrites = 0;
  private socket?: WebSocket;
  private transfer?: SyncTransfer;
  private syncStopped = false;
  private syncRejection: SyncRejection | null = null;
  private updateReload?: IdleUpdateReload;
  private composing = false;
  private lastUpload: Promise<void> = Promise.resolve();
  private historyRequests = new Set<Promise<void>>();
  private retry?: ReturnType<typeof setTimeout>;
  private retryDelay = 1000;
  private requests = new Set<string>();
  private snapshot!: Snapshot;
  private persistence?: LocalPersistence;
  private channel?: BroadcastChannel;
  private images?: ImageStore;
  private accountAbort = new AbortController();
  private syncingImages = false;
  private imagesDirty = false;
  private imageTimer?: ReturnType<typeof setTimeout>;
  private connecting = false;
  private outgoingUpdates: Uint8Array[] = [];
  private broadcastUpdates: Uint8Array[] = [];
  private durableBroadcasts: unknown[] = [];
  private broadcasting = false;
  private replicationScheduled = false;
  private parked = false;

  constructor() {
    window.addEventListener('compositionstart', () => { this.composing = true; }, true);
    window.addEventListener('compositionend', () => { this.composing = false; }, true);
    this.refresh();
    this.vault.onHistoryBoundary(boundary => {
      // These are disposable hints, never an offline upload queue. Current edits
      // have already entered the durable CRDT update path before this callback.
      if (this.access !== 'ready' || this.status !== 'online' || this.socket?.readyState !== WebSocket.OPEN) return;
      this.historyBoundaries.push(boundary);
      if (!this.replicationScheduled) {
        this.replicationScheduled = true;
        queueMicrotask(() => this.flushReplication());
      }
    });
    for (const event of ['stack-item-added', 'stack-item-popped', 'stack-item-updated', 'stack-cleared'] as const) this.vault.undoManager.on(event, () => { this.updateDeletedImages(); this.scheduleImages(); this.refresh(); });
    window.addEventListener('online', () => { this.retryDelay = 1000; void this.connect(); });
    window.addEventListener('offline', () => {
      if (this.access === 'blocked' || this.access === 'locked') return;
      this.closeSocket(); this.status = 'offline'; this.refresh();
    });
    document.addEventListener('visibilitychange', () => {
      if (this.parked) return;
      if (document.visibilityState === 'visible') void this.connect();
      else this.vault.finishEdit();
    });
    window.addEventListener('blur', () => { if (!this.parked) this.vault.finishEdit(); });
    window.addEventListener('pagehide', event => {
      if (this.parked) return;
      this.vault.finishEdit();
      this.flushReplication();
      this.parked = true;
      this.updateReload?.stop();
      this.access = 'opening'; this.ready = false;
      this.closeSocket(); this.channel?.close(); this.channel = undefined; this.durableBroadcasts = [];
      clearTimeout(this.retry); clearTimeout(this.imageTimer);
      const closing = this.persistence?.destroy();
      void closing?.then(() => {
        // A browser can retain an old page while collecting its DOM or keeping
        // navigation history. Do not keep its complete Yjs graph rooted in the
        // module singleton during that interval. Failed writes retain the graph.
        this.accountAbort.abort(); this.images?.close(); this.images = undefined;
        this.vault.doc.off('update', this.onUpdate);
        this.vault.destroy(); this.vault = new Vault();
        this.persistence = undefined;
        this.outgoingUpdates = []; this.broadcastUpdates = []; this.historyPreviews.clear();
        this.refresh();
      }).catch(() => {}); // Persistence reports failures and keeps drafts recoverable.
    });
    window.addEventListener('pageshow', event => {
      if (!event.persisted) return;
      // A parked page released its writer lock, so another tab may have recovered
      // its draft. Reopen from durable storage rather than resume the old writer.
      this.access = 'opening'; this.ready = false; this.refresh();
      void (this.persistence?.destroy() ?? Promise.resolve()).then(() => location.reload()).catch(() => {
        this.accessMessage = 'Local storage failed while leaving this page. Download a vault backup before reloading.';
        this.localError = 'Your unsaved notes remain in this page.'; this.refresh();
      });
    });
    window.addEventListener('storage', event => {
      if (event.key !== ACCOUNT_KEY && event.key !== null) return;
      if (!this.account || this.access === 'blocked') return;
      try {
        if (cachedAccount()?.vaultId !== this.account.vaultId) this.block('The account changed in another tab. Your edits remain in this account’s local vault. Reload to open the current account.');
      } catch (error) { this.block(error instanceof Error ? error.message : 'Could not verify the account in this browser.'); }
    });
    // Also catch a proxy account change while the original WebSocket stays open.
    setInterval(() => { if (this.access === 'ready') void this.connect(); }, 15000);
    void this.connect();
  }

  private fail(message: string) { this.error = message; this.refresh(); }
  private onUpdate = (update: Uint8Array, origin: unknown) => {
    this.updateDeletedImages();
    if (origin === 'broadcast' && this.vault.notes.size > 0) this.ready = true;
    if (this.access === 'ready') {
      if (origin !== 'broadcast') this.broadcastUpdates.push(update);
      if (origin !== 'remote') this.outgoingUpdates.push(update);
      if (!this.replicationScheduled) {
        this.replicationScheduled = true;
        queueMicrotask(() => this.flushReplication());
      }
    }
    this.refresh();
    this.scheduleImages();
  };

  private refresh = () => {
    const visible = this.access === 'ready';
    this.snapshot = {
      notes: visible ? this.vault.getNotes() : [], historyVersion: visible ? this.historyVersion : 0,
      labels: visible ? this.vault.getLabels() : [],
      status: this.status, ready: this.ready, access: this.access, authMode: this.authMode,
      user: visible ? this.account?.user : undefined, accessMessage: this.accessMessage,
      error: this.localError ?? this.imageError ?? this.error, historyError: visible ? this.historyError : null,
      canReload: this.localPending === 0 && this.imageWrites === 0 && !this.localError,
      syncRejection: this.syncRejection, automaticReload: this.updateReload?.automatic ?? false,
      canUndo: visible && this.vault.undoManager.undoStack.length > 0,
      canRedo: visible && this.vault.undoManager.redoStack.length > 0,
      pending: this.requests.size + this.localPending, localPending: this.localPending,
      images: visible && this.images ? { ...this.images.progress } : { pendingUploads: 0, thumbnailsRemaining: 0, originalBytes: 0 },
    };
    this.listeners.forEach(listener => listener());
  };
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.snapshot;
  private flushReplication() {
    this.replicationScheduled = false;
    const broadcast = this.broadcastUpdates.splice(0);
    const outgoing = this.outgoingUpdates.splice(0);
    const boundaries = this.historyBoundaries.splice(0);
    if (this.access !== 'ready') return;
    // Deliver current data before any hint asking the server to save a version.
    if (broadcast.length) this.broadcastAfterSave(Y.mergeUpdates(broadcast));
    if (outgoing.length) this.sendUpdate(Y.mergeUpdates(outgoing));
    for (const boundary of boundaries) this.sendHistoryHint('history-boundary', boundary);
  }

  private broadcastAfterSave(message: unknown) {
    this.durableBroadcasts.push(message);
    this.flushBroadcasts();
  }

  private flushBroadcasts() {
    if (this.broadcasting || !this.durableBroadcasts.length || !this.channel) return;
    this.broadcasting = true;
    const channel = this.channel;
    const batch = this.durableBroadcasts.slice();
    let failed = false;
    // A second tab may compact the shared log as soon as it receives an edit.
    // Its worker must already be able to see the originating tab's Undo ranges.
    void this.persistence?.whenDurable().then(() => {
      if (this.access === 'ready' && this.channel === channel) {
        for (const message of batch) channel.postMessage(message);
        this.durableBroadcasts.splice(0, batch.length);
      }
    }).catch(() => { failed = true; }).finally(() => {
      this.broadcasting = false;
      if (!failed && this.access === 'ready' && this.channel === channel) this.flushBroadcasts();
    });
    // Failed writes keep these messages queued as well as the local updates.
    // Publishing only the next edit would leave peers missing its dependencies.
  }

  private closeSocket() {
    this.historyBoundaries = []; this.historyRequests.clear();
    const transfer = this.transfer; this.transfer = undefined;
    const socket = this.socket;
    this.socket = undefined;
    transfer?.close(); socket?.close();
  }

  private block(message: string) {
    this.updateReload?.stop(); this.updateReload = undefined; this.syncRejection = null;
    this.vault.finishEdit();
    this.access = 'blocked';
    this.accessMessage = message;
    this.status = 'locked';
    clearTimeout(this.retry); clearTimeout(this.imageTimer);
    this.closeSocket();
    this.accountAbort.abort();
    this.channel?.close(); this.channel = undefined; this.durableBroadcasts = [];
    this.historyPreviews.clear();
    this.images?.close();
    this.outgoingUpdates = []; this.broadcastUpdates = []; this.historyPreviews.clear();
    this.refresh();
  }

  private async session(): Promise<{ account: Account; rejection: SyncRejection | null }> {
    startupMark('session-start');
    let response: Response;
    try { response = await fetch('/api/session', { cache: 'no-store', redirect: 'manual', headers: { 'X-Stow-Sync-Protocol': SYNC_PROTOCOL_VERSION, 'X-Stow-Schema': CURRENT_SCHEMA }, signal: AbortSignal.any([this.accountAbort.signal, AbortSignal.timeout(10000)]) }); }
    catch { throw new NetworkError('Could not reach the server.'); }
    startupMark('session-response');
    startupCount('sessionStatus', response.status);
    // A proxy login redirect is an authentication boundary, not an offline signal.
    // Following it could turn the destination's CORS denial into a network error.
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      throw new SessionError('The proxy requires sign in. Sign in through the authentication proxy, then reload Stow.', 'proxy', true);
    }
    if ([500, 502, 503, 504].includes(response.status)) {
      await response.body?.cancel();
      throw new ServerUnavailableError(`The server is temporarily unavailable (HTTP ${response.status}). Retrying…`);
    }
    let value: unknown;
    try { value = await response.json(); }
    catch { throw new SessionError('The server returned an invalid session. Check the authentication proxy, then reload Stow.'); }
    startupMark('session-json');
    const payload = value as { authenticated?: unknown; required?: unknown; authMode?: unknown; error?: unknown; syncRejection?: unknown } | null;
    const authMode = payload?.authMode === 'proxy' || payload?.authMode === 'password' ? payload.authMode : undefined;
    if (!response.ok) throw new SessionError(authMode === 'proxy' ? 'The proxy did not provide a trusted user identity. Sign in through the proxy, then reload Stow.' : 'The server could not verify your account. Reload after signing in.', authMode, response.status === 401 || response.status === 403);
    if (!payload || typeof payload.authenticated !== 'boolean' || typeof payload.required !== 'boolean' || !authMode) throw new SessionError('The server returned an invalid session. Reload after checking the server configuration.');
    if (!payload.authenticated) throw new SessionError(authMode === 'password' ? 'Sign in to open your notes.' : 'Sign in through the authentication proxy, then reload Stow.', authMode, true);
    try {
      const account = parseAccount(value);
      startupAccount(account.vaultId);
      startupMark('account-verified');
      return { account, rejection: parseSyncRejection(payload.syncRejection) };
    }
    catch (error) { throw new SessionError((error as Error).message, authMode); }
  }

  private async openAccount(account: Account) {
    startupMark('account-opening');
    const databaseName = `stow-notes-${account.vaultId}`;
    const ownership = browserEditOwnership(databaseName);
    this.account = account;
    this.authMode = account.authMode;
    this.persistence = new LocalPersistence(this.vault.doc, {
      databaseName,
      undo: {
        manager: this.vault.undoManager, ownership,
        preferredOwner: history.state?.stowUndo?.databaseName === databaseName ? history.state.stowUndo.owner : undefined,
        onOwner: owner => history.replaceState({ ...history.state, stowUndo: { databaseName, owner } }, ''),
      },
      edits: {
        owner: crypto.randomUUID(), ownership,
        getPending: () => this.vault.getPendingEdit(),
        onPendingChange: listener => this.vault.onPendingEditChange(listener),
        recover: draft => this.vault.recoverPendingEdit(draft),
      },
      onError: () => { this.localError = 'Local storage failed. Keep this tab open and export your notes. Offline changes may not survive closing it.'; this.refresh(); },
      onPending: count => { this.localPending = count; if (count === 0) { this.localError = null; this.flushBroadcasts(); } this.refresh(); },
    });
    this.images = new ImageStore({
      vaultId: account.vaultId,
      assertAccount: () => {
        if (this.account?.vaultId !== account.vaultId || this.accountAbort.signal.aborted || this.access === 'blocked' || this.access === 'locked') {
          throw new Error('The active account changed. Reload Stow before accessing images.');
        }
      },
      isOnline: () => this.access === 'ready' && this.status === 'online',
      signal: this.accountAbort.signal,
      onAuthError: message => {
        try { localStorage.removeItem(ACCOUNT_KEY); }
        catch { this.error = 'Browser storage could not clear the previous account. Restore browser storage before reopening Stow.'; }
        this.block(message);
      },
      onError: message => { this.imageError = message; this.refresh(); },
      onChange: () => this.refresh(),
    });
    void this.images.ready.catch(() => {});
    await this.persistence.ready;
    startupMark('local-ready');
    if (this.access === 'blocked' || this.parked) return;
    // Loading does not replicate update bytes. Subscribe after persistence has
    // applied the local log, then perform the initial bookkeeping explicitly.
    this.vault.doc.on('update', this.onUpdate);
    this.updateDeletedImages();
    this.channel = new BroadcastChannel(`stow-vault-${account.vaultId}`);
    const tabs = new TabSync(this.vault.doc, message => this.broadcastAfterSave(message));
    this.channel.addEventListener('message', event => {
      if (this.access !== 'ready') return;
      try {
        tabs.receive(event.data);
      }
      catch { this.fail('Could not read an update from another tab.'); }
    });
    // A new local database says nothing about whether the server vault is empty.
    // Existing notes remain usable immediately, including while offline.
    this.ready = this.persistence.hasSynchronized || this.vault.notes.size > 0;
    this.access = 'ready';
    this.accessMessage = null;
    startupMark('broadcast-encode-start');
    const broadcast = tabs.hello();
    startupMark('broadcast-encode-end');
    startupCount('broadcastBytes', broadcast.vector.byteLength);
    this.channel.postMessage(broadcast);
    startupMark('broadcast-posted');
    startupMark('snapshot-start');
    this.refresh();
    startupMark('snapshot-end');
    startupCount('notes', this.snapshot.notes.length);
    startupCount('items', this.vault.items.size);
    this.scheduleImages();
    startupMark('account-opened');
    void navigator.storage?.persisted?.().catch(() => {});
  }

  private sendUpdate(update: Uint8Array): Promise<void> {
    if (this.access !== 'ready' || this.socket?.readyState !== WebSocket.OPEN || !this.transfer) return Promise.resolve();
    const socket = this.socket, id = crypto.randomUUID();
    this.requests.add(id);
    const transfer = this.transfer;
    const sent = this.persistence!.whenDurable().then(() => {
      if (this.socket !== socket || this.access !== 'ready') return;
      // The server can echo this update to another tab sharing this database.
      return transfer.send('update', update);
    }).then(() => {
      if (this.socket === socket) { this.requests.delete(id); this.refresh(); }
    });
    void sent.catch(() => { if (this.socket === socket) socket.close(); }); this.lastUpload = sent; this.refresh(); return sent;
  }

  private sendHistoryHint(kind: 'history-boundary' | 'sync-complete', value: unknown, socket = this.socket, after = this.lastUpload) {
    if (!socket || this.socket !== socket) return;
    const transfer = this.transfer;
    const sent = after.then(async () => {
      if (this.socket !== socket || socket.readyState !== WebSocket.OPEN || this.access !== 'ready') return;
      await transfer?.send(kind, new TextEncoder().encode(JSON.stringify(value)), true);
    }).catch(() => {
      if (this.socket === socket) this.historyError = 'Could not request a saved version. Current notes continue syncing.';
    }).finally(() => { this.historyRequests.delete(sent); this.refresh(); });
    this.historyRequests.add(sent);
  }

  private async connect() {
    if (this.connecting || this.access === 'blocked' || this.parked || this.syncStopped) return;
    clearTimeout(this.retry);
    this.connecting = true;
    try {
      // Every reconnect verifies identity before it can upload the existing document.
      const { account, rejection } = await this.session();
      if (this.accountAbort.signal.aborted || this.parked) return;
      this.authMode = account.authMode;
      if (this.account && this.account.vaultId !== account.vaultId) {
        rememberAccount(account);
        this.block('Your signed-in account changed. Your edits remain in the previous account’s local vault. Reload to open the current account.');
        return;
      }
      rememberAccount(account);
      if (rejection) {
        // Authenticate first, but do not open an incompatible cached vault on
        // startup. An already open vault keeps its local writer and offline edits.
        this.rejectSync(account, rejection);
        return;
      }
      if (!this.account) {
        // The session is now verified, including after the password form unlocks
        // a fresh browser. Account stores must initialize outside the locked state.
        this.access = 'opening';
        await this.openAccount(account);
      }
      if (this.parked || this.access !== 'ready' || this.socket?.readyState === WebSocket.OPEN || this.socket?.readyState === WebSocket.CONNECTING) return;
      this.status = 'connecting';
      this.refresh();
      startupMark('socket-start');
      const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/sync?schema=${CURRENT_SCHEMA}&protocol=${SYNC_PROTOCOL_VERSION}&vaultId=${encodeURIComponent(account.vaultId)}`);
      this.socket = socket; socket.binaryType = 'arraybuffer';
      const transfer = new SyncTransfer(socket, {
        onFailure: error => {
          if (this.socket !== socket || this.access !== 'ready') return;
          this.error = error.message;
          if (error.code === 'limit' || error.code === 'invalid') this.rejectSync(account, { code: error.code, message: error.message, action: 'none', target: 'sync-transfer' });
          this.status = 'error'; this.refresh();
        },
        onMessage: async (kind, data) => {
          if (this.socket !== socket || this.access !== 'ready') throw new TransferError('retry', 'The active account connection changed.');
          if (kind === 'sync') {
            let message: ReturnType<typeof unpackSync>;
            try { message = unpackSync(data); Y.decodeStateVector(message.vector); }
            catch (error) { this.block(error instanceof Error ? error.message : 'Invalid server snapshot.'); throw error; }
            startupMark('sync-received'); startupMark('sync-apply-start');
            Y.applyUpdate(this.vault.doc, message.update, 'remote');
            startupMark('sync-apply-end');
            const reply = this.sendUpdate(Y.encodeStateAsUpdate(this.vault.doc, message.vector));
            this.sendHistoryHint('sync-complete', {}, socket, reply);
            startupMark('sync-reply-sent');
            this.status = 'online'; this.retryDelay = 1000; this.error = null;
            this.scheduleImages();
          } else if (kind === 'update') Y.applyUpdate(this.vault.doc, data, 'remote');
          else if (kind === 'history-changed') { this.historyVersion++; this.historyError = null; }
          else if (kind === 'history-failure') {
            const notice = JSON.parse(new TextDecoder().decode(data));
            this.historyError = typeof notice.message === 'string' ? notice.message : 'A saved version could not be recorded. Current notes are still saved.';
          } else throw new TransferError('invalid', 'Unexpected server sync request.');
          try {
            if (kind === 'sync') {
              await this.persistence!.markSynchronized();
              if (this.socket === socket && !this.parked) this.ready = true;
            } else await this.persistence?.whenDurable();
          }
          catch { throw new TransferError('storage', 'Local storage could not save the received update. Reconnect to retry.'); }
          this.refresh();
        },
      });
      this.transfer = transfer;
      socket.onopen = () => {
        startupMark('socket-open');
        if (this.socket !== socket || this.access !== 'ready') { socket.close(); return; }
        this.requests.clear();
        void transfer.send('sync-request', Y.encodeStateVector(this.vault.doc)).catch(() => {});
      };
      socket.onmessage = event => {
        if (this.socket === socket && this.access === 'ready') transfer.receive(typeof event.data === 'string' ? event.data : new Uint8Array(event.data));
      };
      socket.onclose = event => {
        if (this.socket !== socket) { transfer.close(); return; }
        if (event.code === 1008 || event.code === 1009) {
          this.error ??= 'Sync requires an updated client or a smaller vault. Your local edits remain on this device.';
          this.rejectSync(account, { code: String(event.code), message: this.error, action: 'none', target: 'sync-transfer' });
        }
        this.socket = undefined; this.transfer = undefined; this.historyBoundaries = []; this.historyRequests.clear(); transfer.close();
        this.status = this.syncStopped ? 'error' : 'offline'; this.refresh();
        if (!this.syncStopped) this.scheduleReconnect();
      };
      socket.onerror = () => socket.close();
    } catch (error) {
      if (this.accountAbort.signal.aborted || this.parked) return;
      if (error instanceof ServerUnavailableError) {
        // Retry availability failures without treating them as authentication
        // or as permission to open an unverified account from the local cache.
        this.closeSocket();
        if (!this.account) this.accessMessage = null;
        this.error = error.message; this.status = 'connecting';
        this.refresh(); this.scheduleReconnect();
      } else if (error instanceof NetworkError) {
        this.closeSocket();
        if (!this.account) {
          try {
            const account = cachedAccount();
            if (!account) { this.accessMessage = 'Connect to the server once to identify and download your vault.'; this.status = 'offline'; this.refresh(); this.scheduleReconnect(); return; }
            await this.openAccount(account);
          } catch (storageError) { this.block(storageError instanceof Error ? storageError.message : 'Could not open your offline vault.'); return; }
        }
        this.status = 'offline'; this.refresh(); this.scheduleReconnect();
      } else {
        // An HTTP/authentication/format failure is not permission to open a cached vault.
        try { localStorage.removeItem(ACCOUNT_KEY); }
        catch { this.error = 'Browser storage could not clear the previous account. Restore browser storage before reopening Stow.'; }
        if (error instanceof SessionError && error.authMode) this.authMode = error.authMode;
        const message = error instanceof Error ? error.message : 'Could not verify your account.';
        if (!this.account && error instanceof SessionError && error.locked) {
          this.access = 'locked'; this.status = 'locked'; this.accessMessage = message; this.refresh();
        } else this.block(message);
      }
    } finally { this.connecting = false; }
  }

  private scheduleReconnect() {
    if (this.access === 'blocked' || this.access === 'locked' || this.parked || this.syncStopped) return;
    clearTimeout(this.retry);
    this.retry = setTimeout(() => void this.connect(), this.retryDelay);
    this.retryDelay = Math.min(this.retryDelay * 1.7, 30000);
  }

  private rejectSync(account: Account, rejection: SyncRejection) {
    if (!this.account) { this.access = 'opening'; this.accessMessage = null; }
    this.syncStopped = true; clearTimeout(this.retry);
    this.closeSocket(); this.status = 'error';
    this.syncRejection = rejection;
    this.updateReload?.stop(); this.updateReload = undefined;
    if (rejection.action === 'reload') this.updateReload = new IdleUpdateReload(account.vaultId, rejection.target, {
      safe: () => !this.parked && !this.composing && this.access !== 'blocked' && this.access !== 'locked' && this.localPending === 0 && this.imageWrites === 0 && !this.localError,
      save: () => this.saveBeforeReload(),
      reload: () => location.reload(),
      failed: () => this.refresh(),
    });
    this.refresh();
  }

  async setHistoryCompression(enabled: boolean): Promise<VaultStorage> {
    await this.whenSynchronized();
    return this.storageRequest('/api/history-retention/compression', 'PUT', { enabled });
  }

  async login(password: string) {
    if (this.authMode !== 'password' || this.account) throw new Error('Reload Stow after signing in to the current account.');
    const response = await fetch('/api/login', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
    if (!response.ok) throw new Error(response.status === 429 ? 'Too many attempts. Please try again shortly.' : 'That password did not work.');
    await this.connect();
  }

  private async saveBeforeReload() {
    try {
      this.vault.finishEdit();
      this.flushReplication();
      if (this.persistence) await this.persistence.whenDurable();
    } catch (error) {
      this.localError = 'Local storage failed. Export your notes before leaving this tab.'; this.refresh(); throw error;
    }
  }

  async reloadAccount() {
    if (this.updateReload) { await this.updateReload.attempt(); return; }
    try {
      await this.saveBeforeReload();
      if (this.localPending === 0 && this.imageWrites === 0 && !this.localError) location.reload();
    } catch { /* saveBeforeReload reports the failure and retains local edits. */ }
  }

  private requireAccount() {
    if (!this.account || this.access !== 'ready') throw new Error('The active account changed. Reload Stow before editing or syncing images.');
    return this.account;
  }

  private async whenSynchronized() {
    this.requireAccount();
    this.vault.finishEdit();
    await this.persistence!.whenDurable();
    this.flushReplication();
    await new Promise<void>((resolve, reject) => {
      let unsubscribe = () => {};
      const finish = (error?: Error) => {
        clearTimeout(timeout); unsubscribe();
        if (error) reject(error); else resolve();
      };
      const check = () => {
        if (this.access !== 'ready') finish(new Error('The active account changed. Reload Stow before managing storage.'));
        else if (this.status === 'offline' || this.status === 'error') finish(new Error('Connect and finish syncing before managing server storage.'));
        else if (this.status === 'online' && this.requests.size === 0 && this.outgoingUpdates.length === 0 && this.historyRequests.size === 0) finish();
      };
      const timeout = setTimeout(() => finish(new Error('Notes have not finished syncing. Try again once connected.')), 15000);
      unsubscribe = this.subscribe(check);
      check();
    });
  }

  private async storageRequest<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const account = this.requireAccount();
    const response = await fetch(path, {
      method, cache: 'no-store', redirect: 'manual',
      headers: { 'X-Stow-Vault': account.vaultId, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.any([this.accountAbort.signal, AbortSignal.timeout(60000)]),
    });
    this.requireAccount();
    if (response.type === 'opaqueredirect' || response.status === 401 || response.status === 403) {
      const message = 'Sign in to the same account, then reload Stow before managing storage.';
      this.block(message);
      throw new Error(message);
    }
    const result = await response.json();
    if (response.status === 409 && result.code === 'vault_mismatch') {
      const message = 'The active account changed. Reload Stow before managing storage.';
      this.block(message);
      throw new Error(message);
    }
    if (!response.ok) throw new Error(result.error || 'Could not update server storage.');
    return result as T;
  }

  async fetchStorage(): Promise<VaultStorage> {
    await this.whenSynchronized();
    return this.storageRequest('/api/storage');
  }

  async setHistoryRetention(enabled: boolean): Promise<VaultStorage> {
    await this.whenSynchronized();
    return this.storageRequest('/api/history-retention', 'PUT', { enabled });
  }

  async discardArchivedHistory(selection: VaultStorage): Promise<ArchivedHistoryCleanup> {
    await this.whenSynchronized();
    const result = await this.storageRequest<ArchivedHistoryCleanup>('/api/history-retention/cleanup', 'POST', {
      sourceIds: selection.archivedSourceIds, selectionToken: selection.archivedSelectionToken,
    });
    this.historyVersion++; this.refresh();
    return result;
  }

  private requireHistoryConnection() {
    this.requireAccount();
    if (this.status !== 'online') throw new Error('Connect to view version history.');
  }

  async fetchHistoryVersions(noteId: string, cursor?: string): Promise<HistoryPage> {
    this.requireHistoryConnection();
    await this.whenSynchronized();
    const query = new URLSearchParams({ noteId, limit: '80', ...(cursor ? { cursor } : {}) });
    return this.storageRequest(`/api/history?${query}`);
  }

  async fetchHistoryVersion(id: string): Promise<SavedVersion> {
    this.requireHistoryConnection();
    return this.storageRequest(`/api/history/${encodeURIComponent(id)}`);
  }

  async restoreHistoryVersion(id: string): Promise<string> {
    const version = await this.fetchHistoryVersion(id);
    this.requireHistoryConnection();
    if (version.sourceIds.some(sourceId => this.vault.deletedNotes.has(sourceId))) throw new Error('This version is no longer available.');
    return this.vault.restoreHistoryState(version.state);
  }

  retainHistoryPreview(attachments: Attachment[]): () => void {
    const key = Symbol();
    this.historyPreviews.set(key, attachments);
    this.updateDeletedImages();
    return () => { this.historyPreviews.delete(key); this.updateDeletedImages(); };
  }

  private retainedAttachments(): Attachment[] {
    return [...this.vault.attachments.values(), ...this.vault.getUndoAttachments(), ...[...this.historyPreviews.values()].flat()]
      .filter(attachment => !this.vault.deletedNotes.has(attachment.noteId));
  }

  async addImage(noteId: string, file: File) {
    this.requireAccount();
    this.imageWrites++; this.refresh();
    try {
      await this.images!.add(file, attachment => {
        this.requireAccount();
        if (this.vault.deletedNotes.has(noteId)) {
          this.vault.doc.transact(() => this.vault.doc.getMap('deletedBlobCandidates').set(attachment.hash, true), PERMANENT_DELETION_ORIGIN);
          this.updateDeletedImages();
          throw new Error('This note was deleted before the image finished saving.');
        }
        this.vault.addAttachment({ ...attachment, id: crypto.randomUUID(), noteId });
      });
    } finally { this.imageWrites--; this.refresh(); this.scheduleImages(); }
  }

  async thumbnailUrl(attachment: Attachment) {
    this.requireAccount();
    return this.images!.thumbnailUrl(attachment);
  }

  async originalUrl(attachment: Attachment) {
    this.requireAccount();
    return this.images!.originalUrl(attachment);
  }

  async deleteNotesForever(sourceIds: readonly string[]): Promise<void> {
    this.requireAccount();
    this.vault.deleteNotesForever(sourceIds);
    this.updateDeletedImages(); this.scheduleImages();
    await this.persistence!.whenDurable();
    this.requireAccount();
    try { await this.images!.pruneDeleted(); }
    catch { throw new Error('Notes deleted. Image cleanup failed and will retry.'); }
  }

  private updateDeletedImages() {
    if (!this.images || !this.vault.doc.getMap('deletedBlobCandidates').size) return;
    const attachments = this.retainedAttachments();
    this.images.setDeletedBlobs(getPermanentDeletionBlobCandidates(this.vault.doc), new Set(attachments.map(image => image.hash)));
  }

  private scheduleImages() {
    if (this.access !== 'ready') return;
    this.imagesDirty = true;
    clearTimeout(this.imageTimer);
    this.imageTimer = setTimeout(() => void this.syncImages(), 300);
  }

  private async syncImages() {
    if (this.syncingImages || this.access !== 'ready') return;
    this.syncingImages = true;
    this.imagesDirty = false;
    try {
      this.updateDeletedImages();
      await this.images!.pruneDeleted();
      const attachments = this.retainedAttachments();
      await this.images!.sync(attachments);
      this.requireAccount();
      this.refresh();
    } catch (error) {
      if (this.access !== 'ready') return;
      this.imageError = error instanceof Error ? error.message : 'Images will sync when the connection returns.';
      this.refresh();
      this.imageTimer = setTimeout(() => void this.syncImages(), 10000);
    } finally {
      this.syncingImages = false;
      if (this.imagesDirty) this.scheduleImages();
    }
  }

  exportCurrentNotes() {
    this.downloadExport({ format: 'stow-current-export-v1', exportedAt: new Date().toISOString(), notes: this.vault.getNotes(), crdt: encode(Y.encodeStateAsUpdate(this.vault.doc)) });
  }

  async exportData() {
    this.requireHistoryConnection();
    await this.whenSynchronized();
    const history = await this.storageRequest<HistoryExport>('/api/history/export');
    this.requireHistoryConnection();
    this.downloadExport({ format: 'stow-export-v3', exportedAt: new Date().toISOString(), notes: this.vault.getNotes(), history, crdt: encode(Y.encodeStateAsUpdate(this.vault.doc)) });
  }

  private downloadExport(data: unknown) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url; a.download = `stow-${new Date().toISOString().slice(0, 10)}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

startupMark('store-constructing');
/** Public UI contract, also implemented by the explicitly selected static demo. */
export type AppStore = Pick<StowStore, keyof StowStore>;
export const store = new StowStore();
export function useStow() { return useSyncExternalStore(store.subscribe, store.getSnapshot); }
