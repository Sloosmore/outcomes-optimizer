import { writeFileSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// Mock heavy dependencies so index.ts can be imported without real Supabase/agent-events calls
vi.mock('@skill-networks/agent-events', () => ({
  createEventService: vi.fn(() => null),
  createWatchdog: vi.fn(() => ({ stop: vi.fn() })),
  EventType: {
    PROCESS_START: 'process:start',
    PROCESS_END: 'process:end',
    PROCESS_SLEEP: 'process:sleep',
    PROCESS_STALE: 'process:stale',
    EPOCH_END: 'epoch:end',
    WORKTREE_PROVISIONED: 'worktree:provisioned',
  },
}))

vi.mock('../../run', () => ({
  run: vi.fn(),
}))

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return { ...actual, execFileSync: vi.fn(actual.execFileSync), execSync: actual.execSync }
})

import { checkAllStoriesPassed } from '../index.js'

describe('checkAllStoriesPassed', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = join(tmpdir(), `check-stories-test-${Date.now()}`)
    mkdirSync(tmpDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('Test A (positive): returns true when all stories have passes=true', () => {
    writeFileSync(
      join(tmpDir, 'state.json'),
      JSON.stringify({ active_prd: 'prd-001' }),
    )
    writeFileSync(
      join(tmpDir, 'prd-001.json'),
      JSON.stringify({ stories: [{ id: 1, passes: true }, { id: 2, passes: true }] }),
    )
    expect(checkAllStoriesPassed(tmpDir)).toBe(true)
  })

  it('Test B (negative — partial pass): returns false when one story has passes=false', () => {
    writeFileSync(
      join(tmpDir, 'state.json'),
      JSON.stringify({ active_prd: 'prd-001' }),
    )
    writeFileSync(
      join(tmpDir, 'prd-001.json'),
      JSON.stringify({ stories: [{ id: 1, passes: false }, { id: 2, passes: true }] }),
    )
    expect(checkAllStoriesPassed(tmpDir)).toBe(false)
  })

  it('Test C (negative — no state): returns false when state.json does not exist', () => {
    // No files created
    expect(checkAllStoriesPassed(tmpDir)).toBe(false)
  })

  it('Test D (negative — empty stories): returns false when stories array is empty', () => {
    writeFileSync(
      join(tmpDir, 'state.json'),
      JSON.stringify({ active_prd: 'prd-001' }),
    )
    writeFileSync(
      join(tmpDir, 'prd-001.json'),
      JSON.stringify({ stories: [] }),
    )
    expect(checkAllStoriesPassed(tmpDir)).toBe(false)
  })

  it('Test E (negative — truthy non-boolean): returns false when passes is "true" (string)', () => {
    writeFileSync(join(tmpDir, 'state.json'), JSON.stringify({ active_prd: 'prd-001' }))
    writeFileSync(join(tmpDir, 'prd-001.json'), JSON.stringify({ stories: [{ id: 1, passes: 'true' }] }))
    expect(checkAllStoriesPassed(tmpDir)).toBe(false)
  })

  it('Test F (negative — missing PRD file): returns false when PRD file does not exist', () => {
    writeFileSync(join(tmpDir, 'state.json'), JSON.stringify({ active_prd: 'prd-missing' }))
    // prd-missing.json not created
    expect(checkAllStoriesPassed(tmpDir)).toBe(false)
  })

  it('Test G (negative — malformed state.json): returns false without throwing', () => {
    writeFileSync(join(tmpDir, 'state.json'), '{not valid json')
    expect(() => checkAllStoriesPassed(tmpDir)).not.toThrow()
    expect(checkAllStoriesPassed(tmpDir)).toBe(false)
  })

  it('Test H (negative — missing stories field): returns false when PRD has no stories array', () => {
    writeFileSync(join(tmpDir, 'state.json'), JSON.stringify({ active_prd: 'prd-001' }))
    writeFileSync(join(tmpDir, 'prd-001.json'), JSON.stringify({ title: 'No stories field' }))
    expect(checkAllStoriesPassed(tmpDir)).toBe(false)
  })

  it('Test I (negative — story with no passes field): returns false when a story lacks passes', () => {
    writeFileSync(join(tmpDir, 'state.json'), JSON.stringify({ active_prd: 'prd-001' }))
    writeFileSync(join(tmpDir, 'prd-001.json'), JSON.stringify({ stories: [{ id: 1 }, { id: 2, passes: true }] }))
    expect(checkAllStoriesPassed(tmpDir)).toBe(false)
  })

  it('Test J (negative — path traversal): returns false for active_prd with path traversal characters', () => {
    writeFileSync(join(tmpDir, 'state.json'), JSON.stringify({ active_prd: '../etc/passwd' }))
    expect(checkAllStoriesPassed(tmpDir)).toBe(false)
  })
})
