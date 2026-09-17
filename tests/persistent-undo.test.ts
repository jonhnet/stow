import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import assert from 'node:assert/strict';
import { beforeEach, test, type TestContext } from 'node:test';
import { openDB } from 'idb';
import * as Y from 'yjs';
import { Vault } from '../src/core/vault';
import { LocalPersistence } from '../src/core/persistence';
import { inlinePersistenceWriter } from '../src/core/persistence-write';
import { openPersistenceDatabase } from '../src/core/persistence-database';
import type { EditOwnership } from '../src/core/edit-ownership';

beforeEach(() => { globalThis.indexedDB = new IDBFactory(); });
function locks(): EditOwnership {
  const owners = new Set<string>();
  return { async acquire(owner) {
    if (owners.has(owner)) return null;
    owners.add(owner); return () => { owners.delete(owner); };
  } };
}
async function page(t: TestContext, ownership = locks(), name = 'undo-test') {
  const vault = new Vault(), errors: Error[] = [];
  const persistence = new LocalPersistence(vault.doc, {
    databaseName: name, writer: inlinePersistenceWriter, onError: error => errors.push(error),
    undo: { manager: vault.undoManager, ownership },
  });
  t.after(async () => { await persistence.destroy().catch(() => {}); vault.destroy(); });
  await persistence.ready;
  return { vault, persistence, errors };
}
async function compact(name = 'undo-test') {
  const db = await openPersistenceDatabase(name);
  await inlinePersistenceWriter.write(db, { batch: [], forceCompact: true, vector: new Uint8Array([0]), retired: [] }, () => {});
  db.close();
}

test('checklist reorder survives repeated reload, undo, redo, and compaction with stable identities', async t => {
  let p = await page(t);
  const id = p.vault.createNote('checklist');
  const first = p.vault.addItem(id, 'First'), second = p.vault.addItem(id, 'Second');
  p.vault.finishEdit(); p.vault.undoManager.clear();
  p.vault.moveItemRelative(second, first, 'before');
  const order = (v: Vault) => v.getNote(id)!.items.map(item => item.id);
  assert.deepEqual(order(p.vault), [second, first]);
  for (let round = 0; round < 6; round++) {
    await p.persistence.destroy(); await compact();
    p = await page(t);
    const description = round % 2 === 0 ? p.vault.undo() : p.vault.redo();
    assert(description);
    assert.deepEqual(order(p.vault), round % 2 === 0 ? [first, second] : [second, first]);
  }
});

test('deleted text and redo links survive deep undo across compaction and a fresh client ID', async t => {
  let p = await page(t);
  const id = p.vault.createNote('text');
  p.vault.setNoteText(id, 'body', 'Original'); p.vault.finishEdit(); p.vault.undoManager.clear();
  for (const value of ['Replacement', 'Different', 'Final']) { p.vault.setNoteText(id, 'body', value); p.vault.finishEdit(); }
  for (const value of ['Different', 'Replacement', 'Original']) {
    await p.persistence.destroy(); await compact(); p = await page(t);
    assert(p.vault.undo()); assert.equal(p.vault.getNote(id)!.body, value);
  }
  for (const value of ['Replacement', 'Different', 'Final']) {
    await p.persistence.destroy(); await compact(); p = await page(t);
    assert(p.vault.redo()); assert.equal(p.vault.getNote(id)!.body, value);
  }
  assert.equal(p.vault.undoManager.redoStack.length, 0);
});

test('restored undo preserves another device’s concurrent text and metadata', async t => {
  let p = await page(t);
  const id = p.vault.createNote('text'); p.vault.setNoteText(id, 'body', 'Original');
  p.vault.finishEdit(); p.vault.undoManager.clear();
  const peer = new Vault(); t.after(() => peer.destroy());
  Y.applyUpdate(peer.doc, Y.encodeStateAsUpdate(p.vault.doc));
  p.vault.setNoteText(id, 'body', 'Original local'); p.vault.finishEdit();
  peer.setNoteText(id, 'body', 'remote Original'); peer.setNoteMeta(id, { pinned: true });
  await p.persistence.destroy(); await compact(); p = await page(t);
  Y.applyUpdate(p.vault.doc, Y.encodeStateAsUpdate(peer.doc), 'remote');
  assert(p.vault.undo()); assert.equal(p.vault.getNote(id)!.body, 'remote Original');
  assert.equal(p.vault.getNote(id)!.pinned, true);
  await p.persistence.destroy(); await compact(); p = await page(t);
  assert(p.vault.redo()); assert.equal(p.vault.getNote(id)!.body, 'remote Original local');
});

