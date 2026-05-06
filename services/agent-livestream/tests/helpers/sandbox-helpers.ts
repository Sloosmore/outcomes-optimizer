/**
 * Shared helpers for sandbox E2E tests.
 * All helpers assume process.env vars are set by the test runner.
 */

export const TEST_PUBLIC_KEY =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFolvRs/0YEJI2TCr2dUhIZI3AI6GWx1sq+oWBz9iZYA sandbox-e2e-test'

export const TIMEOUTS = {
  CF_TLS_ACTIVE: 300_000,   // CF HTTP-01 validation takes 3-5 min after hostname is created
  HETZNER_GONE: 180_000,
  SANDBOX_ACTIVE: 600_000,  // Docker install on fresh cx23 Ubuntu 24.04 takes 4-8 min; 10 min total
  POLL_INTERVAL: 5_000,
  VOICE_ROUND_TRIP: 90_000,
  IFRAME_LOAD: 15_000,
} as const

function requireEnv(key: string): string {
  const val = process.env[key]
  if (!val) throw new Error(`Missing required env var: ${key}`)
  return val
}

/** Wait until all sandbox VMs and their Primary IPs on the account have been deleted (quota free). */
export async function waitForHetznerSlotFree(timeoutMs = 120_000): Promise<void> {
  const apiToken = process.env['HETZNER_API_TOKEN']
  if (!apiToken) return // No token — skip polling, let provision attempt proceed
  const start = Date.now()

  // Phase 1: wait for servers to be gone
  while (Date.now() - start < timeoutMs) {
    const res = await fetch('https://api.hetzner.cloud/v1/servers', {
      headers: { Authorization: `Bearer ${apiToken}` },
    })
    const data = await res.json() as { servers: Array<{ name: string }> }
    // Only count sandbox VMs (named sandbox-<uuid>)
    const sandboxCount = data.servers.filter(s => s.name.startsWith('sandbox-')).length
    if (sandboxCount === 0) break
    await new Promise<void>(r => setTimeout(r, 5_000))
  }
  if (Date.now() - start >= timeoutMs) throw new Error(`Hetzner servers not gone after ${timeoutMs / 1000}s`)

  // Phase 2: wait for Primary IPs to be released.
  // Hetzner enforces a Primary IP quota separate from the server quota. Even after the
  // server is gone (404), Primary IPs may take a few more seconds to be fully released,
  // causing the next server creation to fail with "Primary IP limit exceeded".
  // Phase 2: wait up to 60s for primary IPs to be fully released
  // (Hetzner's Primary IP quota lags the server deletion by a few seconds).
  const ipEnd = Date.now() + 60_000
  while (Date.now() < ipEnd) {
    const res = await fetch('https://api.hetzner.cloud/v1/primary_ips', {
      headers: { Authorization: `Bearer ${apiToken}` },
    })
    const data = await res.json() as { primary_ips: unknown[] }
    if (data.primary_ips.length === 0) break
    await new Promise<void>(r => setTimeout(r, 2_000))
  }

  // Settling delay: Hetzner's internal quota state can lag the list API by 10-15s.
  // Without this, a provision call immediately after the lists return empty can still
  // get a quota rejection from the create endpoint. 15s is empirically sufficient to
  // prevent the quota race between consecutive sandbox-e2e test cycles.
  await new Promise<void>(r => setTimeout(r, 15_000))
}

export async function signIn(email: string, password: string): Promise<string> {
  // SUPABASE_ANON_KEY and VITE_SUPABASE_ANON_KEY hold the same value; accept either
  // so the test works whether the runner exposes the prefixed or unprefixed name.
  const anonKey = process.env['SUPABASE_ANON_KEY'] ?? requireEnv('VITE_SUPABASE_ANON_KEY')
  const res = await fetch(
    `${requireEnv('SUPABASE_URL')}/auth/v1/token?grant_type=password`,
    {
      method: 'POST',
      headers: {
        apikey: anonKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email, password }),
    },
  )
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`signIn failed: ${res.status} ${body}`)
  }
  const data = (await res.json()) as { access_token: string }
  if (!data.access_token) throw new Error('signIn: no access_token in response')
  return data.access_token
}

