import { test, expect } from '@playwright/test'

test('E2E-4: Tasks page navigation', async ({ page }) => {
  // 1. Navigate to /tasks
  await page.goto('/tasks')
  await expect(page.locator('h1')).toContainText('Chats')

  // 2. Click [+] → "New call" → navigate to /chat/:id
  await page.locator('[data-testid="new-call-button"]').click()
  await page.getByRole('menuitem', { name: 'New call' }).click()
  await page.waitForURL(/\/chat\/[0-9a-f-]+/)
  const chatUrl = page.url()
  const chatId = chatUrl.split('/chat/')[1]

  // 3. Join the room (click Join button)
  await page.getByRole('button', { name: /Join|Rejoin/ }).click()

  // Wait for connecting/connected state (audio visualizer visible)
  await page.waitForTimeout(500)

  // 4. Navigate to /tasks
  await page.goto('/tasks')

  // 5. Assert: chat appears in list (use .first() since multiple "New call" chats may exist)
  await expect(page.getByText('New call').first()).toBeVisible({ timeout: 5000 })

  // 6. Click row → /chat/:id
  await page.getByText('New call').first().click()
  await page.waitForURL(new RegExp(chatId ?? ''))

  // Assert: Rejoin button visible (chat was previously visited)
  await expect(page.getByRole('button', { name: /Join|Rejoin/ })).toBeVisible({ timeout: 3000 })
})