test('a peer splitting an old redone range does not leave half the local text behind on Undo', async t => {
  let p = await page(t);
  const id = p.vault.createNote('text'); p.vault.finishEdit(); p.vault.undoManager.clear();
  p.vault.setNoteText(id, 'body', 'abcd'); p.vault.finishEdit();
  const peer = new Vault(); t.after(() => peer.destroy());
  Y.applyUpdate(peer.doc, Y.encodeStateAsUpdate(p.vault.doc));
  p.vault.setNoteText(id, 'body', ''); p.vault.finishEdit(); p.vault.undo();
  assert.equal(p.vault.getNote(id)!.body, 'abcd');
  await p.persistence.destroy();
  // Another writer saves a remote insertion after this page's last Undo record.
  // Loading it splits the original four-character struct into two ranges.
  peer.setNoteText(id, 'body', 'abXcd');
  const db = await openPersistenceDatabase('undo-test');
  await db.add('updates', Y.encodeStateAsUpdate(peer.doc)); db.close();
  p = await page(t);
  assert(p.vault.undo()); assert.equal(p.vault.getNote(id)!.body, 'X');
});

test('undo records and current edits commit atomically and survive a failed write retry', async t => {
  const p = await page(t);
  const id = p.vault.createNote('text'); p.vault.setNoteText(id, 'body', 'Before');
  p.vault.finishEdit(); p.vault.undoManager.clear(); await p.persistence.whenDurable();
  const nativePut = IDBObjectStore.prototype.put;
  const fail = t.mock.method(IDBObjectStore.prototype, 'put', function(this: IDBObjectStore, ...args: Parameters<typeof nativePut>) {
    if (this.name === 'undo') throw new DOMException('Full', 'QuotaExceededError');
    return nativePut.apply(this, args);
  });
  p.vault.setNoteText(id, 'body', 'After'); p.vault.finishEdit();
  await assert.rejects(p.persistence.whenDurable(), /Full/);
  const db = await openPersistenceDatabase('undo-test'), stored = new Y.Doc();
  for (const update of await db.getAll('updates')) Y.applyUpdate(stored, update);
  assert.equal(new Vault(stored).getNote(id)!.body, 'Before'); stored.destroy(); db.close();
  fail.mock.restore(); await p.persistence.destroy();
  const reopened = await page(t); assert.equal(reopened.vault.getNote(id)!.body, 'After');
  assert(reopened.vault.undo()); assert.equal(reopened.vault.getNote(id)!.body, 'Before');
});

test('live tabs keep separate undo stacks, while a fresh page recovers an inactive stack', async t => {
  const ownership = locks(), a = await page(t, ownership);
  const first = a.vault.createNote('text'); a.vault.setNoteText(first, 'body', 'First tab'); a.vault.finishEdit();
  await a.persistence.whenDurable();
  const b = await page(t, ownership);
  assert.equal(b.vault.undoManager.undoStack.length, 0);
  const second = b.vault.createNote('text'); b.vault.setNoteText(second, 'body', 'Second tab'); b.vault.finishEdit();
  await b.persistence.destroy();
  const recovered = await page(t, ownership);
  assert(recovered.vault.undo()); assert.equal(recovered.vault.getNote(second)?.body ?? '', '');
  assert.equal(recovered.vault.getNote(first)!.body, 'First tab');
  const account = await page(t, locks(), 'other-account');
  assert.equal(account.vault.undoManager.undoStack.length, 0); assert.equal(account.vault.getNotes().length, 0);
});

test('permanent deletion purges inactive undo payloads and retains unrelated undo', async t => {
  const ownership = locks(), p = await page(t, ownership);
  const deleted = p.vault.createNote('text'), retained = p.vault.createNote('text');
  p.vault.setNoteText(deleted, 'body', 'ERASE_SECRET_OLD'); p.vault.finishEdit();
  p.vault.setNoteText(deleted, 'body', 'ERASE_SECRET_NEW'); p.vault.finishEdit();
  p.vault.setNoteText(retained, 'body', 'keep before'); p.vault.finishEdit(); p.vault.setNoteText(retained, 'body', 'keep after'); p.vault.finishEdit();
  await p.persistence.whenDurable();
  const other = await page(t, ownership);
  other.vault.setNoteMeta(deleted, { trashed: true }); other.vault.deleteNotesForever([deleted]);
  await other.persistence.destroy();
  // Simulate an old offline tab trying to persist its old retained content.
  p.vault.setNoteMeta(retained, { pinned: true }); await p.persistence.destroy(); await compact();
  const db = await openPersistenceDatabase('undo-test');
  assert(!Buffer.concat((await db.getAll('updates')).map(update => Buffer.from(update))).toString().includes('ERASE_SECRET'));
  const histories = await db.getAll('undo');
  assert(!JSON.stringify(histories, (_key, value) => value instanceof Map || value instanceof Set ? [...value] : value).includes('ERASE_SECRET'));
  db.close();
  const reopened = await page(t);
  assert.equal(reopened.vault.getNote(deleted), undefined);
  assert(reopened.vault.undo()); assert.equal(reopened.vault.getNote(retained)!.pinned, false);
  assert(reopened.vault.undo()); assert.equal(reopened.vault.getNote(retained)!.body, 'keep before');
});

