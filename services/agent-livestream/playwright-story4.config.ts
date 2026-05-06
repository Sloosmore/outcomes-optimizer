import { defineConfig, devices } from '@playwright/test'

const BFF_URL = process.env['SANDBOX_BFF_URL']
if (!BFF_URL) {
  throw new Error(
    'SANDBOX_BFF_URL must be set (e.g. https://your-bff.vercel.app) — point it at your deployed agent-livestream BFF',
  )
}

export default defineConfig({
  testDir: './tests',
  testMatch: /share-screen-six-hop\.spec\.ts/,
  fullyParallel: false,
  retries: 0,
  reporter: 'list',
  timeout: 900_000,
  use: {
    baseURL: BFF_URL,
    trace: 'on-first-retry',
    navigationTimeout: 60_000,
    actionTimeout: 30_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  // No webServer section — test connects to deployed Vercel preview
})
