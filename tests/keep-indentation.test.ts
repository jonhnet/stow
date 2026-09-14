import { diffHistory } from '../src/core/history';
import { assertNoReplicatedHistory } from './history-state-fixture';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import * as Y from 'yjs';
import { buildDir } from '../paths.ts';
import { ImportClient, type ImportAccount } from '../scripts/import-client.ts';
import { executeIndentationPlan, prepareIndentationUpdate, type IndentationPlan } from '../scripts/restore-keep-indentation.ts';
import { startServer } from '../scripts/server-fixture.ts';
import { applyImport, type ImportedNote } from '../src/core/import.ts';
import { Vault } from '../src/core/vault.ts';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const importId = 'synthetic-keep-import';
const manifestHash = sha('selected synthetic Keep manifest');
const proof = 'indentation-test-private-proxy-proof-'.repeat(2);

function importedNote(id: string): ImportedNote {
  return {
    id, title: `Imported ${id}`, body: 'Preserve **body** and links.', kind: 'checklist', color: 'gray',
    pinned: true, archived: false, trashed: false, createdAt: 1420070400000, updatedAt: 1520070456000,
    labels: ['Synthetic'], takeout: { sourcePath: `${id}.json`, rawHash: sha(`${id} original JSON`), labels: ['Synthetic'] },
    items: ['Parent', 'Checked child', 'Other child'].map((text, index) => ({ id: `${id}-${index}`, noteId: id, text, checked: index === 1, rank: (index + 1) * 1024 })),
    images: [{ id: `${id}-image`, noteId: id, hash: sha('synthetic image'), type: 'image/png', name: 'image.png', size: 10, order: 0 }],
  };
}
function seededVault(t: TestContext) {
  const vault = new Vault(); t.after(() => vault.destroy());
  applyImport(vault, { id: importId, manifestHash, notes: [importedNote('selected'), importedNote('untouched')], replaceSourceIds: [] });
  return vault;
}
function seal(plan: IndentationPlan) {
  const { checksum: _checksum, ...contents } = plan;
  plan.checksum = sha(JSON.stringify(contents));
  return plan;
}
function planFor(vault: Vault, account: ImportAccount = { user: 'repair-owner@example.test', vaultId: sha('synthetic vault'), authMode: 'proxy' }, server = 'http://127.0.0.1:1'): IndentationPlan {
  const note = vault.getNote('selected')!;
  return seal({ format: 'stow-keep-indentation-v1', id: sha('synthetic indentation repair'), createdAt: '2026-09-10T00:00:00.000Z',
    server, ...account, htmlHash: sha('synthetic saved Keep page'), importId, manifestHash,
    notes: [{ id: note.id, title: note.title, rawHash: importedNote('selected').takeout!.rawHash,
      expectedItems: structuredClone(note.items), links: [{ itemId: 'selected-1', parentId: 'selected-0' }, { itemId: 'selected-2', parentId: 'selected-0' }] }],
    issues: [], summary: { cards: 1, matchedCards: 1, notes: 1, indentedItems: 2, skippedCards: 0 }, checksum: '' });
}
function view(doc: Y.Doc) {
  const vault = new Vault();
  try { Y.applyUpdate(vault.doc, Y.encodeStateAsUpdate(doc), 'remote'); return vault.getNotes(); }
  finally { vault.destroy(); }
}
async function edit(client: ImportClient, operation: (vault: Vault) => void) {
  const vault = new Vault();
  try {
    Y.applyUpdate(vault.doc, Y.encodeStateAsUpdate(client.doc), 'remote');
    const vector = Y.encodeStateVector(vault.doc); operation(vault);
    await client.submit(Y.encodeStateAsUpdate(vault.doc, vector));
  } finally { vault.destroy(); }
}

