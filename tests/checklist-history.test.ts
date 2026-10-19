import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import * as Y from 'yjs';
import { applyHistory, diffHistory } from '../src/core/history';
import type { HistoryItem, HistoryState } from '../src/core/history-types';
import type { Note } from '../src/core/types';
import { Vault } from '../src/core/vault';
import { checklistGroups } from '../src/core/checklist';
import { snapshotNote, observeBoundaries, latestBoundary, captureSnapshot } from './history-state-fixture';

function vaultFor(t: TestContext, source?: Vault) {
  const vault = new Vault(); observeBoundaries(vault);
  t.after(() => vault.destroy());
  if (source) Y.applyUpdate(vault.doc, Y.encodeStateAsUpdate(source.doc), 'remote');
  return vault;
}
function finishAndLatest(vault: Vault, _id: string) { vault.finishEdit(); return latestBoundary(vault); }
function previewMatches(vault: Vault, id: string) {
  const snapshot = captureSnapshot(vault, id), boundary = latestBoundary(vault);
  assert.deepEqual(snapshot.note, vault.getNote(id));
  return { ...snapshot, boundary };
}
function state(items: Record<string, HistoryItem>): HistoryState {
  return { groups: [['note']], sources: { note: {
    title: 'History fixture', body: '', kind: 'checklist', color: 'default', pinned: false,
    archived: false, trashed: false, createdAt: 1, updatedAt: 2, images: {}, items,
  } } };
}
function assertCopiedParents(original: Note, copy: Note) {
  assert.equal(copy.items.length, original.items.length);
  const originals = new Map(original.items.map(item => [item.id, item]));
  const copies = new Map(copy.items.map(item => [item.text, item]));
  for (const item of original.items) {
    const copied = copies.get(item.text)!;
    assert.ok(copied);
    assert.ok(!originals.has(copied.id), 'Every copied checklist item has a fresh identity');
    assert.ok(!original.sourceIds.includes(copied.noteId));
    assert.equal(copied.checked, item.checked);
    assert.equal(copied.parentId, item.parentId ? copies.get(originals.get(item.parentId)!.text)!.id : undefined);
  }
}

test('parent history patches preserve raw IDs and remove the optional field without mutating their base', () => {
  const before = state({ parent: { text: 'Parent', checked: false, rank: 10 }, child: { text: 'Child', checked: false, rank: 20 } });
  const after = structuredClone(before);
  after.sources.note.items.child.parentId = 'parent';
  const changes = diffHistory(before, after);
  assert.deepEqual(changes, [{ op: 'item-parent', sourceId: 'note', itemId: 'child', value: 'parent' }]);
  assert.deepEqual(applyHistory(before, changes), after);
  assert.equal(before.sources.note.items.child.parentId, undefined);
  const remove = diffHistory(after, before);
  assert.deepEqual(remove, [{ op: 'item-parent', sourceId: 'note', itemId: 'child', value: null }]);
  const removed = applyHistory(after, remove);
  assert.deepEqual(removed, before);
  assert.ok(!Object.hasOwn(removed.sources.note.items.child, 'parentId'));
  assert.equal(after.sources.note.items.child.parentId, 'parent');
  assert.throws(() => applyHistory(before, [{ op: 'item-parent', sourceId: 'note', itemId: 'missing', value: 'parent' }]), /missing checklist item/);
});

test('history ordering keeps descendants with roots and legacy snapshots retain raw grouping references', () => {
  const raw = state({
    parent: { text: 'Parent', checked: false, rank: 30 },
    child: { text: 'Child', checked: false, rank: 20, parentId: 'parent' },
    descendant: { text: 'Concurrent descendant', checked: true, rank: 10, parentId: 'child' },
    first: { text: 'First', checked: false, rank: 1 },
  });
  const snapshot = snapshotNote(raw)!;
  assert.equal(snapshot.items[0].id, 'first');
  assert.equal(snapshot.items[1].id, 'parent');
  assert.equal(snapshot.items.find(item => item.id === 'descendant')!.parentId, 'child');
  assert.deepEqual(snapshotNote(JSON.parse(JSON.stringify(raw))), snapshot);
  assert.equal(raw.sources.note.sortOrderDate, undefined, 'Rendering leaves the supplied snapshot unchanged');
});

