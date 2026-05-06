/**
 * Tests for goal-upload pr configurability and execute command --pr/--no-pr flags.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// ---------------------------------------------------------------------------
// Top-level mocks (hoisted before imports)
// ---------------------------------------------------------------------------

// Mock adapter-factory so addResource calls are captured without hitting the DB
vi.mock('../lib/adapter-factory.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/adapter-factory.js')>()
  return {
    ...actual,
    getAdapter: vi.fn(),
  }
})

// Mock node:child_process so tmux doesn't actually launch during execute tests
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    execFileSync: vi.fn(),
    spawnSync: vi.fn(() => ({ status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') })),
  }
})

// ---------------------------------------------------------------------------
// Imports (after vi.mock declarations)
// ---------------------------------------------------------------------------

import { goalUpload } from '../lib/goal-upload.js'
import * as adapterFactory from '../lib/adapter-factory.js'
import { executeCommand } from '../commands/execute.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MOCK_RESOURCE_ID = 'aaaabbbb-cccc-dddd-eeee-ffffffffffff'

function makeMockAdapter() {
  return {
    addResource: vi.fn().mockResolvedValue({
      id: MOCK_RESOURCE_ID,
      name: 'skill/test',
      type: 'skill',
    }),
    createResourceLink: vi.fn(),
    createResourceLinkById: vi.fn(),
    listProjectsForUser: vi.fn(),
  }
}

let tmpDir: string
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'execute-flags-test-'))
})
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  vi.resetAllMocks()
})

function writeGoal(filename: string, content: string): string {
  const p = path.join(tmpDir, filename)
  fs.writeFileSync(p, content, 'utf-8')
  return p
}

describe('goalUpload pr configurability', () => {
  it('does NOT forward pr: true to addResource when called without a pr option', async () => {
    const mockAdapter = makeMockAdapter()
    vi.mocked(adapterFactory.getAdapter).mockReturnValue(mockAdapter as never)

    const goalPath = writeGoal('goal.md', '# Goal: My Feature\nSome description')

    await goalUpload(goalPath)

    expect(mockAdapter.addResource).toHaveBeenCalledOnce()
    const callArgs = mockAdapter.addResource.mock.calls[0]
    const config = callArgs[2] as Record<string, unknown>

    expect(config['pr']).not.toBe(true)
  })

  it('does NOT include pr in the addResource config object at all by default', async () => {
    const mockAdapter = makeMockAdapter()
    vi.mocked(adapterFactory.getAdapter).mockReturnValue(mockAdapter as never)

    const goalPath = writeGoal('goal.md', '# Goal: Another Feature\nBody')

    await goalUpload(goalPath)

    expect(mockAdapter.addResource).toHaveBeenCalledOnce()
    const callArgs = mockAdapter.addResource.mock.calls[0]
    const config = callArgs[2] as Record<string, unknown>

    expect(Object.prototype.hasOwnProperty.call(config, 'pr')).toBe(false)
  })
})

describe('execute command --pr/--no-pr flags', () => {
  it('executeCommand help text includes --pr as a standalone flag', () => {
    // Use regex to match '--pr' as its own flag, not as a substring of --project-id
    const cmd = executeCommand()
    const help = cmd.helpInformation()

    expect(help).toMatch(/--pr[\s,]/)
  })

  it('executeCommand help text includes --no-pr flag', () => {
    const cmd = executeCommand()
    const help = cmd.helpInformation()

    expect(help).toContain('--no-pr')
  })
})
