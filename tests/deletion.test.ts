import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as Y from 'yjs';
import { Vault } from '../src/core/vault';
import { enforcePermanentDeletions, installPermanentDeletionGuard, getPermanentDeletionBlobCandidates } from '../src/core/deletion';
import { assertNoReplicatedHistory } from './history-state-fixture';

function replica(source: Vault) { const vault = new Vault(); Y.applyUpdate(vault.doc, Y.encodeStateAsUpdate(source.doc), 'remote'); return vault; }
function sync(a: Vault, b: Vault) {
  const updates = [Y.encodeStateAsUpdate(a.doc), Y.encodeStateAsUpdate(b.doc)];
  Y.applyUpdate(a.doc, updates[1], 'remote'); Y.applyUpdate(b.doc, updates[0], 'remote');
  Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc), 'remote'); Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc), 'remote');
  assert.deepEqual(a.getNotes(), b.getNotes());
}
const encoded = (vault: Vault) => Buffer.from(Y.encodeStateAsUpdate(vault.doc)).toString();

test('permanent deletion removes source contents, items, images and history while retaining unrelated undo', () => {
  const vault = new Vault();
  const gone = vault.createNote('checklist', { title: 'ERASED_TITLE_PAYLOAD', body: 'ERASED_BODY_PAYLOAD' });
  const item = vault.addItem(gone, 'ERASED_ITEM_PAYLOAD');
  vault.setNoteText(gone, 'body', 'ERASED_NEW_BODY_PAYLOAD');
  vault.setItemText(item, 'ERASED_NEW_ITEM_PAYLOAD');
  const hash = 'a'.repeat(64);
  vault.addAttachment({ id: 'image', noteId: gone, hash, name: 'ERASED_IMAGE_FILENAME', size: 10, type: 'image/png' });
  const keep = vault.createNote('text', { title: 'Keep me' });
  vault.setNoteText(keep, 'body', 'Unrelated edit');
  vault.setNoteMeta(gone, { trashed: true });
  assert.equal(vault.deleteNotesForever([gone]), true);
  assert.equal(vault.getNote(gone), undefined);
  assert.equal(vault.items.size, 0); assert.equal(vault.attachments.size, 0);
  assertNoReplicatedHistory(vault.doc);
  assert(getPermanentDeletionBlobCandidates(vault.doc).has(hash));
  assert(!encoded(vault).includes('ERASED_'), 'Yjs snapshot must not retain erased text or history payload');
  assert(vault.undo()); assert.equal(vault.getNote(keep)?.body, '');
  assert(vault.redo()); assert.equal(vault.getNote(keep)?.body, 'Unrelated edit');
  assert.equal(vault.getNote(gone), undefined);
  assert.equal(vault.deleteNotesForever([gone]), false);
  vault.destroy();
});

test('confirmation targets reject restored notes and newly expanded merges without deleting anything', () => {
  const vault = new Vault(), first = vault.createNote(), second = vault.createNote();
  vault.setNoteMeta(first, { trashed: true });
  const confirmed = [...vault.getNote(first)!.sourceIds];
  vault.setNoteMeta(first, { trashed: false });
  assert.throws(() => vault.deleteNotesForever(confirmed), /selected notes have changed/);
  vault.setNoteMeta(first, { trashed: true }); vault.setNoteMeta(second, { trashed: true });
  vault.mergeNotes([first, second]);
  assert.throws(() => vault.deleteNotesForever(confirmed), /selected notes have changed/);
  assert.equal(vault.deletedNotes.size, 0);
  assert.equal(vault.deleteNotesForever(vault.getNote(first)!.sourceIds), true);
  assert.equal(vault.notes.size, 0); assert.equal(vault.mergeRecipes.size, 0); assert.equal(vault.textJoins.size, 0);
  vault.destroy();
});

test('late offline edits, restore, added items/images and deep undo cannot resurrect deleted sources', () => {
  const desktop = new Vault(), gone = desktop.createNote('checklist', { title: 'ERASED_OFFLINE_TITLE' });
  desktop.setNoteMeta(gone, { trashed: true });
  const phone = replica(desktop);
  desktop.deleteNotesForever([gone]);
  phone.setNoteMeta(gone, { trashed: false });
  phone.setNoteText(gone, 'body', 'ERASED_OFFLINE_EDIT'); phone.addItem(gone, 'ERASED_OFFLINE_ITEM');
  phone.addAttachment({ id: 'late-image', noteId: gone, hash: 'b'.repeat(64), name: 'ERASED_OFFLINE_IMAGE', type: 'image/png', size: 10 });
  sync(desktop, phone);
  for (const vault of [desktop, phone]) {
    assert.equal(vault.getNotes().length, 0); assert.equal(vault.items.size, 0); assert.equal(vault.attachments.size, 0);
    assertNoReplicatedHistory(vault.doc); assert.equal(vault.undo(), undefined); assert.equal(vault.redo(), undefined);
    assert(!encoded(vault).includes('ERASED_'));
    assert(getPermanentDeletionBlobCandidates(vault.doc).has('b'.repeat(64)));
    vault.destroy();
  }
});

