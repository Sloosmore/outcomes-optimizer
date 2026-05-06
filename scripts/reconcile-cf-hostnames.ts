/**
 * Reconciliation sweep: Cloudflare for SaaS custom hostname orphan cleanup.
 *
 * Lists all CF custom hostnames in the zone matching `*.{uuid}.example.com`.
 * Cross-references against the DB: SELECT id FROM resources WHERE type='server'
 * AND config ? 'cloudflareCustomHostnameId'.
 *
 * Deletes any CF hostname whose server UUID has no matching DB row (orphan).
 * Idempotent: safe to run repeatedly — no-op if nothing to reconcile.
 *
 * Usage:
 *   npx tsx scripts/reconcile-cf-hostnames.ts \
 *     --zone <CLOUDFLARE_ZONE_ID> \
 *     --token <CF_API_TOKEN> \
 *     --database-url <POSTGRES_URL>
 *
 * Or via env vars:
 *   CLOUDFLARE_ZONE_ID=... CLOUDFLARE_API_TOKEN=... DATABASE_URL=... npx tsx scripts/reconcile-cf-hostnames.ts
 *
 * Dry-run mode (list only, no deletes):
 *   ... --dry-run
 */

import postgres from 'postgres'

// ── Argument parsing ─────────────────────────────────────────────────────────

function getArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag)
  return idx !== -1 ? process.argv[idx + 1] : undefined
}

const zoneId = getArg('--zone') ?? process.env['CLOUDFLARE_ZONE_ID']
const token = getArg('--token') ?? process.env['CLOUDFLARE_API_TOKEN']
const databaseUrl = getArg('--database-url') ?? process.env['DATABASE_URL'] ?? process.env['SKILL_NETWORKS_DATABASE_URL']
const dryRun = process.argv.includes('--dry-run')

if (!zoneId || !token || !databaseUrl) {
  console.error('Error: --zone, --token, and --database-url are required (or set env vars)')
  process.exit(1)
}

// ── Cloudflare API helpers ───────────────────────────────────────────────────

const CF_API_BASE = 'https://api.cloudflare.com/client/v4'

interface CfHostname {
  id: string
  hostname: string
  status: string
}

async function listAllCustomHostnames(zoneId: string, token: string): Promise<CfHostname[]> {
  const results: CfHostname[] = []
  let page = 1
  const perPage = 50

  for (;;) {
    const res = await fetch(
      `${CF_API_BASE}/zones/${zoneId}/custom_hostnames?per_page=${perPage}&page=${page}`,
      { headers: { 'Authorization': `Bearer ${token}` } },
    )

    if (!res.ok) {
      const body = await res.text()
      throw new Error(`CF listCustomHostnames failed: HTTP ${res.status} — ${body}`)
    }

    type CfListResponse = {
      success: boolean
      errors: Array<{ code: number; message: string }>
      result: Array<{ id: string; hostname: string; status: string }>
      result_info: { total_pages: number; page: number }
    }
    const data = await res.json() as CfListResponse

    if (!data.success) {
      const errMsg = (data.errors ?? []).map(e => `${e.code}: ${e.message}`).join(', ')
      throw new Error(`CF listCustomHostnames: success=false — ${errMsg}`)
    }

    for (const item of data.result) {
      results.push({ id: item.id, hostname: item.hostname, status: item.status })
    }

    if (page >= data.result_info.total_pages) break
    page++
  }

  return results
}

async function deleteCustomHostname(hostnameId: string, zoneId: string, token: string): Promise<void> {
  const res = await fetch(`${CF_API_BASE}/zones/${zoneId}/custom_hostnames/${hostnameId}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${token}` },
  })

  if (res.status === 404) {
    // Already gone — idempotent
    return
  }

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`CF deleteCustomHostname failed: HTTP ${res.status} — ${body}`)
  }
}

// ── DB helpers ───────────────────────────────────────────────────────────────

/**
 * Pattern: *.{uuid}.example.com
 * Extract the server UUID from a wildcard hostname.
 * Returns null if the hostname doesn't match the expected pattern.
 */
function extractServerIdFromHostname(hostname: string): string | null {
  // Matches: *.{uuid}.example.com
  const match = hostname.match(/^\*\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.duoidal\.com$/)
  return match?.[1] ?? null
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`Reconcile CF hostnames — zone: ${zoneId} | dry-run: ${dryRun}`)

  const sql = postgres(databaseUrl!)

  try {
    // 1. List all CF custom hostnames
    console.log('Fetching CF custom hostnames...')
    const cfHostnames = await listAllCustomHostnames(zoneId!, token!)
    console.log(`Found ${cfHostnames.length} CF custom hostnames`)

    // 2. Filter to sandbox-pattern hostnames (*.{uuid}.example.com)
    const sandboxHostnames = cfHostnames.filter(h => extractServerIdFromHostname(h.hostname) !== null)
    console.log(`${sandboxHostnames.length} match sandbox pattern (*.{uuid}.example.com)`)

    if (sandboxHostnames.length === 0) {
      console.log('No sandbox hostnames — nothing to reconcile')
      return
    }

    // 3. Fetch all server resource IDs from DB that have a cloudflareCustomHostnameId
    type DbRow = { id: string; cf_hostname_id: string }
    const dbRows = await sql<DbRow[]>`
      SELECT id, config->>'cloudflareCustomHostnameId' AS cf_hostname_id
      FROM public.resources
      WHERE type = 'server'
        AND config ? 'cloudflareCustomHostnameId'
    `

    const dbHostnameIds = new Set(dbRows.map(r => r.cf_hostname_id).filter(Boolean))
    const dbServerIds = new Set(dbRows.map(r => r.id))
    console.log(`DB has ${dbHostnameIds.size} server resources with cloudflareCustomHostnameId`)

    // 4. Identify orphans:
    //    A CF hostname is an orphan if its server UUID is not in the DB server IDs,
    //    or its CF hostname ID is not in the DB's recorded hostname IDs.
    const orphans = sandboxHostnames.filter(h => {
      const serverId = extractServerIdFromHostname(h.hostname)
      if (!serverId) return false
      // Orphan if the server resource doesn't exist OR the hostname ID isn't recorded
      return !dbServerIds.has(serverId) || !dbHostnameIds.has(h.id)
    })

    console.log(`Found ${orphans.length} orphaned CF hostnames`)

    if (orphans.length === 0) {
      console.log('No orphans — sweep is a no-op')
      return
    }

    // 5. Delete orphans
    for (const orphan of orphans) {
      const serverId = extractServerIdFromHostname(orphan.hostname)
      if (dryRun) {
        console.log(`[DRY-RUN] Would delete CF hostname: id=${orphan.id} hostname=${orphan.hostname} serverId=${serverId}`)
      } else {
        console.log(`Deleting orphan CF hostname: id=${orphan.id} hostname=${orphan.hostname} serverId=${serverId}`)
        await deleteCustomHostname(orphan.id, zoneId!, token!)
        console.log(`  Deleted: ${orphan.id}`)
      }
    }

    console.log(`Reconciliation complete. ${dryRun ? 'Dry-run' : 'Deleted'} ${orphans.length} orphan(s).`)
  } finally {
    await sql.end()
  }
}

main().catch(err => {
  console.error('Reconciliation failed:', err instanceof Error ? err.message : String(err))
  process.exit(1)
})