test('indentation preparation leaves the original document byte-exact and records only structural changes without replicated history', t => {
  const vault = seededVault(t), plan = planFor(vault);
  const before = Y.encodeStateAsUpdate(vault.doc), original = structuredClone(vault.getNote('selected')!), untouched = structuredClone(vault.getNote('untouched')!);
  let updates = 0; vault.doc.on('update', () => updates++);
  const beforeState = vault.captureHistoryState(['selected']);
  const prepared = prepareIndentationUpdate(vault.doc, plan);
  assert.equal(prepared.status, 'applied'); assert.equal(prepared.notes, 1); assert.equal(prepared.items, 2);
  assert.equal(updates, 0); assert.deepEqual(Y.encodeStateAsUpdate(vault.doc), before);
  assertNoReplicatedHistory(vault.doc);
  Y.applyUpdate(vault.doc, prepared.update, 'remote');
  const actual = vault.getNote('selected')!;
  for (const field of ['id', 'sourceIds', 'title', 'body', 'kind', 'color', 'pinned', 'archived', 'trashed', 'createdAt', 'images', 'labels'] as const) assert.deepEqual(actual[field], original[field], field);
  assert.deepEqual(actual.items.map(({ id, noteId, text, checked }) => ({ id, noteId, text, checked })), original.items.map(({ id, noteId, text, checked }) => ({ id, noteId, text, checked })));
  assert.deepEqual(actual.items.map(item => [item.id, item.parentId]), [['selected-0', undefined], ['selected-1', 'selected-0'], ['selected-2', 'selected-0']]);
  assert.deepEqual(vault.getNote('untouched'), untouched);
  const changes = diffHistory(beforeState, vault.captureHistoryState(['selected']));
  assert.equal(changes.filter(change => change.op === 'item-parent').length, 2);
  assert(changes.every(change => change.op === 'item-parent' || change.op === 'item-set' && change.field === 'rank' || change.op === 'set' && change.field === 'updatedAt'));
  assertNoReplicatedHistory(vault.doc);
  assert.deepEqual(vault.doc.getMap('keepIndentationRepairs').get(plan.id), { notes: 1, items: 2 });
});

test('indentation preconditions reject changed, merged, archived, foreign-source and already nested checklists without writing', t => {
  const changes: [string, (vault: Vault, plan: IndentationPlan) => void][] = [
    ['edited text', vault => vault.setItemText('selected-1', 'A newer edit')],
    ['checked state', vault => vault.toggleItem('selected-2')],
    ['title', vault => vault.setNoteText('selected', 'title', 'Changed title')],
    ['deleted row', vault => vault.deleteItem('selected-2')],
    ['added row', vault => { vault.addItem('selected', 'Later item'); }],
    ['archive', vault => vault.setNoteMeta('selected', { archived: true })],
    ['merge', vault => { vault.mergeNotes(['selected', 'untouched']); }],
    ['source provenance', vault => vault.notes.get('selected')!.set('takeout', { ...importedNote('selected').takeout!, rawHash: sha('different source') })],
    ['missing import receipt', vault => { vault.doc.getMap('imports').delete(importId); }],
    ['nested before preview', (vault, plan) => { vault.setItemParent('selected-1', 'selected-0'); plan.notes[0].expectedItems = structuredClone(vault.getItems('selected')); seal(plan); }],
    ['changed checksum', (_vault, plan) => { plan.notes[0].links.pop(); }],
  ];
  for (const [name, change] of changes) {
    const vault = seededVault(t), plan = planFor(vault); change(vault, plan);
    const before = Y.encodeStateAsUpdate(vault.doc);
    assert.throws(() => prepareIndentationUpdate(vault.doc, plan), /changed|flat|selected Keep import/i, name);
    assert.deepEqual(Y.encodeStateAsUpdate(vault.doc), before, name);
  }
});

