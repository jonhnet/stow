import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as Y from 'yjs';
import { Vault } from '../src/core/vault';
import type { HistoryBoundary } from '../src/core/history-types';
import { redactEditDraft } from '../src/core/edit-draft';

function replica(vault: Vault) {
  const peer = trackedVault(); Y.applyUpdate(peer.doc, Y.encodeStateAsUpdate(vault.doc), 'remote'); return peer;
}
const boundaries = new WeakMap<Vault, HistoryBoundary[]>();
function trackedVault() {
  const vault = new Vault(), observed: HistoryBoundary[] = [];
  boundaries.set(vault, observed); vault.onHistoryBoundary(boundary => observed.push(boundary)); return vault;
}
function textBoundaries(vault: Vault, id: string) {
  return boundaries.get(vault)!.filter(boundary => boundary.sourceIds.includes(id) && boundary.action?.type === 'text');
}

test('history hints and modification time wait for idle and retain last input time', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10000 });
  const vault = trackedVault(); t.after(() => vault.destroy());
  const id = vault.createNote('text', { title: 'Timing' }), originalTime = vault.getNote(id)!.updatedAt;
  t.mock.timers.tick(100); vault.setNoteText(id, 'body', 'a');
  t.mock.timers.tick(4000); vault.setNoteText(id, 'body', 'ab');
  assert.equal(vault.getNote(id)!.updatedAt, originalTime); assert.equal(textBoundaries(vault, id).length, 0);
  const draft = vault.getEditDraft()!;
  assert.equal(draft.firstInputAt, 10100); assert.equal(draft.lastInputAt, 14100);
  assert(Object.isFrozen(draft)); assert(Object.isFrozen(draft.after.sources[id]));
  assert.deepEqual(vault.getPendingEdit(), { modifiedAt: { [id]: 14100 } });
  t.mock.timers.tick(4999); assert(vault.getEditDraft()); t.mock.timers.tick(1);
  assert.equal(vault.getEditDraft(), null); assert.equal(textBoundaries(vault, id)[0].editedAt, 14100);
  assert.equal(vault.getNote(id)!.updatedAt, 14100); assert.equal(vault.getNote(id)!.body, 'ab');
  vault.finishEdit(); assert.equal(textBoundaries(vault, id).length, 1);
  assert(!vault.doc.share.has('revisionBuckets')); assert(!vault.doc.share.has('revisions'));
});

test('net-zero typing sends no boundary and clearing is observable without a CRDT update', t => {
  const vault = trackedVault(); t.after(() => vault.destroy());
  const id = vault.createNote('text', { body: 'before' }), beforeTime = vault.getNote(id)!.updatedAt;
  const observed: unknown[] = [];
  vault.onPendingEditChange(() => observed.push(vault.getPendingEdit()));
  vault.setNoteText(id, 'body', 'before!'); vault.setNoteText(id, 'body', 'before');
  let updates = 0; vault.doc.on('update', () => updates++); vault.finishEdit();
  assert.equal(updates, 0); assert.equal(observed.at(-1), null); assert.equal(vault.getNote(id)!.updatedAt, beforeTime);
  assert.equal(textBoundaries(vault, id).length, 0);
});

test('timestamp metadata and final clearing are visible inside emitted CRDT updates', t => {
  let now = 1000; t.mock.method(Date, 'now', () => now);
  const vault = trackedVault(); t.after(() => vault.destroy()); const id = vault.createNote();
  const observed: unknown[] = [];
  vault.doc.on('update', () => observed.push(vault.getPendingEdit()));
  now++; vault.setNoteText(id, 'body', 'one'); now++; vault.setNoteText(id, 'body', 'two'); vault.finishEdit();
  assert.deepEqual(observed, [{ modifiedAt: { [id]: 1001 } }, { modifiedAt: { [id]: 1002 } }, null]);
});

test('different fields and discrete actions emit completed boundary hints in order', t => {
  const vault = trackedVault(); t.after(() => vault.destroy()); const id = vault.createNote('checklist');
  vault.setNoteText(id, 'title', 'Title'); vault.setNoteText(id, 'body', 'Body');
  assert.equal(textBoundaries(vault, id).length, 1);
  vault.addItem(id, 'Milk'); assert.equal(vault.getEditDraft(), null);
  assert.deepEqual(boundaries.get(vault)!.map(boundary => boundary.action?.type), ['create', 'text', 'text', 'item-add']);
  assert.deepEqual(textBoundaries(vault, id).map(boundary => boundary.action?.field), ['title', 'body']);
});

