import { test, expect } from '@playwright/test'
import { randomUUID } from 'crypto'

test.describe('Story 6 — Chat history from DB', () => {
  test('loads DB messages in fresh browser context', async ({ browser, request }) => {
    const oracle = `oracle-${randomUUID()}`

    // POST to /api/chat — request fixture reads full SSE body
    const response = await request.post('/api/chat', {
      data: { messages: [{ role: 'user', content: oracle }] },
    })
    expect(response.ok()).toBeTruthy()
    const body = await response.text()

    const chatId = body.match(/"threadId":"([0-9a-f-]{36})"/)?.[1]
    expect(chatId).toBeTruthy()

    // Use a page to poll for assistant message (handles race: stream closes before DB insert)
    const pollContext = await browser.newContext()
    const pollPage = await pollContext.newPage()
    await pollPage.goto('/')
    await pollPage.evaluate(
      async (cid) => {
        const deadline = Date.now() + 15_000
        while (Date.now() < deadline) {
          const r = await fetch(`/api/chat/${cid}/messages`)
          if (r.ok) {
            const j = (await r.json()) as { messages: Array<{ role: string }> }
            if (j.messages.some((m) => m.role === 'assistant')) return
          }
          await new Promise((res) => setTimeout(res, 500))
        }
        throw new Error(`Timed out waiting for assistant message in chat ${cid}`)
      },
      chatId as string,
    )
    await pollContext.close()

    // Open fresh browser context (no localStorage/session) and navigate to chat
    const freshContext = await browser.newContext()
    const page = await freshContext.newPage()
    await page.goto(`/chat/${chatId}`)

    // Assert transcript contains oracle string
    await expect(page.locator('[data-testid="transcript"]')).toContainText(oracle, { timeout: 5_000 })

    await freshContext.close()
  })
})
