import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { buildDir, sourceDir } from '../paths.ts';

test('the development wrapper preserves configured origins and uses loopback without one', async t => {
  const workspace = await mkdtemp(path.join(buildDir, 'run-dev-test-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const checkout = path.join(workspace, 'source'), bin = path.join(workspace, 'bin');
  await mkdir(checkout); await mkdir(bin);
  await copyFile(path.join(sourceDir, 'run-dev.sh'), path.join(checkout, 'run-dev.sh'));
  await writeFile(path.join(bin, 'npm'), '#!/bin/sh\nprintf "%s|%s|%s\\n" "$*" "${STOW_ORIGIN:-}" "$STOW_AUTH_MODE"\n', { mode: 0o755 });
  const env = { PATH: `${bin}:${process.env.PATH}`, STOW_PASSWORD: 'local-test-password' };
  const run = (extra = {}) => spawnSync('bash', [path.join(checkout, 'run-dev.sh')], { cwd: '/', env: { ...env, ...extra }, encoding: 'utf8' });
  let result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'run dev||password');
  result = run({ STOW_ORIGIN: 'https://notes.example.test:8443' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'run dev:lan|https://notes.example.test:8443|password');
  await writeFile(path.join(workspace, '.env'), 'STOW_ORIGIN=https://configured.example.test\nSTOW_AUTH_MODE=proxy\nSTOW_PROXY_SECRET=test-proxy-proof-test-proxy-proof\n');
  result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'run dev:lan|https://configured.example.test|proxy');
});
