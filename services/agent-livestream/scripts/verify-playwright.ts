import { chromium, type Browser } from '@playwright/test'
import * as fs from 'fs'
import * as path from 'path'

async function main() {
  const results: { check: string; pass: boolean; detail: string }[] = []
  let browser: Browser | null = null

  try {
    browser = await chromium.launch()
    const port = process.env.VITE_PORT ?? '5173'
    const url = `http://localhost:${port}`

    // Check 1: Light mode screenshot after 4 seconds
    const page = await browser.newPage()
    await page.goto(url)
    await page.waitForTimeout(4000)

    const screenshotDir = path.resolve('workspace/screenshots')
    fs.mkdirSync(screenshotDir, { recursive: true })
    await page.screenshot({ path: path.join(screenshotDir, 'graph-settled.png'), fullPage: true })
    const screenshotSize = fs.statSync(path.join(screenshotDir, 'graph-settled.png')).size
    results.push({
      check: '1. Screenshot saved',
      pass: screenshotSize > 10000,
      detail: `screenshot size: ${screenshotSize} bytes`,
    })

    // Check 2: Zero node overlap
    const nodePositions = await page.evaluate(() => {
      const nodes = document.querySelectorAll('[data-node-id]')
      return Array.from(nodes).map((el) => {
        const rect = el.getBoundingClientRect()
        return { id: el.getAttribute('data-node-id') ?? '', x: rect.left, y: rect.top, w: rect.width, h: rect.height }
      })
    })

    let overlapping = 0
    for (let i = 0; i < nodePositions.length; i++) {
      for (let j = i + 1; j < nodePositions.length; j++) {
        const a = nodePositions[i]
        const b = nodePositions[j]
        const overlapX = a.x < b.x + b.w && a.x + a.w > b.x
        const overlapY = a.y < b.y + b.h && a.y + a.h > b.y
        if (overlapX && overlapY) overlapping++
      }
    }
    results.push({
      check: '2. Zero node overlap',
      pass: overlapping === 0,
      detail: `${overlapping} overlapping pairs out of ${nodePositions.length} nodes`,
    })

    // Check 3: Dot grid background
    const hasDotGrid = await page.evaluate(() => {
      return (
        document.querySelector('pattern[id*="background"]') !== null ||
        document.querySelector('.react-flow__background') !== null
      )
    })
    results.push({
      check: '3. Dot grid background',
      pass: hasDotGrid,
      detail: hasDotGrid ? 'background element found' : 'no background element',
    })

    // Check 4: At least one edge
    const edgeCount = await page.evaluate(() => {
      return document.querySelectorAll('.react-flow__edge').length
    })
    results.push({
      check: '4. At least one edge',
      pass: edgeCount >= 1,
      detail: `${edgeCount} edges found`,
    })

    // Check 5: Dark mode renders correctly
    await page.close()
    const darkPage = await browser.newPage({
      colorScheme: 'dark',
    })
    await darkPage.goto(url)
    await darkPage.waitForTimeout(2000)
    await darkPage.screenshot({ path: path.join(screenshotDir, 'graph-dark.png'), fullPage: true })

    // Check that dark mode applied (background should be dark)
    const isDark = await darkPage.evaluate(() => {
      const body = document.body
      const bg = window.getComputedStyle(body).backgroundColor
      // Dark mode: rgba with low values
      const match = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/)
      if (!match) return false
      const r = parseInt(match[1])
      const g = parseInt(match[2])
      const b = parseInt(match[3])
      return r < 100 && g < 100 && b < 100
    })
    results.push({
      check: '5. Dark mode renders',
      pass: isDark,
      detail: isDark ? 'dark background detected' : 'light background in dark mode',
    })

    await darkPage.close()
  } finally {
    await browser?.close()
  }

  console.log('\n=== Playwright Verification Results ===')
  let allPass = true
  for (const r of results) {
    const status = r.pass ? 'PASS' : 'FAIL'
    console.log(`${status}: ${r.check} — ${r.detail}`)
    if (!r.pass) allPass = false
  }
  console.log(`\nOverall: ${allPass ? 'ALL PASS' : 'SOME CHECKS FAILED'}`)

  fs.writeFileSync('workspace/screenshots/playwright-results.json', JSON.stringify(results, null, 2))

  process.exit(allPass ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
