import { defineConfig, devices } from '@playwright/test'
import { readFileSync } from 'fs'
import { resolve } from 'path'

// Load .env for BFF server env vars
const envPath = resolve(import.meta.dirname, '.env')
try {
  const envContent = readFileSync(envPath, 'utf8')
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) continue
    const key = trimmed.slice(0, eqIdx)
    const value = trimmed.slice(eqIdx + 1)
    if (!process.env[key]) process.env[key] = value
  }
} catch {
  // .env file missing — env vars must be set externally
}

export default defineConfig({
  testDir: './tests',
  testMatch: /unified-matrix\.spec\.ts/,
  fullyParallel: false,
  retries: 0,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'test-results/unified-matrix-html-report' }],
  ],
  timeout: 600_000, // 10 minutes per test
  use: {
    baseURL: process.env['SANDBOX_BFF_URL'] ?? 'http://localhost:3001',
    trace: 'retain-on-failure',
    screenshot: 'on',
    video: 'retain-on-failure',
    // Disable all CSS/JS animations so Playwright's stability check (which waits
    // for two consecutive rAFs with the same bounding box) resolves immediately.
    // Without this, Motion/framer-motion enter-animations on transcript messages
    // kept the input element "unstable", adding ~190ms to every fill() call.
    reducedMotion: 'reduce',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: [
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
            '--autoplay-policy=no-user-gesture-required',
            '--disable-infobars',
            '--disable-dev-shm-usage',
          ],
        },
      },
    },
  ],
  // No webServer — runs against deployed preview
})
