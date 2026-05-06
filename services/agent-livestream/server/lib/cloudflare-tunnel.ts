/**
 * Cloudflare Tunnel ingress rule management for sandbox per-VM routing.
 *
 * Each sandbox VM gets one ingress rule in the shared duoidal tunnel:
 *   `*.{serverId}.example.com → http://{vm-ip}:8080`
 *
 * The port router at :8080 on the VM reads the Host header and proxies
 * to the correct local port (e.g. 3737 for mermaid).
 *
 * Ingress rules are managed via the Cloudflare Tunnel configurations API
 * (remotely-managed tunnel, config_src: "cloudflare").
 *
 * NOTE: This adapter does a GET-then-PUT of the full ingress config.
 * Under concurrent provisioning, two simultaneous calls may race.
 * This is acceptable for single-user-at-a-time provisioning scenarios.
 *
 * Loose coupling: accountId, tunnelId, and token are passed per-call.
 */

import { createLogger } from '@skill-networks/logger'

const logger = createLogger('agent-livestream:cloudflare-tunnel')

const CF_API_BASE = 'https://api.cloudflare.com/client/v4'

// ── Types ────────────────────────────────────────────────────────────────────

export interface TunnelIngressRule {
  hostname?: string
  service: string
}

export interface TunnelConfig {
  ingress: TunnelIngressRule[]
  'warp-routing'?: { enabled: boolean }
}

export interface CloudflareTunnelAdapter {
  /** Add a per-VM ingress rule before the catch-all. No-op if hostname already present. */
  addIngressRule(
    accountId: string,
    tunnelId: string,
    hostname: string,
    service: string,
    token: string,
  ): Promise<void>

  /** Remove the ingress rule for the given hostname. No-op if not found. */
  removeIngressRule(
    accountId: string,
    tunnelId: string,
    hostname: string,
    token: string,
  ): Promise<void>
}

// ── Real HTTP implementation ──────────────────────────────────────────────────

export class HttpCloudflareTunnelAdapter implements CloudflareTunnelAdapter {
  private async getConfig(accountId: string, tunnelId: string, token: string): Promise<TunnelConfig> {
    const res = await fetch(
      `${CF_API_BASE}/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`,
      { headers: { 'Authorization': `Bearer ${token}` } },
    )

    if (!res.ok) {
      const body = await res.text()
      throw new Error(`Cloudflare getConfig failed: HTTP ${res.status} — ${body.slice(0, 200)}`)
    }

    type CfConfigResponse = { result: { config: TunnelConfig } | null }
    const data = await res.json() as CfConfigResponse
    if (!data.result?.config) {
      throw new Error('Cloudflare getConfig: no config in response')
    }
    return data.result.config
  }

  private async putConfig(accountId: string, tunnelId: string, config: TunnelConfig, token: string): Promise<void> {
    const res = await fetch(
      `${CF_API_BASE}/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`,
      {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ config }),
      },
    )

    if (!res.ok) {
      const body = await res.text()
      throw new Error(`Cloudflare putConfig failed: HTTP ${res.status} — ${body.slice(0, 200)}`)
    }
  }

  async addIngressRule(
    accountId: string,
    tunnelId: string,
    hostname: string,
    service: string,
    token: string,
  ): Promise<void> {
    const config = await this.getConfig(accountId, tunnelId, token)
    const { ingress } = config

    // No-op if rule already exists for this hostname
    if (ingress.some(r => r.hostname === hostname)) {
      logger.info('CF tunnel ingress rule already exists', { hostname })
      return
    }

    // Insert before the first wildcard-or-catch-all rule so more-specific rules
    // are evaluated first. Cloudflare tunnel rules are first-match-wins:
    // `*.example.com` (catch-all wildcard) would match `*.{serverId}.example.com`
    // before the per-VM rule if inserted after it. We must insert before any rule
    // whose hostname is a wildcard suffix of ours or has no hostname at all.
    const insertAt = ingress.findIndex(r => {
      if (!r.hostname) return true  // bare catch-all (no hostname)
      if (r.hostname.startsWith('*.') && hostname.endsWith(r.hostname.slice(1))) return true  // wildcard that would match our hostname
      return false
    })
    ingress.splice(insertAt === -1 ? ingress.length : insertAt, 0, { hostname, service })

    await this.putConfig(accountId, tunnelId, config, token)
    logger.info('CF tunnel ingress rule added', { hostname, service })
  }

  async removeIngressRule(
    accountId: string,
    tunnelId: string,
    hostname: string,
    token: string,
  ): Promise<void> {
    const config = await this.getConfig(accountId, tunnelId, token)
    const before = config.ingress.length
    config.ingress = config.ingress.filter(r => r.hostname !== hostname)

    if (config.ingress.length === before) {
      logger.info('CF tunnel ingress rule not found (no-op)', { hostname })
      return
    }

    await this.putConfig(accountId, tunnelId, config, token)
    logger.info('CF tunnel ingress rule removed', { hostname })
  }
}

// ── Mock implementation for tests ────────────────────────────────────────────

export class MockCloudflareTunnelAdapter implements CloudflareTunnelAdapter {
  private _rules = new Map<string, string>() // hostname → service

  async addIngressRule(
    _accountId: string,
    _tunnelId: string,
    hostname: string,
    service: string,
    _token: string,
  ): Promise<void> {
    this._rules.set(hostname, service)
  }

  async removeIngressRule(
    _accountId: string,
    _tunnelId: string,
    hostname: string,
    _token: string,
  ): Promise<void> {
    this._rules.delete(hostname)
  }

  hasRule(hostname: string): boolean {
    return this._rules.has(hostname)
  }

  getService(hostname: string): string | undefined {
    return this._rules.get(hostname)
  }
}
