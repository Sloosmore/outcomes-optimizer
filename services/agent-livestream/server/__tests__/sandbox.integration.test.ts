/**
 * Sandbox Integration Tests — Real Supabase (no real VMs)
 *
 * Gates: RUN_INTEGRATION=true (explicit opt-in required)
 *
 * Uses:
 * - Real Supabase auth users (created + deleted per test suite)
 * - Real DB rows in resources table (auto-provisioned via trigger, updated per test)
 * - MockSandboxProvider (no real Hetzner VMs ever provisioned)
 * - Real JWT middleware in JWKS mode (SUPABASE_URL → JWKS endpoint)
 *
 * NOTE: When createUser is called, the handle_new_auth_user trigger fires and
 * automatically calls provision_user(), creating the user resource. Tests update
 * this resource's config rather than inserting a new one.
 *
 * Run with:
 *   doppler run --project <your-project> --config <your-config> -- \
 *     bash -c 'RUN_INTEGRATION=true npx vitest run --reporter=verbose server/__tests__/sandbox.integration.test.ts'
 */

// A valid ssh-ed25519 public key that satisfies the ProvisionRequest contract regex:
// ^ssh-ed25519\s+[A-Za-z0-9+/]+=*(\s+\S+)?$
const TEST_PUBLIC_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHZuaW9kb21IaW50ZWdyYXRpb250ZXN0 integration-test'

// A valid hetzner server ID (must match /^\d*$/ per ReadyRequest contract)
const TEST_HETZNER_SERVER_ID = '999999'
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { Hono } from 'hono'
import { createClient } from '@supabase/supabase-js'
import { MockSandboxProvider } from '@duoidal/sandbox'
import { jwtMiddleware } from '../middleware/jwt.js'
import { createSandboxRouter, createReadyRouter } from '../routes/sandbox.js'

const RUN_INTEGRATION = !!process.env['RUN_INTEGRATION']

const SUPABASE_URL = process.env['SUPABASE_URL'] ?? ''
const SUPABASE_SERVICE_KEY = process.env['SUPABASE_SERVICE_KEY'] ?? ''
const VITE_SUPABASE_ANON_KEY = process.env['VITE_SUPABASE_ANON_KEY'] ?? ''
const PROVISION_SECRET_VAL = process.env['PROVISION_SECRET'] ?? ''

