import type postgres from 'postgres'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sql = ReturnType<typeof postgres> | any

const VALID_TYPES = ['data', 'identity', 'url', 'credential', 'config', 'app', 'skill', 'proxy', 'server', 'database', 'deployment', 'bucket', 'cron', 'flow', 'package', 'service'] as const
const VALID_STATUSES = ['active', 'inactive', 'banned', 'expired', 'error'] as const

export interface ResourceType {
  name: string
  finite: boolean
  description: string
  count?: number
}

export interface Resource {
  id: string
  name: string
  type: string
  status: string
  config: Record<string, unknown> | null
  notes: string | null
  locked_by: string | null
  locked_at: string | null
  created_at: string
  updated_at: string
}

export interface ResourceLink {
  from_id: string
  to_id: string
  link_type: string
  created_at: string
}

export interface LinkType {
  name: string
  description: string
  cardinality: string
  created_at: string
}

export interface LinkTypeRule {
  id: string
  link_type: string
  from_type: string | null
  to_type: string | null
  created_at: string
}

export interface ValueType {
  name: string
  base_type: string
  constraints: unknown[]
}

export interface ResourceTypeProperty {
  field_name: string
  value_type_name: string | null
  required: boolean
}

export interface ResourceLinkCount {
  link_type: string
  count: number
}

export interface LinkTypeRuleWithCardinality {
  link_type: string
  from_type: string | null
  to_type: string | null
  min_count: number
  max_count: number | null
}

export interface CronWithDetails {
  id: string
  name: string
  schedule: string
  enabled: boolean
  prompt: string | null
  created_at: Date
  skill_id: string | null
  skill_name: string | null
}

export interface IResourcesService {
  add(name: string, type: string, config?: Record<string, unknown>, notes?: string, status?: string): Promise<Resource>
  remove(name: string): Promise<void>
  removeById(id: string): Promise<void>
  getByName(name: string): Promise<Resource | null>
  getById(id: string): Promise<Resource | null>
  list(opts?: { type?: string; status?: string }): Promise<Resource[]>
  listActive(opts?: { types?: string[] }): Promise<Resource[]>
  findByIds(ids: string[]): Promise<Pick<Resource, 'id' | 'name'>[]>
  listLinksBetween(ids: string[]): Promise<ResourceLink[]>
  search(query: string, opts?: { type?: string }): Promise<Resource[]>
  getAvailable(type: string): Promise<Resource[]>
  checkout(name: string, lockerId: string): Promise<Resource>
  release(name: string, lockerId: string): Promise<Resource>
  updateConfig(id: string, config: Record<string, unknown>): Promise<Resource>
  getTypes(): Promise<ResourceType[]>
  getTypeProperties(resourceType: string): Promise<ResourceTypeProperty[]>
  getValueTypes(): Promise<ValueType[]>
  getValueTypeByName(name: string): Promise<ValueType | null>
  getLinks(resourceId: string): Promise<ResourceLink[]>
  createLink(fromName: string, toName: string, linkType: string): Promise<{ link: ResourceLink; created: boolean }>
  createLinkById(fromId: string, toId: string, linkType: string): Promise<{ link: ResourceLink; created: boolean }>
  deleteLink(fromName: string, toName: string, linkType: string): Promise<void>
  deleteLinkById(fromId: string, toId: string, linkType: string): Promise<void>
  getLinkTypes(): Promise<LinkType[]>
  getLinkTypeByName(name: string): Promise<LinkType | null>
  getLinkTypeRules(opts?: { linkType?: string }): Promise<LinkTypeRule[]>
  getLinkTypeRulesWithCardinality(opts?: { fromType?: string; toType?: string }): Promise<LinkTypeRuleWithCardinality[]>
  getLinkCounts(resourceId: string): Promise<ResourceLinkCount[]>
  listAllLinks(): Promise<ResourceLink[]>
  listCronsWithDetails(): Promise<CronWithDetails[]>
  listDistinctTypes(): Promise<string[]>
  findByNameAndType(name: string, type: string): Promise<Resource | null>
  updateStatusWhere(opts: { name: string; type: string; currentStatus: string; newStatus: string }): Promise<Pick<Resource, 'id'>[]>
  upsertByName(data: { name: string; type: string; status: string; config: Record<string, unknown> }): Promise<Pick<Resource, 'id'>>
  findByExternalId(type: string, externalId: string): Promise<Pick<Resource, 'id'> | null>
  listLinksFromId(fromId: string): Promise<Pick<ResourceLink, 'to_id'>[]>
  listLinksToId(opts: { toId: string; linkType: string }): Promise<Pick<ResourceLink, 'from_id'>[]>
  listLinksToIdFull(opts: { toId: string; linkType: string }): Promise<ResourceLink[]>
  countLinkedByType(opts: { toId: string; linkType: string; fromType: string }): Promise<number>
  findLinkByFromAndType(fromId: string, linkType: string): Promise<Pick<ResourceLink, 'to_id'> | null>
  findByTypeAndIds(type: string, ids: string[]): Promise<Resource[]>
  findByTypeAndName(type: string, name: string): Promise<Pick<Resource, 'id' | 'config' | 'updated_at'> | null>
  resolveUserProjects(callerUserId: string): Promise<Set<string>>
  resolveDefaultProject(sub: string): Promise<{ id: string; name: string } | null>
  listUserProjects(sub: string): Promise<Array<{ id: string; name: string; created_at: string }>>
}

