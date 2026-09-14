import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import * as Y from 'yjs';
import { buildDir, defaultDataDir, sourceDir } from '../paths.ts';
import { atomicWrite, mkdirDurable } from './file-io.ts';
import { Vault } from '../src/core/vault.ts';
import type { Item } from '../src/core/types.ts';
import { ImportClient } from './import-client.ts';
import { readImportPlan, type ImportPlan } from './import-keep.ts';
import { parseKeepPage, matchKeepPage } from './keep-page.ts';

const FORMAT = 'stow-keep-indentation-v1';
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
interface RepairNote {
  id: string;
  title: string;
  rawHash: string;
  expectedItems: Item[];
  links: { itemId: string; parentId: string }[];
}
export interface IndentationPlan {
  format: typeof FORMAT;
  id: string;
  createdAt: string;
  server: string;
  authMode: 'proxy' | 'password';
  user: string;
  vaultId: string;
  htmlHash: string;
  importId: string;
  manifestHash: string;
  notes: RepairNote[];
  issues: { cardIndex: number; reason: string }[];
  summary: { cards: number; matchedCards: number; notes: number; indentedItems: number; skippedCards: number };
  checksum: string;
}
function checksum(plan: IndentationPlan) {
  const { checksum: _checksum, ...contents } = plan;
  return sha(JSON.stringify(contents));
}
function snapshot(doc: Y.Doc) {
  const vault = new Vault();
  Y.applyUpdate(vault.doc, Y.encodeStateAsUpdate(doc), 'remote');
  return vault;
}
const sortedItems = (items: Item[]) => [...items].sort((a, b) => a.id.localeCompare(b.id));
function sameItems(a: Item[], b: Item[]) {
  const fields = (items: Item[]) => sortedItems(items).map(item => [item.id, item.noteId, item.text, item.checked, item.rank, item.parentId ?? null]);
  return JSON.stringify(fields(a)) === JSON.stringify(fields(b));
}
function verifyImport(vault: Vault, plan: Pick<IndentationPlan, 'importId' | 'manifestHash'>) {
  const receipt = vault.doc.getMap<{ manifestHash: string }>('imports').get(plan.importId);
  if (receipt?.manifestHash !== plan.manifestHash) throw new Error('This vault does not contain the selected Keep import.');
}

/** Read-only preview: match original plaintext, then require unchanged flat destination lists. */
export async function createIndentationPlan(client: ImportClient, imported: ImportPlan, html: string): Promise<IndentationPlan> {
  if (client.account.vaultId !== imported.vaultId || client.account.user !== imported.user || client.account.authMode !== imported.authMode) {
    throw new Error('The authenticated account differs from the original import.');
  }
  const page = parseKeepPage(html);
  if (page.identity !== client.account.user) throw new Error('The saved Keep page belongs to a different account.');
  const blobs = new Map(imported.blobs.map(blob => [blob.hash, blob]));
  const sources = [];
  for (const note of imported.operation.notes) {
    if (note.kind !== 'checklist' || note.archived || note.trashed) continue;
    const blob = note.takeout && blobs.get(note.takeout.rawHash);
    if (!blob) throw new Error('The original checklist source is missing.');
    const bytes = await readFile(blob.path);
    if (sha(bytes) !== blob.hash) throw new Error('The original checklist source changed.');
    const raw = JSON.parse(bytes.toString('utf8'));
    if (!Array.isArray(raw.listContent) || raw.listContent.length !== note.items.length) throw new Error('The original checklist no longer matches its import plan.');
    sources.push({ id: note.id, title: raw.title, archived: note.archived, trashed: note.trashed,
      items: note.items.map((item, index) => ({ id: item.id, text: raw.listContent[index].text, checked: raw.listContent[index].isChecked })) });
  }
  const matching = matchKeepPage(page, sources);
  await client.refresh();
  const vault = snapshot(client.doc);
  try {
    verifyImport(vault, { importId: imported.operation.id, manifestHash: imported.operation.manifestHash });
    const originals = new Map(imported.operation.notes.map(note => [note.id, note]));
    const issues = [...matching.issues], notes: RepairNote[] = [];
    for (const match of matching.matches) {
      if (!match.links.length) continue;
      const original = originals.get(match.noteId)!, current = vault.getNote(match.noteId);
      if (!current || current.sourceIds.length !== 1 || current.id !== original.id || current.archived || current.trashed ||
          current.kind !== 'checklist' || current.title !== original.title || !sameItems(current.items, original.items) ||
          current.items.some(item => item.parentId) || vault.notes.get(original.id)?.get('takeout')?.rawHash !== original.takeout?.rawHash) {
        issues.push({ cardIndex: match.cardIndex, reason: 'Destination checklist changed since import; left untouched.' });
        continue;
      }
      notes.push({ id: original.id, title: original.title, rawHash: original.takeout!.rawHash,
        expectedItems: current.items, links: match.links });
    }
    const htmlHash = sha(html);
    const plan: IndentationPlan = {
      format: FORMAT, id: sha(JSON.stringify([imported.operation.id, htmlHash, notes.map(note => [note.id, note.links])])),
      createdAt: new Date().toISOString(), server: imported.server, authMode: imported.authMode,
      user: imported.user, vaultId: imported.vaultId, htmlHash, importId: imported.operation.id,
      manifestHash: imported.operation.manifestHash, notes, issues,
      summary: { cards: page.notes.length, matchedCards: matching.matches.length, notes: notes.length,
        indentedItems: notes.reduce((count, note) => count + note.links.length, 0),
        skippedCards: page.notes.length - matching.matches.length + issues.filter(issue => issue.reason === 'Destination checklist changed since import; left untouched.').length },
      checksum: '',
    };
    plan.checksum = checksum(plan);
    prepareIndentationUpdate(client.doc, plan);
    return plan;
  } finally { vault.destroy(); }
}

