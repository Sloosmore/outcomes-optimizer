/**
 * Tests for the standalone teardown CLI logic.
 *
 * Tests call runTeardown() directly — no child_process spawning.
 * Provisioner teardown functions are mocked.
 */

import * as fs from 'fs'
import * as path from 'path'
import { tmpdir } from 'os'

// Mock provisioner modules before importing the module under test
vi.mock('../provisioners/worktree.js', () => ({
  teardown: vi.fn().mockResolvedValue(undefined),
  provision: vi.fn().mockResolvedValue(undefined),
  worktreeProvisioner: { name: 'worktree', provision: vi.fn(), teardown: vi.fn() },
  default: { name: 'worktree', provision: vi.fn(), teardown: vi.fn() },
}))

vi.mock('../provisioners/compose.js', () => ({
  teardown: vi.fn().mockResolvedValue(undefined),
  provision: vi.fn().mockResolvedValue(undefined),
  composeProvisioner: { name: 'compose', provision: vi.fn(), teardown: vi.fn() },
  default: { name: 'compose', provision: vi.fn(), teardown: vi.fn() },
}))

import { runTeardown } from '../teardown.js'
import { teardown as worktreeTeardown } from '../provisioners/worktree.js'
import { teardown as composeTeardown } from '../provisioners/compose.js'

const mockedWorktreeTeardown = vi.mocked(worktreeTeardown)
const mockedComposeTeardown = vi.mocked(composeTeardown)

describe('teardown CLI — runTeardown()', () => {
  let testDir: string

  beforeEach(() => {
    vi.clearAllMocks()
    testDir = fs.mkdtempSync(path.join(tmpdir(), 'teardown-test-'))
  })

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true })
  })

  describe('ctx reconstruction', () => {
    it('reads .env from --worktree and populates ctx fields', async () => {
      const envContent = [
        'WORKTREE_PATH="/some/path"',
        'DATABASE_URL="postgres://localhost/test"',
      ].join('\n') + '\n'
      fs.writeFileSync(path.join(testDir, '.env'), envContent)

      const result = await runTeardown([
        '--slug', 'test-slug',
        '--worktree', testDir,
        '--provision', 'worktree',
      ])

      expect(result.exitCode).toBe(0)
      expect(mockedWorktreeTeardown).toHaveBeenCalledOnce()

      const ctx = mockedWorktreeTeardown.mock.calls[0][0]
      expect(ctx.getEnv('DATABASE_URL')).toBe('postgres://localhost/test')
      expect(ctx.worktreePath).toBe('/some/path')
    })
  })

  describe('fault isolation', () => {
    it('provisioner throws, exits 0 (errors are swallowed)', async () => {
      fs.writeFileSync(path.join(testDir, '.env'), 'WORKTREE_PATH="/some/path"\n')

      mockedWorktreeTeardown.mockRejectedValueOnce(new Error('teardown exploded'))

      const result = await runTeardown([
        '--slug', 'test-slug',
        '--worktree', testDir,
        '--provision', 'worktree',
      ])

      expect(result.exitCode).toBe(0)
      expect(mockedWorktreeTeardown).toHaveBeenCalledOnce()
    })
  })

  describe('missing slug', () => {
    it('exits 1 with usage message when --slug is missing', async () => {
      const result = await runTeardown([
        '--worktree', testDir,
        '--provision', 'worktree',
      ])

      expect(result.exitCode).toBe(1)
      expect(result.stderr).toMatch(/--slug/i)
    })
  })

  describe('missing .env', () => {
    it('exits 0 with warning when .env file does not exist', async () => {
      const emptyDir = fs.mkdtempSync(path.join(tmpdir(), 'teardown-noenv-'))

      const result = await runTeardown([
        '--slug', 'test-slug',
        '--worktree', emptyDir,
        '--provision', 'worktree',
      ])

      expect(result.exitCode).toBe(0)
      expect(result.stderr).toMatch(/\.env/i)
      // Should still call teardown with empty ctx
      expect(mockedWorktreeTeardown).toHaveBeenCalledOnce()

      fs.rmSync(emptyDir, { recursive: true, force: true })
    })
  })

  describe('unknown provisioner', () => {
    it('exits 1 when an unknown provisioner name is given', async () => {
      const result = await runTeardown([
        '--slug', 'test-slug',
        '--worktree', testDir,
        '--provision', 'nonexistent-provisioner',
      ])

      expect(result.exitCode).toBe(1)
      expect(result.stderr).toMatch(/unknown/i)
    })
  })

  describe('--help', () => {
    it('prints usage and exits 0', async () => {
      const result = await runTeardown(['--help'])

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toMatch(/usage/i)
    })
  })

  describe('worktree provisioner', () => {
    it('calls worktree teardown with the ctx and slug', async () => {
      const envContent = [
        'WORKTREE_PATH="/my/worktree"',
      ].join('\n') + '\n'
      fs.writeFileSync(path.join(testDir, '.env'), envContent)

      const result = await runTeardown([
        '--slug', 'my-slug',
        '--worktree', testDir,
        '--provision', 'worktree',
      ])

      expect(result.exitCode).toBe(0)
      expect(mockedWorktreeTeardown).toHaveBeenCalledWith(
        expect.objectContaining({ worktreePath: '/my/worktree' }),
        'my-slug',
      )
    })
  })

  describe('compose provisioner', () => {
    it('calls compose teardown with the ctx and slug', async () => {
      const envContent = [
        'WORKTREE_PATH="/my/worktree"',
      ].join('\n') + '\n'
      fs.writeFileSync(path.join(testDir, '.env'), envContent)

      const result = await runTeardown([
        '--slug', 'my-slug',
        '--worktree', testDir,
        '--provision', 'compose',
      ])

      expect(result.exitCode).toBe(0)
      expect(mockedComposeTeardown).toHaveBeenCalledWith(
        expect.objectContaining({ worktreePath: '/my/worktree' }),
        'my-slug',
      )
    })
  })
})
