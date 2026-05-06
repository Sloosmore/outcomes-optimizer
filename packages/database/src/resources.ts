/**
 * CLI for managing resources
 *
 * Resources are anything an agent can use or reference — accounts, credentials,
 * storage, URLs, configs. The `config` field is flexible JSON; use it to describe
 * whatever is specific to the resource type. The `notes` field is free-text guidance
 * for the agent about how this resource should be used.
 *
 * Convention for webhook routing: include a `webhooks` array in config so the
 * interceptor can reverse-lookup which resource owns an incoming event.
 *
 * Usage:
 *   npm run resource add -- --name "instagram-trianglebender" --type identity --notes "..." --config '{"platform":"instagram","handle":"trianglebender","webhooks":[{"event":"comments","endpoint":"/hooks/instagram"}]}'
 *   npm run resource list [-- --type identity]
 *   npm run resource update -- --name "instagram-trianglebender" --notes "..." --config '{"channelId":"UCxxxxx"}'
 *   npm run resource update-status -- --name "instagram-trianglebender" --status banned
 */
import 'dotenv/config'
import { eq, and, isNull, inArray, type InferSelectModel } from 'drizzle-orm'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { getDb, closeDb } from './drizzle-client.js'
import { resources, tagEntities, tags, resourceLinks } from './schema.js'
import { upsertTag, attachTag } from './utils/tags.js'
import { VALID_TYPES, VALID_STATUSES, parseArgs, parseJsonArg } from './utils/resource-helpers.js'
import { executeAction } from './actions/execute-action.js'
import { getSupabaseUrl } from './constants.js'
import type {
  CreateAgentInput, CreateProxyInput, CreateSkillInput, CreateAppInput,
  CreateIdentityInput, CreateCredentialInput, CreateServerInput, CreateCronInput,
  CreateProjectInput,
} from './actions/execute-action.js'

type Resource = InferSelectModel<typeof resources>


function printResource(r: Resource, parentName?: string) {
  console.log(`  [${r.status.toUpperCase()}] ${r.name}  [${r.type}]`)
  console.log(`     ID:      ${r.id}`)
  console.log(`     Status:  ${r.status}`)
  if (parentName) console.log(`     Parent:  ${parentName}`)
  if (r.config && Object.keys(r.config as object).length > 0) {
    console.log(`     Config:  ${JSON.stringify(r.config)}`)
  }
  if (r['notes']) console.log(`     Notes:   ${r['notes']}`)
  console.log(`     Created: ${r.createdAt.toISOString()}`)
  console.log('')
}

async function resolveResourceId(parentName: string): Promise<string> {
  const db = getDb()
  const [parent] = await db.select({ id: resources.id, type: resources.type }).from(resources).where(eq(resources.name, parentName))
  if (!parent) throw new Error(`Parent resource not found: "${parentName}". --parent must reference an existing resource name.`)
  if (parent.type !== 'app') throw new Error(`Parent "${parentName}" has type "${parent.type}" — parent must be type "app".`)
  return parent.id
}


let _supabaseClient: SupabaseClient | undefined
function getSupabaseClient(): SupabaseClient {
  if (_supabaseClient) return _supabaseClient
  const url = getSupabaseUrl()
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_KEY ?? process.env.SUPABASE_ANON_KEY
  if (!key) {
    throw new Error('Missing required env var: SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SERVICE_KEY / SUPABASE_ANON_KEY)')
  }
  _supabaseClient = createClient(url, key)
  return _supabaseClient
}

/**
 * Type-safe dispatch for create actions — maps resource type to the correct
 * overload without unsafe string-literal casts on the action name.
 */
