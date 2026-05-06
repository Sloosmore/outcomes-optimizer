/**
 * metric (singular) — process-keyed metric recording.
 *
 * Unlike `metrics` (which is skill-keyed), this command records metrics
 * keyed by metric_key globally (across all processes/skills). It's designed
 * for E2E tests and agent loops that record metrics by process rather than skill.
 *
 * record: looks up skill_resource_id from the process, then records via MetricsService.
 *         If the process has no skill_resource_id, falls back to recording with the
 *         process_id treated as the entity_id (raw SQL, bypassing skill type check).
 * latest: queries latest metric snapshot(s) by key (global, not per-skill).
 * history: queries metric history by key (global).
 */
import { Command } from 'commander'
import { getUnscopedAdapter } from '../lib/adapter-factory.js'
import { createLogger } from '@skill-networks/logger'

const logger = createLogger('agent-core')

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const METRIC_KEY_RE = /^[a-zA-Z0-9_.-]{1,128}$/

export function metricCommand(): Command {
  const cmd = new Command('metric').description('Record and query metrics keyed by metric_key')

  // metric record
  cmd
    .command('record')
    .description('Record a metric value')
    .requiredOption('--key <key>', 'Metric key')
    .requiredOption('--value <number>', 'Metric value')
    .option('--process-id <uuid>', 'Process UUID (resolves skill_resource_id automatically)')
    .option('--skill-id <uuid>', 'Skill resource UUID (direct)')
    .option('--metadata <json>', 'JSON metadata object', '{}')
    .action(async (opts: { key: string; value: string; processId?: string; skillId?: string; metadata: string }) => {
      if (!METRIC_KEY_RE.test(opts.key)) {
        logger.error(`invalid key: must be 1-128 characters (alphanumeric, underscore, dot, or dash)`)
        process.exitCode = 1
        return
      }
      const numValue = Number(opts.value)
      if (!Number.isFinite(numValue)) {
        logger.error(`invalid value: "${opts.value}" is not a finite number`)
        process.exitCode = 1
        return
      }
      let metadata: Record<string, unknown>
      try {
        const parsed = JSON.parse(opts.metadata)
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          logger.error(`invalid metadata: must be a JSON object`)
          process.exitCode = 1
          return
        }
        metadata = parsed as Record<string, unknown>
      } catch {
        logger.error(`invalid metadata: must be valid JSON object`)
        process.exitCode = 1
        return
      }

      try {
        let entityId: string | null = opts.skillId ?? null

        // Resolve via process
        if (!entityId && opts.processId) {
          if (!UUID_RE.test(opts.processId)) throw new Error('--process-id must be a valid UUID')
          const proc = await getUnscopedAdapter().getProcessById(opts.processId)
          if (!proc) throw new Error(`Process not found: ${opts.processId}`)
          if (!proc.skill_resource_id) {
            throw new Error(`Process ${opts.processId} has no skill_resource_id — use --skill-id to specify the skill resource directly`)
          }
          entityId = proc.skill_resource_id
        }

        if (!entityId) {
          throw new Error('--process-id or --skill-id is required')
        }

        await getUnscopedAdapter().recordMetricSnapshot(entityId, opts.key, numValue, metadata)
        console.log('recorded')
      } catch (err) {
        logger.error(err instanceof Error ? err.message : String(err))
        process.exitCode = 1
      }
    })

  // metric latest
  cmd
    .command('latest')
    .description('Get latest metric snapshot(s) by key (global)')
    .requiredOption('--key <key>', 'Metric key')
    .option('--json', 'Output as JSON')
    .action(async (opts: { key: string; json?: boolean }) => {
      try {
        const adapter = getUnscopedAdapter()
        const items = await adapter.metricsLatestByKey(opts.key)

        if (opts.json) {
          console.log(JSON.stringify(items, null, 2))
          return
        }
        if (items.length === 0) {
          console.log('No metrics found.')
          return
        }
        for (const s of items) {
          console.log(`${s.metricKey}: ${s.value} (${s.measuredAt})`)
        }
      } catch (err) {
        logger.error(err instanceof Error ? err.message : String(err))
        process.exitCode = 1
      }
    })

  // metric history
  cmd
    .command('history')
    .description('Get metric history by key (global)')
    .requiredOption('--key <key>', 'Metric key')
    .option('--days <number>', 'Number of days of history', '30')
    .option('--json', 'Output as JSON')
    .action(async (opts: { key: string; days: string; json?: boolean }) => {
      const days = Number(opts.days)
      if (!Number.isFinite(days) || days <= 0) {
        logger.error(`invalid days: "${opts.days}" must be a positive number`)
        process.exitCode = 1
        return
      }
      try {
        const adapter = getUnscopedAdapter()
        const items = await adapter.metricsHistoryByKey(opts.key, days)

        if (opts.json) {
          console.log(JSON.stringify(items, null, 2))
          return
        }
        if (items.length === 0) {
          console.log('No history found.')
          return
        }
        for (const s of items) {
          console.log(`${s.measuredAt}: ${s.value}`)
        }
      } catch (err) {
        logger.error(err instanceof Error ? err.message : String(err))
        process.exitCode = 1
      }
    })

  return cmd
}
