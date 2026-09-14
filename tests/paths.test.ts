import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { buildDir, sourceDir } from '../paths.ts';

test('Vite rejects deployment vault storage inside build or source directories', async () => {
  const previous = process.env.DATA_DIR;
  try {
    const cases = [
      [buildDir, /DATA_DIR must be outside build/],
      [path.join(buildDir, 'private-notes'), /DATA_DIR must be outside build/],
      [sourceDir, /DATA_DIR must be outside the source repository/],
      [path.join(sourceDir, 'private-notes'), /DATA_DIR must be outside the source repository/],
      ['./private', /DATA_DIR must be outside the source repository/],
    ] as const;
    for (const [index, [dataDir, expected]] of cases.entries()) {
      process.env.DATA_DIR = dataDir;
      // Each configuration load must observe the current deployment setting.
      const configUrl = new URL(`../vite.config.ts?deployment-data-case=${index}`, import.meta.url);
      await assert.rejects(import(configUrl.href), expected);
    }
  } finally {
    if (previous === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previous;
  }
});