function dispatchCreate(
  type: string,
  input: Record<string, unknown>,
  client: ReturnType<typeof getSupabaseClient>
): Promise<Record<string, unknown>> {
  switch (type) {
    case 'agent':      return executeAction('create_agent',      input as CreateAgentInput,      client)
    case 'proxy':      return executeAction('create_proxy',      input as CreateProxyInput,      client)
    case 'skill':      return executeAction('create_skill',      input as CreateSkillInput,      client)
    case 'app':        return executeAction('create_app',        input as CreateAppInput,        client)
    case 'identity':   return executeAction('create_identity',   input as CreateIdentityInput,   client)
    case 'credential': return executeAction('create_credential', input as CreateCredentialInput, client)
    case 'server':     return executeAction('create_server',     input as CreateServerInput,     client)
    case 'cron':       return executeAction('create_cron',       input as CreateCronInput,       client)
    case 'project':    return executeAction('create_project',    input as CreateProjectInput,    client)
    default:           throw new Error(`No typed create action for resource type: "${type}"`)
  }
}

export async function addResource(options: {
  name: string
  type: typeof VALID_TYPES[number]
  config?: Record<string, unknown>
  notes?: string
  status?: typeof VALID_STATUSES[number]
  tags?: string[]
  parentName?: string
  projectId: string
}) {
  const supabase = getSupabaseClient()
  const config = options.config ?? {}
  if (options['notes']) {
    (config as Record<string, unknown>)['notes'] = options['notes']
  }

  // Build action input — some types require extra top-level fields extracted from config
  const baseInput: Record<string, unknown> = {
    name: options.name,
    projectId: options.projectId,
    config,
  }

  const typeStr: string = options.type
  if (typeStr === 'identity') {
    const handle = config['handle']
    if (!handle) throw new Error(`create_identity requires config.handle`)
    baseInput['handle'] = handle
  } else if (typeStr === 'cron') {
    const schedule = config['schedule']
    if (!schedule) throw new Error(`create_cron requires config.schedule`)
    baseInput['schedule'] = schedule
  } else if (typeStr === 'skill') {
    const content = config['content']
    if (!content) throw new Error(`create_skill requires config.content`)
    baseInput['config'] = { content }
  } else if (typeStr === 'credential') {
    const dopplerProject = config['dopplerProject']
    if (!dopplerProject) throw new Error(`create_credential requires config.dopplerProject`)
    baseInput['dopplerProject'] = dopplerProject as string
  }

  const result = await dispatchCreate(options.type, baseInput, supabase)

  // Retrieve the inserted record for display (all typed RPCs return a *ResourceId field)
  const resourceIdKey = Object.keys(result).find(k => k.endsWith('ResourceId'))
  const insertedId = resourceIdKey ? (result[resourceIdKey] as string) : undefined
  const db = getDb()
  let inserted: Resource | undefined
  if (insertedId) {
    const rows = await db.select().from(resources).where(eq(resources.id, insertedId))
    inserted = rows[0]
  }
  if (!inserted) {
    // Fallback: look up by name
    const rows = await db.select().from(resources).where(eq(resources.name, options.name))
    inserted = rows[0]
  }
  if (!inserted) throw new Error(`Resource created but could not be retrieved: ${options.name}`)

  if (options.tags && options.tags.length > 0) {
    for (const tagName of options.tags) {
      const tag = await upsertTag(tagName)
      await attachTag(inserted.id, 'resource', tag.id)
    }
  }
  console.log(`Created resource: ${inserted.name} (${inserted.id})`)
  printResource(inserted, options.parentName)
  return inserted
}

export async function checkoutResource(name: string, lockerId: string): Promise<Resource> {
  const db = getDb()
  // Atomic: only updates if lockedBy IS NULL
  const [updated] = await db.update(resources)
    .set({ lockedBy: lockerId, lockedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(resources.name, name), isNull(resources.lockedBy)))
    .returning()
  if (!updated) {
    // Find who holds the lock (or if resource doesn't exist)
    const [current] = await db.select({ lockedBy: resources.lockedBy }).from(resources).where(eq(resources.name, name))
    if (!current) throw new Error(`Resource not found: ${name}`)
    throw new Error(`already locked by ${current.lockedBy}`)
  }
  return updated
}

