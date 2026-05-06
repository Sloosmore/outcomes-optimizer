import { Command } from 'commander'
import { getAdapter } from '../lib/adapter-factory.js'
import type { ValueType } from '@skill-networks/database'
import { createLogger } from '@skill-networks/logger'
import { setupPostgresLogger } from '../lib/postgres-log-drain.js'
import { classifyExitCode } from '../lib/output.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const logger = createLogger('agent-core')

function setupLogger(): void {
  setupPostgresLogger()
}

// Constraint type definitions
interface RangeConstraint { type: 'range'; min?: number; max?: number }
interface RegexConstraint { type: 'regex'; pattern: string }
interface UuidConstraint { type: 'uuid' }
interface EnumConstraint { type: 'enum'; values: unknown[] }
type Constraint = RangeConstraint | RegexConstraint | UuidConstraint | EnumConstraint

function validateValue(value: unknown, valueType: ValueType): string | null {
  const base = valueType.base_type
  const constraints = (valueType.constraints ?? []) as Constraint[]

  // Type check
  if (base === 'integer') {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      return `expected integer, got ${typeof value}`
    }
  } else if (base === 'string') {
    if (typeof value !== 'string') {
      return `expected string, got ${typeof value}`
    }
  }

  // Constraint checks
  for (const c of constraints) {
    if (c.type === 'range') {
      if (base === 'string' && typeof value === 'string') {
        if (c.min !== undefined && value.length < c.min) {
          return `string length ${value.length} < min ${c.min}`
        }
        if (c.max !== undefined && value.length > c.max) {
          return `string length ${value.length} > max ${c.max}`
        }
      } else if (base === 'integer' && typeof value === 'number') {
        if (c.min !== undefined && value < c.min) {
          return `value ${value} < min ${c.min}`
        }
        if (c.max !== undefined && value > c.max) {
          return `value ${value} > max ${c.max}`
        }
      }
    } else if (c.type === 'regex') {
      if (typeof value === 'string') {
        let re: RegExp
        try {
          re = new RegExp(c.pattern)
        } catch {
          return `invalid regex pattern: ${c.pattern}`
        }
        if (!re.test(value)) {
          return `does not match pattern ${c.pattern}`
        }
      }
    } else if (c.type === 'uuid') {
      if (typeof value === 'string') {
        const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
        if (!uuidRe.test(value)) {
          return `not a valid UUID`
        }
      }
    } else if (c.type === 'enum') {
      if (!c.values.includes(value)) {
        return `"${String(value)}" not in allowed values`
      }
    }
  }
  return null
}

