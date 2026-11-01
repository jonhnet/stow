import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { collectionStore } from '../src/core/collection-store';
import type { Snapshot, StowStore } from '../src/core/store';
import { Vault } from '../src/core/vault';
import { newSharedReference, sharedSnapshot, type SharedReference } from '../src/core/shared-note';

/** Actual vaults and subscriptions, without the store's browser/network startup. */
function storeFixture(vault = new Vault(), shared?: SharedReference) {
  const listeners = new Set<() => void>();
  let snapshot: Snapshot;
  const store = {
    vault, shared,
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    refresh(patch: Partial<Snapshot> = {}) {
      snapshot = { notes: vault.getNotes(), labels: vault.getLabels(), ready: true, access: 'ready', status: 'online',
        canReload: true, canUndo: false, canRedo: false, pending: 0, localPending: 0, historyVersion: 0,
        error: null, historyError: null, accessMessage: null, syncRejection: null, automaticReload: false,
        images: { pendingUploads: 0, thumbnailsRemaining: 0, originalBytes: 0 }, ...patch };
      for (const listener of listeners) listener();
    },
  };
  vault.doc.on('update', () => store.refresh()); store.refresh();
  return store;
}
const appStore = (store: ReturnType<typeof storeFixture>) => store as unknown as StowStore;
function browserGlobals(t: TestContext) {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ participants: [] }));
  Object.defineProperty(globalThis, 'document', { value: new EventTarget(), configurable: true });
  t.after(() => Reflect.deleteProperty(globalThis, 'document'));
}

test('typing and save-status notifications do not reread sharing metadata across the vault', t => {
  browserGlobals(t);
  const vault = new Vault(); t.after(() => vault.destroy());
  for (let i = 0; i < 500; i++) vault.createNote('text', { title: `Note ${i}` });
  const primary = storeFixture(vault);
  const collection = collectionStore(appStore(primary), () => { throw new Error('No shared notes'); });
  let reads = 0;
  for (const record of vault.notes.values()) {
    const get = record.get.bind(record);
    t.mock.method(record, 'get', (key: string) => { if (key === 'share') reads++; return get(key); });
  }
  for (let i = 0; i < 8; i++) primary.refresh({ pending: i });
  assert.equal(reads, 0, 'sync/save status must not rescan sharing metadata');
  const id = vault.getNotes()[0].id;
  for (const text of ['a', 'ab', 'abc']) collection.vault.setNoteText(id, 'body', text);
  assert.equal(collection.vault.getNote(id)!.body, 'abc');
  assert.equal(reads, 0, 'editing text must not rescan sharing metadata');
});

test('sharing routes follow loaded references, remote publication, replacement, removal, and undo', async t => {
  browserGlobals(t);
  const vault = new Vault(), remote = new Vault();
  const id = vault.createNote('text', { title: 'Private', body: 'Original' });
  const initial = newSharedReference();
  vault.notes.get(id)!.set('share', initial);
  const primary = storeFixture(vault), scopes = new Map<string, ReturnType<typeof storeFixture>>();
  t.after(() => { vault.destroy(); remote.destroy(); for (const scope of scopes.values()) scope.vault.destroy(); });
  const collection = collectionStore(appStore(primary), ref => {
    const scope = storeFixture(new Vault(sharedSnapshot(vault.getNote(id)!, ref.id)), ref);
    scopes.set(ref.id, scope); return appStore(scope);
  });
  collection.vault.setNoteText(id, 'body', 'Shared edit');
  assert.equal(scopes.get(initial.id)!.vault.getNote(initial.id)!.body, 'Shared edit');
  assert.equal(vault.getNote(id)!.body, 'Original');
  Y.applyUpdate(remote.doc, Y.encodeStateAsUpdate(vault.doc), 'remote');
  const replacement = newSharedReference();
  remote.notes.get(id)!.set('share', replacement);
  Y.applyUpdate(vault.doc, Y.encodeStateAsUpdate(remote.doc), 'remote');
  collection.vault.setNoteText(id, 'body', 'Replacement edit');
  assert.equal(scopes.get(replacement.id)!.vault.getNote(replacement.id)!.body, 'Replacement edit');
  assert.equal(scopes.get(initial.id)!.vault.getNote(initial.id)!.body, 'Shared edit');
  vault.notes.get(id)!.delete('share');
  collection.vault.setNoteText(id, 'body', 'Private again');
  assert.equal(vault.getNote(id)!.body, 'Private again');
  // Replacing an entire record (and undoing that replacement) must invalidate it too.
  const undo = new Y.UndoManager(vault.notes, { captureTimeout: 0 });
  const record = new Y.Map<unknown>([['share', initial], ['title', new Y.Text('Restored')]]);
  vault.notes.set(id, record);
  collection.vault.setNoteText(id, 'body', 'Back to first share');
  assert.equal(scopes.get(initial.id)!.vault.getNote(initial.id)!.body, 'Back to first share');
  undo.undo();
  collection.vault.setNoteText(id, 'body', 'Private after undo');
  assert.equal(vault.getNote(id)!.body, 'Private after undo');
  undo.destroy();
  // A newly arriving reference must be discovered without another page load.
  const addedId = remote.createNote('text', { title: 'Arriving reference' });
  const added = newSharedReference(); remote.notes.get(addedId)!.set('share', added);
  Y.applyUpdate(vault.doc, Y.encodeStateAsUpdate(remote.doc), 'remote');
  assert.ok(scopes.has(added.id));
  vault.notes.delete(addedId);
  primary.refresh();
  assert.equal(collection.vault.getNote(addedId), undefined);
  await Promise.resolve();
});