export async function createTestUser(
  email: string,
): Promise<{ id: string; jwt: string; email: string; password: string }> {
  const password = `TestPass123!-${Date.now()}`
  const supabaseUrl = requireEnv('SUPABASE_URL')
  const serviceKey = requireEnv('SUPABASE_SERVICE_KEY')
  const createRes = await fetch(
    `${supabaseUrl}/auth/v1/admin/users`,
    {
      method: 'POST',
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email, password, email_confirm: true }),
    },
  )
  if (!createRes.ok) {
    const body = await createRes.text()
    throw new Error(`createTestUser failed: ${createRes.status} ${body}`)
  }
  const user = (await createRes.json()) as {
    user?: { id: string }
    id?: string
  }
  const userId = user.user?.id ?? user.id ?? ''

  // Call provision_user RPC to create the user resource with status='approved'.
  // The provision_sandbox endpoint checks for an approved user resource before allowing VM creation.
  // Handle 409 Conflict as idempotent — a resource with this auth_user_id may already exist from
  // a previous partial test run. Either way, the user is approved and ready to provision.
  const rpcRes = await fetch(`${supabaseUrl}/rest/v1/rpc/provision_user`, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ p_auth_user_id: userId, p_email: email }),
  })
  if (!rpcRes.ok && rpcRes.status !== 409) {
    const body = await rpcRes.text()
    throw new Error(`provision_user RPC failed: ${rpcRes.status} ${body}`)
  }

  const jwt = await signIn(email, password)
  return { id: userId, jwt, email, password }
}

export async function deleteTestUser(userId: string): Promise<void> {
  // The resources table has a non-cascading FK to auth.users on auth_user_id.
  // We must remove the user resource (and its links) before deleting the auth user
  // to avoid a FK violation (SQLSTATE 23503).
  const supabaseUrl = requireEnv('SUPABASE_URL')
  const serviceKey = requireEnv('SUPABASE_SERVICE_KEY')
  const authHeaders = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` }

  // Find the user resource linked to this auth user
  const resourceRes = await fetch(
    `${supabaseUrl}/rest/v1/resources?auth_user_id=eq.${userId}&type=eq.user&select=id`,
    { headers: { ...authHeaders, 'Content-Type': 'application/json' } },
  )
  if (resourceRes.ok) {
    const resources = (await resourceRes.json()) as Array<{ id: string }>
    for (const resource of resources) {
      // Delete outbound links
      await fetch(
        `${supabaseUrl}/rest/v1/resource_links?from_id=eq.${resource.id}`,
        { method: 'DELETE', headers: authHeaders },
      )
      // Delete inbound links
      await fetch(
        `${supabaseUrl}/rest/v1/resource_links?to_id=eq.${resource.id}`,
        { method: 'DELETE', headers: authHeaders },
      )
      // Delete the resource itself
      await fetch(
        `${supabaseUrl}/rest/v1/resources?id=eq.${resource.id}`,
        { method: 'DELETE', headers: authHeaders },
      )
    }
  }

  const res = await fetch(
    `${supabaseUrl}/auth/v1/admin/users/${userId}`,
    {
      method: 'DELETE',
      headers: authHeaders,
    },
  )
  if (!res.ok && res.status !== 404) {
    throw new Error(`deleteTestUser failed: ${res.status}`)
  }
}

export async function mintVoiceJwt(
  userId: string,
  roomId: string,
): Promise<string> {
  const { SignJWT } = await import('jose')
  const secret = new TextEncoder().encode(requireEnv('VOICE_TOOL_JWT_SECRET'))
  return new SignJWT({
    user_id: userId,
    room_id: roomId,
    scope: 'voice_tool_exec',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('5m')
    .setIssuedAt()
    .sign(secret)
}

export async function pollCF(
  url: string,
  condition: (data: unknown) => boolean,
  timeoutMs = TIMEOUTS.CF_TLS_ACTIVE,
): Promise<boolean> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${requireEnv('CLOUDFLARE_API_TOKEN')}`,
      },
    })
    if (res.status === 404) return condition({ status: 404 })
    const data: unknown = await res.json()
    if (condition(data)) return true
    await new Promise<void>((r) => setTimeout(r, TIMEOUTS.POLL_INTERVAL))
  }
  return false
}

export async function pollHetznerGone(
  serverId: string,
  timeoutMs = TIMEOUTS.HETZNER_GONE,
): Promise<boolean> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    const res = await fetch(
      `https://api.hetzner.cloud/v1/servers/${serverId}`,
      {
        headers: {
          Authorization: `Bearer ${requireEnv('HETZNER_API_TOKEN')}`,
        },
      },
    )
    if (res.status === 404) return true
    await new Promise<void>((r) => setTimeout(r, TIMEOUTS.POLL_INTERVAL))
  }
  return false
}