test('indentation preflight rejects cross-note, missing, duplicate, self and cyclic parent links atomically', t => {
  const cases = [
    [{ itemId: 'selected-1', parentId: 'untouched-0' }],
    [{ itemId: 'untouched-1', parentId: 'selected-0' }],
    [{ itemId: 'selected-1', parentId: 'missing' }],
    [{ itemId: 'selected-1', parentId: 'selected-1' }],
    [{ itemId: 'selected-1', parentId: 'selected-0' }, { itemId: 'selected-1', parentId: 'selected-2' }],
    [{ itemId: 'selected-1', parentId: 'selected-0' }, { itemId: 'selected-0', parentId: 'selected-1' }],
    [{ itemId: 'selected-1', parentId: 'selected-0' }, { itemId: 'selected-2', parentId: 'selected-1' }],
  ];
  for (const links of cases) {
    const vault = seededVault(t), plan = planFor(vault); plan.notes[0].links = links; seal(plan);
    const before = Y.encodeStateAsUpdate(vault.doc);
    assert.throws(() => prepareIndentationUpdate(vault.doc, plan), /invalid child or parent|nested parents/);
    assert.deepEqual(Y.encodeStateAsUpdate(vault.doc), before);
  }
});

test('an indentation receipt makes retries no-ops after later text, checks and hierarchy edits', t => {
  const vault = seededVault(t), plan = planFor(vault);
  Y.applyUpdate(vault.doc, prepareIndentationUpdate(vault.doc, plan).update, 'remote');
  vault.outdentItem('selected-1'); vault.setItemText('selected-2', 'Edited after recovery'); vault.toggleItem('selected-2');
  const before = Y.encodeStateAsUpdate(vault.doc);
  const retry = prepareIndentationUpdate(vault.doc, plan);
  assert.deepEqual(retry, { status: 'already-applied', notes: 1, items: 2, update: new Uint8Array() });
  assert.deepEqual(Y.encodeStateAsUpdate(vault.doc), before);
});

async function serverFixture(t: TestContext) {
  await mkdir(path.join(buildDir, 'tmp'), { recursive: true });
  const directory = await mkdtemp(path.join(buildDir, 'tmp', 'stow-indentation-test-'));
  // Disposable fixture simulates the required persistent backup location outside build/.
  const backups = await mkdtemp('/tmp/stow-indentation-backups-');
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir: path.join(directory, 'server'), authMode: 'proxy', proxySecret: proof, password: '' });
  const url = `http://127.0.0.1:${server.port}`, clients: ImportClient[] = [];
  t.after(async () => { await Promise.all(clients.map(client => client.close())); await server.close(); await Promise.all([rm(directory, { recursive: true, force: true }), rm(backups, { recursive: true, force: true })]); });
  const open = async (user = 'repair-owner@example.test') => { const client = await ImportClient.open({ url, user, authMode: 'proxy', proxySecret: proof }); clients.push(client); return client; };
  const owner = await open();
  await edit(owner, vault => { applyImport(vault, { id: importId, manifestHash, notes: [importedNote('selected'), importedNote('untouched')], replaceSourceIds: [] }); });
  const vault = new Vault();
  let plan: IndentationPlan;
  try { Y.applyUpdate(vault.doc, Y.encodeStateAsUpdate(owner.doc), 'remote'); plan = planFor(vault, owner.account, url); }
  finally { vault.destroy(); }
  return { owner, open, plan, directory, backups };
}

