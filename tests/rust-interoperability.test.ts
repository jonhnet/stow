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
