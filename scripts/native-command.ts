import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { buildDir, sourceDir } from '../paths.ts';
export function nativeResult(reply: any): any {
  if (!reply.ok) throw Object.assign(new Error(`${reply.code ? `${reply.code}: ` : ''}${reply.error}`), reply.code ? { code: reply.code } : {}, reply.status ? { status: reply.status } : {});
  return reply.value;
}
/** Client experiments invoke native commands; no backend policy is implemented here. */
export function nativeCommand(request: unknown): any {
  const executable = process.env.STOW_SERVER_BIN ?? path.join(buildDir, 'cargo-target', 'debug', 'stow-server');
  const result = spawnSync(executable, ['bridge'], { cwd: sourceDir, input: JSON.stringify(request) + '\n', encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, timeout: 120_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || `Native backend exited ${result.status}`);
  return nativeResult(JSON.parse(result.stdout));
}
