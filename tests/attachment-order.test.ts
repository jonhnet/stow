import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as Y from 'yjs';
import { assignImportIds } from '../scripts/import-keep';
import type { KeepSourceNote } from '../scripts/keep-source';
import { applyImport, type ImportedNote } from '../src/core/import';
import { snapshotNote, captureSnapshot, assertNoReplicatedHistory } from './history-state-fixture';
import { Vault } from '../src/core/vault';
import type { Attachment } from '../src/core/types';

function source(sourcePath = 'Keep/note.json', count = 4): KeepSourceNote {
  return {
    sourcePath, title: sourcePath, body: '', kind: 'text', color: 'default',
    pinned: false, archived: false, trashed: false, createdAt: 100, updatedAt: 200,
    labels: [], items: [], takeout: { sourcePath, rawHash: 'f'.repeat(64), labels: [] },
    attachments: Array.from({ length: count }, (_, index) => ({
      sourcePath: `Keep/image-${index}.png`, hash: index.toString(16).padStart(64, '0'),
      name: `image-${index}.png`, type: 'image/png', size: index + 1,
    })),
  };
}
function importNotes(vault: Vault, notes: ImportedNote[], id = 'attachment-order-import') {
  return applyImport(vault, { id, manifestHash: 'e'.repeat(64), notes, replaceSourceIds: [] });
}
function replica(vault: Vault) {
  const result = new Vault();
  Y.applyUpdate(result.doc, Y.encodeStateAsUpdate(vault.doc), 'remote');
  return result;
}
function sync(a: Vault, b: Vault) {
  const fromA = Y.encodeStateAsUpdate(a.doc), fromB = Y.encodeStateAsUpdate(b.doc);
  Y.applyUpdate(a.doc, fromB, 'remote'); Y.applyUpdate(b.doc, fromA, 'remote');
  assert.deepEqual(a.getNotes(), b.getNotes());
}
const names = (images: Attachment[]) => images.map(image => image.name);

test('future import plans preserve source image sequence through normalized storage and binary reload', t => {
  const original = source('Keep/future-import.json', 10);
  const [note] = assignImportIds([original], 'future-import');
  assert.deepEqual(note.images.map(image => image.order), Array.from({ length: 10 }, (_, i) => i));
  assert.notDeepEqual(note.images.map(image => image.id), note.images.map(image => image.id).sort(), 'Fixture must catch the previous ID-sort defect');
  const vault = new Vault(); t.after(() => vault.destroy());
  importNotes(vault, [note]);
  const loaded = replica(vault); t.after(() => loaded.destroy());
  assert.deepEqual(names(vault.getNote(note.id)!.images), original.attachments.map(image => image.name));
  assert.deepEqual(loaded.getNote(note.id)!.images, note.images);
  assertNoReplicatedHistory(vault.doc);
  const beforeRetry = Y.encodeStateAsUpdate(loaded.doc);
  assert.equal(importNotes(loaded, [note]).status, 'already-applied');
  assert.deepEqual(Y.encodeStateAsUpdate(loaded.doc), beforeRetry);
});

test('attachment order survives history deltas, deletion undo/redo, merged previews and restore with new IDs', t => {
  const vault = new Vault(); t.after(() => vault.destroy());
  const notes = assignImportIds([source('Keep/one.json'), { ...source('Keep/two.json', 3), createdAt: 300 }], 'history-order');
  importNotes(vault, notes);
  const id = notes[0].id, originalNames = names(notes[0].images);
  const baseline = captureSnapshot(vault, id);
  vault.setNoteText(id, 'body', 'First local edit'); vault.finishEdit();
  assert.deepEqual(names(snapshotNote(baseline.state)!.images), originalNames);
  vault.undoManager.stopCapturing();
  vault.removeAttachment(notes[0].images[1].id);
  const removed = captureSnapshot(vault, id);
  assert.deepEqual(names(vault.getNote(id)!.images), originalNames.filter((_, i) => i !== 1));
  vault.undo();
  assert.deepEqual(names(vault.getNote(id)!.images), originalNames);
  vault.redo();
  assert.deepEqual(names(snapshotNote(removed.state)!.images), originalNames.filter((_, i) => i !== 1));
  vault.undo();
  vault.mergeNotes(notes.map(note => note.id));
  const mergedSnapshot = captureSnapshot(vault, id);
  const loaded = replica(vault); t.after(() => loaded.destroy());
  const expected = notes.flatMap(note => names(note.images));
  assert.deepEqual(names(snapshotNote(mergedSnapshot.state)!.images), expected);
  const restored = loaded.getNote(loaded.restoreHistoryState(mergedSnapshot.state))!;
  assert.deepEqual(names(restored.images), expected);
  assert(restored.images.every(image => !notes.flatMap(note => note.images).some(original => original.id === image.id)));
  assert.deepEqual(restored.images.map(image => image.order), [0, 1, 2, 3, 4, 5, 6]);
});

