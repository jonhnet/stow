import { fingerprint } from './fingerprint.ts';
/** Production bundle with isolated test routing and measurements. The application
 * implementation is unchanged; this build does not install a service worker. */
import { build, mergeConfig, type UserConfig } from 'vite';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import configuration from '../../vite.config.ts';
import { buildDir, sourceDir } from '../../paths.ts';
function storageLabNamespace(value = '/storage-lab') {
  if (!/^\/[a-z][a-z0-9-]*$/.test(value)) throw new Error('Use one absolute laboratory path segment without a trailing slash.');
  return value;
}
const base = configuration as UserConfig;
const { values } = parseArgs({ options: { 'bundle-dir': { type: 'string' }, base: { type: 'string' } } });
const namespace = storageLabNamespace(values.base);
const bundleDir = path.resolve(values['bundle-dir'] ?? path.join(buildDir, 'storage-lab'));
if (!bundleDir.startsWith(buildDir + path.sep)) throw new Error('Laboratory bundles must stay inside the disposable build directory.');
const output = path.join(bundleDir, 'dist');
await build(mergeConfig({ ...base, plugins: base.plugins?.filter(plugin => !(plugin && 'name' in plugin && plugin.name === 'stow-offline-shell')) }, {
  configFile: false, base: `${namespace}/`, build: { outDir: output },
  plugins: [{ name: 'isolated-storage-measurements', enforce: 'pre', transform(code: string, id: string) {
    if (id === path.join(sourceDir, 'src/main.tsx')) return `import '../scripts/storage-lab/client.ts';\n${code.replace("    if (import.meta.env.PROD) void navigator.serviceWorker.register('/sw.js').catch(console.error);", '')}`;
    if (id === path.join(sourceDir, 'src/core/account.ts')) return code.replace("'stow-account-v1'", '`stow-storage-lab-account-v1-${window.__storageLab.namespace}-${window.__storageLab.scenario}-${window.__storageLab.runId}`');
    if (id === path.join(sourceDir, 'src/core/store.ts')) return code + '\nwindow.__storageLab.attach(store);\n';
  } }],
}));
const hash = createHash('sha256'), assets = await readdir(path.join(output, 'assets'));
for (const asset of assets.sort()) hash.update(asset).update(await readFile(path.join(output, 'assets', asset)));
await writeFile(path.join(bundleDir, 'build.json'), JSON.stringify({ schema: 1, namespace, ...await fingerprint(), at: new Date().toISOString(), sha256: hash.digest('hex'), assets }, null, 2) + '\n');
