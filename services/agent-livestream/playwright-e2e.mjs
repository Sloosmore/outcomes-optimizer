import { chromium } from '@playwright/test'
import { mkdirSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import http from 'http'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const screenshotsDir = path.join(__dirname, 'screenshots')
mkdirSync(screenshotsDir, { recursive: true })

const BASE_URL = 'http://localhost:5173'
const CHAT_ID = 'test-e2e-chat-id'

const artifacts = [
  { port: 8765, label: 'Mermaid Preview', file: 'artifact-mermaid.png' },
  { port: 8766, label: 'HTTP Directory', file: 'artifact-http.png' },
  { port: 5173, label: 'Vite App in Vite', file: 'artifact-vite-in-vite.png' },
]

async function run() {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    // Ignore SSL errors for iframe content
    ignoreHTTPSErrors: true,
  })

  // Intercept tunnel URLs → proxy to localhost using native http (bypasses credential proxy interceptor)
  // Tries IPv4 first (127.0.0.1), falls back to IPv6 (::1) for servers like Vite that bind to IPv6 only
  function httpGetLocal(port, path) {
    return new Promise((resolve, reject) => {
      const attempt = (host) => {
        const chunks = []
        const req = http.get({ host, port, path }, (res) => {
          res.on('data', (chunk) => chunks.push(chunk))
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
        })
        req.on('error', (err) => {
          if (host === '127.0.0.1') {
            // IPv4 failed, try IPv6
            attempt('::1')
          } else {
            reject(err)
          }
        })
      }
      attempt('127.0.0.1')
    })
  }

  // Match artifact-router single-label hostnames: artifact-<sandboxId>-<port>.example.com
  await context.route(/^https:\/\/artifact-[^.]+-\d+\.duoidal\.com\//, async (route) => {
    const url = new URL(route.request().url())
    const m = url.hostname.match(/^artifact-[a-zA-Z0-9-]+-(\d+)\.duoidal\.com$/)
    const port = m ? parseInt(m[1], 10) : NaN
    if (!isNaN(port) && port >= 3000 && port <= 9999) {
      const newPath = `${url.pathname}${url.search}`
      console.log(`  [route] ${url.hostname} → localhost:${port}${newPath}`)
      try {
        const result = await httpGetLocal(port, newPath)
        await route.fulfill({
          status: result.status,
          headers: result.headers,
          body: result.body,
        })
      } catch (err) {
        console.log(`  [route] http.get failed: ${err.message}`)
        await route.abort()
      }
    } else {
      await route.continue()
    }
  })

  const page = await context.newPage()

  page.on('console', msg => {
    if (msg.type() === 'error' || msg.text().includes('ArtifactPanel')) {
      console.log(`  [page] ${msg.type()}: ${msg.text()}`)
    }
  })

  // Navigate to the chat page
  console.log(`Navigating to ${BASE_URL}/chat/${CHAT_ID}`)
  await page.goto(`${BASE_URL}/chat/${CHAT_ID}`, { waitUntil: 'networkidle', timeout: 30000 })

  // Wait for the page to render (React hydration)
  await page.waitForTimeout(2000)

  // Verify __injectArtifact is available
  const hasInject = await page.evaluate(() => typeof window.__injectArtifact === 'function')
  if (!hasInject) {
    console.error('ERROR: window.__injectArtifact not found — VITE_TEST=1 may not be set')
    process.exit(1)
  }
  console.log('window.__injectArtifact is available')

  for (const { port, label, file } of artifacts) {
    console.log(`Injecting artifact: port=${port}, label="${label}"`)
    await page.evaluate(({ port, label }) => {
      window.__injectArtifact({ port, label })
    }, { port, label })

    // Wait for iframe to load content
    try {
      await page.waitForSelector('iframe', { timeout: 5000 })
    } catch (_) {}
    await page.waitForTimeout(6000)

    // Verify ArtifactPanel is visible (label text rendered)
    const labelVisible = await page.evaluate((label) => {
      return document.body.innerText.includes(label)
    }, label)
    console.log(`  Label "${label}" visible: ${labelVisible}`)

    // Verify iframe exists in DOM
    const iframeExists = await page.evaluate(() => document.querySelector('iframe') !== null)
    console.log(`  iframe in DOM: ${iframeExists}`)

    const iframeInfo = await page.evaluate(() => {
      const iframe = document.querySelector('iframe')
      if (!iframe) return 'no iframe'
      return `src=${iframe.src} w=${iframe.offsetWidth} h=${iframe.offsetHeight}`
    })
    console.log(`  iframe info: ${iframeInfo}`)

    const frames = page.frames()
    console.log(`  active frames: ${frames.length}`)
    for (const f of frames) {
      console.log(`    frame: ${f.url()}`)
    }

    const screenshotPath = path.join(screenshotsDir, file)
    await page.screenshot({ path: screenshotPath, fullPage: false })
    console.log(`  Screenshot saved: ${screenshotPath}`)
  }

  await browser.close()
  console.log('All screenshots captured successfully.')
}

run().catch((err) => {
  console.error('Playwright script failed:', err)
  process.exit(1)
})
