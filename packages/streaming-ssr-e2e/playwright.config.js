'use strict';

const path = require('node:path');
const { defineConfig } = require('@playwright/test');

const PORT = Number(process.env.E2E_PORT || 4321);
const BASE_URL = `http://127.0.0.1:${PORT}`;

module.exports = defineConfig({
  expect: { timeout: 10000 },
  forbidOnly: !!process.env.CI,
  fullyParallel: false,
  reporter: [['list']],
  retries: 0,
  testDir: path.join(__dirname, 'specs'),
  testMatch: '**/*.spec.js',
  timeout: 60000,
  use: {
    baseURL: BASE_URL,
    // Deliberately different from what the server declares (1024x768,
    // 'dark'). See the comment block in server.js.
    colorScheme: 'light',
    viewport: { height: 720, width: 1280 }
  },
  // One worker: the frame-by-frame FOUC spec measures paint timing, and a
  // second browser competing for the same machine makes that noisier than
  // it needs to be.
  webServer: {
    command: `node ${JSON.stringify(path.join(__dirname, 'server.js'))}`,
    cwd: __dirname,
    env: { E2E_PORT: String(PORT) },
    // Always a fresh process. The delta channel is warmth-sensitive (rules
    // an earlier request compiled arrive in the next request's shell), and
    // a stale server silently invalidates half of this suite.
    reuseExistingServer: false,
    stderr: 'pipe',
    stdout: 'pipe',
    timeout: 120000,
    url: `${BASE_URL}/health`
  },
  workers: 1
});
