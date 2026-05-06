import { Command } from 'commander'
import { getAdapter } from '../lib/adapter-factory.js'
import { renderResources } from '../lib/render.js'

export function searchCommand(): Command {
  return new Command('search')
    .description('Search across all or one type')
    .argument('<query>', 'Search query')
    .option('--type <type>', 'Filter by type')
    .option('--json', 'Output as JSON')
    .action(async (query, opts) => {
      const results = await getAdapter().searchResources(query, { type: opts.type })
      renderResources(results, opts.json)
    })
}
