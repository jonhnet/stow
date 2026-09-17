import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { buildDir, defaultDataDir, distDir, sourceDir, workspaceDir } from './paths.ts';
import { devHttpDiagnostics } from './scripts/dev-http-diagnostics.ts';
import { buildInfo } from './scripts/build-info.ts';
const publicOrigin = process.env.STOW_ORIGIN ? new URL(process.env.STOW_ORIGIN) : undefined;
const dataDir = path.resolve(process.env.DATA_DIR ?? defaultDataDir);
if (dataDir === sourceDir || dataDir.startsWith(`${sourceDir}${path.sep}`)) {
  throw new Error('DATA_DIR must be outside the source repository; keep persistent data beside it.');
}
if (dataDir === buildDir || dataDir.startsWith(`${buildDir}${path.sep}`)) {
  throw new Error('DATA_DIR must be outside build/; that directory contains disposable artifacts.');
}
export default defineConfig({
  define: { __STOW_BUILD__: JSON.stringify(buildInfo(sourceDir)), __STOW_DEMO__: false },
  root: sourceDir,
  envDir: workspaceDir,
  cacheDir: path.join(buildDir, 'vite'),
  build: { outDir: distDir, emptyOutDir: true },
  plugins: [react(), devHttpDiagnostics(path.join(buildDir, 'startup-http.json')), {
  name: 'stow-offline-shell',
  generateBundle(_options, bundle) {
    const assets = ['/', '/index.html', '/icon.svg', '/icon-192.png', '/icon-512.png', '/icon-maskable-512.png', '/manifest.webmanifest', ...Object.keys(bundle).filter(name => !name.endsWith('.map')).map(name => '/' + name)];
    this.emitFile({ type: 'asset', fileName: 'sw.js', source: `
const CACHE = 'stow-shell-${Date.now()}';
const ASSETS = ${JSON.stringify(assets)};
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS))));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('stow-shell-') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname === '/sync') return;
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(() => caches.match('/index.html')));
  } else if (ASSETS.includes(url.pathname)) {
    event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request)));
  }
});
` });
  }
}], server: { strictPort: true, allowedHosts: publicOrigin ? [publicOrigin.hostname] : [],
  // An explicit client port keeps hot reload on the public origin and disables
  // Vite's direct-connection fallback to localhost on the browsing device.
  hmr: publicOrigin ? {
    protocol: publicOrigin.protocol === 'https:' ? 'wss' : 'ws',
    host: publicOrigin.hostname,
    clientPort: Number(publicOrigin.port || (publicOrigin.protocol === 'https:' ? 443 : 80)),
  } : undefined,
  // Vite serves source files; private vaults and deployment secrets are never source.
  fs: {
    allow: [sourceDir, buildDir],
    deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/data/**', '**/startup-http.json',
      `${workspaceDir.replaceAll('\\', '/')}/.env`, `${workspaceDir.replaceAll('\\', '/')}/.env.*`,
      `${defaultDataDir.replaceAll('\\', '/')}/**`, `${dataDir.replaceAll('\\', '/')}/**`],
  },
  proxy: {
  // Keep Host aligned with the browser's Origin for the server's same-origin check.
  '/api': { target: 'http://127.0.0.1:3001', changeOrigin: false },
  '/sync': { target: 'ws://127.0.0.1:3001', ws: true }
} } });
