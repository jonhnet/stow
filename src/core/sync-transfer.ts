import { CURRENT_SCHEMA } from './current-schema';
/** Protocol 2: one logical transfer in each direction, bounded binary frames.
 * A receipt grants transport credit. Only `done`, after onMessage resolves,
 * acknowledges the logical unit; the server resolves after durable publication. */
export const TRANSFER_FRAME_BYTES = 256 * 1024;
export const TRANSFER_WINDOW = 4;
export const TRANSFER_MAX_BYTES = 128 * 1024 * 1024;
export const TRANSFER_QUEUE_BYTES = TRANSFER_MAX_BYTES;
export const TRANSFER_IDLE_MS = 60_000;
export const TRANSFER_LIFETIME_MS = 5 * 60_000;
const HEADER_BYTES = 8;
export type TransferKind = 'sync-request' | 'sync' | 'update' | 'history-boundary' | 'sync-complete' | 'history-changed' | 'history-failure';
export class TransferError extends Error {
  constructor(readonly code: 'invalid' | 'limit' | 'retry' | 'storage', message: string) { super(message); }
}
export interface TransferSocket {
  readonly bufferedAmount: number;
  send(value: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
}
interface Outgoing {
  id: number; kind: TransferKind; data: Uint8Array; sent: number; received: number;
  resolve(): void; reject(error: Error): void; started: number; release?: () => void;
}
interface Incoming { id: number; kind: TransferKind; data: Uint8Array; offset: number; digest: string; started: number; completing: boolean; release?: () => void }
export interface TransferOptions {
  onMessage(kind: TransferKind, data: Uint8Array): Promise<void> | void;
  onFailure(error: TransferError): void;
  /** Optional server-wide admission budget, released even on disconnect/failure. */
  reserve?(bytes: number): () => void;
  onMetrics?(metrics: { direction: 'send' | 'receive'; bytes: number; durationMs: number; maxInFlightBytes: number }): void;
}
async function digest(data: Uint8Array) {
  const result = await crypto.subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(result), value => value.toString(16).padStart(2, '0')).join('');
}
const validKind = (value: unknown): value is TransferKind => ['sync-request', 'sync', 'update', 'history-boundary', 'sync-complete', 'history-changed', 'history-failure'].includes(value as string);

const maximumBytes = (kind: TransferKind) => ['sync-request', 'sync', 'update'].includes(kind) ? TRANSFER_MAX_BYTES : TRANSFER_FRAME_BYTES;

export class SyncTransfer {
  private outgoing?: Outgoing;
  private incoming?: Incoming;
  private queue: Outgoing[] = [];
  private queuedBytes = 0;
  private nextOutgoing = 0;
  private nextIncoming = 1;
  private failure?: TransferError;
  private timer?: ReturnType<typeof setTimeout>;
  private maxInFlight = 0;
  constructor(private socket: TransferSocket, private options: TransferOptions) {}

