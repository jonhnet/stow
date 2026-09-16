import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as Y from 'yjs';
import { Vault } from '../src/core/vault.ts';
import { enforcePermanentDeletions } from '../src/core/deletion.ts';
import { nativeCommand } from '../scripts/native-command.ts';
import { startServer } from '../scripts/server-fixture.ts';
import { ImportClient } from '../scripts/import-client.ts';
import { diffHistory } from '../src/core/history.ts';
import { describeHistoryAction } from '../src/core/history-description.ts';

function clone(doc: Y.Doc) { const result = new Y.Doc(); Y.applyUpdate(result, Y.encodeStateAsUpdate(doc)); return result; }
async function nativePolicy(doc: Y.Doc) {
  const directory = await mkdtemp(path.join(tmpdir(), 'stow-policy-client-'));
  const server = await startServer({ dataDir: directory, port: 0, authMode: 'password', password: '' });
  let client: ImportClient | undefined;
  try {
    client = await ImportClient.open({ url: `http://127.0.0.1:${server.port}`, authMode: 'password' });
    await client.submit(Y.encodeStateAsUpdate(doc)); await client.refresh();
    // ImportClient uses a plain Y.Doc: no browser deletion guard can hide a server omission.
    return clone(client.doc);
  } finally { await client?.close(); await server.close(); await rm(directory, { recursive: true, force: true }); }
}
function equalRoots(actual: Y.Doc, expected: Y.Doc) {
  for (const name of new Set([...actual.share.keys(), ...expected.share.keys()])) {
    assert.deepEqual(actual.getMap(name).toJSON(), expected.getMap(name).toJSON(), name);
  }
}

test('Rust projection matches browser source, label, placement and merged text identities', async () => {
  const browser = new Vault();
  try {
    const a = browser.createNote('text', { title: 'A😀', body: 'First source' });
    const b = browser.createNote('checklist', { title: 'B', body: 'Second source' });
    browser.addItem(b, 'checkbox'); browser.setNoteLabel(a, 'green', true); browser.setLabelColor('green', 'sage');
    browser.setNoteLabel(a, 'Ｚ', true); browser.setNoteLabel(a, '😀', true);
    browser.mergeNotes([b, a]);
    const request = { op: 'projection', method: 'capture', doc: Buffer.from(Y.encodeStateAsUpdate(browser.doc)).toString('base64'), sourceIds: [a] };
    assert.deepEqual(nativeCommand(request), browser.captureHistoryState([a]));
    const expected = clone(browser.doc); expected.getMap('deletedNotes').set(a, true); enforcePermanentDeletions(expected);
    const input = clone(browser.doc); input.getMap('deletedNotes').set(a, true);
    const actual = await nativePolicy(input); equalRoots(actual, expected);
    actual.destroy(); expected.destroy(); input.destroy();
  } finally { browser.destroy(); }
});

test('Unicode and dependent Yjs edits survive repeated Rust restarts and duplicate replay', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'stow-yjs-client-'));
  const browser = new Y.Doc(), edits: Uint8Array[] = [];
  browser.on('update', update => edits.push(update));
  const text = browser.getText('body'); text.insert(0, 'A😀e\u0301中🦀Z');
  text.delete(1, 2); text.insert(1, '👩‍💻'); text.insert(text.length, '𝄞');
  let server = await startServer({ dataDir: directory, port: 0, authMode: 'password', password: '' });
  let client: ImportClient | undefined;
  const open = () => ImportClient.open({ url: `http://127.0.0.1:${server.port}`, authMode: 'password' });
  try {
    client = await open();
    for (const update of edits.slice(1).reverse()) await client.submit(update);
    await client.close(); await server.close();
    server = await startServer({ dataDir: directory, port: 0, authMode: 'password', password: '' }); client = await open();
    for (const update of edits) await client.submit(update);
    await client.close(); await server.close();
    server = await startServer({ dataDir: directory, port: 0, authMode: 'password', password: '' }); client = await open();
    assert.equal(client.doc.getText('body').toString(), text.toString());
    assert.deepEqual(Y.decodeStateVector(Y.encodeStateVector(client.doc)), Y.decodeStateVector(Y.encodeStateVector(browser)));
  } finally { await client?.close(); await server.close(); browser.destroy(); await rm(directory, { recursive: true, force: true }); }
});