export class ResourcesService implements IResourcesService {
  constructor(private sql: Sql) {}

  async add(name: string, type: string, config?: Record<string, unknown>, notes?: string, status?: string): Promise<Resource> {
    if (!/^[a-zA-Z0-9/_-]{1,128}$/.test(name)) {
      throw new Error(`Invalid resource name: "${name}". Must match [a-zA-Z0-9/_-]{1,128}`)
    }
    if (!(VALID_TYPES as readonly string[]).includes(type)) {
      throw new Error(`Invalid resource type: ${type}. Must be one of: ${VALID_TYPES.join(', ')}`)
    }
    const effectiveStatus = status ?? 'active'
    if (!(VALID_STATUSES as readonly string[]).includes(effectiveStatus)) {
      throw new Error(`Invalid status: ${effectiveStatus}. Must be one of: ${VALID_STATUSES.join(', ')}`)
    }
    const sql = this.sql
    const rows = await sql`
      INSERT INTO resources (name, type, config, notes, status)
      VALUES (${name}, ${type}, ${config ? sql.json(config) : null}, ${notes ?? null}, ${effectiveStatus})
      RETURNING *
    `
    return rows[0] as unknown as Resource
  }

  async remove(name: string): Promise<void> {
    const result = await this.sql`DELETE FROM resources WHERE name = ${name}`
    if (result.count === 0) throw new Error(`Resource not found: ${name}`)
  }

  async removeById(id: string): Promise<void> {
    const result = await this.sql`DELETE FROM resources WHERE id = ${id}`
    if (result.count === 0) throw new Error(`Resource not found: ${id}`)
  }

  async getByName(name: string): Promise<Resource | null> {
    const rows = await this.sql`SELECT * FROM resources WHERE name = ${name}`
    return (rows[0] as unknown as Resource) ?? null
  }

  async getById(id: string): Promise<Resource | null> {
    const rows = await this.sql`SELECT * FROM resources WHERE id = ${id}`
    return (rows[0] as unknown as Resource) ?? null
  }

  async list(opts?: { type?: string; status?: string }): Promise<Resource[]> {
    const sql = this.sql
    let rows
    if (opts?.type && opts?.status) {
      rows = await sql`SELECT * FROM resources WHERE type = ${opts.type} AND status = ${opts.status} ORDER BY name`
    } else if (opts?.type) {
      rows = await sql`SELECT * FROM resources WHERE type = ${opts.type} ORDER BY name`
    } else if (opts?.status) {
      rows = await sql`SELECT * FROM resources WHERE status = ${opts.status} ORDER BY name`
    } else {
      rows = await sql`SELECT * FROM resources ORDER BY name`
    }
    return rows as unknown as Resource[]
  }

  async search(query: string, opts?: { type?: string }): Promise<Resource[]> {
    const sql = this.sql
    const like = `%${query}%`
    let rows
    if (opts?.type) {
      rows = await sql`SELECT * FROM resources WHERE type = ${opts.type} AND (name ILIKE ${like} OR config::text ILIKE ${like}) ORDER BY name`
    } else {
      rows = await sql`SELECT * FROM resources WHERE name ILIKE ${like} OR config::text ILIKE ${like} ORDER BY name`
    }
    return rows as unknown as Resource[]
  }

