import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as Y from 'yjs';
import { Vault } from '../src/core/vault';
import { snapshotNote, observeBoundaries, latestBoundary } from './history-state-fixture';
import { applyImport, type ImportedNote } from '../src/core/import';
import { notePositionChanges, sameNoteBucket } from '../src/core/note-order';

function imported(id: string, createdAt: number, flags: Partial<ImportedNote> = {}): ImportedNote {
  return { id, title: id, body: `Body of ${id}`, kind: 'text', color: 'default', pinned: false, archived: false, trashed: false,
    createdAt, updatedAt: createdAt + 10, items: [], images: [], ...flags };
}
function fixture(notes = [imported('a', 4000), imported('b', 3000), imported('c', 2000), imported('d', 1000)]) {
  const vault = new Vault(); observeBoundaries(vault);
  applyImport(vault, { id: 'ordering-import', manifestHash: 'a'.repeat(64), notes, replaceSourceIds: [] });
  return vault;
}
function order(vault: Vault, member = 'a') {
  const note = vault.getNote(member)!;
  return vault.getNotes().filter(value => sameNoteBucket(value, note)).map(value => value.id);
}
function replica(source: Vault) { const copy = new Vault(); Y.applyUpdate(copy.doc, Y.encodeStateAsUpdate(source.doc), 'remote'); return copy; }
function sync(a: Vault, b: Vault) {
  a.finishEdit(); b.finishEdit();
  const left = Y.encodeStateAsUpdate(a.doc), right = Y.encodeStateAsUpdate(b.doc);
  Y.applyUpdate(a.doc, right, 'remote'); Y.applyUpdate(b.doc, left, 'remote');
  assert.deepEqual(a.getNotes(), b.getNotes());
}

test('import initializes creation-date placement and ordinary edits keep the order', () => {
  const vault = fixture();
  assert.deepEqual(order(vault), ['a', 'b', 'c', 'd']);
  for (const note of vault.getNotes()) {
    assert.equal(note.sortOrderDate, note.createdAt);
    assert.deepEqual(vault.notes.get(note.id)!.get('placement'), { pinned: false, sortOrderDate: note.createdAt });
    assert.equal(vault.notes.get(note.id)!.has('pinned'), false);
  }
  vault.setNoteText('d', 'body', 'Newest edit');
  assert.deepEqual(order(vault), ['a', 'b', 'c', 'd']);
  assert.equal(vault.getNote('d')!.sortOrderDate, 1000);
});

test('opening legacy notes derives their order without changing the document', () => {
  const doc = new Y.Doc();
  for (const [id, createdAt] of [['a', 50], ['b', 50], ['c', 25]] as const) {
    doc.getMap('notes').set(id, new Y.Map(Object.entries({ title: new Y.Text(id), body: new Y.Text(), createdAt, updatedAt: createdAt, pinned: true })));
  }
  const before = Y.encodeStateAsUpdate(doc), vault = new Vault(doc);
  assert.deepEqual(order(vault), ['b', 'a', 'c']);
  assert(vault.getNotes().every(note => note.sortOrderDate === note.createdAt && note.pinned));
  assert.deepEqual(Y.encodeStateAsUpdate(doc), before);
  assert(vault.getNotes().every(note => !vault.notes.get(note.id)!.has('placement')));
});

test('new notes use exact creation dates while pin/unpin goes above same-millisecond or future positions', t => {
  const now = 1000;
  t.mock.method(Date, 'now', () => now);
  const vault = fixture([imported('a', 1_000_000), imported('p', 2_000_000, { pinned: true })]);
  const first = vault.createNote('text', { title: 'First' }), second = vault.createNote('text', { title: 'Second' });
  const tied = [first, second].sort((a, b) => b.localeCompare(a));
  assert.deepEqual(order(vault, first), ['a', ...tied]);
  assert.equal(vault.getNote(first)!.createdAt, now);
  assert.equal(vault.getNote(first)!.sortOrderDate, now);
  assert.equal(vault.getNote(second)!.sortOrderDate, now);
  const before = vault.getNote('a')!;
  vault.setNoteMeta('a', { pinned: true });
  assert.deepEqual(order(vault, 'p'), ['a', 'p']);
  const pinned = vault.getNote('a')!;
  assert(pinned.sortOrderDate > vault.getNote('p')!.sortOrderDate);
  assert.match(vault.undo()!, /unpinned|pinned/);
  assert.equal(vault.getNote('a')!.pinned, false); assert.equal(vault.getNote('a')!.sortOrderDate, before.sortOrderDate);
  vault.redo(); assert.equal(vault.getNote('a')!.sortOrderDate, pinned.sortOrderDate);
  vault.setNoteMeta('a', { pinned: false });
  assert.deepEqual(order(vault, first), ['a', ...tied]);
  assert.equal(vault.getNote('a')!.createdAt, before.createdAt);
});

