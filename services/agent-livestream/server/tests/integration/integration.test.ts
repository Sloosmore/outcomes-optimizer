/**
 * L2 Integration Tests — Real Hetzner API (duoidal-test project)
 *
 * Combines provisioning tests and concurrent idempotency tests in one file
 * to ensure sequential execution (vitest runs tests within a file sequentially).
 *
 * Run with:
 *   HETZNER_TEST_API_TOKEN=<token> PROVISION_SECRET=<secret> NODE_ENV=integration npx vitest run services/agent-livestream/server/tests/integration/
 *
 * These tests:
 * - Call the real Hetzner API in the duoidal-test project
 * - Use the real Supabase DB
 * - Clean up all created servers after each test
 */
import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { HetznerProvider } from '@duoidal/sandbox'
import { createSandboxRouter, createReadyRouter } from '../../routes/sandbox.js'
import { Hono } from 'hono'
import type { JWTPayload } from 'jose'

const HETZNER_TEST_TOKEN = process.env['HETZNER_TEST_API_TOKEN']
const PROVISION_SECRET_VAL = process.env['PROVISION_SECRET'] ?? 'test-secret'
const SUPABASE_URL = process.env['SUPABASE_URL']!
const SUPABASE_SERVICE_KEY = process.env['SUPABASE_SERVICE_KEY']!

const SKIP = !HETZNER_TEST_TOKEN

async function hetznerDelete(serverId: string): Promise<void> {
  if (!HETZNER_TEST_TOKEN) return
  const res = await fetch(`https://api.hetzner.cloud/v1/servers/${serverId}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${HETZNER_TEST_TOKEN}` },
  })
  if (res.status !== 204 && res.status !== 200 && res.status !== 404) {
    console.warn(`Failed to delete Hetzner server ${serverId}: HTTP ${res.status}`)
  }
}

async function hetznerListServers(): Promise<Array<{ id: number; name: string }>> {
  if (!HETZNER_TEST_TOKEN) return []
  const res = await fetch('https://api.hetzner.cloud/v1/servers?per_page=50', {
    headers: { 'Authorization': `Bearer ${HETZNER_TEST_TOKEN}` },
  })
  const data = await res.json() as { servers: Array<{ id: number; name: string }> }
  return data.servers ?? []
}

async function hetznerHasNoPrimaryIps(): Promise<boolean> {
  if (!HETZNER_TEST_TOKEN) return true
  const res = await fetch('https://api.hetzner.cloud/v1/primary_ips?per_page=50', {
    headers: { 'Authorization': `Bearer ${HETZNER_TEST_TOKEN}` },
  })
  const data = await res.json() as { primary_ips: Array<{ id: number }> }
  return (data.primary_ips ?? []).length === 0
}

async function hetznerWaitForClean(label: string): Promise<void> {
  // Wait until Hetzner has 0 servers AND 0 primary IPs (IPs may linger after server deletion)
  for (let i = 0; i < 60; i++) {
    const servers = await hetznerListServers()
    const noIps = await hetznerHasNoPrimaryIps()
    if (servers.length === 0 && noIps) return
    if (i === 0 || i % 5 === 0) {
      console.log(`[${label}] Waiting for Hetzner cleanup: ${servers.length} servers, ips_free=${noIps} (attempt ${i + 1})`)
    }
    await new Promise(r => setTimeout(r, 2_000))
  }
  console.warn(`[${label}] Hetzner cleanup timed out after 120s`)
}

async function hetznerDeleteSshKeyByName(keyName: string): Promise<void> {
  if (!HETZNER_TEST_TOKEN) return
  const res = await fetch(`https://api.hetzner.cloud/v1/ssh_keys?name=${encodeURIComponent(keyName)}`, {
    headers: { 'Authorization': `Bearer ${HETZNER_TEST_TOKEN}` },
  })
  const data = await res.json() as { ssh_keys: Array<{ id: number; name: string }> }
  for (const key of data.ssh_keys ?? []) {
    await fetch(`https://api.hetzner.cloud/v1/ssh_keys/${key.id}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${HETZNER_TEST_TOKEN}` },
    })
  }
}

// ---------------------------------------------------------------------------
// Suite 1: Sandbox Provisioning
// ---------------------------------------------------------------------------

