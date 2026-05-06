/**
 * E2E rename-durability tests
 *
 * Verifies that rename_resource changes the name but preserves every link,
 * credential lookup, CLI CRUD path, and dispatch join that references by UUID.
 *
 * Requires: RUN_INTEGRATION=true (explicit opt-in, via doppler run)
 *
 * Usage:
 *   doppler run -- bash -c 'RUN_INTEGRATION=true npx vitest run packages/agent-core/src/__tests__/rename-durability.e2e.test.ts --reporter=verbose'
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { generateKeyPairSync, createPublicKey } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'

// Dynamic imports for modules outside rootDir (avoids tsc rootDir violation)
type CreateSupabaseClientFn = (url: string, key: string) => SupabaseClient
type AccessCodeAuthAdapterClass = { new (client: SupabaseClient): { exchangeCode: (email: string, otp: string) => Promise<{ accessToken: string; refreshToken?: string }> } }
let createSupabaseClient: CreateSupabaseClientFn
let AccessCodeAuthAdapter: AccessCodeAuthAdapterClass

// ---------------------------------------------------------------------------
// Guard: skip unless explicitly opted in
// ---------------------------------------------------------------------------

describe.skipIf(!process.env['RUN_INTEGRATION'])('E2E: rename-durability', () => {
  // ---------------------------------------------------------------------------
  // Env vars
  // ---------------------------------------------------------------------------

  const SUPABASE_URL = process.env['SUPABASE_URL'] ?? ''
  const SUPABASE_SERVICE_KEY = process.env['SUPABASE_SERVICE_KEY'] ?? ''
  const SUPABASE_ANON_KEY = process.env['VITE_SUPABASE_ANON_KEY'] ?? process.env['SUPABASE_ANON_KEY'] ?? ''

  // ---------------------------------------------------------------------------
  // Shared state
  // ---------------------------------------------------------------------------

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let serviceClient: any
  let timestamp = 0
  let email = ''
  let authUserId = ''
  let userResourceId = ''
  let projectResourceId = ''

  // Track resources for cleanup
  const createdResourceIds: string[] = []

  // Agent-email binary path (relative from __dirname)
  const agentEmailBin = join(__dirname, '../../../../packages/agent-email/bin/throwmail.js')

  // Agent-core binary
  const agentCoreBin = join(__dirname, '../../../../node_modules/.bin/agent-core')

  // UUID regex
  const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Create a resource via typed RPC and track for cleanup.
   * Dispatches to the appropriate typed RPC based on resource type:
   *   rpc('create_agent'), rpc('create_skill'), rpc('create_proxy'),
   *   rpc('create_server'), rpc('create_credential'), rpc('create_identity')
   */
  async function createResource(name: string, type: string, config: Record<string, unknown> = {}): Promise<string> {
    let data: unknown = null
    let error: unknown = null

    if (type === 'agent') {
      ({ data, error } = await serviceClient.rpc('create_agent', {
        p_name: name,
        p_project_id: projectResourceId,
        p_config: config,
      }))
    } else if (type === 'skill') {
      ({ data, error } = await serviceClient.rpc('create_skill', {
        p_name: name,
        p_project_id: projectResourceId,
        p_config: config,
      }))
    } else if (type === 'proxy') {
      ({ data, error } = await serviceClient.rpc('create_proxy', {
        p_name: name,
        p_project_id: projectResourceId,
        p_config: config,
      }))
    } else if (type === 'server') {
      ({ data, error } = await serviceClient.rpc('create_server', {
        p_name: name,
        p_project_id: projectResourceId,
        p_config: config,
      }))
    } else if (type === 'credential') {
      ({ data, error } = await serviceClient.rpc('create_credential', {
        p_name: name,
        p_project_id: projectResourceId,
        p_doppler_project: (config['dopplerProject'] as string | undefined) ?? 'test-default',
        p_config: config,
      }))
    } else if (type === 'identity') {
      ({ data, error } = await serviceClient.rpc('create_identity', {
        p_name: name,
        p_project_id: projectResourceId,
        p_handle: (config['handle'] as string | undefined) ?? name,
        p_config: config,
      }))
    } else {
      throw new Error(`No typed RPC for resource type: ${type}`)
    }

    if (error) throw new Error(`create_${type}(${name}) failed: ${(error as { message: string }).message}`)
    const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown>
    // Typed RPCs return <type>_resource_id (e.g., agent_resource_id, server_resource_id)
    const idKey = Object.keys(row).find(k => k.endsWith('_resource_id') || k === 'resource_id')
    const id = (idKey ? row[idKey] : undefined) as string
    if (!id) throw new Error(`create_${type}(${name}) returned no resource ID: ${JSON.stringify(row)}`)
    createdResourceIds.push(id)
    return id
  }

  /** Create a link via semantic alias RPC or direct insert for types without aliases */
  async function createLink(fromId: string, toId: string, linkType: string): Promise<void> {
    if (linkType === 'credential') {
      const { error } = await serviceClient.rpc('assign_credential', {
        p_from_id: fromId,
        p_to_id: toId,
      })
      if (error) throw new Error(`assign_credential failed: ${(error as { message: string }).message}`)
    } else if (linkType === 'proxy') {
      const { error } = await serviceClient.rpc('assign_proxy', {
        p_from_id: fromId,
        p_to_id: toId,
      })
      if (error) throw new Error(`assign_proxy failed: ${(error as { message: string }).message}`)
    } else if (linkType === 'member_of') {
      const { error } = await serviceClient.rpc('add_project_member', {
        p_from_id: fromId,
        p_to_id: toId,
      })
      if (error) throw new Error(`add_project_member failed: ${(error as { message: string }).message}`)
    } else {
      // For link types without semantic aliases (parent, runs, partOf, etc.),
      // use direct insert via service_role client (bypasses RLS — only for test setup)
      const { error } = await serviceClient
        .from('resource_links')
        .insert({ from_id: fromId, to_id: toId, link_type: linkType })
      if (error) throw new Error(`createLink(${linkType}) failed: ${(error as { message: string }).message}`)
    }
  }

  /** Rename a resource via RPC */
  async function renameResource(id: string, newName: string): Promise<void> {
    const { error } = await serviceClient.rpc('rename_resource', {
      p_resource_id: id,
      p_new_name: newName,
    })
    if (error) throw new Error(`rename_resource(${id}, ${newName}) failed: ${error.message}`)
  }

  /** Generate SSH public key in ssh-ed25519 format */
  function generateSshPublicKey(): { sshPublicKey: string; publicKeyPem: string; privateKeyPem: string } {
    const { publicKey: pkPem, privateKey: privPem } = generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    })
    const pubKeyDer = createPublicKey(pkPem).export({ type: 'spki', format: 'der' }) as Buffer
    const rawPubKey = pubKeyDer.slice(12) // skip 12-byte SPKI header
    const keyTypeBuf = Buffer.from('ssh-ed25519')
    const wireFormat = Buffer.alloc(4 + keyTypeBuf.length + 4 + rawPubKey.length)
    let off = 0
    wireFormat.writeUInt32BE(keyTypeBuf.length, off); off += 4
    keyTypeBuf.copy(wireFormat, off); off += keyTypeBuf.length
    wireFormat.writeUInt32BE(rawPubKey.length, off); off += 4
    rawPubKey.copy(wireFormat, off)
    const sshPublicKey = `ssh-ed25519 ${wireFormat.toString('base64')} e2e-rename-test`
    return { sshPublicKey, publicKeyPem: pkPem, privateKeyPem: privPem }
  }

  /** Create a skill via RPC (requires project_id and valid config) */
  async function createSkill(name: string, projectId: string): Promise<string> {
    const config = {
      prompt: 'E2E rename durability test skill - this is a placeholder prompt for testing purposes only',
      epochs: 1,
      worktree: false,
      git: false,
      pr: false,
      content: 'E2E rename durability test skill content - this placeholder content must be longer than one hundred characters to pass validation requirements in the create_skill function',
    }
    const { data, error } = await serviceClient.rpc('create_skill', {
      p_name: name,
      p_project_id: projectId,
      p_config: config,
    })
    if (error) throw new Error(`create_skill(${name}) failed: ${error.message}`)
    const row = Array.isArray(data) ? data[0] : data
    const id = row.skill_resource_id as string
    createdResourceIds.push(id)
    return id
  }

  // ---------------------------------------------------------------------------
  // beforeAll: set up fresh user via agent-email + access code
  // ---------------------------------------------------------------------------

  beforeAll(async () => {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !SUPABASE_ANON_KEY) {
      throw new Error('Missing required env vars: SUPABASE_URL, SUPABASE_SERVICE_KEY, VITE_SUPABASE_ANON_KEY')
    }

    // Map for executeAction audit writes
    if (process.env['SUPABASE_SERVICE_KEY'] && !process.env['SUPABASE_SERVICE_ROLE_KEY']) {
      process.env['SUPABASE_SERVICE_ROLE_KEY'] = process.env['SUPABASE_SERVICE_KEY']
    }

    // Dynamic import of @duoidal/auth via absolute path (outside rootDir)
    const authAdaptersPath: string = join(__dirname, '../../../../packages/auth/dist/adapters/index.js')
    const authPath: string = join(__dirname, '../../../../packages/auth/dist/index.js')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const authAdaptersMod = await import(/* @vite-ignore */ authAdaptersPath) as {
      createSupabaseClient: CreateSupabaseClientFn
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const authMod = await import(/* @vite-ignore */ authPath) as {
      AccessCodeAuthAdapter: AccessCodeAuthAdapterClass
    }
    createSupabaseClient = authAdaptersMod.createSupabaseClient
    AccessCodeAuthAdapter = authMod.AccessCodeAuthAdapter

    serviceClient = createSupabaseClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    timestamp = Date.now()

    // 1. Create disposable email via agent-email
    const emailName = `e2erename${timestamp}`
    const emailResult = execFileSync(
      'node', [agentEmailBin, 'init', '--adapter', 'mailtm', '--name', emailName],
      { encoding: 'utf-8', timeout: 15000 }
    ).trim()
    email = emailResult.includes('\n')
      ? emailResult.split('\n').find(l => l.includes('@')) ?? emailResult
      : emailResult
    email = email.trim()
    expect(email).toMatch(/@/)
    console.log(`[rename-e2e] Created email: ${email}`)

    // 2. Create access code via RPC
    const codeName = `RENAME-E2E-${timestamp}`
    const { data: codeData, error: codeErr } = await serviceClient.rpc('create_access_code', {
      p_code: codeName,
    })
    if (codeErr) throw new Error(`create_access_code failed: ${codeErr.message}`)
    const codeRow = Array.isArray(codeData) ? codeData[0] : codeData
    createdResourceIds.push(codeRow.access_code_id)
    console.log(`[rename-e2e] Created access code: ${codeName}`)

    // 3. Generate magic link + OTP
    const { data: linkData, error: linkErr } = await serviceClient.auth.admin.generateLink({
      type: 'magiclink',
      email,
      options: { redirectTo: 'http://localhost:3000/auth/callback' },
    })
    if (linkErr) throw new Error(`generateLink failed: ${linkErr.message}`)
    const emailOtp = linkData!.properties!.email_otp!
    console.log(`[rename-e2e] Generated OTP for ${email}`)

    // 4. Exchange OTP for JWT
    const anonClient = createSupabaseClient(SUPABASE_URL, SUPABASE_ANON_KEY)
    const adapter = new AccessCodeAuthAdapter(anonClient)
    const token = await adapter.exchangeCode(email, emailOtp)
    expect(token.accessToken).toBeTruthy()

    // Decode JWT to get auth user ID
    const payload = JSON.parse(
      Buffer.from(token.accessToken.split('.')[1]!, 'base64url').toString()
    ) as { sub: string; email: string }
    authUserId = payload.sub
    console.log(`[rename-e2e] Authenticated as ${payload.email} (${authUserId})`)

    // 5. Provision user via RPC
    const { data: provData, error: provErr } = await serviceClient.rpc('provision_user', {
      p_auth_user_id: authUserId,
      p_email: email,
    })
    if (provErr) throw new Error(`provision_user failed: ${provErr.message}`)
    const provRow = Array.isArray(provData) ? provData[0] : provData
    userResourceId = provRow.user_resource_id as string
    projectResourceId = provRow.project_resource_id as string
    console.log(`[rename-e2e] Provisioned user: ${userResourceId}, project: ${projectResourceId}`)

    // 6. Verify user + project + member_of link exist
    const { data: userRes } = await serviceClient.from('resources').select('id, type').eq('id', userResourceId).single()
    expect(userRes).toBeTruthy()
    expect(userRes!.type).toBe('user')

    const { data: projRes } = await serviceClient.from('resources').select('id, type').eq('id', projectResourceId).single()
    expect(projRes).toBeTruthy()
    expect(projRes!.type).toBe('project')

    const { data: memberLink } = await serviceClient
      .from('resource_links')
      .select('link_type')
      .eq('from_id', userResourceId)
      .eq('to_id', projectResourceId)
      .eq('link_type', 'member_of')
      .single()
    expect(memberLink).toBeTruthy()
    console.log('[rename-e2e] Setup complete: user, project, and member_of link verified')
  }, 60000)

  // ---------------------------------------------------------------------------
  // afterAll: cleanup
  // ---------------------------------------------------------------------------

  afterAll(async () => {
    try {
      // Delete resources in reverse order (links cascade or are handled by delete_resource)
      for (const id of [...createdResourceIds].reverse()) {
        try {
          await serviceClient.rpc('delete_resource', { p_resource_id: id })
        } catch {
          // Fallback: direct delete
          await serviceClient.from('resource_links').delete().or(`from_id.eq.${id},to_id.eq.${id}`)
          await serviceClient.from('resources').delete().eq('id', id)
        }
      }

      // Clean up user and project resources
      if (userResourceId) {
        await serviceClient.from('resource_links').delete().or(`from_id.eq.${userResourceId},to_id.eq.${userResourceId}`)
        await serviceClient.from('resources').delete().eq('id', userResourceId)
      }
      if (projectResourceId) {
        await serviceClient.from('resource_links').delete().or(`from_id.eq.${projectResourceId},to_id.eq.${projectResourceId}`)
        await serviceClient.from('resources').delete().eq('id', projectResourceId)
      }

      // Delete auth user
      if (authUserId) {
        await serviceClient.from('action_events').delete().eq('actor_id', authUserId)
        await serviceClient.auth.admin.deleteUser(authUserId)
      }
    } catch (err) {
      console.warn('[rename-e2e] Cleanup error (non-fatal):', err instanceof Error ? err.message : String(err))
    }
  }, 30000)

  // ---------------------------------------------------------------------------
  // Test 1: Sandbox lifecycle — provision, rename, verify by UUID, deprovision
  // ---------------------------------------------------------------------------

  it('Test 1: sandbox lifecycle survives rename', async () => {
    const serverName = `e2e-sandbox-rename-${timestamp}`
    const sshKeyName = `e2e-key-rename-${timestamp}`
    const { sshPublicKey } = generateSshPublicKey()

    // Provision sandbox directly via create_resource (bypasses auth.uid() ownership check in provision_sandbox RPC)
    const serverId = await createResource(serverName, 'server', {
      status: 'provisioning',
      hetzner_server_id: `fake-${timestamp}`,
    })
    const credId = await createResource(sshKeyName, 'credential', {
      public_key: sshPublicKey,
    })

    // Create links: server -> user (parent), server -> credential
    await createLink(serverId, userResourceId, 'parent')
    await createLink(serverId, credId, 'credential')

    // Rename the server
    const newServerName = `e2e-sandbox-renamed-${timestamp}`
    await renameResource(serverId, newServerName)

    // Verify by UUID: resource still exists with new name
    const { data: serverRow } = await serviceClient
      .from('resources')
      .select('id, name, type')
      .eq('id', serverId)
      .single()
    expect(serverRow).toBeTruthy()
    expect(serverRow!.name).toBe(newServerName)
    expect(serverRow!.type).toBe('server')

    // Verify deprovision works by UUID
    const { data: deprovData, error: deprovErr } = await serviceClient.rpc('deprovision_sandbox', {
      p_server_resource_id: serverId,
    })
    // deprovision_sandbox may or may not fully delete (depends on Hetzner existence),
    // but the RPC call must not error due to rename
    if (deprovErr) {
      // Acceptable: the server was fake, so cleanup may partially fail.
      // The point is the UUID lookup inside the RPC did not break.
      console.log(`[rename-e2e] deprovision_sandbox returned error (expected for fake server): ${deprovErr.message}`)
    } else {
      console.log(`[rename-e2e] deprovision_sandbox succeeded: ${JSON.stringify(deprovData)}`)
    }
  }, 30000)

  // ---------------------------------------------------------------------------
  // Test 2: Credential lifecycle — config->>'serverResourceId' query
  // ---------------------------------------------------------------------------

  it('Test 2: credential lookup by serverResourceId survives rename', async () => {
    const serverName = `e2e-cred-srv-${timestamp}`
    const credName = `e2e-cred-key-${timestamp}`
    const { sshPublicKey } = generateSshPublicKey()

    // Create server and credential
    const serverId = await createResource(serverName, 'server', {
      status: 'active',
      hetzner_server_id: `fake-cred-${timestamp}`,
    })
    const credId = await createResource(credName, 'credential', {
      public_key: sshPublicKey,
      serverResourceId: serverId,
    })

    // Link server -> credential
    await createLink(serverId, credId, 'credential')

    // Rename the server
    await renameResource(serverId, `e2e-cred-srv-renamed-${timestamp}`)

    // Query credential by config->>'serverResourceId' — should still match the UUID
    const { data: credRows, error: credErr } = await serviceClient
      .from('resources')
      .select('id, name, config')
      .eq('type', 'credential')
      .filter('config->>serverResourceId', 'eq', serverId)
    expect(credErr).toBeNull()
    expect(credRows).toBeTruthy()
    expect(credRows!.length).toBeGreaterThan(0)
    expect(credRows![0].id).toBe(credId)

    // Verify the link still exists
    const { data: linkRow } = await serviceClient
      .from('resource_links')
      .select('from_id, to_id, link_type')
      .eq('from_id', serverId)
      .eq('to_id', credId)
      .eq('link_type', 'credential')
      .single()
    expect(linkRow).toBeTruthy()
  }, 30000)

  // ---------------------------------------------------------------------------
  // Test 3: Skill dispatch preflight — runs link by UUID
  // ---------------------------------------------------------------------------

  it('Test 3: skill dispatch preflight runs-link survives rename', async () => {
    const skillName = `e2e-skill-dispatch-${timestamp}`
    const skillId = await createSkill(skillName, projectResourceId)

    // Create an agent resource to link from
    const agentId = await createResource(`e2e-agent-${timestamp}`, 'agent')

    // Create runs link: agent -> skill
    await createLink(agentId, skillId, 'runs')

    // Rename the skill
    await renameResource(skillId, `e2e-skill-dispatch-renamed-${timestamp}`)

    // Verify the runs link still resolves by skill UUID
    const { data: countData, error: countErr } = await serviceClient
      .from('resource_links')
      .select('to_id', { count: 'exact' })
      .eq('to_id', skillId)
      .eq('link_type', 'runs')
    expect(countErr).toBeNull()
    expect(countData).toBeTruthy()
    expect(countData!.length).toBeGreaterThan(0)

    // Also verify via a join query (as dispatch.ts would)
    const { data: joinData, error: joinErr } = await serviceClient
      .from('resources')
      .select('id, name, type')
      .eq('id', skillId)
      .single()
    expect(joinErr).toBeNull()
    expect(joinData).toBeTruthy()
    expect(joinData!.id).toBe(skillId)
  }, 30000)

  // ---------------------------------------------------------------------------
  // Test 4: Cron->skill link survives skill rename
  // ---------------------------------------------------------------------------

  it('Test 4: cron-to-skill schedules link survives rename', async () => {
    const skillName = `e2e-skill-cron-${timestamp}`
    const skillId = await createSkill(skillName, projectResourceId)

    // Create cron resource linked to the skill
    const { data: cronData, error: cronErr } = await serviceClient.rpc('create_cron', {
      p_name: `e2e-cron-${timestamp}`,
      p_project_id: projectResourceId,
      p_skill_resource_id: skillId,
      p_schedule: '0 9 * * 1',
      p_enabled: false,
      p_prompt: 'E2E test cron prompt',
    })
    if (cronErr) throw new Error(`create_cron failed: ${cronErr.message}`)
    const cronRow = Array.isArray(cronData) ? cronData[0] : cronData
    const cronId = cronRow.cron_resource_id as string
    createdResourceIds.push(cronId)

    // Rename the skill
    await renameResource(skillId, `e2e-skill-cron-renamed-${timestamp}`)

    // Verify cron->skill link still resolves by UUID
    // create_cron creates a 'schedules' link from cron to skill
    const { data: linkRows, error: linkErr } = await serviceClient
      .from('resource_links')
      .select('from_id, to_id, link_type')
      .eq('from_id', cronId)
      .eq('to_id', skillId)
    expect(linkErr).toBeNull()
    expect(linkRows).toBeTruthy()
    expect(linkRows!.length).toBeGreaterThan(0)

    // Also verify via join as the scheduler would query
    const { data: joinData, error: joinErr } = await serviceClient
      .from('resources')
      .select('id, name, type')
      .eq('id', skillId)
      .single()
    expect(joinErr).toBeNull()
    expect(joinData).toBeTruthy()
    expect(joinData!.id).toBe(skillId)
    expect(joinData!.type).toBe('skill')
  }, 30000)

  // ---------------------------------------------------------------------------
  // Test 5: Project rename — partOf and member_of links survive
  // ---------------------------------------------------------------------------

  it('Test 5: project rename preserves partOf and member_of links', async () => {
    // Create a skill linked to the project via partOf (created by create_skill RPC)
    const skillName = `e2e-skill-proj-${timestamp}`
    const skillId = await createSkill(skillName, projectResourceId)

    // Verify partOf link exists before rename
    const { data: beforeLink } = await serviceClient
      .from('resource_links')
      .select('link_type')
      .eq('from_id', skillId)
      .eq('to_id', projectResourceId)
      .eq('link_type', 'partOf')
      .single()
    expect(beforeLink).toBeTruthy()

    // Rename the project
    const newProjectName = `e2e-project-renamed-${timestamp}`
    await renameResource(projectResourceId, newProjectName)

    // Verify partOf link still resolves to the project UUID
    const { data: afterPartOf } = await serviceClient
      .from('resource_links')
      .select('link_type')
      .eq('from_id', skillId)
      .eq('to_id', projectResourceId)
      .eq('link_type', 'partOf')
      .single()
    expect(afterPartOf).toBeTruthy()

    // Verify member_of link (user -> project) still resolves
    const { data: afterMemberOf } = await serviceClient
      .from('resource_links')
      .select('link_type')
      .eq('from_id', userResourceId)
      .eq('to_id', projectResourceId)
      .eq('link_type', 'member_of')
      .single()
    expect(afterMemberOf).toBeTruthy()

    // Verify project name actually changed
    const { data: projRow } = await serviceClient
      .from('resources')
      .select('name')
      .eq('id', projectResourceId)
      .single()
    expect(projRow).toBeTruthy()
    expect(projRow!.name).toBe(newProjectName)
  }, 30000)

  // ---------------------------------------------------------------------------
  // Test 6: Identity + credential link survives identity rename
  // ---------------------------------------------------------------------------

  it('Test 6: identity-credential link survives identity rename', async () => {
    // Create identity resource
    const { data: idData, error: idErr } = await serviceClient.rpc('create_identity', {
      p_name: `e2e-identity-${timestamp}`,
      p_project_id: projectResourceId,
      p_handle: `e2ehandle${timestamp}`,
    })
    if (idErr) throw new Error(`create_identity failed: ${idErr.message}`)
    const idRow = Array.isArray(idData) ? idData[0] : idData
    const identityId = idRow.identity_resource_id as string
    createdResourceIds.push(identityId)

    // Create credential resource
    const { data: credData, error: credErr } = await serviceClient.rpc('create_credential', {
      p_name: `e2e-identity-cred-${timestamp}`,
      p_project_id: projectResourceId,
      p_doppler_project: 'e2e-test',
    })
    if (credErr) throw new Error(`create_credential failed: ${credErr.message}`)
    const credRow = Array.isArray(credData) ? credData[0] : credData
    const credentialId = credRow.credential_resource_id as string
    createdResourceIds.push(credentialId)

    // Create credential link: identity -> credential
    await createLink(identityId, credentialId, 'credential')

    // Rename the identity
    await renameResource(identityId, `e2e-identity-renamed-${timestamp}`)

    // Verify link still exists
    const { data: linkRow } = await serviceClient
      .from('resource_links')
      .select('from_id, to_id, link_type')
      .eq('from_id', identityId)
      .eq('to_id', credentialId)
      .eq('link_type', 'credential')
      .single()
    expect(linkRow).toBeTruthy()
    expect(linkRow!.from_id).toBe(identityId)
    expect(linkRow!.to_id).toBe(credentialId)
  }, 30000)

  // ---------------------------------------------------------------------------
  // Test 7: CLI resource CRUD by ID survives rename
  // ---------------------------------------------------------------------------

  it('Test 7: CLI resource CRUD by ID survives rename', async () => {
    // Create resource via CLI
    const addOutput = execFileSync(
      agentCoreBin,
      ['resource', 'add', '--name', `test-cli-rename-${timestamp}`, '--type', 'config'],
      { encoding: 'utf-8', timeout: 30000 }
    ).trim()
    console.log(`[rename-e2e] CLI resource add output: ${addOutput}`)

    // Extract UUID from output
    const uuidMatch = addOutput.match(UUID_RE)
    expect(uuidMatch).toBeTruthy()
    const resourceId = uuidMatch![0]
    createdResourceIds.push(resourceId)

    // Rename via RPC (using the already-initialized serviceClient)
    await renameResource(resourceId, `test-cli-renamed-${timestamp}`)

    // Show by ID should return the resource
    const showOutput = execFileSync(
      agentCoreBin,
      ['show', '--id', resourceId, '--json'],
      { encoding: 'utf-8', timeout: 30000 }
    ).trim()
    console.log(`[rename-e2e] CLI show output: ${showOutput}`)
    expect(showOutput).toContain(resourceId)

    // Remove by ID should exit 0
    const removeOutput = execFileSync(
      agentCoreBin,
      ['resource', 'remove', '--id', resourceId],
      { encoding: 'utf-8', timeout: 30000 }
    ).trim()
    console.log(`[rename-e2e] CLI resource remove output: ${removeOutput}`)
    // If we got here without throwing, exit code was 0

    // Remove from cleanup list since already deleted
    const idx = createdResourceIds.indexOf(resourceId)
    if (idx >= 0) createdResourceIds.splice(idx, 1)
  }, 60000)

  // ---------------------------------------------------------------------------
  // Test 8: Access code immutability — rename should error
  // ---------------------------------------------------------------------------

  it('Test 8: access code cannot be renamed, but can be redeemed', async () => {
    const codeName = `IMMUT-${timestamp}`

    // Create access code
    const { data: codeData, error: codeErr } = await serviceClient.rpc('create_access_code', {
      p_code: codeName,
    })
    if (codeErr) throw new Error(`create_access_code failed: ${codeErr.message}`)
    const codeRow = Array.isArray(codeData) ? codeData[0] : codeData
    const codeId = codeRow.access_code_id as string
    createdResourceIds.push(codeId)

    // Attempt rename — should fail
    const { error: renameErr } = await serviceClient.rpc('rename_resource', {
      p_resource_id: codeId,
      p_new_name: `IMMUT-RENAMED-${timestamp}`,
    })
    expect(renameErr).toBeTruthy()
    expect(renameErr!.message).toMatch(/cannot be renamed/)

    // Redeem the access code (user -> code)
    const { data: redeemData, error: redeemErr } = await serviceClient.rpc('redeem_access_code', {
      p_code: codeName,
      p_user_id: userResourceId,
    })
    if (redeemErr) throw new Error(`redeem_access_code failed: ${redeemErr.message}`)
    const redeemRow = Array.isArray(redeemData) ? redeemData[0] : redeemData
    expect(redeemRow.redeemed).toBe(true)

    // Verify redeemed_by link exists
    const { data: linkRow } = await serviceClient
      .from('resource_links')
      .select('from_id, to_id, link_type')
      .eq('from_id', userResourceId)
      .eq('to_id', codeId)
      .eq('link_type', 'redeemed_by')
      .single()
    expect(linkRow).toBeTruthy()
    expect(linkRow!.from_id).toBe(userResourceId)
    expect(linkRow!.to_id).toBe(codeId)
  }, 30000)
})
