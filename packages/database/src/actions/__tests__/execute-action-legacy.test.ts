import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const mockLoggerError = vi.fn()
const mockLoggerFactory = {
  createLogger: vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: mockLoggerError,
  }),
}
vi.mock('../../logger/index.js', () => mockLoggerFactory)
vi.mock('@skill-networks/logger', () => mockLoggerFactory)

const PROVISION_USER_ACTION_TYPE = {
  name: 'provision_user',
  rpc_function: 'provision_user',
  input_schema: {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    required: ['authUserId', 'email'],
    properties: {
      authUserId: { type: 'string' },
      email: { type: 'string' },
    },
    additionalProperties: false,
  },
  output_schema: {},
  param_mapping: { authUserId: 'p_auth_user_id', email: 'p_email' },
  result_mapping: {
    user_resource_id: 'userResourceId',
    project_resource_id: 'projectResourceId',
  },
  description: 'Provision user',
  schema_version: 1,
  created_at: '2024-01-01T00:00:00Z',
}

// vi.mock is hoisted to top of file. The factory must be self-contained.
// We use a module-level mutable ref so tests can override behavior.
const _auditState = { insert: vi.fn().mockResolvedValue({ error: null }) }

vi.mock('@supabase/supabase-js', () => {
  return {
    createClient: vi.fn().mockImplementation(() => ({
      from: vi.fn().mockReturnValue({ insert: _auditState.insert }),
    })),
  }
})

const mockRpc = vi.fn()
const mockGetUser = vi
  .fn()
  .mockResolvedValue({ data: { user: { id: '00000000-0000-4000-8000-000000000001' } }, error: null })

function makeMockFrom() {
  return vi.fn().mockReturnValue({
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        single: vi
          .fn()
          .mockResolvedValue({ data: PROVISION_USER_ACTION_TYPE, error: null }),
      }),
    }),
  })
}

let mockFrom = makeMockFrom()

const mockClient = {
  get from() { return mockFrom },
  rpc: mockRpc,
  auth: { getUser: mockGetUser },
} as unknown as SupabaseClient

