import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import * as Y from 'yjs';
import { Vault } from '../src/core/vault';
import type { Note } from '../src/core/types';
import { observeBoundaries, snapshotNote } from './history-state-fixture';

function model(t: TestContext, source?: Vault) {
  const vault = new Vault(); t.after(() => vault.destroy());
  if (source) Y.applyUpdate(vault.doc, Y.encodeStateAsUpdate(source.doc), 'remote');
  return vault;
}
function withoutModified({ updatedAt: _, ...note }: Note) { return note; }

test('conversion preserves literal nonblank lines and metadata, with one history boundary and undo entry', t => {
  const vault = model(t), body = '\r\n**First**\r\n \t \n  *Second*  \rThird 🐸\n';
  const id = vault.createNote('text', { title: 'Original title', body });
  vault.setNoteMeta(id, { color: 'sage', pinned: true, archived: true });
  vault.setNoteLabel(id, 'Tasks', true);
  vault.addAttachment({ id: 'picture', noteId: id, hash: 'abc', name: 'Photo', type: 'image/png', size: 100 });
  const before = vault.getNote(id)!;
  vault.undoManager.clear();
  const boundaries = observeBoundaries(vault);

  assert.equal(vault.convertBodyToChecklist(id), true);
  const after = vault.getNote(id)!;
  assert.deepEqual(after.items.map(item => item.text), ['**First**', '  *Second*  ', 'Third 🐸']);
  assert(after.items.every(item => !item.checked && !item.parentId));
  assert.deepEqual(withoutModified(after), { ...withoutModified(before), body: '', kind: 'checklist', items: after.items });
  assert.equal(boundaries.length, 1);
  assert.equal(boundaries[0].description, 'Note: converted text to 3 checklist items');
  assert.deepEqual(snapshotNote(vault.captureHistoryState([id])), after);
  assert.equal(vault.undoManager.undoStack.length, 1);
  assert.equal(vault.undo(), boundaries[0].description);
  assert.deepEqual(withoutModified(vault.getNote(id)!), withoutModified(before));
  assert.equal(vault.redo(), boundaries[0].description);
  assert.deepEqual(withoutModified(vault.getNote(id)!), withoutModified(after));
});

test('conversion prepends roots and preserves existing checked families and their records', t => {
  const vault = model(t), id = vault.createNote('checklist', { body: 'First\nSecond' });
  const root = vault.addItem(id, 'Existing parent'), child = vault.addItem(id, 'Child', root);
  vault.toggleItem(root);
  vault.addItem(id, 'Existing last');
  const original = vault.getItems(id), records = original.map(item => vault.items.get(item.id));
  vault.convertBodyToChecklist(id);
  assert.deepEqual(vault.getItems(id).map(item => item.text), ['First', 'Second', 'Existing parent', 'Child', 'Existing last']);
  assert.deepEqual(vault.getItems(id).slice(2), original);
  assert.equal(vault.getItems(id).find(item => item.id === child)!.parentId, root);
  original.forEach((item, index) => assert.equal(vault.items.get(item.id), records[index]));
  vault.undo();
  assert.equal(vault.getNote(id)!.body, 'First\nSecond');
  assert.deepEqual(vault.getItems(id), original);
});

for (const legacy of [false, true]) test(`conversion clears a ${legacy ? 'legacy' : 'current'} merged body without changing note identities`, t => {
  const vault = model(t);
  const a = vault.createNote('text', { title: 'A', body: 'A task' });
  const b = vault.createNote('checklist', { title: 'B', body: 'B task' });
  vault.addItem(b, 'Existing');
  if (legacy) vault.merges.set('old-merge', { a, b });
  else vault.mergeNotes([a, b]);
  const before = vault.getNote(a)!, expected = before.body.split('\n').filter(line => line.trim());
  vault.undoManager.clear();
  assert.equal(vault.convertBodyToChecklist(b), true);
  const after = vault.getNote(a)!;
  assert.equal(after.body, '');
  assert.equal(after.title, before.title);
  assert.deepEqual(after.sourceIds, before.sourceIds);
  assert.deepEqual(after.items.map(item => item.text), [...expected, 'Existing']);
  assert.deepEqual(model(t, vault).getNotes(), vault.getNotes());
  assert.equal(vault.undoManager.undoStack.length, 1);
  vault.undo();
  assert.deepEqual(withoutModified(vault.getNote(a)!), withoutModified(before));
  vault.redo();
  assert.deepEqual(withoutModified(vault.getNote(a)!), withoutModified(after));
});

