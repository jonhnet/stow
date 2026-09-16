import { SyncTransfer } from '../src/core/sync-transfer.ts';
import { CURRENT_SCHEMA } from '../src/core/current-schema.ts';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { test, type TestContext } from 'node:test';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as Y from 'yjs';
import { WebSocket } from 'ws';
import { createImportPlan, executeImportPlan, main, readImportPlan, type ImportPlan } from '../scripts/import-keep.ts';
import { ImportClient } from '../scripts/import-client.ts';
import { startServer } from '../scripts/server-fixture.ts';
import { Vault } from '../src/core/vault.ts';
import { buildDir } from '../paths.ts';
import type { HistoryExport } from '../src/core/server-history-types.ts';

const proof = 'import-plan-disposable-proxy-proof-'.repeat(2);
const audio = Buffer.from('synthetic 3gp original bytes');

function view(client: ImportClient) {
  const vault = new Vault();
  try {
    Y.applyUpdate(vault.doc, Y.encodeStateAsUpdate(client.doc), 'remote');
    return vault.getNotes();
  } finally { vault.destroy(); }
}

async function edit(client: ImportClient, operation: (vault: Vault) => void) {
  const vault = new Vault();
  try {
    Y.applyUpdate(vault.doc, Y.encodeStateAsUpdate(client.doc), 'remote');
    const vector = Y.encodeStateVector(vault.doc);
    operation(vault);
    await client.submit(Y.encodeStateAsUpdate(vault.doc, vector));
  } finally { vault.destroy(); }
}

async function fixture(t: TestContext) {
  await mkdir(path.join(buildDir, 'tmp'), { recursive: true });
  const directory = await mkdtemp(path.join(buildDir, 'tmp', 'stow-import-plan-'));
  // Backups deliberately live outside disposable build/, just as deployment requires.
  const backups = await mkdtemp('/tmp/stow-import-plan-backups-');
  const dataDir = path.join(directory, 'server');
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir, authMode: 'proxy', proxySecret: proof, password: '' });
  const url = `http://127.0.0.1:${server.port}`;
  const clients: ImportClient[] = [];
  t.after(async () => {
    await Promise.all(clients.map(client => client.close()));
    await server.close();
    await Promise.all([rm(directory, { recursive: true, force: true }), rm(backups, { recursive: true, force: true })]);
  });
  const client = async (user = 'plan-owner@example.test') => {
    const result = await ImportClient.open({ url, authMode: 'proxy', user, proxySecret: proof });
    clients.push(result); return result;
  };
  const owner = await client();
  let oldId = '';
  await edit(owner, vault => { oldId = vault.createNote('text', { title: 'Before import', body: 'Keep this in the backup.' }); });
  const input = path.join(directory, 'Keep'); await mkdir(input);
  await writeFile(path.join(input, 'voice.3gp'), audio);
  await writeFile(path.join(input, 'recording.json'), JSON.stringify({
    title: 'Imported recording', textContent: 'Original imported text', color: 'GRAY',
    isPinned: true, isArchived: false, isTrashed: false,
    createdTimestampUsec: 1420070400123000, userEditedTimestampUsec: 1520070456789000,
    labels: [{ name: 'Travel' }, { name: 'Recordings' }],
    attachments: [{ filePath: 'voice.3gp', mimetype: 'audio/3gp' }],
  }));
  const blobDir = path.join(dataDir, 'users', owner.account.vaultId, 'blobs');
  return {
    owner, oldId, input, backups, blobDir, client, directory,
    async captureHistory(noteId: string) {
      const socket = new WebSocket(`${url.replace('http:', 'ws:')}/sync?schema=${CURRENT_SCHEMA}&protocol=3&vaultId=${owner.account.vaultId}`, {
        headers: { 'X-Auth-User': owner.account.user, 'X-Stow-Proxy-Secret': proof },
      });
      const transfer = new SyncTransfer(socket, { onMessage() {}, onFailure() {} });
      socket.on('message', (raw, binary) => transfer.receive(binary ? new Uint8Array(raw as Buffer) : raw.toString()));
      try {
        await once(socket, 'open');
        await transfer.send('history-boundary', new TextEncoder().encode(JSON.stringify({ sourceIds: [noteId], editedAt: Date.now() })));
      } finally { transfer.close(); socket.terminate(); }
    },
    async plan(replace = true) {
      const workDir = await mkdtemp(path.join(directory, 'plan-'));
      const plan = await createImportPlan(owner, input, replace, workDir, url);
      const filename = path.join(workDir, 'plan.json');
      await writeFile(filename, JSON.stringify(plan));
      return { plan, filename };
    },
  };
}

