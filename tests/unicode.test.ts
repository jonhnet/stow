import { snapshotNote } from './history-state-fixture';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as Y from 'yjs';
import { textSplice } from '../src/core/text-splice';
import { Vault } from '../src/core/vault';
import type { Note } from '../src/core/types';

const sharedLowBefore = String.fromCodePoint(0x10000);
const sharedLowAfter = String.fromCodePoint(0x10400);

test('text splices retain complete surrogate pairs at both changed-span boundaries', () => {
  const cases: [string, string, ReturnType<typeof textSplice>][] = [
    ['A😀B', 'A😃B', { index: 1, remove: 2, insert: '😃' }],
    [`A${sharedLowBefore}B`, `A${sharedLowAfter}B`, { index: 1, remove: 2, insert: sharedLowAfter }],
    ['😀ab', '😀ac', { index: 3, remove: 1, insert: 'c' }],
    ['A😀B', 'AB', { index: 1, remove: 2, insert: '' }],
    ['AB', 'A😀B', { index: 1, remove: 0, insert: '😀' }],
    ['😀', '😀', { index: 2, remove: 0, insert: '' }],
    ['😀😃', '😃😀', { index: 0, remove: 4, insert: '😃😀' }],
    ['', '😃', { index: 0, remove: 0, insert: '😃' }],
  ];
  for (const [before, after, expected] of cases) {
    const patch = textSplice(before, after);
    assert.deepEqual(patch, expected);
    assert.equal(before.slice(0, patch.index) + patch.insert + before.slice(patch.index + patch.remove), after);
    assert.equal(Buffer.from(patch.insert, 'utf8').toString('utf8'), patch.insert, 'the inserted span must not contain an unpaired surrogate');
  }
});

function reload(source: Vault) {
  const replica = new Vault();
  Y.applyUpdate(replica.doc, Y.encodeStateAsUpdate(source.doc), 'remote');
  return replica;
}

for (const [description, from, to] of [
  ['emoji sharing a high surrogate', '😀', '😃'],
  ['supplementary characters sharing a low surrogate', sharedLowBefore, sharedLowAfter],
] as const) {
  for (const field of ['title', 'body', 'item'] as const) {
    test(`${field} replacement preserves ${description} in current state, standalone snapshots, binary reload, undo and redo`, () => {
      const vault = new Vault();
      const replicas: Vault[] = [];
      try {
        const before = `Before ${from} after`, after = `Before ${to} after`;
        const noteId = vault.createNote('checklist', { title: field === 'title' ? before : 'Title', body: field === 'body' ? before : 'Body' });
        const itemId = vault.addItem(noteId, field === 'item' ? before : 'Checklist item');
        const value = (note: Note) => field === 'item' ? note.items.find(item => item.id === itemId)!.text : note[field];
        const beforeSnapshot = vault.captureHistoryState([noteId]);
        vault.undoManager.clear();

        if (field === 'item') vault.setItemText(itemId, after);
        else vault.setNoteText(noteId, field, after);
        vault.finishEdit();
        const afterSnapshot = vault.captureHistoryState([noteId]);
        assert.equal(value(vault.getNote(noteId)!), after);
        assert.equal(value(snapshotNote(JSON.parse(JSON.stringify(beforeSnapshot)))!), before);
        assert.equal(value(snapshotNote(JSON.parse(JSON.stringify(afterSnapshot)))!), after);

        const firstReload = reload(vault); replicas.push(firstReload);
        assert.equal(value(firstReload.getNote(noteId)!), after);
        assert.equal(value(snapshotNote(JSON.parse(JSON.stringify(beforeSnapshot)))!), before);
        assert.equal(value(snapshotNote(JSON.parse(JSON.stringify(afterSnapshot)))!), after);

        vault.undo();
        const undoSnapshot = vault.captureHistoryState([noteId]);
        assert.equal(value(vault.getNote(noteId)!), before);
        assert.equal(value(snapshotNote(JSON.parse(JSON.stringify(undoSnapshot)))!), before);
        vault.redo();
        const redoSnapshot = vault.captureHistoryState([noteId]);
        assert.equal(value(vault.getNote(noteId)!), after);
        assert.equal(value(snapshotNote(JSON.parse(JSON.stringify(redoSnapshot)))!), after);

        const finalReload = reload(vault); replicas.push(finalReload);
        assert.equal(value(finalReload.getNote(noteId)!), after);
        for (const [snapshot, expected] of [[beforeSnapshot, before], [afterSnapshot, after], [undoSnapshot, before], [redoSnapshot, after]]) {
          assert.equal(value(snapshotNote(JSON.parse(JSON.stringify(snapshot)))!), expected);
        }
      } finally { vault.destroy(); replicas.forEach(replica => replica.destroy()); }
    });
  }
}

test('an emoji replacement converges with an offline insertion without replacing unrelated text', () => {
  const desktop = new Vault();
  const noteId = desktop.createNote('text', { body: 'A😀Z' });
  const phone = reload(desktop);
  try {
    desktop.setNoteText(noteId, 'body', 'A😃Z');
    phone.setNoteText(noteId, 'body', 'Remote A😀Z');
    const fromDesktop = Y.encodeStateAsUpdate(desktop.doc), fromPhone = Y.encodeStateAsUpdate(phone.doc);
    Y.applyUpdate(desktop.doc, fromPhone, 'remote');
    Y.applyUpdate(phone.doc, fromDesktop, 'remote');
    assert.equal(desktop.getNote(noteId)!.body, 'Remote A😃Z');
    assert.equal(phone.getNote(noteId)!.body, 'Remote A😃Z');
  } finally { desktop.destroy(); phone.destroy(); }
});
