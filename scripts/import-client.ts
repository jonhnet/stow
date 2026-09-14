import { CURRENT_SCHEMA } from '../src/core/current-schema.ts';
import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { WebSocket } from 'ws';
import * as Y from 'yjs';
type AuthMode = 'password' | 'proxy';
function validIdentity(value: string) { return value.length > 0 && value.length <= 320 && value.trim() === value && !/[\x00-\x20\x7f,]/.test(value); }
import { SyncTransfer, TransferError, TRANSFER_MAX_BYTES, unpackSync, type TransferOptions } from '../src/core/sync-transfer.ts';
import { SYNC_PROTOCOL_VERSION } from '../src/core/protocol-version.ts';
import type { HistoryExport } from '../src/core/server-history-types.ts';

const MAX_BLOB = 20 * 1024 * 1024;
const TIMEOUT = 30_000;
const HASH = /^[a-f0-9]{64}$/;

export interface ImportClientOptions {
  url: string;
  authMode: AuthMode;
  user?: string;
  proxySecret?: string;
  password?: string;
  expectedVaultId?: string;
  onTransferMetrics?: TransferOptions['onMetrics'];
}
export interface ImportAccount { user: string; vaultId: string; authMode: AuthMode }
export interface ImportBlob { hash: string; path: string; size: number; type: string; sourceIds?: string[] }
type Session = { authenticated: false; authMode: AuthMode } | ({ authenticated: true } & ImportAccount);
interface Pending {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function serviceURL(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Import URL must be an HTTP or HTTPS service origin.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Import URL must be an HTTP or HTTPS service origin without credentials, a path, query, or fragment.');
  }
  return url;
}

async function request(url: URL, route: string, headers: Record<string, string>, init: RequestInit = {}, signal?: AbortSignal) {
  let response: Response;
  try {
    response = await fetch(new URL(route, url), {
      ...init, headers: { ...headers, ...init.headers }, redirect: 'manual',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT)]) : AbortSignal.timeout(TIMEOUT),
    });
  } catch { throw new Error('Import HTTP request failed or timed out.'); }
  if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
    await response.body?.cancel();
    throw new Error('Import HTTP request was redirected; use the directly authenticated service origin.');
  }
  return response;
}

