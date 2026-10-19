import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { refreshBackgroundAccount } from '../src/core/background-sync';
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
