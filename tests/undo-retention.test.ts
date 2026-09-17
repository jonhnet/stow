import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import assert from 'node:assert/strict';
import { beforeEach, test, type TestContext } from 'node:test';
import * as Y from 'yjs';
import { Vault } from '../src/core/vault';
import { LocalPersistence } from '../src/core/persistence';
import { inlinePersistenceWriter, type PersistenceWriter } from '../src/core/persistence-write';
import { openPersistenceDatabase } from '../src/core/persistence-database';
import { INACTIVE_UNDO_MAX_AGE, saveUndo, UNDO_LIMIT } from '../src/core/persistent-undo';
import type { EditOwnership } from '../src/core/edit-ownership';

beforeEach(() => { globalThis.indexedDB = new IDBFactory(); });
function locks(): EditOwnership {
  const owners = new Set<string>();
  return { async acquire(owner) {
    if (owners.has(owner)) return null;
    owners.add(owner); return () => { owners.delete(owner); };
  } };
}
function open(t: TestContext, ownership: EditOwnership, databaseName = 'undo-retention', writer: PersistenceWriter = inlinePersistenceWriter) {
  const vault = new Vault(), errors: Error[] = [];
  let owner = '';
  const persistence = new LocalPersistence(vault.doc, { databaseName, writer, onError: error => errors.push(error),
    undo: { manager: vault.undoManager, ownership, onOwner: value => { owner = value; } } });
  t.after(async () => { await persistence.destroy().catch(() => {}); vault.destroy(); });
  return { vault, persistence, errors, get owner() { return owner; } };
}
async function compact(name = 'undo-retention') {
  const db = await openPersistenceDatabase(name);
  await inlinePersistenceWriter.write(db, { batch: [], forceCompact: true, vector: new Uint8Array([0]), retired: [] }, () => {});
  db.close();
}
async function storedBytes(name = 'undo-retention') {
  const db = await openPersistenceDatabase(name);
  try { return Buffer.concat((await db.getAll('updates')).map(update => Buffer.from(update))); }
  finally { db.close(); }
}

test('the 200-step budget releases old text and survives deep Undo/Redo across restarts', async t => {
  const ownership = locks();
  let p = open(t, ownership); await p.persistence.ready;
  const original = 'EXPIRED_PAYLOAD_'.repeat(8000), id = p.vault.createNote('text', { body: original });
  p.vault.finishEdit(); p.vault.undoManager.clear();
  for (let index = 0; index < 210; index++) {
    p.vault.setNoteText(id, 'body', `revision ${index}`); p.vault.finishEdit();
    assert(p.vault.undoManager.undoStack.length + p.vault.undoManager.redoStack.length <= UNDO_LIMIT);
  }
  assert(!Buffer.from(Y.encodeStateAsUpdate(p.vault.doc)).includes(Buffer.from('EXPIRED_PAYLOAD_')));
  await p.persistence.destroy(); await compact();
  assert(!(await storedBytes()).includes(Buffer.from('EXPIRED_PAYLOAD_')));
  p = open(t, ownership); await p.persistence.ready;
  for (let index = 0; index < UNDO_LIMIT; index++) {
    assert(p.vault.undo());
    assert.equal(p.vault.undoManager.undoStack.length + p.vault.undoManager.redoStack.length, UNDO_LIMIT);
    if (index === 99) { await p.persistence.destroy(); p = open(t, ownership); await p.persistence.ready; }
  }
  assert.equal(p.vault.getNote(id)!.body, 'revision 9'); assert.equal(p.vault.undo(), undefined);
  await p.persistence.destroy(); await compact(); p = open(t, ownership); await p.persistence.ready;
  for (let index = 0; index < UNDO_LIMIT; index++) assert(p.vault.redo());
  assert.equal(p.vault.getNote(id)!.body, 'revision 209'); assert.equal(p.vault.redo(), undefined);
});

test('discarding an old step preserves deleted parents still needed by newer undo entries', async t => {
  const p = open(t, locks()); await p.persistence.ready;
  const note = p.vault.createNote('checklist');
  const first = p.vault.addItem(note, 'first'), second = p.vault.addItem(note, 'second');
  p.vault.finishEdit(); p.vault.undoManager.clear();
  p.vault.setItemText(first, 'changed first'); p.vault.finishEdit();
  p.vault.setItemText(second, 'changed second'); p.vault.finishEdit();
  p.vault.deleteItem(first); p.vault.deleteItem(second);
  for (let i = 0; i < 197; i++) p.vault.setNoteMeta(note, { pinned: i % 2 === 0 });
  assert.equal(p.vault.undoManager.undoStack.length, UNDO_LIMIT);
  await p.persistence.destroy(); await compact();
  const restored = open(t, locks()); await restored.persistence.ready;
  for (let i = 0; i < 199; i++) assert(restored.vault.undo());
  assert.deepEqual(restored.vault.getItems(note).map(item => item.text), ['changed first', 'changed second']);
  assert(restored.vault.undo());
  assert.deepEqual(restored.vault.getItems(note).map(item => item.text), ['changed first', 'second']);
});