test('numeric planner rejects invalid inputs and terminates at extreme finite positions', () => {
  for (const invalid of [NaN, Infinity, -Infinity]) {
    assert.throws(() => notePositionChanges([{ id: 'a', sortOrderDate: invalid }], 0, 1000), /finite/);
    assert.throws(() => notePositionChanges([{ id: 'a', sortOrderDate: 1 }], 0, invalid), /finite/);
  }
  assert.throws(() => notePositionChanges([], 0, 1000), /valid position/);
  assert.throws(() => notePositionChanges([{ id: 'a', sortOrderDate: 1 }], -1, 1000), /valid position/);
  const maximum = Number.MAX_VALUE;
  for (const dates of [[maximum, maximum], [-maximum, -maximum], [maximum, -maximum]]) {
    const sequence = dates.map((sortOrderDate, i) => ({ id: String(i), sortOrderDate }));
    const changes = notePositionChanges(sequence, 0, 1000);
    const after = sequence.map(note => changes.get(note.id) ?? note.sortOrderDate);
    assert(after.every(Number.isFinite)); assert(after[0] > after[1]);
  }
  assert.throws(() => notePositionChanges([{ id: 'a', sortOrderDate: -maximum }, { id: 'b', sortOrderDate: -maximum }], 1, -maximum), /distinct finite sort dates/);
});

test('drag uses the arithmetic mean of full-bucket neighbors and records undoable position without content edits', () => {
  const vault = fixture(), before = vault.getNotes();
  assert.equal(vault.moveNoteRelative('d', 'b', 'before'), true);
  assert.deepEqual(order(vault), ['a', 'd', 'b', 'c']);
  assert.equal(vault.getNote('d')!.sortOrderDate, 3500);
  for (const note of before) {
    const after = vault.getNote(note.id)!;
    assert.equal(after.updatedAt, note.updatedAt); assert.equal(after.createdAt, note.createdAt); assert.equal(after.body, note.body);
  }
  const snapshot = vault.captureHistoryState(['d']);
  assert.equal(latestBoundary(vault).description, 'Note: moved “d”');
  assert.equal(snapshotNote(snapshot)!.sortOrderDate, 3500);
  assert.equal(vault.undo(), 'Note: moved “d”'); assert.deepEqual(order(vault), ['a', 'b', 'c', 'd']);
  assert.equal(vault.redo(), 'Note: moved “d”'); assert.deepEqual(order(vault), ['a', 'd', 'b', 'c']);
  assert.deepEqual(replica(vault).getNotes(), vault.getNotes());
  const existing = vault.getNotes();
  const copy = vault.restoreHistoryState(snapshot);
  assert.notEqual(copy, 'd'); assert.equal(vault.getNote(copy)!.body, vault.getNote('d')!.body);
  for (const note of existing) assert.deepEqual(vault.getNote(note.id), note);
});

test('filtered labels use global neighbors and archive, trash and pin buckets cannot be crossed', () => {
  const vault = fixture([imported('a', 5000, { labels: ['Visible'] }), imported('hidden', 4000), imported('b', 3000, { labels: ['Visible'] }), imported('c', 2000, { labels: ['Visible'] }),
    imported('pinned', 6000, { pinned: true }), imported('archived', 7000, { archived: true }), imported('trashed', 8000, { trashed: true })]);
  vault.moveNoteRelative('c', 'b', 'before');
  assert.deepEqual(order(vault), ['a', 'hidden', 'c', 'b']);
  assert.equal(vault.getNote('c')!.sortOrderDate, 3500);
  const bytes = Y.encodeStateAsUpdate(vault.doc);
  for (const target of ['pinned', 'archived', 'trashed', 'missing', 'a']) assert.equal(vault.moveNoteRelative('a', target, 'before'), false);
  assert.deepEqual(Y.encodeStateAsUpdate(vault.doc), bytes);
  assert.equal(vault.moveNoteRelative('hidden', 'a', 'after'), false);
});

