import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as Y from 'yjs';
import { applyImport, type ImportedNote, type ImportOptions } from '../src/core/import';
import { Vault } from '../src/core/vault';
import { assertNoReplicatedHistory } from './history-state-fixture';

const manifestHash = 'a'.repeat(64);
function imported(id = 'takeout-note'): ImportedNote {
  return {
    id, title: 'Packing 😀', body: 'Line one\nhttps://example.com/旅行', kind: 'checklist', color: 'sage',
    pinned: true, archived: true, trashed: false, createdAt: 1_420_070_400_123, updatedAt: 1_520_070_456_789,
    items: [
      { id: `${id}/item-0`, noteId: id, text: 'Passport', checked: true, rank: 1024 },
      { id: `${id}/item-1`, noteId: id, text: 'Charger', checked: false, rank: 2048 },
    ],
    images: [{ id: `${id}/image-0`, noteId: id, hash: 'b'.repeat(64), name: '旅行 photo.png', type: 'image/png', size: 1234 }],
    labels: ['Travel', '日本'],
    takeout: { sourcePath: 'Takeout/Keep/旅行.json', rawHash: 'c'.repeat(64), labels: ['Travel', '日本'] },
  };
}
function options(notes = [imported()], replaceSourceIds: string[] = []): ImportOptions {
  return { id: 'takeout-operation', manifestHash, notes, replaceSourceIds };
}
function replica(source: Vault) {
  const result = new Vault();
  Y.applyUpdate(result.doc, Y.encodeStateAsUpdate(source.doc), 'remote');
  return result;
}
function sync(a: Vault, b: Vault) {
  const fromA = Y.encodeStateAsUpdate(a.doc), fromB = Y.encodeStateAsUpdate(b.doc);
  Y.applyUpdate(a.doc, fromB, 'remote'); Y.applyUpdate(b.doc, fromA, 'remote');
  assert.deepEqual(a.getNotes(), b.getNotes());
}

test('bulk import preserves original content, IDs, timestamps, flags, labels and provenance after reload', t => {
  const vault = new Vault(); t.after(() => vault.destroy());
  const note = imported();
  const result = applyImport(vault, options([note]));
  assert.deepEqual(result, { status: 'applied', added: 1, removed: 0 });
  // Plain objects handed to Yjs must not share mutable arrays with caller input.
  note.takeout!.labels.push('Caller mutation'); note.labels!.push('Caller mutation'); note.images[0].name = 'Changed outside Yjs';
  const loaded = replica(vault); t.after(() => loaded.destroy());
  const actual = loaded.getNote(note.id)!;
  for (const field of ['id', 'title', 'body', 'kind', 'color', 'pinned', 'archived', 'trashed', 'createdAt', 'updatedAt'] as const) {
    assert.equal(actual[field], note[field], field);
  }
  assert.deepEqual(actual.items, imported().items);
  assert.deepEqual(actual.images, imported().images);
  assert.deepEqual(loaded.notes.get(note.id)!.get('labels'), imported().labels);
  assert.deepEqual(loaded.notes.get(note.id)!.get('takeout'), imported().takeout);
  assert.deepEqual(actual.sourceIds, [note.id]);
});

test('the receipt and all normalized records arrive in one update without fabricated history or undo entries', t => {
  const vault = new Vault(), receiver = new Vault();
  t.after(() => { vault.destroy(); receiver.destroy(); });
  const updates: Uint8Array[] = [];
  vault.doc.on('update', update => updates.push(update));
  applyImport(vault, options([imported('first'), imported('second')]));
  assert.equal(updates.length, 1);
  Y.applyUpdate(receiver.doc, updates[0], 'remote');
  assert.equal(receiver.notes.size, 2); assert.equal(receiver.items.size, 4); assert.equal(receiver.attachments.size, 2);
  assert.deepEqual(receiver.doc.getMap('imports').get('takeout-operation'), { manifestHash, added: 2, removed: 0 });
  assertNoReplicatedHistory(vault.doc); assertNoReplicatedHistory(receiver.doc);
  assert.equal(vault.undoManager.undoStack.length, 0);
  const before = receiver.getNote('first')!;
  receiver.setNoteText('first', 'body', 'First Stow edit'); receiver.finishEdit();
  assert.equal(receiver.getNote('first')!.body, 'First Stow edit');
  assert.equal(receiver.getNote('first')!.createdAt, before.createdAt);
  assertNoReplicatedHistory(receiver.doc);
});

test('retry after reload is a no-op and preserves edits and new notes made after the import', t => {
  const first = new Vault(); t.after(() => first.destroy());
  const oldId = first.createNote('text', { title: 'Discard' });
  const input = options([imported()], [oldId]);
  applyImport(first, input);
  const vault = replica(first); t.after(() => vault.destroy());
  vault.setNoteText('takeout-note', 'title', 'Edited in Stow');
  const newId = vault.createNote('text', { title: 'Created later' });
  const before = Y.encodeStateAsUpdate(vault.doc);
  const result = applyImport(vault, input);
  assert.deepEqual(result, { status: 'already-applied', added: 1, removed: 1 });
  assert.deepEqual(Y.encodeStateAsUpdate(vault.doc), before);
  assert.equal(vault.getNote('takeout-note')!.title, 'Edited in Stow');
  assert.equal(vault.getNote(newId)!.title, 'Created later');
});

test('an operation ID cannot be reused for a different manifest', t => {
  const vault = new Vault(); t.after(() => vault.destroy());
  applyImport(vault, options());
  const before = Y.encodeStateAsUpdate(vault.doc);
  assert.throws(() => applyImport(vault, { ...options([imported('different')]), manifestHash: 'd'.repeat(64) }), /different manifest/);
  assert.deepEqual(Y.encodeStateAsUpdate(vault.doc), before);
});

