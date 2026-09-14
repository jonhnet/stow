import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import * as Y from 'yjs';
import { Vault } from '../src/core/vault';
import { checklistGroups, isChecklistGroupChecked, orderChecklistItems } from '../src/core/checklist';
import { applyImport, type ImportedNote } from '../src/core/import';
import type { Item } from '../src/core/types';

function vault(t: TestContext, source?: Vault) {
  const result = new Vault(); t.after(() => result.destroy());
  if (source) Y.applyUpdate(result.doc, Y.encodeStateAsUpdate(source.doc), 'remote');
  return result;
}
function sync(a: Vault, b: Vault) {
  const left = Y.encodeStateAsUpdate(a.doc), right = Y.encodeStateAsUpdate(b.doc);
  Y.applyUpdate(a.doc, right, 'remote'); Y.applyUpdate(b.doc, left, 'remote');
  assert.deepEqual(a.getNotes(), b.getNotes());
}
function groups(vault: Vault, noteId: string) {
  return checklistGroups(vault.getItems(noteId)).map(group => [group.root.text, group.children.map(item => item.text)]);
}

test('opening and projecting an existing flat document performs zero writes or parent-field synthesis', t => {
  const doc = new Y.Doc();
  const note = new Y.Map<any>(); doc.getMap('notes').set('note', note);
  for (const [key, value] of Object.entries({ title: new Y.Text('Existing'), body: new Y.Text(), kind: 'checklist', createdAt: 1, updatedAt: 2 })) note.set(key, value);
  for (const [index, text] of ['First', 'Second'].entries()) {
    const item = new Y.Map<any>(); doc.getMap('items').set(`item-${index}`, item);
    for (const [key, value] of Object.entries({ noteId: 'note', text: new Y.Text(text), checked: false, deleted: false, rank: index * 1024 })) item.set(key, value);
  }
  const before = Y.encodeStateAsUpdate(doc); let writes = 0; doc.on('update', () => writes++);
  const opened = new Vault(doc); t.after(() => opened.destroy());
  assert.deepEqual(opened.getItems('note').map(item => item.text), ['First', 'Second']);
  assert.equal(checklistGroups(opened.getItems('note')).length, 2);
  orderChecklistItems(opened.getItems('note')); opened.getNotes();
  assert.equal(writes, 0); assert.deepEqual(Y.encodeStateAsUpdate(doc), before);
  for (const item of opened.items.values()) assert.equal(item.has('parentId'), false);
});

test('one-level projection handles chains, cycles, missing and self parents while source ownership does not divide a logical checklist', () => {
  const row = (id: string, rank: number, parentId?: string, noteId = 'note'): Item => ({ id, noteId, rank, parentId, text: id, checked: false });
  const items = [row('a', 30, 'b'), row('b', 20, 'c'), row('c', 10, 'a'), row('descendant', 2, 'b'), row('orphan', 1, 'missing'), row('self', 8, 'self'), row('foreign', 5, 'a', 'other'), row('leaf', 4, 'middle'), row('middle', 3, 'root'), row('root', 9)];
  const before = structuredClone(items), first = checklistGroups(items), reverse = checklistGroups([...items].reverse());
  assert.deepEqual(first, reverse);
  assert.deepEqual(first.find(group => group.root.id === 'a')!.children.map(item => item.id), ['descendant', 'foreign', 'c', 'b']);
  assert.deepEqual(first.find(group => group.root.id === 'root')!.children.map(item => item.id), ['middle', 'leaf']);
  for (const id of ['orphan', 'self']) assert(first.some(group => group.root.id === id));
  const flat = orderChecklistItems(items);
  assert.equal(new Set(flat.map(item => item.id)).size, items.length);
  assert(flat.every(item => items.includes(item))); assert.deepEqual(items, before);
});

