import { Command } from 'commander'
import { getAdapter } from '../lib/adapter-factory.js'
import { renderResource, renderResources } from '../lib/render.js'
import { createLogger } from '@skill-networks/logger'

const logger = createLogger('agent-core')

export function typeGroupCommand(typeName: string, finite: boolean): Command {
  const group = new Command(typeName)
    .description(`Manage ${typeName} resources`)

  // list
  group.command('list')
    .description(`List all ${typeName} resources`)
    .option('--status <status>', 'Filter by status')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      try {
        const rows = await getAdapter().listResources({ type: typeName, status: opts.status })
        renderResources(rows, opts.json)
      } catch (e) {
        logger.error(`Error: ${e instanceof Error ? e.message : e}`)
        process.exitCode = 1
      }
    })

  // search
  group.command('search')
    .description(`Search ${typeName} resources`)
    .argument('<query>', 'Search query')
    .option('--json', 'Output as JSON')
    .action(async (query, opts) => {
      try {
        const rows = await getAdapter().searchResources(query, { type: typeName })
        renderResources(rows, opts.json)
      } catch (e) {
        logger.error(`Error: ${e instanceof Error ? e.message : e}`)
        process.exitCode = 1
      }
    })

  // create
  group.command('create')
    .description(`Create a new ${typeName} resource`)
    .requiredOption('--name <name>', 'Resource name')
    .option('--config <json>', 'Config JSON string', '{}')
    .option('--notes <text>', 'Free-text notes')
    .option('--status <status>', 'Initial status', 'active')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      let config: Record<string, unknown>
      try {
        config = JSON.parse(opts.config)
      } catch {
        logger.error(`Error: invalid JSON for --config: ${opts.config}`)
        process.exitCode = 1
        return
      }
      try {
        const resource = await getAdapter().addResource(opts.name, typeName, config, opts.notes, opts.status)
        renderResource(resource, opts.json)
      } catch (e) {
        logger.error(`Error: ${e instanceof Error ? e.message : e}`)
        process.exitCode = 1
      }
    })

  // show
  group.command('show')
    .description(`Show a ${typeName} resource by name`)
    .argument('<name>', 'Resource name')
    .option('--json', 'Output as JSON')
    .action(async (name, opts) => {
      try {
        const resource = await getAdapter().getResource(name)
        if (!resource) {
          logger.error(`Resource not found: ${name}`)
          process.exitCode = 1
          return
        }
        if (resource.type !== typeName) {
          logger.error(`Resource "${name}" is type "${resource.type}", not "${typeName}"`)
          process.exitCode = 1
          return
        }
        renderResource(resource, opts.json)
      } catch (e) {
        logger.error(`Error: ${e instanceof Error ? e.message : e}`)
        process.exitCode = 1
      }
    })

  if (finite) {
    // available
    group.command('available')
      .description(`List available (unlocked) ${typeName} resources`)
      .option('--json', 'Output as JSON')
      .action(async (opts) => {
        try {
          const rows = await getAdapter().getAvailableResources(typeName)
          renderResources(rows, opts.json)
        } catch (e) {
          logger.error(`Error: ${e instanceof Error ? e.message : e}`)
          process.exitCode = 1
        }
      })

    // checkout
    group.command('checkout')
      .description(`Exclusively checkout a ${typeName} resource`)
      .argument('<name>', 'Resource name')
      .requiredOption('--locker <id>', 'Locker ID (workflow run ID or process ID)')
      .option('--json', 'Output as JSON')
      .action(async (name, opts) => {
        try {
          const resource = await getAdapter().checkoutResource(name, opts.locker)
          renderResource(resource, opts.json)
        } catch (e) {
          logger.error(`Error: ${e instanceof Error ? e.message : e}`)
          process.exitCode = 1
        }
      })

    // release
    group.command('release')
      .description(`Release a ${typeName} resource`)
      .argument('<name>', 'Resource name')
      .requiredOption('--locker <id>', 'Locker ID')
      .option('--json', 'Output as JSON')
      .action(async (name, opts) => {
        try {
          const resource = await getAdapter().releaseResource(name, opts.locker)
          renderResource(resource, opts.json)
        } catch (e) {
          logger.error(`Error: ${e instanceof Error ? e.message : e}`)
          process.exitCode = 1
        }
      })
  } else {
    // Non-finite types: add checkout/release as stubs that fail
    group.command('checkout')
      .description('(not available — type is not finite)')
      .argument('[name]', 'Resource name')
      .option('--locker <id>', 'Locker ID')
      .action(async () => {
        logger.error(`Error: ${typeName} resources are not finite and cannot be checked out`)
        process.exitCode = 1
      })

    group.command('release')
      .description('(not available — type is not finite)')
      .argument('[name]', 'Resource name')
      .option('--locker <id>', 'Locker ID')
      .action(async () => {
        logger.error(`Error: ${typeName} resources are not finite and cannot be released`)
        process.exitCode = 1
      })
  }

  return group
}
