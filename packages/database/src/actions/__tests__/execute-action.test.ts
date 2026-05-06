import { beforeEach, describe, it, expect } from 'vitest'
import { executeAction, clearCache } from '../execute-action.js'
import { listActions, describeAction } from '../../actions/index.js'
import type { ActionType } from '../execute-action.js'
import type { SupabaseClient } from '@supabase/supabase-js'

// A minimal mock action type row
function makeActionType(overrides: Partial<ActionType>): ActionType {
  return {
    name: 'test_action',
    rpc_function: 'test_action',
    input_schema: { type: 'object', required: ['foo'], properties: { foo: { type: 'string' } } },
    output_schema: { type: 'object', required: ['bar'], properties: { bar: { type: 'string' } } },
    param_mapping: { foo: 'p_foo' },
    result_mapping: { bar: 'bar' },
    description: 'Test action',
    schema_version: 1,
    sensitive_fields: [],
    validation_rules: null,
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

// Chainable mock query builder
function makeQueryBuilder(response: { data: unknown; error: null } | { data: null; error: { message: string } }) {
  const builder: Record<string, (...args: unknown[]) => unknown> = {}
  builder.select = () => builder
  builder.eq = () => builder
  builder.neq = () => builder
  builder.order = () => Promise.resolve(response)
  builder.maybeSingle = () => Promise.resolve(response)
  builder.single = () => Promise.resolve(response)
  builder.insert = () => Promise.resolve({ error: null })
  return builder
}

function makeMockClient(options: {
  actionType?: ActionType | null
  rpcResult?: unknown[]
  rpcError?: { message: string }
  listActionsData?: { name: string }[]
  describeActionData?: ActionType | null
}): SupabaseClient {
  const {
    actionType = null,
    rpcResult = [],
    rpcError,
    listActionsData,
    describeActionData,
  } = options

  return {
    from: (table: string) => {
      if (table === 'action_types') {
        const data = listActionsData !== undefined
          ? listActionsData
          : (describeActionData !== undefined ? describeActionData : actionType)
        return makeQueryBuilder({ data, error: null })
      }
      if (table === 'action_events') {
        return makeQueryBuilder({ data: null, error: null })
      }
      // uniqueness checks — assume no conflict by default
      return makeQueryBuilder({ data: null, error: null })
    },
    rpc: (_fn: string, _params: unknown) => {
      if (rpcError) return Promise.resolve({ data: null, error: rpcError })
      return Promise.resolve({ data: rpcResult, error: null })
    },
    auth: {
      getUser: () => Promise.resolve({ data: { user: null }, error: null }),
    },
  } as unknown as SupabaseClient
}

// ── create_agent ─────────────────────────────────────────────────────────────

describe('executeAction — create_agent', () => {
  beforeEach(() => clearCache())

  it('returns agentResourceId on valid input', async () => {
    const at = makeActionType({
      name: 'create_agent',
      rpc_function: 'create_agent',
      input_schema: {
        '$schema': 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        required: ['name', 'projectId'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 128 },
          projectId: { type: 'string', format: 'uuid' },
          config: { type: 'object' },
        },
        additionalProperties: false,
      },
      param_mapping: { name: 'p_name', projectId: 'p_project_id', config: 'p_config' },
      result_mapping: { agent_resource_id: 'agentResourceId' },
    })
    const client = makeMockClient({
      actionType: at,
      rpcResult: [{ agent_resource_id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' }],
    })
    const result = await executeAction('create_agent', {
      name: 'my-agent',
      projectId: 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    }, client)
    expect(result).toHaveProperty('agentResourceId', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11')
  })

  it('throws descriptive error on invalid input (missing projectId)', async () => {
    const at = makeActionType({
      name: 'create_agent',
      rpc_function: 'create_agent',
      input_schema: {
        '$schema': 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        required: ['name', 'projectId'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 128 },
          projectId: { type: 'string', format: 'uuid' },
        },
        additionalProperties: false,
      },
      param_mapping: { name: 'p_name', projectId: 'p_project_id' },
      result_mapping: { agent_resource_id: 'agentResourceId' },
    })
    const client = makeMockClient({ actionType: at })
    await expect(executeAction('create_agent', { name: 'my-agent' }, client))
      .rejects.toThrow('create_agent')
  })
})

// ── delete_resource ───────────────────────────────────────────────────────────

describe('executeAction — delete_resource', () => {
  beforeEach(() => clearCache())

  it('returns deletedLinks on valid input', async () => {
    const at = makeActionType({
      name: 'delete_resource',
      rpc_function: 'delete_resource',
      input_schema: {
        '$schema': 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        required: ['resourceId'],
        properties: {
          resourceId: { type: 'string', format: 'uuid' },
        },
        additionalProperties: false,
      },
      param_mapping: { resourceId: 'p_resource_id' },
      result_mapping: { deleted_links: 'deletedLinks' },
    })
    const client = makeMockClient({
      actionType: at,
      rpcResult: [{ deleted_links: 3 }],
    })
    const result = await executeAction('delete_resource', { resourceId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' }, client)
    expect(result).toHaveProperty('deletedLinks', 3)
  })

  it('throws descriptive error on invalid input (missing resourceId)', async () => {
    const at = makeActionType({
      name: 'delete_resource',
      rpc_function: 'delete_resource',
      input_schema: {
        '$schema': 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        required: ['resourceId'],
        properties: {
          resourceId: { type: 'string', format: 'uuid' },
        },
        additionalProperties: false,
      },
      param_mapping: { resourceId: 'p_resource_id' },
      result_mapping: { deleted_links: 'deletedLinks' },
    })
    const client = makeMockClient({ actionType: at })
    await expect(executeAction('delete_resource', {}, client))
      .rejects.toThrow('delete_resource')
  })
})


// ── delete_link ───────────────────────────────────────────────────────────────

describe('executeAction — delete_link', () => {
  beforeEach(() => clearCache())

  it('returns deleted=true on valid input', async () => {
    const at = makeActionType({
      name: 'delete_link',
      rpc_function: 'delete_link',
      input_schema: {
        '$schema': 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        required: ['fromId', 'toId', 'linkType'],
        properties: {
          fromId: { type: 'string', format: 'uuid' },
          toId: { type: 'string', format: 'uuid' },
          linkType: { type: 'string', minLength: 1 },
        },
        additionalProperties: false,
      },
      param_mapping: { fromId: 'p_from_id', toId: 'p_to_id', linkType: 'p_link_type' },
      result_mapping: { deleted: 'deleted' },
    })
    const client = makeMockClient({
      actionType: at,
      rpcResult: [{ deleted: true }],
    })
    const result = await executeAction('delete_link', {
      fromId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      toId: 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      linkType: 'partOf',
    }, client)
    expect(result).toHaveProperty('deleted', true)
  })

  it('throws descriptive error on invalid input (missing toId)', async () => {
    const at = makeActionType({
      name: 'delete_link',
      rpc_function: 'delete_link',
      input_schema: {
        '$schema': 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        required: ['fromId', 'toId', 'linkType'],
        properties: {
          fromId: { type: 'string', format: 'uuid' },
          toId: { type: 'string', format: 'uuid' },
          linkType: { type: 'string', minLength: 1 },
        },
        additionalProperties: false,
      },
      param_mapping: { fromId: 'p_from_id', toId: 'p_to_id', linkType: 'p_link_type' },
      result_mapping: { deleted: 'deleted' },
    })
    const client = makeMockClient({ actionType: at })
    await expect(executeAction('delete_link', {
      fromId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      linkType: 'partOf',
    }, client))
      .rejects.toThrow('delete_link')
  })
})

// ── update_resource_status ────────────────────────────────────────────────────

describe('executeAction — update_resource_status', () => {
  beforeEach(() => clearCache())

  it('returns resourceId and oldStatus on valid input', async () => {
    const at = makeActionType({
      name: 'update_resource_status',
      rpc_function: 'update_resource_status',
      input_schema: {
        '$schema': 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        required: ['resourceId', 'newStatus'],
        properties: {
          resourceId: { type: 'string', format: 'uuid' },
          newStatus: { type: 'string', enum: ['active', 'inactive', 'banned', 'expired', 'error'] },
          expectedStatus: { type: 'string', enum: ['active', 'inactive', 'banned', 'expired', 'error'] },
        },
        additionalProperties: false,
      },
      param_mapping: { resourceId: 'p_resource_id', newStatus: 'p_new_status', expectedStatus: 'p_expected_status' },
      result_mapping: { resource_id: 'resourceId', old_status: 'oldStatus' },
    })
    const client = makeMockClient({
      actionType: at,
      rpcResult: [{ resource_id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', old_status: 'active' }],
    })
    const result = await executeAction('update_resource_status', {
      resourceId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      newStatus: 'inactive',
    }, client)
    expect(result).toHaveProperty('resourceId')
    expect(result).toHaveProperty('oldStatus', 'active')
  })

  it('throws descriptive error on invalid input (missing newStatus)', async () => {
    const at = makeActionType({
      name: 'update_resource_status',
      rpc_function: 'update_resource_status',
      input_schema: {
        '$schema': 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        required: ['resourceId', 'newStatus'],
        properties: {
          resourceId: { type: 'string', format: 'uuid' },
          newStatus: { type: 'string', enum: ['active', 'inactive', 'banned', 'expired', 'error'] },
        },
        additionalProperties: false,
      },
      param_mapping: { resourceId: 'p_resource_id', newStatus: 'p_new_status' },
      result_mapping: { resource_id: 'resourceId', old_status: 'oldStatus' },
    })
    const client = makeMockClient({ actionType: at })
    await expect(executeAction('update_resource_status', {
      resourceId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    }, client))
      .rejects.toThrow('update_resource_status')
  })
})

// ── create_skill ──────────────────────────────────────────────────────────────

describe('executeAction — create_skill', () => {
  beforeEach(() => clearCache())

  it('returns skillResourceId on valid input', async () => {
    const at = makeActionType({
      name: 'create_skill',
      rpc_function: 'create_skill',
      input_schema: {
        '$schema': 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        required: ['name', 'projectId', 'config'],
        properties: {
          name: { type: 'string', minLength: 1 },
          projectId: { type: 'string', format: 'uuid' },
          config: { type: 'object' },
        },
        additionalProperties: false,
      },
      param_mapping: { name: 'p_name', projectId: 'p_project_id', config: 'p_config' },
      result_mapping: { skill_resource_id: 'skillResourceId' },
    })
    const client = makeMockClient({
      actionType: at,
      rpcResult: [{ skill_resource_id: 'skill-uuid-123' }],
    })
    const result = await executeAction('create_skill', {
      name: 'my-skill',
      projectId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      config: {
        prompt: 'Do something',
        epochs: 3,
        worktree: true,
        git: true,
        pr: false,
        content: 'x'.repeat(101),
      },
    }, client)
    expect(result).toHaveProperty('skillResourceId', 'skill-uuid-123')
  })

  it('throws descriptive error on invalid input (missing required config)', async () => {
    const at = makeActionType({
      name: 'create_skill',
      rpc_function: 'create_skill',
      input_schema: {
        '$schema': 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        required: ['name', 'projectId', 'config'],
        properties: {
          name: { type: 'string', minLength: 1 },
          projectId: { type: 'string', format: 'uuid' },
          config: { type: 'object' },
        },
        additionalProperties: false,
      },
      param_mapping: { name: 'p_name', projectId: 'p_project_id', config: 'p_config' },
      result_mapping: { skill_resource_id: 'skillResourceId' },
    })
    const client = makeMockClient({ actionType: at })
    await expect(executeAction('create_skill', { name: 'my-skill' }, client))
      .rejects.toThrow('create_skill')
  })
})

// ── update_skill_config ───────────────────────────────────────────────────────

describe('executeAction — update_skill_config', () => {
  beforeEach(() => clearCache())

  it('returns resourceId on valid input', async () => {
    const at = makeActionType({
      name: 'update_skill_config',
      rpc_function: 'update_skill_config',
      input_schema: {
        '$schema': 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        required: ['resourceId', 'config'],
        properties: {
          resourceId: { type: 'string', format: 'uuid' },
          config: { type: 'object' },
        },
        additionalProperties: false,
      },
      param_mapping: { resourceId: 'p_resource_id', config: 'p_config' },
      result_mapping: { resource_id: 'resourceId' },
    })
    const client = makeMockClient({
      actionType: at,
      rpcResult: [{ resource_id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' }],
    })
    const result = await executeAction('update_skill_config', {
      resourceId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      config: { epochs: 5 },
    }, client)
    expect(result).toHaveProperty('resourceId')
  })

  it('throws descriptive error on invalid input (missing config)', async () => {
    const at = makeActionType({
      name: 'update_skill_config',
      rpc_function: 'update_skill_config',
      input_schema: {
        '$schema': 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        required: ['resourceId', 'config'],
        properties: {
          resourceId: { type: 'string', format: 'uuid' },
          config: { type: 'object' },
        },
        additionalProperties: false,
      },
      param_mapping: { resourceId: 'p_resource_id', config: 'p_config' },
      result_mapping: { resource_id: 'resourceId' },
    })
    const client = makeMockClient({ actionType: at })
    await expect(executeAction('update_skill_config', {
      resourceId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    }, client))
      .rejects.toThrow('update_skill_config')
  })
})

// ── update_skill_content ──────────────────────────────────────────────────────

describe('executeAction — update_skill_content', () => {
  beforeEach(() => clearCache())

  it('returns resourceId on valid input', async () => {
    const at = makeActionType({
      name: 'update_skill_content',
      rpc_function: 'update_skill_content',
      input_schema: {
        '$schema': 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        required: ['resourceId', 'content'],
        properties: {
          resourceId: { type: 'string', format: 'uuid' },
          content: { type: 'string', minLength: 101 },
        },
        additionalProperties: false,
      },
      param_mapping: { resourceId: 'p_resource_id', content: 'p_content' },
      result_mapping: { resource_id: 'resourceId' },
    })
    const client = makeMockClient({
      actionType: at,
      rpcResult: [{ resource_id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' }],
    })
    const result = await executeAction('update_skill_content', {
      resourceId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      content: 'x'.repeat(101),
    }, client)
    expect(result).toHaveProperty('resourceId')
  })

  it('throws descriptive error on invalid input (content too short)', async () => {
    const at = makeActionType({
      name: 'update_skill_content',
      rpc_function: 'update_skill_content',
      input_schema: {
        '$schema': 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        required: ['resourceId', 'content'],
        properties: {
          resourceId: { type: 'string', format: 'uuid' },
          content: { type: 'string', minLength: 101 },
        },
        additionalProperties: false,
      },
      param_mapping: { resourceId: 'p_resource_id', content: 'p_content' },
      result_mapping: { resource_id: 'resourceId' },
    })
    const client = makeMockClient({ actionType: at })
    await expect(executeAction('update_skill_content', {
      resourceId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      content: 'too short',
    }, client))
      .rejects.toThrow('update_skill_content')
  })
})

// ── create_cron ───────────────────────────────────────────────────────────────

describe('executeAction — create_cron', () => {
  beforeEach(() => clearCache())

  it('returns cronResourceId on valid input', async () => {
    const at = makeActionType({
      name: 'create_cron',
      rpc_function: 'create_cron',
      input_schema: {
        '$schema': 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        required: ['name', 'projectId', 'skillResourceId', 'schedule', 'enabled'],
        properties: {
          name: { type: 'string', minLength: 1 },
          projectId: { type: 'string', format: 'uuid' },
          skillResourceId: { type: 'string', format: 'uuid' },
          schedule: { type: 'string' },
          enabled: { type: 'boolean' },
          prompt: { type: 'string' },
          dependsOn: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
      param_mapping: {
        name: 'p_name',
        projectId: 'p_project_id',
        skillResourceId: 'p_skill_resource_id',
        schedule: 'p_schedule',
        enabled: 'p_enabled',
        prompt: 'p_prompt',
        dependsOn: 'p_depends_on',
      },
      result_mapping: { cron_resource_id: 'cronResourceId' },
    })
    const client = makeMockClient({
      actionType: at,
      rpcResult: [{ cron_resource_id: 'cron-uuid-123' }],
    })
    const result = await executeAction('create_cron', {
      name: 'my-cron',
      projectId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      skillResourceId: 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      schedule: '0 * * * *',
      enabled: true,
    }, client)
    expect(result).toHaveProperty('cronResourceId', 'cron-uuid-123')
  })

  it('throws descriptive error on invalid input (missing schedule)', async () => {
    const at = makeActionType({
      name: 'create_cron',
      rpc_function: 'create_cron',
      input_schema: {
        '$schema': 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        required: ['name', 'projectId', 'skillResourceId', 'schedule', 'enabled'],
        properties: {
          name: { type: 'string', minLength: 1 },
          projectId: { type: 'string', format: 'uuid' },
          skillResourceId: { type: 'string', format: 'uuid' },
          schedule: { type: 'string' },
          enabled: { type: 'boolean' },
        },
        additionalProperties: false,
      },
      param_mapping: {
        name: 'p_name',
        projectId: 'p_project_id',
        skillResourceId: 'p_skill_resource_id',
        schedule: 'p_schedule',
        enabled: 'p_enabled',
      },
      result_mapping: { cron_resource_id: 'cronResourceId' },
    })
    const client = makeMockClient({ actionType: at })
    await expect(executeAction('create_cron', {
      name: 'my-cron',
      projectId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      skillResourceId: 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      enabled: true,
    }, client))
      .rejects.toThrow('create_cron')
  })
})

// ── update_cron_schedule ──────────────────────────────────────────────────────

describe('executeAction — update_cron_schedule', () => {
  beforeEach(() => clearCache())

  it('returns resourceId on valid input', async () => {
    const at = makeActionType({
      name: 'update_cron_schedule',
      rpc_function: 'update_cron_schedule',
      input_schema: {
        '$schema': 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        required: ['resourceId'],
        properties: {
          resourceId: { type: 'string', format: 'uuid' },
          schedule: { type: 'string' },
          enabled: { type: 'boolean' },
          prompt: { type: 'string' },
        },
        additionalProperties: false,
      },
      param_mapping: { resourceId: 'p_resource_id', schedule: 'p_schedule', enabled: 'p_enabled', prompt: 'p_prompt' },
      result_mapping: { resource_id: 'resourceId' },
    })
    const client = makeMockClient({
      actionType: at,
      rpcResult: [{ resource_id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' }],
    })
    const result = await executeAction('update_cron_schedule', {
      resourceId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      schedule: '0 9 * * *',
    }, client)
    expect(result).toHaveProperty('resourceId')
  })

  it('throws descriptive error on invalid input (missing resourceId)', async () => {
    const at = makeActionType({
      name: 'update_cron_schedule',
      rpc_function: 'update_cron_schedule',
      input_schema: {
        '$schema': 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        required: ['resourceId'],
        properties: {
          resourceId: { type: 'string', format: 'uuid' },
          schedule: { type: 'string' },
        },
        additionalProperties: false,
      },
      param_mapping: { resourceId: 'p_resource_id', schedule: 'p_schedule' },
      result_mapping: { resource_id: 'resourceId' },
    })
    const client = makeMockClient({ actionType: at })
    await expect(executeAction('update_cron_schedule', { schedule: '0 9 * * *' }, client))
      .rejects.toThrow('update_cron_schedule')
  })
})

// ── create_identity ───────────────────────────────────────────────────────────

describe('executeAction — create_identity', () => {
  beforeEach(() => clearCache())

  it('returns identityResourceId on valid input', async () => {
    const at = makeActionType({
      name: 'create_identity',
      rpc_function: 'create_identity',
      input_schema: {
        '$schema': 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        required: ['name', 'projectId', 'handle'],
        properties: {
          name: { type: 'string' },
          projectId: { type: 'string', format: 'uuid' },
          handle: { type: 'string', minLength: 1 },
          config: { type: 'object' },
        },
        additionalProperties: false,
      },
      param_mapping: { name: 'p_name', projectId: 'p_project_id', handle: 'p_handle', config: 'p_config' },
      result_mapping: { identity_resource_id: 'identityResourceId' },
    })
    const client = makeMockClient({
      actionType: at,
      rpcResult: [{ identity_resource_id: 'identity-uuid-123' }],
    })
    const result = await executeAction('create_identity', {
      name: 'my-identity',
      projectId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      handle: '@myhandle',
    }, client)
    expect(result).toHaveProperty('identityResourceId', 'identity-uuid-123')
  })

  it('throws descriptive error on invalid input (missing handle)', async () => {
    const at = makeActionType({
      name: 'create_identity',
      rpc_function: 'create_identity',
      input_schema: {
        '$schema': 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        required: ['name', 'projectId', 'handle'],
        properties: {
          name: { type: 'string' },
          projectId: { type: 'string', format: 'uuid' },
          handle: { type: 'string', minLength: 1 },
        },
        additionalProperties: false,
      },
      param_mapping: { name: 'p_name', projectId: 'p_project_id', handle: 'p_handle' },
      result_mapping: { identity_resource_id: 'identityResourceId' },
    })
    const client = makeMockClient({ actionType: at })
    await expect(executeAction('create_identity', {
      name: 'my-identity',
      projectId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    }, client))
      .rejects.toThrow('create_identity')
  })
})

// ── create_app ────────────────────────────────────────────────────────────────

describe('executeAction — create_app', () => {
  beforeEach(() => clearCache())

  it('returns appResourceId on valid input', async () => {
    const at = makeActionType({
      name: 'create_app',
      rpc_function: 'create_app',
      input_schema: {
        '$schema': 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        required: ['name', 'projectId'],
        properties: {
          name: { type: 'string' },
          projectId: { type: 'string', format: 'uuid' },
          config: {
            type: 'object',
            properties: {
              urls: { type: 'array', items: { type: 'string' } },
            },
          },
        },
        additionalProperties: false,
      },
      param_mapping: { name: 'p_name', projectId: 'p_project_id', config: 'p_config' },
      result_mapping: { app_resource_id: 'appResourceId' },
    })
    const client = makeMockClient({
      actionType: at,
      rpcResult: [{ app_resource_id: 'app-uuid-123' }],
    })
    const result = await executeAction('create_app', {
      name: 'my-app',
      projectId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    }, client)
    expect(result).toHaveProperty('appResourceId', 'app-uuid-123')
  })

  it('throws descriptive error on invalid input (missing projectId)', async () => {
    const at = makeActionType({
      name: 'create_app',
      rpc_function: 'create_app',
      input_schema: {
        '$schema': 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        required: ['name', 'projectId'],
        properties: {
          name: { type: 'string' },
          projectId: { type: 'string', format: 'uuid' },
        },
        additionalProperties: false,
      },
      param_mapping: { name: 'p_name', projectId: 'p_project_id' },
      result_mapping: { app_resource_id: 'appResourceId' },
    })
    const client = makeMockClient({ actionType: at })
    await expect(executeAction('create_app', { name: 'my-app' }, client))
      .rejects.toThrow('create_app')
  })
})

// ── create_credential ─────────────────────────────────────────────────────────

describe('executeAction — create_credential', () => {
  beforeEach(() => clearCache())

  it('returns credentialResourceId on valid input', async () => {
    const at = makeActionType({
      name: 'create_credential',
      rpc_function: 'create_credential',
      input_schema: {
        '$schema': 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        required: ['name', 'projectId', 'dopplerProject'],
        properties: {
          name: { type: 'string' },
          projectId: { type: 'string', format: 'uuid' },
          dopplerProject: { type: 'string', minLength: 1 },
          config: { type: 'object' },
        },
        additionalProperties: false,
      },
      param_mapping: { name: 'p_name', projectId: 'p_project_id', dopplerProject: 'p_doppler_project', config: 'p_config' },
      result_mapping: { credential_resource_id: 'credentialResourceId' },
    })
    const client = makeMockClient({
      actionType: at,
      rpcResult: [{ credential_resource_id: 'cred-uuid-123' }],
    })
    const result = await executeAction('create_credential', {
      name: 'my-credential',
      projectId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      dopplerProject: 'my-doppler-project',
    }, client)
    expect(result).toHaveProperty('credentialResourceId', 'cred-uuid-123')
  })

  it('throws descriptive error on invalid input (missing dopplerProject)', async () => {
    const at = makeActionType({
      name: 'create_credential',
      rpc_function: 'create_credential',
      input_schema: {
        '$schema': 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        required: ['name', 'projectId', 'dopplerProject'],
        properties: {
          name: { type: 'string' },
          projectId: { type: 'string', format: 'uuid' },
          dopplerProject: { type: 'string', minLength: 1 },
        },
        additionalProperties: false,
      },
      param_mapping: { name: 'p_name', projectId: 'p_project_id', dopplerProject: 'p_doppler_project' },
      result_mapping: { credential_resource_id: 'credentialResourceId' },
    })
    const client = makeMockClient({ actionType: at })
    await expect(executeAction('create_credential', {
      name: 'my-credential',
      projectId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    }, client))
      .rejects.toThrow('create_credential')
  })
})

// ── create_server ─────────────────────────────────────────────────────────────

describe('executeAction — create_server', () => {
  beforeEach(() => clearCache())

  it('returns serverResourceId on valid input', async () => {
    const at = makeActionType({
      name: 'create_server',
      rpc_function: 'create_server',
      input_schema: {
        '$schema': 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        required: ['name', 'projectId'],
        properties: {
          name: { type: 'string' },
          projectId: { type: 'string', format: 'uuid' },
          config: { type: 'object' },
        },
        additionalProperties: false,
      },
      param_mapping: { name: 'p_name', projectId: 'p_project_id', config: 'p_config' },
      result_mapping: { server_resource_id: 'serverResourceId' },
    })
    const client = makeMockClient({
      actionType: at,
      rpcResult: [{ server_resource_id: 'server-uuid-123' }],
    })
    const result = await executeAction('create_server', {
      name: 'my-server',
      projectId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    }, client)
    expect(result).toHaveProperty('serverResourceId', 'server-uuid-123')
  })

  it('throws descriptive error on invalid input (missing name)', async () => {
    const at = makeActionType({
      name: 'create_server',
      rpc_function: 'create_server',
      input_schema: {
        '$schema': 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        required: ['name', 'projectId'],
        properties: {
          name: { type: 'string' },
          projectId: { type: 'string', format: 'uuid' },
        },
        additionalProperties: false,
      },
      param_mapping: { name: 'p_name', projectId: 'p_project_id' },
      result_mapping: { server_resource_id: 'serverResourceId' },
    })
    const client = makeMockClient({ actionType: at })
    await expect(executeAction('create_server', {
      projectId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    }, client))
      .rejects.toThrow('create_server')
  })
})

// ── assign_credential ─────────────────────────────────────────────────────────

describe('executeAction — assign_credential', () => {
  beforeEach(() => clearCache())

  it('returns created=true on valid input', async () => {
    const at = makeActionType({
      name: 'assign_credential',
      rpc_function: 'assign_credential',
      input_schema: {
        '$schema': 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        required: ['resourceId', 'credentialId'],
        properties: {
          resourceId: { type: 'string', format: 'uuid' },
          credentialId: { type: 'string', format: 'uuid' },
        },
        additionalProperties: false,
      },
      param_mapping: { resourceId: 'p_from_id', credentialId: 'p_to_id' },
      result_mapping: { created: 'created' },
    })
    const client = makeMockClient({
      actionType: at,
      rpcResult: [{ created: true }],
    })
    const result = await executeAction('assign_credential', {
      resourceId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      credentialId: 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    }, client)
    expect(result).toHaveProperty('created', true)
  })

  it('throws descriptive error on invalid input (missing credentialId)', async () => {
    const at = makeActionType({
      name: 'assign_credential',
      rpc_function: 'assign_credential',
      input_schema: {
        '$schema': 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        required: ['resourceId', 'credentialId'],
        properties: {
          resourceId: { type: 'string', format: 'uuid' },
          credentialId: { type: 'string', format: 'uuid' },
        },
        additionalProperties: false,
      },
      param_mapping: { resourceId: 'p_from_id', credentialId: 'p_to_id' },
      result_mapping: { created: 'created' },
    })
    const client = makeMockClient({ actionType: at })
    await expect(executeAction('assign_credential', {
      resourceId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    }, client))
      .rejects.toThrow('assign_credential')
  })
})

// ── assign_proxy ──────────────────────────────────────────────────────────────

describe('executeAction — assign_proxy', () => {
  beforeEach(() => clearCache())

  it('returns created=true on valid input', async () => {
    const at = makeActionType({
      name: 'assign_proxy',
      rpc_function: 'assign_proxy',
      input_schema: {
        '$schema': 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        required: ['resourceId', 'proxyId'],
        properties: {
          resourceId: { type: 'string', format: 'uuid' },
          proxyId: { type: 'string', format: 'uuid' },
        },
        additionalProperties: false,
      },
      param_mapping: { resourceId: 'p_from_id', proxyId: 'p_to_id' },
      result_mapping: { created: 'created' },
    })
    const client = makeMockClient({
      actionType: at,
      rpcResult: [{ created: true }],
    })
    const result = await executeAction('assign_proxy', {
      resourceId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      proxyId: 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    }, client)
    expect(result).toHaveProperty('created', true)
  })

  it('throws descriptive error on invalid input (missing proxyId)', async () => {
    const at = makeActionType({
      name: 'assign_proxy',
      rpc_function: 'assign_proxy',
      input_schema: {
        '$schema': 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        required: ['resourceId', 'proxyId'],
        properties: {
          resourceId: { type: 'string', format: 'uuid' },
          proxyId: { type: 'string', format: 'uuid' },
        },
        additionalProperties: false,
      },
      param_mapping: { resourceId: 'p_from_id', proxyId: 'p_to_id' },
      result_mapping: { created: 'created' },
    })
    const client = makeMockClient({ actionType: at })
    await expect(executeAction('assign_proxy', {
      resourceId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    }, client))
      .rejects.toThrow('assign_proxy')
  })
})

// ── add_project_member ────────────────────────────────────────────────────────

describe('executeAction — add_project_member', () => {
  beforeEach(() => clearCache())

  it('returns created=true on valid input', async () => {
    const at = makeActionType({
      name: 'add_project_member',
      rpc_function: 'add_project_member',
      input_schema: {
        '$schema': 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        required: ['userId', 'projectId'],
        properties: {
          userId: { type: 'string', format: 'uuid' },
          projectId: { type: 'string', format: 'uuid' },
        },
        additionalProperties: false,
      },
      param_mapping: { userId: 'p_from_id', projectId: 'p_to_id' },
      result_mapping: { created: 'created' },
    })
    const client = makeMockClient({
      actionType: at,
      rpcResult: [{ created: true }],
    })
    const result = await executeAction('add_project_member', {
      userId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      projectId: 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    }, client)
    expect(result).toHaveProperty('created', true)
  })

  it('throws descriptive error on invalid input (missing projectId)', async () => {
    const at = makeActionType({
      name: 'add_project_member',
      rpc_function: 'add_project_member',
      input_schema: {
        '$schema': 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        required: ['userId', 'projectId'],
        properties: {
          userId: { type: 'string', format: 'uuid' },
          projectId: { type: 'string', format: 'uuid' },
        },
        additionalProperties: false,
      },
      param_mapping: { userId: 'p_from_id', projectId: 'p_to_id' },
      result_mapping: { created: 'created' },
    })
    const client = makeMockClient({ actionType: at })
    await expect(executeAction('add_project_member', {
      userId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    }, client))
      .rejects.toThrow('add_project_member')
  })
})

// ── listActions ───────────────────────────────────────────────────────────────

describe('listActions', () => {
  it('queries action_types and returns names array', async () => {
    const mockData = [
      { name: 'create_skill' },
      { name: 'create_cron' },
      { name: 'delete_resource' },
    ]
    const client = makeMockClient({ listActionsData: mockData })
    const names = await listActions(client)
    expect(names).toContain('create_skill')
    expect(names).toContain('create_cron')
    expect(Array.isArray(names)).toBe(true)
  })

  it('returns empty array when no actions registered', async () => {
    const client = makeMockClient({ listActionsData: [] })
    const names = await listActions(client)
    expect(Array.isArray(names)).toBe(true)
    expect(names).toHaveLength(0)
  })
})

// ── describeAction ────────────────────────────────────────────────────────────

describe('describeAction', () => {
  it('returns full schema object for named action', async () => {
    const at = makeActionType({ name: 'create_skill' })
    const client = makeMockClient({ describeActionData: at })
    const result = await describeAction('create_skill', client)
    expect(result).not.toBeNull()
    expect(result?.name).toBe('create_skill')
    expect(result?.input_schema).toBeDefined()
  })

  it('returns null for unknown action', async () => {
    const client = makeMockClient({ describeActionData: null })
    const result = await describeAction('nonexistent', client)
    expect(result).toBeNull()
  })
})
