import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { refreshBackgroundAccount, runBackgroundSync } from '../src/core/background-sync';
import { recordBackgroundEvent, readBackgroundLog, rememberBackgroundAccount, BACKGROUND_LOG_LIMIT } from '../src/core/background-state';
import { openPersistenceDatabase } from '../src/core/persistence-database';
import { writePersistenceBatch } from '../src/core/persistence-write';
import { SyncTransfer, packSync } from '../src/core/sync-transfer';
import { applyStoredUpdates } from '../src/core/yjs-updates';

const account = { user: 'test', vaultId: 'background-test-account', authMode: 'password' as const };
beforeEach(() => { globalThis.indexedDB = new IDBFactory(); });

for (const interrupt of [false, true]) test(`background download preserves local pending edits (${interrupt ? 'interrupted' : 'complete'})`, async t => {
  const remote = new Y.Doc(), local = new Y.Doc();
  remote.getText('body').insert(0, 'original');
  Y.applyUpdate(local, Y.encodeStateAsUpdate(remote));
  local.getText('body').insert(8, ' local pending');
  const db = await openPersistenceDatabase(`stow-notes-${account.vaultId}`);
  await db.add('updates', Y.encodeStateAsUpdate(local));
  await db.put('maintenance', 1, 'initialSyncComplete');
  const pending = { sourceIds: ['note'], startedAt: 1, editedAt: 2 };
  await db.put('pendingEdits', pending as any, 'foreground-owner');
  remote.getText('plan').insert(0, 'Flight plan downloaded while closed');
  const abort = new AbortController();
  t.mock.method(globalThis, 'fetch', async () => Response.json({ ...account, authenticated: true }));
  let writes = 0;
  class Socket {
    bufferedAmount = 0; binaryType = ''; onopen?: () => void;
    onmessage?: (event: { data: string | ArrayBuffer }) => void;
    onclose?: () => void; onerror?: () => void;
    peer: SyncTransfer;
    constructor(url: string) {
      assert.equal(new URL(url).searchParams.get('vaultId'), account.vaultId);
      this.peer = new SyncTransfer({ bufferedAmount: 0, close() {}, send: value => {
        queueMicrotask(() => this.onmessage?.({ data: typeof value === 'string' ? value : value.slice().buffer as ArrayBuffer }));
      } }, { onFailure() {}, onMessage: async (kind, vector) => {
        assert.equal(kind, 'sync-request');
        // A foreground writer can commit after the background read. Its append
        // must survive the background writer and subsequent compaction.
        const update: Uint8Array[] = [];
        local.on('update', value => update.push(value));
        local.getText('body').insert(0, 'concurrent ');
        await writePersistenceBatch(db, { batch: update, forceCompact: false, vector: Y.encodeStateVector(local), retired: [] });
        if (interrupt) { abort.abort(); return; }
        void this.peer.send('sync', packSync(Y.encodeStateAsUpdate(remote, vector), Y.encodeStateVector(remote))).catch(() => {});
      } });
      queueMicrotask(() => this.onopen?.());
    }
    send(value: string | Uint8Array) { if (typeof value === 'string' && JSON.parse(value).kind === 'update') writes++; this.peer.receive(value); }
    close() { this.peer.close(); }
  }
  t.mock.property(globalThis, 'WebSocket', Socket as any);
  try {
    const attempt = refreshBackgroundAccount(account, 'http://localhost', abort.signal);
    if (interrupt) await assert.rejects(attempt, /interrupted/); else await attempt;
    const restored = new Y.Doc(); applyStoredUpdates(restored, await db.getAll('updates'));
    assert.equal(restored.getText('body').toString(), 'concurrent original local pending');
    assert.equal(restored.getText('plan').toString(), interrupt ? '' : 'Flight plan downloaded while closed');
    assert.deepEqual(await db.get('pendingEdits', 'foreground-owner'), pending);
    assert.equal(!!(await db.get('maintenance', 'lastSyncAt')), !interrupt);
    assert.equal(writes, 0);
    restored.destroy();
  } finally { db.close(); remote.destroy(); local.destroy(); }
});

for (const session of [
  { ...account, authenticated: false },
  { ...account, authenticated: true, vaultId: 'a-different-account' },
  { ...account, authenticated: true, syncRejection: { code: 'client_update_required' } },
]) test(`background refresh rejects unverified identity/version: ${JSON.stringify(session)}`, async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json(session));
  await assert.rejects(refreshBackgroundAccount(account, 'http://localhost', new AbortController().signal), /account or version changed/);
  assert.deepEqual(await indexedDB.databases(), []);
});

test('a proxy login redirect cannot become a background offline account', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 302, headers: { location: 'https://login.invalid' } }));
  await assert.rejects(refreshBackgroundAccount(account, 'http://localhost', new AbortController().signal), /verify the account/);
  assert.deepEqual(await indexedDB.databases(), []);
});

