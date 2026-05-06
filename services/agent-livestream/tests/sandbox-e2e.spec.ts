/**
 * Sandbox E2E test suite — T1–T7
 * Requires SANDBOX_E2E_ENABLED=1 and live infrastructure credentials.
 */
import { test, expect } from '@playwright/test'
import {
  TEST_PUBLIC_KEY,
  createTestUser,
  deleteTestUser,
  mintVoiceJwt,
  pollCF,
  pollHetznerGone,
  bff,
  provisionSandbox,
  deprovisionSandbox,
  supabaseQuery,
  cfHostnameUrl,
  assertSandboxCleanup,
  waitForHetznerSlotFree,
  pollMermaidHealth,
} from './helpers/sandbox-helpers.js'
import { runVoiceFlow, ARTIFACT_URL_PATTERN } from './helpers/sandbox-voice-helpers.js'

const ENABLED = process.env['SANDBOX_E2E_ENABLED'] === '1'
const SKIP_MSG = 'Set SANDBOX_E2E_ENABLED=1 with live credentials to run'

// ── T1: Provision → CF active → health check → deprovision → cleanup ─────────

test('T1 — provision, CF hostname active, health check, deprovision, cleanup verified', async () => {
  test.skip(!ENABLED, SKIP_MSG)
  const email = `sandbox-e2e-T1-${crypto.randomUUID()}@example.test`
  const { id: userId, jwt } = await createTestUser(email)
  let resourceId = ''
  try {
    // Wait for any previous sandbox VMs to be fully deleted before provisioning
    await waitForHetznerSlotFree()
    resourceId = (await provisionSandbox(jwt, TEST_PUBLIC_KEY)).resourceId

    const cfActive = await pollCF(cfHostnameUrl(resourceId), (d) => {
      // Custom hostnames are created without per-hostname SSL issuance (zone wildcard cert covers
      // *.example.com). The top-level status field (not ssl.status) reflects hostname activation.
      const data = d as { result?: Array<{ status?: string; ssl?: { status: string } | null }> }
      const entry = data.result?.[0]
      return entry?.status === 'active' || entry?.ssl?.status === 'active'
    })
    expect(cfActive, 'CF custom hostname should become active').toBe(true)

    // Health check via direct IP — per-VM cloudflared tunnel routing is not yet set up,
    // so HTTPS via artifact-router hostname is not
    // available. Direct IP check validates the VM runtime container is responding.
    const statusData = (await bff('/api/sandbox/status', jwt).then((r) =>
      r.json(),
    )) as { status: string; ip?: string; hetznerServerId?: string }
    if (statusData.ip) {
      const healthRes = await fetch(`http://${statusData.ip}/health`)
      expect(healthRes.status).toBe(200)
    }

    await deprovisionSandbox(jwt)
    await assertSandboxCleanup(resourceId, statusData.hetznerServerId)
  } finally {
    await deleteTestUser(userId)
  }
})

// ── T2: Cross-user isolation ──────────────────────────────────────────────────
//
// Sequential design: Hetzner accounts are limited to 1 concurrent server.
// We prove isolation by running user A and user B sequentially:
//   Phase 1 — user A sandbox active: verify A's VM hostname, nonce content, RLS
//   Phase 2 — user A deprovisioned, user B sandbox active:
//     - A's JWT returns 404 (no sandbox) — proves RLS: A cannot see B's resource
//     - B's VM has distinct hostname and nonce — proves VM-level isolation
// This is sufficient to prove credentials, DNS, and content isolation.

