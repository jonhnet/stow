import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import * as Y from 'yjs';
import { buildDir, defaultDataDir, sourceDir } from '../paths.ts';
import { applyImport, type ImportedNote, type ImportOptions } from '../src/core/import.ts';
import { Vault } from '../src/core/vault.ts';
import { atomicWrite, mkdirDurable } from './file-io.ts';
import { ImportClient, type ImportClientOptions } from './import-client.ts';
import { readKeepSource, type KeepSourceBlob, type KeepSourceNote } from './keep-source.ts';
import { collectReferencedBlobHashes, importBlobOwner } from '../src/core/blob-references.ts';

const FORMAT = 'stow-keep-import-v1';
const MAX_UPDATE = 16 * 1024 * 1024;
const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
type PlanBlob = Omit<KeepSourceBlob, 'role'> & { role: KeepSourceBlob['role'] | 'source-manifest' };
export interface ImportPlan {
  format: typeof FORMAT;
  createdAt: string;
  server: string;
  authMode: 'password' | 'proxy';
  user: string;
  vaultId: string;
  workDir: string;
  mode: 'append' | 'replace';
  operation: ImportOptions;
  blobs: PlanBlob[];
  warnings: { code: string; sourcePaths: string[] }[];
  summary: Record<string, number>;
  checksum: string;
}

function planChecksum(plan: Omit<ImportPlan, 'checksum'> | ImportPlan) {
  const { checksum: _checksum, ...contents } = plan as ImportPlan;
  return sha256(JSON.stringify(contents));
}
function under(filename: string, directory: string) {
  const relative = path.relative(directory, filename);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}
function namedId(operationId: string, ...parts: (string | number)[]) {
  return `keep-${sha256(JSON.stringify([operationId, ...parts])).slice(0, 32)}`;
}
export function assignImportIds(notes: KeepSourceNote[], operationId: string): ImportedNote[] {
  return notes.map(note => {
    const id = namedId(operationId, 'note', note.sourcePath);
    return {
      id, title: note.title, body: note.body, kind: note.kind, color: note.color,
      pinned: note.pinned, archived: note.archived, trashed: note.trashed,
      createdAt: note.createdAt, updatedAt: note.updatedAt, labels: note.labels, takeout: note.takeout,
      items: note.items.map((item, index) => ({ id: namedId(operationId, 'item', note.sourcePath, index), noteId: id, text: item.text, checked: item.checked, rank: (index + 1) * 1024 })),
      images: note.attachments.map((attachment, index) => ({ id: namedId(operationId, 'attachment', note.sourcePath, index), noteId: id, hash: attachment.hash, name: attachment.name, type: attachment.type, size: attachment.size, order: index })),
    };
  });
}

/** Prepare against a copy, so validation or encoding failure cannot mutate the live client. */
export function prepareImportUpdate(doc: Y.Doc, plan: Pick<ImportPlan, 'operation' | 'mode'>) {
  const vault = new Vault();
  try {
    Y.applyUpdate(vault.doc, Y.encodeStateAsUpdate(doc), 'remote');
    const vector = Y.encodeStateVector(vault.doc);
    let result!: ReturnType<typeof applyImport>;
    vault.doc.transact(() => {
      result = applyImport(vault, plan.operation);
      if (result.status === 'applied') vault.doc.getMap('importSources').set(plan.operation.id, {
        source: 'google-keep', manifestHash: plan.operation.manifestHash, mode: plan.mode,
      });
    }, 'import');
    const update = Y.encodeStateAsUpdate(vault.doc, vector);
    if (update.byteLength > MAX_UPDATE) throw new Error(`Import needs ${update.byteLength} update bytes; the current sync limit is ${MAX_UPDATE}. No notes have been changed. Split the input into smaller append imports.`);
    return { update, result, snapshotBytes: Y.encodeStateAsUpdate(vault.doc).byteLength };
  } finally { vault.destroy(); }
}

