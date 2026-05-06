import { test, expect } from '@playwright/test'

const BASE_API = 'http://localhost:3001'

async function createChat(title: string): Promise<string> {
  const res = await fetch(`${BASE_API}/api/chats`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  })
  if (!res.ok) throw new Error(`POST /api/chats failed: ${res.status}`)
  const body = (await res.json()) as { id: string }
  return body.id
}

async function pushArtifactUrl(chatId: string, url: string): Promise<void> {
  const res = await fetch(`${BASE_API}/api/chats/${chatId}/artifact`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  })
  if (!res.ok) throw new Error(`PATCH /api/chats/${chatId}/artifact failed: ${res.status}`)
}

const SANDBOX_ID = process.env.SANDBOX_ID ?? 'test-sandbox'

/**
 * E2E-2b: Tile reload-restore from DB.
 *
 * Pushes a URL onto the tile rail via PATCH, loads /chat/:id, asserts the
 * artifact-frame renders the same URL, reloads, and re-asserts.
 */
test('E2E-2b: tile reload-restore from DB', async ({ page }) => {
  const port = 3741
  const expectedSrc = `https://artifact-${SANDBOX_ID}-${port}.example.com/`

  await page.route(new RegExp(`https://artifact-[^.]+-${port}\\.duoidal\\.com/`), async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<html><body>artifact content</body></html>',
    })
  })

  const chatId = await createChat('E2E-2b reload-restore test')
  await pushArtifactUrl(chatId, expectedSrc)

  await page.goto(`/chat/${chatId}`)
  const frame = page.locator('[data-testid="artifact-frame"]')
  await expect(frame).toBeVisible({ timeout: 5000 })

  const src = await frame.getAttribute('src')
  expect(src).toBe(expectedSrc)

  await page.reload()
  const frameAfterReload = page.locator('[data-testid="artifact-frame"]')
  await expect(frameAfterReload).toBeVisible({ timeout: 2000 })
  const srcAfterReload = await frameAfterReload.getAttribute('src')
  expect(srcAfterReload).toBe(expectedSrc)
})

/**
 * E2E-2a: Full LiveKit-driven artifact flow. Skipped without LIVEKIT_AVAILABLE=1.
 */
test('E2E-2a: artifact via LiveKit research worker', async ({ page }) => {
  test.skip(process.env.LIVEKIT_AVAILABLE !== '1', 'Requires live LiveKit + SSH to OpenClaw')

  const port = 3740
  await page.route(new RegExp(`https://artifact-[^.]+-${port}\\.duoidal\\.com/`), async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<html><body><h1>Live HTML clock</h1></body></html>',
    })
  })

  await page.goto('/tasks')
  await page.locator('button').filter({ hasText: /\+/ }).click()
  await page.getByText('New call').click()
  await page.waitForURL(/\/chat\/[0-9a-f-]+/)

  await page.getByRole('button', { name: /Join|Rejoin/ }).click()
  await expect(page.locator('[data-connection-state="connected"]')).toBeVisible({ timeout: 5000 })

  await page.evaluate(() => window.__sendText?.('make a live HTML clock, start an HTTP server on port 3740'))

  const frame = page.locator('[data-testid="artifact-frame"]')
  await expect(frame).toBeVisible({ timeout: 180_000 })

  const src = await frame.getAttribute('src')
  expect(src).toMatch(new RegExp(`https://artifact-[^.]+-${port}\\.duoidal\\.com/`))

  const currentUrl = page.url()
  await page.goto(currentUrl)
  await expect(page.locator('[data-testid="artifact-frame"]')).toBeVisible({ timeout: 2000 })
  const srcAfter = await page.locator('[data-testid="artifact-frame"]').getAttribute('src')
  expect(srcAfter).toBe(src)
})