test('late offline merges retain surviving sources and redact mixed history and joins', t => {
  let now = 10000;
  t.mock.method(Date, 'now', () => ++now); // The mixed merge uses the soon-erased trash revision as its base.
  const desktop = new Vault(), gone = desktop.createNote('text', { title: 'ERASED_MERGE_TITLE', body: 'ERASED_MERGE_BODY' });
  const keep = desktop.createNote('text', { title: 'Survivor', body: 'Surviving body' });
  desktop.setNoteMeta(gone, { trashed: true });
  const phone = replica(desktop);
  desktop.deleteNotesForever([gone]);
  phone.mergeNotes([gone, keep]);
  phone.setNoteText(keep, 'body', `${phone.getNote(keep)!.body}\nSurviving addition`);
  sync(desktop, phone);
  for (const vault of [desktop, phone]) {
    assert.equal(vault.getNotes().length, 1);
    assert.equal(vault.getNote(keep)!.title, 'Survivor');
    assert.match(vault.getNote(keep)!.body, /Surviving body/);
    assert(!JSON.stringify(vault.getNotes()).includes('ERASED_'));
    assertNoReplicatedHistory(vault.doc);
    assert(!encoded(vault).includes('ERASED_'));
    vault.destroy();
  }
});

test('plain server documents use the same cleanup guard and retain no erased payload on reload', () => {
  const vault = new Vault(), gone = vault.createNote('text', { title: 'ERASED_SERVER_TITLE' });
  vault.setNoteMeta(gone, { trashed: true });
  const doc = new Y.Doc(); const stop = installPermanentDeletionGuard(doc);
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(vault.doc));
  vault.deleteNotesForever([gone]); Y.applyUpdate(doc, Y.encodeStateAsUpdate(vault.doc));
  assert.equal(doc.getMap('notes').size, 0); assertNoReplicatedHistory(doc);
  assert.equal(doc.share.has('revisions'), false);
  assert.equal(enforcePermanentDeletions(doc), false);
  const reload = new Vault(); Y.applyUpdate(reload.doc, Y.encodeStateAsUpdate(doc));
  assert.equal(reload.getNotes().length, 0); assertNoReplicatedHistory(reload.doc);
  stop(); doc.destroy(); vault.destroy(); reload.destroy();
});

test('new surviving sources remain visible when their stale merge arrives after deletion', () => {
  const vault = new Vault(), gone = vault.createNote('text', { title: 'ERASED_BASE_TITLE' });
  vault.setNoteMeta(gone, { trashed: true });
  const offline = replica(vault);
  const vector = Y.encodeStateVector(offline.doc);
  const keep = offline.createNote('text', { title: 'Keep title', body: 'Keep body' });
  offline.mergeNotes([gone, keep]);
  const late = Y.encodeStateAsUpdate(offline.doc, vector);
  vault.deleteNotesForever([gone]);
  Y.applyUpdate(vault.doc, late);
  assert.equal(vault.getNote(keep)?.title, 'Keep title');
  assert.equal(vault.getNote(gone), undefined); assertNoReplicatedHistory(vault.doc);
  vault.destroy(); offline.destroy();
});

