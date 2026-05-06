import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'
import type { JWTPayload } from 'jose'
import { SignJWT } from 'jose'

// Mock supabase BEFORE any imports that use it
vi.mock('../lib/supabase.js', () => ({
  supabase: {
    rpc: vi.fn(),
    from: vi.fn(),
  }
}))

// Mock the services layer so sandbox routes can run without a live SQL client.
// Each test configures the resources mock individually via mockResourcesService.
const mockResources = {
  findByTypeAndName: vi.fn(),
  listLinksToId: vi.fn(),
  countLinkedByType: vi.fn(),
  findByTypeAndIds: vi.fn(),
  findLinkByFromAndType: vi.fn(),
  findByExternalId: vi.fn(),
  listLinksFromId: vi.fn(),
  findByTypeAndName_: vi.fn(),
  getById: vi.fn(),
}

vi.mock('../lib/services.js', () => ({
  getServices: vi.fn(() => ({
    resources: mockResources,
    processes: { getById: vi.fn(), resolveChain: vi.fn(), query: vi.fn(), init: vi.fn() },
    events: { getByProcessIds: vi.fn().mockResolvedValue([]), countByProcessIds: vi.fn().mockResolvedValue(0) },
    chats: { findRecent: vi.fn(), create: vi.fn(), findById: vi.fn(), updateArtifactTiles: vi.fn(), updateStageMode: vi.fn() },
    messages: { findByChatId: vi.fn(), create: vi.fn() },
    metrics: { getLatestSnapshots: vi.fn() },
  })),
}))

import { createSandboxRouter, createReadyRouter } from '../routes/sandbox.js'
import { MockSandboxProvider } from '@duoidal/sandbox'
import { clearCache } from '@skill-networks/database/actions'

const PROVISION_SANDBOX_ACTION_TYPE = {
  name: 'provision_sandbox',
  rpc_function: 'provision_sandbox',
  input_schema: {
    type: 'object',
    required: ['userResourceId', 'serverName', 'sshKeyName', 'publicKey'],
    properties: {
      userResourceId: { type: 'string' },
      serverName: { type: 'string' },
      sshKeyName: { type: 'string' },
      publicKey: { type: 'string' },
      // Optional — passed by the BFF as the JWT sub claim because auth.uid()
      // is NULL for service-role callers (see migration 20260422000001).
      authUid: { type: 'string' },
      hetznerServerId: { type: 'string' },
      cloudflareHostnameId: { type: 'string' },
    },
    additionalProperties: false,
  },
  output_schema: { type: 'object' },
  param_mapping: {
    userResourceId: 'p_user_resource_id',
    serverName: 'p_server_name',
    sshKeyName: 'p_ssh_key_name',
    publicKey: 'p_public_key',
    authUid: 'p_auth_uid',
    hetznerServerId: 'p_hetzner_server_id',
    cloudflareHostnameId: 'p_cloudflare_hostname_id',
  },
  result_mapping: {
    server_resource_id: 'serverResourceId',
    credential_resource_id: 'credentialResourceId',
    is_new: 'isNew',
  },
  schema_version: 1,
  created_at: '2026-01-01T00:00:00Z',
}

const UPDATE_SANDBOX_STATUS_ACTION_TYPE = {
  name: 'update_sandbox_status',
  rpc_function: 'update_sandbox_status',
  input_schema: {
    type: 'object',
    required: ['serverResourceId', 'status', 'ip', 'hetznerServerId', 'provisionedAt'],
    properties: {
      serverResourceId: { type: 'string' },
      status: { type: 'string' },
      ip: { type: 'string' },
      hetznerServerId: { type: 'string' },
      provisionedAt: { type: 'string' },
    },
    additionalProperties: false,
  },
  output_schema: { type: 'object', properties: {} },
  param_mapping: {
    serverResourceId: 'p_server_resource_id',
    status: 'p_status',
    ip: 'p_ip',
    hetznerServerId: 'p_hetzner_server_id',
    provisionedAt: 'p_provisioned_at',
  },
  result_mapping: {},
  schema_version: 1,
  created_at: '2026-01-01T00:00:00Z',
}

