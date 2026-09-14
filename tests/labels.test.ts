import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import * as Y from 'yjs';
import { applyImport } from '../src/core/import';
import { Vault } from '../src/core/vault';
import { CurrentNoteSearch } from '../src/currentSearch';
import { snapshotNote, observeBoundaries, latestBoundary, assertNoReplicatedHistory } from './history-state-fixture';
import { effectiveLabels } from '../src/core/labels';

function vaultFor(t: TestContext, source?: Vault) {
  const vault = new Vault(); observeBoundaries(vault);
  if (source) Y.applyUpdate(vault.doc, Y.encodeStateAsUpdate(source.doc), 'remote');
  t.after(() => vault.destroy());
  return vault;
}

function imported(vault: Vault, id: string, labels: string[], state: { archived?: boolean; trashed?: boolean } = {}) {
  applyImport(vault, {
    id: `import-${id}`, manifestHash: 'a'.repeat(64), replaceSourceIds: [],
    notes: [{ id, title: id, body: 'Apartment #C3', kind: 'text', color: 'sage',
      pinned: false, archived: false, trashed: false, createdAt: 100, updatedAt: 200,
      items: [], images: [], labels, ...state }],
  });
  return id;
}

function sync(a: Vault, b: Vault) {
  const fromA = Y.encodeStateAsUpdate(a.doc), fromB = Y.encodeStateAsUpdate(b.doc);
  Y.applyUpdate(a.doc, fromB, 'remote'); Y.applyUpdate(b.doc, fromA, 'remote');
  Y.applyUpdate(b.doc, fromA, 'remote');
  assert.deepEqual(a.getNotes(), b.getNotes());
  assert.deepEqual(a.getLabels(), b.getLabels());
}

function assertOnlyLabelEventsAdded(vault: Vault, previous: number, count: number) {
  const added = observeBoundaries(vault).slice(previous);
  assert.equal(added.length, count);
  assert(added.every(event => event.description?.includes('Label:')));
  assertNoReplicatedHistory(vault.doc);
  return added;
}

test('opening imported labels preserves their order and does not write or create history', t => {
  const original = vaultFor(t);
  imported(original, 'legacy', ['Shared', 'Travel', 'Audio']);
  const bytes = Y.encodeStateAsUpdate(original.doc), doc = new Y.Doc();
  Y.applyUpdate(doc, bytes, 'remote');
  let updates = 0;
  doc.on('update', () => updates++);
  const loaded = new Vault(doc); t.after(() => loaded.destroy());
  assert.deepEqual(loaded.getNote('legacy')!.labels, ['Shared', 'Travel', 'Audio']);
  assert.deepEqual(loaded.getLabels(), [
    { name: 'Audio', color: 'default' }, { name: 'Shared', color: 'default' }, { name: 'Travel', color: 'default' },
  ]);
  assert.equal(updates, 0);
  assert.deepEqual(Y.encodeStateAsUpdate(doc), bytes);
  assertNoReplicatedHistory(loaded.doc);
  assert.equal(loaded.undoManager.undoStack.length, 0);
});

test('text and item edits reuse the label catalog without scanning unrelated notes', t => {
  const vault = vaultFor(t), id = imported(vault, 'catalog-note', ['Travel']);
  const item = vault.addItem(id, 'A checklist row');
  const labels = vault.getLabels(), values = t.mock.method(vault.notes, 'values');
  for (let i = 0; i < 5; i++) {
    vault.setNoteText(id, 'body', `Body input ${i}`);
    assert.equal(vault.getLabels(), labels);
    vault.setItemText(item, `Item input ${i}`); vault.finishEdit();
    assert.equal(vault.getLabels(), labels);
  }
  assert.equal(values.mock.callCount(), 0, 'input must not enumerate the full note map for labels');
});

test('cached labels follow remote membership, import replacement, color, and permanent disposal', t => {
  const vault = vaultFor(t), id = imported(vault, 'catalog-note', ['Travel']);
  assert.deepEqual(vault.getLabels(), [{ name: 'Travel', color: 'default' }]);
  const peer = vaultFor(t, vault);
  peer.setNoteLabel(id, 'Remote', true);
  Y.applyUpdate(vault.doc, Y.encodeStateAsUpdate(peer.doc), 'remote');
  assert.deepEqual(vault.getLabels().map(label => label.name), ['Remote', 'Travel']);
  vault.doc.transact(() => vault.notes.get(id)!.set('labels', ['Replacement']), 'remote');
  assert.deepEqual(vault.getLabels().map(label => label.name), ['Remote', 'Replacement']);
  vault.setLabelColor('Remote', 'sage');
  assert.deepEqual(vault.getLabels(), [{ name: 'Remote', color: 'sage' }, { name: 'Replacement', color: 'default' }]);
  vault.setNoteMeta(id, { trashed: true });
  vault.deleteNotesForever([id]);
  assert.deepEqual(vault.getLabels(), [{ name: 'Remote', color: 'sage' }]);
});