test('import plan preview preserves server notes and blobs while staging a reviewable exact source', async t => {
  const f = await fixture(t);
  const before = view(f.owner), encoded = Y.encodeStateAsUpdate(f.owner.doc);
  const { plan, filename } = await f.plan();
  assert.deepEqual(view(f.owner), before);
  assert.deepEqual(Y.encodeStateAsUpdate(f.owner.doc), encoded);
  const observer = await f.client();
  assert.deepEqual(view(observer), before);
  assert.deepEqual(await readdir(f.blobDir), []);
  assert.deepEqual(await readdir(f.backups), []);
  assert.deepEqual(plan.operation.replaceSourceIds, [f.oldId]);
  assert.equal(plan.summary.notes, 1);
  assert.equal(plan.summary.attachments, 1);
  assert.equal(plan.summary.labels, 2);
  const note = plan.operation.notes[0];
  assert.equal(note.color, 'gray');
  assert.deepEqual(note.labels, ['Travel', 'Recordings']);
  assert.equal(note.images[0].type, 'audio/3gp');
  assert.deepEqual(await readImportPlan(filename), plan);
  const original = plan.blobs.find(blob => blob.hash === note.images[0].hash)!;
  assert.deepEqual(await readFile(original.path), audio);
  assert.ok(plan.blobs.some(blob => blob.hash === note.takeout!.rawHash));
  assert.ok(plan.blobs.some(blob => blob.hash === plan.operation.manifestHash));
});

test('import plan replacement saves the old vault before uploads and publishes notes only after every original is stored', async t => {
  const f = await fixture(t);
  const { filename } = await f.plan();
  const plan = await readImportPlan(filename);
  const other = await f.client('unrelated-plan-user@example.test');
  const beforeOther = Y.encodeStateAsUpdate(other.doc);
  let backup = '', submissions = 0;
  const putBlob = f.owner.putBlob.bind(f.owner), submit = f.owner.submit.bind(f.owner);
  t.mock.method(f.owner, 'putBlob', async (blob: Parameters<ImportClient['putBlob']>[0]) => {
    assert.ok(backup, 'backup must be saved before the first upload');
    const previous = new Vault();
    try {
      Y.applyUpdate(previous.doc, await readFile(path.join(backup, 'before.yjs')), 'remote');
      assert.equal(previous.getNote(f.oldId)!.body, 'Keep this in the backup.');
      assert.equal(previous.getNotes().length, 1);
    } finally { previous.destroy(); }
    assert.equal(view(f.owner).some(note => note.id === f.oldId), true);
    return await putBlob(blob);
  });
  t.mock.method(f.owner, 'submit', async (update: Uint8Array) => {
    submissions++;
    for (const blob of plan.blobs) assert.deepEqual(await readFile(path.join(f.blobDir, blob.hash)), await readFile(blob.path));
    return await submit(update);
  });
  const result = await executeImportPlan(f.owner, plan, f.backups, event => {
    const value = event as { event: string; directory?: string };
    if (value.event === 'backup-saved') backup = value.directory!;
  });
  assert.equal(result.status, 'applied');
  assert.equal(result.removed, 1); assert.equal(result.added, 1); assert.equal(submissions, 1);
  assert.ok(backup.startsWith(`${f.backups}${path.sep}`));
  const notes = view(f.owner);
  assert.equal(notes.some(note => note.id === f.oldId), false);
  assert.equal(notes[0].title, 'Imported recording');
  assert.equal(notes[0].images[0].type, 'audio/3gp');
  assert.deepEqual(JSON.parse(await readFile(path.join(backup, 'import-plan.json'), 'utf8')), plan);
  assert.deepEqual(JSON.parse(await readFile(path.join(backup, 'before-history.json'), 'utf8')).versions, []);
  assert.equal(JSON.parse(await readFile(path.join(backup, 'result.json'), 'utf8')).status, 'applied');
  await other.refresh();
  assert.deepEqual(Y.encodeStateAsUpdate(other.doc), beforeOther);
});