describe('executeAction', () => {
  beforeEach(async () => {
    vi.clearAllMocks()

    // Set env vars so createClient is actually called in writeAuditEvent
    process.env.SUPABASE_URL = 'https://test.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key'

    // Reset audit insert
    _auditState.insert = vi.fn().mockResolvedValue({ error: null })

    // Reset from mock
    mockFrom = makeMockFrom()

    // Clear cache between tests
    const mod = await import('../execute-action.js')
    mod.clearCache()
  })

  afterEach(() => {
    delete process.env.SUPABASE_URL
    delete process.env.SUPABASE_SERVICE_ROLE_KEY
  })

  it('T1: cache hit on second call', async () => {
    const { executeAction } = await import('../execute-action.js')

    mockRpc.mockResolvedValue({
      data: { user_resource_id: 'u-1', project_resource_id: 'p-1' },
      error: null,
    })

    // First call — should hit DB
    await executeAction(
      'provision_user',
      { authUserId: 'abc', email: 'a@b.com' },
      mockClient
    )

    expect(mockFrom).toHaveBeenCalledTimes(1)

    // Second call — should use cache (DB query not repeated)
    await executeAction(
      'provision_user',
      { authUserId: 'abc', email: 'a@b.com' },
      mockClient
    )

    expect(mockFrom).toHaveBeenCalledTimes(1)
  })

  it('T2: invalid input throws with field names', async () => {
    const { executeAction } = await import('../execute-action.js')

    // Both missing fields should appear in the error message
    const promise = executeAction('provision_user', {}, mockClient)
    await expect(promise).rejects.toThrow(/authUserId/)

    const promise2 = executeAction('provision_user', {}, mockClient)
    await expect(promise2).rejects.toThrow(/email/)
  })

  it('T3: valid input returns correct typed result', async () => {
    const { executeAction } = await import('../execute-action.js')

    mockRpc.mockResolvedValue({
      data: { user_resource_id: 'u-123', project_resource_id: 'p-456' },
      error: null,
    })

    const result = await executeAction(
      'provision_user',
      { authUserId: 'test-user', email: 'test@example.com' },
      mockClient
    )

    expect(result).toEqual({
      userResourceId: 'u-123',
      projectResourceId: 'p-456',
    })
  })

  it('T4: audit event INSERT is attempted after every RPC call (success case)', async () => {
    const { executeAction } = await import('../execute-action.js')

    mockRpc.mockResolvedValue({
      data: { user_resource_id: 'u-1', project_resource_id: 'p-1' },
      error: null,
    })

    await executeAction(
      'provision_user',
      { authUserId: 'abc', email: 'a@b.com' },
      mockClient
    )

    expect(_auditState.insert).toHaveBeenCalledTimes(1)
    const insertArg = _auditState.insert.mock.calls[0][0]
    expect(insertArg.status).toBe('success')
  })

  it('T5: audit INSERT failure swallowed, original result returned', async () => {
    const { executeAction } = await import('../execute-action.js')

    mockRpc.mockResolvedValue({
      data: { user_resource_id: 'u-1', project_resource_id: 'p-1' },
      error: null,
    })

    _auditState.insert = vi.fn().mockRejectedValue(new Error('audit DB down'))

    const result = await executeAction(
      'provision_user',
      { authUserId: 'abc', email: 'a@b.com' },
      mockClient
    )

    // Should still return the correct result
    expect(result).toEqual({
      userResourceId: 'u-1',
      projectResourceId: 'p-1',
    })

    // Should have logged the error via structured logger
    expect(mockLoggerError).toHaveBeenCalledWith('audit write failed', expect.objectContaining({ error: expect.any(Object) }))
  })

  it('T6: RPC failure writes audit event with status=failed', async () => {
    const { executeAction } = await import('../execute-action.js')

    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'db error' },
    })

    await expect(
      executeAction(
        'provision_user',
        { authUserId: 'abc', email: 'a@b.com' },
        mockClient
      )
    ).rejects.toThrow('provision_user RPC failed: db error')

    expect(_auditState.insert).toHaveBeenCalledTimes(1)
    const insertArg = _auditState.insert.mock.calls[0][0]
    expect(insertArg.status).toBe('failed')
    expect(insertArg.error).toBe('provision_user RPC failed: db error')
  })

  it('T7: unknown action name throws with descriptive error', async () => {
    const { executeAction } = await import('../execute-action.js')

    // Override the from mock to return a DB error for unknown action
    mockFrom = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({ data: null, error: { message: 'No rows found' } }),
        }),
      }),
    })

    await expect(
      executeAction('unknown_action', { foo: 'bar' }, mockClient)
    ).rejects.toThrow("Failed to fetch action type 'unknown_action': No rows found")
  })
})

const STORE_CREDENTIAL_ACTION_TYPE = {
  name: 'store_user_credential',
  rpc_function: 'store_user_credential',
  input_schema: {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    required: ['userResourceId', 'sandboxName', 'provider', 'credentialValue'],
    properties: {
      userResourceId: { type: 'string' },
      sandboxName: { type: 'string' },
      provider: { type: 'string' },
      credentialValue: { type: 'string' },
    },
    additionalProperties: false,
  },
  output_schema: {},
  param_mapping: {
    userResourceId: 'p_user_resource_id',
    sandboxName: 'p_sandbox_name',
    provider: 'p_provider',
    credentialValue: 'p_credential_value',
  },
  result_mapping: {
    credential_resource_id: 'credentialResourceId',
    vault_secret_id: 'vaultSecretId',
  },
  description: 'Store credential',
  schema_version: 1,
  sensitive_fields: ['credentialValue'],
  created_at: '2026-04-01T00:00:00Z',
}

