import { Command } from 'commander'
import { getAdapter } from '../lib/adapter-factory.js'
import { createLogger } from '@skill-networks/logger'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const logger = createLogger('agent-core')

export function linkCommand(): Command {
  return new Command('link')
    .description('Create a link between two resources')
    .argument('[from]', 'Source resource name')
    .argument('[to]', 'Target resource name')
    .option('--type <link-type>', 'Link type', 'parent')
    .option('--from-id <uuid>', 'Source resource UUID (use instead of name)')
    .option('--to-id <uuid>', 'Target resource UUID (use instead of name)')
    .action(async (from, to, opts) => {
      try {
        const fromId: string | undefined = opts.fromId
        const toId: string | undefined = opts.toId
        if (fromId && !UUID_RE.test(fromId)) { logger.error('--from-id must be a valid UUID'); process.exitCode = 1; return }
        if (toId && !UUID_RE.test(toId)) { logger.error('--to-id must be a valid UUID'); process.exitCode = 1; return }
        if (fromId && toId) {
          const { created } = await getAdapter().createResourceLinkById(fromId, toId, opts.type)
          if (created) console.log(`linked ${fromId} → ${toId} (type: ${opts.type})`)
          else console.log(`link already exists: ${fromId} → ${toId} (type: ${opts.type})`)
        } else {
          if (!from || !to) {
            logger.error('Error: must provide either <from> <to> name arguments or --from-id and --to-id options')
            process.exitCode = 1
            return
          }
          const { created } = await getAdapter().createResourceLink(from, to, opts.type)
          if (created) console.log(`linked ${from} → ${to} (type: ${opts.type})`)
          else console.log(`link already exists: ${from} → ${to} (type: ${opts.type})`)
        }
      } catch (e) {
        logger.error(`Error: ${e instanceof Error ? e.message : e}`)
        process.exitCode = 1
      }
    })
}

export function unlinkCommand(): Command {
  return new Command('unlink')
    .description('Remove a link between two resources')
    .argument('[from]', 'Source resource name')
    .argument('[to]', 'Target resource name')
    .requiredOption('--type <link-type>', 'Link type (required to prevent accidental deletion)')
    .option('--from-id <uuid>', 'Source resource UUID (use instead of name)')
    .option('--to-id <uuid>', 'Target resource UUID (use instead of name)')
    .action(async (from, to, opts) => {
      try {
        const fromId: string | undefined = opts.fromId
        const toId: string | undefined = opts.toId
        if (fromId && !UUID_RE.test(fromId)) { logger.error('--from-id must be a valid UUID'); process.exitCode = 1; return }
        if (toId && !UUID_RE.test(toId)) { logger.error('--to-id must be a valid UUID'); process.exitCode = 1; return }
        if (fromId && toId) {
          try {
            await getAdapter().deleteResourceLinkById(fromId, toId, opts.type)
            console.log(`unlinked ${fromId} → ${toId} (type: ${opts.type})`)
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            if (msg.startsWith('Link not found:')) {
              console.log(`link not found (already unlinked): ${fromId} → ${toId} (type: ${opts.type})`)
            } else {
              throw e
            }
          }
        } else {
          if (!from || !to) {
            logger.error('Error: must provide either <from> <to> name arguments or --from-id and --to-id options')
            process.exitCode = 1
            return
          }
          try {
            await getAdapter().deleteResourceLink(from, to, opts.type)
            console.log(`unlinked ${from} → ${to} (type: ${opts.type})`)
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            if (msg.startsWith('Link not found:')) {
              // Idempotent: unlinking a non-existent link is a no-op
              console.log(`link not found (already unlinked): ${from} → ${to} (type: ${opts.type})`)
            } else {
              throw e
            }
          }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        logger.error(`Error: ${msg}`)
        process.exitCode = 1
      }
    })
}
