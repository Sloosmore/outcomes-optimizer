import { Command } from 'commander'
import { getAdapter } from '../lib/adapter-factory.js'
import { renderResource } from '../lib/render.js'
import { createLogger } from '@skill-networks/logger'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const logger = createLogger('agent-core')

export function showCommand(): Command {
  return new Command('show')
    .description('Show any resource by name or UUID (type-agnostic)')
    .argument('[name]', 'Resource name')
    .option('--id <uuid>', 'Resource UUID (alternative to name argument)')
    .option('--json', 'Output as JSON')
    .action(async (name, opts) => {
      if (!name && !opts.id) {
        logger.error('Provide a resource name or --id <uuid>')
        process.exitCode = 1
        return
      }
      if (opts.id && !UUID_RE.test(opts.id)) {
        logger.error('--id must be a valid UUID')
        process.exitCode = 1
        return
      }
      const resource = opts.id
        ? await getAdapter().getResourceById(opts.id)
        : await getAdapter().getResource(name)
      if (!resource) {
        logger.error(`Resource not found: ${opts.id ?? name}`)
        process.exitCode = 1
        return
      }
      if (opts.json) {
        // Inject ok:true into existing object for backward compat.
        // dispatch.ts reads parsed.name, parsed.config — both fields are preserved.
        console.log(JSON.stringify({ ok: true, ...resource }, null, 2))
      } else {
        renderResource(resource, false)
      }
    })
}
