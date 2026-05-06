import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Hoisted mock factories
// ---------------------------------------------------------------------------

const {
  mockListProjectsForUser,
  mockGetResourceById,
  mockGetResource,
  mockGetAdapter,
  mockRequireAuth,
  mockReadProject,
  mockWriteProject,
} = vi.hoisted(() => {
  const mockListProjectsForUser = vi.fn()
  const mockGetResourceById = vi.fn()
  const mockGetResource = vi.fn()
  const mockGetAdapter = vi.fn().mockReturnValue({
    listProjectsForUser: mockListProjectsForUser,
    getResourceById: mockGetResourceById,
    getResource: mockGetResource,
  })
  const mockRequireAuth = vi.fn()
  const mockReadProject = vi.fn()
  const mockWriteProject = vi.fn()

  return {
    mockListProjectsForUser,
    mockGetResourceById,
    mockGetResource,
    mockGetAdapter,
    mockRequireAuth,
    mockReadProject,
    mockWriteProject,
  }
})

vi.mock('@duoidal/agent-core', () => ({
  getAdapter: mockGetAdapter,
}))

vi.mock('../lib/require-auth.js', () => ({
  requireAuth: mockRequireAuth,
}))

vi.mock('../lib/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/config.js')>()
  return {
    ...actual,
    readProject: mockReadProject,
    writeProject: mockWriteProject,
  }
})

import { projectCommand } from '../commands/project.js'

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockListProjectsForUser.mockReset()
  mockGetResourceById.mockReset()
  mockGetResource.mockReset()
  mockGetAdapter.mockReturnValue({
    listProjectsForUser: mockListProjectsForUser,
    getResourceById: mockGetResourceById,
    getResource: mockGetResource,
  })
  mockRequireAuth.mockReset()
  mockReadProject.mockReset()
  mockWriteProject.mockReset()
})

afterEach(() => {
  vi.resetAllMocks()
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function runProject(args: string[]) {
  const cmd = projectCommand()
  cmd.exitOverride()
  for (const sub of cmd.commands) {
    sub.exitOverride()
  }
  return cmd.parseAsync(['node', 'duoidal', ...args])
}

// ---------------------------------------------------------------------------
// project list
// ---------------------------------------------------------------------------

describe('project list', () => {
  it('prints projects from listUserProjects with (current) marker', async () => {
    mockRequireAuth.mockReturnValue({ sub: '00000000-0000-4000-8000-000000000001', accessToken: 'tok', refreshToken: '' })
    mockListProjectsForUser.mockResolvedValue([
      { id: 'aaaaaaaa-0000-0000-0000-000000000001', name: 'alpha', created_at: '2024-01-01' },
      { id: 'aaaaaaaa-0000-0000-0000-000000000002', name: 'beta', created_at: '2024-01-02' },
    ])
    mockReadProject.mockReturnValue({ id: 'aaaaaaaa-0000-0000-0000-000000000001', name: 'alpha' })

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await runProject(['list'])

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('alpha'))
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('(current)'))
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('beta'))
    // beta should not have (current)
    const betaCall = consoleSpy.mock.calls.find(c => String(c[0]).includes('beta'))
    expect(betaCall?.[0]).not.toContain('(current)')
  })

  it('prints "No projects found." when empty', async () => {
    mockRequireAuth.mockReturnValue({ sub: '00000000-0000-4000-8000-000000000001', accessToken: 'tok', refreshToken: '' })
    mockListProjectsForUser.mockResolvedValue([])
    mockReadProject.mockReturnValue(null)

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await runProject(['list'])

    expect(consoleSpy).toHaveBeenCalledWith('No projects found.')
  })
})

// ---------------------------------------------------------------------------
// project set
// ---------------------------------------------------------------------------