/** Prepare the complete operation on a copy; a failed precondition writes nothing. */
export function prepareIndentationUpdate(doc: Y.Doc, plan: IndentationPlan) {
  if (plan.format !== FORMAT || checksum(plan) !== plan.checksum || !/^[a-f0-9]{64}$/.test(plan.id)) throw new Error('Indentation plan is invalid or changed. Generate a new preview.');
  const vault = snapshot(doc);
  try {
    verifyImport(vault, plan);
    const receipts = vault.doc.getMap<{ notes: number; items: number }>('keepIndentationRepairs');
    const previous = receipts.get(plan.id);
    if (previous) return { status: 'already-applied' as const, ...previous, update: new Uint8Array() };
    const seen = new Set<string>();
    for (const note of plan.notes) {
      const current = vault.getNote(note.id);
      if (seen.has(note.id) || !current || current.sourceIds.length !== 1 || current.id !== note.id || current.kind !== 'checklist' ||
          current.title !== note.title || current.archived || current.trashed || !sameItems(current.items, note.expectedItems) ||
          vault.notes.get(note.id)?.get('takeout')?.rawHash !== note.rawHash) throw new Error('A selected checklist changed after preview. Generate a new preview.');
      seen.add(note.id);
      if (current.items.some(item => item.parentId)) throw new Error('Recovery requires an unchanged flat checklist.');
      const items = new Set(current.items.map(item => item.id)), children = new Set<string>();
      for (const link of note.links) {
        if (!items.has(link.itemId) || !items.has(link.parentId) || link.itemId === link.parentId || children.has(link.itemId)) throw new Error('Indentation plan has an invalid child or parent.');
        children.add(link.itemId);
      }
      if (note.links.some(link => children.has(link.parentId))) throw new Error('Indentation plan contains nested parents.');
    }
    const vector = Y.encodeStateVector(vault.doc);
    const result = { notes: plan.notes.length, items: plan.notes.reduce((sum, note) => sum + note.links.length, 0) };
    for (const note of plan.notes) for (const link of note.links) {
      if (!vault.setItemParent(link.itemId, link.parentId)) throw new Error('A planned indentation could not be applied.');
    }
    // Only current changes are published by this script. The durable receipt
    // makes retry a no-op even after later user edits to recovered indentation.
    receipts.set(plan.id, result);
    const update = Y.encodeStateAsUpdate(vault.doc, vector);
    if (update.byteLength > 16 * 1024 * 1024) throw new Error('Indentation repair exceeds the sync update limit.');
    return { status: 'applied' as const, ...result, update };
  } finally { vault.destroy(); }
}