test('offline conversion retains concurrent body and checklist edits after synchronization', t => {
  const local = model(t), id = local.createNote('checklist', { body: 'One\nTwo' });
  const item = local.addItem(id, 'Existing'), remote = model(t, local);
  local.convertBodyToChecklist(id);
  remote.setItemText(item, 'Edited elsewhere');
  remote.setNoteText(id, 'body', 'One\nTwo\nLate text'); remote.finishEdit();
  const left = Y.encodeStateAsUpdate(local.doc), right = Y.encodeStateAsUpdate(remote.doc);
  Y.applyUpdate(local.doc, right, 'remote'); Y.applyUpdate(remote.doc, left, 'remote');
  assert.deepEqual(local.getNotes(), remote.getNotes());
  assert.deepEqual(local.getItems(id).map(item => item.text), ['One', 'Two', 'Edited elsewhere']);
  assert.equal(local.getNote(id)!.body, '\nLate text');
  local.undo();
  assert.equal(local.getNote(id)!.body, 'One\nTwo\nLate text');
  assert.deepEqual(local.getItems(id).map(item => item.text), ['Edited elsewhere']);
});

for (const lines of [['One', 'Two'], ['One', 'One', 'Two']]) test(`concurrent offline conversions preserve each source line once: ${lines.join(' / ')}`, {
  todo: 'Concurrent conversions currently create duplicate items; remove this TODO when they reconcile.',
}, t => {
  const local = model(t), id = local.createNote('text', { body: lines.join('\n') });
  local.finishEdit();
  const remote = model(t, local);
  assert.equal(local.convertBodyToChecklist(id), true);
  assert.equal(remote.convertBodyToChecklist(id), true);
  local.finishEdit(); remote.finishEdit();
  const left = Y.encodeStateAsUpdate(local.doc), right = Y.encodeStateAsUpdate(remote.doc);
  Y.applyUpdate(local.doc, right, 'remote'); Y.applyUpdate(remote.doc, left, 'remote');
  assert.deepEqual(local.getNotes(), remote.getNotes());
  assert.equal(local.getNote(id)!.body, '');
  // Coalesce conversion of the same source lines, not distinct lines with equal text.
  assert.deepEqual(local.getItems(id).map(item => item.text), lines);
});

test('conversion re-spaces roots when ranks cannot accommodate a prefix, and undo restores their ranks', t => {
  const vault = model(t), id = vault.createNote('checklist', { body: 'One\nTwo' });
  const root = vault.addItem(id, 'Root'), child = vault.addItem(id, 'Child', root);
  vault.items.get(root)!.set('rank', -Number.MAX_VALUE);
  const original = vault.getItems(id);
  vault.convertBodyToChecklist(id);
  assert.deepEqual(vault.getItems(id).map(item => item.text), ['One', 'Two', 'Root', 'Child']);
  assert.deepEqual(vault.getItems(id).find(item => item.id === child), original.find(item => item.id === child));
  vault.undo();
  assert.deepEqual(vault.getItems(id), original);
});

test('blank, missing and trashed notes are no-ops, including repeated conversion', t => {
  const vault = model(t), empty = vault.createNote('text', { body: '\n \t\r\n' });
  const trash = vault.createNote('text', { body: 'Do not convert' });
  vault.setNoteMeta(trash, { trashed: true });
  const converted = vault.createNote('text', { body: 'One' });
  vault.convertBodyToChecklist(converted);
  const before = Y.encodeStateAsUpdate(vault.doc);
  for (const id of [empty, trash, converted, 'missing']) assert.equal(vault.convertBodyToChecklist(id), false);
  assert.deepEqual(Y.encodeStateAsUpdate(vault.doc), before);
});
