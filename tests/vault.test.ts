import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as Y from 'yjs';
import { Vault } from '../src/core/vault';

function replica(source: Vault) { const next = new Vault(); Y.applyUpdate(next.doc, Y.encodeStateAsUpdate(source.doc), 'remote'); return next; }
function sync(a: Vault, b: Vault) {
  a.finishEdit(); b.finishEdit();
  const fromA = Y.encodeStateAsUpdate(a.doc), fromB = Y.encodeStateAsUpdate(b.doc);
  Y.applyUpdate(a.doc, fromB, 'remote'); Y.applyUpdate(b.doc, fromA, 'remote');
  // Duplicate replay must be harmless.
  Y.applyUpdate(b.doc, fromA, 'remote');
  assert.deepEqual(a.getNotes(), b.getNotes());
}

test('independent offline text edits and checkbox edits converge without whole-note overwrites', () => {
  const a = new Vault();
  const id = a.createNote('checklist', { title: 'Groceries', body: 'coffee and tea' });
  const apples = a.addItem(id, 'Apples');
  const b = replica(a);
  a.setNoteText(id, 'body', 'iced coffee and tea');
  b.setNoteText(id, 'body', 'coffee and green tea');
  a.toggleItem(apples);
  b.setItemText(apples, 'Green apples');
  const bread = b.addItem(id, 'Bread');
  sync(a, b);
  assert.equal(a.getNote(id)!.body, 'iced coffee and green tea');
  assert.equal(a.getNote(id)!.items.find(i => i.id === apples)!.checked, true);
  assert.equal(a.getNote(id)!.items.find(i => i.id === apples)!.text, 'Green apples');
  assert(a.getNote(id)!.items.some(i => i.id === bread));
});

test('merging retains late offline edits, source identities, and checkbox state', () => {
  const desktop = new Vault();
  const first = desktop.createNote('text', { title: 'Trip', body: 'Book tickets' });
  const second = desktop.createNote('checklist', { title: 'Packing' });
  const item = desktop.addItem(second, 'Passport');
  const phone = replica(desktop);
  desktop.mergeNotes([first, second]);
  phone.toggleItem(item);
  phone.setNoteText(second, 'title', 'Packing for Japan');
  phone.addItem(second, 'Charger');
  sync(desktop, phone);
  assert.equal(desktop.getNotes().length, 1);
  const note = desktop.getNotes()[0];
  assert.equal(note.sourceIds.length, 2);
  assert.equal(desktop.notes.get(second)!.get('title').toString(), 'Packing for Japan');
  assert.match(`${note.title}\n${note.body}`, /Packing for Japan/);
  assert.equal(note.items.find(i => i.id === item)!.checked, true);
  assert(note.items.some(i => i.text === 'Charger'));
  desktop.undo();
  sync(desktop, phone);
  assert.equal(desktop.getNotes().length, 2);
  assert.equal(desktop.getNote(second)!.items.find(i => i.id === item)!.checked, true);
});

test('overlapping and reversed concurrent merges converge into one group without cycles or duplicated content', () => {
  const a = new Vault();
  const ids = ['One', 'Two', 'Three'].map(title => a.createNote('text', { title }));
  const b = replica(a), c = replica(a);
  a.mergeNotes([ids[0], ids[1]]);
  b.mergeNotes([ids[1], ids[0]]);
  c.mergeNotes([ids[1], ids[2]]);
  sync(a, b); sync(b, c); sync(a, c); sync(a, b);
  assert.equal(a.getNotes().length, 1);
  assert.equal(a.getNotes()[0].sourceIds.length, 3);
  // Older clients may still remove merge edges; the current UI offers merge Undo.
  a.doc.transact(() => { for (const id of [...a.merges.keys()]) a.merges.delete(id); }, 'remote');
  sync(a, b);
  assert.equal(a.getNotes().length, 3);
});

test('local undo preserves edits made on another device, and redo restores the local change', () => {
  const a = new Vault();
  const id = a.createNote('text', { title: 'Original', body: 'First' });
  const b = replica(a);
  a.setNoteText(id, 'title', 'Changed');
  b.setNoteText(id, 'body', 'Remote body');
  sync(a, b);
  a.undo();
  assert.equal(a.getNote(id)!.title, 'Original');
  assert.equal(a.getNote(id)!.body, 'Remote body');
  a.redo();
  assert.equal(a.getNote(id)!.title, 'Changed');
});

