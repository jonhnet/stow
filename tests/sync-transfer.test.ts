import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { SyncTransfer, TransferError, TRANSFER_FRAME_BYTES, TRANSFER_MAX_BYTES, TRANSFER_WINDOW, packSync, unpackSync, type TransferOptions } from '../src/core/sync-transfer';

const turn = () => new Promise<void>(resolve => setTimeout(resolve, 0));
async function until(condition: () => boolean) {
  for (let i = 0; i < 1000 && !condition(); i++) await turn();
  assert(condition(), 'Transfer did not reach the expected boundary');
}
function pair(t: TestContext, leftOptions: Partial<TransferOptions> = {}, rightOptions: Partial<TransferOptions> = {}) {
  const leftErrors: TransferError[] = [], rightErrors: TransferError[] = [];
  const leftFrames: (string | Uint8Array)[] = [], rightFrames: (string | Uint8Array)[] = [];
  let automatic = true, closed = false;
  const pending: (() => void)[] = [];
  const deliver = (fn: () => void) => { if (automatic) queueMicrotask(fn); else pending.push(fn); };
  const left = new SyncTransfer({ bufferedAmount: 0, close() { closed = true; }, send(value) {
    leftFrames.push(value); deliver(() => right.receive(value));
  } }, { onMessage() {}, onFailure: e => leftErrors.push(e), ...leftOptions });
  const right = new SyncTransfer({ bufferedAmount: 0, close() { closed = true; }, send(value) {
    rightFrames.push(value); deliver(() => left.receive(value));
  } }, { onMessage() {}, onFailure: e => rightErrors.push(e), ...rightOptions });
  t.after(() => { left.close(); right.close(); });
  return { left, right, leftFrames, rightFrames, leftErrors, rightErrors, pending,
    pause() { automatic = false; }, resume() { automatic = true; pending.splice(0).forEach(fn => fn()); }, get closed() { return closed; } };
}

test('binary frame limits and a four-frame window hold while the receiver pauses, independently of durable acknowledgement', async t => {
  let commit!: () => void, delivered = false, acknowledged = false;
  const durable = new Promise<void>(resolve => { commit = resolve; });
  const bytes = new Uint8Array(TRANSFER_FRAME_BYTES * 9 + 13).fill(173);
  const p = pair(t, {}, { async onMessage(kind, data) { assert.equal(kind, 'update'); assert.deepEqual(data, bytes); delivered = true; await durable; } });
  p.pause(); const sent = p.left.send('update', bytes).then(() => { acknowledged = true; });
  await until(() => p.leftFrames.length === 1 + TRANSFER_WINDOW);
  assert.equal(p.leftFrames.filter(value => value instanceof Uint8Array).length, TRANSFER_WINDOW);
  assert(p.leftFrames.every(value => typeof value === 'string' || value.byteLength <= TRANSFER_FRAME_BYTES));
  p.resume(); await until(() => delivered);
  assert.equal(acknowledged, false); assert(!p.rightFrames.some(value => typeof value === 'string' && JSON.parse(value).type === 'done'));
  commit(); await sent; assert(acknowledged);
});

test('a failed durable publication rejects every pending unit and never emits a done acknowledgment', async t => {
  let committed = false;
  const p = pair(t, {}, { onMessage() { throw new TransferError('storage', 'injected fsync failure'); } });
  const first = p.left.send('update', Uint8Array.of(1)).then(() => { committed = true; });
  const second = p.left.send('update', Uint8Array.of(2));
  await Promise.all([assert.rejects(first, /fsync failure/), assert.rejects(second, /fsync failure/)]);
  assert.equal(committed, false); assert(p.closed);
  assert(!p.rightFrames.some(value => typeof value === 'string' && JSON.parse(value).type === 'done'));
});

test('a lost final acknowledgment leaves the unit unacknowledged and permits safe reconnect replay', async t => {
  let publications = 0, acknowledged = false;
  const p = pair(t, {}, { onMessage() { publications++; p.pause(); } });
  const pending = p.left.send('update', Uint8Array.of(7)).then(() => { acknowledged = true; });
  await until(() => publications === 1); p.left.close(); await assert.rejects(pending, /closed/); assert(!acknowledged);
  const replay = pair(t, {}, { onMessage() { publications++; } });
  await replay.left.send('update', Uint8Array.of(7)); assert.equal(publications, 2);
  // The application must be idempotent (Yjs); transport never invents durability.
});

test('disconnects at each chunk boundary release staging and reject unsaved units', async t => {
  for (let boundary = 0; boundary <= 4; boundary++) {
    let reserved = 0, applied = false;
    const p = pair(t, {}, { reserve(bytes) { reserved += bytes; return () => { reserved -= bytes; }; }, onMessage() { applied = true; } });
    p.pause(); const pending = p.left.send('update', new Uint8Array(TRANSFER_FRAME_BYTES * 4));
    await until(() => p.pending.length === 5);
    p.pending.shift()!(); // header admits staging
    for (let i = 0; i < boundary; i++) p.pending.shift()!();
    assert(reserved > 0); p.right.close(); p.left.close();
    await assert.rejects(pending); assert.equal(reserved, 0); assert.equal(applied, false);
  }
});

