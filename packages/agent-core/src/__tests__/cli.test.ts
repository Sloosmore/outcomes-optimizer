import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { setAdapter, clearAdapter } from '../lib/adapter-factory.js'
import type { OntologyStorageAdapter } from '../lib/ontology-adapter.js'
import { VALID_TYPES } from '../lib/resource-helpers.js'
import { resourceCommand } from '../commands/resource.js'

function makeMockAdapter(): OntologyStorageAdapter {
  return {
    getResourceTypes: vi.fn(),
    addResource: vi.fn(),
    listResources: vi.fn(),
    searchResources: vi.fn(),
    getResource: vi.fn(),
    getResourceById: vi.fn(),
    getAvailableResources: vi.fn(),
    updateResource: vi.fn(),
    removeResource: vi.fn(),
    checkoutResource: vi.fn(),
    releaseResource: vi.fn(),
    createResourceLink: vi.fn(),
    deleteResourceLink: vi.fn(),
    getResourceLinkCounts: vi.fn(),
    listAllResourceLinks: vi.fn(),
    getLinkTypes: vi.fn(),
    getLinkType: vi.fn(),
    getLinkTypeRules: vi.fn(),
    getLinkTypeRulesWithCardinality: vi.fn(),
    getValueTypes: vi.fn(),
    getValueTypeByName: vi.fn(),
    getResourceTypeProperties: vi.fn(),
    listProcesses: vi.fn(),
    initProcess: vi.fn(),
    getProcessById: vi.fn(),
    getProcessByName: vi.fn(),
    getProcessEpochs: vi.fn(),
    sleepProcess: vi.fn(),
    resolveProcessId: vi.fn(),
    upsertEpochResult: vi.fn(),
    updateProcessAggregate: vi.fn(),
    listEnabledCrons: vi.fn(),
    listCronsWithDetails: vi.fn(),
  } as unknown as OntologyStorageAdapter
}

describe('renderResource', () => {
  it('renders config.content as primary body', async () => {
    const { renderResource } = await import('../lib/render.js')
    const logs: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...args) => logs.push(args.join(' ')))

    renderResource({
      id: '123',
      name: 'test-resource',
      type: 'skill',
      status: 'active',
      config: { content: '# My Skill\nSome skill content' },
      notes: null,
      locked_by: null,
      locked_at: null,
      created_at: '2024-01-01',
      updated_at: '2024-01-01',

    }, false)

    expect(logs.join('\n')).toContain('# My Skill')
    vi.restoreAllMocks()
  })

  it('falls back to JSON structure when no config.content', async () => {
    const { renderResource } = await import('../lib/render.js')
    const logs: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...args) => logs.push(args.join(' ')))

    renderResource({
      id: '123',
      name: 'test-identity',
      type: 'identity',
      status: 'active',
      config: { platform: 'instagram' },
      notes: 'test notes',
      locked_by: 'locker-1',
      locked_at: '2024-01-01',
      created_at: '2024-01-01',
      updated_at: '2024-01-01',

    }, false)

    const output = logs.join('\n')
    expect(output).toContain('test-identity')
    expect(output).toContain('locker-1')
    vi.restoreAllMocks()
  })

  it('outputs JSON when --json flag is true', async () => {
    const { renderResource } = await import('../lib/render.js')
    const logs: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...args) => logs.push(args.join(' ')))

    const resource = {
      id: '123', name: 'test', type: 'skill', status: 'active',
      config: {}, notes: null, locked_by: null, locked_at: null,
      created_at: '2024-01-01', updated_at: '2024-01-01',
    }
    renderResource(resource, true)

    const parsed = JSON.parse(logs[0])
    expect(parsed.name).toBe('test')
    vi.restoreAllMocks()
  })
})

describe('renderResourceTypes', () => {
  it('outputs table with finite column', async () => {
    const { renderResourceTypes } = await import('../lib/render.js')
    const logs: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...args) => logs.push(args.join(' ')))

    renderResourceTypes([
      { name: 'identity', finite: true, description: 'Platform accounts', count: 5 },
      { name: 'skill', finite: false, description: 'Optimization objectives', count: 3 },
    ], false)

    const output = logs.join('\n')
    expect(output).toContain('identity')
    expect(output).toContain('yes')
    expect(output).toContain('skill')
    expect(output).toContain('no')
    vi.restoreAllMocks()
  })
})