test('shared sessions cannot replace the private background account', async () => {
  const { rememberBackgroundAccount, openBackgroundDatabase } = await import('../src/core/background-state');
  await rememberBackgroundAccount(account);
  const shared = { ...account, vaultId: 'share_background_document', principalId: 'participant_identity_1234' };
  await assert.rejects(rememberBackgroundAccount(shared), /document scope/);
  const db = await openBackgroundDatabase();
  try { assert.deepEqual(await db.get('account', 'active'), account); } finally { db.close(); }
});

test('background refresh refuses shared scope before opening storage or requesting a session', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected request'); });
  await assert.rejects(refreshBackgroundAccount({ ...account, principalId: 'participant_identity_1234' }, 'http://localhost', new AbortController().signal), /document scope/);
  assert.equal(fetch.mock.callCount(), 0);
  assert.deepEqual(await indexedDB.databases(), []);
});

test('background diagnostics report attempts independently of foreground sync and isolate accounts', async () => {
  const { readBackgroundResult, openBackgroundDatabase } = await import('../src/core/background-state');
  assert.equal(await readBackgroundResult(account), null);
  const result = { attemptedAt: 2000, completedAt: 1000, error: 'Background sync could not verify the account (HTTP 401). Open Stow to sign in.' };
  const db = await openBackgroundDatabase();
  try { await db.put('results', result, account.vaultId); } finally { db.close(); }
  assert.deepEqual(await readBackgroundResult(account), result);
  assert.equal(await readBackgroundResult({ ...account, vaultId: 'another-account-12345' }), null);
  await assert.rejects(readBackgroundResult({ ...account, principalId: 'shared-participant-123' }), /document scope/);
});

test('the background log is bounded per account, survives reopening, and records unfinished attempts', async () => {
  const other = { ...account, vaultId: 'another-background-account' };
  await recordBackgroundEvent(other, { kind: 'wake', runId: 'other-run' }, null);
  for (let i = 0; i < BACKGROUND_LOG_LIMIT + 3; i++) {
    await recordBackgroundEvent(account, { kind: 'wake', runId: String(i) }, null);
  }
  await recordBackgroundEvent(account, { kind: 'started', runId: 'interrupted' }, null);
  const log = await readBackgroundLog(account);
  assert.equal(log.events.length, BACKGROUND_LOG_LIMIT);
  assert.equal(log.events[0].kind, 'wake');
  assert.equal(log.events.at(-1)?.kind, 'started');
  assert.equal(log.result, null);
  assert.equal((await readBackgroundLog(other)).events.length, 1);
  assert.equal((await readBackgroundLog(other)).deviceId, log.deviceId);
  assert.ok(log.deviceId);
  assert.deepEqual(await readBackgroundLog(account), log);
});

for (const busy of [false, true]) test(`a real wake records ${busy ? 'a skipped overlap' : 'an authentication failure'} without touching notes`, async t => {
  t.mock.method(console, 'warn', () => {});
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  await rememberBackgroundAccount(account);
  const original = Object.getOwnPropertyDescriptor(navigator, 'locks');
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: async (_name: string, _options: unknown, run: (lock: unknown) => Promise<void>) => run(busy ? null : {}) } });
  t.after(() => { if (original) Object.defineProperty(navigator, 'locks', original); else Reflect.deleteProperty(navigator, 'locks'); });
  // A wall-clock correction during refresh must not create a negative duration
  // that the diagnostic server would reject, blocking all subsequent log batches.
  const fetch = t.mock.method(globalThis, 'fetch', async () => { now -= 1000; return new Response('', { status: 401 }); });
  const build = 'b'.repeat(40);
  if (busy) await runBackgroundSync('http://localhost', build);
  else await assert.rejects(runBackgroundSync('http://localhost', build), /HTTP 401/);
  const { events, result } = await readBackgroundLog(account);
  assert.deepEqual(events.map(event => event.kind), busy ? ['wake', 'skipped'] : ['wake', 'started', 'failure']);
  assert.equal(new Set(events.map(event => 'runId' in event ? event.runId : null)).size, 1);
  assert.deepEqual([...new Set(events.map(event => event.build))], [build]);
  assert.equal(fetch.mock.callCount(), busy ? 0 : 2); // The uploader independently verifies identity.
  if (!busy) assert.match(result!.error!, /HTTP 401/);
  const failure = events.find(event => event.kind === 'failure');
  if (!busy) assert.ok(failure && failure.durationMs >= 0);
  assert.ok((await indexedDB.databases()).every(db => db.name === 'stow-background-v1'));
});

test('adding the event log keeps an existing background registration and last successful result', async () => {
  const { openDB } = await import('idb');
  const old = await openDB('stow-background-v1', 1, { upgrade(db) { db.createObjectStore('account'); db.createObjectStore('results'); } });
  await old.put('account', account, 'active');
  await old.put('results', { attemptedAt: 100, completedAt: 200 }, account.vaultId);
  old.close();
  await recordBackgroundEvent(account, { kind: 'registration', availability: 'enabled', standalone: true, permission: 'granted' }, null);
  const log = await readBackgroundLog(account);
  assert.deepEqual(log.result, { attemptedAt: 100, completedAt: 200 });
  assert.equal(log.events.length, 1);
});
