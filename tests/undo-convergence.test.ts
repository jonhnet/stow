import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import * as Y from 'yjs';
import { Vault } from '../src/core/vault';
import { applyImport } from '../src/core/import';
import { assertNoReplicatedHistory } from './history-state-fixture';

function vaultFor(t: TestContext, source?: Vault) {
  const vault = new Vault();
  if (source) Y.applyUpdate(vault.doc, Y.encodeStateAsUpdate(source.doc), 'remote');
  t.after(() => vault.destroy());
  return vault;
}
function seed(vault: Vault, records: { id: string; labels?: string[]; body?: string }[]) {
  applyImport(vault, {
    id: 'undo-convergence-fixture', manifestHash: 'a'.repeat(64), replaceSourceIds: [],
    notes: records.map(({ id, labels = [], body = 'Base' }) => ({
      id, title: id, body, kind: 'text', color: 'default', pinned: false, archived: false, trashed: false,
      createdAt: 100, updatedAt: 200, items: [], images: [], labels,
    })),
  });
}
function receive(target: Vault, source: Vault) {
  Y.applyUpdate(target.doc, Y.encodeStateAsUpdate(source.doc), 'remote');
}
function sync(a: Vault, b: Vault) {
  a.finishEdit(); b.finishEdit();
  const fromA = Y.encodeStateAsUpdate(a.doc), fromB = Y.encodeStateAsUpdate(b.doc);
  Y.applyUpdate(a.doc, fromB, 'remote'); Y.applyUpdate(b.doc, fromA, 'remote');
  assert.deepEqual(a.getNotes(), b.getNotes());
  assert.deepEqual(a.getLabels(), b.getLabels());
  assertNoReplicatedHistory(a.doc); assertNoReplicatedHistory(b.doc);
}
function appendTyping(vault: Vault, id: string, text: string) {
  for (const character of text) vault.setNoteText(id, 'body', vault.getNote(id)!.body + character);
}

test('undo reports the actual popped text action when a newer local label setting was superseded remotely', t => {
  const a = vaultFor(t); seed(a, [{ id: 'note', labels: ['Shared'] }]);
  a.setNoteText('note', 'body', 'Base locally authored');
  a.setLabelColor('Shared', 'coral');
  assert.equal(a.undoManager.undoStack.length, 2);
  const b = vaultFor(t, a);
  b.setLabelColor('Shared', 'mint');
  receive(a, b);
  const description = a.undo();
  assert.equal(typeof description, 'string');
  assert.match(description!, /locally authored/);
  assert.doesNotMatch(description!, /coral|colored|Label:/);
  assert.equal(a.getNote('note')!.body, 'Base');
  assert.equal(a.getLabels().find(label => label.name === 'Shared')!.color, 'mint');
  assert.equal(a.undoManager.undoStack.length, 0, 'Obsolete setting is skipped before the prior text action is undone');
  assert.equal(a.redo(), description);
  assert.equal(a.getNote('note')!.body, 'Base locally authored');
  assert.equal(a.getLabels().find(label => label.name === 'Shared')!.color, 'mint');
  sync(a, b);
  const loaded = vaultFor(t, a);
  assert.equal(loaded.undo(), undefined, 'Reload does not invent a local undo action');
});