describe('VALID_TYPES', () => {
  it('includes proxy', () => {
    expect(VALID_TYPES).toContain('proxy')
  })

  it('includes all expected types', () => {
    const expected = ['data', 'identity', 'url', 'credential', 'config', 'app', 'skill', 'proxy']
    for (const t of expected) {
      expect(VALID_TYPES).toContain(t)
    }
  })
})

describe('resource add command', () => {
  let logs: string[]
  let errors: string[]
  let mockAdapter: OntologyStorageAdapter

  beforeEach(() => {
    mockAdapter = makeMockAdapter()
    setAdapter(mockAdapter)
    logs = []
    errors = []
    vi.spyOn(console, 'log').mockImplementation((...args) => logs.push(args.join(' ')))
    vi.spyOn(console, 'error').mockImplementation((...args) => errors.push(args.join(' ')))
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      const line = String(chunk)
      if (line.includes('[ERROR]') || line.includes('[WARN]')) errors.push(line)
      return true
    })
  })

  afterEach(() => {
    clearAdapter()
    vi.restoreAllMocks()
  })

  it('calls addResource and prints success', async () => {
    const mockResource = {
      id: 'uuid-1', name: 'proxy-test-01', type: 'proxy', status: 'active',
      config: { urlEnvVar: 'PROXY_TEST_01_URL' }, notes: null,
      locked_by: null, locked_at: null, created_at: '2024-01-01', updated_at: '2024-01-01',
    }
    vi.mocked(mockAdapter.addResource).mockResolvedValueOnce(mockResource)

    const cmd = resourceCommand()
    await cmd.parseAsync(['add', '--name', 'proxy-test-01', '--type', 'proxy', '--config', '{"urlEnvVar":"PROXY_TEST_01_URL"}'], { from: 'user' })

    expect(mockAdapter.addResource).toHaveBeenCalledWith('proxy-test-01', 'proxy', { urlEnvVar: 'PROXY_TEST_01_URL' }, undefined)
    expect(logs.join('\n')).toContain('uuid-1')
  })

  it('sets exitCode on invalid JSON config', async () => {
    const originalExitCode = process.exitCode
    const cmd = resourceCommand()
    await cmd.parseAsync(['add', '--name', 'x', '--type', 'proxy', '--config', 'not-json'], { from: 'user' })

    expect(errors.join('\n')).toContain('Invalid JSON')
    expect(process.exitCode).toBe(1)
    process.exitCode = originalExitCode as number | undefined
  })

  it('prints error and sets exitCode on addResource errors', async () => {
    vi.mocked(mockAdapter.addResource).mockRejectedValueOnce(new Error('Invalid resource type: badtype'))

    const originalExitCode = process.exitCode
    const cmd = resourceCommand()
    await cmd.parseAsync(['add', '--name', 'x', '--type', 'badtype'], { from: 'user' })

    expect(errors.join('\n')).toContain('Invalid resource type: badtype')
    expect(process.exitCode).toBe(2)
    process.exitCode = originalExitCode as number | undefined
  })
})

describe('resource link command', () => {
  let logs: string[]
  let mockAdapter: OntologyStorageAdapter

  beforeEach(() => {
    mockAdapter = makeMockAdapter()
    setAdapter(mockAdapter)
    logs = []
    vi.spyOn(console, 'log').mockImplementation((...args) => logs.push(args.join(' ')))
  })

  afterEach(() => {
    clearAdapter()
    vi.restoreAllMocks()
  })

  it('calls createResourceLink and prints success', async () => {
    vi.mocked(mockAdapter.createResourceLink).mockResolvedValueOnce({
      link: { from_id: 'f', to_id: 't', link_type: 'proxy', created_at: '2024-01-01' },
      created: true,
    })

    const cmd = resourceCommand()
    await cmd.parseAsync(['link', '--from', 'instagram-squarebent', '--to', 'proxy-test-01', '--type', 'proxy'], { from: 'user' })

    expect(mockAdapter.createResourceLink).toHaveBeenCalledWith('instagram-squarebent', 'proxy-test-01', 'proxy')
    expect(logs.join('\n')).toContain('instagram-squarebent')
    expect(logs.join('\n')).toContain('proxy-test-01')
  })
})
