import { test, expect } from '@playwright/test'

test('route renders: orb visible, no errors', async ({ page }) => {
  const errors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text())
  })

  await page.goto('/chat/new')
  await page.waitForURL(/\/chat\/[0-9a-f-]{36}/)
  await expect(page.locator('[data-testid="orb"]')).toBeVisible({ timeout: 2000 })
  expect(errors).toHaveLength(0)
})

test('new chat link visible in sidebar', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('a[href="/chat/new"]')).toBeVisible()
})

test('autostart: orb reaches listening after connect', async ({ page }) => {
  await page.goto('/chat/new?autostart=true')
  await page.waitForURL(/\/chat\/[0-9a-f-]{36}/)
  await expect(page.locator('[data-testid="orb"][data-state="listening"]')).toBeVisible({ timeout: 5000 })
})

test('User speaking placeholder visible during send', async ({ page }) => {
  await page.goto('/chat/new')
  await page.waitForURL(/\/chat\/[0-9a-f-]{36}/)
  await expect(page.locator('[data-testid="orb"]')).toBeVisible()

  // Connect first so the adapter is ready
  await page.locator('[data-testid="orb"]').click()
  await expect(page.locator('[data-testid="orb"][data-state="listening"]')).toBeVisible({ timeout: 3000 })

  // Trigger send and observe "User speaking..." placeholder
  // The 50ms delay in MockAdapter gives us time to observe it
  const [placeholder] = await Promise.all([
    page.waitForSelector(':text("User speaking")', { timeout: 5000 }),
    page.evaluate(() => window.__sendText?.('Show me the architecture')),
  ])
  expect(placeholder).toBeTruthy()
})

test('artifact card renders after stub response', async ({ page }) => {
  await page.goto('/chat/new')
  await page.waitForURL(/\/chat\/[0-9a-f-]{36}/)

  // Click orb to connect
  await page.locator('[data-testid="orb"]').click()
  await expect(page.locator('[data-testid="orb"][data-state="listening"]')).toBeVisible({ timeout: 3000 })

  // Trigger a message — gets the canned response which includes <artifact path="arch.md" />
  await page.evaluate(() => window.__sendText?.('Show me the architecture'))

  // Wait for stream to complete (orb returns to idle)
  await expect(page.locator('[data-testid="orb"][data-state="thinking"]')).toBeVisible({ timeout: 5000 })
  await expect(page.locator('[data-testid="orb"][data-state="idle"]')).toBeVisible({ timeout: 15000 })

  // Artifact viewer should be rendered (arch.md → artifact-md)
  await expect(
    page.locator('[data-testid="artifact-md"], [data-testid="artifact-viewer"]'),
  ).toBeVisible({ timeout: 10000 })
})