test('surviving edited separators and grouping remain visible after a stale merge through a deleted source', () => {
  const desktop = new Vault();
  const gone = desktop.createNote('text', { title: 'ERASED_ROOT', body: 'ERASED_BODY' });
  const first = desktop.createNote('text', { title: 'First survivor', body: 'First body' });
  const second = desktop.createNote('text', { title: 'Second survivor', body: 'Second body' });
  desktop.setNoteMeta(gone, { trashed: true });
  const phone = replica(desktop);
  desktop.deleteNotesForever([gone]);
  phone.mergeNotes([gone, first, second]);
  const recipe = [...phone.mergeRecipes.values()][0];
  const join = recipe.body.find(ref => ref.field === 'join' && ref.sourceId === first);
  assert(join?.field === 'join');
  phone.doc.transact(() => phone.textJoins.get(join.joinId)!.insert(1, 'SURVIVING_JOIN_TEXT'), 'remote');
  Y.applyUpdate(desktop.doc, Y.encodeStateAsUpdate(phone.doc), 'remote');
  assert.equal(desktop.getNotes().length, 1);
  assert.deepEqual(new Set(desktop.getNote(first)!.sourceIds), new Set([first, second]));
  assert.match(desktop.getNote(first)!.body, /SURVIVING_JOIN_TEXT/);
  assert(!encoded(desktop).includes('ERASED_'));
  // This undo was authored offline before learning about permanent deletion.
  // Cleanup must not replace its edges with writes that the undo cannot remove.
  phone.undo();
  Y.applyUpdate(desktop.doc, Y.encodeStateAsUpdate(phone.doc), 'remote');
  assert.equal(desktop.getNotes().length, 2);
  assert.equal(desktop.getNote(first)!.body, 'First body');
  assert.equal(desktop.getNote(second)!.body, 'Second body');
  assert.equal(desktop.getNotes().some(note => note.body.includes('SURVIVING_JOIN_TEXT')), false);
  desktop.destroy(); phone.destroy();
});

test('ordinary typing after deletion does not iterate the vault history or undo stacks', () => {
  const vault = new Vault();
  const gone = vault.createNote(); vault.setNoteMeta(gone, { trashed: true }); vault.deleteNotesForever([gone]);
  const keep = vault.createNote('text', { title: 'Still editable' });
  for (let index = 0; index < 20; index++) vault.setNoteText(keep, 'body', `Revision ${index}`);
  const stack = vault.undoManager.undoStack, iterator = stack[Symbol.iterator];
  stack[Symbol.iterator] = () => { throw new Error('Full Undo stack iteration during typing'); };
  try { assert.doesNotThrow(() => vault.setNoteText(keep, 'body', 'Current typing')); }
  finally { stack[Symbol.iterator] = iterator; }
  assertNoReplicatedHistory(vault.doc);
  assert.equal(vault.getNote(keep)?.body, 'Current typing');
  vault.destroy();
});

test('stale merge and deletion converge in either arrival order without losing surviving joined text', () => {
  const initial = new Vault(), gone = initial.createNote('text', { title: 'ERASED_REVERSE_ROOT' });
  const keep = initial.createNote('text', { title: 'Kept title', body: 'Kept body' });
  initial.setNoteMeta(gone, { trashed: true });
  const deleting = replica(initial), merging = replica(initial);
  deleting.deleteNotesForever([gone]); merging.mergeNotes([gone, keep]);
  const join = [...merging.mergeRecipes.values()][0].body.find(ref => ref.field === 'join' && ref.sourceId === keep);
  assert(join?.field === 'join');
  merging.doc.transact(() => merging.textJoins.get(join.joinId)!.insert(1, 'SURVIVING_REVERSE_JOIN'), 'remote');
  const deletedUpdate = Y.encodeStateAsUpdate(deleting.doc), mergedUpdate = Y.encodeStateAsUpdate(merging.doc);
  const results: unknown[] = [];
  for (const updates of [[deletedUpdate, mergedUpdate], [mergedUpdate, deletedUpdate]]) {
    const receiver = replica(initial);
    for (const update of updates) Y.applyUpdate(receiver.doc, update, 'remote');
    results.push(receiver.getNotes());
    assert.match(receiver.getNote(keep)!.body, /SURVIVING_REVERSE_JOIN/);
    assert(!encoded(receiver).includes('ERASED_'));
    receiver.destroy();
  }
  assert.deepEqual(results[0], results[1]);
  for (const vault of [initial, deleting, merging]) vault.destroy();
});

test('a separately arriving deletion identity invalidates a previously cached surviving composition', () => {
  const vault = new Vault(), first = vault.createNote('text', { title: 'First' }), second = vault.createNote('text', { title: 'Second' });
  vault.doc.transact(() => {
    vault.merges.set('edge-one', { a: 'already-erased', b: first });
    vault.merges.set('edge-two', { a: 'already-erased', b: second });
  }, 'remote');
  assert.equal(vault.getNotes().length, 2);
  vault.doc.transact(() => vault.deletedNotes.set('already-erased', true), 'remote');
  assert.equal(vault.getNotes().length, 1);
  assert.deepEqual(new Set(vault.getNotes()[0].sourceIds), new Set([first, second]));
  vault.destroy();
});
