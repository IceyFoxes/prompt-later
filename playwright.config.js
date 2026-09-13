import { defineConfig } from '@playwright/test';
import path from 'node:path';

export default defineConfig({
  testDir: './tests/browser',
  outputDir: './test-results',
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  use: { headless: true },
  workers: 1,
  timeout: 30000,
  fullyParallel: false,
  projects: [{ name: 'chromium', use: { browserName: 'chromium', launchOptions: { args: [`--disable-extensions-except=${path.resolve('dist')}`, `--load-extension=${path.resolve('dist')}`] } } }],
});
