import { writeFileSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { StoryProgressAdapter } from '../adapters/progress-adapter.js'

describe('StoryProgressAdapter', () => {
  const testDir = join(tmpdir(), 'story-progress-adapter-test')
  let workspaceDir: string

  beforeEach(() => {
    workspaceDir = join(testDir, `run-${Date.now()}`)
    mkdirSync(workspaceDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  function writeState(state: object) {
    writeFileSync(join(workspaceDir, 'state.json'), JSON.stringify(state))
  }

  function writePrd(prdId: string, prd: object) {
    writeFileSync(join(workspaceDir, `${prdId}.json`), JSON.stringify(prd))
  }

  const adapter = new StoryProgressAdapter()

  it('returns 0.4 when 2 of 5 stories passed', () => {
    writeState({ active_prd: 'prd-001', prds: { 'prd-001': { stories_passed: [1, 2] } } })
    writePrd('prd-001', { stories: [1, 2, 3, 4, 5] })
    expect(adapter.calculateProgress(workspaceDir)).toBeCloseTo(0.4)
  })

  it('returns null if state.json is missing', () => {
    expect(adapter.calculateProgress(workspaceDir)).toBeNull()
  })

  it('returns null if state.json is malformed JSON', () => {
    writeFileSync(join(workspaceDir, 'state.json'), 'not valid json {{{')
    expect(adapter.calculateProgress(workspaceDir)).toBeNull()
  })

  it('returns null if stories array is empty', () => {
    writeState({ active_prd: 'prd-001', prds: { 'prd-001': { stories_passed: [] } } })
    writePrd('prd-001', { stories: [] })
    expect(adapter.calculateProgress(workspaceDir)).toBeNull()
  })

  it('returns null if active_prd is missing from state', () => {
    writeState({ prds: { 'prd-001': { stories_passed: [1] } } })
    writePrd('prd-001', { stories: [1, 2, 3] })
    expect(adapter.calculateProgress(workspaceDir)).toBeNull()
  })

  it('returns 0 when no stories passed yet', () => {
    writeState({ active_prd: 'prd-001', prds: { 'prd-001': { stories_passed: [] } } })
    writePrd('prd-001', { stories: [1, 2, 3, 4] })
    expect(adapter.calculateProgress(workspaceDir)).toBe(0)
  })

  it('returns 1.0 when all stories passed', () => {
    writeState({ active_prd: 'prd-002', prds: { 'prd-002': { stories_passed: [1, 2, 3] } } })
    writePrd('prd-002', { stories: [1, 2, 3] })
    expect(adapter.calculateProgress(workspaceDir)).toBe(1)
  })

  it('clamps to 1.0 when stories_passed exceeds total stories', () => {
    writeState({ active_prd: 'prd-001', prds: { 'prd-001': { stories_passed: [1, 2, 3, 4, 5] } } })
    writePrd('prd-001', { stories: [1, 2, 3] })
    expect(adapter.calculateProgress(workspaceDir)).toBe(1)
  })

  it('falls back to prds map when prd file does not exist', () => {
    writeState({
      active_prd: 'prd-001',
      prds: { 'prd-001': { stories: [1, 2, 3, 4], stories_passed: [1] } },
    })
    // No writePrd call — forces fallback path
    expect(adapter.calculateProgress(workspaceDir)).toBeCloseTo(0.25)
  })

  it('returns null for active_prd with path traversal characters', () => {
    writeState({ active_prd: '../../etc/passwd', prds: {} })
    expect(adapter.calculateProgress(workspaceDir)).toBeNull()
  })
})