export function resourceCommand(): Command {
  const resource = new Command('resource').description('Manage resources')

  resource
    .command('add')
    .description('Add a new resource')
    .requiredOption('--name <name>', 'Resource name')
    .requiredOption('--type <type>', 'Resource type')
    .option('--config <json>', 'JSON config object')
    .option('--notes <text>', 'Notes')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      let config: Record<string, unknown> | undefined
      if (opts.config) {
        try {
          config = JSON.parse(opts.config) as Record<string, unknown>
        } catch {
          logger.error('Invalid JSON for --config')
          process.exitCode = 1
          return
        }
      }
      try {
        const resource = await getAdapter().addResource(opts.name, opts.type, config, opts.notes)
        if (opts.json) {
          console.log(JSON.stringify({ ok: true, data: { ...resource, created: true } }, null, 2))
        } else {
          // Print ID on its own line so scripts can capture with $()
          console.log(resource.id)
        }
      } catch (err) {
        // Idempotent: if the resource already exists, return its existing record
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes('already exists') || msg.includes('DUPLICATE_RESOURCE')) {
          const existing = await getAdapter().getResource(opts.name)
          if (existing) {
            if (opts.json) {
              console.log(JSON.stringify({ ok: true, data: { ...existing, created: false } }, null, 2))
            } else {
              console.log(existing.id)
            }
            return
          }
        }
        logger.error(msg)
        process.exitCode = classifyExitCode(err)
      }
    })

  resource
    .command('link')
    .description('Link two resources')
    .option('--from <name>', 'Source resource name')
    .option('--from-id <uuid>', 'Source resource UUID (alternative to --from)')
    .option('--to <name>', 'Target resource name')
    .option('--to-id <uuid>', 'Target resource UUID (alternative to --to)')
    .requiredOption('--type <link_type>', 'Link type')
    .action(async (opts: { from?: string; fromId?: string; to?: string; toId?: string; type: string }) => {
      try {
        const adapter = getAdapter()
        const hasFromId = !!opts.fromId
        const hasToId = !!opts.toId
        const hasFrom = !!opts.from
        const hasTo = !!opts.to

        if (!hasFrom && !hasFromId) {
          logger.error('Error: --from or --from-id is required')
          process.exitCode = 1
          return
        }
        if (!hasTo && !hasToId) {
          logger.error('Error: --to or --to-id is required')
          process.exitCode = 1
          return
        }

        if (hasFromId && hasToId) {
          // Both IDs provided — use ID-based path
          if (!UUID_RE.test(opts.fromId!)) { logger.error('--from-id must be a valid UUID'); process.exitCode = 1; return }
          if (!UUID_RE.test(opts.toId!)) { logger.error('--to-id must be a valid UUID'); process.exitCode = 1; return }
          const { created } = await adapter.createResourceLinkById(opts.fromId!, opts.toId!, opts.type)
          if (created) console.log(`linked ${opts.fromId} → ${opts.toId} (${opts.type})`)
          else console.log(`link already exists: ${opts.fromId} → ${opts.toId} (${opts.type})`)
        } else if (hasFromId && hasTo) {
          // Mixed: resolve to name
          if (!UUID_RE.test(opts.fromId!)) { logger.error('--from-id must be a valid UUID'); process.exitCode = 1; return }
          const fromRes = await adapter.getResourceById(opts.fromId!)
          if (!fromRes) { logger.error(`Resource not found: ${opts.fromId}`); process.exitCode = 1; return }
          const { created } = await adapter.createResourceLink(fromRes.name, opts.to!, opts.type)
          if (created) console.log(`linked ${fromRes.name} → ${opts.to} (${opts.type})`)
          else console.log(`link already exists: ${fromRes.name} → ${opts.to} (${opts.type})`)
        } else if (hasFrom && hasToId) {
          // Mixed: resolve to name
          if (!UUID_RE.test(opts.toId!)) { logger.error('--to-id must be a valid UUID'); process.exitCode = 1; return }
          const toRes = await adapter.getResourceById(opts.toId!)
          if (!toRes) { logger.error(`Resource not found: ${opts.toId}`); process.exitCode = 1; return }
          const { created } = await adapter.createResourceLink(opts.from!, toRes.name, opts.type)
          if (created) console.log(`linked ${opts.from} → ${toRes.name} (${opts.type})`)
          else console.log(`link already exists: ${opts.from} → ${toRes.name} (${opts.type})`)
        } else {
          // Both names provided — use existing name-based path
          const { created } = await adapter.createResourceLink(opts.from!, opts.to!, opts.type)
          if (created) console.log(`linked ${opts.from} → ${opts.to} (${opts.type})`)
          else console.log(`link already exists: ${opts.from} → ${opts.to} (${opts.type})`)
        }
      } catch (err) {
        logger.error(err instanceof Error ? err.message : String(err))
        process.exitCode = 1
      }
    })

  resource
    .command('remove')
    .description('Remove a resource by name or ID')
    .argument('[name]', 'Resource name (positional or use --name)')
    .option('--name <name>', 'Resource name (alternative to positional argument)')
    .option('--id <uuid>', 'Resource UUID (alternative to name argument)')
    .action(async (nameArg: string | undefined, opts: { name?: string; id?: string }) => {
      const name = nameArg ?? opts.name
      const id = opts.id
      if (!name && !id) {
        logger.error('Error: resource name or --id is required')
        process.exitCode = 1
        return
      }
      try {
        const adapter = getAdapter()

        if (id && !name) {
          // ID-based path
          if (!UUID_RE.test(id)) {
            logger.error('--id must be a valid UUID')
            process.exitCode = 1
            return
          }
          const resource = await adapter.getResourceById(id)
          if (!resource) {
            console.log('resource not found (nothing to remove)')
            return
          }
          // If removing a skill, auto-disable any cron resources linked to it
          if (resource.type === 'skill') {
            const links = await adapter.listAllResourceLinks()
            const inboundLinks = links.filter(link => link.to_id === resource.id)
            for (const link of inboundLinks) {
              const fromResource = await adapter.getResourceById(link.from_id)
              if (fromResource && fromResource.type === 'cron') {
                await adapter.updateResource(fromResource.id, {
                  config: { ...fromResource.config, enabled: false },
                })
              }
            }
          }
          await adapter.removeResourceById(id)
          console.log(`removed ${resource.name}`)
          return
        }

        // Name-based path
        // If removing a skill, auto-disable any cron resources linked to it
        const resource = await adapter.getResource(name!)
        if (resource && resource.type === 'skill') {
          const links = await adapter.listAllResourceLinks()
          const inboundLinks = links.filter(link => link.to_id === resource.id)
          for (const link of inboundLinks) {
            const fromResource = await adapter.getResourceById(link.from_id)
            if (fromResource && fromResource.type === 'cron') {
              await adapter.updateResource(fromResource.id, {
                config: { ...fromResource.config, enabled: false },
              })
            }
          }
        }

        await adapter.removeResource(name!)
        console.log(`removed ${name}`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        // Idempotent: if the resource doesn't exist, treat as already removed
        const isNotFound = (err as { code?: string }).code === 'RESOURCE_NOT_FOUND'
          || msg.includes('Resource not found')
          || msg.toLowerCase().includes('not found')
          || msg.toLowerCase().includes('no rows')
        if (isNotFound) {
          console.log('resource not found (nothing to remove)')
          return
        }
        logger.error(msg)
        process.exitCode = 1
      }
    })

  resource
    .command('get')
    .description('Fetch a resource by name or ID')
    .argument('[name]', 'Resource name')
    .option('--id <uuid>', 'Resource UUID (alternative to name argument)')
    .option('--json', 'Output as JSON')
    .action(async (nameArg: string | undefined, opts: { id?: string; json?: boolean }) => {
      try {
        const adapter = getAdapter()
        let res: Awaited<ReturnType<typeof adapter.getResource>> | undefined

        if (opts.id) {
          if (!UUID_RE.test(opts.id)) {
            logger.error('--id must be a valid UUID')
            process.exitCode = 1
            return
          }
          res = await adapter.getResourceById(opts.id)
        } else if (nameArg) {
          res = await adapter.getResource(nameArg)
        } else {
          logger.error('Error: resource name or --id is required')
          process.exitCode = 1
          return
        }

        if (!res) {
          if (opts.json) {
            process.stderr.write(JSON.stringify({ ok: false, error: { code: 'NOT_FOUND', message: `Resource not found: ${opts.id ?? nameArg}`, retry: false } }) + '\n')
            process.exit(4)
          }
          logger.error(`Resource not found: ${opts.id ?? nameArg}`)
          process.exitCode = 4
          return
        }
        if (opts.json) {
          console.log(JSON.stringify({ ok: true, data: res }, null, 2))
        } else {
          console.log(`ID   : ${res.id}`)
          console.log(`Name : ${res.name}`)
          console.log(`Type : ${res.type}`)
          console.log(`Status: ${res.status}`)
        }
      } catch (err) {
        logger.error(err instanceof Error ? err.message : String(err))
        process.exitCode = classifyExitCode(err)
      }
    })

  resource
    .command('checkout')
    .description('Exclusively checkout a finite resource by ID')
    .requiredOption('--id <uuid>', 'Resource UUID')
    .requiredOption('--locked-by <locker>', 'Locker ID (workflow run ID or process ID)')
    .option('--json', 'Output as JSON')
    .action(async (opts: { id: string; lockedBy: string; json?: boolean }) => {
      try {
        if (!UUID_RE.test(opts.id)) throw new Error('--id must be a valid UUID')
        const adapter = getAdapter()
        const res = await adapter.getResourceById(opts.id)
        if (!res) {
          logger.error(`Resource not found: ${opts.id}`)
          process.exitCode = 1
          return
        }
        const checked = await adapter.checkoutResource(res.name, opts.lockedBy)
        if (opts.json) {
          console.log(JSON.stringify(checked, null, 2))
        } else {
          console.log(`checked out ${res.name} (locked_by: ${checked.locked_by})`)
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.error(`Error: ${msg}`)
        process.exitCode = 1
      }
    })

  resource
    .command('release')
    .description('Release a checked-out resource by ID')
    .requiredOption('--id <uuid>', 'Resource UUID')
    .option('--locked-by <locker>', 'Locker ID (required unless resource tracks locker internally)')
    .option('--json', 'Output as JSON')
    .action(async (opts: { id: string; lockedBy?: string; json?: boolean }) => {
      try {
        if (!UUID_RE.test(opts.id)) throw new Error('--id must be a valid UUID')
        const adapter = getAdapter()
        const res = await adapter.getResourceById(opts.id)
        if (!res) {
          logger.error(`Resource not found: ${opts.id}`)
          process.exitCode = 1
          return
        }
        const lockerId = opts.lockedBy ?? res.locked_by ?? 'unknown'
        const released = await adapter.releaseResource(res.name, lockerId)
        if (opts.json) {
          console.log(JSON.stringify(released, null, 2))
        } else {
          console.log(`released ${res.name}`)
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.error(`Error: ${msg}`)
        process.exitCode = 1
      }
    })

  resource
    .command('validate')
    .description('Validate a resource against ontology rules')
    .argument('<name>', 'Resource name')
    .action(async (name: string) => {
      setupLogger()

      try {
        const adapter = getAdapter()
        const res = await adapter.getResource(name)
        if (!res) {
          logger.error(`Resource not found: ${name}`)
          process.exitCode = 1
          return
        }

        const config = res.config ?? {}
        const type = res.type

        const [properties, linkRules, linkCounts] = await Promise.all([
          adapter.getResourceTypeProperties(type),
          adapter.getLinkTypeRulesWithCardinality({ fromType: type }),
          adapter.getResourceLinkCounts(res.id),
        ])

        const linkCountMap = new Map<string, number>()
        for (const lc of linkCounts) {
          linkCountMap.set(lc.link_type, lc.count)
        }

        const checks: Array<{ pass: boolean; label: string }> = []

        // Check required properties and value type constraints
        for (const prop of properties) {
          const fieldValue = config[prop.field_name]
          const hasValue = fieldValue !== undefined && fieldValue !== null

          if (prop.required && !hasValue) {
            checks.push({ pass: false, label: `${prop.field_name}: missing (required)` })
            continue
          }

          if (hasValue && prop.value_type_name) {
            const valueType = await adapter.getValueTypeByName(prop.value_type_name)
            if (valueType) {
              const err = validateValue(fieldValue, valueType)
              if (err) {
                checks.push({ pass: false, label: `${prop.field_name}: "${String(fieldValue)}" fails constraint: ${err} (${prop.value_type_name})` })
              } else {
                checks.push({ pass: true, label: `${prop.field_name}: "${String(fieldValue)}" (${prop.value_type_name})` })
              }
            } else {
              checks.push({ pass: true, label: `${prop.field_name}: "${String(fieldValue)}" (untyped)` })
            }
          } else if (hasValue) {
            checks.push({ pass: true, label: `${prop.field_name}: "${String(fieldValue)}" (untyped)` })
          }
        }

        // Check link cardinality rules
        for (const rule of linkRules) {
          const actual = linkCountMap.get(rule.link_type) ?? 0
          const maxStr = rule.max_count === null ? 'unlimited' : String(rule.max_count)
          const rangeStr = `${rule.min_count}–${maxStr}`

          const meetsMin = actual >= rule.min_count
          const meetsMax = rule.max_count === null || actual <= rule.max_count

          const qualifier = rule.min_count === 0 ? 'allowed' : 'required'
          const label = `${rule.link_type} link: ${actual} (${qualifier}: ${rangeStr})`

          checks.push({ pass: meetsMin && meetsMax, label })
        }

        const allPass = checks.every(c => c.pass)
        const statusLabel = allPass ? '[VALID]' : '[INVALID]'
        console.log(`${statusLabel} ${name} (${type})`)
        for (const c of checks) {
          console.log(`  ${c.pass ? '✓' : '✗'} ${c.label}`)
        }

        // Log result
        if (allPass) {
          logger.info(`resource validation passed: ${name}`, { resource: name, type })
        } else {
          const failed = checks.filter(c => !c.pass).map(c => c.label)
          logger.warn(`resource validation failed: ${name}`, { resource: name, type, failures: failed })
        }

        // Give logger drains a tick to flush
        await new Promise(resolve => setTimeout(resolve, 100))

        if (!allPass) {
          process.exitCode = 1
        }
      } catch (err) {
        logger.error(err instanceof Error ? err.message : String(err))
        process.exitCode = 1
      }
    })

  resource
    .command('search')
    .description('Search resources by name (substring match)')
    .argument('<query>', 'Substring to search for in resource names')
    .option('--type <type>', 'Filter by resource type')
    .option('--json', 'Output as JSON array')
    .action(async (query: string, opts: { type?: string; json?: boolean }) => {
      try {
        const adapter = getAdapter()
        const results = opts.type ? await adapter.searchResources(query, { type: opts.type }) : await adapter.searchResources(query)
        if (opts.json) {
          console.log(JSON.stringify({ ok: true, data: results }, null, 2))
          return
        }
        if (results.length === 0) {
          console.log('No resources found.')
          return
        }
        for (const r of results) {
          console.log(`${r.id}  ${r.type.padEnd(16)} ${r.name}`)
        }
      } catch (err) {
        logger.error(err instanceof Error ? err.message : String(err))
        process.exitCode = classifyExitCode(err)
      }
    })

  resource
    .command('list')
    .description('List all resources, optionally filtered by type')
    .option('--type <type>', 'Filter by resource type')
    .option('--json', 'Output as JSON array')
    .action(async (opts: { type?: string; json?: boolean }) => {
      try {
        const adapter = getAdapter()
        const results = opts.type ? await adapter.listResources({ type: opts.type }) : await adapter.listResources()
        if (opts.json) {
          console.log(JSON.stringify({ ok: true, data: results }, null, 2))
          return
        }
        if (results.length === 0) {
          console.log('No resources found.')
          return
        }
        for (const r of results) {
          console.log(`${r.id}  ${r.type.padEnd(16)} ${r.name}`)
        }
      } catch (err) {
        logger.error(err instanceof Error ? err.message : String(err))
        process.exitCode = classifyExitCode(err)
      }
    })

  return resource
}
