import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import * as Y from 'yjs';
import { Vault } from '../src/core/vault';
import { observeBoundaries, latestBoundary, assertNoReplicatedHistory } from './history-state-fixture';

function vaultFor(t: TestContext) {
  const vault = new Vault(); observeBoundaries(vault); t.after(() => vault.destroy()); return vault;
}

test('Undo and Redo describe the entire typing group and separate title, note and item targets', t => {
  const vault = vaultFor(t), id = vault.createNote('checklist');
  vault.setNoteText(id, 'title', 'T'); vault.setNoteText(id, 'title', 'Trip');
  vault.setNoteText(id, 'body', 'B'); vault.setNoteText(id, 'body', 'Book flights');
  assert.equal(vault.undo(), 'Note: added “Book flights”');
  assert.equal(vault.getNote(id)!.title, 'Trip');
  assert.equal(vault.getNote(id)!.body, '');
  assert.equal(vault.undo(), 'Title: added “Trip”');
  assert.equal(vault.redo(), 'Title: added “Trip”');
  assert.equal(vault.redo(), 'Note: added “Book flights”');
  const item = vault.addItem(id, '');
  vault.setItemText(item, 'P'); vault.setItemText(item, 'Passport');
  assert.equal(vault.undo(), 'Item: added “Passport”');
  assert.equal(vault.redo(), 'Item: added “Passport”');
  assert.equal(vault.getItems(id)[0].text, 'Passport');
});

test('deletion and replacement have separate Undo steps with their actual original text', t => {
  const vault = vaultFor(t), id = vault.createNote('text', { body: 'green' });
  vault.setNoteText(id, 'body', 'gree'); vault.setNoteText(id, 'body', 'gre');
  assert.equal(vault.undo(), 'Note: deleted “en”');
  assert.equal(vault.getNote(id)!.body, 'green');
  vault.setNoteText(id, 'body', 'g'); vault.setNoteText(id, 'body', 'blue');
  assert.equal(vault.undo(), 'Note: replaced “g” with “blue”');
  assert.equal(vault.getNote(id)!.body, 'g');
  assert.equal(vault.undo(), 'Note: deleted “reen”');
  assert.equal(vault.getNote(id)!.body, 'green');
  assert.equal(vault.redo(), 'Note: deleted “reen”');
  assert.equal(vault.redo(), 'Note: replaced “g” with “blue”');
  assert.equal(vault.getNote(id)!.body, 'blue');
  vault.setNoteText(id, 'body', 'Cobalt');
  vault.undoManager.stopCapturing();
  vault.setNoteText(id, 'body', 'C'); vault.setNoteText(id, 'body', 'Copper');
  assert.equal(vault.undo(), 'Note: added “opper”');
  assert.equal(vault.getNote(id)!.body, 'C');
  assert.equal(vault.undo(), 'Note: deleted “obalt”');
  assert.equal(vault.getNote(id)!.body, 'Cobalt');
  assert.equal(vault.redo(), 'Note: deleted “obalt”');
  assert.equal(vault.redo(), 'Note: added “opper”');
});

test('an invalid undo description fails before changing the document', t => {
  const vault = vaultFor(t), id = vault.createNote('text', { body: 'Before' });
  vault.setNoteText(id, 'body', 'After'); vault.finishEdit();
  vault.undoManager.undoStack.at(-1)!.meta.delete('stow-action-description');
  const before = Y.encodeStateAsUpdate(vault.doc);
  assert.throws(() => vault.undo(), /missing its action description/);
  assert.deepEqual(Y.encodeStateAsUpdate(vault.doc), before);
});

test('typing metadata keeps only its changed span rather than a long unchanged note body', t => {
  const vault = vaultFor(t), unchanged = 'q'.repeat(20_000);
  const id = vault.createNote('text', { body: unchanged });
  vault.setNoteText(id, 'body', `${unchanged}a`);
  vault.setNoteText(id, 'body', `${unchanged}added`);
  const metadata = JSON.stringify([...vault.undoManager.undoStack.at(-1)!.meta]);
  assert(metadata.length < 1000);
  assert(!metadata.includes('q'.repeat(100)));
  assert.equal(vault.undo(), 'Note: added “added”');
  assert.equal(vault.getNote(id)!.body, unchanged);
});

