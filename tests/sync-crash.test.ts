import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as Y from 'yjs';
import { buildDir } from '../paths';
import { startServer } from '../scripts/server-fixture';
import { ImportClient } from '../scripts/import-client';
import { Vault } from '../src/core/vault';

async function reached(directory: string) {
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    try { return await readFile(path.join(directory, 'reached'), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('The server never reached the armed storage boundary');
}

for (const target of ['update', 'deletion-snapshot'] as const) for (const phase of ['before-publish', 'after-publish'] as const) {
  test(`SIGKILL ${phase} of ${target}: three replicas replay without losing acknowledged or unrelated edits`, { timeout: 30_000 }, async t => {
    const root = path.join(buildDir, 'test-tmp'); await mkdir(root, { recursive: true });
    const directory = await mkdtemp(path.join(root, 'sync-crash-')), gate = path.join(directory, 'gate');
    await mkdir(gate);
    const options = { dataDir: path.join(directory, 'data'), port: 0, authMode: 'password' as const, password: '', storageGate: gate };
    let server = await startServer(options);
    const clients: ImportClient[] = [], vaults: Vault[] = [];
    t.after(async () => {
      // Kill also releases a failed test stuck at its intentional write barrier.
      await server.crash();
      await Promise.all(clients.map(client => client.close()));
      vaults.forEach(vault => vault.destroy());
      await rm(directory, { recursive: true, force: true });
    });
    const connect = async () => {
      const client = await ImportClient.open({ url: `http://127.0.0.1:${server.port}`, authMode: 'password' });
      clients.push(client); return client;
    };
    const writer = await connect();
    const first = new Vault(); vaults.push(first);
    const keep = first.createNote('checklist', { title: 'Keep', body: 'ACKNOWLEDGED BASELINE' });
    const gone = first.createNote('text', { title: 'Delete', body: 'ERASED ORIGINAL' });
    first.setNoteMeta(gone, { trashed: true }); first.finishEdit();
    await writer.submit(Y.encodeStateAsUpdate(first.doc));
    const peers = [first, ...[1, 2].map(() => {
      const vault = new Vault(); Y.applyUpdate(vault.doc, Y.encodeStateAsUpdate(first.doc), 'remote'); vaults.push(vault); return vault;
    })];
    peers[1].setNoteText(keep, 'body', peers[1].getNote(keep)!.body + ' PHONE 🦀');
    peers[1].setNoteText(gone, 'body', 'ERASED LATE EDIT');
    peers[2].addItem(keep, 'THIRD DEVICE ITEM');
    if (target === 'update') first.setNoteText(keep, 'body', first.getNote(keep)!.body + ' UNCERTAIN WRITE');
    else first.deleteNotesForever([gone]);
    first.finishEdit();
    const update = Y.encodeStateAsUpdate(first.doc, Y.encodeStateVector(writer.doc));
    await writeFile(path.join(gate, 'armed.json'), JSON.stringify({ phase, suffix: target === 'update' ? 'updates/0000000000000001.yjs' : 'vault.yjs' }));
    let acknowledged = false;
    const pending = writer.submit(update).then(() => { acknowledged = true; });
    const rejected = assert.rejects(pending); // Attach before the deliberate crash.
    assert.equal(await reached(gate), phase);
    assert.equal(acknowledged, false, 'No acknowledgment may precede completion of publication');
    await server.crash(); await rejected;
    await rm(path.join(gate, 'armed.json'));
    server = await startServer(options);
    const recovered = await connect();
    assert(String(recovered.doc.getMap<Y.Map<unknown>>('notes').get(keep)!.get('body')).includes('ACKNOWLEDGED BASELINE'));
    if (target === 'update') assert.equal(String(recovered.doc.getMap<Y.Map<unknown>>('notes').get(keep)!.get('body')).includes('UNCERTAIN WRITE'), phase === 'after-publish');
    else assert.equal(recovered.doc.getMap('notes').has(gone), phase !== 'after-publish');
    // Different reconnect orders, plus exact duplicate replay of the ambiguous write.
    const order = phase === 'before-publish' ? [2, 0, 1] : [1, 2, 0];
    for (const actor of order) { peers[actor].finishEdit(); await recovered.submit(Y.encodeStateAsUpdate(peers[actor].doc)); }
    await recovered.submit(update);
    await server.crash(); // All the preceding acknowledgments must survive SIGKILL.
    server = await startServer(options);
    const final = await connect();
    const copy = new Y.Doc(); Y.applyUpdate(copy, Y.encodeStateAsUpdate(final.doc));
    const view = new Vault(copy); vaults.push(view);
    const body = view.getNote(keep)!.body;
    assert.equal(body.split('ACKNOWLEDGED BASELINE').length - 1, 1);
    assert.equal(body.split('PHONE 🦀').length - 1, 1);
    assert.deepEqual(view.getItems(keep).map(item => item.text), ['THIRD DEVICE ITEM']);
    if (target === 'update') assert.equal(body.split('UNCERTAIN WRITE').length - 1, 1);
    else {
      assert.equal(final.doc.getMap('notes').has(gone), false, 'Check the raw server result before any browser guard');
      assert(!JSON.stringify(view.getNotes()).includes('ERASED'));
    }
  });
}
