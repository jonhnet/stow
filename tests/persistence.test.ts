import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import assert from 'node:assert/strict';
import { beforeEach, test, type TestContext } from 'node:test';
import { openDB } from 'idb';
import * as Y from 'yjs';
import { LocalPersistence } from '../src/core/persistence';
import { PERSISTENCE_VERSION, StorageUpdateRequired } from '../src/core/persistence-database';
import { inlinePersistenceWriter } from '../src/core/persistence-write';
import { Vault } from '../src/core/vault';
import { isEmptyUpdate, applyStoredUpdates } from '../src/core/yjs-updates';
import { assertNoReplicatedHistory } from './history-state-fixture';

beforeEach(() => { globalThis.indexedDB = new IDBFactory(); });

for (const duringStartup of [false, true]) test(`a compatibility upgrade drains a pending worker batch (startup: ${duringStartup})`, async t => {
  const doc = new Y.Doc(), errors: Error[] = [];
  const name = 'upgrade-drain';
  let entered!: () => void, rejectWrite: ((error: Error) => void) | undefined;
  const writing = new Promise<void>(resolve => { entered = resolve; });
  let notified = 0;
  if (duringStartup) doc.getText('body').insert(0, 'Unsaved before upgrade');
  const persistence = new LocalPersistence(doc, { databaseName: name,
    onError: error => errors.push(error), onUpgrade: version => { notified = version; },
    writer: { close() { rejectWrite?.(new Error('Worker stopped')); },
      write() { return new Promise((_resolve, reject) => { rejectWrite = reject; entered(); }); } },
  });
  t.after(async () => { rejectWrite?.(new Error('Test finished')); await persistence.destroy().catch(() => {}); doc.destroy(); });
  if (!duringStartup) {
    await persistence.ready;
    doc.getText('body').insert(0, 'Unsaved before upgrade');
  }
  await writing;
  const newer = await openDB(name, PERSISTENCE_VERSION + 1);
  try {
    await persistence.closeForUpgrade();
    assert.equal(notified, PERSISTENCE_VERSION + 1);
    assert.deepEqual(errors, []);
    const restored = new Y.Doc();
    for (const update of await newer.getAll('updates')) Y.applyUpdate(restored, update);
    assert.equal(restored.getText('body').toString(), 'Unsaved before upgrade');
    restored.destroy();
    const before = await newer.getAll('updates');
    doc.getText('body').insert(doc.getText('body').length, ' Must stay isolated');
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(await newer.getAll('updates'), before);
  } finally { newer.close(); }
});

test('an older client cannot open a newer cache and can reload without clearing its contents', async () => {
  const name = 'newer-cache';
  const newer = await openDB(name, PERSISTENCE_VERSION + 1, { upgrade(db) { db.createObjectStore('proof'); } });
  await newer.put('proof', 'Saved data', 'keep'); newer.close();
  const doc = new Y.Doc(), errors: Error[] = [];
  const persistence = new LocalPersistence(doc, { databaseName: name, writer: inlinePersistenceWriter, onError: error => errors.push(error) });
  await assert.rejects(persistence.ready, StorageUpdateRequired);
  await persistence.closeForUpgrade();
  assert.deepEqual(errors, []);
  const reopened = await openDB(name, PERSISTENCE_VERSION + 1);
  assert.equal(await reopened.get('proof', 'keep'), 'Saved data');
  reopened.close(); doc.destroy();
});


function device(t: TestContext, doc = new Y.Doc(), onError?: (error: Error) => void) {
  const errors: Error[] = [];
  let pending = -1;
  const persistence = new LocalPersistence(doc, { writer: inlinePersistenceWriter,
    databaseName: 'stow-notes-persistence-test',
    onError(error) { errors.push(error); onError?.(error); },
    onPending(count) { pending = count; },
  });
  t.after(async () => { await persistence.destroy().catch(() => {}); doc.destroy(); });
  return { doc, persistence, errors, get pending() { return pending; } };
}