  async getAvailable(type: string): Promise<Resource[]> {
    const rows = await this.sql`SELECT * FROM resources WHERE type = ${type} AND locked_by IS NULL ORDER BY name`
    return rows as unknown as Resource[]
  }

  async checkout(name: string, lockerId: string): Promise<Resource> {
    if (!lockerId || lockerId.trim().length === 0) throw new Error('Locker ID must be a non-empty string')
    const sql = this.sql
    // Atomic checkout: enforces finite=true and locked_by IS NULL in a single UPDATE
    const updatedRows = await sql`
      UPDATE resources r
      SET locked_by = ${lockerId}, locked_at = NOW(), updated_at = NOW()
      FROM resource_types rt
      WHERE r.name = ${name}
        AND r.type = rt.name
        AND rt.finite = true
        AND r.locked_by IS NULL
      RETURNING r.*
    `
    const updated = updatedRows[0] as unknown as Resource | undefined
    if (!updated) {
      // Diagnose why the UPDATE matched nothing
      const diagRows = await sql`
        SELECT r.locked_by, rt.finite, r.type
        FROM resources r
        JOIN resource_types rt ON r.type = rt.name
        WHERE r.name = ${name}
      `
      const diag = diagRows[0] as { locked_by: string | null; finite: boolean; type: string } | undefined
      if (!diag) throw new Error(`Resource not found: ${name}`)
      if (!diag.finite) throw new Error(`${diag.type} resources are not finite and cannot be checked out`)
      throw new Error(`already locked by ${diag.locked_by}`)
    }
    return updated
  }

  async release(name: string, lockerId: string): Promise<Resource> {
    if (!lockerId || lockerId.trim().length === 0) throw new Error('Locker ID must be a non-empty string')
    const sql = this.sql
    const releasedRows = await sql`
      UPDATE resources
      SET locked_by = NULL, locked_at = NULL, updated_at = NOW()
      WHERE name = ${name} AND locked_by = ${lockerId}
      RETURNING *
    `
    const released = releasedRows[0] as unknown as Resource | undefined
    if (!released) {
      const currentRows = await sql`SELECT locked_by FROM resources WHERE name = ${name}`
      const current = currentRows[0] as { locked_by: string | null } | undefined
      if (!current) throw new Error(`Resource not found: ${name}`)
      if (!current.locked_by) throw new Error(`Resource is not locked: ${name}`)
      throw new Error(`Cannot release: resource is locked by ${current.locked_by}, not ${lockerId}`)
    }
    return released
  }

  async updateConfig(id: string, config: Record<string, unknown>): Promise<Resource> {
    const sql = this.sql
    const rows = await sql`
      UPDATE resources SET config = ${sql.json(config)}, updated_at = NOW()
      WHERE id = ${id}
      RETURNING *
    `
    if (rows.length === 0) throw new Error(`Resource not found: ${id}`)
    return rows[0] as unknown as Resource
  }

  async getTypes(): Promise<ResourceType[]> {
    const rows = await this.sql`
      SELECT rt.name, rt.finite, rt.description, COUNT(r.id)::int as count
      FROM resource_types rt
      LEFT JOIN resources r ON r.type = rt.name
      GROUP BY rt.name, rt.finite, rt.description
      ORDER BY rt.name
    `
    return rows as unknown as ResourceType[]
  }

  async getTypeProperties(resourceType: string): Promise<ResourceTypeProperty[]> {
    const rows = await this.sql`
      SELECT rtp.field_name, vt.name as value_type_name, rtp.required
      FROM resource_type_properties rtp
      LEFT JOIN value_types vt ON vt.id = rtp.value_type_id
      WHERE rtp.resource_type = ${resourceType}
      ORDER BY rtp.field_name
    `
    return rows as unknown as ResourceTypeProperty[]
  }

  async getValueTypes(): Promise<ValueType[]> {
    const rows = await this.sql`SELECT name, base_type, constraints FROM value_types ORDER BY name`
    return rows as unknown as ValueType[]
  }

