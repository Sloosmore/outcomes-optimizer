import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getSqlClient } from '@skill-networks/database/client'
import { ResourcesService, MetricsService } from '@skill-networks/database'

const RUN_INTEGRATION = process.env.RUN_INTEGRATION === 'true'
const HAS_DB = !!(process.env.DATABASE_URL || process.env.DIRECT_URL)

describe.skipIf(!RUN_INTEGRATION || !HAS_DB)('metrics DB functions smoke test', () => {
  let testSkillId: string
  let testSkillName: string
  const FIXED_AT = '2026-01-01T00:00:00Z'

  beforeAll(async () => {
    const suffix = Math.random().toString(36).slice(2, 8)
    testSkillName = `smoke-metrics-test-${suffix}`
    const resource = await new ResourcesService(getSqlClient()).add(testSkillName, 'skill')
    testSkillId = resource.id
  })

  afterAll(async () => {
    if (!testSkillId) return
    const sql = getSqlClient()
    await sql`DELETE FROM metric_snapshots WHERE skill_id = ${testSkillId}`
    if (testSkillName) await new ResourcesService(sql).remove(testSkillName)
  })

  it('records a metric snapshot', async () => {
    await new MetricsService(getSqlClient()).record(testSkillId, 'smoke_test', 42, {}, FIXED_AT)
  })

  it('reads back via getLatestMetrics', async () => {
    const metrics = await new MetricsService(getSqlClient()).getLatest(testSkillId)
    const found = metrics.find(m => m.metricKey === 'smoke_test')
    expect(found).toBeDefined()
    expect(Number(found!.value)).toBe(42)
  })

  it('upserts on conflict', async () => {
    await new MetricsService(getSqlClient()).record(testSkillId, 'smoke_test', 99, {}, FIXED_AT)
    const metrics = await new MetricsService(getSqlClient()).getLatest(testSkillId)
    const found = metrics.find(m => m.metricKey === 'smoke_test')
    expect(Number(found!.value)).toBe(99)
  })

  it('returns metric history', async () => {
    const history = await new MetricsService(getSqlClient()).getHistory(testSkillId, 'smoke_test', 9999)
    expect(history.length).toBeGreaterThan(0)
  })

  it('throws if resource not found', async () => {
    await expect(
      new MetricsService(getSqlClient()).record('00000000-0000-0000-0000-000000000000', 'x', 1)
    ).rejects.toThrow(/not found/i)
  })

  it('throws if resource is not type skill', async () => {
    const suffix = Math.random().toString(36).slice(2, 8)
    const r = await new ResourcesService(getSqlClient()).add(`smoke-non-skill-${suffix}`, 'data')
    try {
      await expect(
        new MetricsService(getSqlClient()).record(r.id, 'x', 1)
      ).rejects.toThrow(/skill/i)
    } finally {
      await new ResourcesService(getSqlClient()).remove(r.name)
    }
  })
})
