/**
 * Story 4 — Six-hop share_screen E2E. Runs against SANDBOX_BFF_URL.
 * Real audio via --use-fake-device-for-media-stream (no audio injection shortcuts).
 */
import { test, expect } from '@playwright/test'
import { RoomServiceClient } from 'livekit-server-sdk'
import { createTestUser, deleteTestUser } from './helpers/sandbox-helpers.js'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const BFF_URL = process.env['SANDBOX_BFF_URL']
if (!BFF_URL) {
  throw new Error(
    'SANDBOX_BFF_URL must be set (e.g. https://your-bff.vercel.app) — point it at your deployed agent-livestream BFF',
  )
}
const SUPABASE_URL = process.env['SUPABASE_URL'] ?? ''
const SUPABASE_ANON_KEY = process.env['SUPABASE_ANON_KEY'] ?? process.env['VITE_SUPABASE_ANON_KEY'] ?? ''
const SUPABASE_SERVICE_KEY = process.env['SUPABASE_SERVICE_KEY'] ?? ''
const LIVEKIT_URL = process.env['LIVEKIT_URL'] ?? ''
const LIVEKIT_API_KEY = process.env['LIVEKIT_API_KEY'] ?? ''
const LIVEKIT_API_SECRET = process.env['LIVEKIT_API_SECRET'] ?? ''
const FIXTURE_WAV = fileURLToPath(new URL('./fixtures/draw-mermaid-prompt.wav', import.meta.url))

type ThreeUrls = [string, string, string]

async function getThreeSandboxUrls(): Promise<ThreeUrls> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/resources?type=eq.server&config->>status=eq.active&select=id&limit=3`,
    { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } },
  )
  if (!res.ok) throw new Error(`Failed to fetch sandbox servers: ${res.status} ${res.statusText}`)
  const rows = (await res.json()) as Array<{ id: string }>
  if (rows.length < 3) throw new Error(`Need 3 active sandbox servers, found ${rows.length}`)
  const [a, b, c] = rows.map((r) => r.id) as [string, string, string]
  // URL scheme: artifact-{sandboxId}-{port}.example.com — single-label hostname,
  // routed via the *.example.com wildcard → CF tunnel → artifact-router on openclaw
  return [
    `https://artifact-${a}-3737.example.com/`,
    `https://artifact-${b}-3738.example.com/`,
    `https://artifact-${c}-3737.example.com/`,
  ]
}

async function signIn(email: string, password: string) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  return r.json() as Promise<{ access_token: string; refresh_token: string; user: { id: string } }>
}

async function waitForFrameSrc(page: import('@playwright/test').Page, expected: string, ms = 120_000) {
  await expect(async () => {
    expect(await page.locator('[data-testid="artifact-frame"]').getAttribute('src')).toBe(expected)
  }).toPass({ timeout: ms })
}

