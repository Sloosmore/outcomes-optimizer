import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('dotenv/config', () => ({}))

// Build a tagged-template mock that also supports .array()
function makeSqlMock(impl: (...args: unknown[]) => unknown) {
  const fn = vi.fn(impl) as unknown as {
    (...args: unknown[]): unknown
    array: (v: unknown[]) => unknown[]
  }
  fn.array = (v: unknown[]) => v
  return fn
}

let sqlMock = makeSqlMock(() => Promise.resolve([]))

vi.mock('@skill-networks/database/client', () => ({
  getSqlClient: () => sqlMock,
}))

import { traverseCommand } from '../commands/traverse.js'

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

/** Parse the traverse command with the given argv and return captured output. */
async function runTraverse(args: string[]): Promise<{ logs: string[]; errors: string[]; exitCode: number | undefined }> {
  const logs: string[] = []
  const errors: string[] = []
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...a) => logs.push(a.join(' ')))
  const errSpy = vi.spyOn(console, 'error').mockImplementation((...a) => errors.push(a.join(' ')))
  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    const line = String(chunk)
    if (line.includes('[ERROR]') || line.includes('[WARN]')) errors.push(line)
    return true
  })
  process.exitCode = undefined

  const cmd = traverseCommand()
  // commander exits on error — suppress that for tests
  cmd.exitOverride()
  try {
    await cmd.parseAsync(args, { from: 'user' })
  } catch {
    // exitOverride throws on --help / validation errors; ignore
  }

  logSpy.mockRestore()
  errSpy.mockRestore()
  stdoutSpy.mockRestore()
  return { logs, errors, exitCode: process.exitCode }
}

// ──────────────────────────────────────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────────────────────────────────────

// Start resource row — includes type now that traverse.ts fetches it for rule check
const startRow = [{ id: 'id-A', type: 'skill' }]

// Rule check result: has matching rules (count > 0)
const ruleHit = [{ count: '1' }]

const simpleLinkRows = [
  { from_id: 'id-A', to_id: 'id-B' },
  { from_id: 'id-B', to_id: 'id-C' },
]

const nameRows = (map: Record<string, string>) =>
  Object.entries(map).map(([id, name]) => ({ id, name }))

// SQL call sequence:
// 1. SELECT id, type FROM resources WHERE name = ...  (start lookup)
// 2. SELECT COUNT(*) FROM link_type_rules WHERE ...   (rule check)
// 3. SELECT from_id, to_id FROM resource_links WHERE ... (edges)
// 4. SELECT id, name FROM resources WHERE id = ANY(...) (name lookup)
function makeBfsMock(edgeRows: unknown[], nameMap: Record<string, string>) {
  let call = 0
  return makeSqlMock(() => {
    call++
    if (call === 1) return Promise.resolve(startRow)          // start lookup
    if (call === 2) return Promise.resolve(ruleHit)           // rule check
    if (call === 3) return Promise.resolve(edgeRows)          // edges
    return Promise.resolve(nameRows(nameMap))                  // name lookup
  })
}

// ──────────────────────────────────────────────────────────────────────────────
// Input validation (fails before SQL calls — mocks not reached)
// ──────────────────────────────────────────────────────────────────────────────