export async function bff(
  path: string,
  jwt: string,
  options: RequestInit = {},
): Promise<Response> {
  const bffUrl = process.env['SANDBOX_BFF_URL'] ?? ''
  return fetch(`${bffUrl}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    },
  })
}

export async function provisionSandbox(
  jwt: string,
  publicKey: string,
): Promise<{ resourceId: string }> {
  const res = await bff('/api/sandbox/provision', jwt, {
    method: 'POST',
    body: JSON.stringify({ publicKey }),
  })
  if (!res.ok)
    throw new Error(`provision failed: ${res.status} ${await res.text()}`)
  const end = Date.now() + TIMEOUTS.SANDBOX_ACTIVE
  while (Date.now() < end) {
    const statusRes = await bff('/api/sandbox/status', jwt)
    const status = (await statusRes.json()) as {
      status: string
      ip?: string
      resourceId: string
    }
    if (status.status === 'active') return { resourceId: status.resourceId }
    await new Promise<void>((r) => setTimeout(r, TIMEOUTS.POLL_INTERVAL))
  }
  throw new Error('sandbox did not become active within 5 minutes')
}

export async function deprovisionSandbox(jwt: string): Promise<void> {
  const res = await bff('/api/sandbox/deprovision', jwt, { method: 'DELETE' })
  if (!res.ok && res.status !== 404)
    throw new Error(`deprovision failed: ${res.status}`)
}

/** Query Supabase table with service key; returns parsed JSON rows */
export async function supabaseQuery(
  table: string,
  params: string,
): Promise<unknown[]> {
  const res = await fetch(
    `${requireEnv('SUPABASE_URL')}/rest/v1/${table}?${params}`,
    {
      headers: {
        apikey: requireEnv('SUPABASE_SERVICE_KEY'),
        Authorization: `Bearer ${requireEnv('SUPABASE_SERVICE_KEY')}`,
        'Content-Type': 'application/json',
      },
    },
  )
  return res.json() as Promise<unknown[]>
}

/** CF custom-hostnames API URL for the base hostname (resourceId.example.com) */
export function cfHostnameUrl(resourceId: string): string {
  const zone = requireEnv('CLOUDFLARE_ZONE_ID')
  // The CF adapter registers the base hostname (resourceId.example.com) with wildcard=true
  // and no ssl block — it uses the zone's *.example.com wildcard cert, which activates
  // immediately. Traffic routing for *.resourceId.example.com goes through this hostname.
  const hostname = `${resourceId}.example.com`
  return `https://api.cloudflare.com/client/v4/zones/${zone}/custom_hostnames?hostname=${hostname}`
}

/** Condition for "CF hostname is gone" used in pollCF */
export function cfGoneCondition(data: unknown): boolean {
  const d = data as { status?: number; result?: unknown[] }
  return (
    d.status === 404 ||
    (Array.isArray(d.result) && d.result.length === 0)
  )
}

/**
 * Assert that a sandbox has been fully cleaned up:
 * Hetzner server gone, CF hostname gone, DB row deleted.
 */
export async function assertSandboxCleanup(
  resourceId: string,
  hetznerServerId?: string,
): Promise<void> {
  const { expect } = await import('@playwright/test')
  if (hetznerServerId) {
    const gone = await pollHetznerGone(hetznerServerId)
    expect(gone, 'Hetzner server should be deleted').toBe(true)
  }
  const cfGone = await pollCF(cfHostnameUrl(resourceId), cfGoneCondition)
  expect(cfGone, 'CF hostname should be removed after deprovision').toBe(true)
  const rows = await supabaseQuery('resources', `id=eq.${resourceId}&select=id`)
  expect(rows.length, 'Resource row should be deleted from DB').toBe(0)
}

/**
 * Poll the mermaid server health endpoint until it returns 200.
 * Ensures cloudflared, the artifact-router, and the mermaid server are all
 * running before the voice flow starts. Without this, the artifact iframe
 * loads before the VM services are up and the SVG cannot be served.
 */
export async function pollMermaidHealth(
  resourceId: string,
  timeoutMs = 300_000,
): Promise<boolean> {
  const healthUrl = `https://artifact-${resourceId}-3737.example.com/health`
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    try {
      const res = await fetch(healthUrl, { signal: AbortSignal.timeout(10_000) })
      if (res.ok) return true
    } catch {
      // Ignore network errors (cloudflared not yet up, TLS handshake failure, etc.)
    }
    await new Promise<void>((r) => setTimeout(r, TIMEOUTS.POLL_INTERVAL))
  }
  return false
}

/** Run an exec command on a sandbox and return the stdout string */
export async function sandboxExec(jwt: string, command: string): Promise<string> {
  const r = await bff('/api/sandbox/exec', jwt, {
    method: 'POST',
    body: JSON.stringify({ command }),
  })
  if (!r.ok) throw new Error(`sandboxExec failed: ${r.status} ${await r.text()}`)
  const j = (await r.json()) as { stdout?: string; output?: string }
  // The /exec route returns { stdout, stderr, exitCode }
  return j.stdout ?? j.output ?? ''
}
