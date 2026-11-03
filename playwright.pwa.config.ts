import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests/pwa',
  testMatch: '*.spec.ts',
  fullyParallel: false,
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:4185', trace: 'retain-on-failure' },
  webServer: {
    command: 'node --experimental-strip-types tests/pwa/server.ts',
    url: 'http://127.0.0.1:4185',
    reuseExistingServer: false,
  },
  projects: [
    { name: 'pwa-chromium', use: { ...devices['Desktop Chrome'] } },
    {
      name: 'pwa-mobile',
      use: { ...devices['iPhone 13'], browserName: 'chromium' },
    },
  ],
});
