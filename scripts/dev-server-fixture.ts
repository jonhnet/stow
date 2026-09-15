/** The real Vite development proxy in front of a disposable Rust vault. */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { createServer as createListener } from 'node:net';
import { createServer, loadConfigFromFile, type ProxyOptions, type ViteDevServer } from 'vite';
import { buildDir, sourceDir } from '../paths.ts';
import { startServer } from './server-fixture.ts';

export async function startDevServer() {
  const temporary = path.join(buildDir, 'tmp');
  await mkdir(temporary, { recursive: true });
  const directory = await mkdtemp(path.join(temporary, 'dev-proxy-'));
  let backend: Awaited<ReturnType<typeof startServer>> | undefined;
  let vite: ViteDevServer | undefined;
  let port = 0;
  const closeVite = async () => {
    // HTTP-only tests can finish before Vite's initial dependency scan does.
    try { await vite?.environments.client.depsOptimizer?.scanProcessing; }
    finally { await vite?.close(); }
  };
  const close = async () => {
    try { await closeVite(); }
    finally {
      try { await backend?.close(); }
      finally { await rm(directory, { recursive: true, force: true }); }
    }
  };
  try {
    backend = await startServer({ host: '127.0.0.1', port: 0, dataDir: path.join(directory, 'data'),
      authMode: 'password', password: '', origin: '' });
    const loaded = await loadConfigFromFile({ command: 'serve', mode: 'development' }, path.join(sourceDir, 'vite.config.ts'));
    if (!loaded?.config.server?.proxy) throw new Error('The Stow development proxy configuration is missing.');
    const config = loaded.config;
    // Vite treats port 0 as its default, so reserve an OS-selected test port first.
    const listener = createListener();
    await new Promise<void>((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
    port = (listener.address() as { port: number }).port;
    await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
    const start = async (changeOrigin?: boolean) => {
      const proxy: Record<string, string | ProxyOptions> = {};
      for (const [route, options] of Object.entries(config.server!.proxy!)) {
        const target = new URL(typeof options === 'string' ? options : String(options.target));
        target.hostname = '127.0.0.1'; target.port = String(backend!.port);
        // Retain string shorthand: converting it here would mask Vite's Host rewrite.
        proxy[route] = typeof options === 'string' ? target.href : { ...options, target: target.href };
      }
      if (changeOrigin !== undefined) {
        const options = proxy['/api'];
        proxy['/api'] = { ...(typeof options === 'string' ? { target: options } : options), changeOrigin };
      }
      vite = await createServer({ ...config, configFile: false, envFile: false, logLevel: 'error',
        cacheDir: path.join(directory, 'vite'),
        // Keep test asset timings out of the operator's development diagnostics.
        plugins: config.plugins?.filter(plugin => (plugin as { name?: string })?.name !== 'stow-dev-http-diagnostics'),
        server: { ...config.server, host: '127.0.0.1', port, strictPort: true, hmr: false, proxy, watch: null },
      });
      await vite.listen();
      const address = vite.httpServer!.address();
      if (!address || typeof address === 'string') throw new Error('Vite did not open a TCP listener.');
      port = address.port;
    };
    await start();
    return { origin: `http://localhost:${port}`, close,
      /** Reproduce the old proxy, then restore repo configuration on the same browser origin. */
      async setApiChangeOrigin(value?: boolean) { await closeVite(); await start(value); },
    };
  } catch (error) { await close(); throw error; }
}