test('remote changes elsewhere preserve a draft; same-note changes close it without storing authored snapshots', t => {
  const local = trackedVault(); t.after(() => local.destroy());
  const id = local.createNote('text', { body: 'start' }), other = local.createNote();
  const remote = replica(local); t.after(() => remote.destroy());
  local.setNoteText(id, 'body', 'start local'); const draft = local.getEditDraft()!;
  remote.setNoteText(other, 'body', 'unrelated'); remote.finishEdit();
  Y.applyUpdate(local.doc, Y.encodeStateAsUpdate(remote.doc), 'remote'); assert.equal(local.getEditDraft(), draft);
  remote.setNoteText(id, 'body', 'remote start'); Y.applyUpdate(local.doc, Y.encodeStateAsUpdate(remote.doc), 'remote');
  assert.equal(local.getEditDraft(), null); assert.equal(local.getNote(id)!.body, 'remote start local');
  assert.equal(textBoundaries(local, id).length, 1); assert.equal(textBoundaries(local, id)[0].editedAt, draft.lastInputAt);
  assert(!local.doc.share.has('revisionBuckets'));
});

test('timestamp recovery is idempotent, preserves later merged content and emits no history hint', t => {
  let now = 10000; t.mock.method(Date, 'now', () => now);
  const original = trackedVault(); t.after(() => original.destroy()); const id = original.createNote('text', { body: 'start' });
  now = 11000; original.setNoteText(id, 'body', 'start authored'); const pending = original.getPendingEdit()!;
  const recovered = replica(original); t.after(() => recovered.destroy());
  now = 20000; recovered.setNoteText(id, 'body', 'later start authored'); recovered.finishEdit();
  const count = boundaries.get(recovered)!.length;
  recovered.recoverPendingEdit(pending); recovered.recoverPendingEdit(pending);
  assert.equal(recovered.getNote(id)!.body, 'later start authored'); assert.equal(recovered.getNote(id)!.updatedAt, 20000);
  assert.equal(boundaries.get(recovered)!.length, count);
});

test('deleted-source pending timestamps cannot resurrect content or history', t => {
  const original = trackedVault(); t.after(() => original.destroy());
  const id = original.createNote(); original.setNoteText(id, 'body', 'erased draft'); const pending = original.getPendingEdit()!;
  const peer = replica(original); t.after(() => peer.destroy());
  peer.setNoteMeta(id, { trashed: true }); peer.deleteNotesForever([id]); peer.recoverPendingEdit(pending);
  assert.equal(peer.getNote(id), undefined); Y.applyUpdate(original.doc, Y.encodeStateAsUpdate(peer.doc), 'remote');
  assert.equal(original.getEditDraft(), null); assert.equal(original.getPendingEdit(), null);
  assert(!original.doc.share.has('revisionBuckets')); assert.equal(original.undoManager.undoStack.length, 0);
});

test('partial deletion redacts the in-memory merged draft while preserving surviving current text', t => {
  const original = trackedVault(); t.after(() => original.destroy());
  const gone = original.createNote('text', { title: 'Erased title', body: 'erased secret' });
  const keep = original.createNote('text', { title: 'Keep', body: 'surviving text' });
  const deletingPeer = replica(original); t.after(() => deletingPeer.destroy());
  const id = original.mergeNotes([gone, keep]); original.setNoteText(id, 'body', original.getNote(id)!.body + ' authored');
  const redacted = redactEditDraft(original.getEditDraft()!, new Set([gone]))!;
  assert.deepEqual(redacted.sourceIds, [keep]); assert(!JSON.stringify(redacted).includes('erased secret'));
  assert(!JSON.stringify(redacted).includes('Erased title'));
  deletingPeer.setNoteMeta(gone, { trashed: true }); deletingPeer.deleteNotesForever([gone]);
  Y.applyUpdate(original.doc, Y.encodeStateAsUpdate(deletingPeer.doc), 'remote');
  assert.equal(original.getEditDraft(), null); assert(original.getNote(keep)!.body.includes('surviving text authored'));
  assert(!JSON.stringify(original.captureHistoryState([keep])).includes('erased secret'));
  assert.deepEqual(textBoundaries(original, keep).at(-1)!.sourceIds, [keep]);
});

