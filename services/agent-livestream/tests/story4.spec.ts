import { test, expect } from '@playwright/test'
import path from 'node:path'
import fs from 'node:fs'
import http from 'node:http'

function httpGetLocal(port: number, urlPath: string): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const attempt = (host: string) => {
      const chunks: Buffer[] = []
      http.get({ host, port, path: urlPath }, (res) => {
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => resolve({
          status: res.statusCode ?? 200,
          headers: res.headers as Record<string, string>,
          body: Buffer.concat(chunks),
        }))
        res.on('error', reject)
      }).on('error', (err) => {
        if (host === '127.0.0.1') {
          attempt('::1')
        } else {
          reject(err)
        }
      })
    }
    attempt('127.0.0.1')
  })
}

test('E2E: LLM calls open_artifact via tool, SSE emits CUSTOM, ArtifactPanel renders iframe', async ({ page, context }) => {
  // Intercept artifact-router URLs and redirect to localhost services
  await context.route(/https:\/\/artifact-[^.]+-\d+\.duoidal\.com\//, async (route) => {
    const url = new URL(route.request().url())
    const portMatch = url.hostname.match(/^artifact-[a-zA-Z0-9-]+-(\d+)\.duoidal\.com$/)
    if (!portMatch) { await route.continue(); return }
    const port = parseInt(portMatch[1], 10)
    // Validate port range to prevent proxying to privileged or unintended ports
    if (isNaN(port) || port < 3000 || port > 9999) { await route.continue(); return }
    try {
      const result = await httpGetLocal(port, url.pathname || '/')
      await route.fulfill({ status: result.status, headers: result.headers, body: result.body })
    } catch {
      await route.abort()
    }
  })

  // Navigate to a new chat
  await page.goto('/chat/new')
  await page.waitForURL(/\/chat\/[0-9a-f-]{36}/, { timeout: 10000 })

  // Wait for __textSend to be available (set in useEffect under VITE_TEST=1)
  await page.waitForFunction(() => typeof window.__textSend === 'function', { timeout: 5000 })

  // Send a message that causes the LLM to call open_artifact
  await page.evaluate(() => {
    window.__textSend?.('Call open_artifact with port 8765 and label Mermaid Preview right now. Do not say anything else, just call the tool.')
  })

  // Wait for ArtifactPanel iframe to appear (the SSE CUSTOM event was processed)
  await expect(page.locator('iframe')).toBeVisible({ timeout: 60000 })

  // Wait a moment for iframe content to load
  await page.waitForTimeout(2000)

  // Take screenshot
  const screenshotsDir = path.join(process.cwd(), 'screenshots')
  if (!fs.existsSync(screenshotsDir)) fs.mkdirSync(screenshotsDir, { recursive: true })

  await page.screenshot({
    path: path.join(screenshotsDir, 'artifact-e2e-tool-call.png'),
    fullPage: false
  })
})
