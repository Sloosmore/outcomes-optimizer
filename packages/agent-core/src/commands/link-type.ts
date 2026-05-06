import { Command } from 'commander'
import { getAdapter } from '../lib/adapter-factory.js'
import { createLogger } from '@skill-networks/logger'

const logger = createLogger('agent-core')

export function linkTypeCommand(): Command {
  const group = new Command('link-type')
    .description('Manage link types')

  group.addCommand(
    new Command('list')
      .description('List all link types')
      .action(async () => {
        try {
          const types = await getAdapter().getLinkTypes()
          if (types.length === 0) {
            console.log('No link types found.')
            return
          }
          console.log(`${'NAME'.padEnd(15)} ${'DESCRIPTION'.padEnd(47)} CARDINALITY`)
          console.log('─'.repeat(75))
          for (const t of types) {
            console.log(`${t.name.padEnd(15)} ${t.description.padEnd(47)} ${t.cardinality}`)
          }
        } catch (e) {
          logger.error(`Error: ${e instanceof Error ? e.message : e}`)
          process.exitCode = 1
        }
      })
  )

  group.addCommand(
    new Command('show')
      .description('Show a link type and its rules')
      .argument('<name>', 'Link type name')
      .action(async (name: string) => {
        try {
          const adapter = getAdapter()
          const linkType = await adapter.getLinkType(name)
          if (!linkType) {
            logger.error(`Link type not found: ${name}`)
            process.exitCode = 1
            return
          }
          const rules = await adapter.getLinkTypeRules({ linkType: name })
          console.log(`[ACTIVE] link-type/${linkType.name}`)
          console.log(`  Description: ${linkType.description}`)
          console.log(`  Cardinality: ${linkType.cardinality}`)
          console.log(`  Rules:`)
          if (rules.length === 0) {
            console.log(`    (none)`)
          } else {
            for (const r of rules) {
              const from = r.from_type ?? '(any)'
              const to = r.to_type ?? '(any)'
              console.log(`    ${from} → ${to}`)
            }
          }
        } catch (e) {
          logger.error(`Error: ${e instanceof Error ? e.message : e}`)
          process.exitCode = 1
        }
      })
  )

  return group
}

export function linkTypeRuleCommand(): Command {
  const group = new Command('link-type-rule')
    .description('Manage link type rules')

  group.addCommand(
    new Command('list')
      .description('List link type rules')
      .option('--link-type <name>', 'Filter by link type')
      .action(async (opts: { linkType?: string }) => {
        try {
          const rules = opts.linkType
            ? await getAdapter().getLinkTypeRules({ linkType: opts.linkType })
            : await getAdapter().getLinkTypeRules()
          if (rules.length === 0) {
            console.log('No link type rules found.')
            return
          }
          console.log(`${'LINK_TYPE'.padEnd(15)} ${'FROM_TYPE'.padEnd(15)} TO_TYPE`)
          console.log('─'.repeat(45))
          for (const r of rules) {
            const from = r.from_type ?? '(any)'
            const to = r.to_type ?? '(any)'
            console.log(`${r.link_type.padEnd(15)} ${from.padEnd(15)} ${to}`)
          }
        } catch (e) {
          logger.error(`Error: ${e instanceof Error ? e.message : e}`)
          process.exitCode = 1
        }
      })
  )

  return group
}
