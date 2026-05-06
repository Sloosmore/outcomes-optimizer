import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execSync } from 'node:child_process'
import { getSqlClient } from '@skill-networks/database/client'
import { ResourcesService } from '@skill-networks/database'
import http from 'node:http'

const RUN_INTEGRATION = process.env.RUN_INTEGRATION === 'true'
const HAS_DB = !!(process.env.DATABASE_URL || process.env.DIRECT_URL)
const HAS_SUPABASE = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY)

const skipReason = !RUN_INTEGRATION
  ? 'RUN_INTEGRATION not set'
  : !HAS_DB
    ? 'DATABASE_URL / DIRECT_URL not set'
    : !HAS_SUPABASE
      ? 'SUPABASE_URL or SUPABASE_SERVICE_KEY not set'
      : ''

/**
 * HTTP GET via Node's http module directly.
 * Bypasses Node 22's built-in fetch (undici) which, in some environments,
 * applies SSRF protection blocking localhost requests.
 */
function httpGet(url: string): Promise<{ ok: boolean; status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString()
        resolve({ ok: (res.statusCode ?? 500) >= 200 && (res.statusCode ?? 500) < 300, status: res.statusCode ?? 500, body })
      })
    }).on('error', reject)
  })
}

describe.skipIf(!!skipReason)('metrics E2E (CLI write -> BFF read)', () => {
  let testSkillId: string
  let testSkillName: string
  const FIXED_AT = '2026-01-01T00:00:00Z'
  const BFF_BASE = `http://localhost:${process.env.API_PORT ?? '3001'}`

  function cli(args: string): string {
    return execSync(`npx agent-core ${args}`, { encoding: 'utf-8', timeout: 30_000 })
  }

  beforeAll(async () => {
    const suffix = Math.random().toString(36).slice(2, 8)
    testSkillName = `e2e-metrics-test-${suffix}`
    const resource = await new ResourcesService(getSqlClient()).add(testSkillName, 'skill')
    testSkillId = resource.id
  })

  afterAll(async () => {
    if (!testSkillId) return
    const sql = getSqlClient()
    await sql`DELETE FROM metric_snapshots WHERE skill_id = ${testSkillId}`
    if (testSkillName) await new ResourcesService(sql).remove(testSkillName)
  })

  it('records a metric via CLI', () => {
    const out = cli(`metrics record --skill-id ${testSkillId} --key e2e_test --value 42 --measured-at ${FIXED_AT}`)
    expect(out.trim()).toBe('recorded')
  })

  it('BFF /latest returns recorded metric with value 42', async () => {
    const { ok, status, body } = await httpGet(`${BFF_BASE}/api/skill-metrics/${testSkillId}/latest`)
    expect(ok, `BFF returned ${status}: ${body}`).toBe(true)
    const data = JSON.parse(body) as Array<{ metric_key: string; value: number | string }>
    const found = data.find(m => m.metric_key === 'e2e_test')
    expect(found).toBeDefined()
    expect(Number(found!.value)).toBe(42)
  })

  it('upserts same key + same measured_at with new value via CLI', () => {
    const out = cli(`metrics record --skill-id ${testSkillId} --key e2e_test --value 99 --measured-at ${FIXED_AT}`)
    expect(out.trim()).toBe('recorded')
  })

  it('BFF /latest reflects upserted value 99', async () => {
    const { ok, body } = await httpGet(`${BFF_BASE}/api/skill-metrics/${testSkillId}/latest`)
    expect(ok).toBe(true)
    const data = JSON.parse(body) as Array<{ metric_key: string; value: number | string }>
    const found = data.find(m => m.metric_key === 'e2e_test')
    expect(found).toBeDefined()
    expect(Number(found!.value)).toBe(99)
  })

  it('records a second metric key via CLI', () => {
    const out = cli(`metrics record --skill-id ${testSkillId} --key e2e_test_2 --value 7 --measured-at ${FIXED_AT}`)
    expect(out.trim()).toBe('recorded')
  })

  it('BFF /latest returns both metric keys', async () => {
    const { ok, body } = await httpGet(`${BFF_BASE}/api/skill-metrics/${testSkillId}/latest`)
    expect(ok).toBe(true)
    const data = JSON.parse(body) as Array<{ metric_key: string }>
    const keys = data.map(m => m.metric_key)
    expect(keys).toContain('e2e_test')
    expect(keys).toContain('e2e_test_2')
  })

  it('BFF /history returns at least one entry', async () => {
    const { ok, body } = await httpGet(`${BFF_BASE}/api/skill-metrics/${testSkillId}/history?key=e2e_test&days=3650`)
    expect(ok).toBe(true)
    const data = JSON.parse(body) as Array<{ metric_key: string; value: number | string; measured_at: string }>
    expect(data.length).toBeGreaterThan(0)
  })

  it('records with metadata via CLI and BFF returns it', async () => {
    cli(`metrics record --skill-id ${testSkillId} --key e2e_test --value 99 --metadata '{"source":"e2e"}' --measured-at ${FIXED_AT}`)
    const { ok, body } = await httpGet(`${BFF_BASE}/api/skill-metrics/${testSkillId}/latest`)
    expect(ok).toBe(true)
    const data = JSON.parse(body) as Array<{ metric_key: string; metadata: Record<string, unknown> | null }>
    const found = data.find(m => m.metric_key === 'e2e_test')
    expect(found).toBeDefined()
    expect(found!.metadata).toEqual(expect.objectContaining({ source: 'e2e' }))
  })
})
