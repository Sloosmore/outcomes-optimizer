import { Command } from 'commander'
import { getAdapter } from '../lib/adapter-factory.js'
import { createLogger } from '@skill-networks/logger'

const logger = createLogger('agent-core')

export function valueTypeCommand(): Command {
  const group = new Command('value-type')
    .description('Manage value types')

  group.addCommand(
    new Command('list')
      .description('List all value types')
      .action(async () => {
        try {
          const types = await getAdapter().getValueTypes()
          if (types.length === 0) {
            console.log('No value types found.')
            return
          }
          console.log(`${'NAME'.padEnd(20)} ${'BASE_TYPE'.padEnd(12)} CONSTRAINTS`)
          console.log('─'.repeat(80))
          for (const t of types) {
            const constraints = JSON.stringify(t.constraints)
            console.log(`${t.name.padEnd(20)} ${t.base_type.padEnd(12)} ${constraints}`)
          }
        } catch (e) {
          logger.error(`Error: ${e instanceof Error ? e.message : e}`)
          process.exitCode = 1
        }
      })
  )

  return group
}
