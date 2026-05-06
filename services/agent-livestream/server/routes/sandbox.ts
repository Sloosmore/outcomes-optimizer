import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { Hono } from 'hono'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { JWTPayload } from 'jose'
import { ProvisionRequest, ReadyRequest, RepoCloneRequest } from '@skill-networks/contracts/sandbox'
import { provisionSecretMiddleware } from '../middleware/provision-secret.js'
import { executeAction, type ProvisionSandboxResult } from '@skill-networks/database/actions'
import type { SandboxProvider, ProvisionResult } from '@duoidal/sandbox'
import { GitHubAppAdapter } from '@duoidal/sandbox'
import { getServices } from '../lib/services.js'
import { getUserCredential } from '../lib/get-credential.js'
import type { CloudflareSaasAdapter } from '../lib/cloudflare-saas.js'
import { HttpCloudflareSaasAdapter } from '../lib/cloudflare-saas.js'
import type { CloudflareDnsAdapter } from '../lib/cloudflare-dns.js'
import { HttpCloudflareDnsAdapter } from '../lib/cloudflare-dns.js'
import type { CloudflareTunnelAdapter } from '../lib/cloudflare-tunnel.js'
import { HttpCloudflareTunnelAdapter } from '../lib/cloudflare-tunnel.js'
import type { SshExecutor, SshExecResult } from '../lib/ssh-exec.js'
import { HttpSshExecutor } from '../lib/ssh-exec.js'
import { createLogger } from '@skill-networks/logger'
import { VOICE_AGENT, isCodexAuthError } from '../constants.js'
import { resolveSshPrivateKey } from '../lib/resolve-ssh-key.js'

const logger = createLogger('agent-livestream:sandbox')

/**
 * Parse account ID and tunnel ID from CLOUDFLARE_TUNNEL_TOKEN JWT.
 * The tunnel token payload contains "a" (account ID) and "t" (tunnel ID).
 * This avoids requiring separate CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_TUNNEL_ID env vars.
 */
function parseTunnelToken(token: string): { accountId: string; tunnelId: string } | null {
  try {
    const payload = token.split('.')[1]
    if (!payload) return null
    const decoded = Buffer.from(payload, 'base64url').toString('utf-8')
    const data = JSON.parse(decoded) as { a?: string; t?: string }
    if (!data.a || !data.t) return null
    return { accountId: data.a, tunnelId: data.t }
  } catch {
    return null
  }
}

/**
 * Resolve CF tunnel account ID and tunnel ID.
 * Prefers explicit env vars; falls back to parsing CLOUDFLARE_TUNNEL_TOKEN JWT.
 */
function resolveCfTunnelIds(): { accountId: string; tunnelId: string } | null {
  const accountId = process.env['CLOUDFLARE_ACCOUNT_ID']
  const tunnelId = process.env['CLOUDFLARE_TUNNEL_ID']
  if (accountId && tunnelId) return { accountId, tunnelId }
  const tunnelToken = process.env['CLOUDFLARE_TUNNEL_TOKEN']
  if (tunnelToken) return parseTunnelToken(tunnelToken)
  return null
}

const __dirname = dirname(fileURLToPath(import.meta.url))
let bootstrapScriptB64 = ''
let bootstrapScriptBytes = 0
try {
  const bootstrapBuf = readFileSync(resolve(__dirname, '../bootstrap.sh'))
  bootstrapScriptBytes = bootstrapBuf.byteLength
  bootstrapScriptB64 = bootstrapBuf.toString('base64')
  logger.info(`bootstrap.sh loaded, ${bootstrapScriptBytes} bytes`)
} catch {
  logger.warn('bootstrap.sh not found, provisioning will run without bootstrap script')
}

type Env = {
  Variables: {
    jwtPayload: JWTPayload
  }
}