test('merge identity follows creation dates while placement follows selection, and remote edge removal retains source positions', () => {
  const vault = fixture();
  vault.moveNoteRelative('d', 'a', 'before');
  const first = vault.getNote('a')!;
  const merged = vault.mergeNotes(['a', 'd']);
  assert.equal(merged, 'd');
  assert.deepEqual(vault.getNote(merged)!.sourceIds, ['d', 'a']);
  assert.equal(vault.getNote(merged)!.createdAt, 1000);
  assert.equal(vault.getNote(merged)!.sortOrderDate, first.sortOrderDate);
  vault.moveNoteRelative(merged, 'c', 'after');
  // An older client may still remove the original merge edges.
  vault.doc.transact(() => vault.merges.clear(), 'remote');
  assert.deepEqual(order(vault), ['a', 'b', 'c', 'd']);
  assert.equal(vault.getNote('a')!.sortOrderDate, 4000);
});

test('merge inherits the first-selected color, pin group and manually chosen position, with exact undo and history', () => {
  for (const pinned of [false, true]) {
    const vault = fixture([
      imported('oldest', 1000, { color: 'coral', pinned: !pinned }),
      imported('chosen', 6000, { color: 'mint', pinned }),
      imported('above', 5000, { pinned }), imported('below', 2000, { pinned }),
    ]);
    vault.moveNoteRelative('chosen', 'below', 'before');
    const before = vault.getNotes(), chosen = vault.getNote('chosen')!;
    assert.equal(chosen.sortOrderDate, 3500);
    const id = vault.mergeNotes(['chosen', 'oldest']), merged = vault.getNote(id)!;
    assert.equal(id, 'oldest'); assert.equal(merged.createdAt, 1000);
    assert.equal(merged.title, chosen.title); assert.equal(merged.color, chosen.color);
    assert.equal(merged.pinned, pinned); assert.equal(merged.sortOrderDate, chosen.sortOrderDate);
    assert.deepEqual(order(vault, id), ['above', id, 'below']);
    assert.deepEqual(snapshotNote(vault.captureHistoryState(vault.getNote(id)!.sourceIds)), merged);
    assert.deepEqual(replica(vault).getNotes(), vault.getNotes());
    vault.undo(); assert.deepEqual(vault.getNotes(), before.map(note => ({ ...note, updatedAt: vault.getNote(note.id)!.updatedAt })));
    for (const source of ['chosen', 'oldest']) assert(vault.getNote(source)!.updatedAt >= merged.updatedAt);
    vault.redo(); assert.deepEqual(vault.getNote(id), { ...merged, updatedAt: vault.getNote(id)!.updatedAt });
    assert(vault.getNote(id)!.updatedAt >= merged.updatedAt);
    vault.destroy();
  }
});

test('independent offline drags converge and local undo preserves a remote text edit and placement', () => {
  const a = fixture(), b = replica(a);
  a.moveNoteRelative('d', 'b', 'before');
  b.moveNoteRelative('c', 'a', 'before');
  b.setNoteText('d', 'body', 'Remote edit');
  sync(a, b); assert.deepEqual(order(a), ['c', 'a', 'd', 'b']);
  a.undo(); assert.deepEqual(order(a), ['c', 'a', 'b', 'd']);
  assert.equal(a.getNote('d')!.body, 'Remote edit');
  a.redo(); sync(a, b); assert.deepEqual(order(a), ['c', 'a', 'd', 'b']);
});