  // NOTE: resource_links now has valid_from/valid_to columns (added in migration
  // 20260409000001_flow_graph_ontology_schema.sql) for temporal soft-delete tracking.
  // Currently, NO rows have a non-null valid_to — nothing writes it yet.
  // When soft-delete writes are introduced, ALL read paths here (getLinks,
  // getOutgoingLinks, getIncomingLinks, etc.) must be updated to filter
  // WHERE valid_to IS NULL, and deleteLink/deleteLinkById must be changed
  // to UPDATE valid_to = NOW() instead of DELETE. Make both changes atomically
  // to avoid the traverse command seeing a different graph than these methods.
  async getLinks(resourceId: string): Promise<ResourceLink[]> {
    const rows = await this.sql`SELECT from_id, to_id, link_type, created_at FROM resource_links WHERE from_id = ${resourceId} ORDER BY created_at`
    return rows as unknown as ResourceLink[]
  }

  async createLink(fromName: string, toName: string, linkType: string): Promise<{ link: ResourceLink; created: boolean }> {
    const linkTypeDef = await this._getLinkType(linkType)
    if (!linkTypeDef) throw new Error(`Invalid link type: ${linkType}`)
    // Note: linkTypeDef.cardinality is informational (e.g. 'many-to-one') and stored for display/tooling.
    // Cardinality enforcement (e.g. preventing multiple parents) is not implemented here — rely on
    // application-level conventions or add a DB-side uniqueness constraint if strict enforcement is needed.
    const [from, to] = await Promise.all([this._resolveResource(fromName), this._resolveResource(toName)])
    const rules = await this.getLinkTypeRules({ linkType })
    if (rules.length === 0) throw new Error(`Link type '${linkType}' has no rules defined — cannot validate type pairing`)
    const matched = rules.some(rule =>
      (rule.from_type === null || rule.from_type === from.type) &&
      (rule.to_type === null || rule.to_type === to.type)
    )
    if (!matched) throw new Error(`Invalid link: ${from.type} → ${to.type} does not match any rule for type '${linkType}'`)
    const sql = this.sql
    const rows = await sql`
      INSERT INTO resource_links (from_id, to_id, link_type)
      VALUES (${from.id}, ${to.id}, ${linkType})
      ON CONFLICT DO NOTHING
      RETURNING from_id, to_id, link_type, created_at
    `
    // ON CONFLICT DO NOTHING returns empty — fetch the existing row if insert was a no-op
    if (rows.length === 0) {
      const existing = await sql`SELECT from_id, to_id, link_type, created_at FROM resource_links WHERE from_id = ${from.id} AND to_id = ${to.id} AND link_type = ${linkType}`
      return { link: existing[0] as unknown as ResourceLink, created: false }
    }
    return { link: rows[0] as unknown as ResourceLink, created: true }
  }

  async createLinkById(fromId: string, toId: string, linkType: string): Promise<{ link: ResourceLink; created: boolean }> {
    const linkTypeDef = await this._getLinkType(linkType)
    if (!linkTypeDef) throw new Error(`Invalid link type: ${linkType}`)
    const [fromRows, toRows] = await Promise.all([
      this.sql`SELECT id, type FROM resources WHERE id = ${fromId}`,
      this.sql`SELECT id, type FROM resources WHERE id = ${toId}`,
    ])
    const from = fromRows[0] as unknown as { id: string; type: string } | undefined
    const to = toRows[0] as unknown as { id: string; type: string } | undefined
    if (!from) throw new Error(`Resource not found: ${fromId}`)
    if (!to) throw new Error(`Resource not found: ${toId}`)
    const rules = await this.getLinkTypeRules({ linkType })
    if (rules.length === 0) throw new Error(`Link type '${linkType}' has no rules defined — cannot validate type pairing`)
    const matched = rules.some(rule =>
      (rule.from_type === null || rule.from_type === from.type) &&
      (rule.to_type === null || rule.to_type === to.type)
    )
    if (!matched) throw new Error(`Invalid link: ${from.type} → ${to.type} does not match any rule for type '${linkType}'`)
    const sql = this.sql
    const rows = await sql`
      INSERT INTO resource_links (from_id, to_id, link_type)
      VALUES (${from.id}, ${to.id}, ${linkType})
      ON CONFLICT DO NOTHING
      RETURNING from_id, to_id, link_type, created_at
    `
    if (rows.length === 0) {
      const existing = await sql`SELECT from_id, to_id, link_type, created_at FROM resource_links WHERE from_id = ${from.id} AND to_id = ${to.id} AND link_type = ${linkType}`
      return { link: existing[0] as unknown as ResourceLink, created: false }
    }
    return { link: rows[0] as unknown as ResourceLink, created: true }
  }

