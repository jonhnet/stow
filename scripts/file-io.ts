import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

export async function syncDirectory(directoryPath: string) {
  const directory = await open(directoryPath, 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

/** Persist directory creation, including ancestors another vault may just have created. */
export async function mkdirDurable(directoryPath: string) {
  await mkdir(directoryPath, { recursive: true, mode: 0o700 });
  let directory = path.resolve(directoryPath);
  for (;;) {
    await syncDirectory(directory);
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
}

/** Rename is atomic; syncing the file and directory makes acknowledgements durable. */
export async function atomicWrite(destination: string, contents: Uint8Array) {
  const temporary = `${destination}.${randomBytes(8).toString('hex')}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(contents);
    await file.sync();
  } catch (error) {
    await file.close();
    await unlink(temporary).catch(() => {});
    throw error;
  }
  await file.close();
  try {
    await rename(temporary, destination);
    await syncDirectory(path.dirname(destination));
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

export async function readOptional(filename: string) {
  try { return await readFile(filename); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return undefined;
  }
}