test('concurrent placements of one note resolve as whole pin/date pairs with deterministic date ties', () => {
  for (const [aClient, bClient] of [[11, 22], [22, 11]]) {
    const a = fixture(), b = replica(a); a.doc.clientID = aClient; b.doc.clientID = bClient;
    a.setNoteMeta('d', { pinned: true });
    b.moveNoteRelative('d', 'b', 'before');
    const possibilities = [a.notes.get('d')!.get('placement'), b.notes.get('d')!.get('placement')];
    sync(a, b);
    assert(possibilities.some(value => JSON.stringify(value) === JSON.stringify(a.notes.get('d')!.get('placement'))));
  }
  const a = fixture([imported('a', 5000), imported('b', 4000), imported('c', 3000), imported('d', 2000), imported('e', 1000)]), b = replica(a);
  a.moveNoteRelative('d', 'b', 'before'); b.moveNoteRelative('e', 'b', 'before'); sync(a, b);
  assert.equal(a.getNote('d')!.sortOrderDate, a.getNote('e')!.sortOrderDate);
  assert.deepEqual(order(a), ['a', 'd', 'e', 'b', 'c']);
});

test('equal and exhausted dates re-space only their needed neighborhood as one undoable move', () => {
  for (const close of [1000, 1000 + Number.EPSILON * 512]) {
    const vault = fixture([imported('outer-top', 5000), imported('a', 4000), imported('b', 3000), imported('outer-bottom', 2000), imported('moving', 1000)]);
    vault.notes.get('a')!.set('placement', { pinned: false, sortOrderDate: close });
    vault.notes.get('b')!.set('placement', { pinned: false, sortOrderDate: 1000 });
    vault.notes.get('outer-bottom')!.set('placement', { pinned: false, sortOrderDate: 0 });
    vault.notes.get('moving')!.set('placement', { pinned: false, sortOrderDate: -1000 });
    const before = vault.getNotes(), stackSize = vault.undoManager.undoStack.length;
    vault.moveNoteRelative('moving', 'b', 'before');
    assert.deepEqual(order(vault), ['outer-top', 'a', 'moving', 'b', 'outer-bottom']);
    assert.equal(vault.getNote('outer-top')!.sortOrderDate, 5000);
    assert.equal(vault.getNote('outer-bottom')!.sortOrderDate, 0);
    assert.equal(vault.undoManager.undoStack.length, stackSize + 1);
    for (const note of before) assert.equal(vault.getNote(note.id)!.updatedAt, note.updatedAt);
    vault.undo(); assert.deepEqual(vault.getNotes(), before);
    vault.redo(); assert.deepEqual(order(vault), ['outer-top', 'a', 'moving', 'b', 'outer-bottom']);
  }
});

test('repeated moves into one gap remain finite, ordered and reloadable after numeric precision is consumed', () => {
  const vault = fixture();
  for (let step = 0; step < 180; step++) {
    const moving = step % 2 ? 'd' : 'c';
    assert.equal(vault.moveNoteRelative(moving, 'b', 'before'), true);
    const sequence = order(vault);
    assert.equal(sequence[sequence.indexOf('b') - 1], moving);
    assert(vault.getNotes().every(note => Number.isFinite(note.sortOrderDate)));
  }
  assert.deepEqual(replica(vault).getNotes(), vault.getNotes());
});

test('precision repair keeps the explicitly moved note in history when its own numeric date is unchanged', () => {
  const vault = fixture([imported('outer-top', 5000), imported('a', 4000), imported('b', 3000), imported('outer-bottom', 2000), imported('moving', 1000)]);
  for (const [id, sortOrderDate] of [['outer-top', 2000], ['a', 1000], ['b', 1000], ['moving', 1000], ['outer-bottom', 0]] as const) {
    vault.notes.get(id)!.set('placement', { pinned: false, sortOrderDate });
  }
  assert.deepEqual(order(vault), ['outer-top', 'a', 'b', 'moving', 'outer-bottom']);
  vault.moveNoteRelative('moving', 'b', 'before');
  assert.equal(vault.getNote('moving')!.sortOrderDate, 1000);
  assert.equal(latestBoundary(vault).description, 'Note: moved “moving”');
  assert.equal(vault.undo(), 'Note: moved “moving”');
  assert.equal(latestBoundary(vault).description, 'Undid: Note: moved “moving”');
  assert.deepEqual(order(vault), ['outer-top', 'a', 'b', 'moving', 'outer-bottom']);
  vault.redo();
  assert.equal(latestBoundary(vault).description, 'Redid: Note: moved “moving”');
});
