import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import * as Y from 'yjs';
import { Vault } from '../src/core/vault';
import { applyHistory, diffHistory } from '../src/core/history';
import { historyNotes } from '../src/core/history-view';
import type { HistoryState } from '../src/core/history-types';
import { snapshotNote, observeBoundaries, latestBoundary, captureSnapshot } from './history-state-fixture';

function vaultFor(t: TestContext, source?: Vault) {
  const vault = new Vault(); observeBoundaries(vault); t.after(() => vault.destroy());
  if (source) Y.applyUpdate(vault.doc, Y.encodeStateAsUpdate(source.doc), 'remote');
  return vault;
}
function capture(vault: Vault, id: string) {
  const snapshot = captureSnapshot(vault, id), boundary = latestBoundary(vault);
  assert.deepEqual(snapshot.note, vault.getNote(id)); return { ...snapshot, boundary };
}
function sync(a: Vault, b: Vault) {
  const aa = Y.encodeStateAsUpdate(a.doc), bb = Y.encodeStateAsUpdate(b.doc);
  Y.applyUpdate(a.doc, bb, 'remote'); Y.applyUpdate(b.doc, aa, 'remote');
  assert.deepEqual(a.getNotes(), b.getNotes());
}
function fixture(): HistoryState {
  const source = (title: string, body: string) => ({ title, body, kind: 'text' as const, color: 'default' as const,
    pinned: false, archived: false, trashed: false, createdAt: 1, updatedAt: 2, images: {}, items: {} });
  return { sources: { a: source('First', 'First body'), b: source('Second', 'Second body') }, groups: [['a'], ['b']] };
}

test('recipe and checklist mode patches reconstruct exactly without changing earlier source snapshots', () => {
  const before = fixture(), after = structuredClone(before);
  after.groups = [['a', 'b']];
  after.sources.a.unifiedChecklist = true; after.sources.b.unifiedChecklist = true;
  after.joins = { titleJoin: '\n\n', bodyJoin: '\n\n' };
  after.recipes = { recipe: { id: 'recipe', sourceIds: ['a', 'b'], edgeIds: ['edge'], order: 1,
    title: { sourceId: 'a', field: 'title' }, body: [{ sourceId: 'b', field: 'title' }, { sourceId: 'a', field: 'join', joinId: 'titleJoin' },
      { sourceId: 'a', field: 'body' }, { sourceId: 'a', field: 'join', joinId: 'bodyJoin' }, { sourceId: 'b', field: 'body' }] } };
  const original = structuredClone(before), patches = diffHistory(before, after);
  assert.equal(patches.filter(patch => patch.op === 'recipe').length, 1);
  assert.equal(patches.filter(patch => patch.op === 'checklist-mode').length, 2);
  assert.equal(patches.filter(patch => patch.op === 'join').length, 2);
  assert(!patches.some(patch => patch.op === 'text'), 'Merge boundaries do not change any original source text');
  assert.deepEqual(applyHistory(before, patches), after);
  assert.deepEqual(before, original);
  assert.deepEqual(applyHistory(after, diffHistory(after, before)), before);
  assert.equal(snapshotNote(after)!.body, 'Second\n\nFirst body\n\nSecond body');
  assert.equal(historyNotes(before).length, 2);
  const edited = structuredClone(after); edited.joins!.titleJoin = '';
  const edit = diffHistory(after, edited);
  assert.deepEqual(edit, [{ op: 'join-text', joinId: 'titleJoin', index: 0, remove: 2, insert: '' }]);
  assert.equal(snapshotNote(applyHistory(after, edit))!.body, 'SecondFirst body\n\nSecond body');
  assert.deepEqual(after.recipes, edited.recipes);
});

test('join edits stay compact, handle Unicode boundaries, and distinguish an empty run from a removed run', () => {
  const before = fixture(); before.joins = { join: `\n${'x'.repeat(5000)}😀\n` };
  const after = structuredClone(before); after.joins!.join = before.joins.join.replace('😀', '😃');
  const patches = diffHistory(before, after);
  assert.deepEqual(patches, [{ op: 'join-text', joinId: 'join', index: 5001, remove: 2, insert: '😃' }]);
  assert.deepEqual(applyHistory(before, patches), after);
  assert.equal(before.joins.join, `\n${'x'.repeat(5000)}😀\n`);
  const empty = { ...before, joins: { join: '' } };
  assert.deepEqual(applyHistory(before, diffHistory(before, empty)), empty);
  const removed = fixture();
  assert.deepEqual(diffHistory(empty, removed), [{ op: 'join', joinId: 'join', value: null }]);
  assert.deepEqual(applyHistory(empty, diffHistory(empty, removed)), removed);
  assert.deepEqual(applyHistory(removed, diffHistory(removed, empty)), empty);
  assert.throws(() => applyHistory(removed, [{ op: 'join-text', joinId: 'absent', index: 0, remove: 0, insert: 'lost' }]), /missing text join/);
});

