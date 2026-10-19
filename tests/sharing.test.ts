import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { Vault } from '../src/core/vault';
import { sharedSnapshot, newSharedReference, parseCapability, capability, referencedNote } from '../src/core/shared-note';
import { ScopedUndo } from '../src/core/scoped-undo';

test('publication copies visible content without private deleted text or organization', () => {
  const privateVault = new Vault(), id = privateVault.createNote('checklist', { title: 'Public title', body: 'SECRET' });
  privateVault.setNoteText(id, 'body', 'Safe'); privateVault.setNoteMeta(id, { color: 'coral', archived: true });
  const parent = privateVault.addItem(id, 'Parent'), child = privateVault.addItem(id, 'Child', parent); privateVault.toggleItem(child);
  const ref = newSharedReference(), snapshot = sharedSnapshot(privateVault.getNote(id)!, ref.id), shared = new Vault(snapshot);
  assert.deepEqual(parseCapability(capability(ref)), ref);
  assert.equal(new TextDecoder().decode(Y.encodeStateAsUpdate(snapshot)).includes('SECRET'), false);
  const note = shared.getNote(ref.id)!;
  assert.equal(note.body, 'Safe'); assert.equal(note.archived, false); assert.equal(note.color, 'default');
  assert.equal(note.items[1].parentId, note.items[0].id); assert.equal(note.items[1].checked, true);
  assert.equal(referencedNote(privateVault.getNote(id)!, note).color, 'coral');
  shared.destroy(); privateVault.destroy();
});

test('global undo weaves scopes, excludes remote edits, and invalidates redo across scopes', () => {
  const a = new Vault(), b = new Vault(), remote = new Vault(), undo = new ScopedUndo();
  const x = a.createNote(), y = b.createNote(); a.undoManager.clear(); b.undoManager.clear();
  Y.applyUpdate(remote.doc, Y.encodeStateAsUpdate(b.doc), 'remote');
  undo.add(a); undo.add(b);
  undo.before(a); a.setNoteText(x, 'title', 'Private');
  undo.before(b); b.setNoteText(y, 'title', 'Shared');
  remote.setNoteText(y, 'body', 'Jeremy'); Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(remote.doc), 'remote');
  undo.before(a); a.setNoteText(x, 'body', 'Private body');
  undo.run('undo'); assert.equal(a.getNote(x)!.body, '');
  undo.run('undo'); assert.equal(b.getNote(y)!.title, ''); assert.equal(b.getNote(y)!.body, 'Jeremy');
  undo.run('undo'); assert.equal(a.getNote(x)!.title, '');
  undo.run('redo'); assert.equal(a.getNote(x)!.title, 'Private');
  undo.before(a); a.setNoteText(x, 'body', 'New branch'); assert.equal(undo.can('redo'), false);
  a.destroy(); b.destroy(); remote.destroy();
});

test('fresh IDs do not reorder tied checklist ranks or attachment positions at publication', () => {
  const vault = new Vault(), id = vault.createNote('checklist');
  const first = vault.addItem(id, 'first'), second = vault.addItem(id, 'second');
  vault.items.get(first)!.set('rank', 0); vault.items.get(second)!.set('rank', 0);
  for (const image of ['z', 'a']) vault.addAttachment({ id: image, noteId: id, hash: 'a'.repeat(64), name: image, type: 'image/png', size: 1, order: 0 });
  const original = vault.getNote(id)!;
  const ref = newSharedReference(), shared = new Vault(sharedSnapshot(original, ref.id));
  assert.deepEqual(shared.getNote(ref.id)!.items.map(i => i.text), original.items.map(i => i.text));
  assert.deepEqual(shared.getNote(ref.id)!.images.map(i => i.name), original.images.map(i => i.name));
  shared.destroy(); vault.destroy();
});