test('explicit label edits preserve baseline metadata, exact spelling and ordinary hashtag text', t => {
  const vault = vaultFor(t), id = imported(vault, 'legacy', ['Travel', ' spaced ', 'travel']);
  vault.setNoteLabel(id, ' spaced ', false);
  vault.setNoteLabel(id, 'Travel', false);
  vault.setNoteLabel(id, 'Zoo', true);
  vault.setNoteLabel(id, 'Audio', true);
  assert.deepEqual(vault.getNote(id)!.labels, ['travel', 'Audio', 'Zoo']);
  assert.deepEqual(vault.notes.get(id)!.get('labels'), ['Travel', ' spaced ', 'travel']);
  assert.equal(vault.getNote(id)!.body, 'Apartment #C3');
  assert(!vault.getLabels().some(label => label.name === 'C3'));
  vault.setNoteLabel(id, 'Travel', true);
  assert.deepEqual(vault.getNote(id)!.labels, ['Travel', 'travel', 'Audio', 'Zoo']);
  assert.equal(latestBoundary(vault).action?.field, 'labels');
});

test('independent first label edits on offline replicas survive and converge', t => {
  const a = vaultFor(t), id = imported(a, 'legacy', ['Imported']);
  const b = vaultFor(t, a);
  a.setNoteLabel(id, 'Zoo', true);
  b.setNoteLabel(id, 'Audio', true);
  sync(a, b);
  assert.deepEqual(a.getNote(id)!.labels, ['Imported', 'Audio', 'Zoo']);
  const loaded = vaultFor(t, a);
  assert.deepEqual(loaded.getNote(id)!.labels, ['Imported', 'Audio', 'Zoo']);
});

test('removing an imported label does not erase a concurrent added label', t => {
  const a = vaultFor(t), id = imported(a, 'legacy', ['Travel', 'Shared']);
  const b = vaultFor(t, a);
  a.setNoteLabel(id, 'Travel', false);
  b.setNoteLabel(id, 'Audio', true);
  sync(a, b);
  assert.deepEqual(a.getNote(id)!.labels, ['Shared', 'Audio']);
});

test('concurrent opposite changes of the same label have one convergent membership', t => {
  const a = vaultFor(t), id = imported(a, 'legacy', ['Travel']);
  const b = vaultFor(t, a);
  a.setNoteLabel(id, 'Travel', false);
  a.setNoteLabel(id, 'Travel', true);
  b.setNoteLabel(id, 'Travel', false);
  sync(a, b);
  const loaded = vaultFor(t, a);
  assert.deepEqual(loaded.getNote(id)!.labels, a.getNote(id)!.labels);
  assert.deepEqual(loaded.getNote(id)!.labels ?? [], a.notes.get(id)!.get('label:Travel') ? ['Travel'] : []);
});

test('label undo and redo preserve unrelated labels added on another device', t => {
  const a = vaultFor(t), id = imported(a, 'legacy', ['Travel']);
  const b = vaultFor(t, a);
  a.setNoteLabel(id, 'Travel', false);
  b.setNoteLabel(id, 'Audio', true);
  sync(a, b);
  a.undo();
  assert.deepEqual(a.getNote(id)!.labels, ['Travel', 'Audio']);
  sync(a, b);
  a.redo();
  assert.deepEqual(a.getNote(id)!.labels, ['Audio']);
  sync(a, b);
  a.setNoteLabel(id, 'Personal', true);
  a.undo();
  assert.deepEqual(a.getNote(id)!.labels, ['Audio']);
});

