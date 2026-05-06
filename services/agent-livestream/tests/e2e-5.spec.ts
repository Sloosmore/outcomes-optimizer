import { test, expect } from '@playwright/test'

test.describe('Story 6 auth wall — BFF JWT middleware + route guard', () => {
  test('unauthenticated user is redirected to login', async ({ page, context }) => {
    await context.clearCookies()
    // Navigate to a page first so localStorage is accessible, then clear it
    await page.goto('http://localhost:5173/')
    try {
      await page.evaluate(() => {
        localStorage.clear()
        sessionStorage.clear()
      })
    } catch {
      // ignore if storage is not accessible (e.g., about:blank)
    }
    // Reload without stored session to trigger redirect
    await page.goto('http://localhost:5173/')
    await page.waitForURL('**/login', { timeout: 10000 })
    expect(page.url()).toContain('/login')
  })

  test('authenticated user reaches protected route', async ({ page }) => {
    await page.goto('http://localhost:5173/login')
    await page.waitForSelector('[type=email]', { timeout: 5000 })
    await page.fill('[type=email]', process.env['VITE_DEBUG_EMAIL'] ?? 'dev@openclaw.local')
    await page.fill('[type=password]', process.env['VITE_DEBUG_PASSWORD'] ?? 'DevPassword123!')
    await page.click('[type=submit]')
    await page.waitForURL(url => !url.href.includes('/login'), { timeout: 10000 })
    expect(page.url()).not.toContain('/login')
  })
})