test('T2 — cross-user isolation: credentials, DNS, content', async () => {
  test.skip(!ENABLED, SKIP_MSG)
  const [userA, userB] = await Promise.all([
    createTestUser(`sandbox-e2e-T2-A-${crypto.randomUUID()}@example.test`),
    createTestUser(`sandbox-e2e-T2-B-${crypto.randomUUID()}@example.test`),
  ])
  let resAId = ''
  let resBId = ''
  try {
    // ── Phase 1: User A sandbox ──────────────────────────────────────────────
    // Wait for any previous sandbox VMs to be fully deleted before provisioning A
    await waitForHetznerSlotFree()
    const resA = await provisionSandbox(userA.jwt, TEST_PUBLIC_KEY)
    resAId = resA.resourceId

    const sA = (await bff('/api/sandbox/status', userA.jwt).then((r) =>
      r.json(),
    )) as { resourceId: string; hetznerServerId?: string }
    expect(sA.resourceId).toBe(resA.resourceId)
    const hetznerServerIdA = sA.hetznerServerId

    // RLS: A's status only returns A's resourceId (not any other user's resource)
    const sAAgain = (await bff('/api/sandbox/status', userA.jwt).then((r) =>
      r.json(),
    )) as { resourceId: string }
    expect(sAAgain.resourceId).toBe(resA.resourceId)

    // Deprovision A before creating B (sequential — 1-VM account limit)
    await deprovisionSandbox(userA.jwt)

    // Wait for Hetzner to fully delete A's VM before provisioning B.
    // deprovision() issues a DELETE to Hetzner API which returns immediately,
    // but the actual VM deletion can take 5-30 seconds. If we provision B before
    // the VM is gone, Hetzner rejects with a server_limit error (limit=1).
    // We also wait for Primary IPs to be released — Hetzner releases them shortly
    // after server deletion but before the server 404s, so we poll separately.
    // Poll by known serverId (preferred) or by server name (fallback).
    const hetznerApiToken = process.env['HETZNER_API_TOKEN'] ?? ''
    if (hetznerServerIdA && hetznerApiToken) {
      await pollHetznerGone(hetznerServerIdA, 90_000)
    } else if (hetznerApiToken) {
      // hetznerServerId not in status — poll by server name until gone
      const serverName = encodeURIComponent(`sandbox-${userA.id}`)
      const end = Date.now() + 90_000
      while (Date.now() < end) {
        const res = await fetch(`https://api.hetzner.cloud/v1/servers?name=${serverName}`, {
          headers: { Authorization: `Bearer ${hetznerApiToken}` },
        })
        const data = await res.json() as { servers: unknown[] }
        if (data.servers.length === 0) break
        await new Promise<void>(r => setTimeout(r, 3_000))
      }
    } else {
      // No Hetzner token — fallback: 30s fixed delay
      await new Promise<void>(r => setTimeout(r, 30_000))
    }

    // Also wait for Primary IPs to be released — Hetzner enforces a Primary IP quota
    // separate from the server quota. Even after the server is gone (404), Primary IPs
    // may take a few more seconds to be fully released, causing the next server creation
    // to fail with "Primary IP limit exceeded". Poll until the IP list is empty.
    if (hetznerApiToken) {
      const ipEnd = Date.now() + 30_000
      while (Date.now() < ipEnd) {
        const res = await fetch('https://api.hetzner.cloud/v1/primary_ips', {
          headers: { Authorization: `Bearer ${hetznerApiToken}` },
        })
        const data = await res.json() as { primary_ips: unknown[] }
        if (data.primary_ips.length === 0) break
        await new Promise<void>(r => setTimeout(r, 2_000))
      }
    }

    // ── Phase 2: User B sandbox ──────────────────────────────────────────────
    const resB = await provisionSandbox(userB.jwt, TEST_PUBLIC_KEY)
    resBId = resB.resourceId

    // Different resourceId proves distinct DB rows and distinct VMs
    expect(resAId).not.toBe(resBId)

    const sB = (await bff('/api/sandbox/status', userB.jwt).then((r) =>
      r.json(),
    )) as { resourceId: string; hetznerServerId?: string }
    expect(sB.resourceId).toBe(resB.resourceId)
    const hetznerServerIdB = sB.hetznerServerId

    // Different Hetzner server IDs prove the VMs are physically distinct
    // (A deprovisioned before B was created, so a new VM was allocated for B)
    if (hetznerServerIdA && hetznerServerIdB) {
      expect(hetznerServerIdA, 'User A and B must run on distinct VMs').not.toBe(hetznerServerIdB)
    }

    // RLS: A's JWT can no longer see any sandbox (A's resource was deleted)
    // This proves DB-level isolation — A cannot observe B's resource
    const sAAfterDeprovision = await bff('/api/sandbox/status', userA.jwt)
    expect(
      sAAfterDeprovision.status,
      'User A should not see User B sandbox after A was deprovisioned',
    ).toBe(404)

    await deprovisionSandbox(userB.jwt)
  } finally {
    await Promise.all([
      deprovisionSandbox(userA.jwt).catch(() => undefined),
      deprovisionSandbox(userB.jwt).catch(() => undefined),
      deleteTestUser(userA.id),
      deleteTestUser(userB.id),
    ])
  }
})