test('label history survives reload and restores editable labels on a separate copy', t => {
  const vault = vaultFor(t), id = imported(vault, 'legacy', ['Travel']);
  vault.setNoteLabel(id, 'Audio', true);
  const saved = vault.captureHistoryState([id]);
  vault.setNoteLabel(id, 'Travel', false);
  const loaded = vaultFor(t, vault);
  assert.deepEqual(snapshotNote(saved)!.labels, ['Travel', 'Audio']);
  const copy = loaded.restoreHistoryState(saved);
  assert.notEqual(copy, id);
  assert.deepEqual(loaded.getNote(copy)!.labels, ['Travel', 'Audio']);
  assert.deepEqual(loaded.getNote(id)!.labels, ['Audio']);
  loaded.setNoteLabel(copy, 'Audio', false);
  assert.deepEqual(loaded.getNote(copy)!.labels, ['Travel']);
  assert.deepEqual(loaded.getNote(id)!.labels, ['Audio']);
});

test('merged label edits reach every source and retain late offline changes through separation', t => {
  const desktop = vaultFor(t);
  const first = imported(desktop, 'first', ['First', 'Shared']);
  const second = imported(desktop, 'second', ['Second', 'Shared']);
  const phone = vaultFor(t, desktop);
  const merged = desktop.mergeNotes([first, second]);
  phone.setNoteLabel(first, 'First', false);
  phone.setNoteLabel(second, 'Late', true);
  sync(desktop, phone);
  desktop.setNoteLabel(merged, 'Group', true);
  desktop.setNoteLabel(merged, 'Shared', false);
  for (const sourceId of desktop.getNote(merged)!.sourceIds) {
    const labels = effectiveLabels(desktop.notes.get(sourceId)!, desktop.labelLifecycle);
    assert(labels.includes('Group'));
    assert(!labels.includes('Shared'));
  }
  // An older client may still remove the original merge edges.
  desktop.doc.transact(() => desktop.merges.clear(), 'remote');
  assert.deepEqual(desktop.getNote(first)!.labels, ['Group']);
  assert.deepEqual(desktop.getNote(second)!.labels, ['Second', 'Group', 'Late']);
  sync(desktop, phone);
});

test('label color is an undoable synced setting event without note edits', t => {
  const a = vaultFor(t), id = imported(a, 'legacy', ['Travel']);
  const b = vaultFor(t, a), before = a.getNote(id)!;
  const notes = a.getNotes(), history = observeBoundaries(a).length;
  a.setLabelColor('Travel', 'coral');
  assert.deepEqual(a.getLabels(), [{ name: 'Travel', color: 'coral' }]);
  assert.equal(a.getNotes(), notes);
  assert.equal(a.getNote(id), before);
  assert.equal(a.getNote(id)!.color, 'sage');
  assert.equal(a.getNote(id)!.updatedAt, 200);
  assertOnlyLabelEventsAdded(a, history, 1);
  sync(a, b);
  a.undo();
  assert.deepEqual(a.getLabels(), [{ name: 'Travel', color: 'default' }]);
  sync(a, b);
  a.redo();
  assert.deepEqual(a.getLabels(), [{ name: 'Travel', color: 'coral' }]);
  sync(a, b);
  assertOnlyLabelEventsAdded(a, history, 3);
  assert.equal(a.getNote(id), before);
});

test('independent offline label colors survive and undo leaves remote colors alone', t => {
  const a = vaultFor(t), id = imported(a, 'legacy', ['Travel', 'Audio']);
  const b = vaultFor(t, a);
  a.setLabelColor('Travel', 'mint');
  b.setLabelColor('Audio', 'dusk');
  sync(a, b);
  assert.deepEqual(a.getLabels(), [{ name: 'Audio', color: 'dusk' }, { name: 'Travel', color: 'mint' }]);
  a.undo();
  sync(a, b);
  assert.deepEqual(a.getLabels(), [{ name: 'Audio', color: 'dusk' }, { name: 'Travel', color: 'default' }]);
  assert.equal(a.getNote(id)!.updatedAt, 200);
});

test('catalog covers archived and trashed notes, retains color choices, and caches unchanged reads', t => {
  const vault = vaultFor(t);
  imported(vault, 'active', ['Live']);
  imported(vault, 'archive', ['Archive'], { archived: true });
  imported(vault, 'trash', ['Trash'], { trashed: true });
  const first = vault.getLabels();
  assert.deepEqual(first.map(label => label.name), ['Archive', 'Live', 'Trash']);
  assert.equal(vault.getLabels(), first);
  vault.setLabelColor('Live', 'peach');
  const colored = vault.getLabels();
  assert.notEqual(colored, first);
  assert.equal(vault.getLabels(), colored);
  vault.setNoteLabel('active', 'Live', false);
  assert(vault.getLabels().some(label => label.name === 'Live' && label.color === 'peach'));
  vault.setNoteLabel('active', 'New', true);
  assert(vault.getLabels().some(label => label.name === 'New'));
  vault.setLabelColor('Live', 'default');
  assert(vault.getLabels().some(label => label.name === 'Live' && label.color === 'default'));
});