test('replacement rejects partial connected notes and replaces a whole note while retaining other notes', t => {
  const vault = new Vault(); t.after(() => vault.destroy());
  const removed = vault.createNote('checklist', { title: 'Discard' });
  const item = vault.addItem(removed, 'Old item');
  vault.addAttachment({ id: 'old-image', noteId: removed, hash: 'e'.repeat(64), type: 'image/png', name: 'old.png', size: 1 });
  const retained = vault.createNote('text', { title: 'Keep' }), other = vault.createNote('text', { title: 'Keep too' });
  const untouched = vault.createNote('text', { title: 'Unrelated note' }), untouchedNote = vault.getNote(untouched);
  vault.mergeNotes([removed, retained]); vault.mergeNotes([retained, other]);
  assertNoReplicatedHistory(vault.doc);
  const before = Y.encodeStateAsUpdate(vault.doc);
  assert.throws(() => applyImport(vault, options([imported()], [removed])), /whole connected note.*regenerate/);
  assert.deepEqual(Y.encodeStateAsUpdate(vault.doc), before);
  applyImport(vault, options([imported()], [removed, retained, other]));
  assert.equal(vault.notes.has(removed), false); assert.equal(vault.items.has(item), false); assert.equal(vault.attachments.has('old-image'), false);
  assert.equal(vault.merges.size, 0); assert.equal(vault.mergeRecipes.size, 0);
  assert.equal(vault.getNote(retained), undefined); assert.equal(vault.getNote(other), undefined);
  assert.deepEqual(vault.getNote(untouched), untouchedNote);
  assertNoReplicatedHistory(vault.doc);
});

test('stale offline edits, added items, merge edges and undo cannot resurrect discarded sources', t => {
  const live = new Vault(); t.after(() => live.destroy());
  const discarded = live.createNote('checklist', { title: 'Discard' });
  const item = live.addItem(discarded, 'Old item');
  const retained = live.createNote('text', { title: 'Keep' });
  const offline = replica(live); t.after(() => offline.destroy());
  offline.setNoteText(discarded, 'title', 'Edited offline'); offline.toggleItem(item);
  offline.addItem(discarded, 'Added while offline'); offline.mergeNotes([discarded, retained]);
  applyImport(live, options([imported()], [discarded]));
  sync(live, offline);
  assert.equal(live.getNote(discarded), undefined);
  assert.deepEqual(live.getNote(retained)!.sourceIds, [retained]);
  for (let step = 0; step < 4; step++) {
    offline.undo(); sync(live, offline);
    assert.equal(live.notes.has(discarded), false);
    assert.equal(live.getNote(discarded), undefined);
  }
  const loaded = replica(live); t.after(() => loaded.destroy());
  assert.equal(loaded.getNote(discarded), undefined);
  assert.equal(loaded.getNote('takeout-note')!.title, imported().title);
});

test('existing IDs may be reused only when their source is explicitly replaced', t => {
  const vault = new Vault(); t.after(() => vault.destroy());
  applyImport(vault, options());
  const replacement = imported(); replacement.title = 'Explicit replacement';
  const replace = { ...options([replacement], [replacement.id]), id: 'second-operation' };
  assert.deepEqual(applyImport(vault, replace), { status: 'applied', added: 1, removed: 1 });
  assert.equal(vault.getNote(replacement.id)!.title, replacement.title);
  assert.equal(vault.items.size, 2); assert.equal(vault.attachments.size, 1);
});

test('validation and collisions fail before any deletion or insertion', t => {
  const vault = new Vault(); t.after(() => vault.destroy());
  const selected = vault.createNote('text', { title: 'Must survive failed import' });
  const protectedId = vault.createNote('checklist', { title: 'Unselected note' });
  const protectedItem = vault.addItem(protectedId, 'Unselected item');
  vault.addAttachment({ id: 'protected-image', noteId: protectedId, hash: 'f'.repeat(64), name: 'protected.png', type: 'image/png', size: 1 });
  const failures: ((input: ImportOptions) => void)[] = [
    input => { input.notes[0].id = protectedId; },
    input => { input.notes[0].items[0].id = protectedItem; },
    input => { input.notes[0].images[0].id = 'protected-image'; },
    input => { input.notes.push(imported()); },
    input => { input.notes[0].items[1].id = input.notes[0].items[0].id; },
    input => { input.notes[0].images.push({ ...input.notes[0].images[0] }); },
    input => { input.notes[0].items[0].noteId = 'wrong-source'; },
    input => { input.notes[0].images[0].noteId = 'wrong-source'; },
    input => { input.notes[0].images[0].hash = 'invalid'; },
    input => { input.notes[0].items[0].rank = Number.NaN; },
    input => { input.notes[0].updatedAt = Infinity; },
    input => { input.notes[0].body = 'Malformed \ud800'; },
    input => { input.notes[0].takeout!.rawHash = 'invalid'; },
    input => { input.replaceSourceIds.push(selected); },
    input => { input.replaceSourceIds.push('unknown-source'); },
  ];
  for (const corrupt of failures) {
    const input = options([imported()], [selected]); corrupt(input);
    const before = Y.encodeStateAsUpdate(vault.doc);
    assert.throws(() => applyImport(vault, input), /Invalid import:/);
    assert.deepEqual(Y.encodeStateAsUpdate(vault.doc), before);
    assert.equal(vault.doc.getMap('imports').size, 0);
    assert.equal(vault.getNote(selected)!.title, 'Must survive failed import');
  }
});