test('standalone separated and merged snapshots restore one ordinary note per recorded group without mutating the snapshot', t => {
  const vault = vaultFor(t), separated = fixture(), original = structuredClone(separated);
  const merged = structuredClone(separated); merged.groups = [['a', 'b']];
  const bytes = Y.encodeStateAsUpdate(vault.doc);
  assert.deepEqual(historyNotes(separated).map(note => [note.title, note.body]), [['First', 'First body'], ['Second', 'Second body']]);
  assert.deepEqual(Y.encodeStateAsUpdate(vault.doc), bytes);
  const copied = vault.getNote(vault.restoreHistoryState(merged))!;
  assert.equal(copied.sourceIds.length, 1); assert.equal(copied.body, snapshotNote(merged)!.body);
  vault.restoreHistoryState(separated); assert.equal(vault.getNotes().length, 3);
  assert.deepEqual(separated, original);
});

test('selected title and edits across hidden source boundaries retain exact previews and descriptive undo after reload', t => {
  const vault = vaultFor(t), first = vault.createNote('text', { title: 'Alpha title', body: 'Alpha body' });
  const second = vault.createNote('text', { title: 'Bravo title', body: 'Bravo body' });
  const merged = vault.mergeNotes([second, first]);
  assert.equal(vault.getNote(merged)!.title, 'Bravo title');
  assert.equal(vault.getNote(merged)!.body, 'Alpha title\n\nBravo body\n\nAlpha body');
  const versions = [capture(vault, merged)];
  vault.setNoteText(merged, 'title', 'Chosen title'); versions.push(capture(vault, merged));
  assert.match(versions.at(-1)!.boundary.description!, /Bravo.*Chosen/);
  vault.setNoteText(merged, 'body', 'One ordinary paragraph'); versions.push(capture(vault, merged));
  assert.match(versions.at(-1)!.boundary.description!, /Alpha title.*One ordinary paragraph/);
  const undo = vault.undo();
  assert.match(undo!, /One ordinary paragraph/);
  assert.equal(vault.getNote(merged)!.body, versions[1].note.body);
  versions.push(capture(vault, merged));
  assert.equal(vault.redo(), undo); versions.push(capture(vault, merged));
  const reloaded = vaultFor(t, vault);
  for (const { state, note } of versions) assert.deepEqual(snapshotNote(state), note);
  const restored = reloaded.getNote(reloaded.restoreHistoryState(versions[0].state))!;
  assert.equal(restored.sourceIds.length, 1);
  assert.equal(restored.title, versions[0].note.title); assert.equal(restored.body, versions[0].note.body);
  assert.equal(reloaded.getNote(merged)!.body, 'One ordinary paragraph');
});

test('a join-only body edit has exact Undo/Redo history even when no source timestamp changes', t => {
  t.mock.method(Date, 'now', () => 1000);
  const vault = vaultFor(t), a = vault.createNote('text', { title: 'First', body: 'First body' });
  const b = vault.createNote('text', { title: 'Second', body: 'Second body' });
  vault.mergeNotes([a, b]);
  const before = capture(vault, a), raw = [vault.getSource(a)!, vault.getSource(b)!].map(source => [source.title, source.body]);
  vault.setNoteText(a, 'body', before.note.body.replace('\n\n', '\nAuthored separator\n'));
  const edited = capture(vault, a);
  assert.deepEqual([vault.getSource(a)!, vault.getSource(b)!].map(source => [source.title, source.body]), raw);
  assert(diffHistory(before.state, edited.state).some(patch => patch.op === 'join-text'));
  assert(!diffHistory(before.state, edited.state).some(patch => patch.op === 'text' || patch.op === 'set'));
  assert.match(edited.boundary.description!, /Authored separator/);
  const undo = vault.undo(); assert.match(undo!, /Authored separator/);
  assert.deepEqual(vault.getNote(a), before.note);
  const undone = capture(vault, a);
  assert.equal(undone.boundary.action!.type, 'undo');
  assert(diffHistory(edited.state, undone.state).some(patch => patch.op === 'join-text'));
  assert.equal(vault.redo(), undo); assert.deepEqual(vault.getNote(a), edited.note);
  const redone = capture(vault, a), loaded = vaultFor(t, vault);
  for (const saved of [before, edited, undone, redone]) assert.deepEqual(snapshotNote(saved.state), saved.note);
  const copy = loaded.getNote(loaded.restoreHistoryState(edited.state))!;
  assert.equal(copy.sourceIds.length, 1); assert.equal(copy.body, edited.note.body);
  assert.equal(loaded.getSource(copy.id)!.body, edited.note.body, 'A restored copy has an ordinary body without hidden runs');
});

