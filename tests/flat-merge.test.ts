import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as Y from 'yjs';
import { Vault } from '../src/core/vault';
import { snapshotNote, assertNoReplicatedHistory } from './history-state-fixture';
import { applyImport, type ImportedNote } from '../src/core/import';
import { composeText } from '../src/core/merged-text';

function source(id: string, createdAt: number, body = `Body ${id.toUpperCase()}`): ImportedNote {
  return { id, title: `Title ${id.toUpperCase()}`, body, kind: 'text', color: 'default', pinned: false, archived: false, trashed: false,
    createdAt, updatedAt: createdAt, items: [], images: [], labels: [id] };
}
function fixture(notes = [source('a', 100), source('b', 200), source('c', 300)]) {
  const vault = new Vault();
  applyImport(vault, { id: 'flat-merge-import', manifestHash: 'a'.repeat(64), notes, replaceSourceIds: [] });
  return vault;
}
function replica(vault: Vault) { const other = new Vault(); Y.applyUpdate(other.doc, Y.encodeStateAsUpdate(vault.doc), 'remote'); return other; }
function sync(a: Vault, b: Vault) {
  a.finishEdit(); b.finishEdit();
  const left = Y.encodeStateAsUpdate(a.doc), right = Y.encodeStateAsUpdate(b.doc);
  Y.applyUpdate(a.doc, right, 'remote'); Y.applyUpdate(b.doc, left, 'remote');
  assert.deepEqual(a.getNotes(), b.getNotes());
}

test('merge is one ordinary editable note with first-selected title and every body in selection order', () => {
  const vault = fixture(), originals = vault.getNotes();
  const texts = [...vault.notes].map(([id, note]) => [id, note.get('title'), note.get('body')] as const);
  const id = vault.mergeNotes(['b', 'a', 'c']), note = vault.getNote(id)!;
  assert.equal(id, 'a'); assert.equal(note.createdAt, 100);
  assert.equal(note.title, 'Title B');
  assert.equal(note.body, 'Title A\nTitle C\n\nBody B\n\nBody A\n\nBody C');
  assert.deepEqual(note.labels, ['b', 'a', 'c']);
  assert.equal('sections' in note, false);
  for (const [sourceId, title, body] of texts) {
    assert.equal(vault.notes.get(sourceId)!.get('title'), title); assert.equal(vault.notes.get(sourceId)!.get('body'), body);
  }
  assert.deepEqual(snapshotNote(vault.captureHistoryState(vault.getNote(id)!.sourceIds)), note);
  vault.undo(); assert.deepEqual(vault.getNotes(), originals.map(original => ({ ...original, updatedAt: vault.getNote(original.id)!.updatedAt })));
  assert(vault.getNotes().every(restored => restored.updatedAt >= note.updatedAt));
  vault.redo(); assert.deepEqual(vault.getNote(id), { ...note, updatedAt: vault.getNote(id)!.updatedAt });
  assert(vault.getNote(id)!.updatedAt >= note.updatedAt);
});

test('one body editor can delete all joining text, replace across old boundaries and undo exactly', () => {
  const vault = fixture([source('a', 100, '😀'), source('b', 200, '𐐀')]);
  const id = vault.mergeNotes(['a', 'b']), before = vault.getNote(id)!;
  assert.equal(before.body, 'Title B\n\n😀\n\n𐐀');
  vault.setNoteText(id, 'body', 'Title B\n\n😃');
  assert.equal(vault.getNote(id)!.body, 'Title B\n\n😃');
  assert.equal(vault.getSource('b')!.body, '');
  assert.deepEqual(replica(vault).getNote(id), vault.getNote(id));
  vault.undo(); assert.equal(vault.getNote(id)!.body, before.body);
  vault.redo(); assert.equal(vault.getNote(id)!.body, 'Title B\n\n😃');
  vault.undoManager.stopCapturing();
  vault.setNoteText(id, 'body', 'Entirely replaced 😎');
  assert.equal(vault.getNote(id)!.body, 'Entirely replaced 😎');
  assert.equal(vault.getNote(id)!.title, 'Title A');
  vault.undo(); assert.equal(vault.getNote(id)!.body, 'Title B\n\n😃');
});

