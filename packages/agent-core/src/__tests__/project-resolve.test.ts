import { describe, it, expect, afterEach, vi } from 'vitest'

// Top-level mocks — hoisted before imports, so no variable references allowed in factory
vi.mock('../lib/adapter-factory.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/adapter-factory.js')>()
  return {
    ...actual,
    getAdapter: vi.fn(),
  }
})

vi.mock('../lib/identity.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/identity.js')>()
  return {
    ...actual,
    getLocalSubUnchecked: vi.fn(),
  }
})

import { projectResolve } from '../lib/project-resolve.js'
import * as adapterFactory from '../lib/adapter-factory.js'
import * as identity from '../lib/identity.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

afterEach(() => {
  vi.resetAllMocks()
})

function makeMockAdapter() {
  return {
    listProjectsForUser: vi.fn(),
  }
}

// ---------------------------------------------------------------------------
// 1. Happy path — returns UUID when projects list is non-empty
// ---------------------------------------------------------------------------

describe('projectResolve — happy path', () => {
  it('returns the first project ID when listProjectsForUser returns a non-empty list', async () => {
    vi.mocked(identity.getLocalSubUnchecked).mockReturnValue('576e0ff0-aef6-4d86-89c7-b0021d4650be')

    const mockAdapter = makeMockAdapter()
    mockAdapter.listProjectsForUser.mockResolvedValue([
      { id: 'aaaabbbb-cccc-dddd-eeee-ffffffffffff', name: 'Project Alpha', created_at: '2024-01-01T00:00:00Z' },
      { id: 'bbbbcccc-dddd-eeee-ffff-aaaaaaaaaaaa', name: 'Project Beta', created_at: '2024-01-02T00:00:00Z' },
    ])
    vi.mocked(adapterFactory.getAdapter).mockReturnValue(mockAdapter as never)

    const result = await projectResolve()

    expect(result).toBe('aaaabbbb-cccc-dddd-eeee-ffffffffffff')
    expect(mockAdapter.listProjectsForUser).toHaveBeenCalledOnce()
    expect(mockAdapter.listProjectsForUser).toHaveBeenCalledWith('576e0ff0-aef6-4d86-89c7-b0021d4650be')
  })
})

// ---------------------------------------------------------------------------
// 2. Empty list — returns null when projects list is empty
// ---------------------------------------------------------------------------

describe('projectResolve — empty list', () => {
  it('returns null when listProjectsForUser returns an empty array', async () => {
    vi.mocked(identity.getLocalSubUnchecked).mockReturnValue('576e0ff0-aef6-4d86-89c7-b0021d4650be')

    const mockAdapter = makeMockAdapter()
    mockAdapter.listProjectsForUser.mockResolvedValue([])
    vi.mocked(adapterFactory.getAdapter).mockReturnValue(mockAdapter as never)

    const result = await projectResolve()

    expect(result).toBeNull()
    expect(mockAdapter.listProjectsForUser).toHaveBeenCalledOnce()
  })
})

// ---------------------------------------------------------------------------
// 3. No sub — returns null when getLocalSubUnchecked returns null
// ---------------------------------------------------------------------------

describe('projectResolve — no sub', () => {
  it('returns null when getLocalSubUnchecked returns null', async () => {
    vi.mocked(identity.getLocalSubUnchecked).mockReturnValue(null)

    const mockAdapter = makeMockAdapter()
    vi.mocked(adapterFactory.getAdapter).mockReturnValue(mockAdapter as never)

    const result = await projectResolve()

    expect(result).toBeNull()
  })

  it('does NOT call the adapter when sub is null (short-circuit)', async () => {
    vi.mocked(identity.getLocalSubUnchecked).mockReturnValue(null)

    const mockAdapter = makeMockAdapter()
    vi.mocked(adapterFactory.getAdapter).mockReturnValue(mockAdapter as never)

    await projectResolve()

    expect(mockAdapter.listProjectsForUser).not.toHaveBeenCalled()
  })
})
