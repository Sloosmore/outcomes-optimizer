import { test, expect } from '@playwright/test'

const THREAD_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const RUN_ID = 'ffffffff-1111-2222-3333-444444444444'

// The BFF emits a dedicated ARTIFACT event when it parses <open_artifact> from a tool result.
// The frontend reacts to that event type — not to embedded XML in text deltas.
const SSE_BODY = [
  `data: {"type":"RUN_STARTED","threadId":"${THREAD_ID}","runId":"${RUN_ID}"}`,
  '',
  `data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"msg-001","delta":"Here is the service: "}`,
  '',
  `data: {"type":"ARTIFACT","port":3001,"label":"Test Service","url":"https://artifact-test-sandbox-3001.example.com/"}`,
  '',
  'data: [DONE]',
  '',
].join('\n')

test('xml artifact tag in SSE stream renders ArtifactPanel iframe', async ({ page }) => {
  // Stub POST /api/chat to return canned SSE
  await page.route('**/api/chat', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue()
      return
    }
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: SSE_BODY,
    })
  })

  // Stub GET /api/chat/:id/messages to return empty history
  await page.route(/\/api\/chat\/[0-9a-f-]+\/messages/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ messages: [] }),
    })
  })

  // Intercept iframe artifact-router URL so it doesn't make real network requests
  await page.route(/https:\/\/artifact-[^.]+-\d+\.duoidal\.com\//, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<html><body>artifact</body></html>',
    })
  })

  // Navigate — client-side redirect from /chat/new to /chat/<uuid>
  await page.goto('/chat/new')
  await page.waitForURL(/\/chat\//, { timeout: 10000 })

  // Wait for __textSend (exposed under VITE_TEST=1)
  await page.waitForFunction(
    () => typeof window.__textSend === 'function',
    { timeout: 5000 },
  )

  // Send a message — triggers the stubbed SSE stream
  await page.evaluate(() => window.__textSend?.('test'))

  // Assert iframe becomes visible (ArtifactPanel rendered)
  await expect(page.locator('iframe')).toBeVisible({ timeout: 10000 })
})