test('duplicate and reordered chunks, premature acknowledgments, and corrupt payloads are rejected before publication', async t => {
  for (const corruption of ['duplicate', 'reordered', 'checksum', 'ack'] as const) {
    let applied = false;
    const p = pair(t, {}, { onMessage() { applied = true; } });
    p.pause(); const pending = p.left.send('update', new Uint8Array(TRANSFER_FRAME_BYTES * 2));
    await until(() => p.leftFrames.length === 4);
    p.right.receive(p.leftFrames[0]);
    if (corruption === 'ack') p.left.receive(JSON.stringify({ type: 'done', id: 1 }));
    else if (corruption === 'reordered') p.right.receive(p.leftFrames[2]);
    else if (corruption === 'duplicate') { p.right.receive(p.leftFrames[1]); p.right.receive(p.leftFrames[1]); }
    else {
      const damaged = (p.leftFrames[1] as Uint8Array).slice(); damaged[8] = 99;
      p.right.receive(damaged); p.right.receive(p.leftFrames[2]); p.right.receive(p.leftFrames[3]);
      await until(() => p.rightErrors.length > 0);
    }
    assert.equal(applied, false); p.left.close(); await assert.rejects(pending);
  }
});

test('declared aggregate limits and shared admission failures occur before staging allocation', async t => {
  let reserved = 0;
  const p = pair(t, {}, { reserve(bytes) { reserved += bytes; throw new TransferError('retry', 'staging full'); } });
  const begin = { type: 'begin', id: 1, kind: 'update', bytes: TRANSFER_MAX_BYTES + 1, digest: 'a'.repeat(64) };
  p.right.receive(JSON.stringify(begin)); assert.equal(reserved, 0); assert.equal(p.rightErrors[0].code, 'limit');
  const full = pair(t, {}, { reserve() { throw new TransferError('retry', 'staging full'); } });
  await assert.rejects(full.left.send('update', Uint8Array.of(1)), /staging full/);
});

test('simultaneous upload and download preserve independently ordered units', async t => {
  const receivedLeft: number[] = [], receivedRight: number[] = [];
  const p = pair(t, { onMessage(_kind, value) { receivedLeft.push(value[0]); } }, { onMessage(_kind, value) { receivedRight.push(value[0]); } });
  await Promise.all([p.left.send('update', Uint8Array.of(1)), p.left.send('update', Uint8Array.of(2)),
    p.right.send('update', Uint8Array.of(3)), p.right.send('update', Uint8Array.of(4))]);
  assert.deepEqual(receivedLeft, [3, 4]); assert.deepEqual(receivedRight, [1, 2]);
});

test('snapshot framing validates bounds and exposes views instead of another full update copy', () => {
  const packed = packSync(Uint8Array.of(0, 0), Uint8Array.of(0)), result = unpackSync(packed);
  assert.deepEqual(result.vector, Uint8Array.of(0)); assert.deepEqual(result.update, Uint8Array.of(0, 0));
  assert.equal(result.update.buffer, packed.buffer);
  assert.throws(() => unpackSync(Uint8Array.of(0, 0, 0, 8, 0, 0)), /incompatible vault format/);
});

test('disposable history hints obey a smaller budget without closing current-edit sync', async t => {
  const received: string[] = [];
  const p = pair(t, {}, { onMessage(kind) { received.push(kind); } });
  await assert.rejects(p.left.send('history-boundary', new Uint8Array(TRANSFER_FRAME_BYTES + 1), true), { code: 'limit' });
  assert.equal(p.closed, false); assert.deepEqual(p.leftErrors, []);
  await p.left.send('update', Uint8Array.of(1));
  await p.left.send('sync-complete', new TextEncoder().encode('{}'), true);
  assert.deepEqual(received, ['update', 'sync-complete']);
});

test('an optional history admission failure preserves an already queued current write', async t => {
  let committed!: () => void, received = false, rejectHistory = false;
  const durable = new Promise<void>(resolve => { committed = resolve; });
  const p = pair(t, { reserve() { if (rejectHistory) throw new TransferError('retry', 'Injected budget pressure'); return () => {}; } },
    { async onMessage() { received = true; await durable; } });
  const current = p.left.send('update', Uint8Array.of(1)); await until(() => received); rejectHistory = true;
  await assert.rejects(p.left.send('history-boundary', Uint8Array.of(1), true), /budget pressure/);
  assert.equal(p.closed, false); committed(); await current;
});