test('insertion respects sibling groups and moving a parent leaves child records and ranks unchanged', t => {
  const model = vault(t), note = model.createNote('checklist');
  const parent = model.addItem(note, 'Parent'), target = model.addItem(note, 'Target');
  model.addItemAfter(note, target, 'Following root');
  const first = model.addItem(note, 'First child', parent), last = model.addItem(note, 'Last child', parent);
  model.addItemAfter(note, first, 'Middle child');
  const inserted = model.addItemAfter(note, parent, 'New first child');
  assert.equal(model.items.get(inserted)!.get('parentId'), parent);
  assert.deepEqual(groups(model, note), [['Parent', ['New first child', 'First child', 'Middle child', 'Last child']], ['Target', []], ['Following root', []]]);
  model.undo();
  assert.deepEqual(groups(model, note)[0], ['Parent', ['First child', 'Middle child', 'Last child']]);
  model.redo();
  assert.deepEqual(groups(model, note)[0], ['Parent', ['New first child', 'First child', 'Middle child', 'Last child']]);
  const childRecord = model.items.get(last), childText = childRecord!.get('text'), ranks = model.getItems(note).filter(item => item.parentId === parent).map(item => [item.id, item.rank]);
  assert.equal(model.moveItemRelative(parent, target, 'after'), true);
  assert.deepEqual(groups(model, note), [['Target', []], ['Parent', ['New first child', 'First child', 'Middle child', 'Last child']], ['Following root', []]]);
  assert.equal(model.items.get(last), childRecord); assert.equal(model.items.get(last)!.get('text'), childText);
  assert.deepEqual(model.getItems(note).filter(item => item.parentId === parent).map(item => [item.id, item.rank]), ranks);
  assert.equal(model.setItemParent(parent, target), false);
});

test('explicit drop depth supports first-child insertion, reparenting and root anchors, while invalid targets are no-ops', t => {
  const model = vault(t), note = model.createNote('checklist');
  const parent = model.addItem(note, 'Parent'), other = model.addItem(note, 'Other'), leaf = model.addItem(note, 'Leaf');
  const first = model.addItem(note, 'First', parent), second = model.addItem(note, 'Second', parent), target = model.addItem(note, 'Target', other);
  assert.equal(model.moveItemRelative(leaf, parent, 'after', parent), true);
  assert.deepEqual(groups(model, note)[0], ['Parent', ['Leaf', 'First', 'Second']]);
  assert.equal(model.moveItemRelative(first, target, 'before'), true);
  assert.deepEqual(groups(model, note)[1], ['Other', ['First', 'Target']]);
  assert.equal(model.moveItemRelative(second, target, 'after', null), true);
  assert.deepEqual(groups(model, note), [['Parent', ['Leaf']], ['Other', ['First', 'Target']], ['Second', []]]);
  const before = Y.encodeStateAsUpdate(model.doc);
  assert.equal(model.moveItemRelative(leaf, target, 'before', parent), false);
  assert.equal(model.moveItemRelative(parent, target, 'after', other), false);
  assert.equal(model.moveItemRelative(leaf, parent, 'before', parent), false);
  assert.equal(model.setItemParent(leaf, leaf), false);
  assert.equal(model.setItemParent(leaf, 'missing'), false);
  assert.deepEqual(Y.encodeStateAsUpdate(model.doc), before);
});

test('outdent places a child immediately after its old group and keyboard indentation uses visible root groups', t => {
  const model = vault(t), note = model.createNote('checklist');
  const first = model.addItem(note, 'First'), checked = model.addItem(note, 'Completed'), last = model.addItem(note, 'Last');
  model.toggleItem(checked);
  assert.equal(model.indentItem(first), false); assert.equal(model.indentItem(last), true);
  assert.deepEqual(groups(model, note), [['First', ['Last']], ['Completed', []]]);
  const sibling = model.addItem(note, 'Sibling', first);
  assert.equal(model.outdentItem(last), true);
  assert.deepEqual(groups(model, note), [['First', ['Sibling']], ['Last', []], ['Completed', []]]);
  assert.equal(model.outdentItem(last), false);
  model.addItemAfter(note, sibling, 'Second sibling');
  model.moveItem(sibling, 1);
  assert.deepEqual(groups(model, note)[0], ['First', ['Second sibling', 'Sibling']]);
});

test('parent checking cascades observed children and mixed groups remain active without overriding the literal checkbox toggle', t => {
  const model = vault(t), note = model.createNote('checklist');
  const parent = model.addItem(note, 'Parent'), child = model.addItem(note, 'Child', parent);
  model.toggleItem(parent);
  assert(model.getItems(note).every(item => item.checked));
  model.toggleItem(child);
  let group = checklistGroups(model.getItems(note))[0];
  assert.equal(group.root.checked, true); assert.equal(isChecklistGroupChecked(group), false);
  model.toggleItem(parent);
  assert(model.getItems(note).every(item => !item.checked));
  model.toggleItem(parent);
  const offline = vault(t, model);
  offline.addItem(note, 'Late unchecked child', parent); sync(model, offline);
  group = checklistGroups(model.getItems(note))[0];
  assert.equal(group.root.checked, true); assert.equal(isChecklistGroupChecked(group), false);
  model.toggleItem(parent);
  assert(model.getItems(note).every(item => !item.checked));
  assert.equal(model.undo(), 'Unchecked “Parent”');
});

