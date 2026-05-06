/**
 * Browser and voice flow helpers for sandbox E2E tests.
 * Separated from sandbox-helpers.ts to stay within the 250-line limit.
 */
import { chromium } from '@playwright/test'
import type { Page } from '@playwright/test'
import { TIMEOUTS } from './sandbox-helpers.js'

/**
 * Pattern that artifact URLs must match: artifact-router single-label hostname.
 * Format: https://artifact-{sandboxId}-{port}.example.com/...
 */
export const ARTIFACT_URL_PATTERN = /^https:\/\/artifact-[a-zA-Z0-9][a-zA-Z0-9-]+-\d+\.duoidal\.com\//

export interface VoiceFlowOpts {
  /** Supabase access token for the test user */
  jwt: string
  /** Test user email (for full session fetch) */
  email: string
  /** Test user password (for full session fetch) */
  password: string
  /** Test user ID (for onboarding setup) */
  userId: string
}

/**
 * Run the voice flow in a Chromium browser with fake audio injection.
 * Authenticates as the test user, creates a chat, joins the LiveKit room,
 * injects fake audio, and waits for a rendered Mermaid diagram artifact.
 * Returns screenshot paths written to test-results/.
 */
export async function runVoiceFlow(
  screenshotPrefix: string,
  opts: VoiceFlowOpts,
): Promise<{ diagramPath: string; fullPath: string; artifactUrl: string }> {
  const bffUrl = process.env['SANDBOX_BFF_URL'] ?? ''
  const supabaseUrl = process.env['SUPABASE_URL'] ?? ''
  const supabaseAnonKey = process.env['SUPABASE_ANON_KEY'] ?? process.env['VITE_SUPABASE_ANON_KEY'] ?? ''
  const supabaseServiceKey = process.env['SUPABASE_SERVICE_KEY'] ?? ''
  const projectRef = new URL(supabaseUrl).hostname.split('.')[0]
  const storageKey = `sb-${projectRef}-auth-token`

  // Step 1: Get full session (access_token + refresh_token) via password grant
  const sessionRes = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: supabaseAnonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: opts.email, password: opts.password }),
  })
  if (!sessionRes.ok) {
    const body = await sessionRes.text()
    throw new Error(`runVoiceFlow session fetch failed: ${sessionRes.status} ${body}`)
  }
  const fullSession = await sessionRes.json() as {
    access_token: string
    refresh_token: string
    expires_in: number
    expires_at?: number
    token_type: string
    user: { id: string; email: string; user_metadata?: Record<string, unknown>; [key: string]: unknown }
  }

  // Step 2: Mark user as onboarded so _authenticated route doesn't redirect to /onboarding
  await fetch(`${supabaseUrl}/auth/v1/admin/users/${opts.userId}`, {
    method: 'PUT',
    headers: {
      apikey: supabaseServiceKey,
      Authorization: `Bearer ${supabaseServiceKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ user_metadata: { is_onboarded: true } }),
  })

  // Step 3: Create a chat via BFF so the chat page has a valid DB row
  const chatRes = await fetch(`${bffUrl}/api/chats`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${opts.jwt}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ title: `${screenshotPrefix} Voice E2E` }),
  })
  const chat = await chatRes.json() as { id: string }

  const fixtureWav = new URL(
    '../fixtures/draw-mermaid-prompt.wav',
    import.meta.url,
  ).pathname

  const browser = await chromium.launch({
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${fixtureWav}`,
    ],
  })
  const ctx = await browser.newContext()
  const page: Page = await ctx.newPage()
  const diagramPath = `test-results/${screenshotPrefix}-rendered.png`
  const fullPath = `test-results/${screenshotPrefix}-full.png`
  let artifactUrl = ''
  try {
    // Step 4: Navigate to BFF origin first to set localStorage in correct domain
    await page.goto(`${bffUrl}/`)

    // Step 5: Inject Supabase session into localStorage (is_onboarded in user_metadata)
    const sessionToInject = {
      ...fullSession,
      expires_at: fullSession.expires_at ?? Math.floor(Date.now() / 1000) + fullSession.expires_in,
      user: {
        ...fullSession.user,
        user_metadata: { ...(fullSession.user.user_metadata ?? {}), is_onboarded: true },
      },
    }
    await page.evaluate(
      ({ key, value }: { key: string; value: unknown }) => {
        localStorage.setItem(key, JSON.stringify(value))
      },
      { key: storageKey, value: sessionToInject },
    )

    // Step 6: Navigate directly to the chat page
    await page.goto(`${bffUrl}/chat/${chat.id}`)
    await page.waitForURL(/\/chat\/[0-9a-f-]+/, { timeout: 15_000 })

    // Step 7: Click the Join button to initiate LiveKit connection
    const joinBtn = page.locator('button', { hasText: /join|rejoin/i })
    await joinBtn.waitFor({ state: 'visible', timeout: 15_000 })
    await joinBtn.click()

    // Step 8: Wait for connection state to reach 'connected'
    await page
      .locator('[data-connection-state="connected"]')
      .waitFor({ state: 'visible', timeout: TIMEOUTS.VOICE_ROUND_TRIP })

    // Step 9: Wait for artifact frame and SVG to appear (voice agent renders diagram)
    const artifactFrame = page.locator('[data-testid="artifact-frame"]')
    await artifactFrame.waitFor({ state: 'visible', timeout: 960_000 })

    // Capture artifact URL from the iframe src before waiting for SVG
    artifactUrl = await artifactFrame.getAttribute('src') ?? ''

    const iframe = page.frameLocator('[data-testid="artifact-frame"]')
    await iframe
      .locator('svg g.node')
      .first()
      .waitFor({ state: 'visible', timeout: 60_000 })

    await artifactFrame.screenshot({ path: diagramPath })
    await page.screenshot({ path: fullPath, fullPage: true })
  } finally {
    await ctx.close()
    await browser.close()
  }
  return { diagramPath, fullPath, artifactUrl }
}
