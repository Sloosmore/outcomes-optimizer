import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

// Hoist fake functions so they're available in vi.mock factories
const { fakeReadFileSync, fakeMkdirSync, fakeWriteFileSync, fakeRenameSync, realReadFileSync, realMkdirSync, realWriteFileSync, realRenameSync } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const realFs = require('node:fs') as typeof import('node:fs')
  const realReadFileSync = realFs.readFileSync.bind(realFs)
  const realMkdirSync = realFs.mkdirSync.bind(realFs)
  const realWriteFileSync = realFs.writeFileSync.bind(realFs)
  const realRenameSync = realFs.renameSync.bind(realFs)
  return {
    fakeReadFileSync: vi.fn((...args: Parameters<typeof realFs.readFileSync>) => realReadFileSync(...(args as Parameters<typeof realFs.readFileSync>))),
    fakeMkdirSync: vi.fn((...args: Parameters<typeof realFs.mkdirSync>) => realMkdirSync(...(args as Parameters<typeof realFs.mkdirSync>))),
    fakeWriteFileSync: vi.fn((...args: Parameters<typeof realFs.writeFileSync>) => realWriteFileSync(...(args as Parameters<typeof realFs.writeFileSync>))),
    fakeRenameSync: vi.fn((...args: Parameters<typeof realFs.renameSync>) => realRenameSync(...(args as Parameters<typeof realFs.renameSync>))),
    realReadFileSync,
    realMkdirSync,
    realWriteFileSync,
    realRenameSync,
  }
})

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    default: {
      ...actual,
      readFileSync: fakeReadFileSync,
      mkdirSync: fakeMkdirSync,
      writeFileSync: fakeWriteFileSync,
      renameSync: fakeRenameSync,
    },
    readFileSync: fakeReadFileSync,
    mkdirSync: fakeMkdirSync,
    writeFileSync: fakeWriteFileSync,
    renameSync: fakeRenameSync,
  }
})

import { readProject, writeProject, PROJECT_PATH } from '../lib/config.js'

const FAKE_PROJECT_PATH = PROJECT_PATH

beforeEach(() => {
  fakeReadFileSync.mockReset()
  fakeMkdirSync.mockReset()
  fakeWriteFileSync.mockReset()
  fakeRenameSync.mockReset()

  // Default: pass through to real fs for reads, no-op for writes
  fakeReadFileSync.mockImplementation((...args) => realReadFileSync(...(args as Parameters<typeof realReadFileSync>)))
  fakeMkdirSync.mockReturnValue(undefined)
  fakeWriteFileSync.mockReturnValue(undefined)
  fakeRenameSync.mockReturnValue(undefined)
})

afterEach(() => {
  // Restore real fs so other tests are not affected
  fakeReadFileSync.mockImplementation((...args) => realReadFileSync(...(args as Parameters<typeof realReadFileSync>)))
  fakeMkdirSync.mockImplementation((...args) => realMkdirSync(...(args as Parameters<typeof realMkdirSync>)))
  fakeWriteFileSync.mockImplementation((...args) => realWriteFileSync(...(args as Parameters<typeof realWriteFileSync>)))
  fakeRenameSync.mockImplementation((...args) => realRenameSync(...(args as Parameters<typeof realRenameSync>)))
  vi.restoreAllMocks()
})

// ── readProject ───────────────────────────────────────────────────────────────

describe('readProject()', () => {
  it('returns null when project.json does not exist', () => {
    fakeReadFileSync.mockImplementation((filePath: unknown) => {
      if (filePath === FAKE_PROJECT_PATH) {
        throw Object.assign(new Error(`ENOENT: no such file: ${String(filePath)}`), { code: 'ENOENT' })
      }
      return realReadFileSync(filePath as Parameters<typeof realReadFileSync>[0])
    })

    const result = readProject()
    expect(result).toBeNull()
  })

  it('returns parsed StoredProject when file exists with valid content', () => {
    const stored = { name: 'my-project', id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }
    fakeReadFileSync.mockImplementation((filePath: unknown) => {
      if (filePath === FAKE_PROJECT_PATH) {
        return JSON.stringify(stored)
      }
      return realReadFileSync(filePath as Parameters<typeof realReadFileSync>[0])
    })

    const result = readProject()
    expect(result).toEqual(stored)
  })

  it('returns null when file exists but has invalid JSON', () => {
    fakeReadFileSync.mockImplementation((filePath: unknown) => {
      if (filePath === FAKE_PROJECT_PATH) {
        return 'not valid json {'
      }
      return realReadFileSync(filePath as Parameters<typeof realReadFileSync>[0])
    })

    const result = readProject()
    expect(result).toBeNull()
  })
})

// ── writeProject ──────────────────────────────────────────────────────────────

describe('writeProject()', () => {
  it('creates the file with mode 0600', () => {
    const project = { name: 'test-project', id: '11111111-2222-3333-4444-555555555555' }

    writeProject(project)

    expect(fakeWriteFileSync).toHaveBeenCalledWith(
      FAKE_PROJECT_PATH + '.tmp',
      expect.stringContaining(project.id),
      expect.objectContaining({ mode: 0o600 })
    )
  })

  it('uses atomic write via temp file + rename', () => {
    const project = { name: 'atomic-project', id: 'ffffffff-eeee-dddd-cccc-bbbbbbbbbbbb' }

    writeProject(project)

    // Must write to .tmp first, then rename to final path
    expect(fakeWriteFileSync).toHaveBeenCalledWith(
      FAKE_PROJECT_PATH + '.tmp',
      expect.any(String),
      expect.any(Object)
    )
    expect(fakeRenameSync).toHaveBeenCalledWith(FAKE_PROJECT_PATH + '.tmp', FAKE_PROJECT_PATH)

    // Verify rename happens after write
    const writeOrder = fakeWriteFileSync.mock.invocationCallOrder[0]
    const renameOrder = fakeRenameSync.mock.invocationCallOrder[0]
    expect(writeOrder).toBeLessThan(renameOrder)
  })

  it('creates the config directory with mode 0700', () => {
    const project = { name: 'dir-project', id: 'cccccccc-dddd-eeee-ffff-000000000000' }

    writeProject(project)

    expect(fakeMkdirSync).toHaveBeenCalledWith(
      path.dirname(FAKE_PROJECT_PATH),
      expect.objectContaining({ recursive: true, mode: 0o700 })
    )
  })
})