async function session(response: Response, mode: AuthMode): Promise<Session> {
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Import authentication failed (HTTP ${response.status}).`); }
  let value: Record<string, unknown>;
  try { value = await response.json() as Record<string, unknown>; } catch { throw new Error('Import service returned an invalid session response.'); }
  if (!value || typeof value !== 'object' || value.authMode !== mode || typeof value.required !== 'boolean' || typeof value.authenticated !== 'boolean') {
    throw new Error('Import service authentication mode or session response does not match the requested configuration.');
  }
  if (!value.authenticated) {
    if (value.user !== undefined || value.vaultId !== undefined) throw new Error('Import service returned an invalid unauthenticated session.');
    return { authenticated: false, authMode: mode };
  }
  if (typeof value.user !== 'string' || !value.user || typeof value.vaultId !== 'string' || !HASH.test(value.vaultId)) {
    throw new Error('Import service returned an invalid account identity.');
  }
  return { authenticated: true, authMode: mode, user: value.user, vaultId: value.vaultId };
}

function bind(account: Session, options: Pick<ImportClientOptions, 'user' | 'expectedVaultId'>): ImportAccount {
  if (!account.authenticated) throw new Error('Import authentication is required.');
  if ((options.user !== undefined && account.user !== options.user) ||
      (options.expectedVaultId !== undefined && account.vaultId !== options.expectedVaultId)) {
    throw new Error('Import account identity does not match the requested user or vault.');
  }
  return { user: account.user, vaultId: account.vaultId, authMode: account.authMode };
}

/** Explicit administrative transport. Receiving sync never submits local changes. */
export class ImportClient {
  readonly doc = new Y.Doc();
  private socket!: WebSocket;
  private transfer!: SyncTransfer;
  private pending?: Pending;
  private failure?: Error;
  private sequence: Promise<void> = Promise.resolve();
  private closing?: Promise<void>;
  private controller = new AbortController();

  private constructor(private url: URL, private headers: Record<string, string>, readonly account: ImportAccount, private onTransferMetrics?: TransferOptions['onMetrics']) {}

  static async open(options: ImportClientOptions): Promise<ImportClient> {
    const url = serviceURL(options.url);
    if (options.authMode !== 'proxy' && options.authMode !== 'password') throw new Error('Import authentication mode must be proxy or password.');
    if (options.expectedVaultId !== undefined && !HASH.test(options.expectedVaultId)) throw new Error('Expected import vault ID must be a lowercase SHA-256 identifier.');
    const headers: Record<string, string> = {};
    if (options.authMode === 'proxy') {
      if (typeof options.user !== 'string' || !validIdentity(options.user) || typeof options.proxySecret !== 'string' || options.proxySecret.length < 32) {
        throw new Error('Proxy import requires an explicit valid user and private proxy proof of at least 32 characters.');
      }
      headers['X-Auth-User'] = options.user;
      headers['X-Stow-Proxy-Secret'] = options.proxySecret;
    }
    let identity = await session(await request(url, '/api/session', headers), options.authMode);
    if (!identity.authenticated && options.authMode === 'password') {
      if (typeof options.password !== 'string' || !options.password) throw new Error('Import requires the configured Stow password.');
      const response = await request(url, '/api/login', headers, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: options.password }),
      });
      identity = await session(response, 'password');
      bind(identity, options);
      const cookies = response.headers.getSetCookie().filter(cookie => cookie.startsWith('stow_session='));
      if (cookies.length !== 1) throw new Error('Import login did not return a single Stow session cookie.');
      headers.Cookie = cookies[0].split(';', 1)[0];
      identity = await session(await request(url, '/api/session', headers), 'password');
    }
    const account = bind(identity, options);
    headers['X-Stow-Vault'] = account.vaultId;
    const client = new ImportClient(url, headers, Object.freeze(account), options.onTransferMetrics);
    try {
      await client.connect();
      await client.refresh();
      return client;
    } catch (error) {
      await client.close();
      throw error;
    }
  }

  private async connect() {
    const url = new URL('/sync', this.url);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('vaultId', this.account.vaultId);
    url.searchParams.set('protocol', SYNC_PROTOCOL_VERSION);
    url.searchParams.set('schema', CURRENT_SCHEMA);
    this.socket = new WebSocket(url, { headers: this.headers, handshakeTimeout: TIMEOUT, followRedirects: false });
    this.transfer = new SyncTransfer(this.socket, {
      onMetrics: this.onTransferMetrics,
      onFailure: error => this.fail(error),
      onMessage: (kind, data) => {
        if (kind === 'history-changed' || kind === 'history-failure') return;
        if (kind === 'update') { Y.applyUpdate(this.doc, data, 'remote'); return; }
        if (kind !== 'sync' || !this.pending) throw new TransferError('invalid', 'Import sync returned an unexpected response.');
        const message = unpackSync(data); Y.decodeStateVector(message.vector);
        Y.applyUpdate(this.doc, message.update, 'remote');
        const pending = this.pending; clearTimeout(pending.timer); this.pending = undefined; pending.resolve();
      },
    });
    this.socket.on('message', (raw, binary) => {
      const bytes = Array.isArray(raw) ? Buffer.concat(raw) : raw instanceof ArrayBuffer ? new Uint8Array(raw) : raw;
      this.transfer.receive(binary ? bytes : Buffer.from(bytes).toString('utf8'));
    });
    this.socket.on('error', () => this.fail(new Error('Import sync connection failed.')));
    this.socket.on('close', () => this.fail(new Error('Import sync connection closed before completion.')));
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { this.socket.off('open', opened); this.socket.off('error', errored); this.socket.off('close', closed); };
      const opened = () => { cleanup(); resolve(); };
      const errored = () => { cleanup(); reject(new Error('Import sync authentication or connection failed.')); };
      const closed = () => { cleanup(); reject(new Error('Import sync connection closed during authentication.')); };
      this.socket.once('open', opened); this.socket.once('error', errored); this.socket.once('close', closed);
    });
  }

  private fail(error: Error) {
    if (this.failure) return;
    this.failure = error;
    this.transfer?.close();
    this.controller.abort();
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(this.failure); this.pending = undefined; }
    if (this.socket && this.socket.readyState !== WebSocket.CLOSED) this.socket.terminate();
  }
  private usable() {
    if (this.failure) throw this.failure;
    if (this.socket.readyState !== WebSocket.OPEN) throw new Error('Import sync connection is not open.');
  }
  private enqueue(work: () => Promise<void>): Promise<void> {
    const operation = this.sequence.then(async () => {
      this.usable();
      try { await work(); } catch (error) { this.fail(error instanceof Error ? error : new Error('Import operation failed.')); throw this.failure; }
    });
    this.sequence = operation.catch(() => {});
    return operation;
  }
  private exchange() {
    return new Promise<void>((resolve, reject) => {
      this.pending = { resolve, reject,
        timer: setTimeout(() => this.fail(new Error('Import sync timed out before the server confirmed completion.')), TIMEOUT) };
      void this.transfer.send('sync-request', Y.encodeStateVector(this.doc)).catch(error => this.fail(error));
    });
  }
  private async verifyAccount() {
    const current = await session(await request(this.url, '/api/session', this.headers, {}, this.controller.signal), this.account.authMode);
    bind(current, { user: this.account.user, expectedVaultId: this.account.vaultId });
  }

  /** A server-queue barrier; preserves but never transmits local unsent changes. */
  refresh(): Promise<void> {
    return this.enqueue(async () => {
      await this.verifyAccount();
      await this.exchange();
    });
  }

  /** Independent server snapshots are part of a pre-import backup, outside the CRDT. */
  async historyExport(): Promise<HistoryExport> {
    let history!: HistoryExport;
    await this.enqueue(async () => {
      await this.verifyAccount();
      const response = await request(this.url, '/api/history/export', this.headers, {}, this.controller.signal);
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Import history backup failed (HTTP ${response.status}); no notes have been changed.`);
      }
      history = await response.json() as HistoryExport;
      if (history?.schema !== 1 || !Array.isArray(history.versions) || !history.discardedAt || typeof history.discardedAt !== 'object') {
        throw new Error('Import service returned an invalid history backup.');
      }
    });
    return history;
  }

  /** Download one original with bounded memory and verify its content-addressed identity. */
  async getBlob(hash: string): Promise<Buffer> {
    let bytes!: Buffer;
    await this.enqueue(async () => {
      if (!HASH.test(hash)) throw new Error('Import backup references an invalid blob hash.');
      await this.verifyAccount();
      const response = await request(this.url, `/api/blobs/${hash}`, this.headers, {}, this.controller.signal);
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error(`Import media backup failed (HTTP ${response.status}); no notes have been changed.`);
      }
      const reader = response.body.getReader(), chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > MAX_BLOB) throw new Error('Import backup original exceeds the 20 MiB limit.');
          chunks.push(chunk.value);
        }
      } catch (error) { await reader.cancel(); throw error; }
      finally { reader.releaseLock(); }
      bytes = Buffer.concat(chunks, size);
      if (createHash('sha256').update(bytes).digest('hex') !== hash) throw new Error('Import backup original does not match its SHA-256 hash.');
    });
    return bytes;
  }

  async putBlob(blob: ImportBlob): Promise<'uploaded' | 'existing'> {
    try {
      this.usable();
      if (!HASH.test(blob.hash) || !Number.isSafeInteger(blob.size) || blob.size <= 0 || blob.size > MAX_BLOB ||
          typeof blob.type !== 'string' || !blob.type || /[\r\n]/.test(blob.type)) throw new Error('Import blob metadata is invalid or exceeds the 20 MiB limit.');
      let bytes: Buffer;
      try {
        const file = await open(blob.path, 'r');
        try {
          const info = await file.stat();
          if (!info.isFile() || info.size !== blob.size || info.size > MAX_BLOB) throw new Error();
          const buffer = Buffer.alloc(blob.size + 1);
          let length = 0;
          while (length < buffer.length) {
            const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
            if (!bytesRead) break;
            length += bytesRead;
          }
          bytes = buffer.subarray(0, length);
        } finally { await file.close(); }
      } catch { throw new Error('Import blob file cannot be read or does not match its declared size.'); }
      if (bytes.length !== blob.size || createHash('sha256').update(bytes).digest('hex') !== blob.hash) throw new Error('Import blob file does not match its declared SHA-256 hash and size.');
      await this.verifyAccount();
      const route = `/api/blobs/${blob.hash}`;
      const ownership: Record<string, string> = blob.sourceIds?.length ? { 'X-Stow-Blob-Sources': JSON.stringify(blob.sourceIds) } : {};
      const existing = await request(this.url, route, this.headers, { method: 'HEAD', headers: ownership }, this.controller.signal);
      if (existing.status === 200) {
        if (existing.headers.get('content-length') !== String(blob.size)) throw new Error('An existing import blob has a different size.');
        return 'existing';
      }
      await existing.body?.cancel();
      if (existing.status !== 404) throw new Error(`Import blob lookup failed (HTTP ${existing.status}).`);
      const response = await request(this.url, route, this.headers, {
        method: 'PUT', headers: { 'Content-Type': blob.type, ...ownership }, body: new Uint8Array(bytes),
      }, this.controller.signal);
      await response.body?.cancel();
      if (response.status !== 204) throw new Error(`Import blob upload failed (HTTP ${response.status}).`);
      return 'uploaded';
    } catch (error) {
      const failure = error instanceof Error ? error : new Error('Import blob upload failed.');
      this.fail(failure); throw failure;
    }
  }

  submit(update: Uint8Array): Promise<void> {
    return this.enqueue(async () => {
      if (!(update instanceof Uint8Array) || !update.byteLength || update.byteLength > TRANSFER_MAX_BYTES) throw new Error('Import update must be nonempty and no larger than 128 MiB.');
      await this.verifyAccount();
      await this.transfer.send('update', update);
      Y.applyUpdate(this.doc, update, 'submitted');
    });
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      this.fail(new Error('Import client is closed.'));
      if (this.socket && this.socket.readyState !== WebSocket.CLOSED) {
        await new Promise<void>(resolve => { this.socket.once('close', resolve); });
      }
      this.doc.destroy();
    })();
    return this.closing;
  }
}
