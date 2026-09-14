import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { sourceDir } from '../../paths.ts';
export async function fingerprint() {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: sourceDir, encoding: 'utf8' });
  const files = [...new Set(git('ls-files', '--cached', '--others', '--exclude-standard', '-z', 'src', 'server-rust', 'scripts', 'Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', 'vite.config.ts').split('\0').filter(Boolean))].sort();
  const hash = createHash('sha256');
  for (const file of files) hash.update(file).update('\0').update(await readFile(path.join(sourceDir, file)));
  return { commit: git('rev-parse', 'HEAD').trim(), sourceSha256: hash.digest('hex') };
}