test('unchanged catalog references survive note edits, reordering and membership changes', t => {
  const vault = vaultFor(t), id = imported(vault, 'legacy', ['Travel']);
  const first = vault.addItem(id, 'First'), second = vault.addItem(id, 'Second');
  const catalog = vault.getLabels();
  vault.setNoteText(id, 'body', 'Edited ordinary prose');
  assert.equal(vault.getLabels(), catalog);
  vault.moveItemRelative(second, first, 'before');
  assert.equal(vault.getNote(id)!.items[0].id, second);
  assert.equal(vault.getLabels(), catalog);
  vault.setNoteLabel(id, 'Travel', false);
  assert.equal(vault.getLabels(), catalog);
  vault.setNoteLabel(id, 'Travel', true);
  assert.equal(vault.getLabels(), catalog);
  vault.setNoteLabel(id, 'Audio', true);
  const added = vault.getLabels();
  assert.notEqual(added, catalog);
  assert.deepEqual(added.map(label => label.name), ['Audio', 'Travel']);
  vault.setLabelColor('Audio', 'coral');
  const colored = vault.getLabels();
  assert.notEqual(colored, added);
  assert.deepEqual(colored[0], { name: 'Audio', color: 'coral' });
  assert.equal(vault.getLabels(), colored);
});

test('an uncolored label stays in the catalog after its last note is detached and reloaded', t => {
  const vault = vaultFor(t), id = vault.createNote();
  vault.setNoteLabel(id, 'Errands', true);
  vault.setNoteLabel(id, 'Errands', false);
  assert.equal(vault.getNote(id)!.labels, undefined);
  assert.deepEqual(vault.getLabels(), [{ name: 'Errands', color: 'default' }]);
  const loaded = vaultFor(t, vault);
  assert.deepEqual(loaded.getLabels(), [{ name: 'Errands', color: 'default' }]);
  assert.equal(loaded.getNote(id)!.labels, undefined);
  vault.undo();
  assert.deepEqual(vault.getNote(id)!.labels, ['Errands']);
  vault.undo();
  assert.equal(vault.getNote(id)!.labels, undefined);
  assert.deepEqual(vault.getLabels(), []);
  vault.redo();
  assert.deepEqual(vault.getLabels(), [{ name: 'Errands', color: 'default' }]);
  vault.redo();
  assert.equal(vault.getNote(id)!.labels, undefined);
  assert.deepEqual(vault.getLabels(), [{ name: 'Errands', color: 'default' }]);
});

test('detaching the last imported label preserves its catalog entry without a startup write', t => {
  const vault = vaultFor(t), id = imported(vault, 'legacy', ['Travel']);
  const before = Y.encodeStateAsUpdate(vault.doc);
  assert.deepEqual(vault.getLabels(), [{ name: 'Travel', color: 'default' }]);
  assert.deepEqual(Y.encodeStateAsUpdate(vault.doc), before);
  vault.setNoteLabel(id, 'Travel', false);
  assert.equal(vault.getNote(id)!.labels, undefined);
  assert.deepEqual(vault.getLabels(), [{ name: 'Travel', color: 'default' }]);
  const loaded = vaultFor(t, vault);
  assert.deepEqual(loaded.getLabels(), [{ name: 'Travel', color: 'default' }]);
  vault.undo();
  assert.deepEqual(vault.getNote(id)!.labels, ['Travel']);
  assert.deepEqual(vault.getLabels(), [{ name: 'Travel', color: 'default' }]);
});

test('choosing default color explicitly creates an undoable uncolored catalog entry', t => {
  const vault = vaultFor(t);
  vault.setLabelColor('Unused', 'default');
  assert.deepEqual(vault.getLabels(), [{ name: 'Unused', color: 'default' }]);
  assert.deepEqual(vault.getNotes(), []);
  assertOnlyLabelEventsAdded(vault, 0, 0);
  const loaded = vaultFor(t, vault);
  assert.deepEqual(loaded.getLabels(), [{ name: 'Unused', color: 'default' }]);
  vault.undo();
  assert.deepEqual(vault.getLabels(), []);
  vault.redo();
  assert.deepEqual(vault.getLabels(), [{ name: 'Unused', color: 'default' }]);
});