async function storedState() {
  const db = await openDB('stow-notes-persistence-test');
  try {
    const updates: Uint8Array[] = await db.getAll('updates');
    const doc = new Y.Doc();
    if (updates.length) Y.applyUpdate(doc, Y.mergeUpdates(updates));
    return { doc, entries: updates.length, bytes: Buffer.concat(updates.map(update => Buffer.from(update))).toString() };
  } finally { db.close(); }
}

test('an empty completed sync survives reload without adding CRDT updates or repeated marker writes', async t => {
  const first = device(t);
  await first.persistence.ready;
  assert.equal(first.persistence.hasSynchronized, false);
  await first.persistence.markSynchronized();
  assert.equal(first.persistence.hasSynchronized, true);
  assert.equal((await storedState()).entries, 0);
  await first.persistence.destroy();
  const reopened = device(t);
  await reopened.persistence.ready;
  assert.equal(reopened.persistence.hasSynchronized, true);
  const put = t.mock.method(IDBObjectStore.prototype, 'put');
  await reopened.persistence.markSynchronized();
  assert.equal(put.mock.callCount(), 0);
  assert.equal((await storedState()).entries, 0);
});

test('initial sync is not marked complete when its current data fails to commit', async t => {
  const first = device(t);
  await first.persistence.ready;
  const add = t.mock.method(IDBObjectStore.prototype, 'add', () => { throw new DOMException('Full', 'QuotaExceededError'); });
  first.doc.getText('body').insert(0, 'Received server note');
  await assert.rejects(first.persistence.markSynchronized(), { name: 'QuotaExceededError' });
  assert.equal(first.persistence.hasSynchronized, false);
  const db = await openDB('stow-notes-persistence-test');
  assert.equal(await db.get('maintenance', 'initialSyncComplete'), undefined);
  db.close(); add.mock.restore();
  await first.persistence.markSynchronized();
  await first.persistence.destroy();
  const reopened = device(t);
  await reopened.persistence.ready;
  assert.equal(reopened.persistence.hasSynchronized, true);
  assert.equal(reopened.doc.getText('body').toString(), 'Received server note');
});

test('empty startup and unchanged reloads do not append or rewrite the update log', async t => {
  const first = device(t);
  await first.persistence.ready;
  assert.equal(first.pending, 0);
  const db = await openDB('stow-notes-persistence-test');
  t.after(() => db.close());
  assert.deepEqual(await db.getAll('updates'), []);
  first.doc.getText('body').insert(0, 'Keep this snapshot');
  await first.persistence.destroy();
  // Reproduce the legacy snapshot + empty records without clearing user storage.
  await db.add('updates', new Uint8Array([0, 0]));
  await db.add('updates', new Uint8Array([0, 0]));
  const before = await db.getAll('updates');
  for (let reload = 0; reload < 3; reload++) {
    const next = device(t);
    await next.persistence.ready;
    assert.equal(next.doc.getText('body').toString(), 'Keep this snapshot');
    await next.persistence.destroy();
    assert.deepEqual(await db.getAll('updates'), before);
  }
});

test('loading an older replicated history log rejects without modifying its stored bytes', async t => {
  const initial = device(t); await initial.persistence.ready; await initial.persistence.destroy();
  const db = await openDB('stow-notes-persistence-test'); t.after(() => db.close());
  const old = new Y.Doc(); t.after(() => old.destroy());
  old.getMap('revisions').set('old-revision', { id: 'old-revision', label: 'Preserve this old history' });
  const update = Y.encodeStateAsUpdate(old);
  await db.add('updates', update);
  const doc = new Y.Doc();
  const vault = new Vault(doc); t.after(() => vault.destroy());
  const reloaded = device(t, doc);
  await assert.rejects(reloaded.persistence.ready, /older history format/);
  assert.equal(reloaded.errors.length, 1);
  assert.match(reloaded.errors[0].message, /older history format/);
  assert.deepEqual(await db.getAll('updates'), [update], 'Rejecting an incompatible log must leave its bytes intact');
});