test('nested merges reuse prior body runs and preserve their selected source/image order', () => {
  const notes = [source('a', 100), source('b', 200), source('c', 300)];
  for (const note of notes) note.images = [{ id: `image-${note.id}`, noteId: note.id, hash: note.id.repeat(64), name: note.id, type: 'image/png', size: 1, order: 0 }];
  const vault = fixture(notes), first = vault.mergeNotes(['b', 'a']);
  const firstBody = vault.getNote(first)!.body;
  const id = vault.mergeNotes(['c', first]);
  assert.equal(vault.getNote(id)!.title, 'Title C');
  assert.equal(vault.getNote(id)!.body, `Title B\n\nBody C\n\n${firstBody}`);
  assert.deepEqual(vault.getSourceOrder(id), ['c', 'b', 'a']);
  assert.deepEqual(vault.getNote(id)!.images.map(image => image.name), ['c', 'b', 'a']);
  assert.deepEqual(vault.getNote(id)!.labels, ['c', 'b', 'a']);
});

test('empty body runs remain editable and late offline text survives both CRDT insertion orders', () => {
  for (const clients of [[101, 202], [202, 101]]) {
    const desktop = fixture([source('a', 100, ''), source('b', 200, 'Train')]), phone = replica(desktop);
    desktop.doc.clientID = clients[0]; phone.doc.clientID = clients[1];
    const id = desktop.mergeNotes(['a', 'b']);
    assert.equal(desktop.getNote(id)!.body, 'Title B\n\n\n\nTrain');
    phone.setNoteText('a', 'body', 'Late packing');
    phone.setNoteText('b', 'body', 'Train tomorrow');
    sync(desktop, phone);
    const body = desktop.getNote(id)!.body;
    assert.equal(body, 'Title B\n\nLate packing\n\nTrain tomorrow');
    assert.equal(body.match(/Late packing/g)?.length, 1);
    assert.equal(body.match(/Train tomorrow/g)?.length, 1);
    desktop.setNoteText(id, 'body', '');
    assert.equal(desktop.getNote(id)!.body, '');
    desktop.setNoteText(id, 'body', 'New body');
    assert.equal(desktop.getNote(id)!.body, 'New body');
  }
});

test('reversed and overlapping concurrent merges converge with every original field exactly once', () => {
  for (const reversed of [false, true]) {
    const desktop = fixture(), phone = replica(desktop);
    desktop.mergeNotes(['a', 'b']); phone.mergeNotes(reversed ? ['b', 'a'] : ['b', 'c']);
    sync(desktop, phone);
    const merged = desktop.getNote('a')!;
    const included = reversed ? ['a', 'b'] : ['a', 'b', 'c'];
    const allText = merged.title + merged.body;
    for (const id of included) {
      assert.equal(allText.split(`Title ${id.toUpperCase()}`).length - 1, 1);
      assert.equal(allText.split(`Body ${id.toUpperCase()}`).length - 1, 1);
    }
    if (reversed) assert(['Title A', 'Title B'].includes(merged.title), 'Joining text never enters the winning original title');
    assert.deepEqual(replica(desktop).getNotes(), desktop.getNotes());
  }
});

test('undoing one concurrent merge gates its recipe without hiding sources still linked by another merge', () => {
  const desktop = fixture(), phone = replica(desktop);
  desktop.mergeNotes(['a', 'b']); phone.mergeNotes(['b', 'c']); sync(desktop, phone);
  desktop.undo(); sync(desktop, phone);
  assert.equal(desktop.getNotes().length, 2);
  assert.equal(desktop.getNote('a')!.title, 'Title A');
  assert.equal(desktop.getNote('b')!.title, 'Title B');
  assert.equal(desktop.getNote('b')!.body, 'Title C\n\nBody B\n\nBody C');
});