async function legacyStack(undoCount: number, redoCount: number) {
  const vault = new Vault(), id = vault.createNote('text', { title: 'Legacy', body: 'start' });
  vault.finishEdit(); vault.undoManager.clear();
  const manager = new Y.UndoManager(vault.notes, { captureTimeout: 0 });
  manager.on('stack-item-added', ({ stackItem }) => {
    stackItem.meta.set('stow-source-ids', new Set([id]));
    stackItem.meta.set('stow-action-description', { description: 'Legacy edit' });
  });
  const body = vault.notes.get(id)!.get('body') as Y.Text;
  for (let i = 0; i < undoCount + redoCount; i++) vault.doc.transact(() => { body.delete(0, body.length); body.insert(0, `legacy ${i}`); });
  for (let i = 0; i < redoCount; i++) manager.undo();
  const db = await openPersistenceDatabase('undo-retention');
  await inlinePersistenceWriter.write(db, { batch: [Y.encodeStateAsUpdate(vault.doc)], forceCompact: true, vector: new Uint8Array([0]), retired: [],
    undo: { owner: 'legacy', state: saveUndo(manager) } }, () => {});
  manager.destroy(); vault.destroy(); db.close(); return id;
}

test('an oversized saved stack is capped and rewritten on opening without skipping the next Redo', async t => {
  const id = await legacyStack(50, 180);
  const p = open(t, locks()); await p.persistence.ready;
  assert.equal(p.vault.undoManager.undoStack.length, 50); assert.equal(p.vault.undoManager.redoStack.length, 150);
  const db = await openPersistenceDatabase('undo-retention'), saved = (await db.get('undo', p.owner))!; db.close();
  assert.equal(saved.undoStack.length + saved.redoStack.length, UNDO_LIMIT);
  assert(p.vault.redo()); assert.equal(p.vault.getNote(id)!.body, 'legacy 50');
  for (let i = 1; i < 150; i++) assert(p.vault.redo());
  assert.equal(p.vault.getNote(id)!.body, 'legacy 199'); assert.equal(p.vault.redo(), undefined);
});

async function savedTabs(t: TestContext, ownership: EditOwnership, count: number) {
  const tabs: ReturnType<typeof open>[] = [];
  for (let index = 0; index < count; index++) {
    const p = open(t, ownership); await p.persistence.ready;
    const id = p.vault.createNote('text', { title: `Tab ${index}`, body: `OBSOLETE_${index}_PAYLOAD` });
    p.vault.finishEdit(); p.vault.undoManager.clear();
    p.vault.setNoteText(id, 'body', `current text ${index}`); p.vault.finishEdit();
    await p.persistence.whenDurable(); tabs.push(p);
  }
  const db = await openPersistenceDatabase('undo-retention');
  for (const [index, tab] of tabs.entries()) {
    const state = (await db.get('undo', tab.owner))!;
    await db.put('undo', { ...state, updatedAt: Date.now() - (count - index) * 1000 }, tab.owner);
  }
  db.close(); return tabs;
}

test('cleanup keeps live stacks and three recent inactive stacks, expires week-old ones, and releases only their old content', async t => {
  const ownership = locks(), tabs = await savedTabs(t, ownership, 7);
  for (const tab of tabs.slice(1)) await tab.persistence.destroy();
  const db = await openPersistenceDatabase('undo-retention');
  for (const tab of tabs.slice(0, 2)) {
    const state = (await db.get('undo', tab.owner))!;
    await db.put('undo', { ...state, updatedAt: Date.now() - INACTIVE_UNDO_MAX_AGE }, tab.owner);
  }
  const resumed = open(t, ownership); await resumed.persistence.ready;
  assert.equal(resumed.owner, tabs[6].owner);
  assert.deepEqual(new Set(await db.getAllKeys('undo')), new Set([0, 3, 4, 5, 6].map(index => tabs[index].owner)));
  const bytes = (await storedBytes()).toString();
  for (const index of [1, 2]) assert(!bytes.includes(`OBSOLETE_${index}_PAYLOAD`));
  for (const index of [0, 3, 4, 5, 6]) assert(bytes.includes(`OBSOLETE_${index}_PAYLOAD`));
  assert.equal(resumed.vault.getNotes().length, 7);
  assert(resumed.vault.undo());
  assert.equal(resumed.vault.getNotes().find(note => note.title === 'Tab 6')!.body, 'OBSOLETE_6_PAYLOAD');
  assert(tabs[0].vault.undo()); // Even a week-idle live tab remains protected.
  db.close();
});