test('a standalone snapshot restores as a new note after current-state reload without overwriting data', () => {
  const a = new Vault();
  const id = a.createNote('checklist', { title: 'Before' });
  const item = a.addItem(id, 'Milk');
  a.toggleItem(item);
  a.addAttachment({ id: 'image-1', noteId: id, hash: 'a'.repeat(64), name: 'photo.png', type: 'image/png', size: 42 });
  const snapshot = JSON.parse(JSON.stringify(a.captureHistoryState([id])));
  a.setNoteText(id, 'title', 'After');
  const loaded = replica(a);
  assert.equal(loaded.undoManager.undoStack.length, 0);
  const restored = loaded.restoreHistoryState(snapshot);
  assert.notEqual(restored, id);
  assert.equal(loaded.getNote(id)!.title, 'After');
  assert.equal(loaded.getNote(restored)!.title, 'Before');
  assert.equal(loaded.getNote(restored)!.items[0].checked, true);
  assert.equal(loaded.getNote(restored)!.images[0].hash, 'a'.repeat(64));
  assert.notEqual(loaded.getNote(restored)!.items[0].id, item);
});

test('archive, trash, and undo act on a whole merged note', () => {
  const a = new Vault();
  const first = a.createNote(), second = a.createNote();
  const id = a.mergeNotes([first, second]);
  a.setNoteMeta(id, { archived: true });
  assert.equal(a.getNote(id)!.archived, true);
  a.setNoteMeta(id, { trashed: true });
  assert.equal(a.getNote(id)!.trashed, true);
  a.undo();
  assert.equal(a.getNote(id)!.trashed, false);
  assert.equal(a.getNote(id)!.archived, true);
});

test('adding a checklist preserves prose and edits arriving from an offline device', () => {
  const a = new Vault();
  const id = a.createNote('text', { body: 'One\nTwo' });
  const b = replica(a);
  a.setNoteMeta(id, { kind: 'checklist' });
  a.addItem(id, 'Three');
  b.setNoteText(id, 'body', 'One\nTwo updated');
  sync(a, b);
  assert.equal(a.getNote(id)!.body, 'One\nTwo updated');
  assert.equal(a.getNote(id)!.items[0].text, 'Three');
  a.undo();
  assert.equal(a.getNote(id)!.items.length, 0);
  assert.equal(a.getNote(id)!.body, 'One\nTwo updated');
});

test('items added at the same offline rank can subsequently be reordered', () => {
  const a = new Vault();
  const id = a.createNote('checklist');
  const b = replica(a);
  a.addItem(id, 'First'); b.addItem(id, 'Second');
  sync(a, b);
  const before = a.getNote(id)!.items.map(i => i.id);
  a.moveItem(before[1], -1);
  assert.deepEqual(a.getNote(id)!.items.map(i => i.id), [...before].reverse());
  sync(a, b);
});

test('relative checklist moves cross multiple rows, change only the moved rank, and undo in one step', () => {
  const vault = new Vault();
  const noteId = vault.createNote('checklist');
  const ids = ['One', 'Two', 'Three', 'Four', 'Five'].map(text => vault.addItem(noteId, text));
  const ranks = new Map(vault.getItems(noteId).map(item => [item.id, item.rank]));
  vault.undoManager.clear();

  vault.moveItemRelative(ids[0], ids[3], 'before');
  const firstMove = [ids[1], ids[2], ids[0], ids[3], ids[4]];
  assert.deepEqual(vault.getItems(noteId).map(item => item.id), firstMove);
  assert(vault.getItems(noteId).filter(item => item.id !== ids[0]).every(item => item.rank === ranks.get(item.id)));
  assert.equal(vault.undoManager.undoStack.length, 1);

  vault.moveItemRelative(ids[4], ids[1], 'after');
  const secondMove = [ids[1], ids[4], ids[2], ids[0], ids[3]];
  assert.deepEqual(vault.getItems(noteId).map(item => item.id), secondMove);
  assert.equal(vault.undoManager.undoStack.length, 2);
  vault.undo();
  assert.deepEqual(vault.getItems(noteId).map(item => item.id), firstMove);
  vault.redo();
  assert.deepEqual(vault.getItems(noteId).map(item => item.id), secondMove);
  vault.undo();
  vault.undo();
  assert.deepEqual(vault.getItems(noteId).map(item => item.id), ids);
});

test('reordering and its undo preserve moved records and late offline text and checkbox edits', () => {
  const desktop = new Vault();
  const noteId = desktop.createNote('checklist');
  const ids = ['One', 'Two', 'Three', 'Four'].map(text => desktop.addItem(noteId, text));
  const movedRecord = desktop.items.get(ids[3]);
  const movedText = movedRecord!.get('text');
  const phone = replica(desktop);

  desktop.moveItemRelative(ids[3], ids[0], 'before');
  phone.setItemText(ids[3], 'Four updated offline');
  phone.toggleItem(ids[3]);
  sync(desktop, phone);
  assert.deepEqual(desktop.getItems(noteId).map(item => item.id), [ids[3], ids[0], ids[1], ids[2]]);
  assert.equal(desktop.items.get(ids[3]), movedRecord);
  assert.equal(desktop.items.get(ids[3])!.get('text'), movedText);
  assert.equal(desktop.getItems(noteId)[0].text, 'Four updated offline');
  assert.equal(desktop.getItems(noteId)[0].checked, true);

  desktop.undo();
  sync(desktop, phone);
  assert.deepEqual(desktop.getItems(noteId).map(item => item.id), ids);
  assert.equal(desktop.getItems(noteId)[3].text, 'Four updated offline');
  assert.equal(desktop.getItems(noteId)[3].checked, true);
  assert.equal(desktop.items.get(ids[3]), movedRecord);
});

