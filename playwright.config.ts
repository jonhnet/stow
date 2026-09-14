import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { buildDir } from './paths.ts';
export default defineConfig({
  testDir: './tests/browser',
  outputDir: path.join(buildDir, 'test-results'),
  timeout: 45000,
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: 'http://localhost:4173',
    browserName: 'chromium',
    launchOptions: { executablePath: process.env.CHROME_PATH ?? (existsSync('/opt/google/chrome/chrome') ? '/opt/google/chrome/chrome' : undefined), args: ['--no-sandbox', '--host-resolver-rules=MAP stow.test 127.0.0.1'] },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  },
  webServer: {
    command: `${path.join(buildDir, 'cargo-target', 'debug', 'stow-test-driver')} browser`,
    url: 'http://localhost:4173/api/health',
    reuseExistingServer: false,
    timeout: 30000
  }
});
