/** Client-side process lifecycle only. All fixture HTTP/proxy behavior is Rust. */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { buildDir, sourceDir } from '../paths.ts';
export type ServerOptions = { port?: number; host?: string; dataDir?: string; password?: string; authMode?: 'password' | 'proxy'; proxySecret?: string; allowInsecure?: boolean; origin?: string; staticDir?: string; now?: () => number };
export async function startServer(options: ServerOptions = {}, executable = path.join(buildDir, 'cargo-target', 'debug', 'stow-test-driver')) {
  const child = spawn(executable, ['serve'], { cwd: sourceDir, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '', ended: Error | undefined;
  const pending: { resolve(value: any): void; reject(error: Error): void }[] = [];
  const fail = (error: Error) => { ended = error; for (const waiter of pending.splice(0)) waiter.reject(error); };
  child.stderr.on('data', value => { stderr += value; });
  child.on('error', fail); child.stdin.on('error', fail);
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => { try { pending.shift()?.resolve(JSON.parse(line)); } catch (error) { fail(error as Error); } });
  const exited = new Promise<void>(resolve => child.once('close', (code, signal) => { lines.close(); fail(new Error(stderr || `Rust fixture exited (${code ?? signal})`)); resolve(); }));
  const request = (value: unknown): Promise<any> => {
    if (ended) return Promise.reject(ended);
    const reply = new Promise((resolve, reject) => pending.push({ resolve, reject }));
    child.stdin.write(JSON.stringify(value) + '\n'); return reply;
  };
  try {
    const ready = await request({ ...options, now: options.now?.() });
    return { port: ready.port as number, address: { address: ready.address as string, port: ready.port as number },
      async close() { if (!ended) child.stdin.end('{"op":"close"}\n'); await exited; },
      memory: (): Promise<{ rssBytes: number; maxRSSBytes: number }> => request({ op: 'memory' }),
    };
  } catch (error) { child.kill('SIGTERM'); await exited; throw error; }
}