  async deleteLink(fromName: string, toName: string, linkType: string): Promise<void> {
    const exists = await this._getLinkType(linkType)
    if (!exists) throw new Error(`Invalid link type: ${linkType}`)
    const sql = this.sql
    const fromId = await this._resolveResourceId(fromName)
    const toId = await this._resolveResourceId(toName)
    const result = await sql`
      DELETE FROM resource_links WHERE from_id = ${fromId} AND to_id = ${toId} AND link_type = ${linkType}
    `
    if (result.count === 0) throw new Error(`Link not found: ${fromName} → ${toName} (type: ${linkType})`)
  }

  async deleteLinkById(fromId: string, toId: string, linkType: string): Promise<void> {
    const exists = await this._getLinkType(linkType)
    if (!exists) throw new Error(`Invalid link type: ${linkType}`)
    const sql = this.sql
    const result = await sql`
      DELETE FROM resource_links WHERE from_id = ${fromId} AND to_id = ${toId} AND link_type = ${linkType}
    `
    if (result.count === 0) throw new Error(`Link not found: ${fromId} → ${toId} (type: ${linkType})`)
  }

  async getLinkTypes(): Promise<LinkType[]> {
    const rows = await this.sql`SELECT name, description, cardinality, created_at FROM link_types ORDER BY name`
    return rows as unknown as LinkType[]
  }

  async getLinkTypeRules(opts?: { linkType?: string }): Promise<LinkTypeRule[]> {
    const sql = this.sql
    let rows
    if (opts?.linkType) {
      rows = await sql`SELECT id, link_type, from_type, to_type, created_at FROM link_type_rules WHERE link_type = ${opts.linkType} ORDER BY link_type, from_type, to_type`
    } else {
      rows = await sql`SELECT id, link_type, from_type, to_type, created_at FROM link_type_rules ORDER BY link_type, from_type, to_type`
    }
    return rows as unknown as LinkTypeRule[]
  }

  async getLinkCounts(resourceId: string): Promise<ResourceLinkCount[]> {
    const rows = await this.sql`
      SELECT link_type, COUNT(*)::int as count
      FROM resource_links
      WHERE from_id = ${resourceId}
      GROUP BY link_type
    `
    return rows as unknown as ResourceLinkCount[]
  }

  async listAllLinks(): Promise<ResourceLink[]> {
    const rows = await this.sql`SELECT from_id, to_id, link_type, created_at FROM resource_links ORDER BY created_at`
    return rows as unknown as ResourceLink[]
  }

  async listActive(opts?: { types?: string[] }): Promise<Resource[]> {
    const sql = this.sql
    const types = opts?.types
    let rows
    if (types && types.length > 0) {
      rows = await sql`SELECT * FROM resources WHERE status = 'active' AND type = ANY(${sql.array(types)}) ORDER BY name`
    } else {
      rows = await sql`SELECT * FROM resources WHERE status = 'active' ORDER BY name`
    }
    return rows as unknown as Resource[]
  }

  async findByIds(ids: string[]): Promise<Pick<Resource, 'id' | 'name'>[]> {
    if (ids.length === 0) return []
    const sql = this.sql
    const rows = await sql`SELECT id, name FROM resources WHERE id::text = ANY(${sql.array(ids)})`
    return rows as unknown as Pick<Resource, 'id' | 'name'>[]
  }

  async listLinksBetween(ids: string[]): Promise<ResourceLink[]> {
    if (ids.length === 0) return []
    const sql = this.sql
    const rows = await sql`
      SELECT from_id, to_id, link_type, created_at FROM resource_links
      WHERE from_id::text = ANY(${sql.array(ids)}) AND to_id::text = ANY(${sql.array(ids)})
    `
    return rows as unknown as ResourceLink[]
  }

  async updateContent(resourceId: string, content: string): Promise<void> {
    await this.sql`
      UPDATE resources
      SET config = jsonb_set(config, '{content}', to_jsonb(${content}::text))
      WHERE id = ${resourceId}
    `
  }

  async getValueTypeByName(name: string): Promise<ValueType | null> {
    const rows = await this.sql`SELECT name, base_type, constraints FROM value_types WHERE name = ${name}`
    return (rows[0] as unknown as ValueType) ?? null
  }

  async getLinkTypeByName(name: string): Promise<LinkType | null> {
    const rows = await this.sql`SELECT name, description, cardinality, created_at FROM link_types WHERE name = ${name}`
    return (rows[0] as unknown as LinkType) ?? null
  }

