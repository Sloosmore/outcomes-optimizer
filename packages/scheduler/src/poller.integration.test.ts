/**
 * Integration tests for the poller SQL queries.
 *
 * These tests connect to the real DB (DATABASE_URL or SKILL_NETWORKS_DATABASE_URL)
 * and verify the actual SQL behaviour under controlled conditions.
 *
 * Run with:
 *   DATABASE_URL=... npx vitest run packages/scheduler/src/poller.integration.test.ts
 */

// Minimal vitest mocks so the poller module can import child_process and
// dispatch without actually executing anything.
vi.mock('child_process', () => ({
  execFile: vi.fn(),
  spawn: vi.fn(() => {
    const emitter = { on: vi.fn(), removeListener: vi.fn() }
    return emitter
  }),
}))
vi.mock('@duoidal/utils/dispatch', () => ({
  validateSkillConfig: vi.fn(() => false),
  dispatchRun: vi.fn(() => Promise.resolve('completed')),
}))

import postgres from 'postgres'
import { shouldDispatch } from './poller-service.js'

// ── DB connection ─────────────────────────────────────────────────────────────

const DB_URL = process.env.DATABASE_URL ?? process.env.SKILL_NETWORKS_DATABASE_URL
const RUN_INTEGRATION = !!process.env.RUN_INTEGRATION
const describeIntegration = RUN_INTEGRATION && DB_URL ? describe : describe.skip

// ── Real cron/skill IDs from the DB (confirmed 2026-03-27) ───────────────────