function inside(candidate: string, directory: string) {
  const relative = path.relative(directory, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
async function backup(client: ImportClient, plan: IndentationPlan, directory: string) {
  directory = path.resolve(directory);
  if (inside(directory, buildDir) || inside(directory, sourceDir)) throw new Error('Recovery backups must stay outside build/ and the source checkout.');
  await mkdirDurable(directory);
  directory = await realpath(directory);
  if (inside(directory, buildDir) || inside(directory, sourceDir)) throw new Error('Recovery backups resolve inside build/ or source.');
  const destination = path.join(directory, plan.vaultId, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
  await mkdirDurable(destination);
  await atomicWrite(path.join(destination, 'before.yjs'), Buffer.from(Y.encodeStateAsUpdate(client.doc)));
  await atomicWrite(path.join(destination, 'indentation-plan.json'), Buffer.from(json(plan)));
  return destination;
}
export async function executeIndentationPlan(client: ImportClient, plan: IndentationPlan, backupDir: string) {
  if (client.account.user !== plan.user || client.account.vaultId !== plan.vaultId || client.account.authMode !== plan.authMode) throw new Error('Recovery account differs from the saved plan.');
  await client.refresh();
  const prepared = prepareIndentationUpdate(client.doc, plan);
  if (prepared.status === 'already-applied' || prepared.items === 0) return { status: prepared.status === 'already-applied' ? prepared.status : 'no-changes', notes: prepared.notes, items: prepared.items };
  const directory = await backup(client, plan, backupDir);
  await client.refresh();
  const latest = prepareIndentationUpdate(client.doc, plan);
  if (latest.status === 'already-applied') return { status: latest.status, notes: latest.notes, items: latest.items, backup: directory };
  await client.submit(latest.update);
  await client.refresh();
  if (!client.doc.getMap('keepIndentationRepairs').has(plan.id)) throw new Error('The recovery receipt was not confirmed. Retry the same saved plan.');
  const items = client.doc.getMap<Y.Map<unknown>>('items');
  const conflicts = plan.notes.flatMap(note => note.links.filter(link => items.get(link.itemId)?.get('parentId') !== link.parentId).map(link => link.itemId));
  const result = { status: conflicts.length ? 'applied-with-concurrent-changes' : latest.status, notes: latest.notes, items: latest.items, backup: directory, updateBytes: latest.update.byteLength, ...(conflicts.length ? { conflictingItemIds: conflicts } : {}) };
  await atomicWrite(path.join(directory, 'result.json'), Buffer.from(json(result)));
  return result;
}

const help = `Recover checklist indentation from a saved Google Keep web page.

Preview, without changing notes:
  ./restore-keep-indentation.sh --html '/path/Google Keep.html' --import-plan /path/import/plan.json

Apply the exact preview:
  ./restore-keep-indentation.sh --plan /path/recovery/plan.json --apply --vault VAULT_ID

Only exact matches to unchanged, active imported checklists are eligible.
Incomplete previews recover only explicit relationships between visible rows.
Changed/ambiguous notes are reported and skipped; hidden rows are never inferred.
Credentials come from the workspace .env, as with import-keep.sh.
--backup-dir PATH sets persistent backups (default ../data/indentation-backups).
`;
export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, options: {
    html: { type: 'string' }, 'import-plan': { type: 'string' }, plan: { type: 'string' },
    apply: { type: 'boolean' }, vault: { type: 'string' }, 'backup-dir': { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help) { console.log(help); return; }
  if (values.plan ? values.html || values['import-plan'] : !values.html || !values['import-plan']) throw new Error('Supply --html and --import-plan, or one saved --plan.');
  if (values.apply && (!values.plan || !values.vault)) throw new Error('Apply requires the saved --plan and explicit --vault from its preview.');
  let plan: IndentationPlan | undefined;
  if (values.plan) {
    if ((await stat(values.plan)).size > 32 * 1024 * 1024) throw new Error('Recovery plan exceeds 32 MiB.');
    plan = JSON.parse(await readFile(values.plan, 'utf8')) as IndentationPlan;
    if (plan.format !== FORMAT || plan.checksum !== checksum(plan)) throw new Error('Recovery plan is invalid or changed.');
  }
  const imported = plan ? undefined : await readImportPlan(values['import-plan']!);
  const account = plan ?? imported!;
  if (values.vault && values.vault !== account.vaultId) throw new Error('Selected vault differs from the saved plan.');
  const client = await ImportClient.open({ url: account.server, authMode: account.authMode, user: account.user,
    expectedVaultId: account.vaultId, proxySecret: process.env.STOW_PROXY_SECRET, password: process.env.STOW_PASSWORD });
  try {
    let filename = values.plan;
    if (!plan) {
      if ((await stat(values.html!)).size > 32 * 1024 * 1024) throw new Error('Saved Keep page exceeds 32 MiB.');
      const html = await readFile(values.html!, 'utf8');
      plan = await createIndentationPlan(client, imported!, html);
      await mkdir(buildDir, { recursive: true });
      const directory = await mkdtemp(path.join(buildDir, 'keep-indentation-'));
      filename = path.join(directory, 'plan.json');
      await writeFile(filename, json(plan), { flag: 'wx', mode: 0o600 });
      await writeFile(path.join(directory, 'keep.html'), html, { flag: 'wx', mode: 0o600 });
    }
    console.log(json({ event: 'indentation-preview', user: plan.user, vaultId: plan.vaultId, summary: plan.summary, issues: plan.issues, plan: filename }).trim());
    if (values.apply) console.log(json(await executeIndentationPlan(client, plan, values['backup-dir'] ?? path.join(defaultDataDir, 'indentation-backups'))).trim());
  } finally { await client.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(`Indentation recovery stopped: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
}
