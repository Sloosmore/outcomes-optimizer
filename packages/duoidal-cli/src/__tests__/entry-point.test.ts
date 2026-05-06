/**
 * Entry-point behaviour tests: ensure `--version`, `-V`, `--help`, and `-h` are
 * treated as inert Commander built-ins and never trigger an auth check.
 *
 * Regression coverage for the bug where `duoidal --version` exited 1 with
 * "Not authenticated. Run: duoidal auth login" on a machine with no
 * `~/.config/duoidal/token.json`. The startup path was calling
 * `initAdapter()` eagerly, which calls `process.exit(1)` on auth failure
 * before Commander had a chance to handle the info flag.
 *
 * These tests spawn the built CLI as a subprocess with an empty HOME so that
 * no token file exists, and assert that info flags still exit 0 while a real
 * command (e.g. `repo list`) still fails with the auth error.
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI_ENTRY = path.resolve(__dirname, '..', '..', 'dist', 'index.js')

// Empty HOME — guarantees no ~/.config/duoidal/token.json exists.
// Created once per test run; never written to.
const EMPTY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'duoidal-empty-home-'))

function runCli(args: string[]) {
  return spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    encoding: 'utf8',
    timeout: 15_000,
    env: {
      // Minimal env — strip DUOIDAL_TOKEN so the auth path is exercised.
      PATH: process.env.PATH,
      HOME: EMPTY_HOME,
    },
  })
}

describe('duoidal CLI entry point — info flags never require auth', () => {
  beforeAll(() => {
    if (!fs.existsSync(CLI_ENTRY)) {
      throw new Error(
        `CLI entry not built: ${CLI_ENTRY}\n` +
        `Run \`pnpm --filter @duoidal/cli build\` before running this test.`
      )
    }
  })

  it('--version exits 0 and prints a semver-like string with no token', () => {
    const result = runCli(['--version'])
    expect(result.status, `stderr: ${result.stderr}`).toBe(0)
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/)
    expect(result.stderr).not.toContain('Not authenticated')
    expect(result.stderr).not.toContain('Not logged in')
  })

  it('-V (version shortcut) exits 0 with no token', () => {
    const result = runCli(['-V'])
    expect(result.status, `stderr: ${result.stderr}`).toBe(0)
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/)
    expect(result.stderr).not.toContain('Not authenticated')
  })

  it('--help exits 0 with no token', () => {
    const result = runCli(['--help'])
    expect(result.status, `stderr: ${result.stderr}`).toBe(0)
    expect(result.stdout).toContain('Usage: duoidal')
    expect(result.stderr).not.toContain('Not authenticated')
  })

  it('-h exits 0 with no token', () => {
    const result = runCli(['-h'])
    expect(result.status, `stderr: ${result.stderr}`).toBe(0)
    expect(result.stdout).toContain('Usage: duoidal')
  })

  it('commands that require auth still fail without a token (guard check)', () => {
    // Sanity check: confirm the auth enforcement path is still intact for
    // real commands. Without this, the --version fix could accidentally
    // disable auth everywhere.
    const result = runCli(['repo', 'list'])
    expect(result.status).not.toBe(0)
    const combined = result.stdout + result.stderr
    expect(combined).toMatch(/Not (logged in|authenticated)/)
  })
})