test('attaching or detaching a label never overwrites its concurrently chosen color', t => {
  for (const present of [true, false]) {
    const original = vaultFor(t), id = imported(original, `legacy-${present}`, present ? [] : ['Travel']);
    const replica = vaultFor(t, original);
    // A default color written by the assigning device would win a concurrent
    // same-key write with the smaller client ID and erase the explicit color.
    const assigning = original.doc.clientID > replica.doc.clientID ? original : replica;
    const coloring = assigning === original ? replica : original;
    assigning.setNoteLabel(id, 'Travel', present);
    coloring.setLabelColor('Travel', 'coral');
    sync(assigning, coloring);
    assert.equal(assigning.getNote(id)!.labels?.includes('Travel') ?? false, present);
    assert.deepEqual(assigning.getLabels(), [{ name: 'Travel', color: 'coral' }]);
    assigning.undo();
    sync(assigning, coloring);
    assert.deepEqual(assigning.getLabels(), [{ name: 'Travel', color: 'coral' }]);
    assert.equal(assigning.getNote(id)!.labels?.includes('Travel') ?? false, !present);
  }
});

test('labels and their color preferences stay confined to their owning document', t => {
  const a = vaultFor(t), b = vaultFor(t);
  const first = a.createNote(), second = b.createNote();
  a.setNoteLabel(first, 'Personal', true);
  a.setLabelColor('Personal', 'coral');
  assert.deepEqual(b.getLabels(), []);
  assert.equal(b.getNote(second)!.labels, undefined);
  const reloaded = vaultFor(t, a);
  assert.deepEqual(reloaded.getLabels(), [{ name: 'Personal', color: 'coral' }]);
  assert.deepEqual(b.getLabels(), []);
});

test('current search removes detached label text and indexes explicitly attached labels', async t => {
  const vault = vaultFor(t), id = imported(vault, 'legacy', ['Travel']);
  const index = new CurrentNoteSearch();
  await index.update(vault.getNotes());
  assert.equal(index.matches(id, 'travel'), true);
  vault.setNoteLabel(id, 'Travel', false);
  vault.setNoteLabel(id, 'Audio', true);
  await index.update(vault.getNotes());
  assert.equal(index.matches(id, 'travel'), false);
  assert.equal(index.matches(id, 'audio'), true);
  assert.equal(index.matches(id, 'apartment #c3'), true);
});

test('repeating a label choice or its color is a write-free no-op', t => {
  const vault = vaultFor(t), id = imported(vault, 'legacy', ['Travel']);
  vault.setLabelColor('Travel', 'coral');
  vault.setLabelColor('Uncolored', 'default');
  const before = Y.encodeStateAsUpdate(vault.doc);
  vault.setNoteLabel(id, 'Travel', true);
  vault.setNoteLabel(id, 'Unattached', false);
  vault.setLabelColor('Travel', 'coral');
  vault.setLabelColor('Uncolored', 'default');
  assert.deepEqual(Y.encodeStateAsUpdate(vault.doc), before);
});

test('global label deletion covers live, archived, trashed and merged sources in one undoable config change', t => {
  const vault = vaultFor(t);
  const live = imported(vault, 'live', ['Travel', 'Keep']);
  const mergedSource = imported(vault, 'merged', ['Travel']);
  imported(vault, 'archive', ['Travel'], { archived: true });
  imported(vault, 'trash', ['Travel'], { trashed: true });
  const untouched = imported(vault, 'unrelated', ['Keep']);
  const item = vault.addItem(live, 'Checked child');
  vault.toggleItem(item);
  vault.addAttachment({ id: 'image', noteId: live, hash: 'b'.repeat(64), name: 'image.png', type: 'image/png', size: 100 });
  vault.mergeNotes([live, mergedSource]);
  vault.setLabelColor('Travel', 'coral');
  const notes = vault.getNotes(), unrelated = vault.getNote(untouched), history = observeBoundaries(vault).length;
  const records = [...vault.notes].map(([id, note]) => [id, note.toJSON()]);
  const undoCount = vault.undoManager.undoStack.length;
  let updates = 0;
  vault.doc.on('update', () => updates++);
  vault.deleteLabel('Travel');
  assert.equal(updates, 1);
  assert.equal(vault.undoManager.undoStack.length, undoCount + 1);
  assert.deepEqual(vault.getLabels(), [{ name: 'Keep', color: 'default' }]);
  for (const note of vault.getNotes()) {
    assert(!note.labels?.includes('Travel'));
    for (const sourceId of note.sourceIds) assert(!effectiveLabels(vault.notes.get(sourceId)!, vault.labelLifecycle).includes('Travel'));
  }
  assert.equal(vault.getNote(untouched), unrelated);
  assert.deepEqual([...vault.notes].map(([id, note]) => [id, note.toJSON()]), records);
  assertOnlyLabelEventsAdded(vault, history, 1);
  vault.undo();
  assert.deepEqual(vault.getNotes(), notes);
  assert.deepEqual(vault.getLabels(), [{ name: 'Keep', color: 'default' }, { name: 'Travel', color: 'coral' }]);
  assertOnlyLabelEventsAdded(vault, history, 2);
  vault.redo();
  assert(!vault.getLabels().some(label => label.name === 'Travel'));
  assertOnlyLabelEventsAdded(vault, history, 3);
  const loaded = vaultFor(t, vault);
  assert.deepEqual(loaded.getNotes(), vault.getNotes());
  assert.deepEqual(loaded.getLabels(), vault.getLabels());
});

