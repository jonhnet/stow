import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import * as Y from 'yjs';
import { Vault } from '../src/core/vault';
import { diffHistory } from '../src/core/history';
import { checklistGroups, orderComponentChecklist } from '../src/core/checklist';

function model(t: TestContext, source?: Vault) {
  const vault = new Vault(); t.after(() => vault.destroy());
  if (source) Y.applyUpdate(vault.doc, Y.encodeStateAsUpdate(source.doc), 'remote');
  return vault;
}
function sync(a: Vault, b: Vault) {
  const first = Y.encodeStateAsUpdate(a.doc), second = Y.encodeStateAsUpdate(b.doc);
  Y.applyUpdate(a.doc, second, 'remote'); Y.applyUpdate(b.doc, first, 'remote');
  assert.deepEqual(a.getNotes(), b.getNotes());
}
const ids = (vault: Vault, id: string) => vault.getItems(id).map(item => item.id);
const families = (vault: Vault, id: string) => checklistGroups(vault.getItems(id)).map(group => [group.root.id, group.children.map(item => item.id)]);

test('merge selection order produces one checklist while retaining item records, ownership, groups and completed states', t => {
  const vault = model(t), first = vault.createNote('checklist'), second = vault.createNote('checklist');
  const a = vault.addItem(first, 'A'), ac = vault.addItem(first, 'A child', a), az = vault.addItem(first, 'A last');
  const b = vault.addItem(second, 'B'), bc = vault.addItem(second, 'B child', b), bz = vault.addItem(second, 'B last');
  vault.toggleItem(b); vault.toggleItem(az);
  const records = new Map([...vault.items].map(([id, item]) => [id, { item, text: item.get('text'), owner: item.get('noteId') }]));
  const merged = vault.mergeNotes([second, first]);
  assert.deepEqual(ids(vault, merged), [b, bc, bz, a, ac, az]);
  assert.deepEqual(ids(vault, first), ids(vault, second));
  assert.deepEqual(families(vault, merged), [[b, [bc]], [bz, []], [a, [ac]], [az, []]]);
  assert.equal(vault.getNote(merged)!.kind, 'checklist');
  assert.equal('sections' in vault.getNote(merged)!, false);
  for (const [id, record] of records) {
    assert.equal(vault.items.get(id), record.item);
    assert.equal(vault.items.get(id)!.get('text'), record.text);
    assert.equal(vault.items.get(id)!.get('noteId'), record.owner);
  }
  assert.deepEqual(vault.getItems(merged).filter(item => item.checked).map(item => item.id), [b, bc, az]);
  vault.undo();
  assert.equal(vault.getNotes().length, 2);
  assert.deepEqual(ids(vault, first), [a, ac, az]);
  assert.deepEqual(ids(vault, second), [b, bc, bz]);
  vault.redo();
  assert.deepEqual(ids(vault, merged), [b, bc, bz, a, ac, az]);
  assert.deepEqual(model(t, vault).getNotes(), vault.getNotes());
});

test('cross-source moves, indentation and insertion use the whole logical list and undo preserves source identity', t => {
  const vault = model(t), first = vault.createNote('checklist'), second = vault.createNote('checklist');
  const a = vault.addItem(first, 'A'), leaf = vault.addItem(first, 'Leaf');
  const b = vault.addItem(second, 'B'), child = vault.addItem(second, 'B child', b);
  const merged = vault.mergeNotes([first, second]);
  vault.undoManager.clear();
  assert.equal(vault.moveItemRelative(b, a, 'before'), true);
  assert.deepEqual(families(vault, merged), [[b, []], [a, []], [leaf, [child]]]);
  vault.undo(); assert.deepEqual(families(vault, merged), [[a, []], [leaf, []], [b, [child]]]);
  assert.equal(vault.setItemParent(leaf, b), true);
  assert.deepEqual(families(vault, merged), [[a, []], [b, [child, leaf]]]);
  assert.equal(vault.items.get(leaf)!.get('noteId'), first);
  const inserted = vault.addItemAfter(merged, b, 'Inserted first child');
  assert.equal(vault.items.get(inserted)!.get('parentId'), b);
  assert.deepEqual(families(vault, merged), [[a, []], [b, [inserted, child, leaf]]]);
  vault.moveItem(inserted, 1);
  assert.deepEqual(families(vault, merged), [[a, []], [b, [child, inserted, leaf]]]);
  assert.equal(vault.outdentItem(leaf), true);
  assert.deepEqual(families(vault, merged), [[a, []], [b, [child, inserted]], [leaf, []]]);
  assert.equal(vault.indentItem(leaf), true);
  assert.deepEqual(families(vault, merged), [[a, []], [b, [child, inserted, leaf]]]);
});

