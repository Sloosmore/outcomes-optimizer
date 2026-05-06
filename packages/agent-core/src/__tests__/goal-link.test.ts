import { describe, it, expect, afterEach, vi } from 'vitest'

// Top-level mock — hoisted before imports, so no variable references allowed in factory
vi.mock('../lib/adapter-factory.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/adapter-factory.js')>()
  return {
    ...actual,
    getAdapter: vi.fn(),
  }
})

import { goalLink } from '../lib/goal-link.js'
import * as adapterFactory from '../lib/adapter-factory.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

afterEach(() => {
  vi.resetAllMocks()
})

function makeMockAdapter() {
  return {
    getResource: vi.fn(),
    createResourceLinkById: vi.fn().mockResolvedValue({ link: {}, created: true }),
  }
}

// ---------------------------------------------------------------------------
// 1. Basic happy path
// ---------------------------------------------------------------------------

describe('goalLink — happy path', () => {
  it('calls createResourceLinkById with correct arguments derived from getResource', async () => {
    const mockAdapter = makeMockAdapter()
    mockAdapter.getResource.mockResolvedValue({
      id: 'agent-uuid-1234',
      name: 'agent-efficiency',
      type: 'agent',
    })
    vi.mocked(adapterFactory.getAdapter).mockReturnValue(mockAdapter as never)

    await goalLink('some-skill-uuid', 'agent-efficiency')

    expect(mockAdapter.getResource).toHaveBeenCalledOnce()
    expect(mockAdapter.getResource).toHaveBeenCalledWith('agent-efficiency')

    expect(mockAdapter.createResourceLinkById).toHaveBeenCalledOnce()
    expect(mockAdapter.createResourceLinkById).toHaveBeenCalledWith(
      'agent-uuid-1234',
      'some-skill-uuid',
      'runs'
    )
  })
})

// ---------------------------------------------------------------------------
// 2. Throws if assignment resource not found (prefixed names, existing behaviour)
// ---------------------------------------------------------------------------