test('legacy edge-only groups flatten without writes and materialize joining text within an undoable edit', () => {
  const vault = fixture([source('a', 100), source('b', 200)]);
  vault.merges.set('old-edge', { a: 'a', b: 'b' });
  const before = Y.encodeStateAsUpdate(vault.doc), note = vault.getNote('a')!;
  assert.equal(note.body, 'Title B\n\nBody A\n\nBody B');
  assert.deepEqual(Y.encodeStateAsUpdate(vault.doc), before);
  assert.equal(vault.mergeRecipes.size, 0);
  vault.setNoteText('a', 'body', 'Edited ' + note.body);
  assert.equal(vault.mergeRecipes.size, 1);
  assert.equal(vault.getNote('a')!.body, 'Edited ' + note.body);
  vault.undo(); assert.equal(vault.mergeRecipes.size, 0); assert.deepEqual(vault.getNote('a'), { ...note, updatedAt: vault.getNote('a')!.updatedAt });
  assert(vault.getNote('a')!.updatedAt >= note.updatedAt);
  vault.redo(); assert.equal(vault.getNote('a')!.body, 'Edited ' + note.body);
});

test('explicit import replacement removes touching recipes while retained historical previews still work', () => {
  const vault = fixture();
  const id = vault.mergeNotes(['a', 'b']), snapshot = vault.captureHistoryState(vault.getNote(id)!.sourceIds), before = snapshotNote(snapshot);
  applyImport(vault, { id: 'replacement', manifestHash: 'b'.repeat(64), replaceSourceIds: ['a', 'b'], notes: [source('replacement', 500)] });
  assert.equal(vault.mergeRecipes.size, 0);
  assert.equal(vault.getNote('replacement')!.body, 'Body REPLACEMENT');
  assert.deepEqual(snapshotNote(snapshot), before);
});

test('composition rejects missing source fields instead of dropping referenced content', () => {
  assert.throws(() => composeText(['missing'], {}, {}), /missing text field/);
});

test('joining text never interrupts concurrent title/body append phrases in either client order', () => {
  for (const [leftClient, rightClient] of [[101, 202], [202, 101]]) {
    const desktop = fixture([source('a', 100, 'Book tickets'), { ...source('b', 200, 'Bring'), title: 'Packing' }]), phone = replica(desktop);
    desktop.doc.clientID = leftClient; phone.doc.clientID = rightClient;
    desktop.mergeNotes(['a', 'b']);
    phone.setNoteText('b', 'title', 'Packing for Japan');
    phone.setNoteText('a', 'body', 'Book tickets tomorrow');
    phone.setNoteText('b', 'body', 'Bring passport');
    sync(desktop, phone);
    assert.equal(desktop.getNote('a')!.body, 'Packing for Japan\n\nBook tickets tomorrow\n\nBring passport');
    assert.equal(desktop.notes.get('b')!.get('title').toString(), 'Packing for Japan');
    assert.deepEqual(replica(desktop).getNotes(), desktop.getNotes());
  }
});

test('join allocation changes no visible notes and survives creator Undo when a remote nested merge still references it', () => {
  const desktop = fixture(), original = desktop.getNotes();
  let allocations = 0;
  desktop.doc.on('afterTransaction', transaction => {
    if (transaction.origin !== 'join-allocation') return;
    allocations++;
    assert.deepEqual(desktop.getNotes(), original);
    assert.equal(desktop.undoManager.undoStack.length, 0);
    assertNoReplicatedHistory(desktop.doc);
  });
  desktop.mergeNotes(['a', 'b']);
  assert.equal(allocations, 1);
  const originalJoins = [...desktop.textJoins.keys()];
  const phone = replica(desktop);
  phone.mergeNotes(['a', 'c']);
  const body = phone.getNote('a')!.body;
  phone.setNoteText('a', 'body', body.replace('Title B\n\n', 'Title B\nRemote separator words\n'));
  sync(desktop, phone);
  desktop.undo();
  assert.equal(desktop.getNotes().length, 1, 'The later remote merge owns every source it observed');
  assert(desktop.getNote('a')!.body.includes('Remote separator words'));
  for (const id of originalJoins) assert(desktop.textJoins.has(id));
  sync(desktop, phone);
  assert.deepEqual(replica(desktop).getNotes(), desktop.getNotes());
});

