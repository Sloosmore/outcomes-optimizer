import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock the logger to avoid DB writes in tests.
// error/warn forward to console.error so test spies on console.error still work.
vi.mock('@skill-networks/logger', () => ({
  registerDrain: vi.fn(),
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn((...args: unknown[]) => console.error(...args)),
    error: vi.fn((...args: unknown[]) => console.error(...args)),
  })),
}))

vi.mock('../lib/postgres-log-drain.js', () => ({
  PostgresLogDrain: vi.fn(),
  setupPostgresLogger: vi.fn(),
}))

import { setAdapter, clearAdapter } from '../lib/adapter-factory.js'
import type { OntologyStorageAdapter } from '../lib/ontology-adapter.js'
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

const validResource = {
  id: 'uuid-valid',
  name: 'test-valid-identity',
  type: 'identity',
  status: 'active',
  config: { handle: 'testuser', urls: [] },
  notes: null,
  locked_by: null,
  locked_at: null,
  created_at: '2024-01-01',
  updated_at: '2024-01-01',
}

const identityProperties = [
  { field_name: 'handle', value_type_name: 'non-empty-string', required: true },
]

const identityLinkRules = [
  { link_type: 'credential', from_type: 'identity', to_type: 'credential', min_count: 1, max_count: 1 },
  { link_type: 'proxy', from_type: 'identity', to_type: 'proxy', min_count: 0, max_count: 1 },
]

const validLinkCounts = [
  { link_type: 'credential', count: 1 },
  { link_type: 'proxy', count: 1 },
]

const nonEmptyStringValueType = {
  name: 'non-empty-string',
  base_type: 'string',
  constraints: [{ type: 'range', min: 1 }],
}

describe('resource validate command', () => {
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
  })

  afterEach(() => {
    clearAdapter()
    vi.restoreAllMocks()
  })

  it('passes for complete resource with valid properties and links', async () => {
    vi.mocked(mockAdapter.getResource).mockResolvedValueOnce(validResource)
    vi.mocked(mockAdapter.getResourceTypeProperties).mockResolvedValueOnce(identityProperties)
    vi.mocked(mockAdapter.getLinkTypeRulesWithCardinality).mockResolvedValueOnce(identityLinkRules)
    vi.mocked(mockAdapter.getResourceLinkCounts).mockResolvedValueOnce(validLinkCounts)
    vi.mocked(mockAdapter.getValueTypeByName).mockResolvedValueOnce(nonEmptyStringValueType)

    const originalExitCode = process.exitCode
    const cmd = resourceCommand()
    await cmd.parseAsync(['validate', 'test-valid-identity'], { from: 'user' })

    const output = logs.join('\n')
    expect(output).toContain('[VALID]')
    expect(process.exitCode).not.toBe(1)
    process.exitCode = originalExitCode as number | undefined
  })

  it('fails when credential link is missing (cardinality min:1)', async () => {
    vi.mocked(mockAdapter.getResource).mockResolvedValueOnce(validResource)
    vi.mocked(mockAdapter.getResourceTypeProperties).mockResolvedValueOnce(identityProperties)
    vi.mocked(mockAdapter.getLinkTypeRulesWithCardinality).mockResolvedValueOnce(identityLinkRules)
    // No credential link — only proxy
    vi.mocked(mockAdapter.getResourceLinkCounts).mockResolvedValueOnce([
      { link_type: 'proxy', count: 1 },
    ])
    vi.mocked(mockAdapter.getValueTypeByName).mockResolvedValueOnce(nonEmptyStringValueType)

    const originalExitCode = process.exitCode
    const cmd = resourceCommand()
    await cmd.parseAsync(['validate', 'test-valid-identity'], { from: 'user' })

    const output = logs.join('\n')
    expect(output).toContain('[INVALID]')
    expect(output).toContain('credential link')
    expect(process.exitCode).toBe(1)
    process.exitCode = originalExitCode as number | undefined
  })

  it('fails when required property is missing', async () => {
    const resourceMissingHandle = {
      ...validResource,
      config: { urls: [] }, // no handle
    }

    vi.mocked(mockAdapter.getResource).mockResolvedValueOnce(resourceMissingHandle)
    vi.mocked(mockAdapter.getResourceTypeProperties).mockResolvedValueOnce(identityProperties)
    vi.mocked(mockAdapter.getLinkTypeRulesWithCardinality).mockResolvedValueOnce(identityLinkRules)
    vi.mocked(mockAdapter.getResourceLinkCounts).mockResolvedValueOnce(validLinkCounts)

    const originalExitCode = process.exitCode
    const cmd = resourceCommand()
    await cmd.parseAsync(['validate', 'test-valid-identity'], { from: 'user' })

    const output = logs.join('\n')
    expect(output).toContain('[INVALID]')
    expect(output).toContain('handle')
    expect(output).toContain('required')
    expect(process.exitCode).toBe(1)
    process.exitCode = originalExitCode as number | undefined
  })

  it('fails when resource is not found', async () => {
    vi.mocked(mockAdapter.getResource).mockResolvedValueOnce(null)

    const originalExitCode = process.exitCode
    const cmd = resourceCommand()
    await cmd.parseAsync(['validate', 'nonexistent-resource'], { from: 'user' })

    const output = errors.join('\n')
    expect(output).toContain('Resource not found')
    expect(process.exitCode).toBe(1)
    process.exitCode = originalExitCode as number | undefined
  })
})
