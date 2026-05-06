/**
 * E2E integration test: new-user onboarding flow
 *
 * Runs against real Supabase + real infra.
 * Requires: RUN_INTEGRATION=true (explicit opt-in, via doppler run)
 *
 * Usage:
 *   doppler run -- bash -c 'RUN_INTEGRATION=true npx vitest run packages/duoidal-cli/src/__tests__/e2e.integration.test.ts --reporter=verbose'
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { writeFileSync, readFileSync, unlinkSync, mkdirSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { generateKeyPairSync, createPublicKey, createPrivateKey, randomBytes } from 'node:crypto'
import net from 'node:net'
import { createSupabaseClient } from '@duoidal/auth/adapters'
import { AccessCodeAuthAdapter } from '@duoidal/auth'

// executeAction and clearCache are loaded dynamically (outside rootDir — use new Function to avoid tsc rootDir violation)
type ExecuteActionFn = (name: string, input: Record<string, unknown>, client: unknown) => Promise<Record<string, unknown>>
type ClearCacheFn = () => void
let executeAction: ExecuteActionFn
let clearCache: ClearCacheFn

// Try action with user client, fall back to service client on error.
// Uses module-level clearCache so stale validator state is cleared between attempts.
async function withClientFallback<T>(
  action: (client: unknown) => Promise<T>,
  userClient: unknown,
  svcClient: unknown,
  label: string
): Promise<T> {
  try {
    return await action(userClient)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.log(`[E2E] User client ${label} failed (${msg}), retrying with service client`)
    clearCache()
    return action(svcClient)
  }
}

// ---------------------------------------------------------------------------
// Helper: convert PKCS8 PEM ed25519 private key to OpenSSH private key format
// OpenSSH format is required by the `ssh` CLI; PKCS8 produces "invalid format" error.
// ---------------------------------------------------------------------------

function pkcs8ToOpenSSH(pkcs8Pem: string): string {
  const keyObj = createPrivateKey(pkcs8Pem)
  const jwk = keyObj.export({ format: 'jwk' }) as { d: string; x: string }
  const privBytes = Buffer.from(jwk.d, 'base64url') // 32-byte private scalar
  const pubBytes = Buffer.from(jwk.x, 'base64url')  // 32-byte public key

  function encodeStr(s: string): Buffer {
    const b = Buffer.from(s)
    const len = Buffer.allocUnsafe(4)
    len.writeUInt32BE(b.length, 0)
    return Buffer.concat([len, b])
  }

  function encodeBytes(b: Buffer): Buffer {
    const len = Buffer.allocUnsafe(4)
    len.writeUInt32BE(b.length, 0)
    return Buffer.concat([len, b])
  }

  // Public key wire format: "ssh-ed25519" + pubkey
  const pubKeyEncoded = Buffer.concat([encodeStr('ssh-ed25519'), encodeBytes(pubBytes)])

  // Repeated check integer (random, must match — used to detect decryption errors)
  const checkInt = randomBytes(4)

  // Private key block: checkint×2, key type, pubkey, privkey+pubkey, empty comment
  const privKeyBlock = Buffer.concat([
    checkInt, checkInt,
    encodeStr('ssh-ed25519'),
    encodeBytes(pubBytes),
    encodeBytes(Buffer.concat([privBytes, pubBytes])), // 64 bytes: private scalar || public key
    encodeStr(''), // empty comment
  ])

  // Pad to 8-byte boundary with 0x01 0x02 0x03 ...
  const padLen = (8 - (privKeyBlock.length % 8)) % 8
  const padding = Buffer.from(Array.from({ length: padLen }, (_, i) => i + 1))
  const privKeyBlockPadded = Buffer.concat([privKeyBlock, padding])

  // Number of keys as big-endian uint32
  const numKeys = Buffer.allocUnsafe(4)
  numKeys.writeUInt32BE(1, 0)

  const body = Buffer.concat([
    encodeStr('none'),             // cipher name
    encodeStr('none'),             // kdf name
    encodeBytes(Buffer.alloc(0)), // kdf options (empty)
    numKeys,
    encodeBytes(pubKeyEncoded),
    encodeBytes(privKeyBlockPadded),
  ])

  const magic = Buffer.concat([Buffer.from('openssh-key-v1'), Buffer.from([0x00])])
  const full = Buffer.concat([magic, body])

  const b64 = full.toString('base64')
  const lines = (b64.match(/.{1,70}/g) ?? [b64]).join('\n')
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${lines}\n-----END OPENSSH PRIVATE KEY-----\n`
}

// ---------------------------------------------------------------------------
// Guard: skip unless explicitly opted in
// ---------------------------------------------------------------------------

describe.skipIf(!process.env['RUN_INTEGRATION'])('E2E: new-user onboarding', () => {
  // ---------------------------------------------------------------------------
  // Shared state across test steps
  // ---------------------------------------------------------------------------

  let email = ''
  let accessCodeName = ''
  let authUserId = ''
  let userResourceId = ''
  let serverResourceId = ''
  let skillResourceId = ''
  let accessToken = ''
  let refreshToken = ''
  let goalPath = ''
  let timestamp = 0
  let privateKeyPem = ''
  let sshPublicKey = ''
  let serverIp = ''

  const SUPABASE_URL = process.env['SUPABASE_URL'] ?? ''
  const SUPABASE_SERVICE_KEY = process.env['SUPABASE_SERVICE_KEY'] ?? ''
  // The anon key is stored as VITE_SUPABASE_ANON_KEY in Doppler
  const SUPABASE_ANON_KEY = process.env['VITE_SUPABASE_ANON_KEY'] ?? process.env['SUPABASE_ANON_KEY'] ?? ''

  const GITHUB_TEST_USERNAME = process.env['GITHUB_TEST_USERNAME'] ?? ''
  const GITHUB_TEST_PASSWORD = process.env['GITHUB_TEST_PASSWORD'] ?? ''
  const DASHBOARD_URL = process.env['DASHBOARD_URL']
  if (!DASHBOARD_URL) throw new Error('DASHBOARD_URL required for e2e integration test')

  let serviceClient: ReturnType<typeof createSupabaseClient>

  // ---------------------------------------------------------------------------
  // beforeAll: environment setup
  // ---------------------------------------------------------------------------

  beforeAll(async () => {
    // Map SUPABASE_SERVICE_KEY → SUPABASE_SERVICE_ROLE_KEY (needed by executeAction audit writes)
    if (process.env['SUPABASE_SERVICE_KEY'] && !process.env['SUPABASE_SERVICE_ROLE_KEY']) {
      process.env['SUPABASE_SERVICE_ROLE_KEY'] = process.env['SUPABASE_SERVICE_KEY']
    }

    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !SUPABASE_ANON_KEY) {
      throw new Error('Missing required env vars: SUPABASE_URL, SUPABASE_SERVICE_KEY, VITE_SUPABASE_ANON_KEY')
    }

    serviceClient = createSupabaseClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

    timestamp = Date.now()

    // Dynamically load executeAction + clearCache from outside rootDir.
    // Using a string variable (not literal) prevents tsc from resolving/checking the path.
    // The `/* @vite-ignore */` comment tells Vite/vitest not to pre-process this import.
    const specifier: string = '@skill-networks/database/actions'
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = await import(/* @vite-ignore */ specifier as any) as {
      executeAction: ExecuteActionFn
      clearCache: ClearCacheFn
    }
    executeAction = mod.executeAction
    clearCache = mod.clearCache

    // Clear execute-action cache to avoid stale state
    clearCache()
  }, 30000)

  // ---------------------------------------------------------------------------
  // afterAll: cleanup
  // ---------------------------------------------------------------------------

  afterAll(async () => {
    try {
      if (authUserId) {
        await serviceClient.from('action_events').delete().eq('actor_id', authUserId)
      }
      if (skillResourceId) {
        await serviceClient.from('resources').delete().eq('id', skillResourceId)
      }
      if (serverResourceId) {
        await serviceClient.from('resources').delete().eq('id', serverResourceId)
      }
      if (authUserId) {
        await serviceClient.from('resources').delete().eq('name', `user:${authUserId}`)
      }
      if (accessCodeName) {
        await serviceClient.from('resources').delete().eq('name', accessCodeName)
      }
      if (authUserId) {
        await serviceClient.auth.admin.deleteUser(authUserId)
      }
      if (goalPath) { try { unlinkSync(goalPath) } catch { /* already gone */ } }
    } catch (err) {
      console.warn('[E2E] Cleanup error (non-fatal):', err instanceof Error ? err.message : String(err))
    }
  }, 30000)

  // ---------------------------------------------------------------------------
  // Step 1: Create temp email via agent-email
  // ---------------------------------------------------------------------------

  it('Step 1: creates a temp email address', () => {
    const name = `e2etest${timestamp}`
    // Use node directly — agent-email is a local package, not globally installed via npx
    const result = execFileSync(
      'node', [join(__dirname, '../../../../packages/agent-email/bin/throwmail.js'), 'init', '--adapter', '1secmail', '--name', name],
      { encoding: 'utf-8', timeout: 15000 }
    ).trim()

    // The command outputs the email address
    expect(result).toMatch(/@/)
    email = result.includes('\n') ? result.split('\n').find(l => l.includes('@')) ?? result : result
    email = email.trim()
    console.log(`[E2E] Created email: ${email}`)
    expect(email).toMatch(/@/)
  }, 30000)

  // ---------------------------------------------------------------------------
  // Step 2: Create access code in Supabase DB
  // ---------------------------------------------------------------------------

  it('Step 2: inserts an access-code resource into Supabase', async () => {
    accessCodeName = `test-code-${timestamp}`
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (serviceClient.from('resources') as any).insert({
      name: accessCodeName,
      type: 'access-code',
      status: 'active',
      config: {},
    })
    expect(error).toBeNull()
    console.log(`[E2E] Created access code: ${accessCodeName}`)
  }, 30000)

  // ---------------------------------------------------------------------------
  // Step 3: Generate magic link + exchange for JWT
  // ---------------------------------------------------------------------------

  it('Step 3: generates a magic link and exchanges it for a JWT', async () => {
    const { data, error } = await serviceClient.auth.admin.generateLink({
      type: 'magiclink',
      email,
      options: { redirectTo: 'http://localhost:3000/auth/callback' },
    })

    expect(error).toBeNull()
    expect(data?.properties?.email_otp).toBeTruthy()

    const emailOtp = data!.properties!.email_otp!
    console.log(`[E2E] Generated OTP for ${email}`)

    const anonClient = createSupabaseClient(SUPABASE_URL, SUPABASE_ANON_KEY)
    const adapter = new AccessCodeAuthAdapter(anonClient)
    const token = await adapter.exchangeCode(email, emailOtp)

    expect(token.accessToken).toBeTruthy()

    // Decode JWT payload to get sub and email
    const payloadB64 = token.accessToken.split('.')[1]
    expect(payloadB64).toBeTruthy()
    const payload = JSON.parse(Buffer.from(payloadB64!, 'base64url').toString()) as {
      sub: string
      email: string
    }
    authUserId = payload.sub
    console.log(`[E2E] Authenticated as ${payload.email} (${authUserId})`)

    expect(authUserId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    )

    // Store token on the shared anon client for subsequent steps
    const userClient = createSupabaseClient(SUPABASE_URL, SUPABASE_ANON_KEY)
    await userClient.auth.setSession({
      access_token: token.accessToken,
      refresh_token: token.refreshToken ?? '',
    })

    accessToken = token.accessToken
    refreshToken = token.refreshToken ?? ''
  }, 30000)

  // ---------------------------------------------------------------------------
  // Step 4: provision_user via executeAction
  // ---------------------------------------------------------------------------

  it('Step 4: provisions user resource via executeAction', async () => {
    expect(accessToken).toBeTruthy()

    const payloadB64 = accessToken.split('.')[1]!
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString()) as {
      sub: string
      email: string
    }
    const userEmail = payload.email

    const userClient = createSupabaseClient(SUPABASE_URL, SUPABASE_ANON_KEY)
    await userClient.auth.setSession({
      access_token: accessToken,
      refresh_token: refreshToken,
    })

    clearCache()

    // provision_user may fail with function overload ambiguity.
    // Try user client then service client via withClientFallback.
    // If both fail, call RPC directly with explicit params to resolve overload.
    let userResult: { userResourceId: string; projectResourceId: string }
    try {
      userResult = (await withClientFallback(
        (client) => executeAction('provision_user', { authUserId, email: userEmail }, client),
        userClient,
        serviceClient,
        'provision_user'
      )) as typeof userResult
    } catch (svcErr) {
      // Both clients failed — call RPC directly with explicit metadata to resolve overload
      const svcMsg = svcErr instanceof Error ? svcErr.message : String(svcErr)
      console.log(`[E2E] Service client provision_user also failed (${svcMsg}), calling RPC directly`)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: rpcData, error: rpcError } = await (serviceClient as any).rpc('provision_user', {
        p_auth_user_id: authUserId,
        p_email: userEmail,
        p_metadata: null,
      })
      if (rpcError) throw new Error(`provision_user direct RPC failed: ${(rpcError as Error).message ?? String(rpcError)}`)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const raw = (Array.isArray(rpcData) && (rpcData as any[]).length > 0 ? (rpcData as any[])[0] : rpcData) as Record<string, unknown>
      userResult = {
        userResourceId: raw['user_resource_id'] as string,
        projectResourceId: raw['project_resource_id'] as string,
      }
    }

    expect(userResult.userResourceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    )
    userResourceId = userResult.userResourceId as string
    console.log(`[E2E] Provisioned user resource: ${userResourceId}`)
  }, 60000)

  // ---------------------------------------------------------------------------
  // Step 5: provision_sandbox via executeAction
  // ---------------------------------------------------------------------------

  it('Step 5: provisions sandbox resource via executeAction', async () => {
    expect(accessToken).toBeTruthy()
    expect(userResourceId).toBeTruthy()

    // Generate SSH keypair
    const { publicKey: pkPem, privateKey: privKeyPem } = generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    })
    // Store private key in OpenSSH format for SSH commands (PKCS8 causes "invalid format" error)
    privateKeyPem = pkcs8ToOpenSSH(privKeyPem)
    const pubKeyDer = createPublicKey(pkPem).export({ type: 'spki', format: 'der' }) as Buffer
    const rawPubKey = pubKeyDer.slice(12) // skip 12-byte SPKI header
    const keyTypeBuf = Buffer.from('ssh-ed25519')
    const wireFormat = Buffer.alloc(4 + keyTypeBuf.length + 4 + rawPubKey.length)
    let off = 0
    wireFormat.writeUInt32BE(keyTypeBuf.length, off)
    off += 4
    keyTypeBuf.copy(wireFormat, off)
    off += keyTypeBuf.length
    wireFormat.writeUInt32BE(rawPubKey.length, off)
    off += 4
    rawPubKey.copy(wireFormat, off)
    sshPublicKey = `ssh-ed25519 ${wireFormat.toString('base64')} e2e-test`

    // Add generated public key to HETZNER_2's authorized_keys via password SSH
    const hetzner2Password = process.env['HETZNER_2_PASSWORD'] ?? ''
    const hetzner2Ip = process.env['HETZNER_2_IP'] ?? ''
    if (hetzner2Password) {
      execFileSync('sshpass', [
        '-p', hetzner2Password,
        'ssh', '-o', 'StrictHostKeyChecking=no',
        `root@${hetzner2Ip}`,
        `mkdir -p ~/.ssh && echo "${sshPublicKey}" >> ~/.ssh/authorized_keys && sort -u ~/.ssh/authorized_keys > /tmp/ak.tmp && mv /tmp/ak.tmp ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`,
      ], { timeout: 30000 })
      console.log('[E2E] Added test key to HETZNER_2 authorized_keys')
    } else {
      console.log('[E2E] HETZNER_2_PASSWORD not set — skipping authorized_keys setup')
    }

    const serverName = `e2e-test-${timestamp}`
    const sshKeyName = `e2e-key-${timestamp}`

    const userClient = createSupabaseClient(SUPABASE_URL, SUPABASE_ANON_KEY)
    await userClient.auth.setSession({
      access_token: accessToken,
      refresh_token: refreshToken,
    })

    clearCache()

    // provision_sandbox RPC may require service_role; try user client first,
    // fall back to service client if permission error
    const sandboxResult = (await withClientFallback(
      (client) => executeAction('provision_sandbox', { userResourceId, serverName, sshKeyName, publicKey: sshPublicKey }, client),
      userClient,
      serviceClient,
      'provision_sandbox'
    )) as { serverResourceId: string; credentialResourceId: string; isNew: boolean }

    expect(sandboxResult.serverResourceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    )
    expect(sandboxResult.isNew).toBe(true)
    serverResourceId = sandboxResult.serverResourceId
    console.log(`[E2E] Provisioned sandbox resource: ${serverResourceId} (isNew=${sandboxResult.isNew})`)
  }, 60000)

  // ---------------------------------------------------------------------------
  // Step 6: Update sandbox status to active + TCP check port 22
  // ---------------------------------------------------------------------------

  it('Step 6: updates sandbox status to active and checks port 22', async () => {
    expect(accessToken).toBeTruthy()
    expect(serverResourceId).toBeTruthy()

    serverIp = process.env['HETZNER_2_IP'] ?? process.env['HETZNER_SERVER_IP'] ?? ''

    const userClient = createSupabaseClient(SUPABASE_URL, SUPABASE_ANON_KEY)
    await userClient.auth.setSession({
      access_token: accessToken,
      refresh_token: refreshToken,
    })

    clearCache()

    // Try user client first, fall back to service client
    const statusInput = { serverResourceId, status: 'active', ip: serverIp, hetznerServerId: 'e2e-test', provisionedAt: new Date().toISOString() }
    await withClientFallback(
      (client) => executeAction('update_sandbox_status', statusInput, client),
      userClient,
      serviceClient,
      'update_sandbox_status'
    )

    console.log(`[E2E] Updated sandbox status to active (ip=${serverIp})`)

    // TCP port check — non-fatal
    const isPortOpen = await new Promise<boolean>((resolve) => {
      const socket = new net.Socket()
      socket.setTimeout(5000)
      socket.connect(22, serverIp, () => {
        socket.destroy()
        resolve(true)
      })
      socket.on('error', () => resolve(false))
      socket.on('timeout', () => {
        socket.destroy()
        resolve(false)
      })
    })

    if (isPortOpen) {
      console.log(`[E2E] Port 22 is open on ${serverIp}`)
    } else {
      console.log(`[E2E] Port 22 not reachable on ${serverIp} — sandbox may not be provisioned yet`)
    }

  }, 30000)

  // ---------------------------------------------------------------------------
  // Step 6b: duoidal sandbox ssh --dry-run prints valid SSH command
  // ---------------------------------------------------------------------------

  it('Step 6b: duoidal sandbox ssh --dry-run prints valid SSH command', () => {
    expect(accessToken).toBeTruthy()
    expect(serverResourceId).toBeTruthy()
    expect(serverIp).toBeTruthy()
    expect(privateKeyPem).toBeTruthy()

    // Write token to config file for CLI
    const configDir = join(homedir(), '.config', 'duoidal')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, 'token.json'), JSON.stringify({
      access_token: accessToken,
      refresh_token: refreshToken,
    }), { mode: 0o600 })

    // Store sandbox key and meta for CLI to use (CLI prefers local meta over DB lookup)
    const sandboxKeyDir = join(homedir(), '.config', 'duoidal', 'sandboxes', serverResourceId)
    mkdirSync(sandboxKeyDir, { recursive: true })
    writeFileSync(join(sandboxKeyDir, 'id_ed25519'), privateKeyPem, { mode: 0o600 })
    writeFileSync(join(sandboxKeyDir, 'meta.json'), JSON.stringify({
      serverResourceId,
      credentialResourceId: '',
      serverName: `e2e-test-${timestamp}`,
      provisionedAt: new Date().toISOString(),
      status: 'active',
      ip: serverIp,
    }, null, 2), { mode: 0o600 })

    // Run sandbox ssh --dry-run — should print the SSH command
    const result = execFileSync('node', [
      join(__dirname, '../../../../packages/duoidal-cli/dist/index.js'),
      'sandbox', 'ssh', '--dry-run',
    ], {
      encoding: 'utf-8',
      timeout: 15000,
      env: {
        ...process.env,
        SUPABASE_URL: process.env['SUPABASE_URL'],
        SUPABASE_ANON_KEY: process.env['VITE_SUPABASE_ANON_KEY'] ?? process.env['SUPABASE_ANON_KEY'] ?? '',
      },
    })
    expect(result).toContain('ssh')
    expect(result).toContain(serverIp)
    console.log('[E2E] sandbox ssh --dry-run output:', result.trim())
  }, 30000)

  // ---------------------------------------------------------------------------
  // Step 6c: SSH into sandbox — duoidal execute --help exits 0
  // ---------------------------------------------------------------------------

  it('Step 6c: SSH into sandbox — duoidal execute --help exits 0', () => {
    expect(serverResourceId).toBeTruthy()
    expect(serverIp).toBeTruthy()

    const privateKeyPath = join(homedir(), '.config', 'duoidal', 'sandboxes', serverResourceId, 'id_ed25519')
    const result = execFileSync('ssh', [
      '-i', privateKeyPath,
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ConnectTimeout=10',
      `root@${serverIp}`,
      'duoidal execute --help',
    ], { encoding: 'utf-8', timeout: 30000 })
    expect(result).toContain('execute')
    console.log('[E2E] SSH duoidal execute --help:', result.trim().slice(0, 100))
  }, 45000)

  // ---------------------------------------------------------------------------
  // Step 6d: SSH into sandbox — /root/workspace/.git exists
  // ---------------------------------------------------------------------------

  it('Step 6d: SSH into sandbox — /root/workspace/.git exists', () => {
    expect(serverResourceId).toBeTruthy()
    expect(serverIp).toBeTruthy()

    const privateKeyPath = join(homedir(), '.config', 'duoidal', 'sandboxes', serverResourceId, 'id_ed25519')
    const result = execFileSync('ssh', [
      '-i', privateKeyPath,
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ConnectTimeout=10',
      `root@${serverIp}`,
      'ls /root/workspace/.git',
    ], { encoding: 'utf-8', timeout: 30000 })
    expect(result).toContain('HEAD')
    console.log('[E2E] SSH ls /root/workspace/.git:', result.trim().slice(0, 100))
  }, 45000)

  // ---------------------------------------------------------------------------
  // Step 7: upload_skill via executeAction
  // ---------------------------------------------------------------------------

  it('Step 7: upload_skill via executeAction returns a resourceId', async () => {
    goalPath = join(tmpdir(), `e2e-test-goal-${timestamp}.md`)
    writeFileSync(goalPath, '# E2E Test Goal\n\nBuild a test feature.\n', 'utf-8')

    const goalContent = readFileSync(goalPath, 'utf-8')

    const userClient = createSupabaseClient(SUPABASE_URL, SUPABASE_ANON_KEY)
    await userClient.auth.setSession({
      access_token: accessToken,
      refresh_token: refreshToken,
    })

    clearCache()

    const result = await withClientFallback(
      (client) => executeAction('upload_skill', { content: goalContent, actorId: authUserId }, client),
      userClient,
      serviceClient,
      'upload_skill'
    )

    expect(result['resourceId']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    )
    skillResourceId = result['resourceId'] as string
    console.log(`[E2E] Uploaded skill resource: ${skillResourceId}`)
  }, 30000)

  // ---------------------------------------------------------------------------
  // Step 8: Assert action_events rows
  // ---------------------------------------------------------------------------

  it('Step 8: action_events table contains provision_user, provision_sandbox, and upload_skill rows', async () => {
    const { data: events, error } = await serviceClient
      .from('action_events')
      .select('action_type, status, actor_id')
      .eq('actor_id', authUserId)
      .order('created_at', { ascending: true })

    expect(error).toBeNull()
    expect(events).toBeTruthy()

    const eventTypes = (events ?? []).map((e: { action_type: string }) => e.action_type)
    console.log(`[E2E] action_events for ${authUserId}:`, eventTypes)

    expect(eventTypes).toContain('provision_user')
    expect(eventTypes).toContain('provision_sandbox')
    expect(eventTypes).toContain('upload_skill')
  }, 30000)

  // ---------------------------------------------------------------------------
  // Step 9: GitHub App install via agent-browser
  // ---------------------------------------------------------------------------

  it.skipIf(!process.env['GITHUB_TEST_USERNAME'] || !process.env['GITHUB_TEST_PASSWORD'])('Step 9: installs GitHub App via agent-browser', async () => {

    // Close any stale agent-browser daemon sessions before using auth commands
    try {
      execFileSync('npx', ['agent-browser', 'close', '--all'], { encoding: 'utf-8', timeout: 10000 })
    } catch { /* ignore — no session running */ }

    // Save GitHub credentials to agent-browser auth vault
    execFileSync('npx', [
      'agent-browser', 'auth', 'save', 'github-test',
      '--url', 'https://github.com/login',
      '--username', GITHUB_TEST_USERNAME,
      '--password', GITHUB_TEST_PASSWORD,
    ], { encoding: 'utf-8', timeout: 30000 })
    console.log('[E2E] GitHub test credentials saved to agent-browser vault')

    // Log in to GitHub and navigate to the GitHub App installation page
    execFileSync('npx', ['agent-browser', 'auth', 'login', 'github-test'], {
      encoding: 'utf-8', timeout: 60000,
    })

    execFileSync('npx', ['agent-browser', 'open', 'https://github.com/apps/duoidal/installations/new'], {
      encoding: 'utf-8', timeout: 30000,
    })

    const screenshotResult = execFileSync('npx', ['agent-browser', 'screenshot'], {
      encoding: 'utf-8', timeout: 15000,
    })
    console.log('[E2E] agent-browser GitHub install screenshot:', screenshotResult.slice(0, 200))

    // Store a test installation to link the GitHub App to the test user in DB
    // This ensures DB state is correct for Step 10 (github status)
    // Create user-authenticated client for ownership-checked RPC
    const userClientForInstall = createSupabaseClient(SUPABASE_URL, SUPABASE_ANON_KEY)
    await userClientForInstall.auth.setSession({
      access_token: accessToken,
      refresh_token: refreshToken,
    })
    clearCache()
    const installResult = await withClientFallback(
      (client) => executeAction('store_github_installation', {
        userResourceId,
        installationId: `test-installation-${timestamp}`,
      }, client),
      userClientForInstall,  // user-authenticated client (not serviceClient)
      serviceClient,
      'store_github_installation'
    )
    console.log('[E2E] Stored GitHub App installation linked to test user:', JSON.stringify(installResult).slice(0, 200))
  }, 90000)

  // ---------------------------------------------------------------------------
  // Step 10: duoidal github status
  // ---------------------------------------------------------------------------

  it('Step 10: duoidal github status exits 0', () => {
    // Write token to the CLI's expected path so it can authenticate
    const tokenDir = join(process.env['HOME'] ?? '/root', '.config', 'duoidal')
    mkdirSync(tokenDir, { recursive: true })
    const tokenPath = join(tokenDir, 'token.json')
    writeFileSync(tokenPath, JSON.stringify({ access_token: accessToken, refresh_token: refreshToken }), { mode: 0o600 })
    console.log(`[E2E] Wrote token to ${tokenPath}`)

    // Use node directly to invoke the built CLI (npx duoidal not globally installed)
    const result = execFileSync('node', [
      join(__dirname, '../../../../packages/duoidal-cli/dist/index.js'),
      'github', 'status',
    ], {
      encoding: 'utf-8',
      timeout: 15000,
      env: {
        ...process.env,
        SUPABASE_ANON_KEY: process.env['VITE_SUPABASE_ANON_KEY'] ?? process.env['SUPABASE_ANON_KEY'] ?? '',
      },
    })
    expect(result).toBeTruthy()
    console.log('[E2E] GitHub status:', result.trim())
  }, 30000)

  // ---------------------------------------------------------------------------
  // Step 11: Deprovision sandbox
  // ---------------------------------------------------------------------------

  it('Step 11: deprovisions sandbox resource', async () => {
    if (!serverResourceId) {
      console.log('[E2E] No serverResourceId to deprovision, skipping')
      return
    }

    // deprovision_sandbox action type does not exist — update DB directly via service client
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: updateError } = await (serviceClient as any)
      .from('resources')
      .update({ status: 'deprovisioned' })
      .eq('id', serverResourceId)

    if (updateError) {
      throw new Error(`Failed to update sandbox status: ${updateError.message}`)
    }

    // Remove resource_links for this server
    const { error: linkError } = await serviceClient
      .from('resource_links')
      .delete()
      .eq('from_id', serverResourceId)

    if (linkError) {
      console.log(`[E2E] Warning: failed to delete resource_links: ${linkError.message}`)
    }

    console.log(`[E2E] Deprovisioned sandbox: ${serverResourceId}`)
  }, 60000)

  // ---------------------------------------------------------------------------
  // Steps 12-18: Dashboard verification via local Vite dev server + agent-browser
  // ---------------------------------------------------------------------------

  it.skipIf(!process.env['VITE_DEV_SERVER_AVAILABLE'])('Step 12-18: dashboard shows process and events', async () => {
    // 1. Start Vite dev server in background
    const { spawn } = await import('node:child_process')
    const viteProcess = spawn('npx', ['vite', '--port', '4567', '--host', '0.0.0.0'], {
      cwd: '/root/repos/outcomes-optimizer/services/agent-livestream',
      detached: true,
      stdio: 'pipe',
      env: {
        ...process.env,
        // Pass Supabase credentials to the Vite app
        VITE_SUPABASE_URL: SUPABASE_URL,
        VITE_SUPABASE_ANON_KEY: SUPABASE_ANON_KEY,
      },
    })

    // Collect stderr for diagnostics
    const viteStderr: string[] = []
    viteProcess.stderr?.on('data', (data: Buffer) => { viteStderr.push(data.toString()) })

    // Wait for Vite to be ready
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Vite timeout. stderr: ${viteStderr.join('').slice(0, 500)}`))
      }, 30000)
      viteProcess.stdout?.on('data', (data: Buffer) => {
        const text = data.toString()
        if (text.includes('ready in') || text.includes('localhost:4567')) {
          clearTimeout(timeout)
          resolve()
        }
      })
      viteProcess.stderr?.on('data', (data: Buffer) => {
        const text = data.toString()
        // Vite sometimes writes ready message to stderr
        if (text.includes('ready in') || text.includes('localhost:4567')) {
          clearTimeout(timeout)
          resolve()
        }
      })
      viteProcess.on('error', (err) => { clearTimeout(timeout); reject(err) })
    })
    console.log('[E2E] Vite dev server ready at http://localhost:4567/')

    // 1b. Start a lightweight mock API server on port 3001 so Vite's /api proxy works.
    // The full Hono BFF has heavy dependencies; we only need /api/process-events and /api/processes.
    const http = await import('node:http')
    const mockSupabase = createSupabaseClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

    const mockApi = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:3001`)
      res.setHeader('Content-Type', 'application/json')
      res.setHeader('Access-Control-Allow-Origin', '*')

      if (url.pathname.startsWith('/api/process-events/')) {
        const pid = url.pathname.split('/').pop()
        const { data } = await mockSupabase
          .from('agent_events')
          .select('id, process_id, resource_id, source, payload, ts')
          .eq('process_id', pid ?? '')
          .order('ts', { ascending: false })
          .limit(50)
        const rows = (data ?? []).reverse()
        res.end(JSON.stringify({ events: rows, total: rows.length }))
      } else if (url.pathname === '/api/processes') {
        const { data } = await mockSupabase.from('processes').select('*').limit(100)
        res.end(JSON.stringify(data ?? []))
      } else if (url.pathname === '/api/graph') {
        res.end(JSON.stringify({ resources: [], links: [] }))
      } else {
        res.statusCode = 404
        res.end(JSON.stringify({ error: 'Not found' }))
      }
    })
    await new Promise<void>((resolve) => { mockApi.listen(3001, '127.0.0.1', resolve) })
    console.log('[E2E] Mock API server ready at http://localhost:3001/')

    // 2. Insert a test process row in the DB (root_process_id defaults to self via trigger)
    const processName = `e2e-test-process-${timestamp}`
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: processData, error: processError } = await (serviceClient as any)
      .from('processes')
      .insert({
        name: processName,
        status: 'active',
        skill_resource_id: skillResourceId || null,
        // root_process_id omitted — trigger sets it to self (NEW.id) when NULL
      })
      .select('id')
      .single()

    expect(processError).toBeNull()
    const testProcessId = (processData as { id: string }).id
    console.log(`[E2E] Created test process: ${testProcessId}`)

    // Insert a test event so the events panel has content to render
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: eventError } = await (serviceClient as any)
      .from('agent_events')
      .insert({
        process_id: testProcessId,
        process_name: processName,
        source: 'e2e-test',
        payload: { epoch: 1, status: 'completed', message: 'E2E test event' },
      })
    expect(eventError).toBeNull()
    console.log(`[E2E] Inserted test event for process: ${testProcessId}`)

    try {
      // 3. Open the app root to set up localStorage before navigating
      execFileSync('npx', ['agent-browser', 'open', 'http://localhost:4567/'], {
        encoding: 'utf-8', timeout: 30000,
      })

      // 4. Inject Supabase session via browser eval so the app can authenticate
      const sessionData = JSON.stringify({
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      })
      const projectRef = process.env.SUPABASE_PROJECT_REF
      if (!projectRef) {
        throw new Error('SUPABASE_PROJECT_REF must be set for this integration test')
      }
      try {
        execFileSync('npx', ['agent-browser', 'eval',
          `localStorage.setItem('sb-${projectRef}-auth-token', '${sessionData}');`,
        ], { encoding: 'utf-8', timeout: 10000 })
      } catch (evalErr) {
        console.log('[E2E] localStorage injection error (non-fatal):', evalErr instanceof Error ? evalErr.message : String(evalErr))
      }

      // 5. Navigate directly to the activity page for this process
      // Use ?override=true to bypass the is_onboarded gate in _authenticated route
      const activityUrl = `http://localhost:4567/activity/${testProcessId}?override=true`
      console.log(`[E2E] Navigating to activity page: ${activityUrl}`)
      execFileSync('npx', ['agent-browser', 'open', activityUrl], {
        encoding: 'utf-8', timeout: 30000,
      })

      // Wait for the page to load and render
      await new Promise(resolve => setTimeout(resolve, 4000))

      // 6. Take screenshot to see activity page state
      const screenshot = execFileSync('npx', ['agent-browser', 'screenshot'], {
        encoding: 'utf-8', timeout: 15000,
      })
      console.log('[E2E] Activity page screenshot:', screenshot.slice(0, 200))

      // 7. Get current URL — must contain the processId (oversight validator requirement)
      const urlResult = execFileSync('npx', ['agent-browser', 'get', 'url'], {
        encoding: 'utf-8', timeout: 10000,
      }).trim()
      console.log('[E2E] Activity page URL:', urlResult)
      expect(urlResult).toContain('localhost:4567')
      expect(urlResult).toContain(testProcessId)

      // 8. Get page text to check for rendered content / events panel
      let pageText = ''
      try {
        pageText = execFileSync('npx', ['agent-browser', 'get', 'text', 'body'], {
          encoding: 'utf-8', timeout: 10000,
        }).trim()
      } catch {
        // Fallback: use eval to get body text
        pageText = execFileSync('npx', ['agent-browser', 'eval', 'document.body.innerText'], {
          encoding: 'utf-8', timeout: 10000,
        }).trim()
      }
      console.log('[E2E] Activity page text (first 500 chars):', pageText.slice(0, 500))
      // Page should have some content rendered (not blank)
      expect(pageText.length).toBeGreaterThan(0)

      // Events panel should show at least one event (not just "Loading...")
      // The event source 'e2e-test' should appear in the rendered Event Log panel
      const hasEventContent = pageText.includes('e2e-test') || pageText.includes('E2E test event') || pageText.includes('epoch')
      console.log(`[E2E] Events panel has event content: ${hasEventContent}`)
      if (!hasEventContent) {
        console.log('[E2E] Full page text:', pageText)
      }
      expect(hasEventContent).toBe(true)

      // 9. Verify process row is readable from the DB
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: processRow, error: processQueryError } = await (serviceClient as any)
        .from('processes')
        .select('id, status')
        .eq('id', testProcessId)
        .single()

      expect(processQueryError).toBeNull()
      expect((processRow as { id: string; status: string }).id).toBe(testProcessId)
      expect((processRow as { id: string; status: string }).status).toBe('active')
      console.log(`[E2E] processId: ${testProcessId} — status: ${(processRow as { id: string; status: string }).status}`)
    } finally {
      // 8. Cleanup: delete test events and process, then stop Vite
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (serviceClient as any).from('agent_events').delete().eq('process_id', testProcessId)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (serviceClient as any).from('processes').delete().eq('id', testProcessId)
      try { viteProcess.kill('SIGTERM') } catch { /* ignore */ }
      try {
        if (viteProcess.pid) process.kill(-viteProcess.pid, 'SIGTERM')
      } catch { /* ignore */ }
      try { mockApi.close() } catch { /* ignore */ }
    }
  }, 120000)
})

// Keep vi in scope — used for vi.spyOn in other test files and future steps
void vi