export async function createImportPlan(client: ImportClient, input: string, replace: boolean, workDir: string, server: string): Promise<ImportPlan> {
  const source = await readKeepSource(input, path.join(workDir, 'source'));
  const checklists = source.notes.filter(note => note.kind === 'checklist');
  if (checklists.length) source.warnings.push({ code: 'checklist-hierarchy-unavailable-in-takeout', sourcePaths: checklists.map(note => note.sourcePath) });
  const notes = [...source.notes].sort((a, b) => a.sourcePath.localeCompare(b.sourcePath));
  if (!notes.length) throw new Error('No Google Keep notes were found; an empty import cannot replace a vault.');
  const blobs = [...source.blobs].sort((a, b) => a.hash.localeCompare(b.hash));
  const manifest = {
    format: 'stow-keep-source-v1', notes,
    files: blobs.map(blob => ({ hash: blob.hash, size: blob.size, type: blob.type, role: blob.role, sourcePaths: blob.sourcePaths })),
    warnings: source.warnings,
  };
  const bytes = Buffer.from(json(manifest));
  const manifestHash = sha256(bytes);
  const catalogPath = path.join(workDir, 'source-manifest.json');
  await writeFile(catalogPath, bytes, { flag: 'wx', mode: 0o600 });
  await client.refresh();
  const id = replace ? `keep-replace:${randomUUID()}` : `keep-append:${manifestHash}`;
  const operation: ImportOptions = {
    id, manifestHash, notes: assignImportIds(notes, id),
    replaceSourceIds: replace ? [...client.doc.getMap('notes').keys()].sort() : [],
  };
  const plan: ImportPlan = {
    format: FORMAT, createdAt: new Date().toISOString(), server,
    authMode: client.account.authMode, user: client.account.user, vaultId: client.account.vaultId,
    workDir, mode: replace ? 'replace' : 'append', operation,
    blobs: [...blobs, { hash: manifestHash, path: catalogPath, size: bytes.length, type: 'application/json', role: 'source-manifest', sourcePaths: [] }],
    warnings: source.warnings,
    summary: {
      notes: notes.length,
      active: notes.filter(note => !note.archived && !note.trashed).length,
      archived: notes.filter(note => note.archived && !note.trashed).length,
      trashed: notes.filter(note => note.trashed).length,
      pinned: notes.filter(note => note.pinned).length,
      checklistItems: notes.reduce((n, note) => n + note.items.length, 0),
      checkedItems: notes.reduce((n, note) => n + note.items.filter(item => item.checked).length, 0),
      attachments: notes.reduce((n, note) => n + note.attachments.length, 0),
      labeledNotes: notes.filter(note => note.labels.length).length,
      labels: new Set(notes.flatMap(note => note.labels)).size,
      replacing: operation.replaceSourceIds.length,
      uploadFiles: blobs.length + 1,
      uploadBytes: blobs.reduce((n, blob) => n + blob.size, bytes.length),
    }, checksum: '',
  };
  const prepared = prepareImportUpdate(client.doc, plan);
  plan.summary.updateBytes = prepared.update.byteLength;
  plan.summary.resultingSnapshotBytes = prepared.snapshotBytes;
  plan.checksum = planChecksum(plan);
  return plan;
}

export async function readImportPlan(filename: string): Promise<ImportPlan> {
  if ((await stat(filename)).size > 32 * 1024 * 1024) throw new Error('Import plan exceeds 32 MiB.');
  const plan = JSON.parse(await readFile(filename, 'utf8')) as ImportPlan;
  if (plan.format !== FORMAT || plan.checksum !== planChecksum(plan)) throw new Error('Import plan is invalid or changed. Generate a new preview.');
  if (!/^[a-f0-9]{64}$/.test(plan.vaultId) || !['proxy', 'password'].includes(plan.authMode) || !['append', 'replace'].includes(plan.mode)) throw new Error('Import plan account or mode is invalid.');
  const workDir = await realpath(plan.workDir);
  for (const blob of plan.blobs) {
    if (!under(await realpath(blob.path), workDir)) throw new Error('An import file is outside its staging directory. Generate a new preview.');
    const info = await stat(blob.path);
    if (!info.isFile() || !Number.isSafeInteger(blob.size) || blob.size <= 0 || blob.size > 20 * 1024 * 1024 || info.size !== blob.size) throw new Error('An import file has an invalid size or changed after preview.');
    const bytes = await readFile(blob.path);
    if (bytes.length !== blob.size || sha256(bytes) !== blob.hash) throw new Error('An import file changed after preview. Generate a new preview.');
  }
  const hashes = new Set(plan.blobs.map(blob => blob.hash));
  if (!hashes.has(plan.operation.manifestHash)) throw new Error('The source manifest is missing.');
  for (const note of plan.operation.notes) {
    if (!note.takeout || !hashes.has(note.takeout.rawHash) || note.images.some(image => !hashes.has(image.hash))) throw new Error('The plan is missing source data or a referenced attachment.');
  }
  return plan;
}