test('concurrent first edits of a legacy composition keep both separator objects and both authored insertions', () => {
  const desktop = fixture([source('a', 100), source('b', 200)]);
  desktop.merges.set('old-edge', { a: 'a', b: 'b' });
  const phone = replica(desktop), body = desktop.getNote('a')!.body;
  desktop.setNoteText('a', 'body', body.replace('Title B\n\n', 'Title B\nDesktop separator\n'));
  phone.setNoteText('a', 'body', body.replace('Title B\n\n', 'Title B\nPhone separator\n'));
  const ids = new Set([...desktop.textJoins.keys(), ...phone.textJoins.keys()]);
  sync(desktop, phone);
  assert(desktop.getNote('a')!.body.includes('Desktop separator'));
  assert(desktop.getNote('a')!.body.includes('Phone separator'));
  assert.equal(desktop.textJoins.size, ids.size);
});

test('partial import replacement rejects non-anchor, title-owner, anchor and singleton-survivor cases without changing any text', () => {
  for (const [selection, replaced] of [
    [['a', 'b', 'c'], ['b']], [['b', 'a', 'c'], ['b']], [['a', 'b', 'c'], ['a']], [['a', 'b', 'c'], ['a', 'b']],
  ]) {
    const vault = fixture(), id = vault.mergeNotes(selection), recipe = [...vault.mergeRecipes.values()][0];
    let offset = 0;
    for (const ref of recipe.body) {
      if (ref.field === 'join' && !replaced.includes(ref.sourceId)) break;
      offset += ref.field === 'join' ? vault.textJoins.get(ref.joinId)!.length : vault.notes.get(ref.sourceId)!.get(ref.field).length;
    }
    const body = vault.getNote(id)!.body;
    vault.setNoteText(id, 'body', body.slice(0, offset + 1) + 'Surviving joining text' + body.slice(offset + 1));
    const before = Y.encodeStateAsUpdate(vault.doc), note = vault.getNote(id);
    assert(note!.body.includes('Surviving joining text'));
    assert.throws(() => applyImport(vault, { id: 'partial-replacement', manifestHash: 'b'.repeat(64), replaceSourceIds: replaced, notes: [source('replacement', 500)] }), /whole connected note.*regenerate/);
    assert.deepEqual(Y.encodeStateAsUpdate(vault.doc), before);
    assert.deepEqual(vault.getNote(id), note); assertNoReplicatedHistory(vault.doc);
  }
});

test('whole-note replacement may reuse a source ID without reviving old joins and receipt retries stay write-free after another merge', () => {
  const vault = fixture(), id = vault.mergeNotes(['a', 'b']);
  vault.setNoteText(id, 'body', vault.getNote(id)!.body.replace('Title B\n\n', 'Title B\nOld joining words\n'));
  const operation = { id: 'replacement-with-id-reuse', manifestHash: 'b'.repeat(64), replaceSourceIds: ['a', 'b'], notes: [source('b', 500, 'Fresh body')] };
  applyImport(vault, operation);
  assert.equal(vault.mergeRecipes.size, 0);
  const merged = vault.mergeNotes(['b', 'c']), note = vault.getNote(merged)!;
  assert(note.body.includes('Fresh body')); assert(!note.body.includes('Old joining words'));
  const before = Y.encodeStateAsUpdate(vault.doc);
  assert.equal(applyImport(vault, operation).status, 'already-applied');
  assert.deepEqual(Y.encodeStateAsUpdate(vault.doc), before);
});