test('received text ends a local typing group and redo preserves remote insertions without naming them as local work', t => {
  t.mock.method(Date, 'now', () => 10_000); // All input events are inside the grouping interval.
  const a = vaultFor(t); seed(a, [{ id: 'note' }]);
  appendTyping(a, 'note', ' first local');
  assert.equal(a.undoManager.undoStack.length, 1);
  const b = vaultFor(t, a);
  b.setNoteText('note', 'body', 'REMOTE PREFIX ' + b.getNote('note')!.body);
  receive(a, b);
  appendTyping(a, 'note', ' second local');
  assert.equal(a.undoManager.undoStack.length, 2, 'A received change is an edit boundary even without an elapsed timeout');
  const second = a.undo();
  assert.match(second!, /second local/);
  assert.doesNotMatch(second!, /first local|REMOTE/);
  assert.equal(a.getNote('note')!.body, 'REMOTE PREFIX Base first local');

  b.setNoteText('note', 'body', b.getNote('note')!.body + ' REMOTE TAIL');
  receive(a, b);
  assert.equal(a.getNote('note')!.body, 'REMOTE PREFIX Base first local REMOTE TAIL');
  assert.equal(a.redo(), second);
  for (const text of ['REMOTE PREFIX', 'REMOTE TAIL', 'first local', 'second local']) assert(a.getNote('note')!.body.includes(text));
  assert.equal(a.undo(), second);
  assert.equal(a.getNote('note')!.body, 'REMOTE PREFIX Base first local REMOTE TAIL');
  const first = a.undo();
  assert.match(first!, /first local/);
  assert.doesNotMatch(first!, /second local|REMOTE/);
  assert.equal(a.getNote('note')!.body, 'REMOTE PREFIX Base REMOTE TAIL');
  assert.equal(a.redo(), first);
  for (const text of ['REMOTE PREFIX', 'REMOTE TAIL', 'first local']) assert(a.getNote('note')!.body.includes(text));
  sync(a, b);
});

test('global label settings converge across merge, separation and reload without carrying note snapshots', t => {
  const a = vaultFor(t); seed(a, [{ id: 'left', labels: ['Shared'] }, { id: 'right', labels: ['Other'] }, { id: 'unrelated' }]);
  const b = vaultFor(t, a);
  a.setLabelColor('Shared', 'coral'); b.setNoteLabel('right', 'Shared', true); b.setLabelColor('Other', 'mint');
  sync(a, b);
  assert.equal(a.getLabels().find(label => label.name === 'Shared')!.color, 'coral');
  assert.equal(a.getLabels().find(label => label.name === 'Other')!.color, 'mint');
  const merged = a.mergeNotes(['left', 'right']); sync(a, b);
  const loaded = vaultFor(t, a); assert.deepEqual(loaded.getNote(merged), a.getNote(merged));
  loaded.doc.transact(() => loaded.merges.clear(), 'remote');
  assert.deepEqual(loaded.getNote('left')!.labels, ['Shared']);
  assert.deepEqual(loaded.getNote('right')!.labels, ['Other', 'Shared']);
  assert.equal(loaded.getNote('unrelated')!.labels, undefined);
  assertNoReplicatedHistory(loaded.doc);
});

test('recreated label colors keep their generation when late original-generation settings and Undo/Redo arrive', t => {
  const a = vaultFor(t); seed(a, [{ id: 'old', labels: ['Shared'] }, { id: 'new' }]);
  a.setLabelColor('Shared', 'coral'); const stale = vaultFor(t, a);
  a.deleteLabel('Shared'); const generation = a.labelLifecycle.get('Shared')!.generation;
  a.setNoteLabel('new', 'Shared', true); a.setLabelColor('Shared', 'mint');
  stale.setLabelColor('Shared', 'peach'); sync(a, stale);
  assert.equal(a.getLabels().find(label => label.name === 'Shared')!.color, 'mint');
  assert.equal(a.getNote('old')!.labels, undefined); assert.deepEqual(a.getNote('new')!.labels, ['Shared']);
  assert.equal(a.labelLifecycle.get('Shared')!.generation, generation);
  const undo = a.undo(); assert.match(undo!, /Shared/); assert.match(undo!, /mint/); assert.doesNotMatch(undo!, /peach/);
  assert.equal(a.redo(), undo); sync(a, stale);
  const loaded = vaultFor(t, a);
  assert.equal(loaded.getLabels().find(label => label.name === 'Shared')!.color, 'mint');
  assert.equal(loaded.labelLifecycle.get('Shared')!.generation, generation);
  assertNoReplicatedHistory(loaded.doc);
});
