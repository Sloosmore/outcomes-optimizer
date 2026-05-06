/**
 * Reconcile CF custom hostnames against the DB.
 *
 * For every custom hostname in the CF zone that matches the sandbox pattern
 * ({resourceId}.example.com), check whether a resource row exists in Supabase.
 * If none does, the hostname is an orphan — it was created during provisioning
 * but the DB write failed or was rolled back.
 *
 * Usage:
 *   npx tsx scripts/reconcile-cf-hostnames.ts --zone <ZONE_ID> [--dry-run]
 *
 * Env vars required:
 *   CLOUDFLARE_API_TOKEN  — bearer token for CF API
 *   SUPABASE_URL          — Supabase project URL
 *   SUPABASE_SERVICE_KEY  — service-role key for unrestricted DB read
 */

import { parseArgs } from 'node:util'
import { createLogger } from '@skill-networks/logger'
import { getSupabaseUrl, getSupabaseServiceKey } from '@skill-networks/database/constants'

const logger = createLogger('reconcile-cf-hostnames')

const CF_API_BASE = 'https://api.cloudflare.com/client/v4'
// Sandbox hostnames follow the pattern: {resourceId}.example.com
const SANDBOX_HOSTNAME_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.duoidal\.com$/

interface CfHostname {
  id: string
  hostname: string
  status: string
}

async function listAllCfHostnames(zoneId: string, token: string): Promise<CfHostname[]> {
  const results: CfHostname[] = []
  let page = 1
  const perPage = 50

  for (;;) {
    const res = await fetch(
      `${CF_API_BASE}/zones/${zoneId}/custom_hostnames?per_page=${perPage}&page=${page}`,
      { headers: { Authorization: `Bearer ${token}` } },
    )
    if (!res.ok) {
      const body = await res.text()
      throw new Error(`CF listCustomHostnames failed: HTTP ${res.status} — ${body}`)
    }
    type CfListResponse = {
      success: boolean
      result: Array<{ id: string; hostname: string; status: string }>
      result_info: { total_pages: number; page: number }
    }
    const data = await res.json() as CfListResponse
    if (!data.success) throw new Error('CF listCustomHostnames: success=false')
    for (const item of data.result) {
      results.push({ id: item.id, hostname: item.hostname, status: item.status })
    }
    if (page >= data.result_info.total_pages) break
    page++
  }
  return results
}

async function getDbResourceIds(): Promise<Set<string>> {
  const supabaseUrl = getSupabaseUrl()
  const serviceKey = getSupabaseServiceKey()
  const res = await fetch(`${supabaseUrl}/rest/v1/resources?type=eq.server&select=id`, {
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
    },
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Supabase query failed: HTTP ${res.status} — ${body}`)
  }
  const rows = await res.json() as Array<{ id: string }>
  return new Set(rows.map(r => r.id))
}

async function deleteCfHostname(hostnameId: string, zoneId: string, token: string): Promise<void> {
  const res = await fetch(`${CF_API_BASE}/zones/${zoneId}/custom_hostnames/${hostnameId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  })
  if (res.status === 404) return // already gone
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`CF deleteCustomHostname failed: HTTP ${res.status} — ${body}`)
  }
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      zone: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
    },
  })

  const zoneId = values['zone']
  if (!zoneId) {
    console.error('Usage: reconcile-cf-hostnames.ts --zone <ZONE_ID> [--dry-run]')
    process.exit(1)
  }

  const token = process.env['CLOUDFLARE_API_TOKEN']
  if (!token) {
    console.error('Missing required env var: CLOUDFLARE_API_TOKEN')
    process.exit(1)
  }

  const dryRun = values['dry-run'] ?? false
  logger.info('Starting CF hostname reconciliation', { zoneId, dryRun })

  const [cfHostnames, dbIds] = await Promise.all([
    listAllCfHostnames(zoneId, token),
    getDbResourceIds(),
  ])

  logger.info('Fetched CF hostnames and DB resource IDs', {
    cfCount: cfHostnames.length,
    dbCount: dbIds.size,
  })

  const orphans: CfHostname[] = []
  for (const h of cfHostnames) {
    const match = SANDBOX_HOSTNAME_RE.exec(h.hostname)
    if (!match) continue // not a sandbox hostname
    const resourceId = match[1]
    if (!dbIds.has(resourceId)) {
      orphans.push(h)
    }
  }

  if (orphans.length === 0) {
    logger.info('No orphan hostnames found')
    console.log('orphan count: 0')
    return
  }

  for (const orphan of orphans) {
    if (dryRun) {
      logger.info('Would delete orphan hostname (dry-run)', { id: orphan.id, hostname: orphan.hostname })
      console.log(`orphan: ${orphan.hostname} (id=${orphan.id}, status=${orphan.status}) [dry-run]`)
    } else {
      logger.info('Deleting orphan hostname', { id: orphan.id, hostname: orphan.hostname })
      await deleteCfHostname(orphan.id, zoneId, token)
      logger.info('Deleted orphan hostname', { id: orphan.id, hostname: orphan.hostname })
      console.log(`orphan deleted: ${orphan.hostname} (id=${orphan.id})`)
    }
  }

  console.log(`orphan count: ${orphans.length}`)
}

main().catch(err => {
  logger.error('Reconciliation failed', { error: err instanceof Error ? err.message : String(err) })
  process.exit(1)
})