test('overlapping offline recipes retain independently edited joins in history, Undo/Redo and restored copies', t => {
  const left = vaultFor(t), a = left.createNote('text', { title: 'A title', body: 'A body' });
  const b = left.createNote('text', { title: 'B title', body: 'B body' });
  const c = left.createNote('text', { title: 'C title', body: 'C body' });
  const right = vaultFor(t, left);
  left.mergeNotes([a, b]); right.mergeNotes([b, c]);
  left.setNoteText(a, 'body', left.getNote(a)!.body.replace('\n\n', '\nLEFT JOIN WORDS\n'));
  right.setNoteText(b, 'body', right.getNote(b)!.body.replace('\n\n', '\nRIGHT JOIN WORDS\n'));
  const leftVersion = capture(left, a), rightVersion = capture(right, b);
  sync(left, right);
  const combined = left.getNote(a)!;
  for (const marker of ['LEFT JOIN WORDS', 'RIGHT JOIN WORDS']) assert.equal(combined.body.split(marker).length - 1, 1);
  assert.deepEqual(snapshotNote(leftVersion.state), leftVersion.note);
  assert.deepEqual(snapshotNote(rightVersion.state), rightVersion.note);
  const undo = left.undo(); assert.match(undo!, /LEFT JOIN WORDS/); assert.doesNotMatch(undo!, /RIGHT JOIN WORDS/);
  assert(!left.getNote(a)!.body.includes('LEFT JOIN WORDS'));
  assert(left.getNote(a)!.body.includes('RIGHT JOIN WORDS'));
  const undone = capture(left, a);
  assert.equal(left.redo(), undo);
  const redone = capture(left, a);
  for (const marker of ['LEFT JOIN WORDS', 'RIGHT JOIN WORDS']) assert(redone.note.body.includes(marker));
  const loaded = vaultFor(t, left);
  for (const saved of [leftVersion, rightVersion, undone, redone]) assert.deepEqual(snapshotNote(saved.state), saved.note);
  const copy = loaded.getNote(loaded.restoreHistoryState(redone.state))!;
  assert.equal(copy.sourceIds.length, 1); assert.equal(copy.body, redone.note.body);
});

test('late offline source text remains visible while its earlier merged history and later authored action stay distinct', t => {
  const left = vaultFor(t), a = left.createNote('text', { title: 'First', body: 'First body' });
  const b = left.createNote('text', { title: 'Second', body: 'Second body' });
  const offline = vaultFor(t, left);
  left.mergeNotes([a, b]); const merged = capture(left, a);
  offline.setNoteText(b, 'body', 'Second body with late text');
  const remote = capture(offline, b);
  sync(left, offline);
  assert(left.getNote(a)!.body.includes('with late text'));
  assert.deepEqual(snapshotNote(merged.state), merged.note);
  assert.deepEqual(snapshotNote(remote.state), remote.note);
  const observed = left.getNote(a)!.body;
  left.setNoteText(a, 'body', observed + ' locally appended');
  const combined = capture(left, a);
  assert.match(combined.boundary.description!, /locally appended/);
  assert.doesNotMatch(combined.boundary.description!, /late text/);
  const loaded = vaultFor(t, left);
  assert.deepEqual(snapshotNote(combined.state), combined.note);
  assert.deepEqual(snapshotNote(merged.state), merged.note);
});

test('Restore copy uses one fresh parent map across old source boundaries and does not revive deleted label generations', t => {
  const vault = vaultFor(t), a = vault.createNote('checklist', { title: 'One' }), b = vault.createNote('checklist', { title: 'Two' });
  const parent = vault.addItem(a, 'Parent'), child = vault.addItem(b, 'Child');
  vault.setNoteLabel(a, 'Past label', true); vault.setNoteLabel(b, 'Current label', true);
  vault.mergeNotes([a, b]);
  assert(vault.setItemParent(child, parent));
  vault.toggleItem(child);
  const merged = capture(vault, a);
  vault.deleteLabel('Past label');
  const loaded = vaultFor(t, vault), originalItems = new Set([parent, child]);
  const copy = loaded.getNote(loaded.restoreHistoryState(merged.state))!;
  assert.equal(copy.sourceIds.length, 1); assert.deepEqual(copy.labels, ['Current label']);
  const newParent = copy.items.find(item => item.text === 'Parent')!, newChild = copy.items.find(item => item.text === 'Child')!;
  assert.equal(newChild.parentId, newParent.id); assert.equal(newChild.checked, true);
  assert(copy.items.every(item => !originalItems.has(item.id) && item.noteId === copy.id));
  assert.deepEqual(snapshotNote(merged.state), merged.note);
});