  send(kind: TransferKind, data: Uint8Array, optional = false): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    if (!data.byteLength || data.byteLength > maximumBytes(kind)) {
      const error = new TransferError('limit', 'A sync update exceeds the 128 MiB supported limit. Local edits remain saved on this device.');
      if (!optional) this.fail(error); return Promise.reject(error);
    }
    if (this.queuedBytes + data.byteLength > TRANSFER_QUEUE_BYTES || this.queue.length >= 128) {
      const error = new TransferError('retry', 'Sync is falling behind. Reconnect to catch up from saved notes.');
      if (!optional) this.fail(error); return Promise.reject(error);
    }
    let release: (() => void) | undefined;
    try { release = this.options.reserve?.(data.byteLength); } catch (error) {
      const failure = error instanceof TransferError ? error : new TransferError('retry', 'Sync transfer budget is full.');
      if (!optional) this.fail(failure); return Promise.reject(failure);
    }
    const promise = new Promise<void>((resolve, reject) => {
      this.queuedBytes += data.byteLength;
      this.queue.push({ id: ++this.nextOutgoing, kind, data, sent: 0, received: 0, resolve, reject, started: 0, release });
    });
    this.startNext(); return promise;
  }
  private startNext() {
    if (this.failure || this.outgoing || !this.queue.length) return;
    const outgoing = this.outgoing = this.queue.shift()!;
    outgoing.started = performance.now(); this.maxInFlight = 0; this.touch();
    void digest(outgoing.data).then(hash => {
      if (this.failure || this.outgoing !== outgoing) return;
      this.control({ type: 'begin', id: outgoing.id, kind: outgoing.kind, bytes: outgoing.data.byteLength, digest: hash });
      this.pump();
    }).catch(error => this.fail(error instanceof TransferError ? error : new TransferError('invalid', 'Could not encode a sync transfer.')));
  }
  private control(message: unknown) { this.socket.send(JSON.stringify(message)); }
  private touch() {
    clearTimeout(this.timer);
    if (!this.incoming && !this.outgoing) return;
    const start = Math.min(this.incoming?.started ?? Infinity, this.outgoing?.started ?? Infinity);
    const remaining = Math.min(TRANSFER_IDLE_MS, TRANSFER_LIFETIME_MS - (performance.now() - start));
    this.timer = setTimeout(() => this.fail(new TransferError('retry', 'Sync timed out. Unacknowledged changes will retry after reconnecting.')), Math.max(0, remaining));
    // Node fixtures/importers should not be held open by a dead peer.
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }
  private pump() {
    const active = this.outgoing; if (!active || this.failure) return;
    const payload = TRANSFER_FRAME_BYTES - HEADER_BYTES;
    while (active.sent < active.data.byteLength && active.sent - active.received < payload * TRANSFER_WINDOW) {
      if (this.socket.bufferedAmount > TRANSFER_FRAME_BYTES * TRANSFER_WINDOW) throw new TransferError('retry', 'Sync transport queue is full. Reconnect to catch up.');
      const length = Math.min(payload, active.data.byteLength - active.sent);
      const frame = new Uint8Array(HEADER_BYTES + length), header = new DataView(frame.buffer);
      header.setUint32(0, active.id); header.setUint32(4, active.sent);
      frame.set(active.data.subarray(active.sent, active.sent + length), HEADER_BYTES);
      active.sent += length;
      this.maxInFlight = Math.max(this.maxInFlight, active.sent - active.received);
      this.socket.send(frame);
    }
  }
  /** Call with a string for control frames and Uint8Array for binary frames. */
  receive(value: string | Uint8Array) {
    if (this.failure) return;
    try {
      if (typeof value !== 'string') { this.receiveChunk(value); return; }
      if (value.length > 4096) throw new TransferError('invalid', 'Oversized sync control frame.');
      const frame = JSON.parse(value);
      if (frame?.type === 'failure') {
        if (!['invalid', 'limit', 'retry', 'storage'].includes(frame.code) || typeof frame.message !== 'string') throw new TransferError('invalid', 'Invalid sync failure response.');
        this.fail(new TransferError(frame.code, frame.message.slice(0, 512)), false); return;
      }
      if (!Number.isSafeInteger(frame?.id) || frame.id < 1 || frame.id > 0xffffffff) throw new TransferError('invalid', 'Invalid sync transfer identity.');
      if (frame.type === 'begin') {
        if (this.incoming || frame.id !== this.nextIncoming || !validKind(frame.kind) || !Number.isSafeInteger(frame.bytes) || frame.bytes < 1 || typeof frame.digest !== 'string' || !/^[a-f0-9]{64}$/.test(frame.digest)) throw new TransferError('invalid', 'Invalid sync transfer header.');
        if (frame.bytes > maximumBytes(frame.kind)) throw new TransferError('limit', 'A sync update exceeds the 128 MiB supported limit. Local edits remain on this device.');
        const release = this.options.reserve?.(frame.bytes);
        try { this.incoming = { id: frame.id, kind: frame.kind, data: new Uint8Array(frame.bytes), offset: 0, digest: frame.digest, started: performance.now(), completing: false, release }; }
        catch (error) { release?.(); throw error; }
      } else if (frame.type === 'receipt') {
        const active = this.outgoing;
        if (!active || frame.id !== active.id || !Number.isSafeInteger(frame.offset) || frame.offset <= active.received || frame.offset > active.sent || (frame.offset !== active.data.byteLength && frame.offset % (TRANSFER_FRAME_BYTES - HEADER_BYTES))) throw new TransferError('invalid', 'Invalid sync chunk receipt.');
        active.received = frame.offset; this.pump();
      } else if (frame.type === 'done') {
        const active = this.outgoing;
        if (!active || frame.id !== active.id || active.received !== active.data.byteLength) throw new TransferError('invalid', 'Premature sync acknowledgement.');
        this.queuedBytes -= active.data.byteLength; this.outgoing = undefined; active.release?.();
        this.metrics('send', active.data.byteLength, active.started, this.maxInFlight);
        active.resolve(); this.startNext();
      } else throw new TransferError('invalid', 'Unknown sync control frame.');
      this.touch();
    } catch (error) { this.fail(error instanceof TransferError ? error : new TransferError('invalid', 'Invalid sync message')); }
  }
  private receiveChunk(frame: Uint8Array) {
    const active = this.incoming;
    if (!active || active.completing || frame.byteLength <= HEADER_BYTES || frame.byteLength > TRANSFER_FRAME_BYTES) throw new TransferError('invalid', 'Unexpected sync chunk.');
    const header = new DataView(frame.buffer, frame.byteOffset, HEADER_BYTES), length = frame.byteLength - HEADER_BYTES;
    if (header.getUint32(0) !== active.id || header.getUint32(4) !== active.offset || length !== Math.min(TRANSFER_FRAME_BYTES - HEADER_BYTES, active.data.byteLength - active.offset)) throw new TransferError('invalid', 'Missing, repeated, or out-of-order sync chunk.');
    active.data.set(frame.subarray(HEADER_BYTES), active.offset); active.offset += length;
    this.control({ type: 'receipt', id: active.id, offset: active.offset }); this.touch();
    if (active.offset !== active.data.byteLength) return;
    active.completing = true;
    void (async () => {
      if (await digest(active.data) !== active.digest) throw new TransferError('invalid', 'Sync transfer checksum does not match.');
      if (this.failure) return;
      await this.options.onMessage(active.kind, active.data);
      if (this.failure) return;
      active.release?.(); active.release = undefined; this.incoming = undefined; this.nextIncoming++;
      this.metrics('receive', active.data.byteLength, active.started, 0);
      this.control({ type: 'done', id: active.id }); this.touch();
    })().catch(error => this.fail(error instanceof TransferError ? error : new TransferError('invalid', 'Invalid sync message')));
  }
  private metrics(direction: 'send' | 'receive', bytes: number, start: number, maxInFlightBytes: number) {
    try { this.options.onMetrics?.({ direction, bytes, durationMs: performance.now() - start, maxInFlightBytes }); } catch { /* Observations cannot change durability. */ }
  }
  private fail(error: TransferError, tellPeer = true) {
    if (this.failure) return;
    this.failure = error; clearTimeout(this.timer);
    this.incoming?.release?.(); this.incoming = undefined;
    this.outgoing?.release?.(); this.outgoing?.reject(error); this.outgoing = undefined;
    this.queue.splice(0).forEach(value => { value.release?.(); value.reject(error); }); this.queuedBytes = 0;
    if (tellPeer) try { this.control({ type: 'failure', code: error.code, message: error.message }); } catch { /* Disconnected. */ }
    try { this.socket.close(error.code === 'limit' ? 1009 : error.code === 'invalid' ? 1008 : 1013, error.code); } catch { /* Already closed. */ }
    this.options.onFailure(error);
  }
  close() { this.fail(new TransferError('retry', 'Sync connection closed. Unacknowledged edits remain on this device.'), false); }
}

const schemaPrefix = new TextEncoder().encode(CURRENT_SCHEMA + '\0');
export function packSync(update: Uint8Array, vector: Uint8Array) {
  const packed = new Uint8Array(schemaPrefix.length + 4 + vector.byteLength + update.byteLength);
  packed.set(schemaPrefix); new DataView(packed.buffer).setUint32(schemaPrefix.length, vector.byteLength);
  packed.set(vector, schemaPrefix.length + 4); packed.set(update, schemaPrefix.length + 4 + vector.byteLength); return packed;
}
export function unpackSync(data: Uint8Array) {
  if (!schemaPrefix.every((value, index) => data[index] === value)) throw new TransferError('invalid', 'The server uses an incompatible vault format. Open the matching Stow server and a freshly imported vault.');
  data = data.subarray(schemaPrefix.length);
  if (data.byteLength < 6) throw new TransferError('invalid', 'Invalid sync snapshot.');
  const length = new DataView(data.buffer, data.byteOffset, 4).getUint32(0);
  if (length < 1 || length > 1024 * 1024 || length + 4 >= data.byteLength) throw new TransferError('invalid', 'Invalid sync state vector.');
  return { vector: data.subarray(4, 4 + length), update: data.subarray(4 + length) };
}