test('stored updates retain deletion-only changes and notify observers once with the complete state', () => {
  const doc = new Y.Doc(), restored = new Y.Doc();
  try {
    doc.getText('body').insert(0, 'Erase this');
    const snapshot = Y.encodeStateAsUpdate(doc);
    const empty = new Uint8Array([0, 0]);
    let deletion!: Uint8Array;
    doc.on('update', update => { deletion = update; });
    doc.getText('body').delete(0, 10);
    assert.equal(Y.decodeUpdate(deletion).structs.length, 0);
    assert.equal(isEmptyUpdate(deletion), false);
    const observed: string[] = [];
    restored.getText('body').observe(() => observed.push(restored.getText('body').toString()));
    applyStoredUpdates(restored, [empty, snapshot, deletion, snapshot, empty]);
    assert.equal(restored.getText('body').toString(), '');
    assert.deepEqual(observed, ['']);
    applyStoredUpdates(restored, [empty, empty]);
    assert.deepEqual(observed, ['']);
  } finally { doc.destroy(); restored.destroy(); }
});

test('out-of-order stored updates resolve dependencies in one remote transaction', () => {
  const source = new Y.Doc(), restored = new Y.Doc(), expected = new Y.Doc();
  try {
    const updates: Uint8Array[] = [];
    source.on('update', bytes => updates.push(bytes));
    source.getText('body').insert(0, 'Original');
    source.getText('body').insert(8, ' then appended');
    source.getText('body').delete(0, 8);
    const reversed = [...updates].reverse();
    Y.applyUpdate(expected, Y.mergeUpdates(reversed));
    const origin = Symbol('load');
    const observed: unknown[] = [];
    restored.getText('body').observe((_event, transaction) => {
      observed.push([restored.getText('body').toString(), transaction.origin, transaction.local]);
    });
    applyStoredUpdates(restored, reversed, origin);
    assert.deepEqual(observed, [[' then appended', origin, false]]);
    assert.deepEqual(Y.encodeStateAsUpdate(restored), Y.encodeStateAsUpdate(expected));
  } finally { source.destroy(); restored.destroy(); expected.destroy(); }
});

test('loading persisted text does not serialize it again, and the next edit remains durable', async t => {
  const first = device(t);
  await first.persistence.ready;
  first.doc.getText('body').insert(0, 'Stored text');
  await first.persistence.destroy();
  const write = t.mock.method(Y.ContentString.prototype, 'write');
  const doc = new Y.Doc();
  const observed: string[] = [];
  doc.getText('body').observe(() => observed.push(doc.getText('body').toString()));
  const reopened = device(t, doc);
  await reopened.persistence.ready;
  assert.deepEqual(observed, ['Stored text']);
  assert.equal(write.mock.callCount(), 0, 'Loading must not encode the text for an unused update event');
  doc.getText('body').insert(11, ' plus a new edit');
  await reopened.persistence.whenDurable();
  assert(write.mock.callCount() > 0, 'Actual edits still need update bytes');
  const stored = await storedState();
  try { assert.equal(stored.doc.getText('body').toString(), 'Stored text plus a new edit'); }
  finally { stored.doc.destroy(); }
});

test('changes made by observers during loading are saved separately from the loaded data', async t => {
  const first = device(t);
  await first.persistence.ready;
  first.doc.getText('body').insert(0, 'Stored text');
  await first.persistence.destroy();
  const doc = new Y.Doc();
  doc.getText('body').observe(() => { doc.getText('observer').insert(0, 'Created while loading'); });
  const reopened = device(t, doc);
  await reopened.persistence.ready;
  assert.equal(reopened.pending, 0);
  const stored = await storedState();
  try {
    assert.equal(stored.entries, 2, 'Only the observer-created change is appended');
    assert.equal(stored.doc.getText('body').toString(), 'Stored text');
    assert.equal(stored.doc.getText('observer').toString(), 'Created while loading');
  } finally { stored.doc.destroy(); }
});

test('ready commits both preexisting state and edits made while IndexedDB opens', async t => {
  const doc = new Y.Doc();
  doc.getText('before').insert(0, 'Already in memory');
  const first = device(t, doc);
  doc.getText('during').insert(0, 'Typed before ready');
  assert(first.pending > 0, 'In-memory work must not be reported as committed');

  await first.persistence.ready;
  assert.equal(first.pending, 0);
  assert.deepEqual(first.errors, []);
  await first.persistence.destroy();

  const reopened = device(t);
  await reopened.persistence.ready;
  assert.equal(reopened.doc.getText('before').toString(), 'Already in memory');
  assert.equal(reopened.doc.getText('during').toString(), 'Typed before ready');
  assert.deepEqual(reopened.errors, []);
});