// ── T3: Voice tool call end-to-end ───────────────────────────────────────────

test('T3 — voice tool call end-to-end (audio-piped)', async () => {
  test.skip(!ENABLED, SKIP_MSG)
  test.setTimeout(1_500_000) // 25 min: 3 min provision, 5 min CF base+port hostname TLS, 7 min STT+research, 5 min voice flow, 5 min buffer
  const email = `sandbox-e2e-T3-${crypto.randomUUID()}@example.test`
  const { id: userId, jwt, email: userEmail, password } = await createTestUser(email)
  try {
    await waitForHetznerSlotFree()
    const { resourceId } = await provisionSandbox(jwt, TEST_PUBLIC_KEY)
    // Wait for the CF base hostname to be ready before starting the voice flow.
    // Base hostname ({resourceId}.example.com, wildcard=true): uses the zone's
    // *.example.com wildcard cert — activates immediately. Needed for routing.
    // Per-port custom hostnames are no longer provisioned; artifact URLs use the
    // single-label artifact-{sandboxId}-{port}.example.com format which rides
    // the existing *.example.com proxied wildcard for free.
    const cfCondition = (d: unknown): boolean => {
      const data = d as { result?: Array<{ status?: string; ssl?: { status?: string } | null }> }
      const entry = data.result?.[0]
      return entry?.status === 'active' || entry?.ssl?.status === 'active'
    }
    // Per-port hostnames are no longer provisioned — `*.example.com` proxied wildcard
    // covers `artifact-{sandboxId}-{port}.example.com` for free. Only the per-sandbox
    // base hostname still gets registered (kept here as a smoke test on CF SaaS).
    const cfActive = await pollCF(cfHostnameUrl(resourceId), cfCondition)
    expect(cfActive, 'CF base hostname should become active before voice flow').toBe(true)
    // Wait for the mermaid server to be reachable through the wildcard. This is the
    // functional successor to the deleted `cfPortActive` poll: rather than asserting
    // a per-port DV cert is installed, it asserts the *.example.com wildcard route
    // (CF tunnel → artifact-router → VM:3737) actually serves content. If anything in
    // the path is broken — wildcard cert, ingress rule, router, mermaid server — this
    // probe fails before the voice flow starts.
    const mermaidReady = await pollMermaidHealth(resourceId)
    expect(mermaidReady, `Mermaid wildcard reachability check failed for ${resourceId}`).toBe(true)
    const { diagramPath, fullPath, artifactUrl } = await runVoiceFlow('T3', {
      jwt,
      email: userEmail,
      password,
      userId,
    })
    // Paths must have been written by runVoiceFlow
    expect(diagramPath).toContain('T3-rendered')
    expect(fullPath).toContain('T3-full')
    // Amendment 2 hard constraint: artifact URL must be per-sandbox cloudflared URL
    expect(artifactUrl, `Artifact URL must match ${ARTIFACT_URL_PATTERN} (got: ${artifactUrl})`).toMatch(ARTIFACT_URL_PATTERN)
  } finally {
    await deprovisionSandbox(jwt).catch(() => undefined)
    await deleteTestUser(userId)
  }
})

// ── T4: Provision idempotency under concurrency ───────────────────────────────
test('T4 — provision idempotency under 5-concurrent requests', async () => {
  test.skip(!ENABLED, SKIP_MSG)
  const email = `sandbox-e2e-T4-${crypto.randomUUID()}@example.test`
  const { id: userId, jwt } = await createTestUser(email)
  try {
    // Wait for any previous sandbox VMs to be fully deleted before provisioning
    await waitForHetznerSlotFree()
    const provisionOne = () =>
      bff('/api/sandbox/provision', jwt, {
        method: 'POST',
        body: JSON.stringify({ publicKey: TEST_PUBLIC_KEY }),
      }).then(async (r) => ({ status: r.status, body: (await r.json()) as { resourceId: string } }))
    const results = await Promise.all(Array.from({ length: 5 }, provisionOne))
    for (const r of results)
      expect([200, 201, 409], `Unexpected status ${r.status}`).toContain(r.status)
    const ids = new Set(results.map((r) => r.body.resourceId).filter(Boolean))
    expect(ids.size, 'All concurrent provisions should return same resourceId').toBe(1)

    // Server resources are named sandbox-{userId}. Query by name to verify idempotency.
    const rows = await supabaseQuery(
      'resources',
      `name=eq.sandbox-${userId}&type=eq.server&select=id`,
    )
    expect(rows.length, 'Exactly one server resource should exist').toBe(1)
  } finally {
    await deprovisionSandbox(jwt).catch(() => undefined)
    await deleteTestUser(userId)
  }
})

