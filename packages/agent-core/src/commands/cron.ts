import { Command } from 'commander'
import { CronExpressionParser } from 'cron-parser'
import { getAdapter } from '../lib/adapter-factory.js'
import { OntologyError, OntologyErrorCode } from '../lib/ontology-error.js'
import { createLogger } from '@skill-networks/logger'

const logger = createLogger('agent-core')

function validateCronExpression(expression: string): void {
  // Must have exactly 5 space-separated fields
  const parts = expression.trim().split(/\s+/)
  if (parts.length !== 5) {
    throw new OntologyError(
      OntologyErrorCode.INVALID_CRON_EXPRESSION,
      `invalid cron expression: expected 5 fields, got ${parts.length}`
    )
  }
  // Use cron-parser for full validation (value ranges, etc.)
  try {
    CronExpressionParser.parse(expression)
  } catch (e: unknown) {
    throw new OntologyError(
      OntologyErrorCode.INVALID_CRON_EXPRESSION,
      `invalid cron expression: ${e instanceof Error ? e.message : String(e)}`
    )
  }
}

export function cronCommand(): Command {
  const cron = new Command('cron').description('Manage cron schedules')

  cron
    .command('create')
    .description('Create a new cron schedule')
    .requiredOption('--name <name>', 'Cron name')
    .requiredOption('--schedule <expression>', 'Cron expression (5 fields, UTC)')
    .requiredOption('--skill <skill>', 'Skill resource name')
    .requiredOption('--prompt <text>', 'Prompt to run on schedule')
    .action(async (opts: { name: string; schedule: string; skill: string; prompt: string }) => {
      try {
        validateCronExpression(opts.schedule)
      } catch (err) {
        logger.error(err instanceof Error ? err.message : String(err))
        process.exitCode = 1
        return
      }

      try {
        const adapter = getAdapter()

        // Resolve skill
        const skillResource = await adapter.getResource(opts.skill)
        if (!skillResource) {
          logger.error(`skill resource not found: ${opts.skill}`)
          process.exitCode = 1
          return
        }
        if (skillResource.type !== 'skill') {
          logger.error(`must be type skill, got ${skillResource.type}`)
          process.exitCode = 1
          return
        }

        // Create cron resource
        const resource = await adapter.addResource(
          opts.name,
          'cron',
          { schedule: opts.schedule, enabled: true, prompt: opts.prompt }
        )

        // Create schedules link — clean up the cron resource if linking fails
        try {
          await adapter.createResourceLink(opts.name, opts.skill, 'schedules')
        } catch (linkErr) {
          await adapter.removeResource(opts.name)
          throw linkErr
        }

        console.log(resource.id)
      } catch (err) {
        logger.error(err instanceof Error ? err.message : String(err))
        process.exitCode = 1
      }
    })

  cron
    .command('list')
    .description('List cron schedules')
    .option('--json', 'Output as JSON')
    .action(async (opts: { json?: boolean }) => {
      try {
        const crons = await getAdapter().listCronsWithDetails()

        if (opts.json) {
          console.log(JSON.stringify(crons.map(c => ({
            name: c.name,
            schedule: c.schedule,
            enabled: c.enabled,
            skillId: c.skillId,
            skillName: c.skillName,
            createdAt: c.createdAt,
          })), null, 2))
          return
        }

        if (crons.length === 0) {
          console.log('No cron schedules found.')
          return
        }

        console.log(`${'NAME'.padEnd(20)} ${'SCHEDULE'.padEnd(15)} ${'ENABLED'.padEnd(8)} SKILL`)
        console.log('─'.repeat(65))
        for (const c of crons) {
          const enabledStr = c.enabled ? 'yes' : 'no'
          const skillStr = c.skillName ?? '(no skill)'
          console.log(`${c.name.padEnd(20)} ${c.schedule.padEnd(15)} ${enabledStr.padEnd(8)} ${skillStr}`)
        }
      } catch (err) {
        logger.error(err instanceof Error ? err.message : String(err))
        process.exitCode = 1
      }
    })

  cron
    .command('disable')
    .description('Disable a cron schedule')
    .requiredOption('--name <name>', 'Cron name')
    .action(async (opts: { name: string }) => {
      try {
        const adapter = getAdapter()
        const resource = await adapter.getResource(opts.name)
        if (!resource) {
          logger.error(`cron not found: ${opts.name}`)
          process.exitCode = 1
          return
        }
        if (resource.type !== 'cron') {
          logger.error(`resource "${opts.name}" is type "${resource.type}", not cron`)
          process.exitCode = 1
          return
        }
        await adapter.updateResource(resource.id, { config: { ...resource.config, enabled: false } })
        console.log(`disabled ${opts.name}`)
      } catch (err) {
        logger.error(err instanceof Error ? err.message : String(err))
        process.exitCode = 1
      }
    })

  cron
    .command('enable')
    .description('Enable a cron schedule')
    .requiredOption('--name <name>', 'Cron name')
    .action(async (opts: { name: string }) => {
      try {
        const adapter = getAdapter()
        const resource = await adapter.getResource(opts.name)
        if (!resource) {
          logger.error(`cron not found: ${opts.name}`)
          process.exitCode = 1
          return
        }
        if (resource.type !== 'cron') {
          logger.error(`resource "${opts.name}" is type "${resource.type}", not cron`)
          process.exitCode = 1
          return
        }
        await adapter.updateResource(resource.id, { config: { ...resource.config, enabled: true } })
        console.log(`enabled ${opts.name}`)
      } catch (err) {
        logger.error(err instanceof Error ? err.message : String(err))
        process.exitCode = 1
      }
    })

  cron
    .command('remove')
    .description('Remove a cron schedule')
    .requiredOption('--name <name>', 'Cron name')
    .action(async (opts: { name: string }) => {
      try {
        const adapter = getAdapter()
        const resource = await adapter.getResource(opts.name)
        if (!resource) {
          logger.error(`cron not found: ${opts.name}`)
          process.exitCode = 1
          return
        }
        if (resource.type !== 'cron') {
          logger.error(`resource "${opts.name}" is type "${resource.type}", not cron`)
          process.exitCode = 1
          return
        }
        await adapter.removeResource(opts.name)
        console.log(`removed ${opts.name}`)
      } catch (err) {
        logger.error(err instanceof Error ? err.message : String(err))
        process.exitCode = 1
      }
    })

  return cron
}