export async function releaseResource(name: string, lockerId: string): Promise<void> {
  const db = getDb()
  // Atomic: only clears the lock if the caller is the current lock holder
  const [released] = await db.update(resources)
    .set({ lockedBy: null, lockedAt: null, updatedAt: new Date() })
    .where(and(eq(resources.name, name), eq(resources.lockedBy, lockerId)))
    .returning()
  if (!released) {
    // Determine the reason for failure
    const [current] = await db.select({ lockedBy: resources.lockedBy }).from(resources).where(eq(resources.name, name))
    if (!current) throw new Error(`Resource not found: ${name}`)
    if (!current.lockedBy) throw new Error(`Resource is not locked: ${name}`)
    throw new Error(`Cannot release: resource is locked by ${current.lockedBy}, not ${lockerId}`)
  }
}

export async function getAvailableResources(filters?: { type?: string; tag?: string }): Promise<Resource[]> {
  const db = getDb()
  if (filters?.tag) {
    const rows = await db
      .select({ resource: resources })
      .from(resources)
      .innerJoin(tagEntities, and(eq(tagEntities.entityId, resources.id), eq(tagEntities.entityType, 'resource')))
      .innerJoin(tags, eq(tags.id, tagEntities.tagId))
      .where(and(
        isNull(resources.lockedBy),
        eq(tags.name, filters.tag),
        ...(filters.type ? [eq(resources.type, filters.type)] : [])
      ))
    return rows.map(r => r.resource)
  }
  if (filters?.type) {
    return db.select().from(resources).where(and(isNull(resources.lockedBy), eq(resources.type, filters.type)))
  }
  return db.select().from(resources).where(isNull(resources.lockedBy))
}

export async function getResourcesByTag(tag: string): Promise<Resource[]> {
  const db = getDb()
  const rows = await db
    .select({ resource: resources })
    .from(resources)
    .innerJoin(tagEntities, and(eq(tagEntities.entityId, resources.id), eq(tagEntities.entityType, 'resource')))
    .innerJoin(tags, eq(tags.id, tagEntities.tagId))
    .where(eq(tags.name, tag))
  return rows.map(r => r.resource)
}

async function updateResource(name: string, patch: { config?: Record<string, unknown>; notes?: string }) {
  const db = getDb()
  const [existing] = await db.select().from(resources).where(eq(resources.name, name))
  if (!existing) throw new Error(`Resource not found: ${name}`)

  const merged: Record<string, unknown> = {
    ...((existing.config ?? {}) as Record<string, unknown>),
    ...(patch.config ?? {}),
  }

  const [updated] = await db.update(resources)
    .set({
      config: merged,
      ...(patch['notes'] !== undefined ? { notes: patch['notes'] } : {}),
      updatedAt: new Date(),
    })
    .where(eq(resources.name, name))
    .returning()
  console.log(`Updated ${updated.name}`)
  printResource(updated)
  return updated
}

async function updateStatus(name: string, status: typeof VALID_STATUSES[number]) {
  const db = getDb()
  const [updated] = await db.update(resources)
    .set({ status, updatedAt: new Date() })
    .where(eq(resources.name, name))
    .returning()
  if (!updated) throw new Error(`Resource not found: ${name}`)
  console.log(`Updated ${updated.name} -> status: ${updated.status}`)
  return updated
}

async function listResources(type?: string) {
  const db = getDb()
  const rows = type
    ? await db.select().from(resources).where(eq(resources.type, type))
    : await db.select().from(resources)

  if (rows.length === 0) {
    console.log('No resources found.')
    return
  }

  // Build fromId -> parentName map via resource_links
  const resourceIds = rows.map(r => r.id)
  const links = resourceIds.length > 0
    ? await db.select().from(resourceLinks)
        .where(and(inArray(resourceLinks.fromId, resourceIds), eq(resourceLinks.linkType, 'parent')))
    : []

  const linkMap = new Map<string, string>() // fromId -> toId
  for (const link of links) linkMap.set(link.fromId, link.toId)

  const toIds = [...new Set(linkMap.values())]
  const parentNameMap = new Map<string, string>() // id -> name
  if (toIds.length > 0) {
    const parentRows = await db.select({ id: resources.id, name: resources.name })
      .from(resources)
      .where(inArray(resources.id, toIds))
    for (const p of parentRows) parentNameMap.set(p.id, p.name)
  }

  console.log('\nResources:')
  console.log('─'.repeat(80))
  for (const r of rows) {
    const toId = linkMap.get(r.id)
    const parentName = toId ? parentNameMap.get(toId) : undefined
    printResource(r, parentName)
  }
}

