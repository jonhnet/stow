import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'vite';

test('the dev file server denies vaults and deployment secrets, including raw and URL imports', async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'stow-dev-security-'));
  const root = path.join(fixture, 'site');
  const privateDir = path.join(fixture, 'data');
  const sentinel = 'STOW_PRIVATE_FIXTURE_NEVER_SENT_TO_A_BROWSER';
  const files = [
    path.join(root, 'data', 'vault.yjs'),
    path.join(root, 'data', 'users', 'alice', 'vault.yjs'),
    path.join(root, 'data', 'blobs', 'image-hash'),
    path.join(root, 'data', 'session-secret'),
    path.join(root, '.env'),
    path.join(root, '.env.local'),
    path.join(root, 'tls.pem'),
    path.join(root, '.git', 'config'),
    path.join(fixture, '.env'),
    path.join(fixture, '.env.production'),
    path.join(privateDir, 'users', 'bob', 'vault.yjs'),
    path.join(privateDir, 'session-secret'),
  ];
  let server: Awaited<ReturnType<typeof createServer>> | undefined;
  const httpServer = createHttpServer((request, response) => server!.middlewares(request, response, () => {
    response.statusCode = 404;
    response.end();
  }));
  try {
    for (const file of files) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, sentinel);
    }
    await writeFile(path.join(root, 'visible.txt'), 'public fixture');
    const { default: config } = await import('../vite.config.ts');
    server = await createServer({
      ...config,
      configFile: false,
      root,
      envFile: false,
      cacheDir: path.join(fixture, 'cache'),
      appType: 'custom',
      logLevel: 'silent',
      optimizeDeps: { noDiscovery: true, include: [] },
      server: {
        ...config.server,
        middlewareMode: true, hmr: false,
        // Permit the whole fixture so deny rules must protect private files,
        // including secrets and data beside the source tree.
        fs: { ...config.server?.fs, allow: [fixture] },
      },
    });
    await new Promise<void>((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(0, '127.0.0.1', resolve);
    });
    const address = httpServer.address();
    assert(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    assert.equal(await (await fetch(`${origin}/visible.txt`)).text(), 'public fixture');
    for (const file of files) {
      const requests = [`/@fs${file}`, `/@fs/${file}`];
      if (file.startsWith(`${root}/`)) requests.push(`/${path.relative(root, file)}`);
      // URI decoding must not turn an allowed-looking path into a private one.
      const basename = path.basename(file);
      for (const requestPath of [...requests]) {
        requests.push(`${requestPath.slice(0, -basename.length)}%${basename.charCodeAt(0).toString(16)}${basename.slice(1)}`);
      }
      for (const requestPath of requests) {
        for (const query of ['', '?import', '?raw', '?url', '?raw&import', '?url&import', '?raw??', '?url&inline']) {
          const url = `${origin}${requestPath}${query}`;
          const response = await fetch(url);
          const body = await response.text();
          assert(!body.includes(sentinel), `${requestPath}${query} leaked private data`);
          assert.equal(response.status, 403, `${requestPath}${query} must be denied`);
        }
      }
    }
  } finally {
    httpServer.closeAllConnections();
    if (httpServer.listening) await new Promise<void>((resolve, reject) => httpServer.close(error => error ? reject(error) : resolve()));
    await server?.close();
    await rm(fixture, { recursive: true, force: true });
  }
});
