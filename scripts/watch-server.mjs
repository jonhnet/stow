import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import path from 'node:path';
let server;
let compiler;
let closing = false;
let pending = Promise.resolve();
let timer;
function start(command, args) {
  const child = spawn(command, args, { stdio: 'inherit' });
  const done = new Promise(resolve => {
    child.once('error', error => { console.error(error.message); resolve(1); });
    child.once('exit', code => resolve(code ?? 1));
  });
  return { child, done };
}
async function stop(process) {
  if (!process) return;
  process.child.kill('SIGTERM');
  await process.done;
}
async function rebuild() {
  if (closing) return;
  // Cargo replaces the executable at link time; the old running process keeps
  // serving from its original inode throughout compilation, even if it fails.
  compiler = start('cargo', ['build', '--locked']);
  const code = await compiler.done;
  compiler = undefined;
  if (closing) return;
  if (code !== 0) {
    if (server) console.error('Backend build failed; the previous server is still running.');
    return;
  }
  await stop(server);
  if (closing) return;
  const next = start(path.join(process.env.CARGO_TARGET_DIR, 'debug', 'stow-server'), []);
  server = next;
  void next.done.then(() => { if (server === next) server = undefined; });
}
function changed() {
  clearTimeout(timer);
  timer = setTimeout(() => { pending = pending.then(rebuild); }, 200);
}
const watchers = [watch('server-rust', changed), watch('.', (_event, name) => { if (['Cargo.toml', 'Cargo.lock'].includes(String(name))) changed(); })];
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => {
  closing = true; clearTimeout(timer); watchers.forEach(w => w.close());
  await Promise.all([stop(compiler), stop(server)]); await pending;
});
pending = rebuild();