test('concurrent adapters compact over 500 updates without deleting another device history', async t => {
  const left = device(t);
  const right = device(t);
  await Promise.all([left.persistence.ready, right.persistence.ready]);

  // These documents never exchange updates in memory. Compaction has to read
  // every persisted update, rather than replace storage with one tab's state.
  for (let i = 0; i < 310; i++) {
    left.doc.getMap('left').set(String(i), `left ${i}`);
    right.doc.getMap('right').set(String(i), `right ${i}`);
  }
  await Promise.all([left.persistence.destroy(), right.persistence.destroy()]);
  assert.equal(left.pending, 0);
  assert.equal(right.pending, 0);
  assert.deepEqual([...left.errors, ...right.errors], []);

  const stored = await storedState();
  try {
    assert(stored.entries < 500, 'The append log should have been compacted');
    assert.equal(stored.doc.getMap('left').size, 310);
    assert.equal(stored.doc.getMap('right').size, 310);
    for (let i = 0; i < 310; i++) {
      assert.equal(stored.doc.getMap('left').get(String(i)), `left ${i}`);
      assert.equal(stored.doc.getMap('right').get(String(i)), `right ${i}`);
    }
  } finally { stored.doc.destroy(); }

  const reopened = device(t);
  await reopened.persistence.ready;
  assert.equal(reopened.doc.getMap('left').size, 310);
  assert.equal(reopened.doc.getMap('right').size, 310);
});

test('quota failures retain pending edits and retry the full batch on a subsequent edit', async t => {
  let reportFailure!: (error: Error) => void;
  const failed = new Promise<Error>(resolve => { reportFailure = resolve; });
  const first = device(t, new Y.Doc(), reportFailure);
  await first.persistence.ready;
  const originalAdd = IDBObjectStore.prototype.add;
  let quotaExceeded = true;
  const add = t.mock.method(IDBObjectStore.prototype, 'add', function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['add']>) {
    if (this.name === 'updates' && quotaExceeded) throw new DOMException('Simulated full storage', 'QuotaExceededError');
    return originalAdd.apply(this, args);
  });

  try {
    first.doc.getText('body').insert(0, 'Keep this edit');
    assert.equal((await failed).name, 'QuotaExceededError');
    assert(first.pending > 0, 'A failed write must remain pending');
    const beforeRetry = await storedState();
    try { assert.equal(beforeRetry.doc.getText('body').toString(), ''); }
    finally { beforeRetry.doc.destroy(); }

    quotaExceeded = false;
    first.doc.getText('body').insert(first.doc.getText('body').length, ' and this one');
    await first.persistence.destroy();
    assert.equal(first.pending, 0);

    const reopened = device(t);
    await reopened.persistence.ready;
    assert.equal(reopened.doc.getText('body').toString(), 'Keep this edit and this one');
  } finally { add.mock.restore(); }
});

test('an aborted transaction is not acknowledged even when its individual requests succeeded', async t => {
  let reportFailure!: (error: Error) => void;
  const failed = new Promise<Error>(resolve => { reportFailure = resolve; });
  const first = device(t, new Y.Doc(), reportFailure);
  await first.persistence.ready;
  const originalCount = IDBObjectStore.prototype.count;
  let abortCommit = true;
  const count = t.mock.method(IDBObjectStore.prototype, 'count', function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['count']>) {
    const request = originalCount.apply(this, args);
    if (this.name === 'updates' && abortCommit) request.addEventListener('success', () => this.transaction.abort(), { once: true });
    return request;
  });

  try {
    first.doc.getText('body').insert(0, 'Await the commit');
    assert.equal((await failed).name, 'AbortError');
    assert(first.pending > 0);
    const rolledBack = await storedState();
    try { assert.equal(rolledBack.doc.getText('body').toString(), ''); }
    finally { rolledBack.doc.destroy(); }

    abortCommit = false;
    // destroy() must flush the retained batch even without another edit.
    await first.persistence.destroy();
    assert.equal(first.pending, 0);
    const reopened = device(t);
    await reopened.persistence.ready;
    assert.equal(reopened.doc.getText('body').toString(), 'Await the commit');
  } finally { count.mock.restore(); }
});

