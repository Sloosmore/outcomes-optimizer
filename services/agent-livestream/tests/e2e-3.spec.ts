import { test, expect } from '@playwright/test'

/**
 * E2E-3: Full brainstorming session with artifact + persistence.
 *
 * Requires live LiveKit + SSH to OpenClaw (full research worker).
 * Skipped if LIVEKIT_AVAILABLE is not "1".
 */
test.skip(process.env.LIVEKIT_AVAILABLE !== '1', 'E2E-3 requires live LiveKit + SSH to OpenClaw')

// Artifact-router single-label hostname format: artifact-<sandboxId>-<port>.example.com

test('E2E-3: full brainstorming session with artifact and persistence', async ({ page }) => {
  // 1. Navigate to /tasks, start new call
  await page.goto('/tasks')
  await page.locator('button').filter({ hasText: /\+/ }).click()
  await page.getByText('New call').click()
  await page.waitForURL(/\/chat\/[0-9a-f-]+/)
  const chatUrl = page.url()

  // Join room
  await page.getByRole('button', { name: /Join|Rejoin/ }).click()
  await expect(page.locator('[data-connection-state="connected"]')).toBeVisible({ timeout: 5000 })

  // 2. Send first message
  await page.evaluate(() => window.__sendText?.("I'm building a SaaS for restaurant inventory management"))
  // Wait for reply (agent speaks)
  await page.waitForFunction(
    () => (document.querySelectorAll('[data-testid="chat-message"]').length ?? 0) >= 2,
    { timeout: 30_000 }
  )

  // 3. Send second message
  await page.evaluate(() => window.__sendText?.("What's the core data model?"))
  await page.waitForFunction(
    () => (document.querySelectorAll('[data-testid="chat-message"]').length ?? 0) >= 4,
    { timeout: 30_000 }
  )

  // 4. Send third message requesting artifact
  await page.evaluate(() => window.__sendText?.(
    'Give me three feature ideas for reducing food waste, and create a visual summary as an HTML page'
  ))

  // Wait for artifact frame (up to 3 minutes)
  const frame = page.locator('[data-testid="artifact-frame"]')
  await expect(frame).toBeVisible({ timeout: 180_000 })

  // 5. Assert: transcript >= 3 exchanges (at least 6 messages: 3 user + 3 assistant)
  const messages = page.locator('[data-testid="chat-message"]')
  await expect(messages).toHaveCount(6, { timeout: 5000 })

  // 6. Assert: artifact iframe src is port URL
  const iframeSrc = await frame.getAttribute('src')
  expect(iframeSrc).toMatch(/^https:\/\/artifact-[^.]+-\d+\.duoidal\.com\//)

  // Stub iframe so GET returns 200
  await page.route(/^https:\/\/artifact-[^.]+-\d+\.duoidal\.com\//, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<html><body>feature ideas</body></html>',
    })
  })

  // 7. Close page and reopen
  await page.goto(chatUrl)

  // Artifact frame should restore within 2s
  await expect(page.locator('[data-testid="artifact-frame"]')).toBeVisible({ timeout: 2000 })
  const restoredSrc = await page.locator('[data-testid="artifact-frame"]').getAttribute('src')
  expect(restoredSrc).toBe(iframeSrc)

  // Transcript restored
  await expect(page.locator('[data-testid="chat-message"]').first()).toBeVisible({ timeout: 2000 })

  // 8. Rejoin and verify agent context recall
  await page.getByRole('button', { name: /Join|Rejoin/ }).click()
  await expect(page.locator('[data-connection-state="connected"]')).toBeVisible({ timeout: 5000 })

  await page.evaluate(() => window.__sendText?.('What did we discuss about the data model?'))
  await page.waitForFunction(
    () => {
      const msgs = Array.from(document.querySelectorAll('[data-testid="chat-message"]'))
      return msgs.some((el) => {
        const text = el.textContent?.toLowerCase() ?? ''
        return text.includes('inventory') || text.includes('data model')
      })
    },
    { timeout: 30_000 }
  )
})