  async getLinkTypeRulesWithCardinality(opts?: { fromType?: string; toType?: string }): Promise<LinkTypeRuleWithCardinality[]> {
    const sql = this.sql
    let rows
    if (opts?.fromType && opts?.toType) {
      rows = await sql`
        SELECT link_type, from_type, to_type, min_count, max_count
        FROM link_type_rules
        WHERE from_type = ${opts.fromType} AND to_type = ${opts.toType}
        ORDER BY link_type
      `
    } else if (opts?.fromType) {
      rows = await sql`
        SELECT link_type, from_type, to_type, min_count, max_count
        FROM link_type_rules
        WHERE from_type = ${opts.fromType}
        ORDER BY link_type
      `
    } else if (opts?.toType) {
      rows = await sql`
        SELECT link_type, from_type, to_type, min_count, max_count
        FROM link_type_rules
        WHERE to_type = ${opts.toType}
        ORDER BY link_type
      `
    } else {
      rows = await sql`
        SELECT link_type, from_type, to_type, min_count, max_count
        FROM link_type_rules
        ORDER BY link_type
      `
    }
    return rows as unknown as LinkTypeRuleWithCardinality[]
  }

  async listCronsWithDetails(): Promise<CronWithDetails[]> {
    const sql = this.sql
    const rows = await sql`
      SELECT
        r.id,
        r.name,
        r.config->>'schedule' AS schedule,
        (r.config->>'enabled')::boolean AS enabled,
        r.config->>'prompt' AS prompt,
        r.created_at,
        skill.id AS skill_id,
        skill.name AS skill_name
      FROM resources r
      LEFT JOIN resource_links rl ON rl.from_id = r.id AND rl.link_type = 'schedules'
      LEFT JOIN resources skill ON skill.id = rl.to_id
      WHERE r.type = 'cron'
      ORDER BY r.name
    `
    return rows as unknown as CronWithDetails[]
  }

  async listDistinctTypes(): Promise<string[]> {
    const rows = await this.sql`SELECT DISTINCT type FROM resources WHERE type IS NOT NULL ORDER BY type`
    return (rows as unknown as Array<{ type: string }>).map(r => r.type)
  }

  async findByNameAndType(name: string, type: string): Promise<Resource | null> {
    const rows = await this.sql`SELECT * FROM resources WHERE name = ${name} AND type = ${type}`
    return (rows[0] as unknown as Resource) ?? null
  }

  async updateStatusWhere(opts: { name: string; type: string; currentStatus: string; newStatus: string }): Promise<Pick<Resource, 'id'>[]> {
    const rows = await this.sql`
      UPDATE resources SET status = ${opts.newStatus}, updated_at = NOW()
      WHERE name = ${opts.name} AND type = ${opts.type} AND status = ${opts.currentStatus}
      RETURNING id
    `
    return rows as unknown as Pick<Resource, 'id'>[]
  }

  async upsertByName(data: { name: string; type: string; status: string; config: Record<string, unknown> }): Promise<Pick<Resource, 'id'>> {
    const sql = this.sql
    const rows = await sql`
      INSERT INTO resources (name, type, status, config)
      VALUES (${data.name}, ${data.type}, ${data.status}, ${sql.json(data.config)})
      ON CONFLICT (name) DO UPDATE SET status = EXCLUDED.status, config = EXCLUDED.config, updated_at = NOW()
      RETURNING id
    `
    return rows[0] as unknown as Pick<Resource, 'id'>
  }

  async findByExternalId(type: string, externalId: string): Promise<Pick<Resource, 'id'> | null> {
    const rows = await this.sql`SELECT id FROM resources WHERE type = ${type} AND auth_user_id = ${externalId}`
    return (rows[0] as unknown as Pick<Resource, 'id'>) ?? null
  }

  async listLinksFromId(fromId: string): Promise<Pick<ResourceLink, 'to_id'>[]> {
    const rows = await this.sql`SELECT to_id FROM resource_links WHERE from_id = ${fromId}`
    return rows as unknown as Pick<ResourceLink, 'to_id'>[]
  }

  async listLinksToId(opts: { toId: string; linkType: string }): Promise<Pick<ResourceLink, 'from_id'>[]> {
    const rows = await this.sql`SELECT from_id FROM resource_links WHERE to_id = ${opts.toId} AND link_type = ${opts.linkType}`
    return rows as unknown as Pick<ResourceLink, 'from_id'>[]
  }

