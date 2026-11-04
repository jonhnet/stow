import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Manifest installation is all-or-nothing; APKs have their own release lifetime. */
export async function writeAndroidRelease(directory: string) {
  const files: Record<string, { sha256: string; bytes: number }> = {};
  async function visit(relative: string) {
    for (const entry of (await readdir(path.join(directory, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) { if (name !== 'android') await visit(name); continue; }
      if (!entry.isFile() || name === 'release.json' || name.endsWith('.map') || name === 'sw.js') continue;
      const bytes = await readFile(path.join(directory, name));
      files['/' + name] = { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.byteLength };
    }
  }
  await visit('');
  for (const name of ['/index.html', '/background.html']) if (!files[name]) throw new Error(`Android release is missing ${name}`);
  const release = createHash('sha256').update(JSON.stringify(files)).digest('hex');
  await writeFile(path.join(directory, 'release.json'), JSON.stringify({ format: 1, release, minimumShellApi: 1, files, android: null }) + '\n');
}