describe.skipIf(SKIP)('L2 integration: sandbox provisioning', () => {
  let db: ReturnType<typeof createClient>
  const createdHetznerServerIds: string[] = []
  const createdResourceNames: string[] = []

  let userAResourceId: string
  let userBResourceId: string
  let userAName: string
  let userBName: string

  beforeAll(async () => {
    db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

    userAName = `test-user-a-${Date.now()}`
    userBName = `test-user-b-${Date.now()}`

    const { data: userA, error: errA } = await db
      .from('resources')
      .insert({ name: userAName, type: 'user', status: 'active', config: { status: 'approved' } })
      .select('id')
      .single()
    if (errA) throw new Error(`Failed to create User A: ${errA.message}`)
    userAResourceId = userA.id
    createdResourceNames.push(userAName)

    const { data: userB, error: errB } = await db
      .from('resources')
      .insert({ name: userBName, type: 'user', status: 'active', config: { status: 'approved' } })
      .select('id')
      .single()
    if (errB) throw new Error(`Failed to create User B: ${errB.message}`)
    userBResourceId = userB.id
    createdResourceNames.push(userBName)
  })

  afterEach(async () => {
    for (const id of [...createdHetznerServerIds]) {
      await hetznerDelete(id)
    }
    createdHetznerServerIds.length = 0

    const sshKeyNames = createdResourceNames.filter(n => n.startsWith('sshkey-'))
    for (const keyName of sshKeyNames) {
      await hetznerDeleteSshKeyByName(keyName)
    }
    for (const userId of [userAResourceId, userBResourceId]) {
      if (userId) await hetznerDeleteSshKeyByName(`sshkey-${userId}`)
    }

    const namesToClean = createdResourceNames.filter(n => n.startsWith('sandbox-') || n.startsWith('sshkey-'))
    for (const name of namesToClean) {
      const { data: res } = await db.from('resources').select('id').eq('name', name).maybeSingle()
      if (res?.id) {
        await db.from('resource_links').delete().eq('from_id', res.id)
        await db.from('resource_links').delete().eq('to_id', res.id)
        await db.from('resources').delete().eq('id', res.id)
      }
      const idx = createdResourceNames.indexOf(name)
      if (idx !== -1) createdResourceNames.splice(idx, 1)
    }

    // Wait for Hetzner to fully release servers + Primary IPs before the next test
    await hetznerWaitForClean('afterEach suite-1')
  }, 120_000)

  afterAll(async () => {
    if (db) {
      const namesToClean = [...new Set([...createdResourceNames, userAName, userBName].filter(Boolean))]
      for (const name of namesToClean) {
        const { data: res } = await db.from('resources').select('id').eq('name', name).maybeSingle()
        if (res?.id) {
          await db.from('resource_links').delete().eq('from_id', res.id)
          await db.from('resource_links').delete().eq('to_id', res.id)
          await db.from('resources').delete().eq('id', res.id)
        }
      }
    }
  }, 60_000)

  it('provision creates exactly 1 server in duoidal-test project', async () => {
    const provider = new HetznerProvider(HETZNER_TEST_TOKEN!)
    process.env['PROVISION_SECRET'] = PROVISION_SECRET_VAL

    const app = new Hono<{ Variables: { jwtPayload: JWTPayload } }>()
    app.use('/api/*', (c, next) => {
      c.set('jwtPayload', { sub: userAName } as JWTPayload)
      return next()
    })
    app.route('/api/sandbox', createSandboxRouter({ db: db as any, provider }))

    const serversBefore = await hetznerListServers()
    const countBefore = serversBefore.length

    const res = await app.request('/api/sandbox/provision', {
      method: 'POST',
      body: JSON.stringify({ publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIL3DXWxzZpJNOqvCo6cdiFByqjB6PULw9ZivunXJ0RvH test@integration' }),
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer test-jwt' },
    })

    const body = await res.json() as { status: string; resourceId: string; error?: string }
    if (res.status !== 200) console.error('provision failed:', body)
    expect(res.status).toBe(200)
    expect(body.status).toBe('provisioning')
    expect(body.resourceId).toBeTruthy()

    const serversAfter = await hetznerListServers()
    expect(serversAfter.length).toBe(countBefore + 1)

    const newServer = serversAfter.find(s => !serversBefore.find(b => b.id === s.id))
    if (newServer) createdHetznerServerIds.push(String(newServer.id))

    createdResourceNames.push(`sandbox-${userAResourceId}`)
    createdResourceNames.push(`sshkey-${userAResourceId}`)
  }, 60_000)

  it('/sandbox/ready callback completes graph (status=active, ip, hetzner_server_id set)', async () => {
    const provider = new HetznerProvider(HETZNER_TEST_TOKEN!)
    process.env['PROVISION_SECRET'] = PROVISION_SECRET_VAL

    const app = new Hono<{ Variables: { jwtPayload: JWTPayload } }>()
    app.use('/api/*', (c, next) => {
      c.set('jwtPayload', { sub: userBName } as JWTPayload)
      return next()
    })
    const readyApp = new Hono()
    const readyRouter = createReadyRouter({ db: db as any })
    app.route('/api/sandbox', createSandboxRouter({ db: db as any, provider }))
    readyApp.route('/sandbox', readyRouter)

    const provisionRes = await app.request('/api/sandbox/provision', {
      method: 'POST',
      body: JSON.stringify({ publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIL3DXWxzZpJNOqvCo6cdiFByqjB6PULw9ZivunXJ0RvH test@integration' }),
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer test-jwt' },
    })
    expect(provisionRes.status).toBe(200)
    const { resourceId } = await provisionRes.json() as { resourceId: string }
    createdResourceNames.push(`sandbox-${userBResourceId}`)
    createdResourceNames.push(`sshkey-${userBResourceId}`)

    const serversAfter = await hetznerListServers()
    const sandboxServer = serversAfter.find(s => s.name === `sandbox-${userBResourceId}`)
    if (sandboxServer) createdHetznerServerIds.push(String(sandboxServer.id))

    const readyRes = await readyApp.request('/sandbox/ready', {
      method: 'POST',
      body: JSON.stringify({
        resourceId,
        ip: '10.0.0.99',
        hetznerServerId: 'h-99999',
      }),
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${PROVISION_SECRET_VAL}`,
      },
    })
    expect(readyRes.status).toBe(200)

    const { data: serverResource } = await db
      .from('resources')
      .select('id, config')
      .eq('name', `sandbox-${userBResourceId}`)
      .single()

    expect(serverResource).toBeTruthy()
    const cfg = serverResource?.config as Record<string, unknown>
    expect(cfg['status']).toBe('active')
    expect(cfg['ip']).toBe('10.0.0.99')
    expect(cfg['provisioned_at']).toBeTruthy()

    const { data: parentLink } = await db
      .from('resource_links')
      .select('to_id')
      .eq('from_id', serverResource?.id)
      .eq('link_type', 'parent')
      .single()
    expect(parentLink?.to_id).toBe(userBResourceId)

    const { data: credLink } = await db
      .from('resource_links')
      .select('to_id')
      .eq('from_id', serverResource?.id)
      .eq('link_type', 'credential')
      .single()
    expect(credLink?.to_id).toBeTruthy()
  }, 90_000)

  it('no raw secrets in user_data', async () => {
    let capturedUserData: string | null = null
    const originalFetch = globalThis.fetch

    const capturingFetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      if (typeof url === 'string' && url.includes('/v1/servers') && init?.method === 'POST') {
        const body = JSON.parse(init.body as string) as Record<string, unknown>
        capturedUserData = body['user_data'] as string
      }
      return originalFetch(url, init)
    }

    globalThis.fetch = capturingFetch as typeof fetch

    let freshUserId: string | undefined
    try {
      const provider = new HetznerProvider(HETZNER_TEST_TOKEN!)

      const freshUserName = `test-secrets-check-${Date.now()}`
      const { data: freshUser } = await db
        .from('resources')
        .insert({ name: freshUserName, type: 'user', status: 'active', config: { status: 'approved' } })
        .select('id')
        .single()
      createdResourceNames.push(freshUserName)
      freshUserId = freshUser?.id

      const app = new Hono<{ Variables: { jwtPayload: JWTPayload } }>()
      app.use('/api/*', (c, next) => {
        c.set('jwtPayload', { sub: freshUserName } as JWTPayload)
        return next()
      })
      app.route('/api/sandbox', createSandboxRouter({ db: db as any, provider }))

      const res = await app.request('/api/sandbox/provision', {
        method: 'POST',
        body: JSON.stringify({ publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIL3DXWxzZpJNOqvCo6cdiFByqjB6PULw9ZivunXJ0RvH test@integration' }),
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer test-jwt' },
      })

      if (res.status === 200 && freshUserId) {
        const serversAfter = await hetznerListServers()
        const newServer = serversAfter.find(s => s.name === `sandbox-${freshUserId}`)
        if (newServer) createdHetznerServerIds.push(String(newServer.id))
        createdResourceNames.push(`sandbox-${freshUserId}`)
        createdResourceNames.push(`sshkey-${freshUserId}`)
      }
    } finally {
      globalThis.fetch = originalFetch
    }

    expect(capturedUserData).not.toBeNull()
    expect(capturedUserData).not.toContain('DATABASE_URL')
    expect(capturedUserData).not.toContain('ANTHROPIC_API_KEY')
    expect(capturedUserData).not.toContain('GH_TOKEN')
    expect(capturedUserData).not.toContain('SUPABASE_SERVICE_KEY')
    expect(capturedUserData).not.toContain('HETZNER_API_TOKEN')
  }, 60_000)
})

// ---------------------------------------------------------------------------
// Suite 2: Concurrent Idempotency
// ---------------------------------------------------------------------------

describe.skipIf(SKIP)('L2 integration: concurrent idempotency', () => {
  let db: ReturnType<typeof createClient>
  let concurrentUserName: string
  let concurrentUserId: string

  const createdHetznerServerIds: string[] = []
  const createdResourceNames: string[] = []

  beforeAll(async () => {
    db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

    // Wait for any servers/IPs from previous suite to be fully released in Hetzner
    // Hetzner has a Primary IP limit; IPs persist briefly after server deletion
    await hetznerWaitForClean('beforeAll suite-2')

    concurrentUserName = `test-concurrent-${Date.now()}`
    const { data: user, error } = await db
      .from('resources')
      .insert({ name: concurrentUserName, type: 'user', status: 'active', config: { status: 'approved' } })
      .select('id')
      .single()
    if (error) throw new Error(`Failed to create test user: ${error.message}`)
    concurrentUserId = user.id
    createdResourceNames.push(concurrentUserName)
  }, 180_000)

  afterEach(async () => {
    for (const id of [...createdHetznerServerIds]) {
      await hetznerDelete(id)
    }
    createdHetznerServerIds.length = 0

    const sshKeyNames = createdResourceNames.filter(n => n.startsWith('sshkey-'))
    for (const keyName of sshKeyNames) {
      await hetznerDeleteSshKeyByName(keyName)
    }
    if (concurrentUserId) await hetznerDeleteSshKeyByName(`sshkey-${concurrentUserId}`)

    const namesToClean = createdResourceNames.filter(n => n.startsWith('sandbox-') || n.startsWith('sshkey-'))
    for (const name of namesToClean) {
      const { data: res } = await db.from('resources').select('id').eq('name', name).maybeSingle()
      if (res?.id) {
        await db.from('resource_links').delete().eq('from_id', res.id)
        await db.from('resource_links').delete().eq('to_id', res.id)
        await db.from('resources').delete().eq('id', res.id)
      }
      const idx = createdResourceNames.indexOf(name)
      if (idx !== -1) createdResourceNames.splice(idx, 1)
    }
  }, 90_000)

  afterAll(async () => {
    if (db && concurrentUserName) {
      const { data: res } = await db.from('resources').select('id').eq('name', concurrentUserName).maybeSingle()
      if (res?.id) {
        await db.from('resource_links').delete().eq('from_id', res.id)
        await db.from('resource_links').delete().eq('to_id', res.id)
        await db.from('resources').delete().eq('id', res.id)
      }
    }
  }, 30_000)

  it('two simultaneous provision requests result in exactly 1 Hetzner server and 1 DB resource', async () => {
    const provider = new HetznerProvider(HETZNER_TEST_TOKEN!)
    process.env['PROVISION_SECRET'] = PROVISION_SECRET_VAL

    const serversBefore = await hetznerListServers()
    const countBefore = serversBefore.length

    const makeApp = () => {
      const app = new Hono<{ Variables: { jwtPayload: JWTPayload } }>()
      app.use('/api/*', (c, next) => {
        c.set('jwtPayload', { sub: concurrentUserName } as JWTPayload)
        return next()
      })
      app.route('/api/sandbox', createSandboxRouter({ db: db as any, provider }))
      return app
    }

    const app1 = makeApp()
    const app2 = makeApp()

    const makeRequest = (app: ReturnType<typeof makeApp>) =>
      app.request('/api/sandbox/provision', {
        method: 'POST',
        body: JSON.stringify({ publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEh3ZkLAmWTKEA7pPCfppF9fo3KbU8wz+ZZEXTxyPQpU idempotency@integration' }),
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer test-jwt' },
      })

    const [res1, res2] = await Promise.all([makeRequest(app1), makeRequest(app2)])

    // Log errors for debugging
    if (res1.status !== 200) {
      const b = await res1.clone().json() as Record<string, unknown>
      console.error('res1 failed:', res1.status, b)
    }
    if (res2.status !== 200) {
      const b = await res2.clone().json() as Record<string, unknown>
      console.error('res2 failed:', res2.status, b)
    }

    expect(res1.status).toBe(200)
    expect(res2.status).toBe(200)

    const body1 = await res1.json() as { status: string; resourceId: string }
    const body2 = await res2.json() as { status: string; resourceId: string }

    expect(body1.resourceId).toBe(body2.resourceId)

    await new Promise(r => setTimeout(r, 3_000))

    const serversAfter = await hetznerListServers()
    expect(serversAfter.length).toBe(countBefore + 1)

    const newServer = serversAfter.find(s => !serversBefore.find(b => b.id === s.id))
    if (newServer) createdHetznerServerIds.push(String(newServer.id))

    const { data: serverResources } = await db
      .from('resources')
      .select('id')
      .eq('name', `sandbox-${concurrentUserId}`)
      .eq('type', 'server')

    expect(serverResources?.length).toBe(1)
    createdResourceNames.push(`sandbox-${concurrentUserId}`)
    createdResourceNames.push(`sshkey-${concurrentUserId}`)
  }, 120_000)
})