test('deleting an unattached label is undoable and repeated deletion or color clicks cannot recreate it', t => {
  const vault = vaultFor(t);
  vault.setLabelColor('Unused', 'mint');
  vault.deleteLabel('Unused');
  assert.deepEqual(vault.getLabels(), []);
  const bytes = Y.encodeStateAsUpdate(vault.doc);
  vault.deleteLabel('Unused');
  vault.deleteLabel('Never existed');
  vault.setLabelColor('Unused', 'coral');
  assert.deepEqual(Y.encodeStateAsUpdate(vault.doc), bytes);
  vault.undo();
  assert.deepEqual(vault.getLabels(), [{ name: 'Unused', color: 'mint' }]);
  assertOnlyLabelEventsAdded(vault, 0, 0);
});

test('global deletion removes label matches from current search without changing searchable prose', async t => {
  const vault = vaultFor(t), id = imported(vault, 'legacy', ['Travel']);
  const index = new CurrentNoteSearch();
  await index.update(vault.getNotes());
  assert.equal(index.matches(id, 'travel'), true);
  vault.deleteLabel('Travel');
  await index.update(vault.getNotes());
  assert.equal(index.matches(id, 'travel'), false);
  assert.equal(index.matches(id, 'apartment #c3'), true);
  vault.undo();
  await index.update(vault.getNotes());
  assert.equal(index.matches(id, 'travel'), true);
});

test('stale offline attachments, new notes and color updates cannot resurrect a globally deleted label', t => {
  const desktop = vaultFor(t), old = imported(desktop, 'old', ['Travel']);
  const target = imported(desktop, 'target', []), offline = vaultFor(t, desktop);
  desktop.deleteLabel('Travel');
  offline.setNoteLabel(target, 'Travel', true);
  offline.setLabelColor('Travel', 'coral');
  offline.setNoteText(old, 'body', 'An unrelated offline edit');
  const late = offline.createNote('text', { title: 'Created offline' });
  offline.setNoteLabel(late, 'Travel', true);
  sync(desktop, offline);
  assert.deepEqual(desktop.getLabels(), []);
  for (const id of [old, target, late]) assert.equal(desktop.getNote(id)!.labels, undefined);
  assert.equal(desktop.getNote(old)!.body, 'An unrelated offline edit');
  const loaded = vaultFor(t, desktop);
  assert.deepEqual(loaded.getLabels(), []);
  assert.equal(loaded.getNote(late)!.labels, undefined);
});

test('explicit recreation starts empty and isolates both original and later-generation stale updates', t => {
  for (const previouslyRecreated of [false, true]) {
    const desktop = vaultFor(t), old = imported(desktop, 'old', ['Travel']);
    const target = imported(desktop, 'target', []), another = imported(desktop, 'another', []);
    if (previouslyRecreated) {
      desktop.deleteLabel('Travel');
      desktop.setNoteLabel(old, 'Travel', true);
    }
    desktop.setLabelColor('Travel', 'peach');
    const offline = vaultFor(t, desktop);
    desktop.deleteLabel('Travel');
    desktop.setNoteLabel(target, 'Travel', true);
    assert.deepEqual(desktop.getLabels(), [{ name: 'Travel', color: 'default' }]);
    assert.equal(desktop.getNote(old)!.labels, undefined);
    assert.deepEqual(desktop.getNote(target)!.labels, ['Travel']);
    desktop.setLabelColor('Travel', 'mint');
    offline.setNoteLabel(target, 'Travel', true);
    offline.setNoteLabel(another, 'Travel', true);
    offline.setLabelColor('Travel', 'coral');
    sync(desktop, offline);
    assert.deepEqual(desktop.getLabels(), [{ name: 'Travel', color: 'mint' }]);
    assert.deepEqual(desktop.getNote(target)!.labels, ['Travel']);
    assert.equal(desktop.getNote(old)!.labels, undefined);
    assert.equal(desktop.getNote(another)!.labels, undefined);
    const loaded = vaultFor(t, desktop);
    assert.deepEqual(loaded.getLabels(), [{ name: 'Travel', color: 'mint' }]);
    assert.deepEqual(loaded.getNote(target)!.labels, ['Travel']);
  }
});

