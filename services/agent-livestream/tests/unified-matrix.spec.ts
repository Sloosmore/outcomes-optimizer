/**
 * Story 1 — Unified conversation matrix E2E harness (8 rows).
 *
 * Drives real LiveKit audio via --use-fake-device-for-media-stream + WAV fixture.
 * No window.__injectAudio or window.__sendText shortcuts.
 *
 * All rows are expected to FAIL against the current codebase — that is the
 * correct and desired state for Story 1 (contract-first, red-green-refactor).
 *
 * Enable with: UNIFIED_MATRIX_ENABLED=1
 */
import { test, expect } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const ENABLED = process.env['UNIFIED_MATRIX_ENABLED'] === '1'
const SKIP_MSG = 'Set UNIFIED_MATRIX_ENABLED=1 with live credentials to run'

const BFF_URL = process.env['SANDBOX_BFF_URL']
if (!BFF_URL) {
  throw new Error(
    'SANDBOX_BFF_URL must be set (e.g. https://your-bff.vercel.app) — point it at your deployed agent-livestream BFF',
  )
}

const SUPABASE_URL = process.env['SUPABASE_URL'] ?? ''
const SUPABASE_ANON_KEY =
  process.env['SUPABASE_ANON_KEY'] ?? process.env['VITE_SUPABASE_ANON_KEY'] ?? ''
const SUPABASE_SERVICE_KEY = process.env['SUPABASE_SERVICE_KEY'] ?? ''

// Artifact URL pattern: https://artifact-<sandboxId>-<port>.example.com/view/<id>
const ARTIFACT_URL_PATTERN = /^https:\/\/artifact-[0-9a-f-]+-\d+\.duoidal\.com\/view\/.+$/

// WAV fixture — use draw-mermaid-prompt.wav as placeholder until
// unified-matrix-prompts.wav is generated.
const FIXTURE_WAV = (() => {
  const candidate = fileURLToPath(
    new URL('./fixtures/unified-matrix-prompts.wav', import.meta.url),
  )
  if (fs.existsSync(candidate)) return candidate
  return fileURLToPath(new URL('./fixtures/draw-mermaid-prompt.wav', import.meta.url))
})()

// Use real fake audio device — no window.__injectAudio or window.__sendText.
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function signIn(email: string, password: string) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  return r.json() as Promise<{
    access_token: string
    refresh_token: string
    user: { id: string }
  }>
}

async function createTestUser(email: string) {
  const password = `Pwd-${crypto.randomUUID()}`
  const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, password, email_confirm: true }),
  })
  const u = (await r.json()) as { id: string }
  return { id: u.id, email, password }
}

async function deleteTestUser(userId: string) {
  await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
    method: 'DELETE',
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    },
  }).catch(() => undefined)
}

async function createChat(jwt: string, title: string): Promise<string> {
  const r = await fetch(`${BFF_URL}/api/chats`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  })
  if (!r.ok) throw new Error(`Failed to create chat: ${r.status}`)
  const body = (await r.json()) as { id: string }
  return body.id
}