test('an IndexedDB open failure rejects ready and reports unsaved state', async t => {
  const open = t.mock.method(indexedDB, 'open', () => { throw new DOMException('Storage disabled', 'SecurityError'); });
  try {
    const first = device(t);
    first.doc.getText('body').insert(0, 'Still in memory');
    await assert.rejects(first.persistence.ready, { name: 'SecurityError' });
    assert.equal(first.errors.length, 1);
    assert.equal(first.errors[0].name, 'SecurityError');
    assert(first.pending > 0);
    assert.equal(first.doc.getText('body').toString(), 'Still in memory');
    await assert.rejects(first.persistence.destroy(), { name: 'SecurityError' });
  } finally { open.mock.restore(); }
});

test('synchronous note and completed timestamp transactions commit in the same local batch', async t => {
  const first = device(t);
  await first.persistence.ready;
  const originalAdd = IDBObjectStore.prototype.add;
  const transactions = new Set<IDBTransaction>();
  const add = t.mock.method(IDBObjectStore.prototype, 'add', function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['add']>) {
    if (this.name === 'updates') transactions.add(this.transaction);
    return originalAdd.apply(this, args);
  });
  try {
    first.doc.getMap('notes').set('one', 'Undo applied');
    first.doc.getMap('modified').set('one', 1_700_000_000_000);
    await first.persistence.whenDurable();
    assert.equal(transactions.size, 1);
    const stored = await storedState();
    try {
      assert.equal(stored.doc.getMap('notes').get('one'), 'Undo applied');
      assert.equal(stored.doc.getMap('modified').get('one'), 1_700_000_000_000);
      assertNoReplicatedHistory(stored.doc);
    } finally { stored.doc.destroy(); }
  } finally { add.mock.restore(); }
});

test('local compaction collects obsolete payloads while preserving unrelated current content', async t => {
  const first = device(t);
  await first.persistence.ready;
  first.doc.getMap('notes').set('other', 'Keep this unrelated current content');
  for (let i = 0; i < 510; i++) first.doc.getMap('notes').set('body', `${i}:${'x'.repeat(2000)}`);
  await first.persistence.whenDurable();
  const db = await openDB('stow-notes-persistence-test');
  try {
    const updates: Uint8Array[] = await db.getAll('updates');
    assert(updates.reduce((bytes, update) => bytes + update.byteLength, 0) < 20_000, 'Obsolete overwritten content must not remain in compacted update bytes');
  } finally { db.close(); }
  const stored = await storedState();
  try {
    assert.equal(stored.doc.getMap('notes').get('body'), `509:${'x'.repeat(2000)}`);
    assert.equal(stored.doc.getMap('notes').get('other'), 'Keep this unrelated current content');
    assertNoReplicatedHistory(stored.doc);
  } finally { stored.doc.destroy(); }
});

function deletionFixture(t: TestContext, onError?: (error: Error) => void) {
  const vault = new Vault();
  const erased = vault.createNote('checklist', { title: 'ERASED_TITLE_PAYLOAD', body: 'ERASED_OLD_BODY_PAYLOAD' });
  vault.setNoteText(erased, 'body', 'ERASED_CURRENT_BODY_PAYLOAD');
  vault.addItem(erased, 'ERASED_CHECKLIST_PAYLOAD');
  vault.setNoteMeta(erased, { trashed: true });
  const kept = vault.createNote('text', { title: 'Kept note', body: 'Kept historical paragraph' });
  vault.setNoteText(kept, 'body', 'Kept current paragraph');
  const first = device(t, vault.doc, onError);
  t.after(() => vault.destroy());
  return { first, vault, erased, kept };
}

