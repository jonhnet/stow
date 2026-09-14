import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as Y from 'yjs';
import { Vault } from '../src/core/vault';
import { snapshotNote, captureSnapshot, observeBoundaries, assertNoReplicatedHistory } from './history-state-fixture';

function replica(source: Vault) { const next = new Vault(); Y.applyUpdate(next.doc, Y.encodeStateAsUpdate(source.doc), 'remote'); return next; }
function sync(a: Vault, b: Vault) {
  const aa = Y.encodeStateAsUpdate(a.doc), bb = Y.encodeStateAsUpdate(b.doc);
  Y.applyUpdate(a.doc, bb, 'remote'); Y.applyUpdate(b.doc, aa, 'remote');
}
function rawNote(vault: Vault, count = 0) {
  const id = crypto.randomUUID(), items: string[] = [];
  vault.doc.transact(() => {
    const note = new Y.Map<any>(); vault.notes.set(id, note);
    for (const [key, value] of Object.entries({ title: new Y.Text('Existing note'), body: new Y.Text('Before'), kind: count ? 'checklist' : 'text', color: 'default', pinned: false, archived: false, trashed: false, createdAt: 100, updatedAt: 100 })) note.set(key, value);
    for (let index = 0; index < count; index++) {
      const itemId = crypto.randomUUID(), item = new Y.Map<any>(); items.push(itemId); vault.items.set(itemId, item);
      for (const [key, value] of Object.entries({ noteId: id, text: new Y.Text(`Item ${index}: ${'x'.repeat(50)}`), checked: false, deleted: false, rank: index * 1024 })) item.set(key, value);
    }
  }, 'remote');
  return { id, items };
}

test('completed actions notify once and remote synchronization creates neither local boundaries nor replicated history', t => {
  let now = 1000; t.mock.method(Date, 'now', () => now);
  const vault = new Vault(); t.after(() => vault.destroy()); const boundaries = observeBoundaries(vault);
  const id = vault.createNote('checklist', { title: 'List' }), item = vault.addItem(id, 'Milk');
  const peer = replica(vault); t.after(() => peer.destroy()); const remoteBoundaries = observeBoundaries(peer);
  const initial = boundaries.length; now = 2000; vault.setItemText(item, 'Whole milk');
  assert.equal(boundaries.length, initial); sync(vault, peer);
  assert.equal(peer.getItems(id)[0].text, 'Whole milk'); assert.equal(remoteBoundaries.length, 0);
  vault.finishEdit(); assert.equal(boundaries.length, initial + 1);
  assert.equal(boundaries.at(-1)!.editedAt, 2000); assert.match(boundaries.at(-1)!.description!, /Whole/);
  now = 3000; vault.toggleItem(item); assert.equal(boundaries.length, initial + 2);
  assert.equal(boundaries.at(-1)!.action?.type, 'check'); assert.equal(boundaries.at(-1)!.action?.checked, true);
  sync(vault, peer); assert.deepEqual(peer.getNote(id), vault.getNote(id)); assert.equal(remoteBoundaries.length, 0);
  assertNoReplicatedHistory(vault.doc); assertNoReplicatedHistory(peer.doc);
});

test('standalone snapshots preserve removed text and restore copies without reintroducing client history', t => {
  const vault = new Vault(); t.after(() => vault.destroy()); const id = vault.createNote('text', { body: 'skidderidoo' });
  const saved = captureSnapshot(vault, id); vault.setNoteText(id, 'body', 'Current'); vault.finishEdit();
  const peer = replica(vault); t.after(() => peer.destroy());
  const state = JSON.parse(JSON.stringify(saved.state)); assert.equal(snapshotNote(state)!.body, 'skidderidoo');
  const restored = peer.restoreHistoryState(state);
  assert.notEqual(restored, id); assert.equal(peer.getNote(restored)!.body, 'skidderidoo'); assert.equal(peer.getNote(id)!.body, 'Current');
  assertNoReplicatedHistory(peer.doc);
});

test('merged and separated snapshots restore one ordinary fresh note for each recorded group', t => {
  const vault = new Vault(); t.after(() => vault.destroy());
  const a = vault.createNote('text', { title: 'A' }), b = vault.createNote('text', { title: 'B' });
  const separated = vault.captureHistoryState([a, b]); vault.mergeNotes([a, b]); const merged = captureSnapshot(vault, a);
  const mergedCopy = vault.restoreHistoryState(merged.state); assert.equal(vault.getNote(mergedCopy)!.sourceIds.length, 1);
  assert.equal(vault.getNote(mergedCopy)!.body, merged.note.body);
  vault.restoreHistoryState(separated); assert.equal(vault.getNotes().length, 4);
  assert.deepEqual(snapshotNote(merged.state), merged.note); assertNoReplicatedHistory(vault.doc);
});

test('indexed projections keep unrelated references stable through remote edits, moves, undo and merges', () => {
  const vault = new Vault(), a = vault.createNote(), b = vault.createNote(), c = vault.createNote();
  const item = vault.addItem(a, 'One'), beforeB = vault.getNote(b), beforeC = vault.getNote(c), list = vault.getNotes();
  assert.equal(vault.getNotes(), list);
  const peer = replica(vault); peer.setItemText(item, 'Remote'); sync(vault, peer);
  assert.equal(vault.getNote(b), beforeB); assert.equal(vault.getNote(c), beforeC); assert.equal(vault.getNote(a)!.items[0].text, 'Remote');
  vault.toggleItem(item); vault.undo();
  assert.equal(vault.getNote(b), beforeB); assert.equal(vault.getNote(c), beforeC);
  vault.mergeNotes([a, b]); assert.equal(vault.getNote(c), beforeC);
  vault.undo(); assert.equal(vault.getNote(c), beforeC);
  vault.doc.transact(() => vault.items.get(item)!.set('noteId', b), 'remote');
  assert.equal(vault.getItems(a).length, 0); assert.equal(vault.getItems(b)[0].id, item);
  vault.destroy(); peer.destroy();
});

test('item lookup and a cached note lookup never enumerate the whole item map', () => {
  const vault = new Vault(), a = rawNote(vault, 25), b = rawNote(vault, 25);
  vault.getNotes();
  (vault.items as any).entries = () => { throw new Error('Whole-vault item scan'); };
  (vault.items as any).values = () => { throw new Error('Whole-vault item scan'); };
  vault.toggleItem(a.items[0]);
  assert.equal(vault.getNote(a.id)!.items[0].checked, true); assert.equal(vault.getNote(b.id)!.items.length, 25);
  vault.destroy();
});