test('deleting a parent promotes children in place, leaves unrelated positions untouched and retains late child text', t => {
  const model = vault(t), note = model.createNote('checklist');
  const before = model.addItem(note, 'Before'), parent = model.addItem(note, 'Parent'), after = model.addItem(note, 'After');
  model.addItem(note, 'One', parent); model.addItem(note, 'Two', parent);
  const offline = vault(t, model);
  const untouched = [before, after].map(id => [id, model.items.get(id)!.get('parentId'), model.items.get(id)!.get('rank')]);
  model.deleteItem(parent);
  assert.deepEqual(groups(model, note), [['Before', []], ['One', []], ['Two', []], ['After', []]]);
  assert.deepEqual([before, after].map(id => [id, model.items.get(id)!.get('parentId'), model.items.get(id)!.get('rank')]), untouched);
  offline.setItemParent(after, before);
  offline.addItem(note, 'Late child text', parent); sync(model, offline);
  assert.equal(model.items.get(after)!.get('parentId'), before);
  assert(model.getItems(note).some(item => item.text === 'Late child text'));
  assert.equal(model.getItems(note).some(item => item.id === parent), false);
});

test('concurrent moves to different parents converge on one complete parent/rank pair', t => {
  const first = vault(t), note = first.createNote('checklist');
  const left = first.addItem(note, 'Left'), right = first.addItem(note, 'Right'), moved = first.addItem(note, 'Moved');
  first.addItem(note, 'Left child', left); first.addItem(note, 'Right child one', right); first.addItem(note, 'Right child two', right);
  const second = vault(t, first);
  first.setItemParent(moved, left); second.setItemParent(moved, right);
  const position = (model: Vault) => [model.items.get(moved)!.get('parentId'), model.items.get(moved)!.get('rank')];
  const choices = [position(first), position(second)]; assert.notEqual(choices[0][1], choices[1][1]);
  sync(first, second);
  assert(choices.some(choice => JSON.stringify(choice) === JSON.stringify(position(first))));
  assert.deepEqual(position(first), position(second));
});

test('concurrent cycles and children added while a parent moves converge without repair writes', t => {
  const first = vault(t), note = first.createNote('checklist');
  const a = first.addItem(note, 'A'), b = first.addItem(note, 'B'), other = first.addItem(note, 'Other');
  const second = vault(t, first);
  first.setItemParent(a, b); second.setItemParent(b, a);
  sync(first, second);
  const group = checklistGroups(first.getItems(note)).find(group => group.children.length)!;
  assert.equal(group.root.id, [a, b].sort()[0]);
  const before = Y.encodeStateAsUpdate(first.doc); checklistGroups(first.getItems(note));
  assert.deepEqual(Y.encodeStateAsUpdate(first.doc), before);
  const offline = vault(t, first);
  first.moveItemRelative(group.root.id, other, 'after', null);
  offline.addItem(note, 'Concurrent child', group.root.id); sync(first, offline);
  assert.deepEqual(checklistGroups(first.getItems(note)).at(-1)!.children.map(item => item.text).sort(), [group.children[0].text, 'Concurrent child'].sort());
});

test('Restore copy preserves cycle-root selection and rank ties while remapping every live parent ID', t => {
  const model = vault(t), note = model.createNote('checklist');
  const ids = [model.addItem(note, 'A'), model.addItem(note, 'B'), model.addItem(note, 'C')];
  model.doc.transact(() => ids.forEach((id, index) => { model.items.get(id)!.set('parentId', ids[(index + 1) % ids.length]); model.items.get(id)!.set('rank', 1024); }), 'remote');
  model.setNoteText(note, 'title', 'Capture cycle'); model.finishEdit();
  const copy = model.restoreHistoryState(model.captureHistoryState([note]));
  assert.deepEqual(groups(model, copy), groups(model, note));
  const copied = model.getItems(copy), copiedIds = new Set(copied.map(item => item.id));
  assert(copied.every(item => !ids.includes(item.id) && item.parentId && copiedIds.has(item.parentId)));
});

