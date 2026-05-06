/**
 * Tests for parseLaunchArgs — the arg parser extracted from launch.ts main().
 * Verifies correct handling of boolean flags (--pr, --no-pr) and value flags.
 */

import { vi, describe, it, expect } from 'vitest'

// Mock child_process so importing launch.ts doesn't try to spawn anything
vi.mock('child_process')
vi.mock('fs')

const launchModule = await import('../launch.js')
const parseLaunchArgs = (launchModule as Record<string, unknown>)['parseLaunchArgs']

function assertParseLaunchArgsExists(fn: unknown): asserts fn is (args: string[]) => Record<string, string | boolean> {
  if (typeof fn !== 'function') {
    throw new Error(
      `parseLaunchArgs is not exported from launch.ts — expected a function, got ${typeof fn}. ` +
      `Bug A: main() arg parser does not handle boolean flags and parseLaunchArgs is not exposed.`
    )
  }
}

describe('parseLaunchArgs — boolean flag --pr', () => {
  it('parseLaunchArgs is exported from launch.ts', () => {
    assertParseLaunchArgsExists(parseLaunchArgs)
  })

  it('parses --pr as boolean true when it is the only flag', () => {
    assertParseLaunchArgsExists(parseLaunchArgs)

    const result = parseLaunchArgs(['--pr'])
    expect(result['pr']).toBe(true)
  })

  it('parses --pr as boolean true when mixed with value flags', () => {
    assertParseLaunchArgsExists(parseLaunchArgs)

    const result = parseLaunchArgs([
      '--slug', 'my-slug',
      '--worktree', '/tmp/wt',
      '--process-id', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      '--pr',
    ])
    expect(result['pr']).toBe(true)
  })

  it('does not consume the next positional arg as the value of --pr', () => {
    assertParseLaunchArgsExists(parseLaunchArgs)

    const result = parseLaunchArgs([
      '--pr',
      '--slug', 'my-slug',
    ])
    expect(result['pr']).toBe(true)
    expect(result['slug']).toBe('my-slug')
  })

  it('pr defaults to false (or undefined) when --pr is not passed', () => {
    assertParseLaunchArgsExists(parseLaunchArgs)

    const result = parseLaunchArgs([
      '--slug', 'my-slug',
      '--worktree', '/tmp/wt',
      '--process-id', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    ])
    expect(result['pr']).not.toBe(true)
  })

  it('parses --no-pr as boolean true (negation flag)', () => {
    assertParseLaunchArgsExists(parseLaunchArgs)

    const result = parseLaunchArgs(['--no-pr'])
    expect(result['no-pr']).toBe(true)
    expect(result['pr']).not.toBe(true)
  })

  it('does not consume the next arg as the value of --no-pr', () => {
    assertParseLaunchArgsExists(parseLaunchArgs)

    const result = parseLaunchArgs([
      '--no-pr',
      '--slug', 'my-slug',
    ])
    expect(result['no-pr']).toBe(true)
    expect(result['slug']).toBe('my-slug')
  })
})
