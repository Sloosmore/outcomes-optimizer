import { Command } from 'commander'
import { getAdapter } from '../lib/adapter-factory.js'
import { createLogger } from '@skill-networks/logger'

const logger = createLogger('agent-core')

export function resourceTypeShowCommand(): Command {
  const group = new Command('resource-type')
    .description('Manage resource types')

  group.addCommand(
    new Command('list')
      .description('List all resource types')
      .option('--json', 'Output as JSON')
      .action(async (opts: { json?: boolean }) => {
        try {
          const types = await getAdapter().getResourceTypes()
          if (types.length === 0) {
            console.log('No resource types found.')
            return
          }
          if (opts.json) {
            console.log(JSON.stringify(types, null, 2))
            return
          }
          console.log(`${'NAME'.padEnd(15)} ${'DESCRIPTION'.padEnd(55)} COUNT`)
          console.log('─'.repeat(80))
          for (const t of types) {
            const count = t.count !== undefined ? String(t.count) : '-'
            console.log(`${t.name.padEnd(15)} ${(t.description ?? '').padEnd(55)} ${count}`)
          }
        } catch (e) {
          logger.error(`Error: ${e instanceof Error ? e.message : e}`)
          process.exitCode = 1
        }
      })
  )

  group.addCommand(
    new Command('show')
      .description('Show a resource type with its properties and link rules')
      .argument('<type>', 'Resource type name')
      .action(async (type: string) => {
        try {
          const adapter = getAdapter()
          const allTypes = await adapter.getResourceTypes()
          const found = allTypes.find(t => t.name === type)
          if (!found) {
            logger.error(`Resource type not found: ${type}`)
            process.exitCode = 1
            return
          }

          const properties = await adapter.getResourceTypeProperties(type)
          const linkRules = await adapter.getLinkTypeRulesWithCardinality({ fromType: type })

          console.log(`[ACTIVE] resource-type/${type}`)

          console.log('  Properties:')
          if (properties.length === 0) {
            console.log('    (none)')
          } else {
            for (const p of properties) {
              const vtName = p.value_type_name ?? '(untyped)'
              const req = p.required ? 'required' : 'optional'
              console.log(`    ${p.field_name}  ${vtName}  ${req}`)
            }
          }

          console.log('  Link Rules:')
          if (linkRules.length === 0) {
            console.log('    (none)')
          } else {
            for (const r of linkRules) {
              const from = r.from_type ?? '(any)'
              const to = r.to_type ?? '(any)'
              const max = r.max_count === null ? 'unlimited' : String(r.max_count)
              console.log(`    ${r.link_type}  ${from} \u2192 ${to}  min:${r.min_count} max:${max}`)
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