  async listLinksToIdFull(opts: { toId: string; linkType: string }): Promise<ResourceLink[]> {
    const rows = await this.sql`SELECT from_id, to_id, link_type, created_at FROM resource_links WHERE to_id = ${opts.toId} AND link_type = ${opts.linkType}`
    return rows as unknown as ResourceLink[]
  }

  async countLinkedByType(opts: { toId: string; linkType: string; fromType: string }): Promise<number> {
    const rows = await this.sql`
      SELECT COUNT(*)::int AS count
      FROM resource_links rl
      JOIN resources r ON r.id = rl.from_id
      WHERE rl.to_id = ${opts.toId}
        AND rl.link_type = ${opts.linkType}
        AND r.type = ${opts.fromType}`
    return (rows[0] as { count: number }).count
  }

  async findLinkByFromAndType(fromId: string, linkType: string): Promise<Pick<ResourceLink, 'to_id'> | null> {
    const rows = await this.sql`SELECT to_id FROM resource_links WHERE from_id = ${fromId} AND link_type = ${linkType} LIMIT 1`
    return (rows[0] as unknown as Pick<ResourceLink, 'to_id'>) ?? null
  }

  async findByTypeAndIds(type: string, ids: string[]): Promise<Resource[]> {
    if (ids.length === 0) return []
    const sql = this.sql
    const rows = await sql`SELECT * FROM resources WHERE type = ${type} AND id::text = ANY(${sql.array(ids)})`
    return rows as unknown as Resource[]
  }

  async findByTypeAndName(type: string, name: string): Promise<Pick<Resource, 'id' | 'config' | 'updated_at'> | null> {
    const rows = await this.sql`SELECT id, config, updated_at FROM resources WHERE type = ${type} AND name = ${name}`
    return (rows[0] as unknown as Pick<Resource, 'id' | 'config' | 'updated_at'>) ?? null
  }

  async resolveUserProjects(callerUserId: string): Promise<Set<string>> {
    const user = await this.findByExternalId('user', callerUserId)
    if (!user) return new Set()
    const rows = await this.sql`
      SELECT to_id FROM resource_links
      WHERE from_id = ${user.id} AND link_type = 'member_of'
    `
    return new Set(rows.map((r: { to_id: string }) => r.to_id))
  }

  async resolveDefaultProject(sub: string): Promise<{ id: string; name: string } | null> {
    const userName = `user:${sub}`
    const rows = await this.sql`
      SELECT p.id, p.name FROM resources p
      JOIN resource_links rl ON rl.to_id = p.id AND rl.link_type = 'member_of'
      JOIN resources u ON u.id = rl.from_id AND u.type = 'user' AND u.name = ${userName}
      WHERE p.type = 'project'
      ORDER BY p.created_at ASC
      LIMIT 1
    `
    const row = rows[0] as { id: string; name: string } | undefined
    return row ?? null
  }

  async listUserProjects(sub: string): Promise<Array<{ id: string; name: string; created_at: string }>> {
    const userName = `user:${sub}`
    const rows = await this.sql`
      SELECT p.id, p.name, p.created_at FROM resources p
      JOIN resource_links rl ON rl.to_id = p.id AND rl.link_type = 'member_of'
      JOIN resources u ON u.id = rl.from_id AND u.type = 'user' AND u.name = ${userName}
      WHERE p.type = 'project'
      ORDER BY p.created_at ASC
    `
    return rows as unknown as Array<{ id: string; name: string; created_at: string }>
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private async _resolveResourceId(name: string): Promise<string> {
    const rows = await this.sql`SELECT id FROM resources WHERE name = ${name}`
    if (!rows[0]) throw new Error(`Resource not found: ${name}`)
    return (rows[0] as { id: string }).id
  }

  private async _resolveResource(name: string): Promise<{ id: string; type: string }> {
    const rows = await this.sql`SELECT id, type FROM resources WHERE name = ${name}`
    if (!rows[0]) throw new Error(`Resource not found: ${name}`)
    return rows[0] as unknown as { id: string; type: string }
  }

  private async _getLinkType(name: string): Promise<LinkType | null> {
    const rows = await this.sql`SELECT name, description, cardinality, created_at FROM link_types WHERE name = ${name}`
    return (rows[0] as unknown as LinkType) ?? null
  }
}
