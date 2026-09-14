import { fingerprint } from './fingerprint.ts';
/** Disposable synthetic vaults matched across retention policies. No user data. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as Y from 'yjs';
import sharp from 'sharp';
import { Vault } from '../../src/core/vault.ts';
import { applyImport, type ImportedNote } from '../../src/core/import.ts';
import { nativeCommand } from '../native-command.ts';
import type { SavedVersion } from '../../src/core/server-history-types.ts';
import { CURRENT_SCHEMA, assertCurrentSchema } from '../../src/core/current-schema.ts';
import { buildDir } from '../../paths.ts';

export const SCENARIOS = ['fresh', 'aged', 'archive', 'live', 'both'] as const;
export const LAB_FIXTURES = path.join(buildDir, 'storage-lab', 'fixtures-current-v1');
export async function buildFixtures(directory = LAB_FIXTURES) {
  if (!directory.startsWith(buildDir + path.sep)) throw new Error('Fixtures belong under build/.');
  // Existing trial inputs are immutable; choose a new directory for another build.
  await mkdir(directory);
  const historyHashes = Object.fromEntries(SCENARIOS.map(name => [name, createHash('sha256')]));
  const totals = Object.fromEntries(SCENARIOS.map(name => [name, { retainedVersions: 0, historyPayloadBytes: 0 }]));
  for (const name of SCENARIOS) await mkdir(path.join(directory, name, 'history'), { recursive: true });
  const saveVersions = async (scenario: string, key: string, versions: SavedVersion[]) => {
    if (!versions.length) return;
    const bytes = Buffer.from(JSON.stringify({ schema: 1, versions }));
    await writeFile(path.join(directory, scenario, 'history', `${key}.json`), bytes);
    historyHashes[scenario].update(key).update(bytes);
    totals[scenario].retainedVersions += versions.length; totals[scenario].historyPayloadBytes += bytes.byteLength;
  };
  await mkdir(path.join(directory, 'blobs'), { recursive: true });
  const blobs = [];
  for (let i = 0; i < 4; i++) {
    const bytes = await sharp({ create: { width: 32, height: 32, channels: 4, background: { r: 40 + i * 50, g: 100, b: 180, alpha: 1 } } }).png().toBuffer();
    const hash = createHash('sha256').update(bytes).digest('hex');
    await writeFile(path.join(directory, 'blobs', hash), bytes); blobs.push({ hash, bytes: bytes.length });
  }
  const notes: ImportedNote[] = Array.from({ length: 2707 }, (_, i) => ({
    id: `lab-note-${i}`, title: i === 0 ? 'Performance checklist' : `Fixture note ${String(i).padStart(4, '0')}`,
    body: `Synthetic note ${i}. ` + 'A repeatable notes fixture with prose, lists and a searchable phrase. '.repeat(18),
    kind: 'checklist', color: 'default', pinned: i === 0, archived: i % 4 !== 0, trashed: false,
    createdAt: 1_700_000_000_000 + i, updatedAt: 1_700_000_000_000 + i, images: [],
    items: Array.from({ length: i === 0 ? 1000 : i === 1 ? 1288 : 6 }, (_, j) => ({ id: `lab-item-${i}-${j}`, noteId: `lab-note-${i}`,
      text: `Checklist row ${j} for fixture ${i}`, checked: j % 4 === 0, rank: j })),
  }));
  assert.equal(notes.reduce((sum, note) => sum + note.items.length, 0), 18518);
  const vault = new Vault(new Y.Doc()); vault.doc.clientID = 0x51000001;
  applyImport(vault, { id: 'storage-lab-import', manifestHash: createHash('sha256').update(JSON.stringify(notes)).digest('hex'), notes, replaceSourceIds: [] });
  const results: object[] = [];
  const save = async (name: string, bytes: Uint8Array) => {
    const entry = { scenario: name, sha256: createHash('sha256').update(bytes).digest('hex'), encodedBytes: bytes.byteLength,
      notes: notes.length, items: name === 'fresh' ? notes.reduce((sum, note) => sum + note.items.length, 0) : vault.items.size, visibleItems: 18518, ...totals[name], serverHistorySha256: historyHashes[name].digest('hex'), replicatedHistoryBytes: 0 };
    results.push(entry); await writeFile(path.join(directory, `${name}.yjs`), bytes); console.log(JSON.stringify(entry));
  };
  const fresh = Y.encodeStateAsUpdate(vault.doc);
  for (const [index, note] of notes.entries()) {
    const key = createHash('sha256').update(JSON.stringify([note.id])).digest('hex');
    const versions: SavedVersion[] = [];
    const capture = () => {
      const at = 1_800_000_000_000 + versions.length;
      versions.push(nativeCommand({ op: 'makeVersion', state: vault.captureHistoryState([note.id]), boundary: { sourceIds: [note.id], editedAt: at }, now: at, id: `${key}.${String(versions.length).padStart(32, '0')}`, before: versions.at(-1)?.state }));
    };
    capture(); await saveVersions('fresh', key, versions);
    for (let edit = 0; edit < 20; edit++) { vault.setNoteText(note.id, 'body', `${note.body}\nCompleted edit ${edit}`); vault.finishEdit(); capture(); }
    if (index === 0) {
      for (let edit = 0; edit < 1000; edit++) {
        vault.setItemText('lab-item-0-0', `Long-lived checklist edit ${edit}`); vault.finishEdit(); capture();
        if (edit % 10 === 0) { const item = vault.addItem(note.id, `Removed checklist row ${edit}`); capture(); vault.deleteItem(item); capture(); }
        if (edit % 100 === 0) {
          const blob = blobs[(edit / 100) % blobs.length], id = `lab-old-image-${edit}`;
          vault.addAttachment({ id, noteId: note.id, hash: blob.hash, name: `Historical image ${edit}.png`, type: 'image/png', size: blob.bytes }); capture();
          vault.removeAttachment(id); capture();
        }
        vault.undoManager.clear();
      }
      const image = blobs[0];
      vault.addAttachment({ id: 'lab-current-image', noteId: note.id, hash: image.hash, name: 'Current image.png', type: 'image/png', size: image.bytes }); capture();
    } else if (index < 48 && index % 4 === 0) {
      for (let edit = 0; edit < 130; edit++) { vault.setNoteText(note.id, 'body', `${note.body}\nOlder active edit ${edit}`); vault.finishEdit(); capture(); }
    }
    // One note's snapshots at a time: never materialize several whole aged vaults.
    for (const scenario of ['aged', 'archive', 'live', 'both']) {
      const discard = note.archived && (scenario === 'archive' || scenario === 'both');
      await saveVersions(scenario, key, discard ? [] : scenario === 'live' || scenario === 'both' ? nativeCommand({ op: 'thinVersions', records: versions }) : versions);
    }
    if (index % 200 === 0) console.log(JSON.stringify({ agingNotes: index }));
    vault.undoManager.clear();
  }
  assertCurrentSchema(vault.doc);
  await save('fresh', fresh);
  const aged = Y.encodeStateAsUpdate(vault.doc);
  for (const scenario of ['aged', 'archive', 'live', 'both']) await save(scenario, aged);
  vault.destroy();
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ schema: 2, currentSchema: CURRENT_SCHEMA, ...await fingerprint(), synthetic: true, blobs, results }, null, 2) + '\n');
}
if (process.argv[1]?.endsWith('/fixtures.ts')) await buildFixtures(process.argv[2] ? path.resolve(process.argv[2]) : undefined);
