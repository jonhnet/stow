import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { Vault } from '../src/core/vault';
import { ScopedUndo } from '../src/core/scoped-undo';

test('returning to a scope breaks typing capture even within the idle interval', () => {
  const a = new Vault(), b = new Vault(), order = new ScopedUndo();
  const x = a.createNote(), y = b.createNote(); a.undoManager.clear(); b.undoManager.clear(); order.add(a); order.add(b);
  order.before(a); a.setNoteText(x, 'body', 'a'); order.before(b); b.setNoteText(y, 'body', 'b'); order.before(a); a.setNoteText(x, 'body', 'ab');
  order.run('undo'); assert.equal(a.getNote(x)!.body, 'a');
  order.run('undo'); assert.equal(b.getNote(y)!.body, '');
  order.run('undo'); assert.equal(a.getNote(x)!.body, '');
  order.run('redo'); order.run('redo'); order.run('redo');
  assert.equal(a.getNote(x)!.body, 'ab'); assert.equal(b.getNote(y)!.body, 'b');
  a.destroy(); b.destroy();
});
test('undo of a local item change retains remote text and checkbox changes', () => {
  const a = new Vault(), id = a.createNote('checklist'), item = a.addItem(id, 'Milk');
  const b = new Vault(); Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc), 'remote');
  a.undoManager.clear(); const order = new ScopedUndo(); order.add(a);
  order.before(a); a.setItemText(item, 'Milk and eggs');
  b.toggleItem(item); Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc), 'remote');
  order.run('undo'); assert.equal(a.getItems(id)[0].text, 'Milk'); assert.equal(a.getItems(id)[0].checked, true);
  a.destroy(); b.destroy();
});

test('late loading a scope cannot resurrect redo after a new local branch; blocked scopes are not editable through global undo', () => {
  const a = new Vault(), b = new Vault(), order = new ScopedUndo();
  const x = a.createNote(), y = b.createNote(); a.undoManager.clear(); b.undoManager.clear();
  let enabled = true;
  order.add(a); order.add(b, () => enabled);
  order.before(b); b.setNoteText(y, 'body', 'old'); order.run('undo');
  const delayed = b.undoManager.redoStack; b.undoManager.redoStack = [];
  order.before(a); a.setNoteText(x, 'body', 'new branch');
  b.undoManager.redoStack = delayed; order.restored(b);
  assert.equal(order.can('redo'), false);
  order.before(b); b.setNoteText(y, 'body', 'unavailable'); enabled = false;
  order.run('undo'); assert.equal(a.getNote(x)!.body, ''); assert.equal(b.getNote(y)!.body, 'unavailable');
  a.destroy(); b.destroy();
});

test('skipping a remotely superseded action does not skip a newer action in another document', () => {
  const a = new Vault(), b = new Vault(), remote = new Vault(), order = new ScopedUndo();
  const x = a.createNote(), y = b.createNote(); a.undoManager.clear(); b.undoManager.clear();
  order.add(a); order.add(b);
  order.before(a); a.setNoteText(x, 'body', 'oldest');
  order.before(b); b.setNoteText(y, 'body', 'middle');
  order.before(a); a.setNoteMeta(x, { color: 'coral' });
  Y.applyUpdate(remote.doc, Y.encodeStateAsUpdate(a.doc), 'remote');
  remote.setNoteMeta(x, { color: 'sand' });
  Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(remote.doc), 'remote');
  order.run('undo');
  assert.equal(b.getNote(y)!.body, '', 'the middle action is next after skipping the obsolete color change');
  assert.equal(a.getNote(x)!.body, 'oldest'); assert.equal(a.getNote(x)!.color, 'sand');
  a.destroy(); b.destroy(); remote.destroy();
});

test('persisted scope stacks retain chronological undo and redo order after reload', async () => {
  const { saveUndo, restoreUndo } = await import('../src/core/persistent-undo');
  const a = new Vault(), b = new Vault(), order = new ScopedUndo();
  const x = a.createNote(), y = b.createNote(); a.undoManager.clear(); b.undoManager.clear(); order.add(a); order.add(b);
  order.before(a); a.setNoteText(x, 'title', 'first'); order.before(b); b.setNoteText(y, 'title', 'second');
  order.before(a); a.setNoteText(x, 'body', 'third'); order.run('undo');
  const a2 = new Vault(), b2 = new Vault();
  a2.doc.gc = false; b2.doc.gc = false;
  Y.applyUpdate(a2.doc, Y.encodeStateAsUpdate(a.doc), 'remote'); Y.applyUpdate(b2.doc, Y.encodeStateAsUpdate(b.doc), 'remote');
  restoreUndo(a2.undoManager, saveUndo(a.undoManager)); restoreUndo(b2.undoManager, saveUndo(b.undoManager));
  const restored = new ScopedUndo(); restored.add(a2); restored.add(b2); restored.restored(a2); restored.restored(b2);
  restored.run('undo'); assert.equal(b2.getNote(y)!.title, ''); assert.equal(a2.getNote(x)!.title, 'first');
  restored.run('redo'); assert.equal(b2.getNote(y)!.title, 'second');
  restored.run('redo'); assert.equal(a2.getNote(x)!.body, 'third');
  for (const v of [a, b, a2, b2]) v.destroy();
});

test('an asynchronous image addition switches the undo scope at the actual mutation', () => {
  const a = new Vault(), b = new Vault(), order = new ScopedUndo();
  const x = a.createNote(), y = b.createNote(); a.undoManager.clear(); b.undoManager.clear(); order.add(a); order.add(b);
  a.setNoteText(x, 'body', 'a');
  b.addAttachment({ id: 'image', noteId: y, hash: 'a'.repeat(64), name: 'photo', type: 'image/png', size: 1 });
  a.setNoteText(x, 'body', 'ab');
  order.run('undo'); assert.equal(a.getNote(x)!.body, 'a'); assert.equal(b.getNote(y)!.images.length, 1);
  order.run('undo'); assert.equal(b.getNote(y)!.images.length, 0);
  order.run('undo'); assert.equal(a.getNote(x)!.body, '');
  a.destroy(); b.destroy();
});