test('adding Undo storage preserves a v1 current-only cache and its offline edits', async t => {
  const old = await openDB('undo-test', 1, { upgrade(db) {
    db.createObjectStore('updates', { autoIncrement: true }); db.createObjectStore('pendingEdits'); db.createObjectStore('maintenance');
  } });
  const vault = new Vault(), id = vault.createNote('text'); vault.setNoteText(id, 'body', 'Offline before upgrade');
  await old.add('updates', Y.encodeStateAsUpdate(vault.doc)); old.close(); vault.destroy();
  const reopened = await page(t); assert.equal(reopened.vault.getNote(id)!.body, 'Offline before upgrade');
  assert.equal(reopened.vault.undoManager.undoStack.length, 0);
  reopened.vault.setNoteText(id, 'body', 'New version'); await reopened.persistence.destroy();
  const again = await page(t); assert(again.vault.undo()); assert.equal(again.vault.getNote(id)!.body, 'Offline before upgrade');
});

test('merge, conversion, labels, and creation can be undone and redone across restarts', async t => {
  let p = await page(t);
  const a = p.vault.createNote('text', { title: 'A', body: 'First\nSecond' });
  const b = p.vault.createNote('text', { title: 'B', body: 'Other' });
  p.vault.finishEdit(); p.vault.undoManager.clear();
  const projection = (vault: Vault) => vault.getNotes().map(({ updatedAt: _time, ...note }) => note);
  const states = [projection(p.vault)];
  for (const edit of [
    () => p.vault.convertBodyToChecklist(a),
    () => p.vault.setNoteLabel(a, 'Research', true),
    () => p.vault.setLabelColor('Research', 'mint'),
    () => p.vault.mergeNotes([a, b]),
    () => p.vault.setNoteText(a, 'body', 'Changed merged text'),
    () => p.vault.createNote('text', { title: 'Created after the merge', body: 'New note' }),
  ]) {
    edit(); p.vault.finishEdit(); states.push(projection(p.vault));
  }
  for (let index = states.length - 2; index >= 0; index--) {
    await p.persistence.destroy(); await compact(); p = await page(t);
    assert(p.vault.undo()); assert.deepEqual(projection(p.vault), states[index]);
  }
  for (let index = 1; index < states.length; index++) {
    await p.persistence.destroy(); await compact(); p = await page(t);
    assert(p.vault.redo()); assert.deepEqual(projection(p.vault), states[index]);
  }
});

test('new edits after reload discard saved Redo, including when Undo only skips obsolete entries', async t => {
  let p = await page(t);
  const id = p.vault.createNote('text', { title: 'A', body: 'Original' });
  p.vault.finishEdit(); p.vault.undoManager.clear();
  p.vault.setNoteMeta(id, { pinned: true }); p.vault.undo();
  await p.persistence.destroy(); p = await page(t);
  assert.equal(p.vault.undoManager.redoStack.length, 1);
  p.vault.setNoteText(id, 'title', 'B'); p.vault.finishEdit();
  await p.persistence.destroy(); p = await page(t);
  assert.equal(p.vault.redo(), undefined);
  p.vault.undoManager.clear(); p.vault.setNoteMeta(id, { pinned: true });
  const peer = new Vault(); t.after(() => peer.destroy());
  Y.applyUpdate(peer.doc, Y.encodeStateAsUpdate(p.vault.doc)); peer.setNoteMeta(id, { pinned: false });
  Y.applyUpdate(p.vault.doc, Y.encodeStateAsUpdate(peer.doc), 'remote');
  assert.equal(p.vault.undo(), undefined);
  await p.persistence.destroy(); p = await page(t);
  assert.equal(p.vault.undoManager.undoStack.length, 0);
});
