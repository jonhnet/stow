import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { buildDir } from '../paths';
import { writeAndroidRelease } from '../scripts/android-release';

test('Android releases cover both entry points and assets, have deterministic identities, and exclude APKs', async () => {
  const directory = await mkdtemp(path.join(buildDir, 'release-test-'));
  try {
    await assert.rejects(writeAndroidRelease(directory), /missing/);
    await mkdir(path.join(directory, 'assets')); await mkdir(path.join(directory, 'android'));
    for (const name of ['index.html', 'background.html', 'assets/chunk.js', 'android/stow.apk', 'sw.js']) await writeFile(path.join(directory, name), name);
    const read = async () => JSON.parse(await readFile(path.join(directory, 'release.json'), 'utf8'));
    await writeAndroidRelease(directory); const original = await read();
    assert.deepEqual(Object.keys(original.files).sort(), ['/assets/chunk.js', '/background.html', '/index.html']);
    await writeAndroidRelease(directory); assert.deepEqual(await read(), original);
    await writeFile(path.join(directory, 'assets/chunk.js'), 'a changed chunk');
    await writeAndroidRelease(directory); assert.notEqual((await read()).release, original.release);
  } finally { await rm(directory, { recursive: true }); }
});
