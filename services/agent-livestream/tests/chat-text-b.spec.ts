import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'

const TURNS = [
  'I want a skill that monitors running processes and alerts on failures',
  'Alert via the send-message skill to a Slack channel',
  'Check every 5 minutes, alert if a process status goes to failed',
  'No other constraints',
  'Yes, confirmed',
]

interface MessageRow {
  id: string
  chat_id: string
  role: string
  content: string
  tool_calls: unknown
  created_at: string
}

/** Poll /api/chat/:id/messages from the browser context (avoids SSRF proxy blocking Node-to-localhost). */
async function pollMessages(page: Page, chatId: string, expectedCount: number): Promise<MessageRow[]> {
  return page.evaluate(
    async ({ cid, count }) => {
      const deadline = Date.now() + 15_000
      while (Date.now() < deadline) {
        const res = await fetch(`/api/chat/${cid}/messages`)
        if (res.ok) {
          const body = (await res.json()) as { messages: MessageRow[] }
          if (body.messages.length >= count) return body.messages
        }
        await new Promise((r) => setTimeout(r, 500))
      }
      throw new Error(`Timed out waiting for ${count} messages in chat ${cid}`)
    },
    { cid: chatId, count: expectedCount },
  )
}

function at<T>(arr: T[], index: number): T {
  const val = arr[index]
  if (val === undefined) throw new Error(`No element at index ${index}`)
  return val
}

test.describe('Campaign B — Agent Failure Alerting', () => {
  test('5-turn campaign: tool_calls on turn 3, turn 5 references turn 1', async ({ page }) => {
    // Turn 1
    await page.goto(`/chat/new?autostart=true&message=${encodeURIComponent(at(TURNS, 0))}`)
    await page.waitForURL(/\/chat\/[0-9a-f-]{36}/, { timeout: 10_000 })
    const chatId = page.url().match(/\/chat\/([0-9a-f-]{36})/)?.[1] ?? ''
    expect(chatId).toBeTruthy()

    await expect(page.locator('[data-testid="orb"][data-state="thinking"], [data-testid="orb"][data-state="speaking"]')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('[data-testid="orb"][data-state="idle"]')).toBeVisible({ timeout: 15_000 })
    await pollMessages(page, chatId, 2)

    // Turns 2-5
    for (let i = 1; i < TURNS.length; i++) {
      await page.goto(`/chat/${chatId}?autostart=true&message=${encodeURIComponent(at(TURNS, i))}`)
      await expect(page.locator('[data-testid="orb"][data-state="thinking"], [data-testid="orb"][data-state="speaking"]')).toBeVisible({ timeout: 10_000 })
      await expect(page.locator('[data-testid="orb"][data-state="idle"]')).toBeVisible({ timeout: 15_000 })
      await pollMessages(page, chatId, (i + 1) * 2)
    }

    // Assert: 10 DB rows
    const allMessages = await pollMessages(page, chatId, 10)
    expect(allMessages).toHaveLength(10)

    // Turn 3 assistant (index 5) has tool_calls with claude_code
    const turn3Assistant = at(allMessages, 5)
    expect(turn3Assistant.role).toBe('assistant')
    expect(turn3Assistant.tool_calls).toBeTruthy()
    const toolCalls = turn3Assistant.tool_calls as { name: string }[]
    expect(toolCalls.some((tc) => tc.name === 'claude_code')).toBe(true)

    // Turn 5 response references content from turn 1 (monitor or process)
    const turn5Assistant = at(allMessages, 9)
    expect(turn5Assistant.role).toBe('assistant')
    const t5Lower = turn5Assistant.content.toLowerCase()
    expect(t5Lower.includes('monitor') || t5Lower.includes('process')).toBe(true)
  })
})
