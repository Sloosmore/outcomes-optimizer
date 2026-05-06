import { defineConfig, devices } from '@playwright/test'
import { readFileSync } from 'fs'
import { resolve } from 'path'

// Load .env for BFF server env vars (Playwright webServer needs them)
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

// BFF needs the Supabase URL in bypass list; test runner needs localhost
const supabaseBypass = process.env['CREDENTIAL_PROXY_BYPASS_URLS'] ?? ''
const bffBypassUrls = [supabaseBypass, 'http://localhost:3001'].filter(Boolean).join(',')
// Override for test runner (direct BFF calls from test code, not browser)
process.env['CREDENTIAL_PROXY_BYPASS_URLS'] = bffBypassUrls

export default defineConfig({
  testDir: './tests',
  testMatch: /e2e-\d+\.spec\.ts/,
  fullyParallel: false,
  retries: 0,
  reporter: 'list',
  timeout: 120_000, // 5-turn tests with real LLM calls need more time than the 30s default
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      command: 'npm run dev',
      port: 5173,
      env: {
        VITE_TEST: '1',
        SANDBOX_ID: 'test-sandbox',
        VITE_SUPABASE_URL: process.env['VITE_SUPABASE_URL'] ?? '',
        VITE_SUPABASE_ANON_KEY: process.env['VITE_SUPABASE_ANON_KEY'] ?? '',
        VITE_DEBUG_EMAIL: process.env['VITE_DEBUG_EMAIL'] ?? '',
        VITE_DEBUG_PASSWORD: process.env['VITE_DEBUG_PASSWORD'] ?? '',
      },
      reuseExistingServer: true,
      timeout: 60000,
    },
    {
      command: 'npm run server',
      port: 3001,
      env: {
        SUPABASE_URL: process.env['SUPABASE_URL'] ?? '',
        SUPABASE_SERVICE_KEY: process.env['SUPABASE_SERVICE_KEY'] ?? '',
        SUPABASE_JWT_SECRET: process.env['SUPABASE_JWT_SECRET'] ?? '',
        CREDENTIAL_PROXY_BYPASS_URLS: bffBypassUrls,
      },
      reuseExistingServer: true,
      timeout: 30000,
    },
  ],
})