test('indentation execution creates a complete backup before its only write and retries safely across connections', async t => {
  const f = await serverFixture(t), before = view(f.owner.doc), beforeUpdate = Y.encodeStateAsUpdate(f.owner.doc);
  const submit = f.owner.submit.bind(f.owner); let submissions = 0;
  t.mock.method(f.owner, 'submit', async (update: Uint8Array) => {
    submissions++;
    const accountDir = path.join(f.backups, f.owner.account.vaultId), entries = await readdir(accountDir);
    assert.equal(entries.length, 1);
    const saved = path.join(accountDir, entries[0]);
    const snapshot = await readFile(path.join(saved, 'before.yjs'));
    const doc = new Y.Doc();
    try { Y.applyUpdate(doc, snapshot); assert.deepEqual(view(doc), before); assert.equal(doc.getMap('keepIndentationRepairs').has(f.plan.id), false); }
    finally { doc.destroy(); }
    assert.deepEqual(new Uint8Array(snapshot), beforeUpdate);
    assert.deepEqual(JSON.parse(await readFile(path.join(saved, 'indentation-plan.json'), 'utf8')), f.plan);
    return submit(update);
  });
  const result = await executeIndentationPlan(f.owner, f.plan, f.backups);
  assert.equal(result.status, 'applied'); assert.equal(submissions, 1);
  assert.ok('backup' in result && result.backup?.startsWith(f.backups));
  assert.equal(JSON.parse(await readFile(path.join(result.backup!, 'result.json'), 'utf8')).status, 'applied');
  const fresh = await f.open();
  assert.equal(view(fresh.doc).find(note => note.id === 'selected')!.items.filter(item => item.parentId).length, 2);
  await edit(fresh, vault => { vault.outdentItem('selected-1'); vault.setItemText('selected-2', 'Kept later edit'); });
  const after = view(fresh.doc), resumed = await f.open();
  assert.equal((await executeIndentationPlan(resumed, f.plan, f.backups)).status, 'already-applied');
  assert.deepEqual(view(resumed.doc), after);
  assert.equal((await readdir(path.join(f.backups, f.owner.account.vaultId))).length, 1);
});

test('indentation execution rejects another authenticated account or unusable backup before submitting', async t => {
  const f = await serverFixture(t), other = await f.open('other-owner@example.test');
  const ownerBefore = Y.encodeStateAsUpdate(f.owner.doc), otherBefore = Y.encodeStateAsUpdate(other.doc);
  await assert.rejects(executeIndentationPlan(other, f.plan, f.backups), /account differs/);
  assert.deepEqual(Y.encodeStateAsUpdate(other.doc), otherBefore);
  assert.deepEqual(await readdir(f.backups), []);
  let submitted = 0; t.mock.method(f.owner, 'submit', async () => { submitted++; });
  await assert.rejects(executeIndentationPlan(f.owner, f.plan, path.join(f.directory, 'bad-build-backup')), /outside build/);
  const blocked = path.join(f.backups, 'not-a-directory'); await writeFile(blocked, 'synthetic file');
  await assert.rejects(executeIndentationPlan(f.owner, f.plan, blocked), /EEXIST|ENOTDIR/);
  assert.equal(submitted, 0);
  const fresh = await f.open(), before = new Y.Doc();
  try {
    Y.applyUpdate(before, ownerBefore);
    // Yjs and Yrs may encode object keys in different orders. Check both causal
    // state (including deletions) and every root's contents across the boundary.
    for (const name of new Set([...before.share.keys(), ...fresh.doc.share.keys()])) {
      assert.deepEqual(fresh.doc.getMap(name).toJSON(), before.getMap(name).toJSON());
    }
    assert(Y.equalSnapshots(Y.snapshot(fresh.doc), Y.snapshot(before)));
  } finally { before.destroy(); }
});

test('indentation execution rechecks the destination after backup and preserves intervening edits', async t => {
  const f = await serverFixture(t), remote = await f.open();
  const refresh = f.owner.refresh.bind(f.owner); let refreshes = 0, submits = 0;
  t.mock.method(f.owner, 'refresh', async () => {
    if (++refreshes === 2) await edit(remote, vault => vault.setItemText('selected-1', 'Changed while backup was saved'));
    await refresh();
  });
  t.mock.method(f.owner, 'submit', async () => { submits++; });
  await assert.rejects(executeIndentationPlan(f.owner, f.plan, f.backups), /changed after preview/);
  assert.equal(submits, 0);
  const fresh = await f.open(), note = view(fresh.doc).find(note => note.id === 'selected')!;
  assert.equal(note.items.find(item => item.id === 'selected-1')!.text, 'Changed while backup was saved');
  assert.equal(note.items.some(item => item.parentId), false);
  assert.equal(fresh.doc.getMap('keepIndentationRepairs').has(f.plan.id), false);
  assert.equal((await readdir(path.join(f.backups, f.owner.account.vaultId))).length, 1);
});