describe.skipIf(!RUN_INTEGRATION)('sandbox integration', () => {
  // Clients are initialized in beforeAll to avoid createClient throwing
  // when SUPABASE_URL is empty (vitest evaluates describe body even when skipped)
  let supabase: ReturnType<typeof createClient>
  let anonClient: ReturnType<typeof createClient>

  let testAuthId: string
  let testJwt: string
  let userResourceId: string

  // Track extra resource IDs created during tests (server/credential resources only; NOT user resource)
  const extraResourcesToClean: string[] = []

  // Build the test Hono app with real JWT middleware + real routes + mock provider
  const provider = new MockSandboxProvider()
  let app: Hono

  beforeAll(async () => {
    // Initialize clients here (not at describe scope) so createClient doesn't
    // throw when SUPABASE_URL is empty and the suite is skipped
    supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
      auth: { persistSession: false },
    })
    anonClient = createClient(SUPABASE_URL, VITE_SUPABASE_ANON_KEY, {
      auth: { persistSession: false },
    })

    app = new Hono()
    app.use('/api/*', jwtMiddleware)
    app.route('/sandbox', createReadyRouter({ db: supabase }))
    app.route('/api/sandbox', createSandboxRouter({ db: supabase, provider }))

    // Ensure required env vars for the provision route are present.
    // AGENT_LIVESTREAM_URL is not in Doppler for this project; set a dummy value
    // so the route's env-check passes (MockSandboxProvider ignores it).
    if (!process.env['AGENT_LIVESTREAM_URL']) {
      process.env['AGENT_LIVESTREAM_URL'] = 'http://localhost:3001'
    }

    // Create a real Supabase auth user. The handle_new_auth_user trigger will
    // automatically call provision_user() creating the user resource in the DB.
    const email = `test-integration-${Date.now()}@test.example.invalid`
    const password = 'Test-Integration-Password-123!'

    const { data: createData, error: createErr } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    })
    if (createErr || !createData.user) {
      throw new Error(`Failed to create test auth user: ${createErr?.message}`)
    }
    testAuthId = createData.user.id

    // Wait briefly for the trigger to create the user resource
    await new Promise<void>((resolve) => setTimeout(resolve, 500))

    // Look up the auto-created user resource by auth_user_id
    const { data: userRes, error: lookupErr } = await supabase
      .from('resources')
      .select('id')
      .eq('auth_user_id', testAuthId)
      .eq('type', 'user')
      .single()

    if (lookupErr || !userRes) {
      throw new Error(`User resource not created by trigger: ${lookupErr?.message}`)
    }
    userResourceId = userRes.id

    // Sign in via anon client to get a real JWT
    const { data: signInData, error: signInErr } = await anonClient.auth.signInWithPassword({
      email,
      password,
    })
    if (signInErr || !signInData.session) {
      throw new Error(`Failed to sign in test user: ${signInErr?.message}`)
    }
    testJwt = signInData.session.access_token
  })

  afterAll(async () => {
    // Delete the test auth user (cascades to the user resource via ON DELETE SET NULL,
    // then the resource itself is deleted on next cleanup or left as orphan - we clean up explicitly)
    if (testAuthId) {
      await supabase.auth.admin.deleteUser(testAuthId)
    }
    // Clean up the user resource itself (auth_user_id will be SET NULL, resource row remains)
    if (userResourceId) {
      await supabase.from('resource_links').delete().or(`from_id.eq.${userResourceId},to_id.eq.${userResourceId}`)
      await supabase.from('resources').delete().eq('id', userResourceId)
    }
  })

  afterEach(async () => {
    // Clean up server/credential resources created during each test (links first, FK constraint)
    if (extraResourcesToClean.length > 0) {
      await supabase.from('resource_links').delete().in('from_id', extraResourcesToClean)
      await supabase.from('resource_links').delete().in('to_id', extraResourcesToClean)
      await supabase.from('resources').delete().in('id', extraResourcesToClean)
      extraResourcesToClean.length = 0
    }
    // Reset user resource config back to a neutral state (status=pending) after each test
    // so each test starts fresh without approved/provisioning state
    if (userResourceId) {
      await supabase
        .from('resources')
        .update({ config: { status: 'pending' } })
        .eq('id', userResourceId)
    }
  })

  async function setUserResourceConfig(config: Record<string, unknown>): Promise<void> {
    const { error } = await supabase
      .from('resources')
      .update({ config })
      .eq('id', userResourceId)

    if (error) {
      throw new Error(`Failed to update user resource config: ${error.message}`)
    }
  }

  // ── Test 1: Unapproved user → 403 ──────────────────────────────────────────

  it('unapproved user (status=pending) → 403 with User not approved', async () => {
    await setUserResourceConfig({ status: 'pending' })

    const res = await app.request('/api/sandbox/provision', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${testJwt}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ publicKey: TEST_PUBLIC_KEY }),
    })

    expect(res.status).toBe(403)
    const body = await res.json() as { error: string }
    expect(body.error).toBe('User not approved')
  })

  // ── Test 2: Approved user → 200 + DB row ────────────────────────────────────

  it('approved user → 200 with resourceId and server resource created in DB', async () => {
    await setUserResourceConfig({ status: 'approved' })

    const res = await app.request('/api/sandbox/provision', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${testJwt}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ publicKey: TEST_PUBLIC_KEY }),
    })

    expect(res.status).toBe(200)
    const body = await res.json() as { status: string; resourceId: string }
    expect(body.status).toBe('provisioning')
    expect(typeof body.resourceId).toBe('string')
    expect(body.resourceId.length).toBeGreaterThan(0)

    // Track created server resource for cleanup
    extraResourcesToClean.push(body.resourceId)

    // Verify the server resource exists in DB with correct status
    const { data: serverRow } = await supabase
      .from('resources')
      .select('id, type, config')
      .eq('id', body.resourceId)
      .single()

    expect(serverRow).not.toBeNull()
    expect(serverRow!.type).toBe('server')
    const serverConfig = serverRow!.config as Record<string, unknown>
    expect(serverConfig['status']).toBe('provisioning')

    // Verify the parent link from server to user exists
    const { data: linkRows } = await supabase
      .from('resource_links')
      .select('from_id, to_id, link_type')
      .eq('from_id', body.resourceId)
      .eq('to_id', userResourceId)
      .eq('link_type', 'parent')

    expect(linkRows).not.toBeNull()
    expect(linkRows!.length).toBeGreaterThan(0)

    // Track any credential resource linked to the server for cleanup
    const { data: credLinks } = await supabase
      .from('resource_links')
      .select('from_id')
      .eq('to_id', body.resourceId)

    if (credLinks) {
      for (const cl of credLinks) {
        if (!extraResourcesToClean.includes(cl.from_id)) {
          extraResourcesToClean.push(cl.from_id)
        }
      }
    }
  })

  // ── Test 3: Credential resource does not count against sandbox limit ─────────

  it('credential-type resource linked as parent does not count against sandbox limit → 200', async () => {
    await setUserResourceConfig({ status: 'approved', maxSandboxes: 1 })

    // Insert a credential resource linked to the user via parent link
    const { data: credResource, error: credErr } = await supabase
      .from('resources')
      .insert({
        name: `integration-test-credential:${testAuthId}`,
        type: 'credential',
        status: 'active',
        config: {},
      })
      .select('id')
      .single()

    if (credErr || !credResource) {
      throw new Error(`Failed to create credential resource: ${credErr?.message}`)
    }
    extraResourcesToClean.push(credResource.id)

    // Link credential to user resource (from_id=credential, to_id=user, link_type=parent)
    const { error: linkErr } = await supabase
      .from('resource_links')
      .insert({
        from_id: credResource.id,
        to_id: userResourceId,
        link_type: 'parent',
      })

    if (linkErr) {
      throw new Error(`Failed to create credential link: ${linkErr?.message}`)
    }

    // Directly verify via DB: count of server-type resources linked as parent to user = 0
    // This mirrors countLinkedByType({ toId: userResourceId, linkType: 'parent', fromType: 'server' })
    const { data: directRows } = await supabase
      .from('resource_links')
      .select('from_id, resources!resource_links_from_id_fkey(type)')
      .eq('to_id', userResourceId)
      .eq('link_type', 'parent')

    const serverCount = (directRows ?? []).filter(
      (r: { resources: { type: string } | { type: string }[] | null }) => {
        const res = r.resources
        if (Array.isArray(res)) return res.some((x) => x.type === 'server')
        return res?.type === 'server'
      }
    ).length

    expect(serverCount).toBe(0)

    // POST /api/sandbox/provision with maxSandboxes=1 — should succeed (not 409)
    // because only a credential is linked, not a server
    const res = await app.request('/api/sandbox/provision', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${testJwt}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ publicKey: TEST_PUBLIC_KEY }),
    })

    expect(res.status).toBe(200)
    const body = await res.json() as { status: string; resourceId: string }
    expect(body.status).toBe('provisioning')
    expect(typeof body.resourceId).toBe('string')

    // Track the created server resource and its children for cleanup
    extraResourcesToClean.push(body.resourceId)

    const { data: newCredLinks } = await supabase
      .from('resource_links')
      .select('from_id')
      .eq('to_id', body.resourceId)

    if (newCredLinks) {
      for (const cl of newCredLinks) {
        if (!extraResourcesToClean.includes(cl.from_id)) {
          extraResourcesToClean.push(cl.from_id)
        }
      }
    }
  })

  // ── Test 4: /sandbox/ready transitions to active ────────────────────────────

  it('/sandbox/ready with valid PROVISION_SECRET transitions resource to active', async () => {
    // Setup: approve user + provision to get a server resourceId
    await setUserResourceConfig({ status: 'approved' })

    const provisionRes = await app.request('/api/sandbox/provision', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${testJwt}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ publicKey: TEST_PUBLIC_KEY }),
    })

    expect(provisionRes.status).toBe(200)
    const provisionBody = await provisionRes.json() as { status: string; resourceId: string }
    const resourceId = provisionBody.resourceId
    extraResourcesToClean.push(resourceId)

    // Track credential resources linked to server for cleanup
    const { data: credLinks } = await supabase
      .from('resource_links')
      .select('from_id')
      .eq('to_id', resourceId)

    if (credLinks) {
      for (const cl of credLinks) {
        if (!extraResourcesToClean.includes(cl.from_id)) {
          extraResourcesToClean.push(cl.from_id)
        }
      }
    }

    // POST /sandbox/ready with PROVISION_SECRET
    const readyRes = await app.request('/sandbox/ready', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${PROVISION_SECRET_VAL}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        resourceId,
        ip: '10.0.0.1',
        hetznerServerId: TEST_HETZNER_SERVER_ID,
      }),
    })

    expect(readyRes.status).toBe(200)
    const readyBody = await readyRes.json() as { success: boolean }
    expect(readyBody.success).toBe(true)

    // Verify DB directly: config.status should be 'active' and config.ip should be '10.0.0.1'
    const { data: resourceRow } = await supabase
      .from('resources')
      .select('config')
      .eq('id', resourceId)
      .single()

    expect(resourceRow).not.toBeNull()
    const config = resourceRow!.config as Record<string, unknown>
    expect(config['status']).toBe('active')
    expect(config['ip']).toBe('10.0.0.1')
  })
})
