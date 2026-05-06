import { test, expect } from '@playwright/test'

test('research tool fires when asked about the codebase', async ({ page }) => {
  // Navigate and wait for redirect to /chat/<uuid>
  await page.goto('/chat/new')
  await page.waitForURL(/\/chat\/[0-9a-f-]{36}/)

  // Connect
  await page.click('[data-testid="orb"]')
  await expect(page.locator('[data-testid="orb"]')).toHaveAttribute('data-state', 'listening', {
    timeout: 15_000,
  })

  // Ask a question that requires the research tool to answer correctly.
  // The model cannot know which specific skills exist in this repo from training data.
  await page.evaluate(() => {
    ;(window as unknown as { __sendText: (t: string) => void }).__sendText(
      'What skills are available in this system? List their names.',
    )
  })

  // Orb must reach 'calling' — confirms agent_tool_start fired
  await expect(page.locator('[data-testid="orb"]')).toHaveAttribute('data-state', 'calling', {
    timeout: 30_000,
  })

  // 3-dot animation must be visible while in calling state
  await expect(page.locator('[data-testid="orb"] .animate-bounce').first()).toBeVisible()

  // Wait for tool call to complete and model to respond
  await expect(page.locator('[data-testid="orb"]')).toHaveAttribute('data-state', /(speaking|listening)/, {
    timeout: 60_000,
  })

  // Transcript must contain content — the model's response with tool-derived skill names
  const transcriptEl = page.locator('[data-testid="transcript"]')
  await expect(transcriptEl).not.toBeEmpty({ timeout: 10_000 })
  const text = await transcriptEl.textContent()
  // At least one known skill name must appear — proves the tool result was used
  const knownSkills = ['dispatch', 'agent-instagram', 'agent-media', 'create-skill', 'oversight']
  const found = knownSkills.some((s) => text?.toLowerCase().includes(s))
  expect(found, `Transcript did not mention any known skill. Got: ${text?.slice(0, 300)}`).toBe(true)
})