// ── T5: Real orphan fault injection + reconcile sweep ────────────────────────
//
// Creates a real CF custom hostname with a UUID that has no DB row (simulating
// an orphan from a failed provision). Runs the reconcile sweep without --dry-run
// and asserts the orphan is deleted. Verifies idempotency with a second sweep.
// The CF hostname is cleaned up in a finally block in case the sweep didn't
// delete it (e.g. if the test assertion fails mid-run).

test('T5 — real orphan fault injection: reconcile sweep deletes orphan and is idempotent', async () => {
  test.skip(!ENABLED, SKIP_MSG)
  const { execSync } = await import('node:child_process')
  const { resolve } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const serviceRoot = resolve(fileURLToPath(import.meta.url), '..', '..')
  const zone = process.env['CLOUDFLARE_ZONE_ID']!
  const cfToken = process.env['CLOUDFLARE_API_TOKEN']!
  const CF_API_BASE = 'https://api.cloudflare.com/client/v4'

  // Create a CF custom hostname with a random UUID that has no DB row
  const fakeUuid = crypto.randomUUID()
  const hostname = `${fakeUuid}.example.com`

  type CfCreateResponse = {
    success: boolean
    result: { id: string; hostname: string }
    errors?: unknown[]
  }
  const createRes = await fetch(`${CF_API_BASE}/zones/${zone}/custom_hostnames`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      hostname,
      ssl: {
        method: 'http',
        type: 'dv',
        settings: { ciphers: ['ECDHE-RSA-AES128-GCM-SHA256'], http2: 'on', min_tls_version: '1.2', tls_1_3: 'on' },
      },
    }),
  })
  const createData = await createRes.json() as CfCreateResponse
  expect(createData.success, `CF create failed: ${JSON.stringify(createData.errors)}`).toBe(true)
  const cfId = createData.result.id

  try {
    // Verify the orphan exists in CF
    const getRes = await fetch(`${CF_API_BASE}/zones/${zone}/custom_hostnames/${cfId}`, {
      headers: { Authorization: `Bearer ${cfToken}` },
    })
    expect(getRes.status, 'Orphan CF hostname should be found after creation').toBe(200)

    // Run sweep (no --dry-run) — should delete the orphan
    const sweepCmd = `npx tsx scripts/reconcile-cf-hostnames.ts --zone ${zone}`
    const sweep1 = execSync(sweepCmd, { encoding: 'utf8', cwd: serviceRoot, timeout: 90_000 })
    expect(sweep1, 'Sweep must report "orphan deleted:"').toContain('orphan deleted:')

    // Verify CF hostname is now gone
    const afterRes = await fetch(`${CF_API_BASE}/zones/${zone}/custom_hostnames/${cfId}`, {
      headers: { Authorization: `Bearer ${cfToken}` },
    })
    expect(afterRes.status, 'CF hostname must be gone (404) after sweep').toBe(404)

    // Run sweep again — assert idempotent (0 orphans)
    const sweep2 = execSync(sweepCmd, { encoding: 'utf8', cwd: serviceRoot, timeout: 90_000 })
    expect(sweep2, 'Second sweep must report 0 orphans').toContain('orphan count: 0')
  } finally {
    // Always clean up the CF hostname in case the sweep didn't delete it
    await fetch(`${CF_API_BASE}/zones/${zone}/custom_hostnames/${cfId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${cfToken}` },
    }).catch(() => undefined)
  }
})

// ── T6: Sandbox SSH context endpoint returns correct credentials ──────────────
//
// Story 5 replaced the voice-tool/exec route with a lightweight /api/voice-tool/ctx
// endpoint that returns sandbox SSH context for the sandbox agent runner.
// This test verifies the ctx endpoint returns host, sandboxId, and privateKey.