test('dropping between equal ranks restores spacing in one undoable operation', () => {
  const vault = new Vault();
  const noteId = vault.createNote('checklist');
  const ids = ['One', 'Two', 'Three', 'Four'].map(text => vault.addItem(noteId, text));
  vault.doc.transact(() => ids.forEach(id => vault.items.get(id)!.set('rank', 1024)), 'remote');
  const original = vault.getItems(noteId).map(item => item.id);
  const records = original.map(id => vault.items.get(id));
  vault.undoManager.clear();

  vault.moveItemRelative(original[3], original[0], 'after');
  assert.deepEqual(vault.getItems(noteId).map(item => item.id), [original[0], original[3], original[1], original[2]]);
  assert.equal(vault.undoManager.undoStack.length, 1);
  original.forEach((id, i) => assert.equal(vault.items.get(id), records[i]));
  vault.undo();
  assert.deepEqual(vault.getItems(noteId).map(item => item.id), original);
  assert(vault.getItems(noteId).every(item => item.rank === 1024));
});

test('dropping into an exhausted numeric gap restores spacing', () => {
  const vault = new Vault();
  const noteId = vault.createNote('checklist');
  const ids = ['One', 'Two', 'Three', 'Four'].map(text => vault.addItem(noteId, text));
  const ranks = [0, 1, 1 + Number.EPSILON, 2];
  vault.doc.transact(() => ids.forEach((id, i) => vault.items.get(id)!.set('rank', ranks[i])), 'remote');
  vault.undoManager.clear();
  vault.moveItemRelative(ids[3], ids[1], 'after');
  assert.deepEqual(vault.getItems(noteId).map(item => item.id), [ids[0], ids[1], ids[3], ids[2]]);
  vault.undo();
  assert.deepEqual(vault.getItems(noteId).map(item => item.rank), ranks);
});

test('relative moves ignore other notes, checked groups, deleted items, and unchanged placement', () => {
  const vault = new Vault();
  const first = vault.createNote('checklist'), second = vault.createNote('checklist');
  const one = vault.addItem(first, 'One'), two = vault.addItem(first, 'Two');
  const checked = vault.addItem(first, 'Checked'), deleted = vault.addItem(first, 'Deleted');
  vault.addItem(second, 'Merged source');
  const otherNote = vault.addItem(vault.createNote('checklist'), 'Other note');
  vault.toggleItem(checked);
  vault.deleteItem(deleted);
  vault.mergeNotes([first, second]);
  vault.undoManager.clear();
  const original = Y.encodeStateAsUpdate(vault.doc);

  vault.moveItemRelative(one, otherNote, 'after');
  vault.moveItemRelative(one, checked, 'after');
  vault.moveItemRelative(checked, one, 'before');
  vault.moveItemRelative(one, deleted, 'before');
  vault.moveItemRelative(deleted, one, 'after');
  vault.moveItemRelative('missing', one, 'after');
  vault.moveItemRelative(one, 'missing', 'after');
  vault.moveItemRelative(one, one, 'after');
  vault.moveItemRelative(one, two, 'before');
  vault.moveItemRelative(two, one, 'after');
  vault.moveItem(deleted, 1);
  vault.moveItem(one, -1);
  assert.deepEqual(Y.encodeStateAsUpdate(vault.doc), original);
  assert.equal(vault.undoManager.undoStack.length, 0);
});

test('keyboard moves select the adjacent item in the same visible checkbox group', () => {
  const vault = new Vault();
  const noteId = vault.createNote('checklist');
  const one = vault.addItem(noteId, 'One'), checked = vault.addItem(noteId, 'Checked'), two = vault.addItem(noteId, 'Two');
  vault.toggleItem(checked);
  const checkedRank = vault.items.get(checked)!.get('rank');
  vault.moveItem(two, -1);
  assert.deepEqual(vault.getItems(noteId).filter(item => !item.checked).map(item => item.id), [two, one]);
  assert.equal(vault.items.get(checked)!.get('rank'), checkedRank);
  vault.moveItem(two, 1);
  assert.deepEqual(vault.getItems(noteId).filter(item => !item.checked).map(item => item.id), [one, two]);
  assert.equal(vault.items.get(checked)!.get('rank'), checkedRank);
});