test('replacement backup preserves independent history and its removed original before replacing current sources', async t => {
  const f = await fixture(t), original = Buffer.from('Historical recording original');
  const hash = createHash('sha256').update(original).digest('hex'), filename = path.join(f.directory, 'historical.3gp');
  await writeFile(filename, original);
  await f.owner.putBlob({ hash, path: filename, size: original.length, type: 'audio/3gp', sourceIds: [f.oldId] });
  await edit(f.owner, vault => vault.addAttachment({ id: 'historical-recording', noteId: f.oldId, hash, name: 'historical.3gp', size: original.length, type: 'audio/3gp', order: 0 }));
  await f.captureHistory(f.oldId);
  await edit(f.owner, vault => vault.removeAttachment('historical-recording'));
  const { plan } = await f.plan();
  const result = await executeImportPlan(f.owner, plan, f.backups, () => {});
  assert.ok('backup' in result && result.backup);
  const history = JSON.parse(await readFile(path.join(result.backup, 'before-history.json'), 'utf8')) as HistoryExport;
  assert.equal(history.versions.length, 1);
  assert.equal(history.versions[0].state.sources[f.oldId].images['historical-recording'].hash, hash);
  const before = JSON.parse(await readFile(path.join(result.backup, 'before-notes.json'), 'utf8'));
  assert.deepEqual(before.notes[0].images, []);
  assert.deepEqual(await readFile(path.join(result.backup, 'blobs', hash)), original);
  assert.equal(view(f.owner).some(note => note.id === f.oldId), false);
  assert.deepEqual(await f.owner.historyExport(), history);
});

test('unreadable history or corrupt backup media aborts before uploads and source replacement', async t => {
  const f = await fixture(t), original = Buffer.from('Current recording original');
  const hash = createHash('sha256').update(original).digest('hex'), filename = path.join(f.directory, 'current.3gp');
  await writeFile(filename, original);
  await f.owner.putBlob({ hash, path: filename, size: original.length, type: 'audio/3gp', sourceIds: [f.oldId] });
  await edit(f.owner, vault => vault.addAttachment({ id: 'current-recording', noteId: f.oldId, hash, name: 'current.3gp', size: original.length, type: 'audio/3gp', order: 0 }));
  const { plan } = await f.plan();
  let uploads = 0;
  t.mock.method(f.owner, 'putBlob', async () => { uploads++; throw new Error('Unexpected upload'); });
  const historyExport = f.owner.historyExport.bind(f.owner);
  const mock = t.mock.method(f.owner, 'historyExport', async () => { throw new Error('History unavailable'); });
  await assert.rejects(executeImportPlan(f.owner, plan, f.backups, () => {}), /History unavailable/);
  mock.mock.restore();
  assert.deepEqual((await historyExport()).versions, []);
  await writeFile(path.join(f.blobDir, hash), Buffer.from('Corrupt recording bytes'));
  await assert.rejects(executeImportPlan(f.owner, plan, f.backups, () => {}), /does not match its SHA-256 hash/);
  assert.equal(uploads, 0);
  const fresh = await f.client();
  assert.equal(view(fresh)[0].id, f.oldId);
  assert.equal(fresh.doc.getMap('imports').has(plan.operation.id), false);
});

