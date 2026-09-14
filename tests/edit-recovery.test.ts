import { inlinePersistenceWriter } from '../src/core/persistence-write';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import assert from 'node:assert/strict';
import { beforeEach, test, type TestContext } from 'node:test';
import { openDB } from 'idb';
import * as Y from 'yjs';
import { LocalPersistence } from '../src/core/persistence';
import { browserEditOwnership, type EditOwnership } from '../src/core/edit-ownership';
import type { PendingEdit } from '../src/core/history-types';
import { Vault } from '../src/core/vault';

beforeEach(() => { globalThis.indexedDB = new IDBFactory(); });
const DATABASE = 'stow-edit-recovery-test';

class Ownership implements EditOwnership {
  owners = new Set<string>();
  async acquire(owner: string, ifAvailable: boolean) {
    if (this.owners.has(owner)) {
      if (ifAvailable) return null;
      throw new Error('Test writer is already active');
    }
    this.owners.add(owner); return () => { this.owners.delete(owner); };
  }
}

function page(t: TestContext, owner: string, ownership: Ownership, onError?: (error: Error) => void) {
  const doc = new Y.Doc(), listeners = new Set<() => void>();
  let current: PendingEdit | null = null, pending = 0, time = 10;
  const recovered: PendingEdit[] = [], errors: Error[] = [];
  const persistence = new LocalPersistence(doc, { writer: inlinePersistenceWriter,
    databaseName: DATABASE,
    onError(error) { errors.push(error); onError?.(error); }, onPending(count) { pending = count; },
    edits: { owner, ownership, getPending: () => current,
      onPendingChange(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
      recover(saved) {
        recovered.push(saved);
        doc.transact(() => {
          for (const [id, timestamp] of Object.entries(saved.modifiedAt)) {
            const note = doc.getMap<Y.Map<any>>('notes').get(id);
            if (note && !doc.getMap('deletedNotes').has(id)) note.set('updatedAt', Math.max(note.get('updatedAt'), timestamp));
          }
        }, 'timestamp-recovery');
      },
    },
  });
  t.after(async () => { await persistence.destroy().catch(() => {}); doc.destroy(); });
  return { doc, persistence, recovered, errors, get pending() { return pending; },
    setPending(value: PendingEdit | null) { current = value; listeners.forEach(listener => listener()); },
    type(body: string, source = 'note') {
      doc.transact(() => {
        const notes = doc.getMap<Y.Map<any>>('notes');
        if (!notes.has(source)) { const note = new Y.Map(); notes.set(source, note); note.set('body', new Y.Text()); note.set('updatedAt', 1); }
        const text = notes.get(source)!.get('body') as Y.Text;
        text.delete(0, text.length); text.insert(0, body);
        current = { modifiedAt: { [source]: ++time } }; listeners.forEach(listener => listener());
      }, 'typing');
    },
  };
}
const body = (doc: Y.Doc, source = 'note') => doc.getMap<Y.Map<any>>('notes').get(source)?.get('body')?.toString();
const modified = (doc: Y.Doc, source = 'note') => doc.getMap<Y.Map<any>>('notes').get(source)?.get('updatedAt');
async function stored() {
  const db = await openDB(DATABASE);
  try {
    const doc = new Y.Doc(), updates: Uint8Array[] = await db.getAll('updates');
    for (const update of updates) Y.applyUpdate(doc, update);
    return { doc, pending: await db.getAll('pendingEdits') as PendingEdit[], owners: await db.getAllKeys('pendingEdits') };
  } finally { db.close(); }
}

test('one timestamp row accompanies durable live text; orphan recovery advances time without retaining text history', async t => {
  const ownership = new Ownership(), first = page(t, 'first', ownership); await first.persistence.ready;
  for (const text of ['h', 'he', 'hello']) { first.type(text); await first.persistence.whenDurable(); }
  const typed = await stored();
  assert.equal(body(typed.doc), 'hello'); assert.equal(modified(typed.doc), 1);
  assert.deepEqual(typed.pending, [{ modifiedAt: { note: 13 } }]); assert(!JSON.stringify(typed.pending).includes('hello')); typed.doc.destroy();
  await first.persistence.destroy();
  const second = page(t, 'second', ownership); await second.persistence.ready;
  assert.equal(body(second.doc), 'hello'); assert.equal(modified(second.doc), 13); assert.equal(second.recovered.length, 1);
  const recovered = await stored(); assert.deepEqual(recovered.pending, []); assert.equal(modified(recovered.doc), 13); recovered.doc.destroy();
  await second.persistence.destroy();
  const third = page(t, 'third', ownership); await third.persistence.ready;
  assert.equal(third.recovered.length, 0); assert.equal(modified(third.doc), 13); assert(!third.doc.share.has('revisions'));
});

test('new pages leave active writers’ timestamp metadata untouched', async t => {
  const ownership = new Ownership(), first = page(t, 'first', ownership); await first.persistence.ready;
  first.type('still typing'); await first.persistence.whenDurable();
  const second = page(t, 'second', ownership); await second.persistence.ready;
  assert.equal(second.recovered.length, 0); assert.equal(modified(second.doc), 1);
  const current = await stored(); assert.deepEqual(current.owners, ['first']); current.doc.destroy();
});

test('failed metadata writes roll back both current text and its timestamp, and retry retains the batch', async t => {
  let report!: (error: Error) => void; const failed = new Promise<Error>(resolve => { report = resolve; });
  const first = page(t, 'first', new Ownership(), report); await first.persistence.ready;
  first.type('before'); await first.persistence.whenDurable();
  const put = IDBObjectStore.prototype.put; let fail = true;
  t.mock.method(IDBObjectStore.prototype, 'put', function(this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
    if (this.name === 'pendingEdits' && fail) throw new DOMException('Storage full', 'QuotaExceededError');
    return put.apply(this, args);
  });
  first.type('after'); assert.equal((await failed).name, 'QuotaExceededError'); assert(first.pending > 0);
  const rollback = await stored(); assert.equal(body(rollback.doc), 'before'); assert.deepEqual(rollback.pending, [{ modifiedAt: { note: 11 } }]); rollback.doc.destroy();
  fail = false; await first.persistence.whenDurable();
  const retried = await stored(); assert.equal(body(retried.doc), 'after'); assert.deepEqual(retried.pending, [{ modifiedAt: { note: 12 } }]); retried.doc.destroy();
  first.setPending(null); await first.persistence.whenDurable();
  const cleared = await stored(); assert.deepEqual(cleared.pending, []); cleared.doc.destroy();
});

test('an edit arriving during a metadata write keeps its matching current update for the next transaction', async t => {
  const first = page(t, 'first', new Ownership()); await first.persistence.ready;
  const put = IDBObjectStore.prototype.put; let intervened = false;
  t.mock.method(IDBObjectStore.prototype, 'put', function(this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
    const request = put.apply(this, args);
    if (this.name === 'pendingEdits' && !intervened) request.addEventListener('success', () => { intervened = true; first.type('newer'); }, { once: true });
    return request;
  });
  first.type('first'); await first.persistence.whenDurable(); const latest = await stored();
  assert(intervened); assert.equal(first.pending, 0); assert.equal(body(latest.doc), 'newer');
  assert.deepEqual(latest.pending, [{ modifiedAt: { note: 12 } }]); latest.doc.destroy();
});

test('failed recovery commits neither recovered time nor retirement', async t => {
  const ownership = new Ownership(), first = page(t, 'first', ownership); await first.persistence.ready;
  first.type('recover me'); await first.persistence.destroy();
  const remove = IDBObjectStore.prototype.delete; let fail = true;
  t.mock.method(IDBObjectStore.prototype, 'delete', function(this: IDBObjectStore, ...args: Parameters<IDBObjectStore['delete']>) {
    if (this.name === 'pendingEdits' && fail) throw new DOMException('Storage failed', 'QuotaExceededError');
    return remove.apply(this, args);
  });
  const second = page(t, 'second', ownership); await assert.rejects(second.persistence.ready, { name: 'QuotaExceededError' });
  const rollback = await stored(); assert.equal(rollback.pending.length, 1); assert.equal(modified(rollback.doc), 1); rollback.doc.destroy();
  fail = false; const third = page(t, 'third', ownership); await third.persistence.ready; assert.equal(modified(third.doc), 11);
});

test('deletion erases current text and pending metadata; stale timestamp-only writes cannot resurrect it', async t => {
  const ownership = new Ownership(), first = page(t, 'first', ownership); await first.persistence.ready;
  first.type('ERASED_TEXT', 'gone'); await first.persistence.whenDurable();
  const second = page(t, 'second', ownership); await second.persistence.ready;
  second.doc.getMap('deletedNotes').set('gone', true); await second.persistence.whenDurable();
  let saved = await stored(); assert.deepEqual(saved.pending, []); assert.equal(body(saved.doc, 'gone'), undefined); saved.doc.destroy();
  // This stale page has not received the deletion. Its row contains no payload.
  first.setPending({ modifiedAt: { gone: 30 } }); await first.persistence.whenDurable();
  saved = await stored(); assert(!JSON.stringify(saved.pending).includes('ERASED_TEXT')); saved.doc.destroy();
  await first.persistence.destroy(); await second.persistence.destroy();
  const third = page(t, 'third', ownership); await third.persistence.ready;
  assert.equal(third.recovered.length, 0); assert.equal(body(third.doc, 'gone'), undefined);
  saved = await stored(); assert.deepEqual(saved.pending, []); saved.doc.destroy();
});

test('partial deletion retains only surviving pending modification times during recovery', async t => {
  const ownership = new Ownership(), first = page(t, 'first', ownership); await first.persistence.ready;
  first.type('Gone', 'gone'); first.type('Surviving unfinished text', 'kept');
  const mixed = { modifiedAt: { gone: 20, kept: 30 } }; first.setPending(mixed); await first.persistence.whenDurable();
  const second = page(t, 'second', ownership); await second.persistence.ready;
  second.doc.getMap('deletedNotes').set('gone', true); await second.persistence.whenDurable();
  const redacted = await stored(); assert.deepEqual(redacted.pending, [{ modifiedAt: { kept: 30 } }]); redacted.doc.destroy();
  first.setPending(mixed); await first.persistence.whenDurable();
  await first.persistence.destroy(); await second.persistence.destroy();
  const third = page(t, 'third', ownership); await third.persistence.ready;
  assert.deepEqual(third.recovered, [{ modifiedAt: { kept: 30 } }]); assert.equal(modified(third.doc, 'kept'), 30);
  assert.equal(body(third.doc, 'gone'), undefined);
});

test('parked pages release ownership only after current edits and timestamp metadata are durable', async t => {
  const ownership = new Ownership(), first = page(t, 'first', ownership); await first.persistence.ready;
  first.type('parked'); assert(ownership.owners.has('first')); await first.persistence.destroy(); assert(!ownership.owners.has('first'));
  const second = page(t, 'second', ownership); await second.persistence.ready;
  assert.equal(second.recovered.length, 1); assert.equal(body(second.doc), 'parked'); assert.equal(modified(second.doc), 11);
});

for (const version of [1, 3]) test(`older local schema version ${version} is rejected without changing stored data`, async t => {
  const old = await openDB(DATABASE, version, { upgrade(db) {
    db.createObjectStore('updates', { autoIncrement: true }); if (version === 3) db.createObjectStore('edits');
  } });
  const doc = new Y.Doc(); doc.getText('note').insert(0, 'existing vault');
  const update = Y.encodeStateAsUpdate(doc); await old.add('updates', update); old.close(); doc.destroy();
  const first = page(t, 'first', new Ownership()); await assert.rejects(first.persistence.ready, /older Stow storage format/);
  const db = await openDB(DATABASE); assert.equal(db.version, version); assert.deepEqual(await db.getAll('updates'), [update]);
  assert(!db.objectStoreNames.contains('pendingEdits')); db.close();
});

test('Web Locks are an explicit browser requirement', () => {
  if (!globalThis.navigator?.locks) assert.throws(() => browserEditOwnership('vault'), /requires.*Web Locks/);
});

function vaultPage(t: TestContext, owner: string, ownership: Ownership) {
  const vault = new Vault(), errors: Error[] = [];
  const persistence = new LocalPersistence(vault.doc, { writer: inlinePersistenceWriter,
    databaseName: DATABASE, onError: error => { errors.push(error); },
    edits: { owner, ownership, getPending: () => vault.getPendingEdit(),
      onPendingChange: listener => vault.onPendingEditChange(listener), recover: saved => vault.recoverPendingEdit(saved) },
  });
  t.after(async () => { await persistence.destroy().catch(() => {}); vault.destroy(); }); return { vault, persistence, errors };
}

test('real Vault recovery preserves a later peer result and later modification time without uploading a history hint', async t => {
  let now = 1000; t.mock.method(Date, 'now', () => now);
  const ownership = new Ownership(), first = vaultPage(t, 'first', ownership); await first.persistence.ready;
  const note = first.vault.createNote('text', { body: 'initial' });
  now = 2000; first.vault.setNoteText(note, 'body', 'author before phone closed'); await first.persistence.whenDurable();
  const second = vaultPage(t, 'second', ownership); await second.persistence.ready;
  now = 3000; second.vault.setNoteText(note, 'body', 'peer changed this later'); second.vault.finishEdit(); await second.persistence.whenDurable();
  await first.persistence.destroy();
  const third = vaultPage(t, 'third', ownership); let hints = 0; third.vault.onHistoryBoundary(() => hints++); await third.persistence.ready;
  assert.equal(third.vault.getNote(note)!.body, 'peer changed this later'); assert.equal(third.vault.getNote(note)!.updatedAt, 3000);
  assert.equal(hints, 0); assert.equal(third.vault.getEditDraft(), null); assert.deepEqual(third.errors, []);
  const saved = await stored(); assert.deepEqual(saved.pending, []); saved.doc.destroy();
});

test('closing during startup recovery persists its modification time before retiring metadata', async t => {
  let now = 1000; t.mock.method(Date, 'now', () => now);
  const ownership = new Ownership(), first = vaultPage(t, 'first', ownership); await first.persistence.ready;
  const note = first.vault.createNote(); now = 2000; first.vault.setNoteText(note, 'body', 'Durable interrupted text'); await first.persistence.destroy();
  const second = vaultPage(t, 'second', ownership); await second.persistence.destroy();
  const saved = await stored(); assert.deepEqual(saved.pending, []); assert.equal(modified(saved.doc, note), 2000); saved.doc.destroy();
  const third = vaultPage(t, 'third', ownership); await third.persistence.ready;
  assert.equal(third.vault.getNote(note)!.body, 'Durable interrupted text'); assert.equal(third.vault.getNote(note)!.updatedAt, 2000);
});

test('finishing a real Vault burst atomically retires timestamp metadata with its current modified time', async t => {
  let now = 1000; t.mock.method(Date, 'now', () => now);
  const first = vaultPage(t, 'first', new Ownership()); await first.persistence.ready;
  const note = first.vault.createNote(); now = 2000; first.vault.setNoteText(note, 'body', 'last words'); await first.persistence.whenDurable();
  const transactions = new Set<IDBTransaction>(), add = IDBObjectStore.prototype.add, remove = IDBObjectStore.prototype.delete;
  t.mock.method(IDBObjectStore.prototype, 'add', function(this: IDBObjectStore, ...args: Parameters<IDBObjectStore['add']>) {
    if (this.name === 'updates') transactions.add(this.transaction); return add.apply(this, args);
  });
  t.mock.method(IDBObjectStore.prototype, 'delete', function(this: IDBObjectStore, ...args: Parameters<IDBObjectStore['delete']>) {
    if (this.name === 'pendingEdits') transactions.add(this.transaction); return remove.apply(this, args);
  });
  first.vault.finishEdit(); await first.persistence.whenDurable(); assert.equal(transactions.size, 1);
  const saved = await stored(); assert.deepEqual(saved.pending, []); assert.equal(modified(saved.doc, note), 2000); saved.doc.destroy();
});