describe('traverse — input validation', () => {
  beforeEach(() => {
    process.exitCode = undefined
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('rejects --direction other than "in" or "out"', async () => {
    sqlMock = makeSqlMock(() => Promise.resolve(startRow))
    const { errors, exitCode } = await runTraverse(['--from', 'A', '--via', 'dependsOn', '--direction', 'sideways'])
    expect(errors.join('\n')).toMatch(/direction.*"in" or "out"/i)
    expect(exitCode).toBe(1)
  })

  it('rejects --depth 0 (must be >= 1)', async () => {
    sqlMock = makeSqlMock(() => Promise.resolve(startRow))
    const { errors, exitCode } = await runTraverse(['--from', 'A', '--via', 'dependsOn', '--depth', '0'])
    expect(errors.join('\n')).toMatch(/depth.*positive integer/i)
    expect(exitCode).toBe(1)
  })

  it('rejects --depth that exceeds MAX_DEPTH (20)', async () => {
    sqlMock = makeSqlMock(() => Promise.resolve(startRow))
    const { errors, exitCode } = await runTraverse(['--from', 'A', '--via', 'dependsOn', '--depth', '21'])
    expect(errors.join('\n')).toMatch(/depth cannot exceed 20/i)
    expect(exitCode).toBe(1)
  })

  it('rejects non-numeric --depth', async () => {
    sqlMock = makeSqlMock(() => Promise.resolve(startRow))
    const { errors, exitCode } = await runTraverse(['--from', 'A', '--via', 'dependsOn', '--depth', 'abc'])
    expect(errors.join('\n')).toMatch(/depth.*positive integer/i)
    expect(exitCode).toBe(1)
  })

  it('rejects --depth with trailing non-digits (e.g. "3abc")', async () => {
    sqlMock = makeSqlMock(() => Promise.resolve(startRow))
    const { errors, exitCode } = await runTraverse(['--from', 'A', '--via', 'dependsOn', '--depth', '3abc'])
    expect(errors.join('\n')).toMatch(/depth.*positive integer/i)
    expect(exitCode).toBe(1)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Resource lookup
// ──────────────────────────────────────────────────────────────────────────────

describe('traverse — resource lookup', () => {
  afterEach(() => vi.restoreAllMocks())

  it('errors when start resource is not found', async () => {
    sqlMock = makeSqlMock(() => Promise.resolve([]))
    const { errors, exitCode } = await runTraverse(['--from', 'nonexistent', '--via', 'dependsOn'])
    expect(errors.join('\n')).toMatch(/Resource not found: nonexistent/i)
    expect(exitCode).toBe(1)
  })

  it('errors when multiple resources share the same name', async () => {
    sqlMock = makeSqlMock(() => Promise.resolve([{ id: 'id-1', type: 'skill' }, { id: 'id-2', type: 'skill' }]))
    const { errors, exitCode } = await runTraverse(['--from', 'A', '--via', 'dependsOn'])
    expect(errors.join('\n')).toMatch(/Multiple resources named "A"/i)
    expect(exitCode).toBe(1)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// BFS — direction out
// ──────────────────────────────────────────────────────────────────────────────

describe('traverse — BFS direction=out', () => {
  afterEach(() => vi.restoreAllMocks())

  it('returns direct neighbors at depth=1', async () => {
    sqlMock = makeBfsMock(
      [{ from_id: 'id-A', to_id: 'id-B' }, { from_id: 'id-A', to_id: 'id-C' }],
      { 'id-B': 'B', 'id-C': 'C' }
    )
    const { logs, exitCode } = await runTraverse(['--from', 'A', '--via', 'dependsOn', '--depth', '1'])
    expect(exitCode).toBeUndefined()
    expect(logs).toContain('B')
    expect(logs).toContain('C')
  })

  it('traverses multiple hops at default depth', async () => {
    sqlMock = makeBfsMock(simpleLinkRows, { 'id-B': 'B', 'id-C': 'C' })
    const { logs, exitCode } = await runTraverse(['--from', 'A', '--via', 'dependsOn'])
    expect(exitCode).toBeUndefined()
    expect(logs).toContain('B')
    expect(logs).toContain('C')
  })

  it('stops at specified depth (does not traverse beyond)', async () => {
    let call = 0
    sqlMock = makeSqlMock(() => {
      call++
      if (call === 1) return Promise.resolve(startRow)
      if (call === 2) return Promise.resolve(ruleHit)
      if (call === 3) return Promise.resolve([
        { from_id: 'id-A', to_id: 'id-B' },
        { from_id: 'id-B', to_id: 'id-C' }, // hop 2 — should not be reached at depth=1
      ])
      // Name lookup — only B discovered at depth=1
      return Promise.resolve(nameRows({ 'id-B': 'B' }))
    })
    const { logs, exitCode } = await runTraverse(['--from', 'A', '--via', 'dependsOn', '--depth', '1'])
    expect(exitCode).toBeUndefined()
    expect(logs).toContain('B')
    expect(logs).not.toContain('C')
  })

  it('handles cycles without infinite loop', async () => {
    sqlMock = makeBfsMock(
      [{ from_id: 'id-A', to_id: 'id-B' }, { from_id: 'id-B', to_id: 'id-A' }],
      { 'id-B': 'B' }
    )
    const { logs, exitCode } = await runTraverse(['--from', 'A', '--via', 'dependsOn'])
    expect(exitCode).toBeUndefined()
    expect(logs).toContain('B')
    expect(logs).not.toContain('A') // start node excluded from results
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// BFS — direction in
// ──────────────────────────────────────────────────────────────────────────────

describe('traverse — BFS direction=in', () => {
  afterEach(() => vi.restoreAllMocks())

  it('returns consumers (reversed edges)', async () => {
    let call = 0
    sqlMock = makeSqlMock(() => {
      call++
      if (call === 1) return Promise.resolve([{ id: 'id-C', type: 'skill' }]) // start = C
      if (call === 2) return Promise.resolve(ruleHit)
      if (call === 3) return Promise.resolve([
        { from_id: 'id-A', to_id: 'id-C' }, // A depends on C
        { from_id: 'id-B', to_id: 'id-C' }, // B depends on C
      ])
      return Promise.resolve(nameRows({ 'id-A': 'A', 'id-B': 'B' }))
    })
    const { logs, exitCode } = await runTraverse(['--from', 'C', '--via', 'dependsOn', '--direction', 'in'])
    expect(exitCode).toBeUndefined()
    expect(logs).toContain('A')
    expect(logs).toContain('B')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Rule check warning
// ──────────────────────────────────────────────────────────────────────────────

describe('traverse — rule check warning', () => {
  afterEach(() => vi.restoreAllMocks())

  it('prints a warning when no link_type_rules match start node type', async () => {
    let call = 0
    sqlMock = makeSqlMock(() => {
      call++
      if (call === 1) return Promise.resolve([{ id: 'id-A', type: 'package' }])
      if (call === 2) return Promise.resolve([{ count: '0' }]) // no matching rules
      return Promise.resolve([]) // no edges
    })
    const { errors } = await runTraverse(['--from', 'A', '--via', 'traverses'])
    expect(errors.join('\n')).toMatch(/traverses.*from_type="package"/)
  })

  it('does not warn when matching rules exist', async () => {
    sqlMock = makeBfsMock([], {})
    const { errors } = await runTraverse(['--from', 'A', '--via', 'dependsOn'])
    const warnings = errors.filter(e => e.includes('Warning'))
    expect(warnings).toHaveLength(0)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Empty results
// ──────────────────────────────────────────────────────────────────────────────

describe('traverse — empty results', () => {
  afterEach(() => vi.restoreAllMocks())

  it('outputs "No resources found" when no reachable nodes (text mode)', async () => {
    let call = 0
    sqlMock = makeSqlMock(() => {
      call++
      if (call === 1) return Promise.resolve(startRow)
      if (call === 2) return Promise.resolve(ruleHit)
      return Promise.resolve([]) // no links
    })
    const { logs, exitCode } = await runTraverse(['--from', 'A', '--via', 'dependsOn'])
    expect(exitCode).toBeUndefined()
    expect(logs.join('\n')).toContain('No resources found')
  })

  it('outputs "[]" when no reachable nodes (JSON mode)', async () => {
    let call = 0
    sqlMock = makeSqlMock(() => {
      call++
      if (call === 1) return Promise.resolve(startRow)
      if (call === 2) return Promise.resolve(ruleHit)
      return Promise.resolve([]) // no links
    })
    const { logs, exitCode } = await runTraverse(['--from', 'A', '--via', 'dependsOn', '--json'])
    expect(exitCode).toBeUndefined()
    expect(JSON.parse(logs[0])).toEqual([])
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// JSON output
// ──────────────────────────────────────────────────────────────────────────────

describe('traverse — JSON output', () => {
  afterEach(() => vi.restoreAllMocks())

  it('outputs sorted JSON array of names', async () => {
    // Provide names in reverse order to confirm sorting
    sqlMock = makeBfsMock(
      [{ from_id: 'id-A', to_id: 'id-B' }, { from_id: 'id-A', to_id: 'id-C' }],
      { 'id-C': 'C', 'id-B': 'B' } // reversed to prove sort is applied
    )
    const { logs, exitCode } = await runTraverse(['--from', 'A', '--via', 'dependsOn', '--json'])
    expect(exitCode).toBeUndefined()
    expect(JSON.parse(logs[0])).toEqual(['B', 'C'])
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Row limit guard
// ──────────────────────────────────────────────────────────────────────────────

describe('traverse — row limit', () => {
  afterEach(() => vi.restoreAllMocks())

  it('errors when edge count exceeds MAX_LINKS', async () => {
    // Return 100_001 rows to trigger the limit
    const tooManyRows = Array.from({ length: 100_001 }, (_, i) => ({
      from_id: `id-${i}`,
      to_id: `id-${i + 1}`,
    }))
    let call = 0
    sqlMock = makeSqlMock(() => {
      call++
      if (call === 1) return Promise.resolve(startRow)
      if (call === 2) return Promise.resolve(ruleHit)
      return Promise.resolve(tooManyRows)
    })
    const { errors, exitCode } = await runTraverse(['--from', 'node-0', '--via', 'dependsOn'])
    expect(errors.join('\n')).toMatch(/more than 100000 active edges/i)
    expect(exitCode).toBe(1)
  })
})
