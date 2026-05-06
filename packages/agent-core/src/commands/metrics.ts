import { Command } from 'commander'
import { getAdapter } from '../lib/adapter-factory.js'
import { createLogger } from '@skill-networks/logger'

const logger = createLogger('agent-core')

export const DEFAULT_HISTORY_DAYS = 30

// UUID v4 regex validation helper (inline, no external library)
function isValidUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
}

export function metricsCommand(): Command {
  const metrics = new Command('metrics').description('Manage metric snapshots')

  // metrics record
  metrics
    .command('record')
    .description('Record a metric snapshot')
    .requiredOption('--skill-id <uuid>', 'Skill resource UUID')
    .requiredOption('--key <key>', 'Metric key')
    .requiredOption('--value <number>', 'Metric value')
    .option('--metadata <json>', 'JSON metadata object', '{}')
    .option('--measured-at <iso>', 'ISO timestamp (defaults to now)')
    .action(async (opts: { skillId: string; key: string; value: string; metadata: string; measuredAt?: string }) => {
      // Validate UUID
      if (!isValidUuid(opts.skillId)) {
        logger.error(`invalid skill-id: "${opts.skillId}" is not a valid UUID`)
        process.exitCode = 1
        return
      }
      // Validate key format
      if (!/^[a-zA-Z0-9_.-]{1,128}$/.test(opts.key)) {
        logger.error(`invalid key: must be 1-128 characters (alphanumeric, underscore, dot, or dash)`)
        process.exitCode = 1
        return
      }
      // Validate value is a finite number
      const numValue = Number(opts.value)
      if (!Number.isFinite(numValue)) {
        logger.error(`invalid value: "${opts.value}" is not a finite number`)
        process.exitCode = 1
        return
      }
      // Parse metadata and validate it is a plain object
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
        const adapter = getAdapter()
        await adapter.recordMetricSnapshot(
          opts.skillId,
          opts.key,
          numValue,
          metadata,
          opts.measuredAt
        )
        console.log('recorded')
      } catch (err) {
        logger.error(err instanceof Error ? err.message : String(err))
        process.exitCode = 1
      }
    })

  // metrics latest
  metrics
    .command('latest')
    .description('Get latest metric snapshot per key for a skill')
    .requiredOption('--skill-id <uuid>', 'Skill resource UUID')
    .option('--json', 'Output as JSON')
    .action(async (opts: { skillId: string; json?: boolean }) => {
      if (!isValidUuid(opts.skillId)) {
        logger.error(`invalid skill-id: "${opts.skillId}" is not a valid UUID`)
        process.exitCode = 1
        return
      }
      try {
        const snapshots = await getAdapter().getLatestMetrics(opts.skillId)
        if (opts.json) {
          console.log(JSON.stringify(snapshots, null, 2))
          return
        }
        if (snapshots.length === 0) {
          console.log('No metrics found.')
          return
        }
        console.log(`${'KEY'.padEnd(30)} ${'VALUE'.padEnd(15)} MEASURED_AT`)
        console.log('─'.repeat(70))
        for (const s of snapshots) {
          console.log(`${s.metricKey.padEnd(30)} ${s.value.padEnd(15)} ${s.measuredAt}`)
        }
      } catch (err) {
        logger.error(err instanceof Error ? err.message : String(err))
        process.exitCode = 1
      }
    })

  // metrics history
  metrics
    .command('history')
    .description('Get metric history for a skill and key')
    .requiredOption('--skill-id <uuid>', 'Skill resource UUID')
    .requiredOption('--key <key>', 'Metric key')
    .option('--days <number>', 'Number of days of history', String(DEFAULT_HISTORY_DAYS))
    .option('--json', 'Output as JSON')
    .action(async (opts: { skillId: string; key: string; days: string; json?: boolean }) => {
      if (!isValidUuid(opts.skillId)) {
        logger.error(`invalid skill-id: "${opts.skillId}" is not a valid UUID`)
        process.exitCode = 1
        return
      }
      const days = Number(opts.days)
      if (!Number.isFinite(days) || days <= 0) {
        logger.error(`invalid days: "${opts.days}" must be a positive number`)
        process.exitCode = 1
        return
      }
      try {
        const snapshots = await getAdapter().getMetricHistory(opts.skillId, opts.key, days)
        if (opts.json) {
          console.log(JSON.stringify(snapshots, null, 2))
          return
        }
        if (snapshots.length === 0) {
          console.log('No history found.')
          return
        }
        console.log(`${'MEASURED_AT'.padEnd(30)} VALUE`)
        console.log('─'.repeat(50))
        for (const s of snapshots) {
          console.log(`${s.measuredAt.padEnd(30)} ${s.value}`)
        }
      } catch (err) {
        logger.error(err instanceof Error ? err.message : String(err))
        process.exitCode = 1
      }
    })

  return metrics
}
