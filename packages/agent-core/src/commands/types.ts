import { Command } from 'commander'
import { getUnscopedAdapter } from '../lib/adapter-factory.js'
import { renderResourceTypes } from '../lib/render.js'

export function typesCommand(): Command {
  return new Command('types')
    .description('List all resource types with finite flag and counts')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      const types = await getUnscopedAdapter().getResourceTypes()
      renderResourceTypes(types, opts.json)
    })
}
