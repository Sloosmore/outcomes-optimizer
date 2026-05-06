import type { OntologyStorageAdapter, ProcessRow, CronDetail, MetricSnapshot } from '../lib/ontology-adapter.js'
import type {
  ResourceType,
  Resource,
  ResourceLink,
  ResourceLinkCount,
  LinkType,
  LinkTypeRule,
  LinkTypeRuleWithCardinality,
  ValueType,
  ResourceTypeProperty,
} from '@skill-networks/database'
import { OntologyError, OntologyErrorCode } from '../lib/ontology-error.js'

function uuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0
    const v = c === 'x' ? r : (r & 0x3 | 0x8)
    return v.toString(16)
  })
}

function now(): string {
  return new Date().toISOString()
}

export class InMemoryOntologyAdapter implements OntologyStorageAdapter {
  private resources = new Map<string, Resource>()
  private resourceLinks: ResourceLink[] = []
  private linkTypes = new Map<string, LinkType>()
  private linkTypeRules: LinkTypeRule[] = []
  private valueTypes = new Map<string, ValueType>()
  private resourceTypeProperties = new Map<string, ResourceTypeProperty[]>()
  private resourceTypes = new Map<string, ResourceType>()
  private processes = new Map<string, ProcessRow & { id: string; name: string }>()
  private epochResults: Array<{ campaign_id: string; epoch_number: number; status: string; state_snapshot: unknown | null; completed_at: Date | null }> = []

  // Seeding helpers for tests
  seedLinkType(lt: LinkType): void {
    this.linkTypes.set(lt.name, lt)
  }

  seedLinkTypeRule(rule: LinkTypeRule): void {
    this.linkTypeRules.push(rule)
  }

  seedResourceType(rt: ResourceType): void {
    this.resourceTypes.set(rt.name, rt)
  }

  seedValueType(vt: ValueType): void {
    this.valueTypes.set(vt.name, vt)
  }

  async getResourceTypes(): Promise<ResourceType[]> {
    return [...this.resourceTypes.values()]
  }

  async addResource(name: string, type: string, config?: Record<string, unknown>, notes?: string, status?: string): Promise<Resource> {
    if (this.resources.has(name)) {
      throw new OntologyError(OntologyErrorCode.DUPLICATE_RESOURCE, `Resource already exists: ${name}`)
    }
    const resource: Resource = {
      id: uuid(),
      name,
      type,
      status: status ?? 'active',
      config: config ?? null,
      notes: notes ?? null,
      locked_by: null,
      locked_at: null,
      created_at: now(),
      updated_at: now(),
    }
    this.resources.set(name, resource)
    return resource
  }

  async listResources(opts?: { type?: string; status?: string }): Promise<Resource[]> {
    let results = [...this.resources.values()]
    if (opts?.type) results = results.filter(r => r.type === opts.type)
    if (opts?.status) results = results.filter(r => r.status === opts.status)
    return results.sort((a, b) => a.name.localeCompare(b.name))
  }

  async searchResources(query?: string, opts?: { type?: string }): Promise<Resource[]> {
    const lower = (query ?? '').toLowerCase()
    let results = [...this.resources.values()].filter(r =>
      r.name.toLowerCase().includes(lower) ||
      JSON.stringify(r.config ?? {}).toLowerCase().includes(lower)
    )
    if (opts?.type) results = results.filter(r => r.type === opts.type)
    return results.sort((a, b) => a.name.localeCompare(b.name))
  }

  async getResource(name: string): Promise<Resource | null> {
    return this.resources.get(name) ?? null
  }

  async getResourceById(id: string): Promise<Resource | null> {
    for (const r of this.resources.values()) {
      if (r.id === id) return r
    }
    return null
  }