test('completed boundaries describe text deltas and metadata names while Undo returns the same original action', t => {
  const vault = vaultFor(t), id = vault.createNote('text', { title: 'Packing', body: 'Old text' });
  vault.setNoteText(id, 'body', 'New text'); vault.finishEdit();
  assert.equal(latestBoundary(vault).description, 'Note: replaced “Old” with “New”');
  vault.setNoteMeta(id, { pinned: true });
  assert.equal(latestBoundary(vault).description, 'Note: pinned “Packing”');
  assert.equal(vault.undo(), 'Note: pinned “Packing”');
  assert.equal(latestBoundary(vault).description, 'Undid: Note: pinned “Packing”');
  vault.setNoteMeta(id, { archived: true });
  assert.equal(vault.undo(), 'Note: archived “Packing”');
  vault.setNoteMeta(id, { trashed: true });
  assert.equal(vault.undo(), 'Note: moved to trash “Packing”');
});

test('global label changes share one setting update and emit a small descriptive boundary without note content', t => {
  const vault = vaultFor(t), id = vault.createNote('text', { title: 'Packing', body: 'Before' });
  vault.setNoteLabel(id, 'Travel', true);
  const before = vault.getNote(id)!, events = observeBoundaries(vault), count = events.length, updates: Uint8Array[] = [];
  vault.doc.on('update', update => updates.push(update));
  vault.setLabelColor('Travel', 'mint');
  assert.equal(updates.length, 1); assert.equal(vault.getNote(id), before);
  assert.equal(events.length, count + 1); assert.equal(events.at(-1)!.description, 'Label: colored “Travel” mint');
  assert.deepEqual(events.at(-1)!.sourceIds, [id]); assert(!JSON.stringify(events.at(-1)).includes('Before'));
  assertNoReplicatedHistory(vault.doc);
});

test('one global label boundary can cover many large notes without retaining their text or rewriting timestamps', t => {
  const vault = vaultFor(t), ids: string[] = [];
  vault.doc.transact(() => {
    for (let index = 0; index < 100; index++) {
      const id = `source-${index}`; ids.push(id);
      vault.notes.set(id, new Y.Map<any>([
        ['title', new Y.Text(`Note ${index}`)], ['body', new Y.Text('large body '.repeat(1000))],
        ['kind', 'text'], ['color', 'default'], ['createdAt', 100], ['updatedAt', 200], ['labels', ['Shared']],
      ]));
    }
  }, 'import');
  const snapshots = vault.getNotes(), events = observeBoundaries(vault);
  vault.setLabelColor('Shared', 'sage');
  assert.equal(events.length, 1); assert.deepEqual(new Set(events[0].sourceIds), new Set(ids));
  const serialized = JSON.stringify(events[0]); assert(serialized.length < 5000); assert(!serialized.includes('large body'));
  assert.deepEqual(vault.getNotes(), snapshots); assertNoReplicatedHistory(vault.doc);
});

test('label color and deletion Undo/Redo report their setting actions and preserve restored membership', t => {
  const vault = vaultFor(t), id = vault.createNote('text', { title: 'Packing' });
  vault.setNoteLabel(id, 'shrek', true); vault.setLabelColor('shrek', 'mint');
  const colorUndo = vault.undo(); assert.match(colorUndo!, /shrek.*mint/);
  assert.equal(vault.getLabels().find(label => label.name === 'shrek')!.color, 'default');
  assert.equal(vault.redo(), colorUndo); assert.equal(vault.getLabels().find(label => label.name === 'shrek')!.color, 'mint');
  vault.deleteLabel('shrek'); assert.equal(latestBoundary(vault).description, 'Label: deleted “shrek”');
  assert.equal(vault.undo(), 'Label: deleted “shrek”'); assert.deepEqual(vault.getNote(id)!.labels, ['shrek']);
  assertNoReplicatedHistory(vault.doc);
});