test('concurrent recreations of the same observed deletion retain both new attachments', t => {
  const a = vaultFor(t), original = imported(a, 'old', ['Travel']);
  const first = imported(a, 'first', []), second = imported(a, 'second', []);
  a.deleteLabel('Travel');
  const b = vaultFor(t, a);
  a.setNoteLabel(first, 'Travel', true);
  b.setNoteLabel(second, 'Travel', true);
  sync(a, b);
  assert.equal(a.getNote(original)!.labels, undefined);
  assert.deepEqual(a.getNote(first)!.labels, ['Travel']);
  assert.deepEqual(a.getNote(second)!.labels, ['Travel']);
  assert.deepEqual(a.getLabels(), [{ name: 'Travel', color: 'default' }]);
});

test('concurrent global deletion and recreation converge in both deterministic lifecycle conflict orders', t => {
  for (const recreationWins of [false, true]) {
    const recreating = vaultFor(t);
    recreating.doc.clientID = recreationWins ? 200 : 100;
    const original = imported(recreating, 'old', ['Travel']);
    const target = imported(recreating, 'new', []);
    const deleting = vaultFor(t, recreating);
    deleting.doc.clientID = recreationWins ? 100 : 200;
    recreating.deleteLabel('Travel');
    recreating.setNoteLabel(target, 'Travel', true);
    deleting.deleteLabel('Travel');
    sync(recreating, deleting);
    assert.equal(recreating.labelLifecycle.get('Travel')!.deleted, !recreationWins);
    assert.equal(recreating.getNote(original)!.labels, undefined);
    assert.equal(recreating.getNote(target)!.labels?.includes('Travel') ?? false, recreationWins);
    assert.equal(recreating.getLabels().some(label => label.name === 'Travel'), recreationWins);
  }
});

test('undoing recreation restores deletion and undoing deletion restores the prior assignments and color', t => {
  const vault = vaultFor(t), old = imported(vault, 'old', ['Travel']);
  const target = imported(vault, 'target', []);
  vault.setLabelColor('Travel', 'coral');
  vault.deleteLabel('Travel');
  vault.setNoteLabel(target, 'Travel', true);
  vault.undo();
  assert.deepEqual(vault.getLabels(), []);
  assert.equal(vault.getNote(old)!.labels, undefined);
  assert.equal(vault.getNote(target)!.labels, undefined);
  vault.undo();
  assert.deepEqual(vault.getLabels(), [{ name: 'Travel', color: 'coral' }]);
  assert.deepEqual(vault.getNote(old)!.labels, ['Travel']);
  assert.equal(vault.getNote(target)!.labels, undefined);
  vault.redo();
  assert.deepEqual(vault.getLabels(), []);
  vault.redo();
  assert.deepEqual(vault.getLabels(), [{ name: 'Travel', color: 'default' }]);
  assert.deepEqual(vault.getNote(target)!.labels, ['Travel']);
  assert.equal(vault.getNote(old)!.labels, undefined);
});

test('undoing deletion preserves unrelated remote labels, text and color choices', t => {
  const a = vaultFor(t), id = imported(a, 'legacy', ['Travel']);
  a.setLabelColor('Travel', 'peach');
  const b = vaultFor(t, a);
  a.deleteLabel('Travel');
  b.setNoteText(id, 'body', 'Edited on another device');
  b.setNoteLabel(id, 'Audio', true);
  b.setLabelColor('Audio', 'dusk');
  sync(a, b);
  const history = observeBoundaries(a).length;
  a.undo();
  assert.deepEqual(a.getNote(id)!.labels, ['Travel', 'Audio']);
  assert.equal(a.getNote(id)!.body, 'Edited on another device');
  assert.deepEqual(a.getLabels(), [{ name: 'Audio', color: 'dusk' }, { name: 'Travel', color: 'peach' }]);
  assertOnlyLabelEventsAdded(a, history, 1);
  sync(a, b);
});