test('saved import plan retries preserve later edits while a new replacement uses fresh IDs and defeats stale source edits', async t => {
  const f = await fixture(t);
  const first = await f.plan();
  await executeImportPlan(f.owner, await readImportPlan(first.filename), f.backups, () => {});
  const originalId = first.plan.operation.notes[0].id;
  let laterId = '';
  await edit(f.owner, vault => {
    vault.setNoteText(originalId, 'body', 'Edited after import');
    laterId = vault.createNote('text', { title: 'Created after import' });
  });
  const afterEdits = view(f.owner), backupCount = (await readdir(path.join(f.backups, f.owner.account.vaultId))).length;
  const resumed = await f.client();
  const retry = await executeImportPlan(resumed, await readImportPlan(first.filename), f.backups, () => {});
  assert.equal(retry.status, 'already-applied');
  assert.deepEqual(view(resumed), afterEdits);
  assert.equal((await readdir(path.join(f.backups, f.owner.account.vaultId))).length, backupCount);

  const offline = new Vault(); t.after(() => offline.destroy());
  Y.applyUpdate(offline.doc, Y.encodeStateAsUpdate(resumed.doc), 'remote');
  offline.setNoteText(originalId, 'title', 'Old source edited offline');
  offline.addItem(originalId, 'Offline item from replaced source');
  const second = await f.plan();
  assert.notEqual(second.plan.operation.id, first.plan.operation.id);
  const replacementId = second.plan.operation.notes[0].id;
  assert.notEqual(replacementId, originalId);
  assert.deepEqual(new Set(second.plan.operation.replaceSourceIds), new Set([originalId, laterId]));
  let newestId = '';
  await edit(resumed, vault => { newestId = vault.createNote('text', { title: 'Created after the new preview' }); });
  await executeImportPlan(f.owner, await readImportPlan(second.filename), f.backups, () => {});
  await resumed.refresh();
  await resumed.submit(Y.encodeStateAsUpdate(offline.doc));
  const fresh = await f.client();
  const actual = view(fresh);
  assert.deepEqual(new Set(actual.map(note => note.id)), new Set([replacementId, newestId]));
  assert.equal(actual.find(note => note.id === replacementId)!.title, 'Imported recording');
  assert.equal(actual.find(note => note.id === replacementId)!.items.length, 0);
  assert.equal(fresh.doc.getMap('notes').has(originalId), false);
  assert.equal(fresh.doc.getMap('notes').has(laterId), false);
});

test('changed import plan checksums and staged file bytes fail review before uploads or vault writes', async t => {
  const f = await fixture(t);
  const { plan, filename } = await f.plan();
  const before = view(f.owner);
  const changed: ImportPlan = structuredClone(plan);
  changed.operation.notes[0].title = 'Unreviewed title';
  await writeFile(filename, JSON.stringify(changed));
  await assert.rejects(readImportPlan(filename), /plan is invalid or changed/);
  await writeFile(filename, JSON.stringify(plan));
  const original = plan.blobs.find(blob => blob.hash === plan.operation.notes[0].images[0].hash)!;
  await writeFile(original.path, Buffer.alloc(original.size, 1));
  await assert.rejects(readImportPlan(filename), /file changed after preview/);
  assert.deepEqual(await readdir(f.blobDir), []);
  assert.deepEqual(await readdir(f.backups), []);
  const fresh = await f.client();
  assert.deepEqual(view(fresh), before);
});

test('CLI applies the exact selected plan copy and retries it even when the original filename is gone', async t => {
  const f = await fixture(t);
  const selected = await f.plan(), different = await f.plan();
  const copy = path.join(f.backups, 'selected-plan.json');
  await writeFile(copy, JSON.stringify(selected.plan));
  await writeFile(selected.filename, JSON.stringify(different.plan));
  const previousProof = process.env.STOW_PROXY_SECRET;
  process.env.STOW_PROXY_SECRET = proof;
  t.after(() => {
    if (previousProof === undefined) delete process.env.STOW_PROXY_SECRET;
    else process.env.STOW_PROXY_SECRET = previousProof;
  });
  t.mock.method(console, 'log', () => {});
  const args = ['--plan', copy, '--apply', '--vault', f.owner.account.vaultId, '--backup-dir', f.backups];
  await main(args);
  await f.owner.refresh();
  assert.equal(f.owner.doc.getMap('imports').has(selected.plan.operation.id), true);
  assert.equal(f.owner.doc.getMap('imports').has(different.plan.operation.id), false);
  assert.equal(view(f.owner)[0].id, selected.plan.operation.notes[0].id);
  await rm(selected.filename);
  await main(args);
  await f.owner.refresh();
  assert.equal(view(f.owner).length, 1);
  assert.equal((await readdir(path.join(f.backups, f.owner.account.vaultId))).length, 1);
});