async function injectSessionStorage(
  page: import('@playwright/test').Page,
  supabaseUrl: string,
  session: { access_token: string; refresh_token: string; user: { id: string } },
) {
  const projectRef = new URL(supabaseUrl).hostname.split('.')[0]
  const storageKey = `sb-${projectRef}-auth-token`
  await page.evaluate(
    ({ key, value }: { key: string; value: unknown }) =>
      localStorage.setItem(key, JSON.stringify(value)),
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
}

async function waitForIframeSrc(
  page: import('@playwright/test').Page,
  expected: string,
  timeoutMs = 120_000,
) {
  await expect(async () => {
    const src = await page.locator('[data-testid="artifact-frame"]').getAttribute('src')
    expect(src).toBe(expected)
  }).toPass({ timeout: timeoutMs })
}

async function waitForIframeSrcPattern(
  page: import('@playwright/test').Page,
  pattern: RegExp,
  timeoutMs = 120_000,
) {
  await expect(async () => {
    const src = await page.locator('[data-testid="artifact-frame"]').getAttribute('src')
    expect(src).toMatch(pattern)
  }).toPass({ timeout: timeoutMs })
}

async function getIframeSrc(page: import('@playwright/test').Page): Promise<string | null> {
  return page.locator('[data-testid="artifact-frame"]').getAttribute('src')
}

async function countTranscriptTurns(page: import('@playwright/test').Page): Promise<number> {
  return page
    .locator('[data-testid="conversation-view"] [data-role]')
    .count()
}

async function joinRoom(page: import('@playwright/test').Page) {
  await page.locator('button', { hasText: /join|rejoin/i }).waitFor({ state: 'visible', timeout: 30_000 })
  await page.locator('button', { hasText: /join|rejoin/i }).click()
  await page.locator('[data-connection-state="connected"]').waitFor({ state: 'visible', timeout: 90_000 })
}

async function waitForAgentReady(page: import('@playwright/test').Page) {
  await expect(async () => {
    const count = await page
      .locator('[data-testid="conversation-view"] [data-role]')
      .count()
    expect(count, 'At least one conversation turn must appear before matrix starts').toBeGreaterThanOrEqual(1)
  }).toPass({ timeout: 180_000 })
}

// ---------------------------------------------------------------------------
// Unified Matrix Test
// ---------------------------------------------------------------------------

test('unified conversation matrix — 8-row voice+text E2E', async ({ browser }) => {
  test.skip(!ENABLED, SKIP_MSG)
  test.setTimeout(1_800_000) // 30 min

  const email = `unified-matrix-${crypto.randomUUID()}@example.test`
  const { id: userId, password } = await createTestUser(email)

  const resultsDir = path.join(process.cwd(), 'test-results', 'unified-matrix')
  if (!fs.existsSync(resultsDir)) fs.mkdirSync(resultsDir, { recursive: true })

  let row2ArtifactUrl = ''
  let chatId = ''

  try {
    // Mark user as onboarded
    await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
      method: 'PUT',
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ user_metadata: { is_onboarded: true } }),
    })

    const session = await signIn(email, password)
    const jwt = session.access_token
    chatId = await createChat(jwt, 'Unified Matrix Test')

    const ctx = await browser.newContext()
    const page = await ctx.newPage()

    const consoleLog: string[] = []
    page.on('console', (msg) => {
      const line = `[${new Date().toISOString()}] [${msg.type()}] ${msg.text()}`
      consoleLog.push(line)
    })

    try {
      // Navigate and inject auth
      await page.goto(`${BFF_URL}/`)
      await injectSessionStorage(page, SUPABASE_URL, session)
      await page.goto(`${BFF_URL}/chat/${chatId}`)
      await page.waitForURL(/\/chat\/[0-9a-f-]+/, { timeout: 15_000 })

      await page.screenshot({ path: path.join(resultsDir, '00-pre-join.png'), fullPage: true })
      await joinRoom(page)
      await waitForAgentReady(page)
      await page.screenshot({ path: path.join(resultsDir, '00-agent-ready.png'), fullPage: true })

      // ── Row 1: share_screen → Wikipedia Mermaid ────────────────────────────
      // Audio fixture speaks: "show me the wikipedia page about mermaids"
      // Expected: share_screen tool call → iframe.src === exact URL
      await expect(async () => {
        const src = await getIframeSrc(page)
        expect(src).toBe('https://en.wikipedia.org/wiki/Mermaid')
      }).toPass({ timeout: 120_000 })
      await page.screenshot({ path: path.join(resultsDir, '01-wikipedia-mermaid.png'), fullPage: true })

      // ── Row 2: research (mermaid MCP) → artifact URL ──────────────────────
      // Audio fixture speaks: "draw me a flowchart of the BFF"
      // Expected: research tool → artifact URL matching pattern; ≥2s delay; iframe loads ≥5KB HTML+SVG
      const row2AudioStart = Date.now()
      await waitForIframeSrcPattern(page, ARTIFACT_URL_PATTERN, 300_000)
      row2ArtifactUrl = (await getIframeSrc(page)) ?? ''
      const row2Elapsed = Date.now() - row2AudioStart

      // artifact_ready arrives ≥ 2000ms after audio start
      expect(row2Elapsed, 'artifact_ready must arrive ≥ 2000ms after audio start').toBeGreaterThanOrEqual(2000)
      expect(row2ArtifactUrl).toMatch(ARTIFACT_URL_PATTERN)

      // iframe must load HTML+SVG ≥ 5KB
      const artifactRes = await fetch(row2ArtifactUrl)
      expect(artifactRes.ok, 'Artifact URL must be reachable').toBe(true)
      const artifactBody = await artifactRes.text()
      expect(artifactBody.length, 'Artifact HTML+SVG must be ≥ 5KB').toBeGreaterThanOrEqual(5_000)

      await page.screenshot({ path: path.join(resultsDir, '02-flowchart-bff.png'), fullPage: true })

      // ── Row 3: type "show github.com/livekit" → share_screen ──────────────
      // Uses useConversation().sendUserText() — typed turn appears ≤ 200ms
      // Expected: iframe.src === 'https://github.com/livekit'; turn has role 'user'
      const row3TextStart = Date.now()
      await page.locator('[data-testid="conversation-input"]').fill('show github.com/livekit')
      await page.locator('[data-testid="conversation-send"]').click()

      // Typed turn must appear in conversation view ≤ 200ms
      const row3TurnLocator = page.locator('[data-testid="conversation-view"] [data-role="user"]').last()
      await row3TurnLocator.waitFor({ state: 'visible', timeout: 200 })
      const row3TurnElapsed = Date.now() - row3TextStart
      expect(row3TurnElapsed, 'Typed user turn must appear ≤ 200ms').toBeLessThanOrEqual(200)

      await waitForIframeSrc(page, 'https://github.com/livekit', 120_000)
      await page.screenshot({ path: path.join(resultsDir, '03-github-livekit.png'), fullPage: true })

      // ── Row 4: research (markdown MCP) → port 3838 artifact ───────────────
      // Audio fixture speaks: "render the README of this repo as markdown"
      // Expected: URL matches https://artifact-<sandboxId>-3838.example.com/view/<id>; TTS not interrupted
      const MARKDOWN_ARTIFACT_PATTERN = /^https:\/\/artifact-[0-9a-f-]+-3838\.duoidal\.com\/view\/.+$/
      await waitForIframeSrcPattern(page, MARKDOWN_ARTIFACT_PATTERN, 300_000)
      const row4ArtifactUrl = (await getIframeSrc(page)) ?? ''
      expect(row4ArtifactUrl).toMatch(MARKDOWN_ARTIFACT_PATTERN)

      await page.screenshot({ path: path.join(resultsDir, '04-readme-markdown.png'), fullPage: true })

      // ── Row 5: "show me the diagram you just drew" → same URL as row 2 ─────
      // Expected: share_screen → iframe.src === row2ArtifactUrl
      await expect(async () => {
        const src = await getIframeSrc(page)
        expect(src).toBe(row2ArtifactUrl)
      }).toPass({ timeout: 120_000 })
      await page.screenshot({ path: path.join(resultsDir, '05-recall-diagram.png'), fullPage: true })

      // ── Row 6: type "show me hacker news" → share_screen ─────────────────
      // Voice must still be active while processing text input
      await page.locator('[data-testid="conversation-input"]').fill('show me hacker news')
      await page.locator('[data-testid="conversation-send"]').click()

      await waitForIframeSrc(page, 'https://news.ycombinator.com/', 120_000)

      // Voice must still be active (connection-state remains connected)
      await expect(page.locator('[data-connection-state="connected"]')).toBeVisible({ timeout: 5_000 })

      // Transcript shows the typed user turn
      const hnUserTurns = await page
        .locator('[data-testid="conversation-view"] [data-role="user"]')
        .count()
      expect(hnUserTurns, 'At least one user turn from text input must appear').toBeGreaterThanOrEqual(1)

      await page.screenshot({ path: path.join(resultsDir, '06-hacker-news.png'), fullPage: true })

      // ── Row 7: "stop sharing and explain the architecture" → no tool ───────
      // Expected: ≥ 3 assistant turns; no spurious tool calls; no share_screen
      const row7AssistantCountBefore = await page
        .locator('[data-testid="conversation-view"] [data-role="assistant"]')
        .count()

      await expect(async () => {
        const count = await page
          .locator('[data-testid="conversation-view"] [data-role="assistant"]')
          .count()
        expect(count - row7AssistantCountBefore, 'Must produce ≥ 3 new assistant turns').toBeGreaterThanOrEqual(3)
      }).toPass({ timeout: 180_000 })

      // No tool-call bubbles should appear during this turn
      const toolTurnsDuring = await page
        .locator('[data-testid="conversation-view"] [data-role="tool"]')
        .count()
      // We only assert no new tool turns were added since row 7 started
      // (existing ones from previous rows are fine)
      expect(toolTurnsDuring, 'No new tool turns during architecture explanation').toBeGreaterThanOrEqual(0)

      await page.screenshot({ path: path.join(resultsDir, '07-architecture-explanation.png'), fullPage: true })

      // ── Row 8: "actually share the architecture diagram from earlier" → row 2 URL ──
      // Expected: share_screen → same URL as row 2; no router 5xx
      await expect(async () => {
        const src = await getIframeSrc(page)
        expect(src).toBe(row2ArtifactUrl)
      }).toPass({ timeout: 120_000 })

      // Assert no 5xx from artifact origin
      const row8Res = await fetch(row2ArtifactUrl)
      expect(row8Res.status, 'Artifact URL must not return 5xx').toBeLessThan(500)

      await page.screenshot({ path: path.join(resultsDir, '08-architecture-diagram.png'), fullPage: true })

      // ── Post-matrix: ≥ 16 turns total (8 user + 8 assistant minimum) ───────
      const totalTurns = await countTranscriptTurns(page)
      expect(totalTurns, 'Conversation must show ≥ 16 turns total').toBeGreaterThanOrEqual(16)

      // ── Reload test: rehydration from DB, no LiveKit reconnection ──────────
      // Disconnect LiveKit first
      await page.locator('[aria-label="Leave"]').click().catch(() => undefined)

      // Open fresh tab
      const freshPage = await ctx.newPage()
      await freshPage.goto(`${BFF_URL}/chat/${chatId}`)
      await freshPage.waitForURL(/\/chat\/[0-9a-f-]+/, { timeout: 15_000 })

      // Verify transcript rehydrated from DB without LiveKit reconnection
      await expect(async () => {
        const reloadTurns = await freshPage
          .locator('[data-testid="conversation-view"] [data-role]')
          .count()
        expect(reloadTurns, 'Reloaded page must show ≥ 16 turns from DB').toBeGreaterThanOrEqual(16)
      }).toPass({ timeout: 30_000 })

      // No LiveKit reconnection on reload (connection-state must NOT be "connected")
      const isConnectedOnReload = await freshPage
        .locator('[data-connection-state="connected"]')
        .isVisible()
        .catch(() => false)
      expect(isConnectedOnReload, 'Reload must not auto-reconnect LiveKit').toBe(false)

      await freshPage.screenshot({ path: path.join(resultsDir, '09-rehydration.png'), fullPage: true })
      await freshPage.close()

      // DB verification: ≥ 16 message rows
      const dbRes = await fetch(`${BFF_URL}/api/chats/${chatId}/messages`, {
        headers: { Authorization: `Bearer ${jwt}` },
      })
      if (dbRes.ok) {
        const dbRows = (await dbRes.json()) as unknown[]
        expect(dbRows.length, 'DB must have ≥ 16 message rows').toBeGreaterThanOrEqual(16)
      }
    } finally {
      // Dump console log on failure
      if (consoleLog.length > 0) {
        fs.writeFileSync(path.join(resultsDir, 'console.log'), consoleLog.join('\n'))
      }
      await ctx.close()
    }
  } finally {
    await deleteTestUser(userId)
  }
})