test('indenting a merged parent records every new sibling parent and undo preserves offline child edits', t => {
  const desktop = model(t), first = desktop.createNote('checklist'), second = desktop.createNote('checklist'), third = desktop.createNote('checklist');
  const a = desktop.addItem(first, 'A'), b = desktop.addItem(second, 'B'), c = desktop.addItem(third, 'C'), d = desktop.addItem(third, 'D');
  const merged = desktop.mergeNotes([first, second, third]);
  desktop.indentItem(c);
  const phone = model(t, desktop), before = desktop.captureHistoryState([merged]);
  const cRecord = desktop.items.get(c), cText = cRecord!.get('text');
  desktop.undoManager.clear();
  assert.equal(desktop.indentItem(b), true);
  assert.deepEqual(families(desktop, merged), [[a, [b, c]], [d, []]]);
  const changes = diffHistory(before, desktop.captureHistoryState([merged]));
  assert.deepEqual(changes.filter(change => change.op === 'item-parent').map(change => [change.sourceId, change.itemId, change.value]).sort(), [[second, b, a], [third, c, a]].sort());
  phone.setItemText(c, 'C edited offline'); phone.toggleItem(c);
  const late = phone.addItem(merged, 'Late child', b);
  sync(desktop, phone);
  desktop.undo(); sync(desktop, phone);
  assert.equal(desktop.items.get(b)!.get('parentId'), null);
  assert.equal(desktop.items.get(c)!.get('parentId'), b);
  assert.equal(desktop.items.get(late)!.get('parentId'), b);
  assert.equal(desktop.items.get(c), cRecord); assert.equal(cRecord!.get('text'), cText);
  assert.equal(cRecord!.get('noteId'), third);
  assert.equal(cText.toString(), 'C edited offline'); assert.equal(cRecord!.get('checked'), true);
});

test('outdenting across merged sources records adopted children and preserves their offline edits through undo', t => {
  const desktop = model(t), first = desktop.createNote('checklist'), second = desktop.createNote('checklist');
  const a = desktop.addItem(first, 'A'), b = desktop.addItem(first, 'B'), c = desktop.addItem(second, 'C'), d = desktop.addItem(second, 'D');
  const merged = desktop.mergeNotes([first, second]);
  for (const id of [b, c, d]) desktop.indentItem(id);
  const phone = model(t, desktop), before = desktop.captureHistoryState([merged]);
  const records = [b, c, d].map(id => desktop.items.get(id));
  desktop.undoManager.clear();
  assert.equal(desktop.outdentItem(b), true);
  assert.deepEqual(families(desktop, merged), [[a, []], [b, [c, d]]]);
  const changes = diffHistory(before, desktop.captureHistoryState([merged]));
  assert.deepEqual(changes.filter(change => change.op === 'item-parent').map(change => [change.sourceId, change.itemId, change.value]).sort(), [[first, b, null], [second, c, b], [second, d, b]].sort());
  phone.setItemText(c, 'C edited offline'); phone.toggleItem(d);
  sync(desktop, phone);
  desktop.undo(); sync(desktop, phone);
  assert.deepEqual(families(desktop, merged), [[a, [b, c, d]]]);
  assert.equal(desktop.items.get(c)!.get('noteId'), second);
  assert.equal(desktop.items.get(c)!.get('text').toString(), 'C edited offline');
  assert.equal(desktop.items.get(d)!.get('checked'), true);
  [b, c, d].forEach((id, index) => assert.equal(desktop.items.get(id), records[index]));
});

test('checking a cross-source family timestamps and records every changed owning source, and leaves other sources untouched', t => {
  const vault = model(t), first = vault.createNote('checklist'), second = vault.createNote('checklist'), third = vault.createNote('checklist');
  const a = vault.addItem(first, 'A'), b = vault.addItem(second, 'B'), bc = vault.addItem(second, 'B child', b), c = vault.addItem(third, 'Untouched');
  const merged = vault.mergeNotes([first, second, third]);
  assert.equal(vault.setItemParent(a, b), true);
  vault.doc.transact(() => [first, second, third].forEach(id => vault.notes.get(id)!.set('updatedAt', 0)), 'remote');
  const beforeCheck = vault.captureHistoryState([first, second, third]);
  vault.toggleItem(b);
  assert.deepEqual(new Set(vault.getItems(merged).filter(item => item.checked).map(item => item.id)), new Set([a, b, bc]));
  assert.equal(vault.getItems(merged).find(item => item.id === c)!.checked, false);
  assert.equal(vault.notes.get(first)!.get('updatedAt'), vault.notes.get(second)!.get('updatedAt'));
  assert(Number(vault.notes.get(first)!.get('updatedAt')) > 0);
  assert.equal(vault.notes.get(third)!.get('updatedAt'), 0);
  const changed = diffHistory(beforeCheck, vault.captureHistoryState([first, second, third])).filter(change => change.op === 'item-set' && change.field === 'checked');
  assert.deepEqual(new Set(changed.map(change => 'sourceId' in change && change.sourceId)), new Set([first, second]));
  vault.undo(); assert(vault.getItems(merged).every(item => !item.checked));
  vault.redo(); assert.equal(vault.getItems(merged).find(item => item.id === a)!.checked, true);
});