test('indent, group moves, child reparenting and outdent have exact immutable previews after reload', t => {
  const vault = vaultFor(t), id = vault.createNote('checklist');
  const parent = vault.addItem(id, 'Parent'), child = vault.addItem(id, 'Child'), other = vault.addItem(id, 'Other');
  const versions = [previewMatches(vault, id)];
  vault.indentItem(child);
  assert.equal(vault.getItems(id).find(item => item.id === child)!.parentId, parent);
  versions.push(previewMatches(vault, id));
  assert.ok(diffHistory(versions.at(-2)!.state, versions.at(-1)!.state).some(patch => patch.op === 'item-parent' && patch.itemId === child && patch.value === parent));

  vault.moveItemRelative(parent, other, 'after');
  assert.deepEqual(vault.getItems(id).map(item => item.id), [other, parent, child]);
  versions.push(previewMatches(vault, id));
  vault.setItemParent(child, other);
  assert.equal(vault.getItems(id).find(item => item.id === child)!.parentId, other);
  versions.push(previewMatches(vault, id));
  vault.outdentItem(child);
  assert.equal(vault.getItems(id).find(item => item.id === child)!.parentId, undefined);
  versions.push(previewMatches(vault, id));
  assert.ok(diffHistory(versions.at(-2)!.state, versions.at(-1)!.state).some(patch => patch.op === 'item-parent' && patch.itemId === child && patch.value === null));

  const reloaded = vaultFor(t, vault);
  for (const version of versions) {
    assert.deepEqual(snapshotNote(version.state), version.note);
    assert.deepEqual(snapshotNote(version.state), version.note);
  }
  assert.deepEqual(reloaded.getNote(id), vault.getNote(id));
});

test('indent and child reparent undo/redo record the actual parent changes in history', t => {
  const vault = vaultFor(t), id = vault.createNote('checklist');
  const parent = vault.addItem(id, 'Parent'), child = vault.addItem(id, 'Child'), other = vault.addItem(id, 'Other');
  vault.indentItem(child);
  const indented = previewMatches(vault, id);
  vault.undo();
  assert.equal(vault.getItems(id).find(item => item.id === child)!.parentId, undefined);
  assert.equal(finishAndLatest(vault, id).action!.type, 'undo');
  previewMatches(vault, id);
  vault.redo();
  assert.equal(vault.getItems(id).find(item => item.id === child)!.parentId, parent);
  assert.equal(finishAndLatest(vault, id).action!.type, 'redo');
  previewMatches(vault, id);
  vault.setItemParent(child, other);
  const reparented = previewMatches(vault, id);
  vault.undo();
  assert.equal(vault.getItems(id).find(item => item.id === child)!.parentId, parent);
  previewMatches(vault, id);
  vault.redo();
  assert.equal(vault.getItems(id).find(item => item.id === child)!.parentId, other);
  previewMatches(vault, id);
  assert.deepEqual(snapshotNote(indented.state), indented.note);
  assert.deepEqual(snapshotNote(reparented.state), reparented.note);
});

test('checking a parent records all group checks; deleting it records child promotion and undo restores the group', t => {
  const vault = vaultFor(t), id = vault.createNote('checklist');
  const parent = vault.addItem(id, 'Parent'), child = vault.addItem(id, 'Child'), sibling = vault.addItem(id, 'Sibling');
  vault.setItemParent(child, parent); vault.setItemParent(sibling, parent);
  const beforeCheck = vault.captureHistoryState([id]);
  vault.toggleItem(parent);
  assert.ok(vault.getItems(id).every(item => item.checked));
  const checked = previewMatches(vault, id);
  const checkedIds = diffHistory(beforeCheck, checked.state).flatMap(patch => patch.op === 'item-set' && patch.field === 'checked' ? [patch.itemId] : []);
  assert.deepEqual(new Set(checkedIds), new Set([parent, child, sibling]));
  vault.deleteItem(parent);
  const promoted = previewMatches(vault, id);
  assert.equal(vault.getItems(id).length, 2);
  assert.ok(vault.getItems(id).every(item => !item.parentId));
  vault.undo();
  assert.equal(vault.getItems(id).find(item => item.id === child)!.parentId, parent);
  assert.equal(vault.getItems(id).find(item => item.id === sibling)!.parentId, parent);
  previewMatches(vault, id);
  const reloaded = vaultFor(t, vault);
  assert.deepEqual(snapshotNote(checked.state), checked.note);
  assert.deepEqual(snapshotNote(promoted.state), promoted.note);
});

test('Restore copy flattens merged sources with fresh item and parent identities', t => {
  const vault = vaultFor(t), first = vault.createNote('checklist'), second = vault.createNote('checklist');
  const parent = vault.addItem(first, 'First parent'), child = vault.addItem(first, 'First child');
  const secondParent = vault.addItem(second, 'Second parent'), secondChild = vault.addItem(second, 'Second child');
  vault.setItemParent(child, parent); vault.setItemParent(secondChild, secondParent);
  vault.toggleItem(child);
  vault.mergeNotes([first, second]);
  const grouped = previewMatches(vault, first);
  vault.outdentItem(child);
  const reloaded = vaultFor(t, vault);
  const copiedId = reloaded.restoreHistoryState(grouped.state), copy = reloaded.getNote(copiedId)!;
  assert.equal(copy.sourceIds.length, 1);
  assertCopiedParents(grouped.note, copy);
  previewMatches(reloaded, copiedId);
  assert.equal(reloaded.getItems(first).find(item => item.id === child)!.parentId, undefined, 'Restoration does not rewrite the live original');
  assert.deepEqual(snapshotNote(grouped.state), grouped.note);
});

