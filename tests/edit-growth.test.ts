import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as Y from 'yjs';
import { Vault } from '../src/core/vault';
import { observeBoundaries, assertNoReplicatedHistory } from './history-state-fixture';

test('a thousand immediately replicated keystrokes create one completed boundary without replicated history', t => {
  let now = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const vault = new Vault(), peer = new Y.Doc();
  t.after(() => { vault.destroy(); peer.destroy(); });
  const boundaries = observeBoundaries(vault);
  const id = vault.createNote('text', { title: 'Typing' });
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(vault.doc));
  const baseline = Y.encodeStateAsUpdate(peer).length;
  const initialBoundaries = boundaries.length;
  const initialModified = vault.getNote(id)!.updatedAt;
  let updates = 0;
  vault.doc.on('update', update => { updates++; Y.applyUpdate(peer, update); });

  for (let count = 1; count <= 1000; count++) {
    now += 80;
    vault.setNoteText(id, 'body', 'x'.repeat(count));
    const remote = peer.getMap<Y.Map<any>>('notes').get(id)!;
    assert.equal(remote.get('body').toString().length, count, 'Text reaches the peer before an edit boundary');
  }
  assert.equal(updates, 1000, 'Every input still produces a live update');
  assert.equal(vault.getNote(id)!.updatedAt, initialModified, 'Typing does not advance modification time');
  assert.equal(boundaries.length, initialBoundaries); assertNoReplicatedHistory(peer);
  const lastInput = now;
  now += 5000;
  vault.finishEdit();
  assert.equal(vault.getNote(id)!.updatedAt, lastInput);
  assert.equal(boundaries.length, initialBoundaries + 1); assertNoReplicatedHistory(peer);
  const growth = Y.encodeStateAsUpdate(peer).length - baseline;
  assert(growth < 8000, `A single 1000-character edit grew by ${growth} bytes`);

  const reloaded = new Vault();
  t.after(() => reloaded.destroy());
  Y.applyUpdate(reloaded.doc, Y.encodeStateAsUpdate(peer), 'remote');
  assert.equal(boundaries.at(-1)!.editedAt, lastInput);
  assert.equal(reloaded.getNote(id)!.body, 'x'.repeat(1000));
  assert.equal(reloaded.getNote(id)!.updatedAt, lastInput);
});

test('a hundred completed edits retain current text and completion time without a client history collection', t => {
  const vault = new Vault();
  t.after(() => vault.destroy());
  const id = vault.createNote('text', { title: 'Several edits' });
  const boundaries = observeBoundaries(vault);
  const initialBytes = Y.encodeStateAsUpdate(vault.doc).length;
  for (let edit = 0; edit < 100; edit++) {
    for (let key = 1; key <= 100; key++) vault.setNoteText(id, 'body', 'x'.repeat(edit * 100 + key));
    vault.finishEdit();
  }
  assert.equal(boundaries.length, 100); assertNoReplicatedHistory(vault.doc);
  const replica = new Vault();
  t.after(() => replica.destroy());
  Y.applyUpdate(replica.doc, Y.encodeStateAsUpdate(vault.doc), 'remote');
  const bytes = Y.encodeStateAsUpdate(replica.doc).length - initialBytes;
  assert(bytes < 30000, `One hundred edits/10000 keys grew by ${bytes} bytes`);
  assertNoReplicatedHistory(replica.doc);
  assert.equal(replica.getNote(id)!.body, 'x'.repeat(10000));
});
