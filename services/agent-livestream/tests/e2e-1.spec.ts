import { test, expect } from '@playwright/test'

test('E2E-1: Voice turn latency', async ({ page }) => {
  test.skip(
    process.env.LIVEKIT_AVAILABLE !== '1',
    'Requires live LiveKit + OpenAI voice pipeline',
  )

  // 1. Navigate to /tasks, click [+] → "New call"
  await page.goto('/tasks')
  await page.locator('[data-testid="new-call-button"]').click()
  await page.getByText('New call').click()
  await page.waitForURL(/\/chat\/[0-9a-f-]+/)

  // 2. Click Join, wait for connected (max 5s)
  await page.getByRole('button', { name: /Join|Rejoin/ }).click()
  await expect(page.locator('[data-connection-state="connected"]')).toBeVisible({
    timeout: 5000,
  })

  // 3. Inject sendText
  await page.evaluate(() => window.__sendText?.('hello'))

  // 4. Assert: <audio> play event fires within 3000ms
  const audioPlayed = await page.evaluate(() => {
    return new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => resolve(false), 3000)
      const observer = new MutationObserver(() => {
        const audios = document.querySelectorAll('audio')
        for (const audio of audios) {
          audio.addEventListener(
            'play',
            () => {
              clearTimeout(timeout)
              resolve(true)
            },
            { once: true },
          )
        }
      })
      observer.observe(document.body, { childList: true, subtree: true })
      // Also check existing audio elements
      const existing = document.querySelectorAll('audio')
      for (const audio of existing) {
        audio.addEventListener(
          'play',
          () => {
            clearTimeout(timeout)
            resolve(true)
          },
          { once: true },
        )
      }
    })
  })
  expect(audioPlayed).toBe(true)
})