describe('sensitive_fields redaction', () => {
  beforeEach(async () => {
    vi.clearAllMocks()

    process.env.SUPABASE_URL = 'https://test.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key'

    _auditState.insert = vi.fn().mockResolvedValue({ error: null })

    mockFrom = makeMockFrom()

    const mod = await import('../execute-action.js')
    mod.clearCache()
  })

  afterEach(() => {
    delete process.env.SUPABASE_URL
    delete process.env.SUPABASE_SERVICE_ROLE_KEY
  })

  it('T-REDACT-1: redacts sensitive fields in audit input but uses original for RPC call', async () => {
    const { executeAction } = await import('../execute-action.js')

    mockFrom = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({ data: STORE_CREDENTIAL_ACTION_TYPE, error: null }),
        }),
      }),
    })

    mockRpc.mockResolvedValue({
      data: [{ credential_resource_id: 'cred-uuid-1', vault_secret_id: 'vault-uuid-1' }],
      error: null,
    })

    await executeAction(
      'store_user_credential',
      { userResourceId: 'uuid-1', sandboxName: 'dev', provider: 'anthropic', credentialValue: 'sk-ant-secret123' },
      mockClient
    )

    // Audit insert must have been called once
    expect(_auditState.insert).toHaveBeenCalledTimes(1)
    const insertArg = _auditState.insert.mock.calls[0][0]

    // Audit input must have credentialValue redacted
    expect(insertArg.input.credentialValue).toBe('[REDACTED]')

    // RPC must have been called with the original credential value
    expect(mockRpc).toHaveBeenCalledWith(
      'store_user_credential',
      expect.objectContaining({ p_credential_value: 'sk-ant-secret123' })
    )
  })

  it('T-REDACT-2: no redaction when sensitive_fields is empty', async () => {
    const { executeAction } = await import('../execute-action.js')

    const actionWithNoSensitiveFields = { ...STORE_CREDENTIAL_ACTION_TYPE, sensitive_fields: [] }

    mockFrom = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({ data: actionWithNoSensitiveFields, error: null }),
        }),
      }),
    })

    mockRpc.mockResolvedValue({
      data: [{ credential_resource_id: 'cred-uuid-2', vault_secret_id: 'vault-uuid-2' }],
      error: null,
    })

    await executeAction(
      'store_user_credential',
      { userResourceId: 'uuid-1', sandboxName: 'dev', provider: 'anthropic', credentialValue: 'sk-ant-secret123' },
      mockClient
    )

    expect(_auditState.insert).toHaveBeenCalledTimes(1)
    const insertArg = _auditState.insert.mock.calls[0][0]

    // No redaction — original value preserved in audit
    expect(insertArg.input.credentialValue).toBe('sk-ant-secret123')
  })

  it('T-REDACT-3: no redaction when sensitive_fields absent from action type', async () => {
    const { executeAction } = await import('../execute-action.js')

    // Omit sensitive_fields entirely (undefined)
    const { sensitive_fields: _omitted, ...actionWithoutSensitiveFields } = STORE_CREDENTIAL_ACTION_TYPE

    mockFrom = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({ data: actionWithoutSensitiveFields, error: null }),
        }),
      }),
    })

    mockRpc.mockResolvedValue({
      data: [{ credential_resource_id: 'cred-uuid-3', vault_secret_id: 'vault-uuid-3' }],
      error: null,
    })

    await executeAction(
      'store_user_credential',
      { userResourceId: 'uuid-1', sandboxName: 'dev', provider: 'anthropic', credentialValue: 'sk-ant-secret123' },
      mockClient
    )

    expect(_auditState.insert).toHaveBeenCalledTimes(1)
    const insertArg = _auditState.insert.mock.calls[0][0]

    // No redaction — original value preserved in audit
    expect(insertArg.input.credentialValue).toBe('sk-ant-secret123')
  })
})