describe('project set', () => {
  it('resolves by UUID via getResourceById and calls writeProject', async () => {
    const uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    mockRequireAuth.mockReturnValue({ sub: '00000000-0000-4000-8000-000000000001', accessToken: 'tok', refreshToken: '' })
    mockGetResourceById.mockResolvedValue({ id: uuid, name: 'my-project', type: 'project' })
    mockListProjectsForUser.mockResolvedValue([{ id: uuid, name: 'my-project', created_at: '2024-01-01' }])
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await runProject(['set', uuid])

    expect(mockGetResourceById).toHaveBeenCalledWith(uuid)
    expect(mockWriteProject).toHaveBeenCalledWith({ id: uuid, name: 'my-project' })
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('my-project'))
  })

  it('resolves by name via getResource and calls writeProject', async () => {
    const uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    mockRequireAuth.mockReturnValue({ sub: '00000000-0000-4000-8000-000000000001', accessToken: 'tok', refreshToken: '' })
    mockGetResource.mockResolvedValue({ id: uuid, name: 'my-project', type: 'project' })
    mockListProjectsForUser.mockResolvedValue([{ id: uuid, name: 'my-project', created_at: '2024-01-01' }])
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await runProject(['set', 'my-project'])

    expect(mockGetResource).toHaveBeenCalledWith('my-project')
    expect(mockWriteProject).toHaveBeenCalledWith({ id: uuid, name: 'my-project' })
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('my-project'))
  })

  it('exits 1 when caller is not a member of the project', async () => {
    const uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    mockRequireAuth.mockReturnValue({ sub: '00000000-0000-4000-8000-000000000004', accessToken: 'tok', refreshToken: '' })
    mockGetResourceById.mockResolvedValue({ id: uuid, name: 'other-project', type: 'project' })
    mockListProjectsForUser.mockResolvedValue([]) // not a member

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called')
    }) as (code?: string | number | null) => never)

    await expect(runProject(['set', uuid])).rejects.toThrow()

    expect(mockWriteProject).not.toHaveBeenCalled()
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('not a member'))
    expect(exitSpy).toHaveBeenCalledWith(1)
    exitSpy.mockRestore()
  })

  it('does not set a non-project resource by UUID', async () => {
    const uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    mockRequireAuth.mockReturnValue({ sub: '00000000-0000-4000-8000-000000000001', accessToken: 'tok', refreshToken: '' })
    mockGetResourceById.mockResolvedValue({ id: uuid, name: 'some-sandbox', type: 'sandbox' })

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called')
    }) as (code?: string | number | null) => never)

    await expect(runProject(['set', uuid])).rejects.toThrow()

    expect(mockWriteProject).not.toHaveBeenCalled()
    expect(exitSpy).toHaveBeenCalledWith(1)
    exitSpy.mockRestore()
  })

  it('exits 1 when project is not found by name', async () => {
    mockRequireAuth.mockReturnValue({ sub: '00000000-0000-4000-8000-000000000001', accessToken: 'tok', refreshToken: '' })
    mockGetResource.mockResolvedValue(null)

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called')
    }) as (code?: string | number | null) => never)

    await expect(runProject(['set', 'nonexistent-project'])).rejects.toThrow()

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('not found'))
    expect(exitSpy).toHaveBeenCalledWith(1)
    exitSpy.mockRestore()
  })

  it('exits 1 when project is not found by UUID', async () => {
    mockRequireAuth.mockReturnValue({ sub: '00000000-0000-4000-8000-000000000001', accessToken: 'tok', refreshToken: '' })
    mockGetResourceById.mockResolvedValue(null)
    const uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called')
    }) as (code?: string | number | null) => never)

    await expect(runProject(['set', uuid])).rejects.toThrow()

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('not found'))
    expect(exitSpy).toHaveBeenCalledWith(1)
    exitSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// project current
// ---------------------------------------------------------------------------

describe('project current', () => {
  it('reads from readProject when file exists', async () => {
    mockReadProject.mockReturnValue({ id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', name: 'my-project' })
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await runProject(['current'])

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('my-project'))
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'))
    // Should not call requireAuth since file exists
    expect(mockRequireAuth).not.toHaveBeenCalled()
  })

  it('outputs valid JSON with --json flag', async () => {
    const project = { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', name: 'my-project' }
    mockReadProject.mockReturnValue(project)

    let output = ''
    vi.spyOn(console, 'log').mockImplementation((msg: string) => { output = msg })

    await runProject(['current', '--json'])

    const parsed = JSON.parse(output)
    expect(parsed).toEqual(project)
  })

  it('falls back to DB when no file, writes project.json', async () => {
    mockReadProject.mockReturnValue(null)
    mockRequireAuth.mockReturnValue({ sub: '00000000-0000-4000-8000-000000000001', accessToken: 'tok', refreshToken: '' })
    const dbProject = { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', name: 'db-project', created_at: '2024-01-01' }
    mockListProjectsForUser.mockResolvedValue([dbProject])

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await runProject(['current'])

    expect(mockRequireAuth).toHaveBeenCalled()
    expect(mockListProjectsForUser).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000001')
    expect(mockWriteProject).toHaveBeenCalledWith({ id: dbProject.id, name: dbProject.name })
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('db-project'))
  })

  it('exits 1 when no file and requireAuth throws (no auth)', async () => {
    mockReadProject.mockReturnValue(null)
    // requireAuth throws — should be caught gracefully, then fall through to "No active project"
    mockRequireAuth.mockImplementation(() => {
      throw new Error('Not logged in')
    })

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called')
    }) as (code?: string | number | null) => never)

    await expect(runProject(['current'])).rejects.toThrow()

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('No active project'))
    expect(exitSpy).toHaveBeenCalledWith(1)
    exitSpy.mockRestore()
  })

  it('exits 1 when no file and DB returns empty list', async () => {
    mockReadProject.mockReturnValue(null)
    mockRequireAuth.mockReturnValue({ sub: '00000000-0000-4000-8000-000000000001', accessToken: 'tok', refreshToken: '' })
    mockListProjectsForUser.mockResolvedValue([])

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called')
    }) as (code?: string | number | null) => never)

    await expect(runProject(['current'])).rejects.toThrow()

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('No active project'))
    expect(exitSpy).toHaveBeenCalledWith(1)
    exitSpy.mockRestore()
  })
})