test('recovery timestamp arriving from another page closes the old draft before fresh typing', t => {
  let now = 10000; t.mock.method(Date, 'now', () => now);
  const vault = trackedVault(); t.after(() => vault.destroy()); const id = vault.createNote();
  now++; vault.setNoteText(id, 'body', 'one'); const pending = vault.getPendingEdit()!;
  const peer = replica(vault); t.after(() => peer.destroy()); peer.recoverPendingEdit(pending);
  Y.applyUpdate(vault.doc, Y.encodeStateAsUpdate(peer.doc), 'remote'); assert.equal(vault.getEditDraft(), null);
  now++; vault.setNoteText(id, 'body', 'two'); vault.finishEdit();
  assert.equal(textBoundaries(vault, id).length, 2); assert.equal(vault.getNote(id)!.body, 'two');
});

test('Undo keeps fine groups after coarse history completion and caps continuous typing at two seconds', t => {
  let now = 10000; t.mock.method(Date, 'now', () => now);
  const vault = trackedVault(); t.after(() => vault.destroy());
  const id = vault.createNote();
  for (let count = 1; count <= 30; count++) { now += 100; vault.setNoteText(id, 'body', 'x'.repeat(count)); }
  const fineGroups = vault.undoManager.undoStack.length;
  assert.equal(fineGroups, 3, 'creation plus two fine typing groups');
  vault.finishEdit(); assert.equal(vault.undoManager.undoStack.length, fineGroups);
  assert.equal(textBoundaries(vault, id).length, 1);
  vault.undo(); assert.equal(vault.getNote(id)!.body, 'x'.repeat(20));
  vault.undo(); assert.equal(vault.getNote(id)!.body, '');
  vault.redo(); assert.equal(vault.getNote(id)!.body, 'x'.repeat(20));
});

test('insertion and deletion use separate fine Undo steps without splitting saved history', t => {
  const vault = trackedVault(); t.after(() => vault.destroy()); const id = vault.createNote();
  vault.setNoteText(id, 'body', 'abc'); vault.setNoteText(id, 'body', 'ab');
  assert.equal(vault.undoManager.undoStack.length, 3);
  vault.finishEdit(); assert.equal(textBoundaries(vault, id).length, 1);
  vault.undo(); assert.equal(vault.getNote(id)!.body, 'abc');
});

test('continuous middle insertion remains one Undo step across identical existing characters', t => {
  const vault = trackedVault(); t.after(() => vault.destroy());
  const original = 'Original body ABC', id = vault.createNote('text', { body: original });
  let caret = 1;
  for (const character of 'prefix ') {
    const before = vault.getNote(id)!.body;
    vault.setNoteText(id, 'body', before.slice(0, caret) + character + before.slice(caret)); caret++;
  }
  assert.equal(vault.getNote(id)!.body, 'Oprefix riginal body ABC');
  vault.undo(); assert.equal(vault.getNote(id)!.body, original);
});

test('IME stays one Undo action and defers overlapping boundaries until final input', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10000 });
  const vault = trackedVault(); t.after(() => vault.destroy()); const id = vault.createNote();
  vault.beginComposition(); vault.setNoteText(id, 'body', 'n');
  t.mock.timers.tick(6000); vault.finishEdit(); vault.breakUndo();
  assert.equal(textBoundaries(vault, id).length, 0);
  vault.setNoteText(id, 'body', '日本'); vault.endComposition();
  assert.equal(textBoundaries(vault, id).length, 1); assert.equal(vault.getEditDraft(), null);
  vault.undo(); assert.equal(vault.getNote(id)!.body, '');
});

