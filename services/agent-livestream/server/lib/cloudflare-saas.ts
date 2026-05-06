/**
 * Cloudflare for SaaS adapter — custom hostname management for sandbox DNS.
 *
 * Each sandbox gets a wildcard custom hostname `*.{serverId}.example.com` registered
 * in the Cloudflare zone for example.com. This routes all `*.{serverId}.example.com`
 * traffic to the sandbox VM via the CF tunnel. The artifact-router on the VM then
 * parses `artifact-{sandboxId}-{port}.example.com` hostnames (single-label, riding
 * the existing `*.example.com` wildcard) to proxy requests to the correct port.
 *
 * The real implementation calls the Cloudflare API v4 custom_hostnames endpoint.
 * The mock implementation is used in tests to count CF API calls without network I/O.
 *
 * Loose coupling: the adapter receives the zone ID and bearer token as parameters
 * on every call — it does not read from process.env. The caller (BFF route handler)
 * is responsible for resolving credentials from Vault.
 */

import { createLogger } from '@skill-networks/logger'

const logger = createLogger('agent-livestream:cloudflare-saas')

// ── Types ────────────────────────────────────────────────────────────────────

export interface CloudflareCustomHostname {
  id: string
  hostname: string
  status: string
}

export interface CloudflareSaasAdapter {
  createCustomHostname(serverId: string, zoneId: string, token: string): Promise<CloudflareCustomHostname>
  deleteCustomHostname(hostnameId: string, zoneId: string, token: string): Promise<void>
  getCustomHostname(hostnameId: string, zoneId: string, token: string): Promise<CloudflareCustomHostname | null>
  listCustomHostnames(zoneId: string, token: string): Promise<CloudflareCustomHostname[]>
  /** Number of createCustomHostname calls made — used in concurrency tests. */
  readonly callCount: number
}

// ── Real HTTP implementation ─────────────────────────────────────────────────

const CF_API_BASE = 'https://api.cloudflare.com/client/v4'

/**
 * Builds the wildcard hostname for a given serverId.
 * Pattern: {serverId}.example.com (with wildcard: true in the CF API body).
 * The Cloudflare for SaaS API requires the base hostname without the "*." prefix —
 * wildcard coverage is enabled via the `wildcard: true` boolean field.
 * This routes all `*.{serverId}.example.com` traffic to the sandbox VM.
 */
export function buildSandboxHostname(serverId: string): string {
  return `${serverId}.example.com`
}

export class HttpCloudflareSaasAdapter implements CloudflareSaasAdapter {
  private _callCount = 0

  get callCount(): number {
    return this._callCount
  }

