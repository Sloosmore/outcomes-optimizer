import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  testMatch: /(sandbox-e2e|share-screen-six-hop)\.spec\.ts/,
  fullyParallel: false,
  retries: 0,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'test-results/sandbox-html-report' }],
  ],
  timeout: 600_000, // 10 minutes per test — T1 needs ~4m VM boot + ~5m CF TLS activation
  use: {
    baseURL: process.env['SANDBOX_BFF_URL'] ?? 'http://localhost:3001',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  // No webServer — runs against deployed preview, not local dev
})