test('a week-old inactive stack expires without deleting current notes or another account’s undo', async t => {
  const ownership = locks(), [old] = await savedTabs(t, ownership, 1);
  await old.persistence.destroy();
  const other = open(t, locks(), 'other-account'); await other.persistence.ready;
  other.vault.createNote('text', { title: 'Private to the other account' }); await other.persistence.destroy();
  const db = await openPersistenceDatabase('undo-retention');
  const state = (await db.get('undo', old.owner))!;
  await db.put('undo', { ...state, updatedAt: Date.now() - INACTIVE_UNDO_MAX_AGE }, old.owner);
  const p = open(t, ownership); await p.persistence.ready;
  assert.notEqual(p.owner, old.owner); assert.equal(p.vault.undo(), undefined);
  assert.equal(p.vault.getNotes()[0].body, 'current text 0'); assert.equal(await db.count('undo'), 0); db.close();
  const otherAgain = open(t, locks(), 'other-account'); await otherAgain.persistence.ready;
  assert(otherAgain.vault.undo()); assert.equal(otherAgain.vault.getNotes().length, 0);
});

test('cleanup holds owner locks through atomic compaction and rolls everything back on storage failure', async t => {
  const ownership = locks(), tabs = await savedTabs(t, ownership, 5);
  for (const tab of tabs) await tab.persistence.destroy();
  const before = await storedBytes();
  let cleanups = 0;
  const writer: PersistenceWriter = { ...inlinePersistenceWriter, async write(db, request, compacting) {
    for (const { owner } of request.undoCleanup ?? []) {
      cleanups++; assert.equal(await ownership.acquire(`undo:${owner}`, true), null);
    }
    return inlinePersistenceWriter.write(db, request, compacting);
  } };
  const nativeClear = IDBObjectStore.prototype.clear;
  const fail = t.mock.method(IDBObjectStore.prototype, 'clear', function(this: IDBObjectStore) {
    if (this.name === 'updates') throw new DOMException('Disk full', 'QuotaExceededError');
    return nativeClear.call(this);
  });
  const p = open(t, ownership, 'undo-retention', writer);
  await assert.rejects(p.persistence.ready, /Disk full/); assert.equal(cleanups, 1);
  assert.deepEqual(await storedBytes(), before);
  const db = await openPersistenceDatabase('undo-retention'); assert.equal(await db.count('undo'), 5); db.close();
  for (const tab of tabs) { const release = await ownership.acquire(`undo:${tab.owner}`, true); assert(release); release(); }
  fail.mock.restore();
  const retry = open(t, ownership); await retry.persistence.ready;
  assert.equal(retry.vault.getNotes().length, 5); assert(retry.vault.undo());
});

test('an opener rereads a candidate after claiming its lock instead of reviving a concurrently retired record', async t => {
  const ownership = locks(), [tab] = await savedTabs(t, ownership, 1); await tab.persistence.destroy();
  let intercepted = false;
  const concurrent: EditOwnership = { async acquire(owner, available) {
    if (owner === `undo:${tab.owner}` && !intercepted) {
      intercepted = true;
      const db = await openPersistenceDatabase('undo-retention'); await db.delete('undo', tab.owner); db.close();
    }
    return ownership.acquire(owner, available);
  } };
  const p = open(t, concurrent); await p.persistence.ready;
  assert(intercepted); assert.notEqual(p.owner, tab.owner); assert.equal(p.vault.undo(), undefined);
  assert.equal(p.vault.getNotes()[0].body, 'current text 0');
});

test('a running tab cleans newly inactive stacks after ordinary update-log compaction', async t => {
  const ownership = locks(), tabs = await savedTabs(t, ownership, 5);
  for (const tab of tabs.slice(1)) await tab.persistence.destroy();
  const db = await openPersistenceDatabase('undo-retention');
  // No reload or new page is needed to clean stacks that became inactive later.
  const transaction = db.transaction('updates', 'readwrite');
  for (let i = await transaction.store.count(); i < 499; i++) await transaction.store.add(Uint8Array.of(0, 0));
  await transaction.done;
  const p = tabs[0], note = p.vault.getNotes().find(note => note.title === 'Tab 0')!;
  p.vault.setNoteMeta(note.id, { pinned: true }); await p.persistence.whenDurable();
  assert.deepEqual(new Set(await db.getAllKeys('undo')), new Set([0, 2, 3, 4].map(index => tabs[index].owner)));
  assert.equal(await db.count('updates'), 1); db.close();
  assert(!(await storedBytes()).includes(Buffer.from('OBSOLETE_1_PAYLOAD')));
  assert(p.vault.undo()); assert.equal(p.vault.getNote(note.id)!.pinned, false);
});