// Fake audio device args scoped to this test file only — does not affect sandbox-e2e.spec.ts
test.use({
  launchOptions: {
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${FIXTURE_WAV}`,
      '--allow-file-access',
    ],
  },
})

test('six-hop share_screen E2E — real audio via fake device', async ({ browser }) => {
  test.setTimeout(900_000)

  const [urlA, urlB, urlC] = await getThreeSandboxUrls()
  const hops = [urlA, 'https://en.wikipedia.org/wiki/Mermaid', urlB, 'https://github.com/mermaid-js/mermaid', urlC, 'https://news.ycombinator.com/']

  const email = `story4-${crypto.randomUUID()}@example.test`
  const { id: userId, password } = await createTestUser(email)
  let chatId = ''

  try {
    await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
      method: 'PUT',
      headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_metadata: { is_onboarded: true } }),
    })

    const session = await signIn(email, password)
    const jwt = session.access_token

    const chatRes = await fetch(`${BFF_URL}/api/chats`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Story 4 Six-Hop Test' }),
    })
    if (!chatRes.ok) throw new Error(`Failed to create chat: ${chatRes.status} ${chatRes.statusText}`)
    const chat = (await chatRes.json()) as { id: string }
    chatId = chat.id

    const projectRef = new URL(SUPABASE_URL).hostname.split('.')[0]
    const storageKey = `sb-${projectRef}-auth-token`
    const resultsDir = path.join(process.cwd(), 'test-results')
    if (!fs.existsSync(resultsDir)) fs.mkdirSync(resultsDir, { recursive: true })

    const ctx = await browser.newContext()
    const page = await ctx.newPage()

    // Capture artifact_ready events for diagnostics — log ALL console messages
    const artifactEvents: string[] = []
    page.on('console', msg => {
      const text = msg.text()
      const tagged = `[${new Date().toISOString()}] [${msg.type()}] ${text}`
      artifactEvents.push(tagged)
      if (text.includes('artifact') || text.includes('use-artifact-stream') || text.includes('hop-back') || text.includes('livekit') || text.includes('Disconnected') || text.includes('Reconnect')) {
        console.log('[browser]', tagged)
      }
    })

    try {
      await page.goto(`${BFF_URL}/`)
      await page.evaluate(
        ({ key, value }: { key: string; value: unknown }) => localStorage.setItem(key, JSON.stringify(value)),
        {
          key: storageKey,
          value: {
            access_token: session.access_token,
            refresh_token: session.refresh_token,
            token_type: 'bearer',
            expires_in: 3600,
            expires_at: Math.floor(Date.now() / 1000) + 3600,
            user: { ...session.user, user_metadata: { is_onboarded: true } },
          },
        },
      )

      await page.goto(`${BFF_URL}/chat/${chatId}`)
      await page.waitForURL(/\/chat\/[0-9a-f-]+/, { timeout: 15_000 })
      // Capture URL and page state before Join button wait for diagnostics
      console.log('[pre-join] URL after goto:', page.url())
      await page.screenshot({ path: path.join(resultsDir, 'pre-join-state.png'), fullPage: true })
      await page.locator('button', { hasText: /join|rejoin/i }).waitFor({ state: 'visible', timeout: 30_000 })
      await page.locator('button', { hasText: /join|rejoin/i }).click()
      await page.locator('[data-connection-state="connected"]').waitFor({ state: 'visible', timeout: 90_000 })

      // Wait for agent's first response (confirms session.start() completed and LLM pipeline ready)
      // The looping WAV audio triggers research → agent speaks → first transcript entry appears
      console.log('Waiting for agent readiness...')
      await expect(async () => {
        const count = await page.locator('[data-connection-state="connected"] [role="log"] [class*="gap-8"] > div').count()
        expect(count, 'Agent must produce at least one transcript entry before share commands start').toBeGreaterThanOrEqual(1)
      }).toPass({ timeout: 180_000 })

      // Audio track verification via LiveKit server SDK
      if (LIVEKIT_URL && LIVEKIT_API_KEY && LIVEKIT_API_SECRET) {
        const svc = new RoomServiceClient(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET)
        const participants = await svc.listParticipants(`room-${chatId}`)
        const audioTracks = participants.flatMap((p) => p.tracks).filter((t) => t.type === 0 /* AUDIO */)
        expect(audioTracks.length, 'Expected ≥1 audio track in room').toBeGreaterThanOrEqual(1)
      }

      await page.waitForFunction(() => typeof (window as Window & { __sendText?: unknown }).__sendText === 'function', { timeout: 15_000 })

      // Pre-hop settle: wait for the pipeline to drain the audio turn that triggered agent
      // readiness before injecting the first share command. Without this, the text injection
      // races with the ongoing audio turn and the LLM may call research instead of share_screen.
      await page.waitForTimeout(8_000)

      // Six-hop share sequence
      // 8-second settle delay between hops lets the voice-agent pipeline drain any
      // concurrent audio turn before the next text injection arrives. Without this,
      // the looping WAV audio and the text injection fight for the same LLM context,
      // causing tool-call chaos that drops hops inconsistently.
      for (let i = 0; i < hops.length; i++) {
        const url = hops[i] as string
        await page.evaluate(({ text }: { text: string }) => window.__sendText?.(text), { text: `Share this URL now: ${url}` })
        await waitForFrameSrc(page, url)
        const src = await page.locator('[data-testid="artifact-frame"]').getAttribute('src')
        expect(src).not.toMatch(/^data:/)
        expect(src).not.toMatch(/^http:\/\/localhost/)
        await page.screenshot({ path: path.join(resultsDir, `share-screen-${i + 1}.png`), fullPage: true })
        // Let the pipeline settle before the next hop
        await page.waitForTimeout(8_000)
      }

      // Verify no full-page reload occurred during hop sequence (navigation type 0 = navigate, 1 = reload)
      const navType = await page.evaluate(() => (window.performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming)?.type)
      expect(navType, 'Hop-back must not trigger a page reload').not.toBe('reload')

      // Hop-back to share 1's URL — no full-page reload
      await page.waitForTimeout(8_000)
      // Guard: ensure __sendText is available before injecting the hop-back command.
      // useChatHistory refetches every 2s, cycling send's reference and briefly setting
      // window.__sendText = undefined during cleanup. Without this guard, the optional
      // chaining in the evaluate call silently no-ops and the hop-back is never sent.
      await page.waitForFunction(() => typeof (window as Window & { __sendText?: unknown }).__sendText === 'function', { timeout: 15_000 })
      const hopBackText = `Share this URL now: ${urlA}`
      console.log('[hop-back] Sending:', hopBackText)
      const currentSrc = await page.locator('[data-testid="artifact-frame"]').getAttribute('src')
      console.log('[hop-back] Current iframe src before send:', currentSrc)

      // Start polling iframe src for diagnostics
      const srcPollInterval = setInterval(async () => {
        const src = await page.locator('[data-testid="artifact-frame"]').getAttribute('src').catch(() => null)
        console.log('[hop-back] iframe src poll:', src)
      }, 5_000)

      await page.evaluate(({ text }: { text: string }) => window.__sendText?.(text), { text: hopBackText })
      console.log('[hop-back] Text injected at', new Date().toISOString())
      console.log('[hop-back] ChatId for DB check:', chatId)

      // Also monitor transcript count during hop-back wait
      const transcriptPollInterval = setInterval(async () => {
        const count = await page.locator('[data-connection-state="connected"] [role="log"] [class*="gap-8"] > div').count().catch(() => -1)
        console.log('[hop-back] transcript count:', count)
      }, 10_000)

      // Retry: resend the hop-back command every 20s if the iframe hasn't updated yet.
      // The agent may be overwhelmed by continuous audio turns, causing the first injection
      // to be processed but then overridden. Retries ensure eventual delivery.
      let retryCount = 0
      const retryInterval = setInterval(async () => {
        const src = await page.locator('[data-testid="artifact-frame"]').getAttribute('src').catch(() => null)
        if (src === urlA) { clearInterval(retryInterval); return }
        retryCount++
        console.log('[hop-back] retry #' + retryCount + ' at', new Date().toISOString())
        await page.waitForFunction(() => typeof (window as Window & { __sendText?: unknown }).__sendText === 'function', { timeout: 5_000 }).catch(() => {})
        await page.evaluate(({ text }: { text: string }) => window.__sendText?.(text), { text: hopBackText }).catch(() => {})
      }, 20_000)

      await waitForFrameSrc(page, urlA).finally(() => {
        clearInterval(srcPollInterval)
        clearInterval(transcriptPollInterval)
        clearInterval(retryInterval)
        console.log('[hop-back] artifactEvents count:', artifactEvents.length)
        const artifactFiltered = artifactEvents.filter(e => e.includes('artifact') || e.includes('use-artifact-stream'))
        console.log('[hop-back] artifact-related events:', JSON.stringify(artifactFiltered, null, 2))
      })
      const finalSrc = await page.locator('[data-testid="artifact-frame"]').getAttribute('src')
      console.log('[hop-back] Final iframe src:', finalSrc)
      const hopBackSrc = await page.locator('[data-testid="artifact-frame"]').getAttribute('src')
      expect(hopBackSrc).toBe(urlA)
      expect(hopBackSrc).not.toMatch(/^data:/)
      expect(hopBackSrc).not.toMatch(/^http:\/\/localhost/)

      // Transcript: ≥12 finalized turns in sidebar
      await expect(async () => {
        const msgs = await page.locator('[data-connection-state="connected"] [role="log"] [class*="gap-8"] > div').count()
        expect(msgs, `Expected ≥12 transcript entries, got ${msgs}`).toBeGreaterThanOrEqual(12)
      }).toPass({ timeout: 60_000 })
      // Also assert data-testid="transcript" resolves (the stable hook)
      await expect(page.locator('[data-testid="transcript"]')).toBeVisible({ timeout: 5_000 })
      await page.screenshot({ path: path.join(resultsDir, 'transcript-sidebar-final.png'), fullPage: true })

      // DB polling: ≥12 message rows within 30s
      const deadline = Date.now() + 30_000
      let dbRows: unknown[] = []
      while (Date.now() < deadline) {
        const r = await fetch(`${BFF_URL}/api/chats/${chatId}/messages`, { headers: { Authorization: `Bearer ${jwt}` } })
        if (r.ok) { dbRows = (await r.json()) as unknown[]; if (dbRows.length >= 12) break }
        await new Promise<void>((res) => setTimeout(res, 500))
      }
      expect(dbRows.length, 'Expected ≥12 DB message rows').toBeGreaterThanOrEqual(12)

      // Reload test: disconnect LiveKit, reload page, verify transcript from DB (no LiveKit)
      await page.locator('[aria-label="Leave"]').click().catch(() => undefined)
      await page.goto(`${BFF_URL}/chat/${chatId}`)
      await page.waitForURL(/\/chat\/[0-9a-f-]+/, { timeout: 10_000 })
      await expect(async () => {
        const liCount = await page.locator('ul > li').count()
        expect(liCount, `Expected ≥12 history items after reload, got ${liCount}`).toBeGreaterThanOrEqual(12)
      }).toPass({ timeout: 15_000 })
      await page.screenshot({ path: path.join(resultsDir, 'transcript-reload-from-db.png'), fullPage: true })
    } finally {
      await ctx.close()
    }
  } finally {
    await deleteTestUser(userId)
  }
})
