import { defineConfig } from '@playwright/test';
import path from 'node:path';
import app from './playwright.config';
import { buildDir, sourceDir } from './paths';

export default defineConfig({
  testDir: './tests/demo',
  outputDir: path.join(buildDir, 'demo-test-results'),
  timeout: 30000, fullyParallel: false, workers: 1,
  use: { ...app.use, baseURL: 'http://localhost:4175' },
  webServer: {
    command: `node ${path.join(sourceDir, 'scripts/serve-demo.mjs')}`,
    url: 'http://localhost:4175', reuseExistingServer: false, timeout: 10000,
  },
});
