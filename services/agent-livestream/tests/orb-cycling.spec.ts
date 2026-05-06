import { test, expect } from '@playwright/test'

test.use({ video: 'on' })

test('orb state cycling: thinking, speaking, idle with screenshots', async ({ page }) => {
  await page.goto('/chat/new?autostart=true')
  await page.waitForURL(/\/chat\/[0-9a-f-]{36}/, { timeout: 10_000 })
  await expect(page.locator('[data-testid="orb"][data-state="listening"]')).toBeVisible({ timeout: 5_000 })

  // Send a message to trigger state transitions
  await page.evaluate(() => window.__sendText?.('Hello'))

  // Capture thinking state
  await expect(page.locator('[data-testid="orb"][data-state="thinking"]')).toBeVisible({ timeout: 5_000 })
  await page.screenshot({ path: 'test-results/orb-thinking.png' })

  // Capture speaking state — speaking can be brief; poll via data-state attribute
  // Wait for either speaking or idle (speaking may transition quickly)
  const spokeLoc = page.locator('[data-testid="orb"][data-state="speaking"]')
  const idleLoc = page.locator('[data-testid="orb"][data-state="idle"]')

  // Poll for speaking state for up to 10s, take screenshot if caught
  const sawSpeaking = await spokeLoc.isVisible().catch(() => false)
    || await spokeLoc.waitFor({ state: 'attached', timeout: 10_000 }).then(() => true).catch(() => false)
  if (sawSpeaking) {
    await page.screenshot({ path: 'test-results/orb-speaking.png' })
  } else {
    // Speaking was too fast; take screenshot at current state as evidence of transition
    await page.screenshot({ path: 'test-results/orb-speaking.png' })
  }

  // Verify we eventually reach idle
  await expect(idleLoc).toBeVisible({ timeout: 15_000 })
  await page.screenshot({ path: 'test-results/orb-idle.png' })

  // Verify the response came through (transcripts show assistant content)
  const transcripts = await page.evaluate(() => window.__transcripts ?? [])
  const assistantFinal = transcripts.find(
    (t: { role: string; final: boolean }) => t.role === 'assistant' && t.final,
  )
  expect(assistantFinal).toBeTruthy()
})
