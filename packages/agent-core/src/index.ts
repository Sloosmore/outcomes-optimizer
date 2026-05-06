import { Command } from 'commander'
import { getAdapter } from './lib/adapter-factory.js'
import { typesCommand } from './commands/types.js'
import { showCommand } from './commands/show.js'
import { searchCommand } from './commands/search.js'
import { typeGroupCommand } from './commands/type-group.js'
import { resourceCommand } from './commands/resource.js'
import { linkCommand, unlinkCommand } from './commands/link.js'
import { linkTypeCommand, linkTypeRuleCommand } from './commands/link-type.js'
import { valueTypeCommand } from './commands/value-type.js'
import { resourceTypeShowCommand } from './commands/resource-type.js'
import { processCommand } from './commands/process.js'
import { cronCommand } from './commands/cron.js'
import { metricsCommand } from './commands/metrics.js'
import { metricCommand } from './commands/metric.js'
import { actionCommand } from './commands/action.js'
import { traverseCommand } from './commands/traverse.js'
import { executeCommand } from './commands/execute.js'

export { initAdapter, getAdapter, getUnscopedAdapter } from './lib/adapter-factory.js'
export { outputError, classifyExitCode } from './lib/output.js'
export { readLocalToken, parseJwtSub } from './lib/identity.js'

export async function registerCommands(program: Command): Promise<void> {
  // Top-level commands
  program.addCommand(typesCommand())
  program.addCommand(showCommand())
  program.addCommand(searchCommand())
  program.addCommand(resourceCommand())
  program.addCommand(linkCommand())
  program.addCommand(unlinkCommand())
  program.addCommand(linkTypeCommand())
  program.addCommand(linkTypeRuleCommand())
  program.addCommand(valueTypeCommand())
  program.addCommand(resourceTypeShowCommand())
  program.addCommand(processCommand())
  program.addCommand(cronCommand())
  program.addCommand(metricsCommand())
  program.addCommand(metricCommand())
  program.addCommand(actionCommand())
  program.addCommand(traverseCommand())
  program.addCommand(executeCommand())

  // Dynamic type-based subcommands — fetched from DB at startup.
  // Failure is non-fatal so static commands (--help, types, show, search) still work.
  const types = await Promise.resolve()
    .then(() => getAdapter().getResourceTypes())
    .catch(e => {
      if (process.env.DUOIDAL_DEBUG) {
        process.stderr.write(JSON.stringify({
          level: 'warn',
          code: 'DYNAMIC_TYPES_UNAVAILABLE',
          message: e instanceof Error ? e.message : String(e)
        }) + '\n')
      }
      return []
    })

  // Types with dedicated commands are excluded from the generic type-group loop
  const dedicatedCommands = new Set(['cron'])
  for (const t of types) {
    if (dedicatedCommands.has(t.name)) continue
    program.addCommand(typeGroupCommand(t.name, t.finite))
  }
}
