import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { buildInfo } from '../scripts/build-info';
import { buildDir, sourceDir } from '../paths';

test('running build metadata survives deployment archives and distinguishes modified checkouts', t => {
  const root = mkdtempSync(path.join(buildDir, 'version-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'); mkdirSync(source);
  for (const name of ['.gitattributes', 'build-version.json']) writeFileSync(path.join(source, name), readFileSync(path.join(sourceDir, name)));
  const git = (...args: string[]) => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_AUTHOR_DATE: '2026-09-01T12:34:56Z', GIT_COMMITTER_DATE: '2026-09-02T01:02:03Z' } }).trim();
  git('init'); git('add', '.'); git('-c', 'user.name=Version test', '-c', 'user.email=version@example.test', 'commit', '-m', 'fixture');
  const version = buildInfo(source, '');
  assert.equal(version.commit, git('rev-parse', 'HEAD'));
  assert.equal(Date.parse(version.committedAt!), Date.parse('2026-09-02T01:02:03Z'));
  assert.equal(version.dirty, false);
  const archive = path.join(root, 'source.tar'); git('archive', '--output', archive, 'HEAD');
  // Even nested under a different Git checkout, an archive identifies itself.
  const exported = path.join(source, 'exported'); mkdirSync(exported);
  execFileSync('tar', ['-xf', archive, '-C', exported]);
  assert.deepEqual(buildInfo(exported, ''), version);
  writeFileSync(path.join(source, 'change.txt'), 'modified'); assert.equal(buildInfo(source, '').dirty, true);
  assert.deepEqual(buildInfo(exported, JSON.stringify(version)), version);
  writeFileSync(path.join(exported, 'build-version.json'), readFileSync(path.join(sourceDir, 'build-version.json')));
  assert.deepEqual(buildInfo(exported, ''), { commit: null, committedAt: null, dirty: false });
  assert.throws(() => buildInfo(exported, '{"commit":"made-up"}'), /Invalid Stow build metadata/);
});