export function createReadyRouter(deps: {
  db: SupabaseClient
  cfTunnel?: CloudflareTunnelAdapter
}): Hono {
  const cfTunnel = deps.cfTunnel ?? new HttpCloudflareTunnelAdapter()
  const router = new Hono()

  router.get('/bootstrap-check', provisionSecretMiddleware, (c) => {
    if (bootstrapScriptBytes > 0) {
      return c.json({ loaded: true, bytes: bootstrapScriptBytes })
    }
    return c.json({ loaded: false })
  })

  router.post('/ready', provisionSecretMiddleware, async (c) => {
    const body = await c.req.json()
    const parsed = ReadyRequest.safeParse(body)
    if (!parsed.success) return c.json({ error: 'Invalid request' }, 400)
    const { resourceId, ip, hetznerServerId } = parsed.data

    try {
      await executeAction(
        'update_sandbox_status',
        {
          serverResourceId: resourceId,
          status: 'active',
          ip,
          hetznerServerId,
          provisionedAt: new Date().toISOString(),
        },
        deps.db
      )
    } catch (err) {
      // Idempotent: if already updated, still return success
      const message = err instanceof Error ? err.message : String(err)
      // If not a "not found" type error, propagate
      if (!message.includes('no rows')) {
        return c.json({ error: message }, 500)
      }
    }

    // Add per-VM tunnel ingress rule so *.{serverId}.example.com routes to the VM's port router.
    // Prefer explicit CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_TUNNEL_ID; fall back to parsing them
    // from CLOUDFLARE_TUNNEL_TOKEN JWT (payload claims "a" = account, "t" = tunnel).
    const cfTunnelIds = resolveCfTunnelIds()
    const cfToken = process.env['CLOUDFLARE_API_TOKEN']
    if (cfTunnelIds && cfToken) {
      const hostname = `*.${resourceId}.example.com`
      const service = `http://${ip}:8080`
      try {
        await cfTunnel.addIngressRule(cfTunnelIds.accountId, cfTunnelIds.tunnelId, hostname, service, cfToken)
        logger.info('CF tunnel ingress rule added on /ready', { resourceId, ip, accountId: cfTunnelIds.accountId, tunnelId: cfTunnelIds.tunnelId })
      } catch (err) {
        // Non-fatal: log error but don't fail the ready callback
        logger.error('Failed to add CF tunnel ingress rule on /ready (non-fatal)', {
          resourceId,
          ip,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    } else {
      logger.warn('CF tunnel IDs not available — skipping ingress rule on /ready', {
        hasToken: !!cfToken,
        hasTunnelIds: !!cfTunnelIds,
      })
    }

    return c.json({ success: true })
  })

  return router
}

// Extract the auth user ID (sub claim) from a JWT payload.
// Supabase always sets sub to the auth UUID — tokens without sub are non-standard
// and cannot be used for auth_user_id lookups.
function getAuthUserId(payload: JWTPayload): string {
  if (payload.sub) return payload.sub
  throw new Error('JWT payload has no sub claim')
}

async function findUserSandbox(authUserId: string) {
  const { resources } = getServices()

  // Look up by auth_user_id column — provision_user creates resources with email-local-part
  // names (e.g. user:alice) but the JWT sub is always the auth UUID. Using auth_user_id avoids
  // the naming mismatch.
  const userResourceRef = await resources.findByExternalId('user', authUserId)
  if (!userResourceRef) return { error: 'User not found', status: 404 as const }
  const userResource = await resources.getById(userResourceRef.id)
  if (!userResource) {
    // Ref exists but row is missing — data-consistency anomaly (race with deprovisioning or replication lag)
    logger.warn('User resource ref found but row missing', { authUserId, refId: userResourceRef.id })
    return { error: 'User not found', status: 404 as const }
  }

  const links = await resources.listLinksToId({ toId: userResource.id, linkType: 'parent' })
  if (!links || links.length === 0) return { error: 'No sandbox found', status: 404 as const }

  const serverIds = links.map((l: { from_id: string }) => l.from_id)
  const serverResources = await resources.findByTypeAndIds('server', serverIds)
  const serverResource = serverResources[0] ?? null

  if (!serverResource) return { error: 'No sandbox found', status: 404 as const }

  return { userResource, serverResource }
}

export function createSandboxRouter(deps: {
  db: SupabaseClient
  provider: SandboxProvider
  cfSaas?: CloudflareSaasAdapter
  cfDns?: CloudflareDnsAdapter
  cfTunnel?: CloudflareTunnelAdapter
  sshExecutor?: SshExecutor
  fetch?: typeof globalThis.fetch
}): Hono {
  const cfAdapter = deps.cfSaas ?? new HttpCloudflareSaasAdapter()
  const cfDnsAdapter = deps.cfDns ?? new HttpCloudflareDnsAdapter()
  const cfTunnelAdapter = deps.cfTunnel ?? new HttpCloudflareTunnelAdapter()
  const sshExecutor = deps.sshExecutor ?? new HttpSshExecutor()
  // Injectable fetch for CLIProxyAPI calls — allows test overrides without global mocking
  const fetchFn = deps.fetch ?? globalThis.fetch
  const router = new Hono<Env>()

  // POST /provision
  router.post('/provision', async (c) => {
    const payload = c.get('jwtPayload') as JWTPayload
    let authUserId: string
    try { authUserId = getAuthUserId(payload) } catch { return c.json({ error: 'Invalid token' }, 401) }

    const { resources } = getServices()

    // Look up by auth_user_id — provision_user names resources user:<email-local-part>
    // but the JWT sub is always the auth UUID. Using auth_user_id avoids the naming mismatch.
    const userResourceRef = await resources.findByExternalId('user', authUserId)
    if (!userResourceRef) return c.json({ error: 'User not approved' }, 403)
    const userResource = await resources.getById(userResourceRef.id)

    if (!userResource) return c.json({ error: 'User not approved' }, 403)

    const config = userResource.config as Record<string, unknown> | null
    if (!config || config['status'] !== 'approved') {
      return c.json({ error: 'User not approved' }, 403)
    }

    // Check sandbox limit — count only server resources to avoid counting other
    // parent-linked resources (e.g. credential resources) against the limit
    const maxSandboxes = (config['maxSandboxes'] as number | undefined) ?? 1
    const existingCount = await resources.countLinkedByType({ toId: userResource.id, linkType: 'parent', fromType: 'server' })
    if (existingCount >= maxSandboxes) {
      return c.json({ error: 'Sandbox limit reached' }, 409)
    }

    // Parse body first
    const body = await c.req.json()
    const parsed = ProvisionRequest.safeParse(body)
    if (!parsed.success) return c.json({ error: 'Invalid request' }, 400)
    const { publicKey } = parsed.data

    // Use deterministic, user-specific server name based on authUserId
    const serverName = `sandbox-${authUserId}`
    const sshKeyName = `sshkey-${authUserId}`

    // Create DB record FIRST (before calling Hetzner) - atomic idempotency via ON CONFLICT
    let provisionResult: ProvisionSandboxResult
    try {
      provisionResult = await executeAction(
        'provision_sandbox',
        {
          userResourceId: userResource.id,
          serverName,
          sshKeyName,
          publicKey,
          // Required for the RPC's ownership check — auth.uid() is NULL when
          // the BFF calls via service-role, so the caller's identity must be
          // passed explicitly. The JWT was already validated by the JWT
          // middleware; `authUserId` here is the verified `sub` claim.
          authUid: authUserId,
        },
        deps.db
      )
    } catch (err) {
      logger.error('provision_sandbox action failed', { error: err instanceof Error ? err.message : String(err) })
      return c.json({ error: 'Internal server error' }, 500)
    }

    // If not new (ON CONFLICT) → another request already claimed this slot, return early
    if (!provisionResult.isNew) {
      return c.json({ status: 'provisioning', resourceId: provisionResult.serverResourceId })
    }

    // We're the winner — create CF custom hostname BEFORE calling the provider.
    // This ensures the DNS entry exists before the VM boots.
    // CF zone ID is required for hostname creation. Read from env (set by infra).
    // Declared outside the cfZoneId block so they survive the try-catch scope and can be
    // persisted via the service-role resources.updateConfig() call below, even when the
    // update_server_config RPC fails due to the email-local-part vs UUID naming mismatch.
    let capturedCfHostnameId: string | undefined
    let capturedCfDnsCnameId: string | undefined
    const cfZoneId = process.env['CLOUDFLARE_ZONE_ID']
    const cfTunnelId = process.env['CLOUDFLARE_TUNNEL_ID']
    if (cfZoneId) {
      try {
        // Prefer env var (server-side provisioning runs as service role, not a user JWT,
        // so auth.uid()-based vault lookup returns empty). Fall back to vault lookup only
        // when the env var is absent (e.g. local dev without the var set).
        const cfToken = process.env['CLOUDFLARE_API_TOKEN'] ?? await getUserCredential(deps.db, 'CLOUDFLARE_API_TOKEN')
        const cfHostname = await cfAdapter.createCustomHostname(
          provisionResult.serverResourceId,
          cfZoneId,
          cfToken,
        )
        capturedCfHostnameId = cfHostname.id

        // Add wildcard DNS CNAME *.{serverId}.example.com → tunnel (for traffic routing)
        // This routes all port-based subdomains through the shared cloudflared tunnel
        const tunnelId = cfTunnelId ?? ''
        let cfDnsCnameId: string | undefined
        if (tunnelId) {
          try {
            const cname = await cfDnsAdapter.createCnameRecord(
              cfZoneId,
              `*.${provisionResult.serverResourceId}.example.com`,
              `${tunnelId}.cfargotunnel.com`,
              true, // proxied
              cfToken,
            )
            cfDnsCnameId = cname.id
            capturedCfDnsCnameId = cname.id
          } catch (err) {
            logger.error('CF DNS wildcard CNAME creation failed (non-fatal)', {
              error: err instanceof Error ? err.message : String(err),
              resourceId: provisionResult.serverResourceId,
            })
          }
        }

        // Per-port custom hostnames are no longer created at provision time.
        // The new artifact-router on openclaw routes `artifact-{sandboxId}-{port}.example.com`
        // via the existing `*.example.com` proxied wildcard, so each sandbox gets HTTPS for
        // every port for free with no per-port DNS or DV-cert work. Deprovision still cleans
        // up legacy `cfPortHostnameId`/`cfDcvCnameId` from older sandbox rows.

        // Persist CF IDs into the server config for later deprovision.
        // p_auth_uid is required for the RPC's parent-link ownership check
        // (auth.uid() is NULL when called via service-role).
        await deps.db.rpc('update_server_config', {
          p_server_resource_id: provisionResult.serverResourceId,
          p_auth_uid: authUserId,
          p_config_patch: {
            cloudflareCustomHostnameId: cfHostname.id,
            ...(cfDnsCnameId ? { cfDnsCnameId } : {}),
          },
        })
        logger.info('CF custom hostname created and stored', {
          resourceId: provisionResult.serverResourceId,
          hostnameId: cfHostname.id,
        })
      } catch (err) {
        // Non-fatal: log the error but continue provisioning.
        // The reconciliation sweep will clean up orphans if needed.
        logger.error('CF createCustomHostname failed (non-fatal)', {
          error: err instanceof Error ? err.message : String(err),
          resourceId: provisionResult.serverResourceId,
        })
      }
    } else {
      logger.warn('CLOUDFLARE_ZONE_ID not set — skipping CF custom hostname creation')
    }

    // We're the winner — call provider
    const dopplerToken = process.env['DOPPLER_TOKEN']
    const provisionSecret = process.env['PROVISION_SECRET']
    const agentLivestreamUrl = process.env['AGENT_LIVESTREAM_URL']
    if (!dopplerToken || !provisionSecret || !agentLivestreamUrl) {
      return c.json({ error: 'Server misconfigured: missing provisioning secrets' }, 500)
    }

    let hetznerResult: ProvisionResult
    try {
      hetznerResult = await deps.provider.provision({
        resourceId: provisionResult.serverResourceId,
        serverName,
        publicKey,
        sshKeyName,
        dopplerToken,
        provisionSecret,
        agentLivestreamUrl,
        bootstrapScript: bootstrapScriptB64,
      })
    } catch (err) {
      logger.error('provider.provision failed', { error: err instanceof Error ? err.message : String(err) })
      return c.json({ error: 'Internal server error' }, 500)
    }

    // Add per-VM CF tunnel ingress rule eagerly at provision time using the IP
    // returned by the Hetzner server creation response. This is more reliable than
    // doing it in the /ready callback (which runs inside a short-lived Vercel function
    // that may timeout before the CF API call completes, and has no retry mechanism).
    // The /ready callback also attempts this as a backstop, but provision-time is the
    // primary path.
    if (hetznerResult.ip) {
      const cfProvisionTunnelIds = resolveCfTunnelIds()
      const cfProvisionToken = process.env['CLOUDFLARE_API_TOKEN']
      if (cfProvisionTunnelIds && cfProvisionToken) {
        const ingressHostname = `*.${provisionResult.serverResourceId}.example.com`
        const ingressService = `http://${hetznerResult.ip}:8080`
        try {
          await cfTunnelAdapter.addIngressRule(
            cfProvisionTunnelIds.accountId,
            cfProvisionTunnelIds.tunnelId,
            ingressHostname,
            ingressService,
            cfProvisionToken,
          )
          logger.info('CF tunnel ingress rule added at provision time', {
            resourceId: provisionResult.serverResourceId,
            ip: hetznerResult.ip,
            accountId: cfProvisionTunnelIds.accountId,
            tunnelId: cfProvisionTunnelIds.tunnelId,
          })
        } catch (err) {
          // Non-fatal: /ready callback will retry; log so we can see if this is a
          // persistent failure (e.g. missing Account:Cloudflare Tunnel:Edit permission).
          logger.error('CF tunnel ingress rule failed at provision time (non-fatal, /ready will retry)', {
            resourceId: provisionResult.serverResourceId,
            ip: hetznerResult.ip,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      } else {
        logger.warn('CF tunnel IDs or token not available at provision time — skipping ingress rule (will retry at /ready)', {
          hasToken: !!cfProvisionToken,
          hasTunnelIds: !!cfProvisionTunnelIds,
        })
      }
    }

    // Persist hetznerServerId (and any CF IDs captured above) so deprovision can find and
    // delete the VM and clean up CF hostnames. The capturedCf* variables are set above even
    // when the update_server_config RPC fails (due to ownership check name mismatch between
    // email-local-part resource names and UUID-based auth IDs). This service-role call via
    // resources.updateConfig() bypasses the RPC ownership check and is the authoritative write.
    try {
      const serverResource = await resources.getById(provisionResult.serverResourceId)
      const existingConfig = (serverResource?.config as Record<string, unknown> | null) ?? {}
      await resources.updateConfig(provisionResult.serverResourceId, {
        ...existingConfig,
        hetznerServerId: hetznerResult.hetznerServerId,
        status: 'provisioning',
        ...(capturedCfHostnameId ? { cloudflareCustomHostnameId: capturedCfHostnameId } : {}),
        ...(capturedCfDnsCnameId ? { cfDnsCnameId: capturedCfDnsCnameId } : {}),
      })
    } catch (err) {
      // Non-fatal: log and continue — the /ready callback will also set hetznerServerId
      logger.error('Failed to persist hetznerServerId to DB', { error: err instanceof Error ? err.message : String(err) })
    }

    return c.json({ status: 'provisioning', resourceId: provisionResult.serverResourceId })
  })

  // GET /status
  router.get('/status', async (c) => {
    const payload = c.get('jwtPayload') as JWTPayload
    let authUserId: string
    try { authUserId = getAuthUserId(payload) } catch { return c.json({ error: 'Invalid token' }, 401) }
    const result = await findUserSandbox(authUserId)
    if ('error' in result) return c.json({ error: result.error }, result.status)

    const serverConfig = result.serverResource.config as Record<string, unknown> | null
    return c.json({
      status: (serverConfig?.['status'] as string) ?? 'unknown',
      ip: serverConfig?.['ip'] as string | undefined,
      resourceId: result.serverResource.id,
      hetznerServerId: serverConfig?.['hetznerServerId'] as string | undefined,
    })
  })

  // DELETE /deprovision
  router.delete('/deprovision', async (c) => {
    const payload = c.get('jwtPayload') as JWTPayload
    let authUserId: string
    try { authUserId = getAuthUserId(payload) } catch { return c.json({ error: 'Invalid token' }, 401) }
    const result = await findUserSandbox(authUserId)
    if ('error' in result) {
      // No sandbox found = already deprovisioned = idempotent success (criterion #8)
      if (result.status === 404) return c.json({ deleted: true, alreadyGone: true })
      return c.json({ error: result.error }, result.status)
    }

    const serverConfig = result.serverResource.config as Record<string, unknown> | null
    let hetznerServerId = serverConfig?.['hetznerServerId'] as string | undefined

    // Delete CF custom hostname + DNS records + port hostname + tunnel ingress (all non-fatal)
    const cfZoneId = process.env['CLOUDFLARE_ZONE_ID']
    const cfDeprovisionTunnelIds = resolveCfTunnelIds()
    const cfHostnameId = serverConfig?.['cloudflareCustomHostnameId'] as string | undefined
    const cfDnsCnameId = serverConfig?.['cfDnsCnameId'] as string | undefined
    const cfPortHostnameId = serverConfig?.['cfPortHostnameId'] as string | undefined
    const cfDcvCnameId = serverConfig?.['cfDcvCnameId'] as string | undefined
    if (cfZoneId) {
      const cfToken = process.env['CLOUDFLARE_API_TOKEN'] ?? await getUserCredential(deps.db, 'CLOUDFLARE_API_TOKEN').catch(() => '')
      if (!cfToken) {
        logger.warn('CLOUDFLARE_API_TOKEN not available for CF cleanup during deprovision')
      } else {
        // Remove tunnel ingress rule for this sandbox
        if (cfDeprovisionTunnelIds) {
          const ingressHostname = `*.${result.serverResource.id}.example.com`
          try {
            await cfTunnelAdapter.removeIngressRule(cfDeprovisionTunnelIds.accountId, cfDeprovisionTunnelIds.tunnelId, ingressHostname, cfToken)
            logger.info('CF tunnel ingress rule removed during deprovision', { ingressHostname })
          } catch (err) {
            logger.error('CF removeIngressRule failed during deprovision (non-fatal)', {
              error: err instanceof Error ? err.message : String(err), ingressHostname,
            })
          }
        }
        // Delete per-port custom hostname (3737.{serverId}.example.com)
        if (cfPortHostnameId) {
          try {
            await cfAdapter.deleteCustomHostname(cfPortHostnameId, cfZoneId, cfToken)
            logger.info('CF port custom hostname deleted during deprovision', { cfPortHostnameId })
          } catch (err) {
            logger.error('CF deletePortCustomHostname failed (non-fatal)', {
              error: err instanceof Error ? err.message : String(err), cfPortHostnameId,
            })
          }
        }
        // Delete DCV delegation CNAME
        if (cfDcvCnameId) {
          try {
            await cfDnsAdapter.deleteDnsRecord(cfZoneId, cfDcvCnameId, cfToken)
            logger.info('CF DCV CNAME deleted during deprovision', { cfDcvCnameId })
          } catch (err) {
            logger.error('CF deleteDcvCname failed (non-fatal)', {
              error: err instanceof Error ? err.message : String(err), cfDcvCnameId,
            })
          }
        }
        // Delete wildcard DNS CNAME for *.{serverId}.example.com
        if (cfDnsCnameId) {
          try {
            await cfDnsAdapter.deleteDnsRecord(cfZoneId, cfDnsCnameId, cfToken)
            logger.info('CF DNS wildcard CNAME deleted during deprovision', { cfDnsCnameId })
          } catch (err) {
            logger.error('CF deleteDnsCname failed (non-fatal)', {
              error: err instanceof Error ? err.message : String(err), cfDnsCnameId,
            })
          }
        }
        // Delete base custom hostname for {serverId}.example.com
        if (cfHostnameId) {
          try {
            await cfAdapter.deleteCustomHostname(cfHostnameId, cfZoneId, cfToken)
            logger.info('CF custom hostname deleted during deprovision', { cfHostnameId })
          } catch (err) {
            logger.error('CF deleteCustomHostname failed during deprovision (non-fatal)', {
              error: err instanceof Error ? err.message : String(err), cfHostnameId,
            })
          }
        }
      }
    }

    // Fallback: if hetznerServerId is missing from DB config, look it up by server name
    if (!hetznerServerId) {
      const serverName = `sandbox-${authUserId}`
      try {
        const resolvedId = await deps.provider.findServerIdByName(serverName)
        if (resolvedId) {
          hetznerServerId = resolvedId
          logger.info('Resolved hetznerServerId via fallback name lookup', { serverName, hetznerServerId })
        } else {
          logger.warn('No Hetzner server found by name, skipping provider deprovision', { serverName })
        }
      } catch (err) {
        logger.error('findServerIdByName failed during deprovision fallback', { error: err instanceof Error ? err.message : String(err) })
      }
    }

    // Delete from provider (if Hetzner server exists)
    // Pass sshKeyName so the provider also deletes the SSH key, preventing stale
    // key accumulation that breaks re-provisioning for the same user.
    const sshKeyName = `sshkey-${authUserId}`
    if (hetznerServerId) {
      try {
        await deps.provider.deprovision(hetznerServerId, sshKeyName)
      } catch (err) {
        logger.error('provider.deprovision failed', { error: err instanceof Error ? err.message : String(err) })
        return c.json({ error: 'Internal server error' }, 500)
      }
    }

    // Clean up DB records
    try {
      await executeAction(
        'deprovision_sandbox',
        { serverResourceId: result.serverResource.id },
        deps.db
      )
    } catch (err) {
      logger.error('deprovision_sandbox DB cleanup failed after provider deprovision', { error: err instanceof Error ? err.message : String(err) })
      return c.json({ error: 'Server deleted but DB cleanup failed' }, 500)
    }

    return c.json({ deleted: true })
  })

  // GET /ssh-access
  //
  // Returns the sandbox IP and the local key path the CLI should use for SSH.
  // Ownership is enforced by `findUserSandbox` (parent link from server → user).
  //
  // Historically this route also gated on a server→credential `resource_links`
  // row. That gate was a remnant of the old provision flow and turned a
  // metadata lookup into a 403 for any sandbox whose credential link was never
  // backfilled (e.g. sandboxes provisioned by older code paths or by tooling
  // that bypasses `provision_sandbox`). Whether SSH actually succeeds depends
  // on the user holding the matching private key locally — that check belongs
  // in the CLI, not the BFF. Auth is already enforced above.
  router.get('/ssh-access', async (c) => {
    const payload = c.get('jwtPayload') as JWTPayload
    let authUserId: string
    try { authUserId = getAuthUserId(payload) } catch { return c.json({ error: 'Invalid token' }, 401) }
    const result = await findUserSandbox(authUserId)
    if ('error' in result) return c.json({ error: result.error }, result.status)

    const serverConfig = result.serverResource.config as Record<string, unknown> | null
    const ip = serverConfig?.['ip'] as string | undefined

    return c.json({
      allowed: true as const,
      ip: ip ?? '',
      keyPath: `~/.config/duoidal/sandboxes/${result.serverResource.id}/id_ed25519`,
    })
  })

  // POST /repo-clone — Mint a short-lived GitHub clone URL (server-side secrets)
  router.post('/repo-clone', async (c) => {
    const payload = c.get('jwtPayload') as JWTPayload
    let authUserId: string
    try { authUserId = getAuthUserId(payload) } catch { return c.json({ error: 'Invalid token' }, 401) }

    const body = await c.req.json()
    const parsed = RepoCloneRequest.safeParse(body)
    if (!parsed.success) return c.json({ error: 'Invalid request body' }, 400)
    const { repo } = parsed.data

    const { resources } = getServices()

    // Find user resource
    const userResourceRef = await resources.findByExternalId('user', authUserId)
    if (!userResourceRef) return c.json({ error: 'User not found' }, 404)
    const userResource = await resources.getById(userResourceRef.id)
    if (!userResource) return c.json({ error: 'User not found' }, 404)

    // Check repo is registered
    const userConfig = (userResource.config as Record<string, unknown> | null) ?? {}
    const repos = (userConfig['repos'] ?? []) as Array<{ owner: string; name: string }>
    const repoEntry = repos.find(r => r.name === repo)
    if (!repoEntry) {
      return c.json({ error: `Repo '${repo}' not registered. Run: duodal repo add <owner>/${repo}` }, 400)
    }

    // Check GitHub App link
    const githubLink = await resources.findLinkByFromAndType(userResourceRef.id, 'github_app')
    if (!githubLink) {
      return c.json({ error: 'GitHub not connected. Run: duodal github connect' }, 403)
    }

    // Read installation_id from credential resource
    const credentialResource = await resources.getById(githubLink.to_id)
    const credConfig = (credentialResource?.config as Record<string, unknown> | null) ?? {}
    const installationId = credConfig['installation_id'] as string | undefined
    if (!installationId) {
      return c.json({ error: 'GitHub installation not found. Reconnect GitHub.' }, 403)
    }

    // Mint clone URL using server-side secrets
    const appId = process.env['GITHUB_APP_ID'] ?? ''
    const privateKey = process.env['GITHUB_APP_PRIVATE_KEY'] ?? ''
    if (!appId || !privateKey) {
      logger.error('GITHUB_APP_ID or GITHUB_APP_PRIVATE_KEY not configured in BFF env')
      return c.json({ error: 'Server misconfigured: missing GitHub App credentials' }, 500)
    }

    try {
      const adapter = new GitHubAppAdapter({ appId, privateKey, installationId })
      const cloneUrl = await adapter.getCloneUrl(repoEntry)
      return c.json({ cloneUrl })
    } catch (err) {
      logger.error('Failed to mint clone URL', { error: err instanceof Error ? err.message : String(err) })
      return c.json({ error: 'Failed to generate clone URL' }, 500)
    }
  })

  // POST /exec — Run a command on the user's default sandbox via SSH
  router.post('/exec', async (c) => {
    const payload = c.get('jwtPayload') as JWTPayload
    let authUserId: string
    try { authUserId = getAuthUserId(payload) } catch { return c.json({ error: 'Invalid token' }, 401) }

    const body = await c.req.json().catch(() => null)
    if (!body || typeof body !== 'object' || typeof body['command'] !== 'string') {
      return c.json({ error: 'Invalid request: command is required' }, 400)
    }
    const { command } = body as { command: string }
    if (command.length > 4096) {
      return c.json({ error: 'Command too long' }, 400)
    }

    const result = await findUserSandbox(authUserId)
    if ('error' in result) return c.json({ error: result.error }, result.status)

    const { serverResource } = result
    const serverConfig = serverResource.config as Record<string, unknown> | null
    const ip = serverConfig?.['ip'] as string | undefined
    if (!ip) return c.json({ error: 'Sandbox IP not available — server may still be provisioning' }, 503)

    // Fetch SSH private key — tries vault first, falls back to E2E test key env var.
    const privateKey = await resolveSshPrivateKey(deps.db, serverResource.id, authUserId)
    if (!privateKey) {
      return c.json({ error: 'SSH credentials not configured' }, 503)
    }

    // Execute command — key stays in memory, never touches the filesystem
    try {
      const execResult = await sshExecutor.exec({ host: ip, privateKey, command, timeoutMs: 30_000 })
      return c.json({ stdout: execResult.stdout, stderr: execResult.stderr, exitCode: execResult.exitCode })
    } catch (err) {
      logger.error('SSH exec failed', { error: err instanceof Error ? err.message : String(err) })
      return c.json({ error: 'SSH exec failed' }, 500)
    }
  })

  // POST /voice-tool/exec — Run a command on the user's sandbox with Claude Haiku fallback
  // Falls back to Claude Haiku when Codex returns a 401/auth error (e.g. session invalidated).
  // This endpoint is behind the Supabase JWT wall — always use sub for identity.
  router.post('/voice-tool/exec', async (c) => {
    const payload = c.get('jwtPayload') as JWTPayload
    const authUserId = payload.sub
    if (!authUserId) return c.json({ error: 'Invalid token: missing sub' }, 401)

    const body = await c.req.json().catch(() => null)
    if (!body || typeof body !== 'object' || typeof body['command'] !== 'string') {
      return c.json({ error: 'Invalid request: command is required' }, 400)
    }
    const { command } = body as { command: string; promptId?: string }
    if (command.length > 4096) {
      return c.json({ error: 'Command too long' }, 400)
    }

    const sandboxResult = await findUserSandbox(authUserId)
    if ('error' in sandboxResult) return c.json({ error: sandboxResult.error }, sandboxResult.status)

    const { serverResource } = sandboxResult
    const serverConfig = serverResource.config as Record<string, unknown> | null
    const ip = serverConfig?.['ip'] as string | undefined
    if (!ip) return c.json({ error: 'Sandbox IP not available — server may still be provisioning' }, 503)

    // Fetch SSH private key — tries vault first, falls back to E2E test key env var.
    const privateKey = await resolveSshPrivateKey(deps.db, sandboxResult.serverResource.id, authUserId)
    if (!privateKey) {
      return c.json({ error: 'SSH credentials not configured' }, 503)
    }

    let execResult: SshExecResult
    try {
      execResult = await sshExecutor.exec({ host: ip, privateKey, command, timeoutMs: 30_000 })
    } catch (err) {
      logger.error('SSH exec failed for voice-tool/exec', { error: err instanceof Error ? err.message : String(err) })
      return c.json({ error: 'SSH exec failed' }, 500)
    }

    // Check for Codex auth errors — fall back to Claude Haiku if detected
    if (execResult.exitCode !== 0 && isCodexAuthError(execResult.stdout, execResult.stderr)) {
      logger.info('Codex auth error detected, falling back to Claude Haiku', { exitCode: execResult.exitCode })
      const cliproxyApiUrl = VOICE_AGENT.LLM_BASE_URL
      const apiKey = process.env['ANTHROPIC_API_KEY']
      const fallbackHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
      }
      if (apiKey) fallbackHeaders['x-api-key'] = apiKey
      try {
        const fallbackRes = await fetchFn(`${cliproxyApiUrl}/v1/messages`, {
          method: 'POST',
          headers: fallbackHeaders,
          body: JSON.stringify({
            model: VOICE_AGENT.LLM_MODEL,
            max_tokens: 1024,
            messages: [{ role: 'user', content: command }],
          }),
          signal: AbortSignal.timeout(20_000),
        })
        const fallbackData = await fallbackRes.json() as { content: Array<{ type: string; text: string }> }
        const text = fallbackData.content[0]?.text ?? ''
        return c.json({ result: text, model_used: VOICE_AGENT.LLM_MODEL, fallback_reason: 'codex_auth_error' })
      } catch (err) {
        logger.error('Claude Haiku fallback failed', { error: err instanceof Error ? err.message : String(err) })
        return c.json({ error: 'Fallback inference failed' }, 500)
      }
    }

    return c.json({ result: execResult.stdout, model_used: 'gpt-5.3-codex-spark', exitCode: execResult.exitCode })
  })

  return router as unknown as Hono
}
