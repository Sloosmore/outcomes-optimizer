import { Command } from 'commander'
import { getSqlClient } from '@skill-networks/database/client'
import { createLogger } from '@skill-networks/logger'

const logger = createLogger('agent-core')

interface RawLink {
  from_id: string
  to_id: string
}

export function traverseCommand(): Command {
  return new Command('traverse')
    .description('BFS traversal of the resource graph')
    .requiredOption('--from <name>', 'Starting resource name')
    .requiredOption('--via <link-type>', 'Link type to traverse')
    .option('--direction <direction>', 'Direction: in (consumers) or out (dependencies)', 'out')
    .option('--depth <n>', 'Number of hops from start node (1 = direct neighbors only, default 3, max 20)', '3')
    .option('--json', 'Output as JSON array')
    .action(async (opts) => {
      try {
        const linkType: string = opts.via
        const direction: string = opts.direction
        const depth = /^\d+$/.test(opts.depth) ? Number(opts.depth) : NaN

        if (direction !== 'in' && direction !== 'out') {
          logger.error(`Error: --direction must be "in" or "out", got "${direction}"`)
          process.exitCode = 1
          return
        }

        const MAX_DEPTH = 20
        if (isNaN(depth) || depth < 1) {
          logger.error(`Error: --depth must be a positive integer, got "${opts.depth}"`)
          process.exitCode = 1
          return
        }
        if (depth > MAX_DEPTH) {
          logger.error(`Error: --depth cannot exceed ${MAX_DEPTH}`)
          process.exitCode = 1
          return
        }

        // Resolve start resource using direct SQL to bypass project scoping.
        // Intentional: traverse is an infrastructure-level graph tool that must see
        // flow/ resources seeded with auth_user_id=null across independent sessions.
        // getAdapter().getResource() enforces auth_user_id scoping and returns null for those.
        //
        // WARNING: This command runs as service_role, which bypasses RLS entirely.
        // "service_role_full_access" is the only RLS policy on these tables — it grants
        // unrestricted access to all rows. Do not expose this CLI to untrusted operators.
        // It is intended for infrastructure automation where the full resource graph is needed.
        const sql = getSqlClient()
        // eslint-disable-next-line no-restricted-syntax
        const startResult = await sql<{ id: string; type: string }[]>`
          SELECT id::text as id, type FROM resources WHERE name = ${opts.from}
        `
        if (startResult.length === 0) {
          logger.error(`Error: Resource not found: ${opts.from}`)
          process.exitCode = 1
          return
        }
        if (startResult.length > 1) {
          logger.error(`Error: Multiple resources named "${opts.from}" found. Use a more specific name.`)
          process.exitCode = 1
          return
        }
        const startResource = startResult[0]
        const startId = startResource.id

        // Warn if the start node's type has no matching rule for this link_type
        // in the traversal direction. If so, the query will always return empty.
        // direction=out: start is the "from" node; check from_type rules
        // direction=in:  start is the "to" node; check to_type rules
        // eslint-disable-next-line no-restricted-syntax
        const ruleCheckRows = await sql<{ count: string }[]>`
          SELECT COUNT(*)::text as count
          FROM link_type_rules
          WHERE link_type = ${linkType}
            AND CASE
              WHEN ${direction} = 'out'
                THEN (from_type = ${startResource.type} OR from_type IS NULL)
              ELSE
                (to_type = ${startResource.type} OR to_type IS NULL)
            END
        `
        if (ruleCheckRows[0]?.count === '0') {
          const typeField = direction === 'out' ? 'from_type' : 'to_type'
          logger.error(`Warning: link type "${linkType}" has no rules where ${typeField}="${startResource.type}". Traversal will return no results.`)
        }

        // Load all active links for the given link_type directly via SQL.
        // Hard cap prevents OOM on very large graphs; if hit, a recursive CTE
        // approach (BFS in SQL) would be needed to bound by reachability.
        const MAX_LINKS = 100_000
        // eslint-disable-next-line no-restricted-syntax
        const rows = await sql<RawLink[]>`
          SELECT from_id, to_id
          FROM resource_links
          WHERE link_type = ${linkType}
            AND valid_to IS NULL
          LIMIT ${MAX_LINKS + 1}
        `
        if (rows.length > MAX_LINKS) {
          logger.error(`Error: link type "${linkType}" has more than ${MAX_LINKS} active edges. Use a more specific traversal.`)
          process.exitCode = 1
          return
        }

        // Build adjacency map based on direction
        // direction=out: natural edges — what the start node points TO (dependencies)
        // direction=in:  reversed edges — what points TO the start node (consumers)
        const adjacency = new Map<string, Set<string>>()

        for (const row of rows) {
          if (direction === 'out') {
            // Natural direction: from -> to
            if (!adjacency.has(row.from_id)) adjacency.set(row.from_id, new Set())
            adjacency.get(row.from_id)!.add(row.to_id)
          } else {
            // Reversed direction: to -> from (find who points at start)
            if (!adjacency.has(row.to_id)) adjacency.set(row.to_id, new Set())
            adjacency.get(row.to_id)!.add(row.from_id)
          }
        }

        // BFS traversal
        const visited = new Set<string>()
        visited.add(startId)
        let frontier = new Set<string>([startId])

        for (let hop = 0; hop < depth; hop++) {
          const nextFrontier = new Set<string>()
          for (const nodeId of frontier) {
            const neighbors = adjacency.get(nodeId)
            if (!neighbors) continue
            for (const neighbor of neighbors) {
              if (!visited.has(neighbor)) {
                visited.add(neighbor)
                nextFrontier.add(neighbor)
              }
            }
          }
          if (nextFrontier.size === 0) break
          frontier = nextFrontier
        }

        // Remove start node from results
        visited.delete(startId)

        if (visited.size === 0) {
          if (opts.json) {
            console.log(JSON.stringify([]))
          } else {
            console.log('No resources found')
          }
          return
        }

        // Look up names for all discovered UUIDs
        const discoveredIds = Array.from(visited)
        // eslint-disable-next-line no-restricted-syntax
        const nameRows = await sql<{ id: string; name: string }[]>`
          SELECT id::text, name
          FROM resources
          WHERE id::text = ANY(${sql.array(discoveredIds)})
        `

        const names = nameRows.map(r => r.name).sort()

        if (opts.json) {
          console.log(JSON.stringify(names))
        } else {
          for (const name of names) {
            console.log(name)
          }
        }
      } catch (e) {
        logger.error(`Error: ${e instanceof Error ? e.message : e}`)
        process.exitCode = 1
      }
    })
}