async function assertErasedStorage(erased: string, kept: string) {
  const stored = await storedState();
  try {
    assert(!stored.bytes.includes('ERASED_'), 'The raw update log must reclaim erased text and history payloads');
    assert(!stored.doc.getMap('notes').has(erased));
    assert(stored.doc.getMap('notes').has(kept));
    assertNoReplicatedHistory(stored.doc);
    const rawKept = stored.doc.getMap<Y.Map<unknown>>('notes').get(kept)!;
    assert.equal(rawKept.get('title')?.toString(), 'Kept note');
    assert(rawKept.get('body')?.toString(), 'Unrelated current content must remain available');
    return stored.entries;
  } finally { stored.doc.destroy(); }
}

test('a remotely received deletion immediately compacts raw update bytes, while subsequent ordinary edits append normally', async t => {
  const { first, vault, erased, kept } = deletionFixture(t);
  await first.persistence.ready;
  const before = await storedState();
  try { assert(before.bytes.includes('ERASED_')); } finally { before.doc.destroy(); }
  const remote = new Vault();
  try {
    Y.applyUpdate(remote.doc, Y.encodeStateAsUpdate(vault.doc));
    remote.deleteNotesForever([erased]);
    // This arrives with a transport origin and already includes the cleanup.
    // Detecting only the local cleanup origin would leave old bytes on disk.
    Y.applyUpdate(vault.doc, Y.encodeStateAsUpdate(remote.doc), 'remote');
  } finally { remote.destroy(); }
  await first.persistence.whenDurable();
  assert.equal(await assertErasedStorage(erased, kept), 1);

  vault.setNoteText(kept, 'body', 'An ordinary later edit');
  await first.persistence.whenDurable();
  assert((await assertErasedStorage(erased, kept)) > 1, 'A deletion marker must not force full compaction on every later edit');
  assert.deepEqual(first.errors, []);
});

test('startup compacts stale-tab content appended after a deletion snapshot and preserves that tab’s unrelated writes', async t => {
  const { first, vault, erased, kept } = deletionFixture(t);
  await first.persistence.ready;
  const stale = new Vault();
  try {
    Y.applyUpdate(stale.doc, Y.encodeStateAsUpdate(vault.doc));
    vault.deleteNotesForever([erased]);
    await first.persistence.whenDurable();
    await first.persistence.destroy();
    stale.setNoteMeta(erased, { trashed: false });
    stale.addItem(erased, 'ERASED_LATE_CHECKLIST_PAYLOAD');
    stale.setNoteText(erased, 'body', 'ERASED_LATE_BODY_PAYLOAD');
    const other = stale.createNote('text', { title: 'Unrelated stale-tab note' });
    const db = await openDB('stow-notes-persistence-test');
    try { await db.add('updates', Y.encodeStateAsUpdate(stale.doc)); } finally { db.close(); }
    const before = await storedState();
    try { assert(before.bytes.includes('ERASED_LATE_')); } finally { before.doc.destroy(); }

    const reopened = device(t);
    await reopened.persistence.ready;
    assert.equal(await assertErasedStorage(erased, kept), 1);
    const after = await storedState();
    try {
      assert.equal(after.doc.getMap('items').size, 0);
      assert(after.doc.getMap('notes').has(other));
    } finally { after.doc.destroy(); }
  } finally { stale.destroy(); }
});

test('validated post-cleanup storage reloads without rewriting the durable log', async t => {
  const { first, vault, erased, kept } = deletionFixture(t);
  await first.persistence.ready;
  vault.deleteNotesForever([erased]);
  await first.persistence.whenDurable();
  vault.setNoteText(kept, 'body', 'Valid post-cleanup input');
  vault.finishEdit();
  await first.persistence.destroy();
  const db = await openDB('stow-notes-persistence-test'); t.after(() => db.close());
  // New post-deletion appends are checked once; unchanged reloads then only read.
  const validated = device(t); await validated.persistence.ready; await validated.persistence.destroy();
  const keys = await db.getAllKeys('updates'), before = await db.getAll('updates');
  assert.equal(keys.length, 1);
  assert.equal(await db.get('maintenance', 'validatedThrough'), keys.at(-1));
  for (let i = 0; i < 3; i++) {
    const next = device(t); await next.persistence.ready; await next.persistence.destroy();
    assert.deepEqual(await db.getAllKeys('updates'), keys);
    assert.deepEqual(await db.getAll('updates'), before);
  }
});