test('cross-source raw-chain moves detach only the selected visible child and parent deletion promotes all sources in place', t => {
  const vault = model(t), first = vault.createNote('checklist'), second = vault.createNote('checklist');
  const a = vault.addItem(first, 'A'), moved = vault.addItem(first, 'Moved');
  const b = vault.addItem(second, 'B'), sibling = vault.addItem(second, 'Sibling', b), tail = vault.addItem(second, 'Tail');
  const merged = vault.mergeNotes([first, second]);
  vault.setItemParent(moved, b);
  vault.doc.transact(() => vault.items.get(sibling)!.set('parentId', moved), 'remote');
  const before = families(vault, merged);
  assert.equal(vault.moveItemRelative(moved, a, 'after', a), true);
  assert.equal(vault.items.get(sibling)!.get('parentId'), b);
  assert.equal(vault.items.get(moved)!.get('parentId'), a);
  vault.undo();
  assert.equal(vault.items.get(sibling)!.get('parentId'), moved);
  assert.deepEqual(families(vault, merged), before);
  const children = checklistGroups(vault.getItems(merged)).find(group => group.root.id === b)!.children.map(item => item.id);
  vault.deleteItem(b);
  assert.deepEqual(families(vault, merged), [[a, []], ...children.map(id => [id, []]), [tail, []]]);
  assert.equal(vault.items.get(moved)!.get('noteId'), first);
  assert.equal(vault.items.get(sibling)!.get('noteId'), second);
  vault.undo(); assert.deepEqual(families(vault, merged), before);
});

test('late offline text, checked state and new children survive merging and a cross-source reorder undo', t => {
  const desktop = model(t), first = desktop.createNote('checklist'), second = desktop.createNote('checklist');
  const a = desktop.addItem(first, 'A'), moved = desktop.addItem(first, 'Moved');
  const b = desktop.addItem(second, 'B');
  const phone = model(t, desktop), record = desktop.items.get(moved), text = record!.get('text');
  const merged = desktop.mergeNotes([first, second]);
  desktop.setItemParent(moved, b);
  phone.setItemText(moved, 'Changed while offline'); phone.toggleItem(moved);
  const late = phone.addItem(second, 'Late child', b);
  sync(desktop, phone);
  assert.deepEqual(new Set(ids(desktop, merged)), new Set([a, moved, b, late]));
  assert.equal(desktop.items.get(moved), record); assert.equal(record!.get('text'), text);
  assert.equal(desktop.getItems(merged).find(item => item.id === moved)!.text, 'Changed while offline');
  assert.equal(desktop.getItems(merged).find(item => item.id === moved)!.checked, true);
  desktop.undo(); sync(desktop, phone);
  assert.equal(desktop.items.get(moved)!.get('parentId'), null);
  assert.equal(desktop.getItems(merged).find(item => item.id === moved)!.text, 'Changed while offline');
  assert.equal(desktop.getItems(merged).find(item => item.id === moved)!.checked, true);
  assert.equal(desktop.items.get(late)!.get('parentId'), b);
});

test('legacy graph-only merges have zero read-time writes and materialize ranks only in an explicit structural action', t => {
  const vault = model(t), first = vault.createNote('checklist'), second = vault.createNote('checklist');
  const a = vault.addItem(first, 'A'), ac = vault.addItem(first, 'A child', a), az = vault.addItem(first, 'A last');
  const b = vault.addItem(second, 'B'), bc = vault.addItem(second, 'B child', b);
  vault.doc.transact(() => {
    vault.notes.get(first)!.set('createdAt', 1); vault.notes.get(second)!.set('createdAt', 2);
    vault.merges.set('old-edge', { a: first, b: second });
  }, 'remote');
  const before = Y.encodeStateAsUpdate(vault.doc), ranks = new Map([...vault.items].map(([id, item]) => [id, item.get('rank')]));
  let writes = 0; vault.doc.on('update', () => writes++);
  assert.deepEqual(ids(vault, first), [a, ac, az, b, bc]);
  vault.getNotes(); vault.getItems(second);
  assert.equal(writes, 0); assert.deepEqual(Y.encodeStateAsUpdate(vault.doc), before);
  vault.undoManager.clear(); vault.moveItemRelative(b, az, 'before');
  assert.deepEqual(ids(vault, first), [a, ac, b, az, bc]);
  assert.equal(vault.notes.get(first)!.get('unifiedChecklist'), true);
  assert.equal(vault.notes.get(second)!.get('unifiedChecklist'), true);
  assert.equal(vault.undoManager.undoStack.length, 1);
  vault.undo();
  assert.equal(vault.notes.get(first)!.has('unifiedChecklist'), false);
  assert.equal(vault.notes.get(second)!.has('unifiedChecklist'), false);
  assert.deepEqual(new Map([...vault.items].map(([id, item]) => [id, item.get('rank')])), ranks);
  assert.deepEqual(ids(vault, first), [a, ac, az, b, bc]);
  assert.deepEqual(model(t, vault).getNotes(), vault.getNotes());
});