test('old history previews retain labels but restoring copies cannot recreate a deleted or replaced label identity', t => {
  const vault = vaultFor(t), id = imported(vault, 'legacy', ['Travel']);
  vault.setNoteLabel(id, 'Audio', true);
  const originalSnapshot = vault.captureHistoryState([id]);
  vault.deleteLabel('Travel');
  assert.deepEqual(snapshotNote(originalSnapshot)!.labels, ['Travel', 'Audio']);
  const afterDelete = vault.restoreHistoryState(originalSnapshot);
  assert.deepEqual(vault.getNote(afterDelete)!.labels, ['Audio']);
  assert(!vault.getLabels().some(label => label.name === 'Travel'));
  vault.setNoteLabel(id, 'Travel', true);
  const recreatedSnapshot = vault.captureHistoryState([id]);
  const afterRecreate = vault.restoreHistoryState(originalSnapshot);
  assert.deepEqual(vault.getNote(afterRecreate)!.labels, ['Audio']);
  const loaded = vaultFor(t, vault);
  const currentCopy = loaded.restoreHistoryState(recreatedSnapshot);
  assert.deepEqual(loaded.getNote(currentCopy)!.labels?.slice().sort(), ['Audio', 'Travel']);
  loaded.setNoteLabel(currentCopy, 'Travel', false);
  assert.deepEqual(loaded.getNote(currentCopy)!.labels, ['Audio']);
  loaded.deleteLabel('Travel');
  loaded.setNoteLabel(id, 'Travel', true);
  const previousGeneration = loaded.restoreHistoryState(recreatedSnapshot);
  assert.deepEqual(loaded.getNote(previousGeneration)!.labels, ['Audio']);
  assert.deepEqual(snapshotNote(recreatedSnapshot)!.labels, ['Travel', 'Audio']);
});

test('a new explicit import uses current label identities and can recreate a deleted label without reviving old notes', t => {
  for (const recreateFirst of [false, true]) {
    const vault = vaultFor(t), old = imported(vault, 'old', ['Travel']);
    const manual = imported(vault, 'manual', []);
    vault.deleteLabel('Travel');
    if (recreateFirst) vault.setNoteLabel(manual, 'Travel', true);
    const beforeBoundaries = observeBoundaries(vault).length;
    const fresh = imported(vault, 'fresh', ['Travel']);
    assert.equal(vault.getNote(old)!.labels, undefined);
    assert.deepEqual(vault.getNote(fresh)!.labels, ['Travel']);
    assert.equal(vault.getNote(manual)!.labels?.includes('Travel') ?? false, recreateFirst);
    assert.equal(observeBoundaries(vault).length, beforeBoundaries);
    vault.deleteLabel('Travel');
    const beforeRetry = Y.encodeStateAsUpdate(vault.doc);
    imported(vault, 'fresh', ['Travel']);
    assert.deepEqual(Y.encodeStateAsUpdate(vault.doc), beforeRetry);
    assert.equal(vault.getNote(fresh)!.labels, undefined);
    assert.deepEqual(vault.getLabels(), []);
  }
});

test('new imported memberships cannot become the old label when recreation and deletion are undone', t => {
  const vault = vaultFor(t), old = imported(vault, 'old', ['Travel']);
  const manual = imported(vault, 'manual', []);
  vault.deleteLabel('Travel');
  vault.setNoteLabel(manual, 'Travel', true);
  const fresh = imported(vault, 'fresh', ['Travel']);
  assert.deepEqual(vault.getNote(fresh)!.labels, ['Travel']);
  vault.undo();
  assert.deepEqual(vault.getLabels(), []);
  assert.equal(vault.getNote(fresh)!.labels, undefined);
  vault.undo();
  assert.deepEqual(vault.getNote(old)!.labels, ['Travel']);
  assert.equal(vault.getNote(manual)!.labels, undefined);
  assert.equal(vault.getNote(fresh)!.labels, undefined);
  vault.redo(); vault.redo();
  assert.equal(vault.getNote(old)!.labels, undefined);
  assert.deepEqual(vault.getNote(manual)!.labels, ['Travel']);
  assert.deepEqual(vault.getNote(fresh)!.labels, ['Travel']);
});