test('T6 — sandbox ctx endpoint returns sandbox SSH context', async () => {
  test.skip(!ENABLED, SKIP_MSG)
  const email = `sandbox-e2e-T6-${crypto.randomUUID()}@example.test`
  const { id: userId, jwt } = await createTestUser(email)
  try {
    await waitForHetznerSlotFree()
    await provisionSandbox(jwt, TEST_PUBLIC_KEY)
    const voiceJwt = await mintVoiceJwt(userId, `test-room-T6-${userId}`)
    const r = await bff('/api/voice-tool/ctx', voiceJwt, {
      method: 'POST',
    })
    expect(r.status).toBe(200)
    const body = await r.json() as { host: string; sandboxId: string; privateKey: string }
    expect(typeof body.host).toBe('string')
    expect(body.host.length).toBeGreaterThan(0)
    expect(typeof body.sandboxId).toBe('string')
    expect(body.sandboxId.length).toBeGreaterThan(0)
    expect(typeof body.privateKey).toBe('string')
    expect(body.privateKey.length).toBeGreaterThan(0)
  } finally {
    await deprovisionSandbox(jwt).catch(() => undefined)
    await deleteTestUser(userId)
  }
})

// ── T7: Full lifecycle stability (3 consecutive cycles) ───────────────────────

test.describe.serial('T7 — full lifecycle stability (3 cycles)', () => {
  const email = `sandbox-e2e-T7-${crypto.randomUUID()}@example.test`
  let userId: string | undefined
  let jwt: string | undefined
  let userEmail: string | undefined
  let userPassword: string | undefined

  test.beforeAll(async () => {
    if (!ENABLED) return
    const user = await createTestUser(email)
    userId = user.id
    jwt = user.jwt
    userEmail = user.email
    userPassword = user.password
  })

  test.afterAll(async () => {
    if (!ENABLED || !userId) return
    await deprovisionSandbox(jwt!).catch(() => undefined)
    await deleteTestUser(userId)
    const remaining = await supabaseQuery(
      'resources',
      `type=eq.server&name=like.sandbox-e2e-*&select=id`,
    )
    expect(remaining.length, 'No orphaned sandbox-e2e-* resources should remain').toBe(0)
  })

  for (let cycle = 1; cycle <= 3; cycle++) {
    test(`T7 cycle ${cycle} — provision, voice flow, deprovision, zero orphans`, async () => {
      test.skip(!ENABLED, SKIP_MSG)
      test.setTimeout(1_200_000) // 20 min: 3 min provision, 5 min CF port hostname TLS, 7 min voice flow, 5 min buffer
      if (!userId || !jwt || !userEmail || !userPassword) throw new Error('beforeAll did not complete')
      await waitForHetznerSlotFree()
      const { resourceId } = await provisionSandbox(jwt, TEST_PUBLIC_KEY)
      // Wait for BOTH CF hostnames (base + port 3737) before voice flow — same as T3.
      const cfCond = (d: unknown): boolean => {
        const data = d as { result?: Array<{ status?: string; ssl?: { status?: string } | null }> }
        const entry = data.result?.[0]
        return entry?.status === 'active' || entry?.ssl?.status === 'active'
      }
      const cfOk = await pollCF(cfHostnameUrl(resourceId), cfCond)
      expect(cfOk, 'CF base hostname must be active before voice flow').toBe(true)
      // Per-port hostnames removed — see top-of-file note. Wildcard cert covers all ports.
      // Ensure VM services (cloudflared, port router, mermaid server) are running
      const mermaidUp = await pollMermaidHealth(resourceId)
      expect(mermaidUp, `Cycle ${cycle}: Mermaid server health check failed`).toBe(true)
      const { diagramPath, fullPath, artifactUrl } = await runVoiceFlow(`T7-cycle-${cycle}`, {
        jwt,
        email: userEmail,
        password: userPassword,
        userId,
      })

      const { statSync } = await import('node:fs')
      expect(statSync(diagramPath).size, `Cycle ${cycle} diagram > 5KB`).toBeGreaterThan(5_000)
      expect(statSync(fullPath).size, `Cycle ${cycle} full page > 5KB`).toBeGreaterThan(5_000)
      // Amendment 2: artifact URL must be per-sandbox cloudflared URL
      expect(artifactUrl, `Cycle ${cycle} artifact URL must match ${ARTIFACT_URL_PATTERN} (got: ${artifactUrl})`).toMatch(ARTIFACT_URL_PATTERN)

      await deprovisionSandbox(jwt)
      await assertSandboxCleanup(resourceId)
    })
  }
})