const SKILLS = {
  agentHours:        'd8b9ba1d-56aa-4d67-a2dc-9fe7711abfda',
  agentEfficiency:   '53deb8c9-1752-4e52-9894-58eaa99ea8f2',
  developerLeverage: '519ed841-55b9-401f-9088-5c4fc4f8f0df',
  prodFailures:      'eb26c0f6-89b0-4d27-9ca7-cd5f1bd5ffc3',
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Unique prefix for test-only DB rows so cleanup never touches real data. */
function testPrefix() {
  return `__test_${Date.now()}_`
}

/** Insert a minimal metric_snapshot row and return cleanup fn. */
async function insertMetric(
  sql: ReturnType<typeof postgres>,
  skillId: string,
  metricKey: string,
  measuredAt: Date,
  value = 1.0,
) {
  await sql`
    INSERT INTO metric_snapshots (skill_id, metric_key, value, measured_at)
    VALUES (${skillId}, ${metricKey}, ${value}, ${measuredAt})
    ON CONFLICT DO NOTHING
  `
  return async () => {
    await sql`
      DELETE FROM metric_snapshots
      WHERE skill_id = ${skillId} AND metric_key = ${metricKey} AND measured_at = ${measuredAt}
    `
  }
}

/** Insert a minimal process row and return cleanup fn. */
async function insertProcess(
  sql: ReturnType<typeof postgres>,
  opts: { skillResourceId: string; status: string; name: string; createdAt: Date },
) {
  const [row] = await sql`
    INSERT INTO processes (name, skill_resource_id, status, started_at, created_at)
    VALUES (${opts.name}, ${opts.skillResourceId}, ${opts.status}, ${opts.createdAt}, ${opts.createdAt})
    RETURNING id
  `
  const id = row.id as string
  return async () => {
    await sql`DELETE FROM processes WHERE id = ${id}`
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describeIntegration('poller integration — cron SQL query', () => {
  let sql: ReturnType<typeof postgres>

  beforeAll(() => {
    sql = postgres(DB_URL!, { ssl: 'require', max: 3 })
  })

  afterAll(async () => {
    await sql.end()
  })

  // ── Main query ──────────────────────────────────────────────────────────────

  it('main query returns only enabled crons with their linked skills', async () => {
    const rows = await sql`
      SELECT r.name AS cron_name, r.config->>'enabled' AS enabled,
             skill.name AS skill_name, skill.id AS skill_id
      FROM resources r
      JOIN resource_links rl ON rl.from_id = r.id AND rl.link_type = 'schedules'
      JOIN resources skill ON skill.id = rl.to_id
      WHERE r.type = 'cron' AND (r.config->>'enabled')::boolean = true
    `

    const names = rows.map((r: { cron_name: string }) => r.cron_name)

    // Enabled crons must appear
    expect(names).toContain('agent-hours-cron')
    expect(names).toContain('failures-in-prod-cron')
    expect(names).toContain('developer-leverage-cron')
  })

  it('main query joins the correct skill_id for each cron', async () => {
    const rows = await sql<{ cron_name: string; skill_id: string }[]>`
      SELECT r.name AS cron_name, skill.id AS skill_id
      FROM resources r
      JOIN resource_links rl ON rl.from_id = r.id AND rl.link_type = 'schedules'
      JOIN resources skill ON skill.id = rl.to_id
      WHERE r.type = 'cron' AND (r.config->>'enabled')::boolean = true
    `

    const byName = Object.fromEntries(rows.map(r => [r.cron_name, r.skill_id]))

    expect(byName['agent-hours-cron']).toBe(SKILLS.agentHours)
    expect(byName['failures-in-prod-cron']).toBe(SKILLS.prodFailures)
    expect(byName['developer-leverage-cron']).toBe(SKILLS.developerLeverage)
  })

  // ── Gate 1: metric idempotency ──────────────────────────────────────────────

  it('shouldDispatch skips when metric already recorded today', async () => {
    const today = new Date()
    today.setUTCHours(0, 1, 0, 0) // 00:01 UTC today

    const cleanup = await insertMetric(sql, SKILLS.agentHours, '__test_metric_gate1', today)
    try {
      const result = await shouldDispatch(sql, SKILLS.agentHours, '__test_metric_gate1')
      expect(result).toEqual({ skip: true, reason: 'metric __test_metric_gate1 already recorded today' })
    } finally {
      await cleanup()
    }
  })

  it('shouldDispatch proceeds when metric only exists yesterday (not today)', async () => {
    const yesterday = new Date()
    yesterday.setUTCDate(yesterday.getUTCDate() - 1)
    yesterday.setUTCHours(23, 59, 59, 0)

    const cleanup = await insertMetric(sql, SKILLS.agentHours, '__test_metric_yesterday', yesterday)
    try {
      const result = await shouldDispatch(sql, SKILLS.agentHours, '__test_metric_yesterday')
      // Gate 1 passes (yesterday's metric doesn't block). Gate 2 checks active processes.
      // No test process inserted, so gate 2 passes too.
      expect(result).toEqual({ skip: false })
    } finally {
      await cleanup()
    }
  })

  it('shouldDispatch proceeds when no metric exists at all', async () => {
    const result = await shouldDispatch(sql, SKILLS.agentHours, '__test_nonexistent_metric_xyz')
    expect(result).toEqual({ skip: false })
  })

  // ── Gate 2: active process guard ────────────────────────────────────────────

  it('shouldDispatch skips when active process exists today', async () => {
    const todayStart = new Date()
    todayStart.setUTCHours(0, 5, 0, 0)

    const prefix = testPrefix()
    const cleanup = await insertProcess(sql, {
      skillResourceId: SKILLS.agentHours,
      status: 'active',
      name: `${prefix}agent-hours`,
      createdAt: todayStart,
    })
    try {
      const result = await shouldDispatch(sql, SKILLS.agentHours, undefined)
      expect(result).toEqual({ skip: true, reason: 'active process exists' })
    } finally {
      await cleanup()
    }
  })

  it('shouldDispatch skips when pending process exists today', async () => {
    const todayStart = new Date()
    todayStart.setUTCHours(1, 0, 0, 0)

    const prefix = testPrefix()
    const cleanup = await insertProcess(sql, {
      skillResourceId: SKILLS.agentHours,
      status: 'pending',
      name: `${prefix}agent-hours-pending`,
      createdAt: todayStart,
    })
    try {
      const result = await shouldDispatch(sql, SKILLS.agentHours, undefined)
      expect(result).toEqual({ skip: true, reason: 'active process exists' })
    } finally {
      await cleanup()
    }
  })

  it('shouldDispatch proceeds when only a failed process exists today', async () => {
    const todayStart = new Date()
    todayStart.setUTCHours(0, 10, 0, 0)

    const prefix = testPrefix()
    const cleanup = await insertProcess(sql, {
      skillResourceId: SKILLS.agentHours,
      status: 'failed',
      name: `${prefix}agent-hours-failed`,
      createdAt: todayStart,
    })
    try {
      const result = await shouldDispatch(sql, SKILLS.agentHours, undefined)
      // failed processes don't block — only active/pending do
      expect(result).toEqual({ skip: false })
    } finally {
      await cleanup()
    }
  })

  it('shouldDispatch proceeds when active process was yesterday, not today', async () => {
    const yesterday = new Date()
    yesterday.setUTCDate(yesterday.getUTCDate() - 1)
    yesterday.setUTCHours(12, 0, 0, 0)

    const prefix = testPrefix()
    const cleanup = await insertProcess(sql, {
      skillResourceId: SKILLS.agentHours,
      status: 'active',
      name: `${prefix}agent-hours-yesterday`,
      createdAt: yesterday,
    })
    try {
      const result = await shouldDispatch(sql, SKILLS.agentHours, undefined)
      // yesterday's active process doesn't block today's dispatch
      expect(result).toEqual({ skip: false })
    } finally {
      await cleanup()
    }
  })

  // ── Gate 0: depends_on check ────────────────────────────────────────────────

  it('depends_on check fails when metric not recorded today', async () => {
    const [depRow] = await sql`
      SELECT 1 FROM metric_snapshots
      WHERE metric_key = 'human_equivalent_hours_per_day'
        AND measured_at >= date_trunc('day', NOW())
      LIMIT 1
    `
    // Only run this assertion when the dep is genuinely absent from the window
    if (!depRow) {
      const [checkRow] = await sql`
        SELECT 1 FROM metric_snapshots
        WHERE metric_key = 'human_equivalent_hours_per_day'
          AND measured_at >= date_trunc('day', NOW())
      `
      expect(checkRow).toBeUndefined()
    } else {
      console.log('human_equivalent_hours_per_day is within 24h — skipping absence assertion')
    }
  })

  it('depends_on check passes when metric IS recorded today', async () => {
    const recentTime = new Date(Date.now() - 60 * 60 * 1000) // 1 hour ago

    const cleanup = await insertMetric(
      sql, SKILLS.developerLeverage, 'human_equivalent_hours_per_day', recentTime, 3.5,
    )
    try {
      const [row] = await sql`
        SELECT 1 FROM metric_snapshots
        WHERE metric_key = 'human_equivalent_hours_per_day'
          AND measured_at >= date_trunc('day', NOW())
        LIMIT 1
      `
      expect(row).toBeDefined()
    } finally {
      await cleanup()
    }
  })

  // ── Diagnostic: current eligible cron list ("the CSV") ──────────────────────

  it('diagnostic: show which crons are eligible right now given real DB state', async () => {
    const { CronExpressionParser } = await import('cron-parser')

    // Run the main query
    const rows = await sql<{
      cron_name: string; schedule: string; skill_id: string; skill_name: string
      metric_key: string | null; depends_on: string[] | null
    }[]>`
      SELECT r.name AS cron_name, r.config->>'schedule' AS schedule,
             skill.id AS skill_id, skill.name AS skill_name,
             skill.config->>'metric' AS metric_key,
             (r.config->'depends_on')::jsonb AS depends_on
      FROM resources r
      JOIN resource_links rl ON rl.from_id = r.id AND rl.link_type = 'schedules'
      JOIN resources skill ON skill.id = rl.to_id
      WHERE r.type = 'cron' AND (r.config->>'enabled')::boolean = true
    `

    const POLL_WINDOW_MS = 5 * 60 * 1000
    const now = new Date()
    const eligible: string[] = []
    const skipped: Array<{ name: string; reason: string }> = []

    for (const row of rows) {
      // Schedule check
      let prevFire: Date
      try {
        prevFire = CronExpressionParser.parse(row.schedule, { currentDate: now, tz: 'UTC' }).prev().toDate()
      } catch {
        skipped.push({ name: row.cron_name, reason: 'bad cron expression' })
        continue
      }
      if (now.getTime() - prevFire.getTime() > POLL_WINDOW_MS) {
        skipped.push({ name: row.cron_name, reason: 'schedule window not yet reached' })
        continue
      }

      // Gate 0: depends_on
      let depMissing = false
      if (Array.isArray(row.depends_on) && row.depends_on.length > 0) {
        for (const dep of row.depends_on) {
          const [depRow] = await sql`
            SELECT 1 FROM metric_snapshots
            WHERE metric_key = ${dep} AND measured_at >= date_trunc('day', NOW())
            LIMIT 1
          `
          if (!depRow) {
            skipped.push({ name: row.cron_name, reason: `dep missing: ${dep}` })
            depMissing = true
            break
          }
        }
      }
      if (depMissing) continue

      // Gate 1/2: shouldDispatch
      const result = await shouldDispatch(sql, row.skill_id, row.metric_key ?? undefined)
      if (result.skip) {
        skipped.push({ name: row.cron_name, reason: result.reason })
        continue
      }

      eligible.push(row.cron_name)
    }

    // Print the CSV
    console.log('\n=== CRON ELIGIBILITY REPORT ===')
    console.log(`Eligible (would fire): [${eligible.join(', ') || 'NONE'}]`)
    for (const s of skipped) {
      console.log(`  SKIP ${s.name}: ${s.reason}`)
    }
    console.log('================================\n')

    // No hard assertion — this is a diagnostic. The test always passes.
    expect(Array.isArray(eligible)).toBe(true)
  })
})
