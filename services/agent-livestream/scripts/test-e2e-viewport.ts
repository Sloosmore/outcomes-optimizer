import { chromium } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'
import { spawn, type ChildProcess } from 'child_process'
import * as path from 'path'
import { fileURLToPath } from 'url'
import { getSupabaseUrl } from '@skill-networks/database/constants'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const SUPABASE_URL = getSupabaseUrl()
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY

if (!SUPABASE_SERVICE_KEY) {
  console.error('Missing required env var: SUPABASE_SERVICE_KEY')
  process.exit(1)
}

// Generate a unique sentinel to track the inserted event in the viewport
const sentinel = `e2e-viewport-${Math.random().toString(36).slice(2)}`

function spawnServer(command: string, args: string[], cwd: string, readyPhrase: string): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })

    proc.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      if (text.includes(readyPhrase)) {
        resolve(proc)
      }
    })

    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      if (text.includes(readyPhrase)) {
        resolve(proc)
      }
    })

    proc.on('error', reject)

    // Fallback: resolve after 10s even if ready phrase not seen
    setTimeout(() => resolve(proc), 10_000)
  })
}

const serviceDir = path.resolve(__dirname, '..')

// Teardown state held in a plain object to avoid TypeScript narrowing variables to `never`
// in the finally block after top-level process.exit() guards above.
const teardown = {
  bffProc: null as ChildProcess | null,
  viteProc: null as ChildProcess | null,
  browser: null as Awaited<ReturnType<typeof chromium.launch>> | null,
}

async function cleanup() {
  if (teardown.browser) {
    await teardown.browser.close().catch(() => {})
  }
  if (teardown.bffProc) {
    teardown.bffProc.kill('SIGTERM')
  }
  if (teardown.viteProc) {
    teardown.viteProc.kill('SIGTERM')
  }
}

async function main(): Promise<number> {
  // Start BFF server on port 3001
  teardown.bffProc = await spawnServer('npx', ['tsx', 'server/adapters/node.ts'], serviceDir, 'Server running at')

  // Start Vite dev server on port 5173
  teardown.viteProc = await spawnServer('npx', ['vite', '--port', '5173', '--strictPort'], serviceDir, 'localhost:5173')

  // Launch headless Playwright browser
  teardown.browser = await chromium.launch({ headless: true })
  const page = await teardown.browser.newPage()

  await page.goto('http://localhost:5173', { waitUntil: 'networkidle', timeout: 30_000 })

  // Insert test row using service_role key so it propagates via Realtime to the viewport
  const supabase = createClient(SUPABASE_URL!, SUPABASE_SERVICE_KEY!)

  const { randomUUID } = await import('crypto')
  const row = {
    id: randomUUID(),
    process_id: randomUUID(),
    process_name: 'e2e-viewport-test',
    resource_id: randomUUID(),
    source: sentinel,
    payload: null,
    ts: new Date().toISOString(),
  }

  const { error } = await supabase.from('agent_events').insert(row)
  if (error) {
    console.error('Insert error:', error.message)
    throw new Error(`Failed to insert sentinel row: ${error.message}`)
  }

  // Wait up to 5 seconds for the sentinel to appear in the DOM
  let found = false
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const bodyText = await page.evaluate(() => document.body.innerText)
    if (bodyText.includes(sentinel)) {
      found = true
      break
    }
    await new Promise((r) => setTimeout(r, 200))
  }

  if (found) {
    console.log(`E2E viewport test passed — sentinel found in DOM: ${sentinel}`)
    return 0
  } else {
    const bodyText = await page.evaluate(() => document.body.innerText)
    console.error(`E2E viewport test FAILED — sentinel not found: ${sentinel}`)
    console.error(`Page content (first 500 chars): ${bodyText.slice(0, 500)}`)
    return 1
  }
}

let exitCode = 1
try {
  exitCode = await main()
} catch (err) {
  console.error('E2E test error:', err instanceof Error ? err.message : String(err))
  exitCode = 1
} finally {
  // Teardown: close browser and kill both servers regardless of result
  await cleanup()
}

process.exit(exitCode)