test('deletion compaction preserves simultaneous writes from another adapter that has not received the deleting tab’s updates', async t => {
  const { first, vault, erased, kept } = deletionFixture(t);
  const second = device(t);
  await Promise.all([first.persistence.ready, second.persistence.ready]);
  vault.deleteNotesForever([erased]);
  for (let index = 0; index < 8; index++) second.doc.getMap('unrelated').set(String(index), `Other tab edit ${index}`);
  await Promise.all([first.persistence.whenDurable(), second.persistence.whenDurable()]);
  await assertErasedStorage(erased, kept);
  const stored = await storedState();
  try {
    for (let index = 0; index < 8; index++) assert.equal(stored.doc.getMap('unrelated').get(String(index)), `Other tab edit ${index}`);
  } finally { stored.doc.destroy(); }
});

test('cleanup arriving during an in-flight deletion snapshot forces another compact instead of appending erased bytes', async t => {
  const { first, vault, erased, kept } = deletionFixture(t);
  await first.persistence.ready;
  const stale = new Vault();
  Y.applyUpdate(stale.doc, Y.encodeStateAsUpdate(vault.doc));
  stale.setNoteMeta(erased, { trashed: false });
  stale.addItem(erased, 'ERASED_DURING_COMPACTION');
  const late = Y.encodeStateAsUpdate(stale.doc);
  stale.destroy();
  const originalClear = IDBObjectStore.prototype.clear;
  let delivered = false;
  const clear = t.mock.method(IDBObjectStore.prototype, 'clear', function (this: IDBObjectStore) {
    const request = originalClear.call(this);
    if (this.name === 'updates' && !delivered) request.addEventListener('success', () => {
      delivered = true;
      Y.applyUpdate(vault.doc, late, 'remote');
    }, { once: true });
    return request;
  });
  try {
    vault.deleteNotesForever([erased]);
    await first.persistence.whenDurable();
    assert(delivered, 'The stale update must arrive between clearing and committing the initial snapshot');
    assert.equal(await assertErasedStorage(erased, kept), 1);
    assert.equal(first.pending, 0);
  } finally { clear.mock.restore(); }
});

test('a failed deletion snapshot rolls back the whole replacement and retries without losing pending changes', async t => {
  let reportFailure!: (error: Error) => void;
  const failed = new Promise<Error>(resolve => { reportFailure = resolve; });
  const { first, vault, erased, kept } = deletionFixture(t, reportFailure);
  await first.persistence.ready;
  const originalClear = IDBObjectStore.prototype.clear, originalAdd = IDBObjectStore.prototype.add;
  const replacements = new WeakSet<IDBTransaction>();
  let failSnapshot = true;
  const clear = t.mock.method(IDBObjectStore.prototype, 'clear', function (this: IDBObjectStore) {
    if (this.name === 'updates') replacements.add(this.transaction);
    return originalClear.call(this);
  });
  const add = t.mock.method(IDBObjectStore.prototype, 'add', function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['add']>) {
    if (failSnapshot && replacements.has(this.transaction)) throw new DOMException('Simulated snapshot storage failure', 'QuotaExceededError');
    return originalAdd.apply(this, args);
  });
  try {
    vault.deleteNotesForever([erased]);
    assert.equal((await failed).name, 'QuotaExceededError');
    assert(first.pending > 0, 'Deletion is still pending when its compacted snapshot could not be committed');
    const rolledBack = await storedState();
    try {
      assert(rolledBack.bytes.includes('ERASED_'));
      assert(rolledBack.doc.getMap('notes').has(erased), 'Clearing without a durable replacement must roll back');
      assert(rolledBack.doc.getMap('notes').has(kept));
    } finally { rolledBack.doc.destroy(); }

    failSnapshot = false;
    vault.setNoteText(kept, 'body', 'A pending edit alongside the retried deletion');
    await first.persistence.whenDurable();
    assert.equal(await assertErasedStorage(erased, kept), 1);
    assert.equal(first.pending, 0);
    const retried = await storedState();
    try { assert(retried.bytes.includes('A pending edit alongside the retried deletion')); }
    finally { retried.doc.destroy(); }
  } finally { clear.mock.restore(); add.mock.restore(); }
});