  async createCustomHostname(
    serverId: string,
    zoneId: string,
    token: string,
  ): Promise<CloudflareCustomHostname> {
    this._callCount++
    const hostname = buildSandboxHostname(serverId)

    const res = await fetch(`${CF_API_BASE}/zones/${zoneId}/custom_hostnames`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        hostname,
        // wildcard: true enables *.{hostname} coverage (e.g. artifact-{sandboxId}-3737.{serverId}.example.com).
        // The CF API rejects hostnames with a "*." prefix — the wildcard is a separate boolean.
        wildcard: true,
        // No ssl block — use the zone's existing *.example.com wildcard certificate.
        // Per-hostname DV issuance (ssl.type=dv, method=http) requires CF to reach the VM
        // via the ACME challenge URL, which fails because the fallback origin routes through
        // the Argo Tunnel rather than directly to individual VMs. Omitting ssl means CF uses
        // the zone wildcard cert for TLS termination, which activates immediately.
      }),
    })

    type CfResponse = {
      success: boolean
      errors: Array<{ code: number; message: string }>
      result: { id: string; hostname: string; status: string } | null
    }

    const data = await res.json() as CfResponse

    if (!data.success || !data.result) {
      const errMsg = data.errors.map(e => `${e.code}: ${e.message}`).join(', ')
      logger.error('CF createCustomHostname failed', { serverId, zoneId, errors: errMsg })
      throw new Error(`Cloudflare createCustomHostname failed: ${errMsg}`)
    }

    logger.info('CF custom hostname created', { serverId, hostnameId: data.result.id, hostname })
    return {
      id: data.result.id,
      hostname: data.result.hostname,
      status: data.result.status,
    }
  }

  async deleteCustomHostname(
    hostnameId: string,
    zoneId: string,
    token: string,
  ): Promise<void> {
    const res = await fetch(`${CF_API_BASE}/zones/${zoneId}/custom_hostnames/${hostnameId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` },
    })

    // 404 is acceptable — hostname already gone (idempotent)
    if (res.status === 404) {
      logger.info('CF custom hostname already deleted (404)', { hostnameId })
      return
    }

    if (!res.ok) {
      const body = await res.text()
      logger.error('CF deleteCustomHostname failed', { hostnameId, status: res.status, body })
      throw new Error(`Cloudflare deleteCustomHostname failed: HTTP ${res.status}`)
    }

    logger.info('CF custom hostname deleted', { hostnameId })
  }

  async getCustomHostname(
    hostnameId: string,
    zoneId: string,
    token: string,
  ): Promise<CloudflareCustomHostname | null> {
    const res = await fetch(`${CF_API_BASE}/zones/${zoneId}/custom_hostnames/${hostnameId}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    })

    if (res.status === 404) {
      return null
    }

    if (!res.ok) {
      const body = await res.text()
      throw new Error(`Cloudflare getCustomHostname failed: HTTP ${res.status} — ${body}`)
    }

    type CfGetResponse = {
      success: boolean
      result: { id: string; hostname: string; status: string } | null
    }
    const data = await res.json() as CfGetResponse
    if (!data.success || !data.result) return null

    return {
      id: data.result.id,
      hostname: data.result.hostname,
      status: data.result.status,
    }
  }

  async listCustomHostnames(zoneId: string, token: string): Promise<CloudflareCustomHostname[]> {
    const results: CloudflareCustomHostname[] = []
    let page = 1
    const perPage = 50

    for (;;) {
      const res = await fetch(
        `${CF_API_BASE}/zones/${zoneId}/custom_hostnames?per_page=${perPage}&page=${page}`,
        { headers: { 'Authorization': `Bearer ${token}` } },
      )

      if (!res.ok) {
        const body = await res.text()
        throw new Error(`Cloudflare listCustomHostnames failed: HTTP ${res.status} — ${body}`)
      }

      type CfListResponse = {
        success: boolean
        result: Array<{ id: string; hostname: string; status: string }>
        result_info: { total_pages: number; page: number }
      }
      const data = await res.json() as CfListResponse

      if (!data.success) {
        throw new Error('Cloudflare listCustomHostnames: success=false')
      }

      for (const item of data.result) {
        results.push({ id: item.id, hostname: item.hostname, status: item.status })
      }

      if (page >= data.result_info.total_pages) break
      page++
    }

    return results
  }
}

// ── Mock implementation for tests ────────────────────────────────────────────

export interface MockHostnameEntry {
  id: string
  hostname: string
  status: string
  deleted?: boolean
}

/**
 * Mock adapter for testing. Stores hostnames in memory, counts create calls.
 * Allows pre-seeding orphaned hostnames for reconciliation sweep tests.
 */
export class MockCloudflareSaasAdapter implements CloudflareSaasAdapter {
  private _callCount = 0
  private _hostnames: Map<string, MockHostnameEntry> = new Map()

  get callCount(): number {
    return this._callCount
  }

  /** Pre-seed a hostname as if it was created but the DB was rolled back. */
  seedOrphan(id: string, hostname: string, status = 'active'): void {
    this._hostnames.set(id, { id, hostname, status })
  }

  async createCustomHostname(
    serverId: string,
    _zoneId: string,
    _token: string,
  ): Promise<CloudflareCustomHostname> {
    this._callCount++
    const id = `mock-${serverId}`
    const hostname = buildSandboxHostname(serverId)
    const entry: MockHostnameEntry = { id, hostname, status: 'active' }
    this._hostnames.set(id, entry)
    return { id, hostname, status: 'active' }
  }

  async deleteCustomHostname(
    hostnameId: string,
    _zoneId: string,
    _token: string,
  ): Promise<void> {
    const entry = this._hostnames.get(hostnameId)
    if (!entry) return // 404 → no-op (idempotent)
    entry.deleted = true
    this._hostnames.delete(hostnameId)
  }

  async getCustomHostname(
    hostnameId: string,
    _zoneId: string,
    _token: string,
  ): Promise<CloudflareCustomHostname | null> {
    const entry = this._hostnames.get(hostnameId)
    if (!entry) return null
    return { id: entry.id, hostname: entry.hostname, status: entry.status }
  }

  async listCustomHostnames(_zoneId: string, _token: string): Promise<CloudflareCustomHostname[]> {
    return Array.from(this._hostnames.values()).map(e => ({
      id: e.id,
      hostname: e.hostname,
      status: e.status,
    }))
  }

  /** Check if a hostname ID exists (not deleted). */
  has(hostnameId: string): boolean {
    return this._hostnames.has(hostnameId)
  }
}