test('nested merge inherits the first selected logical note appearance and manual position rather than its raw title owner', t => {
  t.mock.method(Date, 'now', () => 1000);
  const desktop = fixture([source('a', 100), source('b', 200), source('c', 50), source('d', 300)]);
  desktop.setNoteMeta('b', { color: 'mint', pinned: true });
  desktop.setNoteMeta('d', { pinned: true });
  const phone = replica(desktop); desktop.doc.clientID = 101; phone.doc.clientID = 202;
  const first = desktop.mergeNotes(['b', 'a']);
  desktop.setNoteMeta(first, { color: 'peach' });
  desktop.moveNoteRelative(first, 'd', 'before');
  phone.setNoteMeta('b', { color: 'sage' });
  sync(desktop, phone);
  const selected = desktop.getNote(first)!;
  assert.equal(selected.color, 'peach'); assert.equal(desktop.getSource('b')!.color, 'sage');
  assert.notEqual(selected.sortOrderDate, desktop.getSource('b')!.sortOrderDate);
  assert.equal(selected.sortOrderDate, 1002);
  const originalC = desktop.getNote('c')!;
  const nested = desktop.mergeNotes([first, 'c']), result = desktop.getNote(nested)!;
  assert.equal(nested, 'c'); assert.equal(result.createdAt, 50);
  assert.equal(result.title, selected.title); assert.equal(result.color, selected.color);
  assert.equal(result.pinned, selected.pinned); assert.equal(result.sortOrderDate, selected.sortOrderDate);
  assert.deepEqual(desktop.notes.get(nested)!.get('placement'), { pinned: true, sortOrderDate: 1002 });
  desktop.undo();
  assert.deepEqual(desktop.getNote('c'), { ...originalC, updatedAt: result.updatedAt });
  assert.equal(desktop.getNote(first)!.color, selected.color); assert.equal(desktop.getNote(first)!.sortOrderDate, selected.sortOrderDate);
  desktop.redo(); assert.deepEqual(desktop.getNote(nested), result);
});

test('creator Undo retains appearance explicitly chosen by a later remote nested merge even when its values did not change', t => {
  t.mock.method(Date, 'now', () => 1000);
  const desktop = fixture();
  desktop.setNoteMeta('a', { color: 'coral' });
  desktop.setNoteMeta('b', { color: 'mint', pinned: true });
  const first = desktop.mergeNotes(['b', 'a']), chosen = desktop.getNote(first)!;
  const phone = replica(desktop);
  phone.mergeNotes([first, 'c']);
  sync(desktop, phone);
  assert.equal(desktop.undo(), 'Merged notes');
  const remaining = desktop.getNote(first)!;
  assert.equal(desktop.getNotes().length, 1);
  assert.equal(remaining.color, chosen.color); assert.equal(remaining.pinned, chosen.pinned);
  assert.equal(remaining.sortOrderDate, chosen.sortOrderDate);
  sync(desktop, phone); assert.deepEqual(replica(desktop).getNotes(), desktop.getNotes());
});

test('Undo of the merge preserves later remote color and placement edits on its source notes', t => {
  t.mock.method(Date, 'now', () => 1000);
  const desktop = fixture();
  desktop.setNoteMeta('b', { color: 'mint', pinned: true });
  const first = desktop.mergeNotes(['b', 'a']), phone = replica(desktop);
  phone.setNoteMeta(first, { color: 'storm' });
  phone.setNoteMeta(first, { pinned: false });
  const selected = phone.getNote(first)!;
  sync(desktop, phone); desktop.undo();
  assert.equal(desktop.getNotes().length, 3);
  for (const id of ['a', 'b']) {
    const note = desktop.getNote(id)!;
    assert.equal(note.color, 'storm'); assert.equal(note.pinned, false); assert.equal(note.sortOrderDate, selected.sortOrderDate);
  }
  sync(desktop, phone);
});
