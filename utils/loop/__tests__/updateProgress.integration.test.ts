import { writeFileSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// Mock the run module to prevent side effects when importing utils/loop/index
// NOTE: We still need to mock run to prevent module-level side effects on import,
// but we are NOT mocking updateProgress, patchProcess, or StoryProgressAdapter.
// The real updateProgress() → patchProcess() → Supabase path is exercised.
vi.mock('../../run', () => ({
  run: vi.fn(),
}))

import { updateProgress } from '../index.js'

// --- Supabase helpers ---

async function getProcessProgress(processId: string): Promise<number | null> {
  const supabaseUrl = process.env.SUPABASE_URL!
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY!
  const res = await fetch(
    `${supabaseUrl}/rest/v1/processes?id=eq.${encodeURIComponent(processId)}&select=progress`,
    {
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        Accept: 'application/json',
      },
    }
  )
  if (!res.ok) throw new Error(`GET progress failed: ${res.status} ${res.statusText}`)
  const rows = (await res.json()) as Array<{ progress: number | null }>
  if (!rows.length) return null
  return rows[0].progress
}

async function setProcessProgress(processId: string, progress: number | null): Promise<void> {
  const supabaseUrl = process.env.SUPABASE_URL!
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY!
  const res = await fetch(
    `${supabaseUrl}/rest/v1/processes?id=eq.${encodeURIComponent(processId)}`,
    {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ progress }),
    }
  )
  if (!res.ok) throw new Error(`PATCH progress failed: ${res.status} ${res.statusText}`)
}

// --- Test suite ---

describe('updateProgress integration', () => {
  const processId = process.env.EVAL_PROCESS_ID || process.env.EVAL_CAMPAIGN_ID
  const supabaseUrl = process.env.SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY

  const skipIfNoDb = !processId || !supabaseUrl || !supabaseKey

  let originalProgress: number | null = null
  let workspaceDir: string

  beforeAll(async () => {
    if (skipIfNoDb) return
    originalProgress = await getProcessProgress(processId!)
  })

  afterAll(async () => {
    if (skipIfNoDb) return
    await setProcessProgress(processId!, originalProgress)
    if (workspaceDir) {
      rmSync(workspaceDir, { recursive: true, force: true })
    }
  })

  it('writes progress=0.4 to DB when stories_passed=[1,2] and 5 total stories', async () => {
    if (skipIfNoDb) {
      console.log('Skipping: no DB connection configured')
      return
    }

    // Create temp workspace
    workspaceDir = join(tmpdir(), `updateProgress-test-${Date.now()}`)
    mkdirSync(workspaceDir, { recursive: true })

    // Write state.json: active_prd + 2 stories passed
    writeFileSync(
      join(workspaceDir, 'state.json'),
      JSON.stringify({
        active_prd: 'prd-test',
        prds: {
          'prd-test': {
            stories_passed: [1, 2],
          },
        },
      })
    )

    // Write prd-test.json: 5 total stories
    writeFileSync(
      join(workspaceDir, 'prd-test.json'),
      JSON.stringify({
        stories: [1, 2, 3, 4, 5],
      })
    )

    // Call the real updateProgress — no mocking of adapter or DB
    await updateProgress(workspaceDir)

    // Query DB directly
    const progress = await getProcessProgress(processId!)

    expect(progress).toBeCloseTo(0.4, 5)
  })
})