  async getAvailableResources(type: string): Promise<Resource[]> {
    return [...this.resources.values()]
      .filter(r => r.type === type && r.locked_by === null)
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  async updateResource(id: string, updates: { config?: Record<string, unknown> }): Promise<Resource> {
    for (const [name, r] of this.resources.entries()) {
      if (r.id === id) {
        const updated: Resource = {
          ...r,
          config: updates.config !== undefined ? updates.config : r.config,
          updated_at: now(),
        }
        this.resources.set(name, updated)
        return updated
      }
    }
    throw new OntologyError(OntologyErrorCode.RESOURCE_NOT_FOUND, `Resource not found: ${id}`)
  }

  async removeResource(name: string): Promise<void> {
    const resource = this.resources.get(name)
    if (!resource) {
      throw new OntologyError(OntologyErrorCode.RESOURCE_NOT_FOUND, `Resource not found: ${name}`)
    }
    // Mirror ON DELETE CASCADE: remove links involving this resource
    this.resourceLinks = this.resourceLinks.filter(
      l => l.from_id !== resource.id && l.to_id !== resource.id
    )
    this.resources.delete(name)
  }

  async removeResourceById(id: string): Promise<void> {
    for (const [name, resource] of this.resources) {
      if (resource.id === id) {
        this.resourceLinks = this.resourceLinks.filter(
          l => l.from_id !== id && l.to_id !== id
        )
        this.resources.delete(name)
        return
      }
    }
    throw new OntologyError(OntologyErrorCode.RESOURCE_NOT_FOUND, `Resource not found: ${id}`)
  }

  async checkoutResource(name: string, lockerId: string): Promise<Resource> {
    const r = this.resources.get(name)
    if (!r) throw new Error(`Resource not found: ${name}`)
    if (r.locked_by !== null) throw new Error(`already locked by ${r.locked_by}`)
    const updated: Resource = { ...r, locked_by: lockerId, locked_at: now(), updated_at: now() }
    this.resources.set(name, updated)
    return updated
  }

  async releaseResource(name: string, lockerId: string): Promise<Resource> {
    const r = this.resources.get(name)
    if (!r) throw new Error(`Resource not found: ${name}`)
    if (!r.locked_by) throw new Error(`Resource is not locked: ${name}`)
    if (r.locked_by !== lockerId) throw new Error(`Cannot release: resource is locked by ${r.locked_by}, not ${lockerId}`)
    const updated: Resource = { ...r, locked_by: null, locked_at: null, updated_at: now() }
    this.resources.set(name, updated)
    return updated
  }

  async createResourceLink(fromName: string, toName: string, linkType: string): Promise<{ link: ResourceLink; created: boolean }> {
    const lt = this.linkTypes.get(linkType)
    if (!lt) throw new OntologyError(OntologyErrorCode.INVALID_LINK_TYPE, `Invalid link type: ${linkType}`)

    const from = this.resources.get(fromName)
    if (!from) throw new Error(`Resource not found: ${fromName}`)
    const to = this.resources.get(toName)
    if (!to) throw new Error(`Resource not found: ${toName}`)

    const rules = this.linkTypeRules.filter(r => r.link_type === linkType)
    if (rules.length === 0) throw new Error(`Link type '${linkType}' has no rules defined — cannot validate type pairing`)

    const matched = rules.some(rule =>
      (rule.from_type === null || rule.from_type === from.type) &&
      (rule.to_type === null || rule.to_type === to.type)
    )
    if (!matched) {
      throw new OntologyError(OntologyErrorCode.TYPE_MISMATCH, `Invalid link: ${from.type} → ${to.type} does not match any rule for type '${linkType}'`)
    }

    const existing = this.resourceLinks.find(l => l.from_id === from.id && l.to_id === to.id && l.link_type === linkType)
    if (existing) return { link: existing, created: false }

    const link: ResourceLink = {
      from_id: from.id,
      to_id: to.id,
      link_type: linkType,
      created_at: now(),
    }
    this.resourceLinks.push(link)
    return { link, created: true }
  }

  async createResourceLinkById(fromId: string, toId: string, linkType: string): Promise<{ link: ResourceLink; created: boolean }> {
    const from = [...this.resources.values()].find(r => r.id === fromId)
    if (!from) throw new Error(`Resource not found: ${fromId}`)
    const to = [...this.resources.values()].find(r => r.id === toId)
    if (!to) throw new Error(`Resource not found: ${toId}`)
    return this.createResourceLink(from.name, to.name, linkType)
  }

  async deleteResourceLink(fromName: string, toName: string, linkType: string): Promise<void> {
    const lt = this.linkTypes.get(linkType)
    if (!lt) throw new OntologyError(OntologyErrorCode.INVALID_LINK_TYPE, `Invalid link type: ${linkType}`)

    const from = this.resources.get(fromName)
    if (!from) throw new Error(`Resource not found: ${fromName}`)
    const to = this.resources.get(toName)
    if (!to) throw new Error(`Resource not found: ${toName}`)

    const idx = this.resourceLinks.findIndex(l => l.from_id === from.id && l.to_id === to.id && l.link_type === linkType)
    if (idx === -1) throw new Error(`Link not found: ${fromName} → ${toName} (type: ${linkType})`)
    this.resourceLinks.splice(idx, 1)
  }

  async deleteResourceLinkById(fromId: string, toId: string, linkType: string): Promise<void> {
    const lt = this.linkTypes.get(linkType)
    if (!lt) throw new OntologyError(OntologyErrorCode.INVALID_LINK_TYPE, `Invalid link type: ${linkType}`)
    const idx = this.resourceLinks.findIndex(l => l.from_id === fromId && l.to_id === toId && l.link_type === linkType)
    if (idx === -1) throw new Error(`Link not found: ${fromId} → ${toId} (type: ${linkType})`)
    this.resourceLinks.splice(idx, 1)
  }

  async getResourceLinkCounts(resourceId: string): Promise<ResourceLinkCount[]> {
    const counts = new Map<string, number>()
    for (const link of this.resourceLinks) {
      if (link.from_id === resourceId) {
        counts.set(link.link_type, (counts.get(link.link_type) ?? 0) + 1)
      }
    }
    return [...counts.entries()].map(([link_type, count]) => ({ link_type, count }))
  }

  async listAllResourceLinks(): Promise<ResourceLink[]> {
    return [...this.resourceLinks]
  }

  async listLinksToId(opts: { toId: string; linkType: string }): Promise<Pick<ResourceLink, 'from_id'>[]> {
    return this.resourceLinks
      .filter(l => l.to_id === opts.toId && l.link_type === opts.linkType)
      .map(l => ({ from_id: l.from_id }))
  }

  async findLinkByFromAndType(fromId: string, linkType: string): Promise<Pick<ResourceLink, 'to_id'> | null> {
    const link = this.resourceLinks.find(l => l.from_id === fromId && l.link_type === linkType)
    return link ? { to_id: link.to_id } : null
  }

  async getLinkTypes(): Promise<LinkType[]> {
    return [...this.linkTypes.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  async getLinkType(name: string): Promise<LinkType | null> {
    return this.linkTypes.get(name) ?? null
  }

  async getLinkTypeRules(opts?: { linkType?: string }): Promise<LinkTypeRule[]> {
    let rules = [...this.linkTypeRules]
    if (opts?.linkType) rules = rules.filter(r => r.link_type === opts.linkType)
    return rules.sort((a, b) => a.link_type.localeCompare(b.link_type))
  }

  async getLinkTypeRulesWithCardinality(_opts?: { fromType?: string; toType?: string }): Promise<LinkTypeRuleWithCardinality[]> {
    // Return empty for simplicity - InMemory adapter is for testing cron commands specifically
    return []
  }

  async getValueTypes(): Promise<ValueType[]> {
    return [...this.valueTypes.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  async getValueTypeByName(name: string): Promise<ValueType | null> {
    return this.valueTypes.get(name) ?? null
  }

  async getResourceTypeProperties(resourceType: string): Promise<ResourceTypeProperty[]> {
    return this.resourceTypeProperties.get(resourceType) ?? []
  }

  async listProcesses(filter?: { status?: string }): Promise<ProcessRow[]> {
    const all = [...this.processes.values()]
    // Group by root_process_id, keep latest per group (leaf)
    const leafMap = new Map<string, typeof all[0]>()
    for (const p of all) {
      const rootId = p.root_process_id ?? p.id
      const existing = leafMap.get(rootId)
      if (!existing || (p.created_at?.getTime() ?? 0) > (existing.created_at?.getTime() ?? 0)) {
        leafMap.set(rootId, p)
      }
    }
    let results = [...leafMap.values()].sort((a, b) => {
      const aTime = a.updated_at?.getTime() ?? 0
      const bTime = b.updated_at?.getTime() ?? 0
      return bTime - aTime
    })
    if (filter?.status) results = results.filter(r => r.status === filter.status)
    return results.slice(0, 200)
  }

  async initProcess(name: string, opts?: {
    branch?: string
    runType?: string
    skillResourceId?: string
    trainingSetId?: string
    resolvedTrainingResourceId?: string | null
    channelId?: string | null
    status?: string
    prompt?: string
    parentProcessId?: string
    worktreePath?: string
    projectId?: string
  }): Promise<string> {
    const id = uuid()
    const p: ProcessRow & { id: string; name: string } = {
      id,
      name,
      status: opts?.status ?? 'pending',
      current_epoch: null,
      updated_at: new Date(),
      created_at: new Date(),
      started_at: null,
      completed_at: null,
      branch: opts?.branch ?? null,
      training_resource_id: opts?.resolvedTrainingResourceId ?? opts?.trainingSetId ?? null,
      resume_at: null,
      worktree_path: opts?.worktreePath ?? null,
      resume_context: opts?.prompt ? JSON.stringify({ prompt: opts.prompt }) : null,
      root_process_id: id,
      channel_id: opts?.channelId ?? null,
      skill_resource_id: opts?.skillResourceId ?? null,
    }
    this.processes.set(id, p)
    return id
  }

  async getProcessById(id: string): Promise<ProcessRow | null> {
    return this.processes.get(id) ?? null
  }

  async getProcessByName(name: string): Promise<ProcessRow | null> {
    const matches = [...this.processes.values()]
      .filter(p => p.name === name)
      .sort((a, b) => (b.updated_at?.getTime() ?? 0) - (a.updated_at?.getTime() ?? 0))
    return matches[0] ?? null
  }

  async getProcessEpochs(processId: string, limit: number = 10): Promise<Array<{ epoch_number: number; status: string; completed_at: Date | null }>> {
    return this.epochResults
      .filter(e => e.campaign_id === processId)
      .sort((a, b) => b.epoch_number - a.epoch_number)
      .slice(0, limit)
      .map(e => ({ epoch_number: e.epoch_number, status: e.status, completed_at: e.completed_at }))
  }

  async sleepProcess(id: string, interval: string, resumeContext?: string | null): Promise<{ resume_at: Date; new_segment_id: string }> {
    const p = this.processes.get(id)
    if (!p) throw new Error(`Process not found: ${id}`)
    // Simple interval parsing for tests — create a new segment
    const resume_at = new Date(Date.now() + 60000)
    p.status = 'completed'
    p.completed_at = new Date()
    p.updated_at = new Date()
    const newId = crypto.randomUUID()
    const parentCreatedAt = p.created_at?.getTime() ?? Date.now()
    const rootProcessId = p.root_process_id ?? p.id
    // Count segments sharing the same root to match Postgres naming behaviour
    const segmentCount = [...this.processes.values()].filter(
      proc => (proc.root_process_id ?? proc.id) === rootProcessId
    ).length
    const rootProcess = this.processes.get(rootProcessId)
    const rootName = rootProcess?.name ?? p.name.replace(/-s\d+$/, '')
    const newSegment = {
      ...p,
      id: newId,
      status: 'waiting' as string,
      resume_at,
      resume_context: resumeContext ?? null,
      started_at: null as Date | null,
      completed_at: null as Date | null,
      root_process_id: rootProcessId,
      name: `${rootName}-s${segmentCount + 1}`,
      updated_at: new Date(),
      // Ensure the new segment is strictly after its parent so leaf detection is deterministic
      created_at: new Date(Math.max(Date.now(), parentCreatedAt + 1)),
    }
    this.processes.set(newId, newSegment)
    return { resume_at, new_segment_id: newId }
  }

  async resolveProcessId(nameOrId: string, isId: boolean): Promise<string> {
    if (isId) {
      const p = this.processes.get(nameOrId)
      if (!p) throw new Error(`Process not found: ID "${nameOrId}"`)
      return p.id
    } else {
      const p = [...this.processes.values()].find(proc => proc.name === nameOrId)
      if (!p) throw new Error(`Process not found: name "${nameOrId}"`)
      return p.id
    }
  }

  async upsertEpochResult(processId: string, epochNumber: number, data: Record<string, unknown>): Promise<void> {
    const existing = this.epochResults.findIndex(e => e.campaign_id === processId && e.epoch_number === epochNumber)
    const entry = {
      campaign_id: processId,
      epoch_number: epochNumber,
      status: 'completed',
      state_snapshot: data.state_snapshot !== undefined ? data.state_snapshot : null,
      completed_at: new Date(),
    }
    if (existing >= 0) {
      this.epochResults[existing] = entry
    } else {
      this.epochResults.push(entry)
    }
  }

  async listEnabledCrons(): Promise<Resource[]> {
    return [...this.resources.values()]
      .filter(r => r.type === 'cron' && (r.config as Record<string, unknown> | null)?.enabled === true)
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  async listCronsWithDetails(): Promise<CronDetail[]> {
    const crons = [...this.resources.values()].filter(r => r.type === 'cron')
    return crons.map(cron => {
      const config = (cron.config ?? {}) as Record<string, unknown>
      // Find linked goal via resource_links
      const link = this.resourceLinks.find(l => l.from_id === cron.id && l.link_type === 'schedules')
      const goal = link ? [...this.resources.values()].find(r => r.id === link.to_id) : undefined
      return {
        id: cron.id,
        name: cron.name,
        schedule: String(config.schedule ?? ''),
        enabled: Boolean(config.enabled),
        prompt: String(config.prompt ?? ''),
        skillId: goal?.id ?? null,
        skillName: goal?.name ?? null,
        createdAt: String(cron.created_at ?? ''),
      }
    }).sort((a, b) => a.name.localeCompare(b.name))
  }

  async recordMetricSnapshot(_skillId: string, _metricKey: string, _value: number, _metadata?: Record<string, unknown>, _measuredAt?: string): Promise<void> {
    throw new Error('recordMetricSnapshot not implemented in InMemoryOntologyAdapter')
  }

  async getLatestMetrics(_skillId: string): Promise<MetricSnapshot[]> {
    throw new Error('getLatestMetrics not implemented in InMemoryOntologyAdapter')
  }

  async getMetricHistory(_skillId: string, _metricKey: string, _days: number): Promise<MetricSnapshot[]> {
    throw new Error('getMetricHistory not implemented in InMemoryOntologyAdapter')
  }

  async metricsLatestByKey(_key: string): Promise<MetricSnapshot[]> {
    return []
  }

  async metricsHistoryByKey(_key: string, _days: number): Promise<MetricSnapshot[]> {
    return []
  }

  async activateProcess(id: string): Promise<void> {
    const p = this.processes.get(id)
    if (!p) throw new Error('Process not found: ' + id)
    p.status = 'active'
    p.updated_at = new Date()
  }

  async completeProcess(id: string): Promise<void> {
    const p = this.processes.get(id)
    if (!p) throw new Error('Process not found: ' + id)
    p.status = 'completed'
    p.updated_at = new Date()
  }

  async failProcess(id: string, reason?: string): Promise<void> {
    const p = this.processes.get(id)
    if (!p) throw new Error('Process not found: ' + id)
    p.status = 'failed'
    p.updated_at = new Date()
    void reason
  }

  async blockProcess(id: string, reason: string, worktreePath?: string | null): Promise<void> {
    const p = this.processes.get(id)
    if (!p) throw new Error('Process not found: ' + id)
    p.status = 'blocked'
    p.worktree_path = worktreePath ?? null
    p.updated_at = new Date()
    void reason
  }

  async resetProcess(id: string): Promise<void> {
    const p = this.processes.get(id)
    if (!p) throw new Error('Process not found: ' + id)
    p.status = 'pending'
    p.updated_at = new Date()
  }

  async claimProcess(id: string): Promise<boolean> {
    const p = this.processes.get(id)
    if (!p) throw new Error('Process not found: ' + id)
    if (p.status === 'waiting') {
      p.status = 'active'
      p.updated_at = new Date()
      return true
    }
    return false
  }

  async resolveTrainingSetId(_name: string): Promise<string> {
    throw new Error('InMemoryOntologyAdapter.resolveTrainingSetId is not implemented')
  }

  async updateProcessFields(opts: { id?: string; name?: string; channelId?: string; worktreePath?: string }): Promise<string> {
    // Resolve the process
    let p: (ProcessRow & { id: string; name: string }) | undefined
    if (opts.id) {
      p = this.processes.get(opts.id)
    } else if (opts.name) {
      const matches = [...this.processes.values()]
        .filter(proc => proc.name === opts.name)
        .sort((a, b) => (b.updated_at?.getTime() ?? 0) - (a.updated_at?.getTime() ?? 0))
      p = matches[0]
    }
    if (!p) throw new Error('Process not found')
    if (opts.channelId !== undefined) p.channel_id = opts.channelId
    if (opts.worktreePath !== undefined) p.worktree_path = opts.worktreePath
    p.updated_at = new Date()
    return p.id
  }

  async restartProcess(_deadId: string): Promise<{ newId: string; originalProcess: ProcessRow }> {
    throw new Error('InMemoryOntologyAdapter.restartProcess is not implemented')
  }

  async listProjectsForUser(_sub: string): Promise<Array<{ id: string; name: string; created_at: string }>> {
    throw new Error('InMemoryOntologyAdapter.listProjectsForUser is not implemented')
  }

  async resolveDefaultProject(_sub: string): Promise<{ id: string; name: string } | null> {
    throw new Error('InMemoryOntologyAdapter.resolveDefaultProject is not implemented')
  }

  async updateResourceContent(id: string, content: string): Promise<void> {
    for (const [name, r] of this.resources.entries()) {
      if (r.id === id) {
        const updated: Resource = { ...r, config: { ...(r.config ?? {}), content }, updated_at: now() }
        this.resources.set(name, updated)
        return
      }
    }
    throw new OntologyError(OntologyErrorCode.RESOURCE_NOT_FOUND, `Resource not found: ${id}`)
  }

  async insertAgentEvent(_args: { processId: string; processName: string; resourceId: string | null; source: string; payload: Record<string, unknown> }): Promise<void> {
    // No-op for in-memory adapter
  }

  async updateProcessAggregate(processId: string, touchedEpochs?: number[]): Promise<void> {
    const p = this.processes.get(processId)
    if (!p) return

    const completed = this.epochResults.filter(e => e.campaign_id === processId && e.status === 'completed')
    if (completed.length === 0) return

    const completedMax = Math.max(...completed.map(e => e.epoch_number))
    const touchedMax = touchedEpochs && touchedEpochs.length > 0 ? Math.max(...touchedEpochs) : 0
    p.current_epoch = Math.max(completedMax, touchedMax)
    if (p.status === 'pending') p.status = 'active'
    p.updated_at = new Date()
  }
}