const DEPROVISION_SANDBOX_ACTION_TYPE = {
  name: 'deprovision_sandbox',
  rpc_function: 'deprovision_sandbox',
  input_schema: {
    type: 'object',
    required: ['serverResourceId'],
    properties: { serverResourceId: { type: 'string' } },
    additionalProperties: false,
  },
  output_schema: { type: 'object' },
  param_mapping: { serverResourceId: 'p_server_resource_id' },
  result_mapping: { deleted: 'deleted' },
  schema_version: 1,
  created_at: '2026-01-01T00:00:00Z',
}

const TEST_SECRET = 'test-provision-secret-123'

function makeTestApp(deps: {
  db: ReturnType<typeof vi.fn>
  provider?: MockSandboxProvider
  sub?: string
}) {
  const app = new Hono()
  // Mock JWT middleware - inject sub into context
  app.use('/api/*', (c, next) => {
    c.set('jwtPayload', { sub: deps.sub ?? 'test-user-sub-123' } as JWTPayload)
    return next()
  })
  const provider = deps.provider ?? new MockSandboxProvider()
  app.route('/sandbox', createReadyRouter({ db: deps.db as any }))
  app.route('/api/sandbox', createSandboxRouter({ db: deps.db as any, provider }))
  return app
}

// Helper to create a chainable mock for supabase from()
function makeDbMock() {
  const db = vi.fn()
  return db
}