describe('goalLink — assignment resource not found (prefixed)', () => {
  it('throws with the assignment name in the error message when getResource returns null for a prefixed name', async () => {
    const mockAdapter = makeMockAdapter()
    mockAdapter.getResource.mockResolvedValue(null)
    vi.mocked(adapterFactory.getAdapter).mockReturnValue(mockAdapter as never)

    await expect(goalLink('some-skill-uuid', 'user:nonexistent')).rejects.toThrow(
      'Assignment resource not found: user:nonexistent'
    )
  })

  it('does NOT call createResourceLinkById when prefixed getResource returns null', async () => {
    const mockAdapter = makeMockAdapter()
    mockAdapter.getResource.mockResolvedValue(null)
    vi.mocked(adapterFactory.getAdapter).mockReturnValue(mockAdapter as never)

    await expect(goalLink('some-skill-uuid', 'agent:nonexistent')).rejects.toThrow()

    expect(mockAdapter.createResourceLinkById).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// 3. No process creation
// ---------------------------------------------------------------------------

describe('goalLink — no process creation', () => {
  it('only calls link-related adapter methods (getResource + createResourceLinkById), no process methods', async () => {
    const mockAdapter = {
      ...makeMockAdapter(),
      initProcess: vi.fn(),
      createProcess: vi.fn(),
      addResource: vi.fn(),
    }
    mockAdapter.getResource.mockResolvedValue({
      id: 'agent-uuid-1234',
      name: 'agent-efficiency',
      type: 'agent',
    })
    vi.mocked(adapterFactory.getAdapter).mockReturnValue(mockAdapter as never)

    await goalLink('some-skill-uuid', 'agent-efficiency')

    expect(mockAdapter.initProcess).not.toHaveBeenCalled()
    expect(mockAdapter.createProcess).not.toHaveBeenCalled()
    expect(mockAdapter.addResource).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// 4. Bare name prefix resolution
// ---------------------------------------------------------------------------

describe('goalLink — bare name prefix resolution', () => {
  it('resolves "stan" to "user:stan" when getResource("stan") is null but getResource("user:stan") returns a resource', async () => {
    const mockAdapter = makeMockAdapter()
    mockAdapter.getResource.mockImplementation(async (name: string) => {
      if (name === 'user:stan') {
        return { id: 'user-uuid-stan', name: 'user:stan', type: 'user' }
      }
      return null
    })
    vi.mocked(adapterFactory.getAdapter).mockReturnValue(mockAdapter as never)

    await goalLink('some-skill-uuid', 'stan')

    expect(mockAdapter.createResourceLinkById).toHaveBeenCalledOnce()
    expect(mockAdapter.createResourceLinkById).toHaveBeenCalledWith(
      'user-uuid-stan',
      'some-skill-uuid',
      'runs'
    )
  })

  it('resolves "bot" to "agent:bot" when getResource("bot") is null but getResource("agent:bot") returns a resource', async () => {
    const mockAdapter = makeMockAdapter()
    mockAdapter.getResource.mockImplementation(async (name: string) => {
      if (name === 'agent:bot') {
        return { id: 'agent-uuid-bot', name: 'agent:bot', type: 'agent' }
      }
      return null
    })
    vi.mocked(adapterFactory.getAdapter).mockReturnValue(mockAdapter as never)

    await goalLink('some-skill-uuid', 'bot')

    expect(mockAdapter.createResourceLinkById).toHaveBeenCalledOnce()
    expect(mockAdapter.createResourceLinkById).toHaveBeenCalledWith(
      'agent-uuid-bot',
      'some-skill-uuid',
      'runs'
    )
  })

  it('throws an ambiguous error when both user:X and agent:X exist for a bare name', async () => {
    const mockAdapter = makeMockAdapter()
    mockAdapter.getResource.mockImplementation(async (name: string) => {
      if (name === 'user:alex') {
        return { id: 'user-uuid-alex', name: 'user:alex', type: 'user' }
      }
      if (name === 'agent:alex') {
        return { id: 'agent-uuid-alex', name: 'agent:alex', type: 'agent' }
      }
      return null
    })
    vi.mocked(adapterFactory.getAdapter).mockReturnValue(mockAdapter as never)

    await expect(goalLink('some-skill-uuid', 'alex')).rejects.toThrow(
      "Ambiguous assignment 'alex': multiple resources found. Specify one explicitly: user:alex, agent:alex"
    )
    expect(mockAdapter.createResourceLinkById).not.toHaveBeenCalled()
  })

  it('throws an actionable not-found error when no prefix matches are found for a bare name', async () => {
    const mockAdapter = makeMockAdapter()
    mockAdapter.getResource.mockResolvedValue(null)
    vi.mocked(adapterFactory.getAdapter).mockReturnValue(mockAdapter as never)

    await expect(goalLink('some-skill-uuid', 'ghost')).rejects.toThrow(
      "Assignment resource not found: 'ghost'. Tried: user:ghost, agent:ghost. Use 'duoidal search ghost' to find the resource."
    )
    expect(mockAdapter.createResourceLinkById).not.toHaveBeenCalled()
  })

  it('does not attempt prefix resolution when assignment already contains a colon', async () => {
    const mockAdapter = makeMockAdapter()
    mockAdapter.getResource.mockImplementation(async (name: string) => {
      if (name === 'user:stan') {
        return { id: 'user-uuid-stan', name: 'user:stan', type: 'user' }
      }
      return null
    })
    vi.mocked(adapterFactory.getAdapter).mockReturnValue(mockAdapter as never)

    await goalLink('some-skill-uuid', 'user:stan')

    // Only one call — no prefix probing
    expect(mockAdapter.getResource).toHaveBeenCalledOnce()
    expect(mockAdapter.getResource).toHaveBeenCalledWith('user:stan')
    expect(mockAdapter.createResourceLinkById).toHaveBeenCalledWith(
      'user-uuid-stan',
      'some-skill-uuid',
      'runs'
    )
  })
})

// ---------------------------------------------------------------------------
// Integration tests (gated by RUN_INTEGRATION=true)
// ---------------------------------------------------------------------------

const RUN_INTEGRATION = !!process.env.RUN_INTEGRATION

describe.skipIf(!RUN_INTEGRATION)('goalLink — real DB integration', () => {
  it('creates a runs link and verifies it appears in duoidal link list', async () => {
    const { initAdapter, getAdapter: getRealAdapter } = await import('../lib/adapter-factory.js')
    await initAdapter()

    // This test requires a prior goalUpload to have created a skill resource.
    // Set INTEGRATION_SKILL_RESOURCE_ID to a known UUID for a pre-existing skill resource.
    const skillResourceId = process.env.INTEGRATION_SKILL_RESOURCE_ID
    if (!skillResourceId) {
      throw new Error(
        'Integration test requires INTEGRATION_SKILL_RESOURCE_ID env var pointing to an existing skill resource UUID'
      )
    }

    await goalLink(skillResourceId, 'agent-efficiency')

    // Verify the link was created by looking it up via the adapter
    const adapter = getRealAdapter()
    const allLinks = await adapter.listAllResourceLinks()
    const matching = allLinks.filter(
      (l) =>
        l.to_id === skillResourceId &&
        l.link_type === 'runs'
    )
    expect(matching.length).toBeGreaterThan(0)
  })
})