test('older unpositioned attachments remain readable and a captured snapshot restores ordered copies without rewriting originals', t => {
  const [note] = assignImportIds([source('Keep/old.json', 2)], 'old-order');
  note.images = note.images.map(({ order: _order, ...image }, index) => ({ ...image, id: index ? 'a-old' : 'z-old' }));
  const seed = new Vault(); t.after(() => seed.destroy()); importNotes(seed, [note]);
  const doc = new Y.Doc(); Y.applyUpdate(doc, Y.encodeStateAsUpdate(seed.doc));
  const before = Y.encodeStateAsUpdate(doc); let writes = 0; doc.on('update', () => writes++);
  const vault = new Vault(doc); t.after(() => vault.destroy());
  const snapshot = captureSnapshot(vault, note.id);
  assert.deepEqual(snapshot.note.images.map(image => image.id), ['a-old', 'z-old']);
  assert.equal(writes, 0); assert.deepEqual(Y.encodeStateAsUpdate(doc), before);
  assert([...vault.attachments.values()].every(image => !Object.hasOwn(image, 'order')));
  const copy = vault.getNote(vault.restoreHistoryState(JSON.parse(JSON.stringify(snapshot.state))))!;
  assert.deepEqual(names(copy.images), names(snapshot.note.images));
  assert.deepEqual(copy.images.map(image => image.order), [0, 1]);
  assert([...vault.attachments.values()].filter(image => image.noteId === note.id).every(image => !Object.hasOwn(image, 'order')));
});

test('new uploads append after older unpositioned images and offline additions converge with deterministic ties', t => {
  const notes = assignImportIds([source('Keep/old-upload.json', 2), source('Keep/unaffected.json', 0)], 'offline-order');
  notes[0].images = notes[0].images.map(({ order: _order, ...image }, index) => ({ ...image, id: index ? 'z-old' : 'a-old' }));
  const a = new Vault(); t.after(() => a.destroy()); importNotes(a, notes);
  const b = replica(a); t.after(() => b.destroy());
  const id = notes[0].id, unaffected = b.getNote(notes[1].id);
  const add = (vault: Vault, imageId: string) => vault.addAttachment({ id: imageId, noteId: id, hash: 'd'.repeat(64), name: imageId, type: 'image/png', size: 1 });
  add(a, 'z-new'); add(b, 'a-new');
  assert.deepEqual(a.getNote(id)!.images.map(image => image.id), ['a-old', 'z-old', 'z-new']);
  sync(a, b);
  assert.deepEqual(a.getNote(id)!.images.map(image => image.id), ['a-old', 'z-old', 'a-new', 'z-new']);
  assert.equal(b.getNote(notes[1].id), unaffected, 'Other note projection remains cached');
  add(a, '0-later'); sync(a, b);
  assert.deepEqual(b.getNote(id)!.images.map(image => image.id), ['a-old', 'z-old', 'a-new', 'z-new', '0-later']);
  assert.equal(b.attachments.get('0-later')!.order, 1);
  const snapshot = captureSnapshot(b, id);
  const loaded = replica(b); t.after(() => loaded.destroy());
  assert.deepEqual(names(snapshotNote(snapshot.state)!.images), names(loaded.getNote(id)!.images));
  assert.deepEqual(names(loaded.getNote(loaded.restoreHistoryState(snapshot.state))!.images), names(loaded.getNote(id)!.images));
});

test('invalid import positions fail before mutating notes, attachment records or receipts', t => {
  const vault = new Vault(); t.after(() => vault.destroy());
  const before = Y.encodeStateAsUpdate(vault.doc);
  for (const order of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const notes = assignImportIds([source()], 'invalid-order'); notes[0].images[0].order = order;
    assert.throws(() => importNotes(vault, notes), /image order must be a nonnegative safe integer/);
    assert.deepEqual(Y.encodeStateAsUpdate(vault.doc), before);
    assert.equal(vault.notes.size, 0); assert.equal(vault.attachments.size, 0); assert.equal(vault.doc.getMap('imports').size, 0);
  }
});
