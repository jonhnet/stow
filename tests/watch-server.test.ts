import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { buildDir, sourceDir } from '../paths.ts';

test('the dev watcher serves during a blocked or failed build and stops both processes on shutdown', { timeout: 20000 }, async t => {
  const work = await mkdtemp(path.join(buildDir, 'watch-server-test-'));
  await Promise.all(['bin', 'server-rust', 'target/debug'].map(dir => mkdir(path.join(work, dir), { recursive: true })));
  const events = path.join(work, 'events.jsonl');
  await writeFile(path.join(work, 'package.json'), '{"type":"commonjs"}');
  await writeFile(events, '');
  await writeFile(path.join(work, 'bin/cargo'), `#!${process.execPath}
const fs = require('node:fs');
const events = ${JSON.stringify(events)};
const log = value => fs.appendFileSync(events, JSON.stringify(value) + '\\n');
const attempt = fs.readFileSync(events, 'utf8').split('\\n').filter(line => line && JSON.parse(line).event === 'build').length + 1;
log({ event: 'build', attempt, pid: process.pid });
const timer = setInterval(() => {
  if (!fs.existsSync('release-' + attempt)) return;
  clearInterval(timer);
  if (fs.readFileSync('release-' + attempt, 'utf8') === 'fail') { log({ event: 'failed', attempt }); process.exit(1); }
  const source = '#!' + ${JSON.stringify(process.execPath)} + '\\n' +
    'const fs = require("node:fs"); const http = require("node:http");' +
    'const server = http.createServer((req, res) => res.end(' + JSON.stringify(String(attempt)) + '));' +
    'const log = event => fs.appendFileSync(' + JSON.stringify(events) + ', JSON.stringify({event, attempt:' + attempt + ', pid:process.pid, port:server.address()?.port}) + "\\\\n");' +
    'server.listen(0, "127.0.0.1", () => log("ready"));' +
    'process.on("SIGTERM", () => {log("stopped"); server.close();});';
  fs.writeFileSync('target/debug/next', source, { mode: 0o755 });
  fs.renameSync('target/debug/next', 'target/debug/stow-server');
  log({ event: 'built', attempt });
}, 10);
`, { mode: 0o755 });
  const watcher = spawn(process.execPath, [path.join(sourceDir, 'scripts/watch-server.mjs')], {
    cwd: work, env: { ...process.env, PATH: `${work}/bin:${process.env.PATH}`, CARGO_TARGET_DIR: path.join(work, 'target') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  watcher.stdout.on('data', chunk => { output += chunk; });
  watcher.stderr.on('data', chunk => { output += chunk; });
  const exited = new Promise(resolve => watcher.once('exit', resolve));
  t.after(async () => { watcher.kill('SIGTERM'); await exited; await rm(work, { recursive: true, force: true }); });
  const records = async () => (await readFile(events, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const event = async (kind: string, attempt: number) => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const found = (await records()).find(value => value.event === kind && value.attempt === attempt);
      if (found) return found;
      assert.equal(watcher.exitCode, null, output);
      await pause(10);
    }
    assert.fail(`Timed out awaiting ${kind} ${attempt}: ${output}`);
  };
  const read = async (port: number) => (await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(1000) })).text();
  await event('build', 1); await writeFile(path.join(work, 'release-1'), 'pass');
  const first = await event('ready', 1);
  assert.equal(await read(first.port), '1');
  await writeFile(path.join(work, 'server-rust/change.rs'), 'build 2');
  await event('build', 2);
  assert.equal(await read(first.port), '1', 'The current server must stay up during compilation');
  await writeFile(path.join(work, 'release-2'), 'fail');
  await event('failed', 2);
  assert.equal(await read(first.port), '1', 'A failed build must preserve the running server');
  await writeFile(path.join(work, 'server-rust/change.rs'), 'build 3');
  await event('build', 3); assert.equal(await read(first.port), '1');
  await writeFile(path.join(work, 'release-3'), 'pass');
  const next = await event('ready', 3);
  await event('stopped', 1); assert.equal(await read(next.port), '3');
  await writeFile(path.join(work, 'server-rust/change.rs'), 'build 4');
  const compiler = await event('build', 4);
  assert.equal(await read(next.port), '3');
  watcher.kill('SIGTERM'); await exited; await event('stopped', 3);
  assert.throws(() => process.kill(compiler.pid, 0), { code: 'ESRCH' });
});
