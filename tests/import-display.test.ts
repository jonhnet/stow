import { snapshotNote } from './history-state-fixture';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as Y from 'yjs';
import { applyImport, type ImportedNote } from '../src/core/import';
import { Vault } from '../src/core/vault';
import { effectiveLabels } from '../src/core/labels';

test('gray imported notes retain per-source labels through history, merge, binary reload and restore copies', t => {
  const first: ImportedNote = {
    id: 'imported-gray', title: 'Gray note', body: 'Imported text', kind: 'text', color: 'gray',
    pinned: false, archived: false, trashed: false, createdAt: 1, updatedAt: 2,
    labels: ['Shared', 'Travel'], items: [], images: [],
  };
  const second: ImportedNote = { ...first, id: 'imported-second', title: 'Second note', color: 'sage', createdAt: 3, labels: ['Shared', 'Audio'] };
  const vault = new Vault(); t.after(() => vault.destroy());
  applyImport(vault, { id: 'gray-labels-import', manifestHash: 'a'.repeat(64), notes: [first, second], replaceSourceIds: [] });
  assert.equal(vault.getNote(first.id)!.color, 'gray');
  assert.deepEqual(vault.getNote(first.id)!.labels, first.labels);
  const baseline = vault.captureHistoryState([first.id]);
  vault.setNoteText(first.id, 'body', 'Edited in Stow'); vault.finishEdit();
  assert.equal(snapshotNote(baseline)!.body, first.body);
  assert.deepEqual(snapshotNote(baseline)!.labels, first.labels);
  vault.mergeNotes([first.id, second.id]);
  const merged = vault.getNote(first.id)!;
  assert.deepEqual(merged.labels, ['Shared', 'Travel', 'Audio']);
  assert.deepEqual(merged.sourceIds.map(id => effectiveLabels(vault.notes.get(id)!, vault.labelLifecycle)), [first.labels, second.labels]);
  const merge = vault.captureHistoryState(merged.sourceIds);

  const reloaded = new Vault(); t.after(() => reloaded.destroy());
  Y.applyUpdate(reloaded.doc, Y.encodeStateAsUpdate(vault.doc), 'remote');
  const preview = snapshotNote(JSON.parse(JSON.stringify(merge)))!;
  assert.deepEqual(preview.labels, merged.labels);
  assert.equal(preview.body, merged.body);
  const restored = reloaded.getNote(reloaded.restoreHistoryState(merge))!;
  assert.deepEqual(restored.labels, merged.labels);
  assert.equal(restored.sourceIds.length, 1);
  assert.equal(restored.body, merged.body);
  assert.equal(restored.color, 'gray');
  assert.notDeepEqual(restored.sourceIds, merged.sourceIds);
  const originalCopy = reloaded.getNote(reloaded.restoreHistoryState(baseline))!;
  assert.equal(originalCopy.body, first.body);
  assert.equal(originalCopy.color, 'gray');
  assert.deepEqual(originalCopy.labels, first.labels);
});