async function saveBeforeImport(client: ImportClient, plan: ImportPlan, backupDir: string) {
  backupDir = path.resolve(backupDir);
  if (backupDir === buildDir || under(backupDir, buildDir) || backupDir === sourceDir || under(backupDir, sourceDir)) throw new Error('Import backups must stay outside the source checkout and build/.');
  await mkdirDurable(backupDir);
  const real = await realpath(backupDir);
  if (real === buildDir || under(real, buildDir) || real === sourceDir || under(real, sourceDir)) throw new Error('The backup directory resolves inside disposable build files or source.');
  const directory = path.join(real, plan.vaultId, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
  await mkdirDurable(directory);
  const snapshot = Y.encodeStateAsUpdate(client.doc);
  const vault = new Vault();
  try {
    Y.applyUpdate(vault.doc, snapshot, 'remote');
    const history = await client.historyExport();
    const hashes = collectReferencedBlobHashes(vault.doc);
    for (const version of history.versions) {
      for (const source of Object.values(version.state.sources)) {
        for (const image of Object.values(source.images)) hashes.add(image.hash);
      }
    }
    await atomicWrite(path.join(directory, 'before.yjs'), snapshot);
    await atomicWrite(path.join(directory, 'before-notes.json'), Buffer.from(json({ user: plan.user, vaultId: plan.vaultId, notes: vault.getNotes() })));
    await atomicWrite(path.join(directory, 'before-history.json'), Buffer.from(json(history)));
    await atomicWrite(path.join(directory, 'import-plan.json'), Buffer.from(json(plan)));
    if (hashes.size) {
      await mkdirDurable(path.join(directory, 'blobs'));
      for (const hash of [...hashes].sort()) await atomicWrite(path.join(directory, 'blobs', hash), await client.getBlob(hash));
    }
  } finally { vault.destroy(); }
  return directory;
}

export async function executeImportPlan(client: ImportClient, plan: ImportPlan, backupDir: string, log: (value: unknown) => void = console.log) {
  if (client.account.vaultId !== plan.vaultId || client.account.user !== plan.user || client.account.authMode !== plan.authMode) throw new Error('The authenticated account does not match the reviewed import plan.');
  await client.refresh();
  const preflight = prepareImportUpdate(client.doc, plan);
  if (preflight.result.status === 'already-applied') return { ...preflight.result, vaultId: plan.vaultId };
  const backup = await saveBeforeImport(client, plan, backupDir);
  log({ event: 'backup-saved', directory: backup });
  let uploaded = 0, existing = 0, completed = 0;
  // Sequential bounded memory and deterministic progress; failures stop before note publication.
  for (const blob of plan.blobs) {
    const sourceIds = blob.hash === plan.operation.manifestHash ? [importBlobOwner(plan.operation.id)] : plan.operation.notes
      .filter(note => note.takeout?.rawHash === blob.hash || note.images.some(image => image.hash === blob.hash)).map(note => note.id);
    const outcome = await client.putBlob({ ...blob, sourceIds });
    if (outcome === 'uploaded') uploaded++; else existing++;
    completed++;
    if (completed % 100 === 0 || completed === plan.blobs.length) log({ event: 'files-stored', completed, total: plan.blobs.length, uploaded, existing });
  }
  // Re-validate replacement IDs after uploads. Notes created meanwhile are preserved.
  await client.refresh();
  const prepared = prepareImportUpdate(client.doc, plan);
  if (prepared.result.status === 'already-applied') return { ...prepared.result, backup, vaultId: plan.vaultId };
  await client.submit(prepared.update);
  await client.refresh();
  const receipt = client.doc.getMap<{ manifestHash: string }>('imports').get(plan.operation.id);
  if (receipt?.manifestHash !== plan.operation.manifestHash) throw new Error('The server acknowledged the update but the import receipt could not be verified. Keep the plan and retry it.');
  const result = { ...prepared.result, vaultId: plan.vaultId, backup, uploaded, existing, updateBytes: prepared.update.byteLength };
  await atomicWrite(path.join(backup, 'result.json'), Buffer.from(json(result)));
  return result;
}

const help = `Import Google Keep into an explicitly selected Stow account.

Preview (no uploads or note changes):
  ./import-keep.sh --input /path/takeout.tgz --user owner@example.com --replace

Apply the exact saved plan:
  ./import-keep.sh --plan /path/plan.json --apply --vault <vault-id-from-preview>

Options:
  --input PATH        .tgz/.tar.gz or an extracted Takeout/Keep directory
  --plan PATH         Reopen a saved preview; safe to retry after interruption
  --server URL        Backend root URL (default http://127.0.0.1:3001)
  --user ID           Exact proxy identity; required for proxy mode
  --auth-mode MODE    proxy or password (defaults to STOW_AUTH_MODE or password)
  --replace           Replace the sources observed during preview; default appends
  --apply             Upload files and commit the prepared import
  --vault ID          Required with --apply; must equal the authenticated vault
  --backup-dir PATH   Persistent backups (default ../data/import-backups)
  --staging-dir PATH  Preview location within build/ (default ../build)
  --help              Show this help

Credentials come from STOW_PROXY_SECRET or STOW_PASSWORD, never command arguments.
The wrapper reads the workspace .env. Each new --replace preview uses fresh note IDs;
retry its saved plan to avoid duplicates. Existing source history and server blobs remain.
`;

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, options: {
    input: { type: 'string' }, plan: { type: 'string' }, server: { type: 'string' }, user: { type: 'string' },
    'auth-mode': { type: 'string' }, replace: { type: 'boolean' }, apply: { type: 'boolean' }, vault: { type: 'string' },
    'backup-dir': { type: 'string' }, 'staging-dir': { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help) { console.log(help); return; }
  if (!!values.input === !!values.plan) throw new Error('Supply exactly one of --input or --plan. Use --help for examples.');
  if (values.plan && values.replace) throw new Error('Replacement choices are frozen in the saved plan; create a new --input preview to change them.');
  if (values.apply && !values.vault) throw new Error('--apply requires --vault from the preview, to select the destination explicitly.');
  let planFilename = values.plan ? path.resolve(values.plan) : undefined;
  let plan = planFilename ? await readImportPlan(planFilename) : undefined;
  const mode = values['auth-mode'] ?? plan?.authMode ?? process.env.STOW_AUTH_MODE ?? 'password';
  if (mode !== 'proxy' && mode !== 'password') throw new Error('--auth-mode must be proxy or password.');
  const server = new URL(values.server ?? plan?.server ?? 'http://127.0.0.1:3001');
  if (!['http:', 'https:'].includes(server.protocol) || server.username || server.password || server.pathname !== '/' || server.search || server.hash) throw new Error('--server must be an HTTP(S) backend root URL without credentials.');
  const user = values.user ?? (mode === 'proxy' ? plan?.user : undefined);
  if (plan && (server.origin !== plan.server || mode !== plan.authMode || (user !== undefined && user !== plan.user))) throw new Error('The server or identity differs from the saved plan. Generate a new preview.');
  if (plan && values.vault && values.vault !== plan.vaultId) throw new Error('--vault differs from the saved plan.');
  const options: ImportClientOptions = { url: server.origin, authMode: mode, user, proxySecret: process.env.STOW_PROXY_SECRET, password: process.env.STOW_PASSWORD, expectedVaultId: values.vault ?? plan?.vaultId };
  const client = await ImportClient.open(options);
  try {
    if (!plan) {
      const stagingDir = path.resolve(values['staging-dir'] ?? buildDir);
      await mkdir(stagingDir, { recursive: true });
      const workDir = await mkdtemp(path.join(stagingDir, 'keep-import-'));
      console.log(json({ event: 'reading-takeout', user: client.account.user, vaultId: client.account.vaultId, staging: workDir }).trim());
      plan = await createImportPlan(client, path.resolve(values.input!), !!values.replace, workDir, server.origin);
      planFilename = path.join(workDir, 'plan.json');
      await writeFile(planFilename, json(plan), { flag: 'wx', mode: 0o600 });
    }
    console.log(json({ event: 'preview', user: plan.user, vaultId: plan.vaultId, mode: plan.mode, summary: plan.summary, warnings: plan.warnings.map(warning => ({ code: warning.code, affectedFiles: warning.sourcePaths.length })), plan: planFilename }).trim());
    if (!values.apply) { console.log('Preview only. Apply this saved plan with --plan PATH --apply --vault ID.'); return; }
    // Recheck all staged bytes immediately before any upload, also for one-command imports.
    plan = await readImportPlan(planFilename!);
    const result = await executeImportPlan(client, plan, values['backup-dir'] ?? path.join(defaultDataDir, 'import-backups'), value => console.log(JSON.stringify(value)));
    console.log(json({ event: 'import-complete', ...result }).trim());
  } finally { await client.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(`Import stopped: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
}
