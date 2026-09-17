import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { buildDir, sourceDir } from './paths.ts';
import { buildInfo } from './scripts/build-info.ts';

const accountStore = path.join(sourceDir, 'src/core/store');
const policy = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob:; font-src 'self'; connect-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'";

// Deliberately independent of the application's server/proxy/offline config.
// The result is ordinary static files, with no writable backend to deploy.
export default defineConfig({
  root: sourceDir,
  envDir: false,
  publicDir: false,
  cacheDir: path.join(buildDir, 'vite-demo'),
  define: { __STOW_BUILD__: JSON.stringify(buildInfo(sourceDir)), __STOW_DEMO__: true },
  build: { outDir: path.join(buildDir, 'demo'), emptyOutDir: true },
  plugins: [{
    name: 'stow-browser-only-demo', enforce: 'pre',
    resolveId(id, importer) {
      if (importer && id.startsWith('.') && path.resolve(path.dirname(importer.split('?')[0]), id).replace(/\.tsx?$/, '') === accountStore) {
        return path.join(sourceDir, 'src/demo/store.ts');
      }
    },
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        if (!html.includes('src="/src/main.tsx"')) throw new Error('The demo entry point no longer matches index.html.');
        return html.replace('src="/src/main.tsx"', 'src="/src/demo/main.tsx"')
          .replace('<title>Stow</title>', '<title>Stow Demo — changes are not saved</title>')
          .replace('<link rel="manifest" href="/manifest.webmanifest" />', '')
          .replace('<head>', `<head><meta http-equiv="Content-Security-Policy" content="${policy}" /><meta name="referrer" content="no-referrer" />`);
      },
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'icon.svg', source: readFileSync(path.join(sourceDir, 'public/icon.svg')) });
    },
  }, react()],
});