test('editing and checking legacy merged items leave source-local ranks, markers and unrelated timestamps untouched', t => {
  const vault = model(t), first = vault.createNote('checklist'), second = vault.createNote('checklist');
  const a = vault.addItem(first, 'A'), b = vault.addItem(second, 'B'), bc = vault.addItem(second, 'B child', b);
  vault.doc.transact(() => {
    vault.notes.get(first)!.set('createdAt', 1); vault.notes.get(second)!.set('createdAt', 2);
    vault.notes.get(first)!.set('updatedAt', 0); vault.notes.get(second)!.set('updatedAt', 0);
    vault.merges.set('old-edge', { a: first, b: second });
  }, 'remote');
  const ranks = new Map([...vault.items].map(([id, item]) => [id, item.get('rank')]));
  const unchangedRanks = () => {
    assert.deepEqual(new Map([...vault.items].map(([id, item]) => [id, item.get('rank')])), ranks);
    assert.equal(vault.notes.get(first)!.has('unifiedChecklist'), false);
    assert.equal(vault.notes.get(second)!.has('unifiedChecklist'), false);
    assert.equal(vault.notes.get(first)!.get('updatedAt'), 0);
    assert.deepEqual(ids(vault, first), [a, b, bc]);
  };
  vault.setItemText(bc, 'Updated child'); unchangedRanks();
  const beforeCheck = vault.captureHistoryState([first, second]);
  vault.toggleItem(b); unchangedRanks();
  assert.deepEqual(vault.getItems(first).filter(item => item.checked).map(item => item.id), [b, bc]);
  const changes = diffHistory(beforeCheck, vault.captureHistoryState([first, second]));
  assert(changes.every(change => !('sourceId' in change) || change.sourceId === second));
  assert(changes.every(change => change.op !== 'item-set' || change.field !== 'rank'));
  vault.undo(); unchangedRanks();
  assert(vault.getItems(first).every(item => !item.checked));
});

test('overlapping concurrent merges converge on all checklist families without recreating items', t => {
  const first = model(t), sources = ['A', 'B', 'C'].map(title => first.createNote('checklist', { title }));
  const pairs = sources.map((id, index) => { const root = first.addItem(id, `Root ${index}`); return [root, first.addItem(id, `Child ${index}`, root)]; });
  const second = model(t, first);
  first.mergeNotes([sources[1], sources[0]]); second.mergeNotes([sources[2], sources[1]]);
  sync(first, second);
  assert.equal(first.getNotes().length, 1);
  assert.deepEqual(new Set(ids(first, sources[0])), new Set(pairs.flat()));
  for (const [root, child] of pairs) assert.deepEqual(checklistGroups(first.getItems(sources[0])).find(group => group.root.id === root)!.children.map(item => item.id), [child]);
  const before = Y.encodeStateAsUpdate(first.doc); first.getNotes(); first.getItems(sources[2]);
  assert.deepEqual(Y.encodeStateAsUpdate(first.doc), before);
});

test('component ordering derives legacy ranks without mutating raw source items', () => {
  const item = (id: string, noteId: string, rank: number, parentId?: string) => ({ id, noteId, rank, parentId });
  const sources = [{ id: 'a', items: [item('a-root', 'a', 1024), item('a-child', 'a', 1024, 'a-root'), item('a-last', 'a', 2048)] }, { id: 'b', items: [item('b-root', 'b', 1024), item('b-last', 'b', 2048)] }];
  const before = structuredClone(sources);
  assert.deepEqual(orderComponentChecklist(sources).map(item => item.id), ['a-root', 'a-child', 'a-last', 'b-root', 'b-last']);
  assert.deepEqual(orderComponentChecklist([...sources].reverse()).map(item => item.id), ['b-root', 'b-last', 'a-root', 'a-child', 'a-last']);
  assert.deepEqual(sources, before);
});
