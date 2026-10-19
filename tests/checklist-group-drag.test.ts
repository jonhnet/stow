import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import * as Y from 'yjs';
import { Vault } from '../src/core/vault';
import { checklistGroups } from '../src/core/checklist';

function setup(t: TestContext) {
  const vault = new Vault(); t.after(() => vault.destroy());
  const note = vault.createNote('checklist');
  const parent = vault.addItem(note, 'Parent');
  const children = ['One', 'Two', 'Three'].map(text => vault.addItem(note, text, parent));
  const target = vault.addItem(note, 'Target');
  const before = vault.addItem(note, 'Before', target), after = vault.addItem(note, 'After', target);
  const last = vault.addItem(note, 'Last');
  vault.undoManager.clear();
  return { vault, note, parent, children, target, before, after, last };
}
function layout(vault: Vault, note: string) {
  return checklistGroups(vault.getItems(note)).map(group => [group.root.text, group.children.map(child => child.text)]);
}

for (const nested of [false, true]) test(`dragging a root ${nested ? 'into a sublist flattens' : 'to the top level carries'} its three children as one undoable move`, t => {
  const { vault, note, parent, children, target, before, last } = setup(t);
  // Mixed checked states must survive both placements.
  vault.toggleItem(children[1]); vault.undoManager.clear();
  const original = vault.captureHistoryState([note]);
  const records = new Map(vault.getItems(note).map(item => [item.id, vault.items.get(item.id)!]));
  const text = records.get(children[1])!.get('text');
  assert.equal(vault.moveItemRelative(parent, nested ? before : last, 'after', nested ? target : null), true);
  const expected = nested
    ? [['Target', ['Before', 'Parent', 'One', 'Two', 'Three', 'After']], ['Last', []]]
    : [['Target', ['Before', 'After']], ['Last', []], ['Parent', ['One', 'Two', 'Three']]];
  assert.deepEqual(layout(vault, note), expected);
  for (const id of children) assert.equal(vault.items.get(id)!.get('parentId'), nested ? target : parent);
  const moved = vault.captureHistoryState([note]);
  assert.equal(vault.undoManager.undoStack.length, 1);
  vault.undo();
  assert.deepEqual(vault.captureHistoryState([note]).sources[note].items, original.sources[note].items);
  vault.redo();
  assert.deepEqual(vault.captureHistoryState([note]).sources[note].items, moved.sources[note].items);
  for (const [id, record] of records) assert.equal(vault.items.get(id), record);
  assert.equal(vault.items.get(children[1])!.get('text'), text);
  assert.equal(vault.items.get(children[1])!.get('checked'), true);
  const reloaded = new Vault(); t.after(() => reloaded.destroy());
  Y.applyUpdate(reloaded.doc, Y.encodeStateAsUpdate(vault.doc), 'remote');
  assert.deepEqual(reloaded.getNote(note), vault.getNote(note));
});

test('a carried group can split another group at a literal top-level slot', t => {
  const { vault, note, parent, before } = setup(t);
  assert.equal(vault.moveItemRelative(parent, before, 'after', null), true);
  assert.deepEqual(layout(vault, note), [['Target', ['Before']], ['Parent', ['One', 'Two', 'Three', 'After']], ['Last', []]]);
});

test('dragging a child still moves only that child, including outdent in place', t => {
  const { vault, note, children, target, before } = setup(t);
  vault.moveItemRelative(children[0], before, 'after', target);
  assert.deepEqual(layout(vault, note), [['Parent', ['Two', 'Three']], ['Target', ['Before', 'One', 'After']], ['Last', []]]);
  vault.undo();
  vault.moveItemRelative(children[0], children[1], 'before', null);
  assert.deepEqual(layout(vault, note), [['Parent', []], ['One', ['Two', 'Three']], ['Target', ['Before', 'After']], ['Last', []]]);
});

test('a group cannot target itself or its own children; returning to its original slot makes no edit', t => {
  const { vault, parent, children, target } = setup(t);
  const original = Y.encodeStateAsUpdate(vault.doc);
  for (const id of [parent, ...children]) for (const placement of ['before', 'after'] as const) {
    assert.equal(vault.moveItemRelative(parent, id, placement, null), false);
    assert.equal(vault.moveItemRelative(parent, id, placement, parent), false);
  }
  assert.equal(vault.moveItemRelative(parent, target, 'before', null), false);
  assert.deepEqual(Y.encodeStateAsUpdate(vault.doc), original);
  assert.equal(vault.undoManager.undoStack.length, 0);
});

for (const nested of [false, true]) test(`a ${nested ? 'flattened' : 'top-level'} group move converges with offline child edits and Undo preserves those edits`, t => {
  const { vault, note, parent, children, target, before, last } = setup(t);
  const remote = new Vault(); t.after(() => remote.destroy());
  Y.applyUpdate(remote.doc, Y.encodeStateAsUpdate(vault.doc), 'remote');
  vault.moveItemRelative(parent, nested ? before : last, 'after', nested ? target : null);
  remote.setItemText(children[0], 'One edited offline');
  remote.toggleItem(children[1]);
  const sync = () => {
    Y.applyUpdate(vault.doc, Y.encodeStateAsUpdate(remote.doc), 'remote');
    Y.applyUpdate(remote.doc, Y.encodeStateAsUpdate(vault.doc), 'remote');
    assert.deepEqual(remote.getNote(note), vault.getNote(note));
    assert.equal(vault.getItems(note).length, 8);
    assert.equal(vault.getItems(note).find(item => item.id === children[0])!.text, 'One edited offline');
    assert.equal(vault.getItems(note).find(item => item.id === children[1])!.checked, true);
  };
  sync();
  vault.undo(); sync();
  assert.deepEqual(layout(vault, note), [['Parent', ['One edited offline', 'Two', 'Three']], ['Target', ['Before', 'After']], ['Last', []]]);
  vault.redo(); sync();
  assert.deepEqual(layout(vault, note), nested
    ? [['Target', ['Before', 'Parent', 'One edited offline', 'Two', 'Three', 'After']], ['Last', []]]
    : [['Target', ['Before', 'After']], ['Last', []], ['Parent', ['One edited offline', 'Two', 'Three']]]);
});
