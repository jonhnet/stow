import { constants, createWriteStream } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { extract } from 'tar-stream';
import { buildDir } from '../paths.ts';

export interface KeepSourceLimits { maxEntries?: number; maxFileBytes?: number; maxTotalBytes?: number }
export interface StagedKeepFile { path: string; size: number }

function within(parent: string, candidate: string) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function entryPath(value: string, directory: boolean) {
  if (typeof value !== 'string' || value.includes('\0') || value.includes('\\') || value.startsWith('/') || /^[a-z]:/i.test(value)) {
    throw new Error('Keep source contains an absolute or unsafe entry path.');
  }
  const parts = value.split('/');
  if (parts.includes('..')) throw new Error('Keep source contains a traversal entry path.');
  const normalized = parts.filter(part => part && part !== '.').join('/');
  if (/^[a-z]:/i.test(normalized)) throw new Error('Keep source contains an absolute or unsafe entry path.');
  if (!normalized && !directory) throw new Error('Keep source contains an empty file path.');
  return normalized;
}

async function emptyStagingDirectory(staging: string) {
  const root = path.resolve(buildDir);
  if (staging === root || !within(root, staging)) throw new Error('Keep staging directory must be a child of build/.');
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('Keep staging build directory must be a real directory.');
  let current = root;
  for (const component of path.relative(root, staging).split(path.sep)) {
    current = path.join(current, component);
    try { await mkdir(current, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Keep staging path contains a link or non-directory component.');
  }
  if ((await readdir(staging)).length) throw new Error('Keep staging directory must be empty.');
  await chmod(staging, 0o700);
}

/** Stage regular files without trusting archive paths, links, modes, or claimed sizes. */
export async function stageKeepSource(inputPath: string, stagingDir: string, options: KeepSourceLimits = {}): Promise<Map<string, StagedKeepFile>> {
  const limits = { maxEntries: options.maxEntries ?? 100_000, maxFileBytes: options.maxFileBytes ?? 20 * 1024 * 1024, maxTotalBytes: options.maxTotalBytes ?? 5 * 1024 ** 3 };
  for (const value of Object.values(limits)) if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Keep source limits must be positive safe integers.');
  const input = path.resolve(inputPath), staging = path.resolve(stagingDir);
  const inputInfo = await lstat(input);
  if (inputInfo.isSymbolicLink() || (!inputInfo.isDirectory() && !inputInfo.isFile()) || (inputInfo.isFile() && inputInfo.nlink !== 1)) {
    throw new Error('Keep source must be a regular archive file or directory, without links.');
  }
  const inputReal = await realpath(input);
  if (inputInfo.isDirectory() && within(inputReal, staging)) throw new Error('Keep staging directory cannot be inside the input directory.');
  if (inputInfo.isFile() && !/\.(tgz|tar\.gz)$/i.test(input)) throw new Error('Keep archive must have a .tgz or .tar.gz extension.');
  await emptyStagingDirectory(staging);

  const files = new Map<string, StagedKeepFile>();
  const explicit = new Set<string>(), kinds = new Map<string, 'file' | 'directory'>();
  let entries = 0, totalBytes = 0;
  function register(raw: string, kind: 'file' | 'directory') {
    if (++entries > limits.maxEntries) throw new Error('Keep source exceeds the entry count limit.');
    const name = entryPath(raw, kind === 'directory');
    if (explicit.has(name)) throw new Error('Keep source contains duplicate entry paths.');
    const pieces = name.split('/');
    for (let index = 1; index < pieces.length; index++) {
      const parent = pieces.slice(0, index).join('/');
      if (kinds.get(parent) === 'file') throw new Error('Keep source contains a file/directory path collision.');
      kinds.set(parent, 'directory');
    }
    const previous = kinds.get(name);
    if (previous === 'file' || (previous === 'directory' && kind === 'file')) throw new Error('Keep source contains a file/directory path collision.');
    explicit.add(name); kinds.set(name, kind);
    return name;
  }
  async function directory(name: string) {
    if (name) await mkdir(path.join(staging, ...name.split('/')), { recursive: true, mode: 0o700 });
  }
  async function file(name: string, size: number, stream: AsyncIterable<unknown>) {
    if (!Number.isSafeInteger(size) || size < 0 || size > limits.maxFileBytes) throw new Error('Keep source exceeds the per-file byte limit or has an invalid size.');
    if (size > limits.maxTotalBytes - totalBytes) throw new Error('Keep source exceeds the total byte limit.');
    const destination = path.join(staging, ...name.split('/'));
    await directory(path.posix.dirname(name) === '.' ? '' : path.posix.dirname(name));
    let bytes = 0;
    const measure = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > size || bytes > limits.maxFileBytes) callback(new Error('Keep source entry exceeds its declared size or the per-file byte limit.'));
      else callback(null, chunk);
    } });
    await pipeline(Readable.from(stream, { objectMode: false }), measure, createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
    if (bytes !== size) throw new Error('Keep source entry does not match its declared size.');
    totalBytes += bytes; files.set(name, { path: destination, size: bytes });
  }

  if (inputInfo.isDirectory()) {
    async function walk(source: string, relative: string) {
      const children = await readdir(source, { withFileTypes: true });
      children.sort((a, b) => a.name.localeCompare(b.name));
      for (const child of children) {
        const childPath = path.join(source, child.name), raw = relative ? `${relative}/${child.name}` : child.name;
        const info = await lstat(childPath);
        if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile()) || (info.isFile() && info.nlink !== 1)) throw new Error('Keep source contains a link or unsupported file type.');
        if (info.isDirectory()) {
          const name = register(raw, 'directory'); await directory(name); await walk(childPath, name);
        } else {
          const name = register(raw, 'file');
          const handle = await open(childPath, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            const opened = await handle.stat();
            if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== info.dev || opened.ino !== info.ino) throw new Error('Keep source file changed while it was being staged.');
            await file(name, opened.size, handle.createReadStream({ autoClose: false }));
          } finally { await handle.close(); }
        }
      }
    }
    await walk(inputReal, '');
  } else {
    const archive = extract();
    // Bound compressed-stream expansion too, including headers, padding and PAX
    // metadata that tar-stream consumes without exposing as normal entries.
    const maxExpanded = limits.maxTotalBytes + limits.maxEntries * (16 * 1024) + 1024;
    let expanded = 0;
    const measure = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      expanded += chunk.length;
      if (expanded > maxExpanded) callback(new Error('Keep archive exceeds its expanded byte limit.'));
      else callback(null, chunk);
    } });
    const handle = await open(input, constants.O_RDONLY | constants.O_NOFOLLOW);
    const finished = pipeline(handle.createReadStream({ autoClose: false }), createGunzip(), measure, archive);
    void finished.catch(() => {});
    try {
      for await (const entry of archive) {
        const header = entry.header;
        if ((header.type !== 'file' && header.type !== 'directory') || header.linkname) throw new Error('Keep archive contains a link or unsupported entry type.');
        const name = register(header.name, header.type);
        if (header.type === 'directory') {
          if (header.size !== 0) throw new Error('Keep archive directory has an invalid nonzero size.');
          await directory(name);
          for await (const chunk of entry) if (!(chunk instanceof Uint8Array) || chunk.byteLength) throw new Error('Keep archive directory contains unexpected data.');
        } else await file(name, header.size!, entry);
      }
      await finished;
    } catch (error) {
      archive.destroy(error instanceof Error ? error : new Error('Keep archive staging failed.'));
      await finished.catch(() => {});
      throw error;
    } finally { await handle.close(); }
  }
  return files;
}