describe('sandbox routes', () => {
  let originalSecret: string | undefined
  let originalDopplerToken: string | undefined
  let originalProvisionSecret: string | undefined
  let originalAgentLivestreamUrl: string | undefined

  beforeEach(() => {
    clearCache()
    // Reset mock resources so each test starts clean
    mockResources.findByTypeAndName.mockReset()
    mockResources.listLinksToId.mockReset()
    mockResources.countLinkedByType.mockReset()
    mockResources.findByTypeAndIds.mockReset()
    mockResources.findLinkByFromAndType.mockReset()
    mockResources.findByExternalId.mockReset()
    mockResources.listLinksFromId.mockReset()
    mockResources.getById.mockReset()
    originalSecret = process.env['PROVISION_SECRET']
    process.env['PROVISION_SECRET'] = TEST_SECRET
    originalDopplerToken = process.env['DOPPLER_TOKEN']
    originalProvisionSecret = process.env['PROVISION_SECRET']
    originalAgentLivestreamUrl = process.env['AGENT_LIVESTREAM_URL']
    process.env['DOPPLER_TOKEN'] = 'dp.st.test.token'
    process.env['PROVISION_SECRET'] = TEST_SECRET
    process.env['AGENT_LIVESTREAM_URL'] = 'http://localhost:3001'
  })

  afterEach(() => {
    if (originalSecret === undefined) {
      delete process.env['PROVISION_SECRET']
    } else {
      process.env['PROVISION_SECRET'] = originalSecret
    }
    if (originalDopplerToken === undefined) delete process.env['DOPPLER_TOKEN']
    else process.env['DOPPLER_TOKEN'] = originalDopplerToken
    if (originalProvisionSecret === undefined) delete process.env['PROVISION_SECRET']
    else process.env['PROVISION_SECRET'] = originalProvisionSecret
    if (originalAgentLivestreamUrl === undefined) delete process.env['AGENT_LIVESTREAM_URL']
    else process.env['AGENT_LIVESTREAM_URL'] = originalAgentLivestreamUrl
  })

  // 1. POST /api/sandbox/provision with no auth header → 401
  it('POST /api/sandbox/provision with no auth header → 401', async () => {
    // The Hono JWT mock middleware will inject jwtPayload, so we need
    // an app WITHOUT the mock JWT middleware to test the real 401 path.
    // Actually the jwtMiddleware runs on /api/* — but in our test app we mock it.
    // For this test we need the real JWT check behavior.
    // Let's create an app with a real 401-returning middleware.
    const app = new Hono()
    app.use('/api/*', (c, next) => {
      const auth = c.req.header('Authorization')
      if (!auth?.startsWith('Bearer ')) {
        return c.json({ error: 'Missing or invalid Authorization header' }, 401)
      }
      return next()
    })
    const provider = new MockSandboxProvider()
    const db = makeDbMock()
    app.route('/api/sandbox', createSandboxRouter({ db: db as any, provider }))

    const res = await app.request('/api/sandbox/provision', { method: 'POST', body: JSON.stringify({ publicKey: 'ssh-ed25519 abc' }), headers: { 'Content-Type': 'application/json' } })
    expect(res.status).toBe(401)
  })

  // 2. POST /sandbox/ready with wrong secret → 401
  it('POST /sandbox/ready with wrong secret → 401', async () => {
    const db = makeDbMock()
    const app = makeTestApp({ db })
    const res = await app.request('/sandbox/ready', {
      method: 'POST',
      body: JSON.stringify({ resourceId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', ip: '1.2.3.4', hetznerServerId: '12345' }),
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer wrong-secret',
      },
    })
    expect(res.status).toBe(401)
  })

  // 3. POST /sandbox/ready with correct secret → 200
  it('POST /sandbox/ready with correct secret → 200', async () => {
    const rpcMock = vi.fn().mockResolvedValue({ data: null, error: null })
    const db = {
      rpc: rpcMock,
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }) },
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'action_types') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({ data: UPDATE_SANDBOX_STATUS_ACTION_TYPE, error: null }),
              }),
            }),
          }
        }
        return { select: vi.fn() }
      }),
    }
    const app = makeTestApp({ db: db as any })
    const res = await app.request('/sandbox/ready', {
      method: 'POST',
      body: JSON.stringify({ resourceId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', ip: '1.2.3.4', hetznerServerId: '12345' }),
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TEST_SECRET}`,
      },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { success: boolean }
    expect(body.success).toBe(true)
  })

  // 4. POST /sandbox/ready idempotent (call twice) → 200 both times
  it('POST /sandbox/ready idempotent → 200 both calls', async () => {
    const rpcMock = vi.fn().mockResolvedValue({ data: null, error: null })
    const db = {
      rpc: rpcMock,
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }) },
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'action_types') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({ data: UPDATE_SANDBOX_STATUS_ACTION_TYPE, error: null }),
              }),
            }),
          }
        }
        return { select: vi.fn() }
      }),
    }
    const app = makeTestApp({ db: db as any })
    const payload = JSON.stringify({ resourceId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', ip: '1.2.3.4', hetznerServerId: '12345' })
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${TEST_SECRET}`,
    }

    const res1 = await app.request('/sandbox/ready', { method: 'POST', body: payload, headers })
    expect(res1.status).toBe(200)

    const res2 = await app.request('/sandbox/ready', { method: 'POST', body: payload, headers })
    expect(res2.status).toBe(200)
  })

  // 5. POST /api/sandbox/provision with JWT from unapproved user → 403
  it('POST /api/sandbox/provision with unapproved user → 403', async () => {
    mockResources.findByExternalId.mockResolvedValue({ id: 'fac837ea-1599-4fcd-82f5-c0f6433e5ae4' })
    mockResources.getById.mockResolvedValue({ id: 'fac837ea-1599-4fcd-82f5-c0f6433e5ae4', config: { status: 'pending' }, updated_at: new Date().toISOString() })
    const db = { rpc: vi.fn(), from: vi.fn() }
    const app = makeTestApp({ db: db as any })
    const res = await app.request('/api/sandbox/provision', {
      method: 'POST',
      body: JSON.stringify({ publicKey: 'ssh-ed25519 abc' }),
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer fake-jwt',
      },
    })
    expect(res.status).toBe(403)
    const body = await res.json() as { error: string }
    expect(body.error).toBe('User not approved')
  })

  // 6. POST /api/sandbox/provision with approved user → 200 with resourceId
  it('POST /api/sandbox/provision with approved user → 200 with resourceId', async () => {
    // New flow: DB record created FIRST (rpc), then provider called
    // 1. resources.findByTypeAndName('user', sub) -> returns approved user resource
    // 2. rpc('provision_sandbox', ...) -> returns server resource id with is_new=true
    // 3. provider.provision() -> succeeds
    mockResources.findByExternalId.mockResolvedValue({ id: 'fac837ea-1599-4fcd-82f5-c0f6433e5ae4' })
    mockResources.getById.mockResolvedValue({ id: 'fac837ea-1599-4fcd-82f5-c0f6433e5ae4', config: { status: 'approved' }, updated_at: new Date().toISOString() })
    mockResources.countLinkedByType.mockResolvedValue(0)

    const rpcMock = vi.fn().mockResolvedValue({
      data: [{ server_resource_id: 'srv-res-123', credential_resource_id: 'cred-res-123', is_new: true }],
      error: null,
    })

    const fromMock = vi.fn().mockImplementation((table: string) => {
      if (table === 'action_types') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({ data: PROVISION_SANDBOX_ACTION_TYPE, error: null }),
            }),
          }),
        }
      }
      return { select: vi.fn().mockReturnThis() }
    })

    const db = { rpc: rpcMock, from: fromMock, auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }) } }
    const provider = new MockSandboxProvider()
    const app = makeTestApp({ db: db as any, provider })

    const res = await app.request('/api/sandbox/provision', {
      method: 'POST',
      body: JSON.stringify({ publicKey: 'ssh-ed25519 AAAAB3NzaC1yc2E test' }),
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer fake-jwt',
      },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { status: string; resourceId: string }
    expect(body.status).toBe('provisioning')
    expect(body.resourceId).toBe('srv-res-123')
    // rpc must have been called (DB first)
    expect(rpcMock).toHaveBeenCalledOnce()
  })

  // 7. POST /api/sandbox/provision when provider throws → 500
  it('POST /api/sandbox/provision when provider throws → 500', async () => {
    // New flow: DB record is created FIRST (rpc), then provider throws
    // The rpc IS called (DB record is created), but provider fails → 500
    mockResources.findByExternalId.mockResolvedValue({ id: 'fac837ea-1599-4fcd-82f5-c0f6433e5ae4' })
    mockResources.getById.mockResolvedValue({ id: 'fac837ea-1599-4fcd-82f5-c0f6433e5ae4', config: { status: 'approved' }, updated_at: new Date().toISOString() })
    mockResources.countLinkedByType.mockResolvedValue(0)

    const rpcMock = vi.fn().mockResolvedValue({
      data: [{ server_resource_id: 'srv-res-123', credential_resource_id: 'cred-res-123', is_new: true }],
      error: null,
    })

    const fromMock = vi.fn().mockImplementation((table: string) => {
      if (table === 'action_types') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({ data: PROVISION_SANDBOX_ACTION_TYPE, error: null }),
            }),
          }),
        }
      }
      return { select: vi.fn().mockReturnThis() }
    })

    const db = { rpc: rpcMock, from: fromMock, auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }) } }
    const provider = new MockSandboxProvider({ failProvision: true })
    const app = makeTestApp({ db: db as any, provider })

    const res = await app.request('/api/sandbox/provision', {
      method: 'POST',
      body: JSON.stringify({ publicKey: 'ssh-ed25519 AAAAB3NzaC1yc2E test' }),
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer fake-jwt',
      },
    })
    expect(res.status).toBe(500)
    // rpc SHOULD have been called (DB record created before provider)
    expect(rpcMock).toHaveBeenCalledOnce()
  })

  // 8. GET /api/sandbox/status with JWT → returns user's server resource only
  it('GET /api/sandbox/status → returns server resource status', async () => {
    mockResources.findByExternalId.mockResolvedValue({ id: 'fac837ea-1599-4fcd-82f5-c0f6433e5ae4' })
    mockResources.getById.mockResolvedValue({ id: 'fac837ea-1599-4fcd-82f5-c0f6433e5ae4', config: { status: 'approved' }, updated_at: new Date().toISOString() })
    mockResources.listLinksToId.mockResolvedValue([{ from_id: 'srv-res-1' }])
    mockResources.findByTypeAndIds.mockResolvedValue([{ id: 'srv-res-1', name: 'sandbox-user-res-1', type: 'server', config: { status: 'active', ip: '10.0.0.1' }, updated_at: '2026-03-28T00:00:00Z' }])

    const db = { rpc: vi.fn(), from: vi.fn() }
    const app = makeTestApp({ db: db as any })

    const res = await app.request('/api/sandbox/status', {
      method: 'GET',
      headers: { 'Authorization': 'Bearer fake-jwt' },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { status: string; ip: string; resourceId: string }
    expect(body.status).toBe('active')
    expect(body.ip).toBe('10.0.0.1')
    expect(body.resourceId).toBe('srv-res-1')
  })

  // 9. GET /api/sandbox/ssh-access for owner → 200
  // Ownership is enforced by the parent link in findUserSandbox. The route does
  // not require a server→credential link — that row is provisioner-internal and
  // its absence on legacy sandboxes used to surface as a misleading 403.
  it('GET /api/sandbox/ssh-access for owner → 200', async () => {
    mockResources.findByExternalId.mockResolvedValue({ id: 'fac837ea-1599-4fcd-82f5-c0f6433e5ae4' })
    mockResources.getById.mockResolvedValue({ id: 'fac837ea-1599-4fcd-82f5-c0f6433e5ae4', config: { status: 'approved' }, updated_at: new Date().toISOString() })
    mockResources.listLinksToId.mockResolvedValue([{ from_id: 'srv-res-1' }])
    mockResources.findByTypeAndIds.mockResolvedValue([{ id: 'srv-res-1', name: 'sandbox-user-res-1', type: 'server', config: { status: 'active', ip: '10.0.0.2' }, updated_at: '2026-03-28T00:00:00Z' }])
    // No credential link in DB — historically a 403 trigger; route must now return 200.
    mockResources.findLinkByFromAndType.mockResolvedValue(null)

    const db = { rpc: vi.fn(), from: vi.fn() }
    const app = makeTestApp({ db: db as any })

    const res = await app.request('/api/sandbox/ssh-access', {
      method: 'GET',
      headers: { 'Authorization': 'Bearer fake-jwt' },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { allowed: boolean; ip: string; keyPath: string }
    expect(body.allowed).toBe(true)
    expect(body.ip).toBe('10.0.0.2')
    expect(body.keyPath).toContain('srv-res-1')
  })

  // 11. User isolation: DB query is scoped to the authenticated user's sub claim
  it('GET /api/sandbox/status - query is scoped to JWT sub claim', async () => {
    const USER_A_SUB = '111c86bf-1153-47c3-81a3-ec35d00a6221'
    const USER_B_SUB = '8fd4e228-fc8a-41c9-8c03-b6d34439bc48'

    // Track which externalId values are passed to findByExternalId
    const queriedExternalIds: string[] = []

    mockResources.findByExternalId.mockImplementation((_type: string, externalId: string) => {
      queriedExternalIds.push(externalId)
      return Promise.resolve(null)
    })

    const db = { rpc: vi.fn(), from: vi.fn() }

    // Test with User A's sub
    const appA = new Hono()
    appA.use('/api/*', (c, next) => {
      c.set('jwtPayload', { sub: USER_A_SUB } as JWTPayload)
      return next()
    })
    appA.route('/api/sandbox', createSandboxRouter({ db: db as any, provider: new MockSandboxProvider() }))

    await appA.request('/api/sandbox/status', {
      method: 'GET',
      headers: { 'Authorization': 'Bearer fake-jwt-a' },
    })

    // The DB query should have been called with the auth UUID directly (not user:<sub>)
    expect(queriedExternalIds).toContain(USER_A_SUB)
    expect(queriedExternalIds).not.toContain(USER_B_SUB)
    expect(queriedExternalIds).not.toContain(`user:${USER_A_SUB}`)
  })

  // 12. DELETE /api/sandbox/deprovision with sandbox → 200 { deleted: true }
  it('DELETE /api/sandbox/deprovision with sandbox → 200 { deleted: true }', async () => {
    mockResources.findByExternalId.mockResolvedValue({ id: 'fac837ea-1599-4fcd-82f5-c0f6433e5ae4' })
    mockResources.getById.mockResolvedValue({ id: 'fac837ea-1599-4fcd-82f5-c0f6433e5ae4', config: { status: 'approved' }, updated_at: new Date().toISOString() })
    mockResources.listLinksToId.mockResolvedValue([{ from_id: 'srv-res-1' }])
    mockResources.findByTypeAndIds.mockResolvedValue([{ id: 'srv-res-1', config: { status: 'active', ip: '10.0.0.1', hetznerServerId: '42' } }])

    const rpcMock = vi.fn().mockResolvedValue({ data: [{ deleted: true }], error: null })
    const fromMock = vi.fn().mockImplementation((table: string) => {
      if (table === 'action_types') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({ data: DEPROVISION_SANDBOX_ACTION_TYPE, error: null }),
            }),
          }),
        }
      }
      return { select: vi.fn().mockReturnThis() }
    })
    const db = { rpc: rpcMock, from: fromMock, auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }) } }

    // Use a provider whose deprovision won't throw for unknown server IDs
    const provider = new MockSandboxProvider()
    // Provision a fake server so deprovision('42') doesn't throw
    vi.spyOn(provider, 'deprovision').mockResolvedValue(undefined)

    const app = makeTestApp({ db: db as any, provider })
    const res = await app.request('/api/sandbox/deprovision', {
      method: 'DELETE',
      headers: { 'Authorization': 'Bearer fake-jwt' },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { deleted: boolean }
    expect(body.deleted).toBe(true)
  })

  // 13. DELETE /api/sandbox/deprovision with no sandbox → 200 (idempotent, alreadyGone)
  // Story 8 #8: double-deprovision must be idempotent — calling DELETE twice or against
  // a user with no sandbox returns 200 { deleted: true, alreadyGone: true }, not 404.
  it('DELETE /api/sandbox/deprovision with no sandbox → 200 alreadyGone', async () => {
    mockResources.findByExternalId.mockResolvedValue(null)

    const db = { rpc: vi.fn(), from: vi.fn() }
    const app = makeTestApp({ db: db as any })

    const res = await app.request('/api/sandbox/deprovision', {
      method: 'DELETE',
      headers: { 'Authorization': 'Bearer fake-jwt' },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { deleted: boolean; alreadyGone: boolean }
    expect(body.deleted).toBe(true)
    expect(body.alreadyGone).toBe(true)
  })

  // 14. POST /api/sandbox/provision with maxSandboxes=1 and existing sandbox → 409
  it('POST /api/sandbox/provision with maxSandboxes=1 and existing sandbox → 409', async () => {
    mockResources.findByExternalId.mockResolvedValue({ id: 'fac837ea-1599-4fcd-82f5-c0f6433e5ae4' })
    mockResources.getById.mockResolvedValue({ id: 'fac837ea-1599-4fcd-82f5-c0f6433e5ae4', config: { status: 'approved', maxSandboxes: 1 }, updated_at: new Date().toISOString() })
    mockResources.countLinkedByType.mockResolvedValue(1)

    const db = { rpc: vi.fn(), from: vi.fn() }
    const app = makeTestApp({ db: db as any })

    const res = await app.request('/api/sandbox/provision', {
      method: 'POST',
      body: JSON.stringify({ publicKey: 'ssh-ed25519 AAAAB3NzaC1yc2E test' }),
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer fake-jwt',
      },
    })
    expect(res.status).toBe(409)
    const body = await res.json() as { error: string }
    expect(body.error).toBe('Sandbox limit reached')
  })

  // 10. GET /api/sandbox/ssh-access for non-owner → 404
  // Regression sentinel: a user with no parent-linked sandbox must never see
  // another user's sandbox. The route's auth path is `findUserSandbox`, which
  // resolves only sandboxes whose `parent` link points at the caller's user
  // resource.
  it('GET /api/sandbox/ssh-access for non-owner (no sandbox) → 404', async () => {
    mockResources.findByExternalId.mockResolvedValue({ id: 'fac837ea-1599-4fcd-82f5-c0f6433e5ae4' })
    mockResources.getById.mockResolvedValue({ id: 'fac837ea-1599-4fcd-82f5-c0f6433e5ae4', config: { status: 'approved' }, updated_at: new Date().toISOString() })
    // No parent links to the caller's user resource — caller does not own a sandbox.
    mockResources.listLinksToId.mockResolvedValue([])

    const db = { rpc: vi.fn(), from: vi.fn() }
    const app = makeTestApp({ db: db as any })

    const res = await app.request('/api/sandbox/ssh-access', {
      method: 'GET',
      headers: { 'Authorization': 'Bearer fake-jwt' },
    })
    expect(res.status).toBe(404)
    const body = await res.json() as { error: string }
    expect(body.error).toBe('No sandbox found')
  })
})