test('IME creation and subsequent text updates are one Undo action with the completed item description', t => {
  const vault = trackedVault(); t.after(() => vault.destroy()); const id = vault.createNote('checklist');
  vault.beginComposition(); const item = vault.addItem(id, 'n');
  vault.setItemText(item, 'ni'); vault.setItemText(item, '日本'); vault.endComposition(); vault.finishEdit();
  assert.equal(vault.undo(), 'Item: added “日本”'); assert.deepEqual(vault.getItems(id), []);
  vault.redo(); assert.equal(vault.getItems(id)[0].text, '日本');
});

test('lazy note creation during IME joins its first composed text in one Undo action', t => {
  const vault = trackedVault(); t.after(() => vault.destroy());
  vault.beginComposition(); const id = vault.createNote();
  vault.setNoteText(id, 'body', 'n'); vault.setNoteText(id, 'body', '日本'); vault.endComposition(); vault.finishEdit();
  vault.undo(); assert.equal(vault.getNote(id), undefined);
});

test('note reordering does not change content modification time', t => {
  let now = 10000; t.mock.method(Date, 'now', () => now);
  const vault = trackedVault(); t.after(() => vault.destroy());
  const first = vault.createNote(), second = vault.createNote();
  const initial = vault.getNote(first)!.updatedAt; now += 1000;
  vault.moveNoteRelative(first, second, 'before');
  assert.equal(vault.getNote(first)!.updatedAt, initial);
});

test('Undo and Redo advance completed modification time and preserve it after reload', t => {
  let now = 10000; t.mock.method(Date, 'now', () => now);
  const vault = trackedVault(); t.after(() => vault.destroy());
  const id = vault.createNote('text', { body: 'Before' });
  now = 11000; vault.setNoteText(id, 'body', 'After'); vault.finishEdit();
  assert.equal(vault.getNote(id)!.updatedAt, 11000);
  now = 12000; vault.undo();
  assert.equal(vault.getNote(id)!.body, 'Before'); assert.equal(vault.getNote(id)!.updatedAt, 12000);
  assert.equal(boundaries.get(vault)!.at(-1)!.editedAt, 12000);
  now = 13000; vault.redo();
  assert.equal(vault.getNote(id)!.body, 'After'); assert.equal(vault.getNote(id)!.updatedAt, 13000);
  const peer = replica(vault); t.after(() => peer.destroy());
  assert.equal(peer.getNote(id)!.updatedAt, 13000);
  assert.equal(vault.notes.get(id)!.get('updatedAt'), 13000, 'Completed edits keep timestamps in the current note independently of server history');
});

test('checklist Undo and Redo use their action time without adding undo steps for metadata', t => {
  let now = 10000; t.mock.method(Date, 'now', () => now);
  const vault = trackedVault(); t.after(() => vault.destroy());
  const id = vault.createNote('checklist'), item = vault.addItem(id, 'Milk');
  now = 11000; vault.toggleItem(item); const steps = vault.undoManager.undoStack.length;
  now = 12000; vault.undo();
  assert.equal(vault.getItems(id)[0].checked, false); assert.equal(vault.getNote(id)!.updatedAt, 12000);
  assert.equal(vault.undoManager.undoStack.length, steps - 1);
  now = 13000; vault.redo();
  assert.equal(vault.getItems(id)[0].checked, true); assert.equal(vault.getNote(id)!.updatedAt, 13000);
  assert.equal(vault.undoManager.undoStack.length, steps);
});

test('Undo and Redo of tile order or global label color leave note modification time unchanged', t => {
  let now = 10000; t.mock.method(Date, 'now', () => now);
  const vault = trackedVault(); t.after(() => vault.destroy()); const first = vault.createNote();
  now = 10001; const second = vault.createNote();
  now = 11000; assert(vault.moveNoteRelative(first, second, 'before'));
  now = 12000; vault.undo(); assert.equal(vault.getNote(first)!.updatedAt, 10000);
  now = 13000; vault.redo(); assert.equal(vault.getNote(first)!.updatedAt, 10000);
  now = 14000; vault.setNoteLabel(first, 'Travel', true);
  now = 15000; vault.setLabelColor('Travel', 'coral');
  now = 16000; vault.undo(); assert.equal(vault.getNote(first)!.updatedAt, 14000);
  now = 17000; vault.redo(); assert.equal(vault.getNote(first)!.updatedAt, 14000);
});