test('concurrent parent chains remain raw in history and restored IDs even when the effective view is one level', t => {
  const vault = vaultFor(t), id = vault.createNote('checklist');
  const parent = vault.addItem(id, 'Root'), child = vault.addItem(id, 'Middle'), descendant = vault.addItem(id, 'Leaf');
  // Model a converged offline relationship. The live API only authors one level.
  vault.doc.transact(() => {
    vault.items.get(child)!.set('parentId', parent);
    vault.items.get(descendant)!.set('parentId', child);
  }, 'remote');
  vault.setItemText(descendant, 'Leaf edited');
  const captured = previewMatches(vault, id);
  assert.equal(captured.note.items.find(item => item.id === descendant)!.parentId, child);
  const reloaded = vaultFor(t, vault);
  assert.deepEqual(snapshotNote(captured.state), captured.note);
  const copy = reloaded.getNote(reloaded.restoreHistoryState(captured.state))!;
  assertCopiedParents(captured.note, copy);
});

test('offline reparent branches keep their own previews while the shared parent and history converge', t => {
  const left = vaultFor(t), id = left.createNote('checklist');
  const first = left.addItem(id, 'First parent'), second = left.addItem(id, 'Second parent'), child = left.addItem(id, 'Child');
  const right = vaultFor(t, left);
  left.setItemParent(child, first);
  const leftVersion = previewMatches(left, id);
  right.setItemParent(child, second);
  const rightVersion = previewMatches(right, id);
  Y.applyUpdate(left.doc, Y.encodeStateAsUpdate(right.doc), 'remote');
  Y.applyUpdate(right.doc, Y.encodeStateAsUpdate(left.doc), 'remote');
  assert.deepEqual(left.getNote(id), right.getNote(id));
  for (const vault of [left, right]) {
    assert.deepEqual(snapshotNote(leftVersion.state), leftVersion.note);
    assert.deepEqual(snapshotNote(rightVersion.state), rightVersion.note);
  }
  const observed = left.captureHistoryState([id]);
  left.setItemText(child, 'Child after sync');
  const combined = previewMatches(left, id);
  assert.ok(!diffHistory(observed, combined.state).some(patch => patch.op === 'item-parent'), 'The authored text action does not claim a remotely received parent change');
  const reloaded = vaultFor(t, left);
  assert.deepEqual(snapshotNote(combined.state), combined.note);
});

test('moving one visible child out of a concurrent chain retains its visible sibling and records an exact undo', t => {
  const vault = vaultFor(t), id = vault.createNote('checklist');
  const parent = vault.addItem(id, 'Parent'), selected = vault.addItem(id, 'Selected'), sibling = vault.addItem(id, 'Sibling'), other = vault.addItem(id, 'Other');
  vault.doc.transact(() => {
    vault.items.get(selected)!.set('parentId', parent);
    vault.items.get(sibling)!.set('parentId', selected);
  }, 'remote');
  vault.setItemText(parent, 'Parent observed');
  const before = previewMatches(vault, id);
  const siblingRank = vault.items.get(sibling)!.get('rank');
  assert.ok(vault.moveItemRelative(selected, other, 'after', other));
  assert.deepEqual(checklistGroups(vault.getItems(id)).map(group => [group.root.id, group.children.map(item => item.id)]), [[parent, [sibling]], [other, [selected]]]);
  assert.equal(vault.items.get(sibling)!.get('parentId'), parent);
  assert.equal(vault.items.get(sibling)!.get('rank'), siblingRank, 'The retained sibling keeps its position');
  const after = previewMatches(vault, id);
  assert.ok(diffHistory(before.state, after.state).some(patch => patch.op === 'item-parent' && patch.itemId === sibling && patch.value === parent));
  vault.undo();
  const undone = vault.getNote(id)!;
  assert.deepEqual(undone, { ...before.note, updatedAt: undone.updatedAt });
  assert.ok(undone.updatedAt >= after.note.updatedAt);
  previewMatches(vault, id);
  vault.redo();
  const redone = vault.getNote(id)!;
  assert.deepEqual(redone, { ...after.note, updatedAt: redone.updatedAt });
  assert.ok(redone.updatedAt >= undone.updatedAt);
  previewMatches(vault, id);
  const reloaded = vaultFor(t, vault);
  assert.deepEqual(snapshotNote(before.state), before.note);
  assert.deepEqual(snapshotNote(after.state), after.note);
});