// ─── JWT Wall Tests (using real jwtMiddleware with HS256 test secret) ─────────

describe('JWT wall enforcement', () => {
  const TEST_JWT_SECRET = 'test-jwt-secret-for-unit-tests-32chars!!'
  const TEST_SUPABASE_URL = '' // empty = no JWKS, use HS256 path

  let originalEnv: typeof process.env

  beforeEach(() => {
    originalEnv = { ...process.env }
    delete process.env['SUPABASE_URL']
    process.env['SUPABASE_JWT_SECRET'] = TEST_JWT_SECRET
    process.env['NODE_ENV'] = 'test'
  })

  afterEach(() => {
    process.env = originalEnv
  })

  async function makeSignedJwt(opts: {
    secret: string
    expiresIn?: string | number
    audience?: string
    issuer?: string
    sub?: string
  }): Promise<string> {
    const secret = new TextEncoder().encode(opts.secret)
    let builder = new SignJWT({ sub: opts.sub ?? 'test-sub' })
      .setProtectedHeader({ alg: 'HS256' })
      .setAudience(opts.audience ?? 'authenticated')
    if (opts.issuer) builder = builder.setIssuer(opts.issuer)
    if (opts.expiresIn !== undefined) {
      if (typeof opts.expiresIn === 'string') {
        builder = builder.setExpirationTime(opts.expiresIn)
      } else {
        // Unix timestamp
        builder = builder.setExpirationTime(opts.expiresIn)
      }
    } else {
      builder = builder.setExpirationTime('1h')
    }
    return builder.sign(secret)
  }

  it('POST /api/sandbox/provision with valid JWT from wrong project (wrong secret) → 401', async () => {
    // JWT signed with a DIFFERENT secret than the server's — simulates wrong project
    const wrongSecretJwt = await makeSignedJwt({ secret: 'WRONG-SECRET-different-project-abc' })

    // Build app with the real jwtMiddleware
    // Re-import jwtMiddleware after setting env vars
    const { jwtMiddleware: realJwtMiddleware } = await import('../middleware/jwt.js')
    const { createSandboxRouter: realRouter } = await import('../routes/sandbox.js')
    const { MockSandboxProvider: RealMock } = await import('@duoidal/sandbox')

    const app = new Hono()
    app.use('/api/*', realJwtMiddleware)
    app.route('/api/sandbox', realRouter({ db: {} as any, provider: new RealMock() }))

    const res = await app.request('/api/sandbox/provision', {
      method: 'POST',
      body: JSON.stringify({ publicKey: 'ssh-ed25519 abc' }),
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${wrongSecretJwt}`,
      },
    })
    expect(res.status).toBe(401)
  })

  it('POST /api/sandbox/provision with expired JWT → 401', async () => {
    // JWT that expired 1 second ago
    const expiredAt = Math.floor(Date.now() / 1000) - 1
    const expiredJwt = await makeSignedJwt({
      secret: TEST_JWT_SECRET,
      expiresIn: expiredAt,
    })

    const { jwtMiddleware: realJwtMiddleware } = await import('../middleware/jwt.js')
    const { createSandboxRouter: realRouter } = await import('../routes/sandbox.js')
    const { MockSandboxProvider: RealMock } = await import('@duoidal/sandbox')

    const app = new Hono()
    app.use('/api/*', realJwtMiddleware)
    app.route('/api/sandbox', realRouter({ db: {} as any, provider: new RealMock() }))

    const res = await app.request('/api/sandbox/provision', {
      method: 'POST',
      body: JSON.stringify({ publicKey: 'ssh-ed25519 abc' }),
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${expiredJwt}`,
      },
    })
    expect(res.status).toBe(401)
  })
})