async function main() {
  const [command, ...rest] = process.argv.slice(2)

  if (!command || command === 'help' || command === '--help') {
    console.log(`
Resources CLI

Commands:
  add              Add a new resource
  list             List all resources
  list-by-tag      List resources with a specific tag
  update           Patch config and/or notes on an existing resource (merges config)
  update-status    Change a resource's status
  checkout         Lock a resource for exclusive use
  release          Release a lock on a resource
  available        List unlocked resources

add Options:
  --name      Required. Unique name
  --type      Required. ${VALID_TYPES.join(' | ')}
  --config    Optional. JSON object string (flexible, type-specific fields go here)
              WARNING: Do not store raw secrets. Use env var names instead
              (e.g. "authEnvVar": "MY_TOKEN_VAR" — not the token value itself).
  --notes     Optional. Free-text guidance for the agent about this resource
  --status    Optional. active (default) | inactive | banned | expired | error
  --parent    Optional. Name of parent resource (must exist; fails loudly if not found)
  --tags      Optional. Comma-separated list of tags to attach (e.g. "prod,instagram")
list Options:
  --type      Optional. Filter by type
list-by-tag Options:
  --tag       Required. Tag name to filter by

update Options:
  --name      Required. Resource name
  --config    Optional. JSON object to merge into existing config
  --notes     Optional. Replace notes text

update-status Options:
  --name      Required. Resource name
  --status    Required. ${VALID_STATUSES.join(' | ')}

checkout Options:
  --name      Required. Resource name
  --locker    Required. Identifier for the entity acquiring the lock

release Options:
  --name      Required. Resource name
  --locker    Required. Identifier for the entity releasing the lock (must match current locker)

available Options:
  --type      Optional. Filter by resource type
  --tag       Optional. Filter by tag name

Webhook routing convention:
  Include a "webhooks" array in --config to register this resource as the
  owner of an interceptor endpoint. The interceptor uses this for reverse lookup.
  Example: --config '{"webhooks":[{"event":"comments","endpoint":"/hooks/instagram"}]}'

Examples:
  npm run resource add -- --name "meta-app-instagram" --type app --config '{"platform":"meta","appIdEnvVar":"INSTAGRAM_APP_ID","appSecretEnvVar":"INSTAGRAM_APP_SECRET"}'
  npm run resource add -- --name "instagram-trianglebender" --type identity --parent "meta-app-instagram" --notes "Primary account" --config '{"platform":"instagram","handle":"trianglebender","authEnvVar":"INSTAGRAM_TRIANGLEBENDER_ACCESS_TOKEN"}'
  npm run resource list
  npm run resource list -- --type identity
  npm run resource update -- --name "youtube-hay-maker" --config '{"channelId":"UCxxxxx"}'
  npm run resource update-status -- --name "instagram-trianglebender" --status banned
`)
    return
  }

  try {
    if (command === 'add') {
      const args = parseArgs(rest)
      if (!args.name) throw new Error('--name is required')
      if (!args.type) throw new Error('--type is required')
      if (!VALID_TYPES.includes(args.type as typeof VALID_TYPES[number])) {
        throw new Error(`Invalid type: "${args.type}". Must be one of: ${VALID_TYPES.join(', ')}`)
      }
      const DISPATCH_TYPES = ['agent', 'proxy', 'skill', 'app', 'identity', 'credential', 'server', 'cron', 'project']
      if (!DISPATCH_TYPES.includes(args.type)) {
        throw new Error(`Type "${args.type}" does not have a typed RPC yet — cannot create via CLI. Supported types: ${DISPATCH_TYPES.join(', ')}`)
      }
      if (args.status && !VALID_STATUSES.includes(args.status as typeof VALID_STATUSES[number])) {
        throw new Error(`Invalid status: "${args.status}". Must be one of: ${VALID_STATUSES.join(', ')}`)
      }
      const config = args.config ? parseJsonArg(args.config, 'config') : {}
      const tagsArg = args.tags ? args.tags.split(',').map((t: string) => t.trim()).filter(Boolean) : undefined
      const parentName = args.parent as string | undefined
      // Resolve projectId: --project <name-or-id> or fall back to the first project in the DB
      const db = getDb()
      let projectId: string
      if (args.project) {
        const [proj] = await db.select({ id: resources.id }).from(resources).where(and(eq(resources.name, args.project), eq(resources.type, 'project')))
        if (!proj) throw new Error(`Project not found: "${args.project}"`)
        projectId = proj.id
      } else {
        const [proj] = await db.select({ id: resources.id }).from(resources).where(eq(resources.type, 'project')).limit(1)
        if (!proj) throw new Error('No project found — pass --project <name> or create a project first')
        projectId = proj.id
      }
      const inserted = await addResource({
        name: args.name,
        type: args.type as typeof VALID_TYPES[number],
        config,
        notes: args['notes'],
        status: args.status as typeof VALID_STATUSES[number] | undefined,
        tags: tagsArg,
        parentName,
        projectId,
      })
      if (parentName) {
        const resolvedToId = await resolveResourceId(parentName)
        const db = getDb()
        await db.insert(resourceLinks).values({ fromId: inserted.id, toId: resolvedToId, linkType: 'parent' })
        console.log(`Linked to parent: ${parentName}`)
      }

    } else if (command === 'list') {
      const args = parseArgs(rest)
      if (args.type && !VALID_TYPES.includes(args.type as typeof VALID_TYPES[number])) {
        console.warn(`Warning: unknown type "${args.type}". Valid types: ${VALID_TYPES.join(', ')}`)
      }
      await listResources(args.type)

    } else if (command === 'update') {
      const args = parseArgs(rest)
      if (!args.name) throw new Error('--name is required')
      const config = args.config ? parseJsonArg(args.config, 'config') : undefined
      await updateResource(args.name, { config, notes: args['notes'] })

    } else if (command === 'update-status') {
      const args = parseArgs(rest)
      if (!args.name) throw new Error('--name is required')
      if (!args.status) throw new Error('--status is required')
      if (!VALID_STATUSES.includes(args.status as typeof VALID_STATUSES[number])) {
        throw new Error(`Invalid status: "${args.status}". Must be one of: ${VALID_STATUSES.join(', ')}`)
      }
      await updateStatus(args.name, args.status as typeof VALID_STATUSES[number])

    } else if (command === 'list-by-tag') {
      const args = parseArgs(rest)
      if (!args.tag) throw new Error('--tag is required')
      const results = await getResourcesByTag(args.tag)
      if (results.length === 0) {
        console.log('No resources found.')
      } else {
        console.log('\nResources:')
        console.log('─'.repeat(80))
        for (const r of results) printResource(r)
      }

    } else if (command === 'checkout') {
      const args = parseArgs(rest)
      if (!args.name) throw new Error('--name is required')
      if (!args.locker) throw new Error('--locker is required')
      const result = await checkoutResource(args.name, args.locker)
      console.log(`Checked out ${result.name} (lockedBy: ${result.lockedBy})`)
      printResource(result)

    } else if (command === 'release') {
      const args = parseArgs(rest)
      if (!args.name) throw new Error('--name is required')
      if (!args.locker) throw new Error('--locker is required')
      await releaseResource(args.name, args.locker)
      console.log(`Released ${args.name}`)

    } else if (command === 'available') {
      const args = parseArgs(rest)
      const results = await getAvailableResources({ type: args.type, tag: args.tag })
      if (results.length === 0) {
        console.log('No available resources found.')
      } else {
        console.log('\nAvailable Resources:')
        console.log('─'.repeat(80))
        for (const r of results) printResource(r)
      }

    } else {
      throw new Error(`Unknown command: ${command}. Run with --help to see usage.`)
    }
  } finally {
    await closeDb()
  }
}

main().catch(e => {
  console.error('Error:', e instanceof Error ? e.message : e)
  process.exit(1)
})