test('native saved changes and descriptions match browser Unicode splices and word boundaries', () => {
  const client = new Vault();
  try {
    const id = client.createNote('text', { title: 'Unicode' });
    const body = client.doc.getMap<Y.Map<Y.Text>>('notes').get(id)!.get('body')!;
    for (const [old, current] of [
      ['A😀Z', 'A🦀Z'], ['a𝄞b', 'a😀b'], ['e\u0301cole', 'e\u0300cole'],
      ['किताब', 'किताप'], ['مُحَمَّد', 'مُحَمَّل'], ['กิข', 'กิค'],
      ['foo_bar', 'foo_baz'], ['中甲文', '中乙文'], ['', 'new 😀'], ['erase 🦀', ''],
      ['old\r\nline\tvalue', 'new\r\nline\tvalue'],
    ]) {
      body.delete(0, body.length); body.insert(0, old);
      const before = client.captureHistoryState([id]);
      body.delete(0, body.length); body.insert(0, current);
      const state = client.captureHistoryState([id]);
      const version = nativeCommand({ op: 'makeVersion', state, boundary: { sourceIds: [id], editedAt: 10, action: { type: 'text', noteId: id, field: 'body' } }, now: 20, id: 'test', before });
      assert.equal(version.action!.type, 'text');
      assert.deepEqual(version.action!.changes, diffHistory(before, state), `${old} → ${current}`);
      assert.equal(version.label, describeHistoryAction(before, state, version.action!, 'Saved note'), `${old} → ${current}`);
    }
  } finally { client.destroy(); }
});

test('Rust history and browser views agree on conversion masks, duplicate parents and conflict copies', () => {
  const a = new Vault(), b = new Vault();
  try {
    const id = a.createNote('text', { body: 'One 🦀\r\nOne 🦀\nTwo\nThree' });
    Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc), 'remote');
    a.convertBodyToChecklist(id); b.convertBodyToChecklist(id);
    const left = a.getItems(id), right = b.getItems(id);
    const check = () => {
      const l = Y.encodeStateAsUpdate(a.doc), r = Y.encodeStateAsUpdate(b.doc);
      Y.applyUpdate(a.doc, r, 'remote'); Y.applyUpdate(b.doc, l, 'remote');
      assert.deepEqual(a.getNotes(), b.getNotes());
      assert.deepEqual(nativeCommand({ op: 'projection', method: 'capture', doc: Buffer.from(Y.encodeStateAsUpdate(a.doc)).toString('base64'), sourceIds: [id] }), a.captureHistoryState([id]));
    };
    check();
    a.setItemText(left[0].id, 'Edited 🐸'); a.finishEdit();
    b.addItem(id, 'Child', right[0].id); b.toggleItem(right[2].id);
    a.deleteItem(left[3].id); check();
    b.setItemText(right[0].id, 'Another 🐸'); b.finishEdit(); check();
    a.setNoteText(id, 'body', 'New body 👩‍💻'); a.finishEdit(); check();
    a.convertBodyToChecklist(id); check(); a.undo(); check();
    const second = a.createNote('text', { title: 'Other title', body: 'Other body' });
    a.mergeNotes([id, second]); check();
    a.convertBodyToChecklist(id); b.convertBodyToChecklist(id); check();
    a.undo(); b.undo(); check();
  } finally { a.destroy(); b.destroy(); }
});

test('a child from another merged source follows the surviving converted parent in browser and Rust history', () => {
  const a = new Vault(), b = new Vault();
  try {
    const id = a.createNote('text', { body: 'Parent' }), other = a.createNote('checklist', { title: 'Other' });
    const child = a.addItem(other, 'Child'); a.mergeNotes([id, other]);
    Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc), 'remote');
    a.convertBodyToChecklist(id); b.convertBodyToChecklist(id);
    const parents = [a, b].map(vault => vault.getItems(id).find(item => item.text === 'Parent')!.id);
    const loser = parents[0] < parents[1] ? 1 : 0;
    [a, b][loser].setItemParent(child, parents[loser]);
    const updates = [a, b].map(vault => Y.encodeStateAsUpdate(vault.doc));
    for (const vault of [a, b]) for (const update of updates) Y.applyUpdate(vault.doc, update, 'remote');
    assert.deepEqual(a.getNotes(), b.getNotes());
    const items = a.getItems(id);
    assert.equal(items.find(item => item.id === child)!.parentId, items.find(item => item.text === 'Parent')!.id);
    assert.deepEqual(nativeCommand({ op: 'projection', method: 'capture', doc: Buffer.from(Y.encodeStateAsUpdate(a.doc)).toString('base64'), sourceIds: [id] }), a.captureHistoryState([id]));
    a.setItemText(items.find(item => item.text === 'Parent')!.id, 'Edited parent'); a.finishEdit();
    assert.equal(a.getItems(id).find(item => item.id === child)!.parentId, a.getItems(id).find(item => item.text === 'Edited parent')!.id);
  } finally { a.destroy(); b.destroy(); }
});