test('moving or deleting a visible child in a concurrent chain preserves its observed siblings', t => {
  for (const operation of ['move', 'outdent', 'delete'] as const) {
    const model = vault(t), note = model.createNote('checklist');
    const root = model.addItem(note, 'Root'), target = model.addItem(note, 'Target');
    const moved = model.addItem(note, 'Moved', root), sibling = model.addItem(note, 'Sibling', root), deep = model.addItem(note, 'Deeper sibling', root);
    model.doc.transact(() => { model.items.get(sibling)!.set('parentId', moved); model.items.get(deep)!.set('parentId', sibling); }, 'remote');
    assert.deepEqual(groups(model, note), [['Root', ['Moved', 'Sibling', 'Deeper sibling']], ['Target', []]]);
    if (operation === 'move') assert.equal(model.moveItemRelative(moved, target, 'after', target), true);
    else if (operation === 'outdent') assert.equal(model.outdentItem(moved), true);
    else model.deleteItem(moved);
    const oldGroup = checklistGroups(model.getItems(note)).find(group => group.root.id === root)!;
    assert.deepEqual(oldGroup.children.map(item => item.text), ['Sibling', 'Deeper sibling']);
    assert.equal(model.items.get(sibling)!.get('parentId'), root);
    assert.equal(model.items.get(deep)!.get('parentId'), sibling);
    if (operation === 'move') assert.deepEqual(groups(model, note).at(-1), ['Target', ['Moved']]);
    if (operation === 'outdent') assert.deepEqual(groups(model, note), [['Root', ['Sibling', 'Deeper sibling']], ['Moved', []], ['Target', []]]);
    model.undo();
    assert.equal(model.items.get(sibling)!.get('parentId'), moved);
    assert.deepEqual(groups(model, note), [['Root', ['Moved', 'Sibling', 'Deeper sibling']], ['Target', []]]);
  }
});

test('moving, outdenting or deleting a visible cycle child leaves the old root and siblings together', t => {
  for (const operation of ['move', 'outdent', 'delete'] as const) {
    const model = vault(t), note = model.createNote('checklist');
    const first = model.addItem(note, 'First'), second = model.addItem(note, 'Second'), target = model.addItem(note, 'Target');
    model.doc.transact(() => { model.items.get(first)!.set('parentId', second); model.items.get(second)!.set('parentId', first); }, 'remote');
    const original = checklistGroups(model.getItems(note)).find(group => group.children.length)!;
    const moving = original.children[0].id, sibling = model.addItem(note, 'Observed sibling', original.root.id);
    model.doc.transact(() => model.items.get(sibling)!.set('parentId', moving), 'remote');
    if (operation === 'move') assert.equal(model.moveItemRelative(moving, target, 'after', target), true);
    else if (operation === 'outdent') assert.equal(model.outdentItem(moving), true);
    else model.deleteItem(moving);
    assert.equal(model.items.get(original.root.id)!.get('parentId'), null);
    assert.equal(model.items.get(sibling)!.get('parentId'), original.root.id);
    const retained = checklistGroups(model.getItems(note)).find(group => group.root.id === original.root.id)!;
    assert.deepEqual(retained.children.map(item => item.id), [sibling]);
    assert(retained.children.every(item => item.id !== moving));
  }
});

test('explicit bulk imports preserve valid parents and reject missing, foreign or deeper relationships atomically', t => {
  const model = vault(t);
  const note: ImportedNote = { id: 'imported', title: '', body: '', kind: 'checklist', color: 'default', pinned: false, archived: false, trashed: false, createdAt: 0, updatedAt: 1, images: [], items: [
    { id: 'parent', noteId: 'imported', text: 'Parent', checked: false, rank: 1024 },
    { id: 'child', noteId: 'imported', text: 'Child', checked: false, rank: 1024, parentId: 'parent' },
  ] };
  applyImport(model, { id: 'first', manifestHash: 'a'.repeat(64), notes: [note], replaceSourceIds: [] });
  assert.deepEqual(groups(model, note.id), [['Parent', ['Child']]]);
  const before = Y.encodeStateAsUpdate(model.doc);
  for (const parentId of ['missing', 'child']) {
    const invalid = structuredClone(note); invalid.items[0].parentId = parentId;
    assert.throws(() => applyImport(model, { id: `invalid-${parentId}`, manifestHash: 'b'.repeat(64), notes: [invalid], replaceSourceIds: [note.id] }), /different root/);
    assert.deepEqual(Y.encodeStateAsUpdate(model.doc), before);
  }
});
