/**
 * Cloudflare Zone DNS record management for sandbox per-VM routing.
 *
 * Used by the sandbox provisioner to create/delete CNAME records that route
 * `*.{serverId}.example.com` → the shared cloudflared tunnel and to add
 * DCV delegation CNAMEs for per-hostname TLS certificate issuance.
 *
 * Loose coupling: zone ID and bearer token are passed per-call, not read from env.
 */

import { createLogger } from '@skill-networks/logger'

const logger = createLogger('agent-livestream:cloudflare-dns')

const CF_API_BASE = 'https://api.cloudflare.com/client/v4'

// ── Types ────────────────────────────────────────────────────────────────────

export interface CloudflareDnsRecord {
  id: string
  name: string
  type: string
  content: string
  proxied: boolean
}

export interface CloudflareDnsAdapter {
  createCnameRecord(
    zoneId: string,
    name: string,
    target: string,
    proxied: boolean,
    token: string,
  ): Promise<CloudflareDnsRecord>

  createTxtRecord(
    zoneId: string,
    name: string,
    value: string,
    token: string,
  ): Promise<CloudflareDnsRecord>

  deleteDnsRecord(zoneId: string, recordId: string, token: string): Promise<void>
}

// ── Real HTTP implementation ──────────────────────────────────────────────────

export class HttpCloudflareDnsAdapter implements CloudflareDnsAdapter {
  async createCnameRecord(
    zoneId: string,
    name: string,
    target: string,
    proxied: boolean,
    token: string,
  ): Promise<CloudflareDnsRecord> {
    const res = await fetch(`${CF_API_BASE}/zones/${zoneId}/dns_records`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ type: 'CNAME', name, content: target, proxied, ttl: 1 }),
    })

    type CfResponse = {
      success: boolean
      errors: Array<{ code: number; message: string }>
      result: { id: string; name: string; type: string; content: string; proxied: boolean } | null
    }

    const data = await res.json() as CfResponse
    if (!data.success || !data.result) {
      const errMsg = data.errors.map(e => `${e.code}: ${e.message}`).join(', ')
      logger.error('CF createCnameRecord failed', { name, target, errors: errMsg })
      throw new Error(`Cloudflare createCnameRecord failed: ${errMsg}`)
    }

    logger.info('CF CNAME record created', { name, target, proxied, id: data.result.id })
    return { id: data.result.id, name: data.result.name, type: 'CNAME', content: data.result.content, proxied: data.result.proxied }
  }

  async createTxtRecord(
    zoneId: string,
    name: string,
    value: string,
    token: string,
  ): Promise<CloudflareDnsRecord> {
    const res = await fetch(`${CF_API_BASE}/zones/${zoneId}/dns_records`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ type: 'TXT', name, content: value, ttl: 60 }),
    })

    type CfResponse = {
      success: boolean
      errors: Array<{ code: number; message: string }>
      result: { id: string; name: string; type: string; content: string; proxied: boolean } | null
    }

    const data = await res.json() as CfResponse
    if (!data.success || !data.result) {
      const errMsg = data.errors.map(e => `${e.code}: ${e.message}`).join(', ')
      logger.error('CF createTxtRecord failed', { name, errors: errMsg })
      throw new Error(`Cloudflare createTxtRecord failed: ${errMsg}`)
    }

    logger.info('CF TXT record created', { name, id: data.result.id })
    return { id: data.result.id, name: data.result.name, type: 'TXT', content: data.result.content, proxied: false }
  }

  async deleteDnsRecord(zoneId: string, recordId: string, token: string): Promise<void> {
    const res = await fetch(`${CF_API_BASE}/zones/${zoneId}/dns_records/${recordId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` },
    })

    if (res.status === 404) {
      logger.info('CF DNS record already deleted (404)', { recordId })
      return
    }

    if (!res.ok) {
      const body = await res.text()
      logger.error('CF deleteDnsRecord failed', { recordId, status: res.status, body })
      throw new Error(`Cloudflare deleteDnsRecord failed: HTTP ${res.status}`)
    }

    logger.info('CF DNS record deleted', { recordId })
  }
}

// ── Mock implementation for tests ────────────────────────────────────────────

export class MockCloudflareDnsAdapter implements CloudflareDnsAdapter {
  private _records = new Map<string, CloudflareDnsRecord>()

  async createCnameRecord(
    _zoneId: string,
    name: string,
    target: string,
    proxied: boolean,
    _token: string,
  ): Promise<CloudflareDnsRecord> {
    const id = `mock-cname-${name}`
    const record: CloudflareDnsRecord = { id, name, type: 'CNAME', content: target, proxied }
    this._records.set(id, record)
    return record
  }

  async createTxtRecord(
    _zoneId: string,
    name: string,
    value: string,
    _token: string,
  ): Promise<CloudflareDnsRecord> {
    const id = `mock-txt-${name}-${value.slice(0, 8)}`
    const record: CloudflareDnsRecord = { id, name, type: 'TXT', content: value, proxied: false }
    this._records.set(id, record)
    return record
  }

  async deleteDnsRecord(_zoneId: string, recordId: string, _token: string): Promise<void> {
    this._records.delete(recordId)
  }

  has(recordId: string): boolean {
    return this._records.has(recordId)
  }

  list(): CloudflareDnsRecord[] {
    return Array.from(this._records.values())
  }
}
