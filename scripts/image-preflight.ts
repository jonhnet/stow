import { spawn } from 'node:child_process';
import path from 'node:path';
import { buildDir } from '../paths.ts';

/** The importer and HTTP server use exactly the same native decoder and limits. */
export function checkImage(bytes: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.STOW_SERVER_BIN ?? path.join(buildDir, 'cargo-target', 'debug', 'stow-server'), ['check-image']);
    let error = '';
    child.stdout.resume();
    child.stderr.on('data', chunk => { error += chunk; });
    child.on('error', reject);
    child.stdin.on('error', () => {}); // The process's exit status reports decoder rejection.
    child.on('close', code => code === 0 ? resolve() : reject(new Error(error || 'Image could not be decoded')));
    child.stdin.end(bytes);
  });
}
