import type { OntologyStorageAdapter, ProcessRow, CronDetail } from '../lib/ontology-adapter.js'
import { getSqlClient } from '@skill-networks/database/client'
import { ProcessesService, ResourcesService, MetricsService, EventsService } from '@skill-networks/database'
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
  MetricSnapshot,
  AgentEventSource,
} from '@skill-networks/database'
import type { ProjectScope } from '@skill-networks/database/services'
import { OntologyError, OntologyErrorCode } from '../lib/ontology-error.js'

export class PostgresOntologyAdapter implements OntologyStorageAdapter {
  private readonly opts: { scope?: ProjectScope }

  constructor(opts: { scope?: ProjectScope } = {}) {
    this.opts = opts
  }

  private get sql() { return getSqlClient() }
  private get resourcesService() { return new ResourcesService(this.sql) }
  private get processesService() { return new ProcessesService(this.sql) }
  private get metricsService() { return new MetricsService(this.sql) }
  private get eventsService() { return new EventsService(this.sql) }

  async getResourceTypes(): Promise<ResourceType[]> {
    return this.resourcesService.getTypes()
  }

  async addResource(name: string, type: string, config?: Record<string, unknown>, notes?: string, status?: string): Promise<Resource> {
    try {
      return await this.resourcesService.add(name, type, config, notes, status)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.includes('duplicate') || msg.includes('unique')) {
        throw new OntologyError(OntologyErrorCode.DUPLICATE_RESOURCE, `Resource already exists: ${name}`)
      }
      throw e
    }
  }

  async listResources(opts?: { type?: string; status?: string }): Promise<Resource[]> {
    const rows = await this.resourcesService.list(opts)
    return this.opts.scope ? this.opts.scope.filterResources(rows) : rows
  }

  async searchResources(query?: string, opts?: { type?: string }): Promise<Resource[]> {
    const rows = await this.resourcesService.search(query ?? '', opts)
    return this.opts.scope ? this.opts.scope.filterResources(rows) : rows
  }

  async getResource(name: string): Promise<Resource | null> {
    const result = await this.resourcesService.getByName(name)
    if (this.opts.scope && result && !this.opts.scope.has(result.id)) return null
    return result
  }

  async getResourceById(id: string): Promise<Resource | null> {
    const result = await this.resourcesService.getById(id)
    if (this.opts.scope && result && !this.opts.scope.has(result.id)) return null
    return result
  }

  async getAvailableResources(type: string): Promise<Resource[]> {
    const rows = await this.resourcesService.getAvailable(type)
    return this.opts.scope ? this.opts.scope.filterResources(rows) : rows
  }

  async updateResource(id: string, updates: { config?: Record<string, unknown> }): Promise<Resource> {
    if (updates.config === undefined) {
      throw new Error('updateResource requires config in updates')
    }
    try {
      return await this.resourcesService.updateConfig(id, updates.config)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.includes('Resource not found') || msg.includes('invalid input syntax for type uuid')) {
        throw new OntologyError(OntologyErrorCode.RESOURCE_NOT_FOUND, `Resource not found: ${id}`)
      }
      throw e
    }
  }

  async removeResource(name: string): Promise<void> {
    try {
      return await this.resourcesService.remove(name)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.includes('Resource not found')) {
        throw new OntologyError(OntologyErrorCode.RESOURCE_NOT_FOUND, msg)
      }
      throw e
    }
  }

  async removeResourceById(id: string): Promise<void> {
    if (this.opts.scope && !this.opts.scope.has(id)) {
      throw new OntologyError(OntologyErrorCode.RESOURCE_NOT_FOUND, `Resource not found: ${id}`)
    }
    try {
      return await this.resourcesService.removeById(id)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.includes('Resource not found')) {
        throw new OntologyError(OntologyErrorCode.RESOURCE_NOT_FOUND, msg)
      }
      throw e
    }
  }

  async checkoutResource(name: string, lockerId: string): Promise<Resource> {
    return this.resourcesService.checkout(name, lockerId)
  }

  async releaseResource(name: string, lockerId: string): Promise<Resource> {
    return this.resourcesService.release(name, lockerId)
  }

  async listProjectsForUser(sub: string): Promise<Array<{ id: string; name: string; created_at: string }>> {
    return this.resourcesService.listUserProjects(sub)
  }

  async resolveDefaultProject(sub: string): Promise<{ id: string; name: string } | null> {
    return this.resourcesService.resolveDefaultProject(sub)
  }

  async updateResourceContent(id: string, content: string): Promise<void> {
    return this.resourcesService.updateContent(id, content)
  }

  async insertAgentEvent(args: {
    processId: string
    processName: string
    resourceId: string | null
    source: AgentEventSource
    payload: Record<string, unknown>
  }): Promise<void> {
    return this.eventsService.insertAgentEvent(args)
  }

  async createResourceLink(fromName: string, toName: string, linkType: string): Promise<{ link: ResourceLink; created: boolean }> {
    try {
      return await this.resourcesService.createLink(fromName, toName, linkType)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.includes('Invalid link type')) {
        throw new OntologyError(OntologyErrorCode.INVALID_LINK_TYPE, msg)
      }
      if (msg.includes('does not match any rule')) {
        throw new OntologyError(OntologyErrorCode.TYPE_MISMATCH, msg)
      }
      throw e
    }
  }

  async createResourceLinkById(fromId: string, toId: string, linkType: string): Promise<{ link: ResourceLink; created: boolean }> {
    try {
      return await this.resourcesService.createLinkById(fromId, toId, linkType)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.includes('Invalid link type')) {
        throw new OntologyError(OntologyErrorCode.INVALID_LINK_TYPE, msg)
      }
      if (msg.includes('does not match any rule')) {
        throw new OntologyError(OntologyErrorCode.TYPE_MISMATCH, msg)
      }
      throw e
    }
  }

  async deleteResourceLink(fromName: string, toName: string, linkType: string): Promise<void> {
    try {
      return await this.resourcesService.deleteLink(fromName, toName, linkType)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.includes('Invalid link type')) {
        throw new OntologyError(OntologyErrorCode.INVALID_LINK_TYPE, msg)
      }
      throw e
    }
  }

  async deleteResourceLinkById(fromId: string, toId: string, linkType: string): Promise<void> {
    try {
      return await this.resourcesService.deleteLinkById(fromId, toId, linkType)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.includes('Invalid link type')) {
        throw new OntologyError(OntologyErrorCode.INVALID_LINK_TYPE, msg)
      }
      throw e
    }
  }

  async getResourceLinkCounts(resourceId: string): Promise<ResourceLinkCount[]> {
    if (this.opts.scope && !this.opts.scope.has(resourceId)) return []
    return this.resourcesService.getLinkCounts(resourceId)
  }

  async listAllResourceLinks(): Promise<ResourceLink[]> {
    const links = await this.resourcesService.listAllLinks()
    return this.opts.scope ? this.opts.scope.filterLinks(links) : links
  }

  async listLinksToId(opts: { toId: string; linkType: string }): Promise<Pick<ResourceLink, 'from_id'>[]> {
    return this.resourcesService.listLinksToId(opts)
  }

  async findLinkByFromAndType(fromId: string, linkType: string): Promise<Pick<ResourceLink, 'to_id'> | null> {
    return this.resourcesService.findLinkByFromAndType(fromId, linkType)
  }

  async getLinkTypes(): Promise<LinkType[]> {
    return this.resourcesService.getLinkTypes()
  }

  async getLinkType(name: string): Promise<LinkType | null> {
    return this.resourcesService.getLinkTypeByName(name)
  }

  async getLinkTypeRules(opts?: { linkType?: string }): Promise<LinkTypeRule[]> {
    return this.resourcesService.getLinkTypeRules(opts)
  }

  async getLinkTypeRulesWithCardinality(opts?: { fromType?: string; toType?: string }): Promise<LinkTypeRuleWithCardinality[]> {
    return this.resourcesService.getLinkTypeRulesWithCardinality(opts)
  }

  async listProcesses(filter?: { status?: string }): Promise<ProcessRow[]> {
    const rows = await this.processesService.listLeaves()
    const scoped = this.opts.scope ? this.opts.scope.filterProcesses(rows) : rows
    const filtered = filter?.status ? scoped.filter(r => r.status === filter.status) : scoped
    return filtered.slice(0, 200)
  }

  async getValueTypes(): Promise<ValueType[]> {
    return this.resourcesService.getValueTypes()
  }

  async getValueTypeByName(name: string): Promise<ValueType | null> {
    return this.resourcesService.getValueTypeByName(name)
  }

  async getResourceTypeProperties(resourceType: string): Promise<ResourceTypeProperty[]> {
    return this.resourcesService.getTypeProperties(resourceType)
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
    const { branch, runType, skillResourceId, trainingSetId, channelId, status, prompt, parentProcessId, worktreePath, projectId } = opts ?? {}
    let resolvedTrainingResourceId: string | null = opts?.resolvedTrainingResourceId ?? trainingSetId ?? null
    if (trainingSetId && opts?.resolvedTrainingResourceId === undefined) {
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      if (!UUID_RE.test(trainingSetId)) {
        resolvedTrainingResourceId = await this.processesService.resolveTrainingSetId(trainingSetId)
      }
    }
    return this.processesService.init({ name, branch, runType, skillResourceId, resolvedTrainingResourceId, channelId, status, prompt, parentProcessId, worktreePath, projectId })
  }

  async getProcessById(id: string): Promise<ProcessRow | null> {
    const result = await this.processesService.getById(id)
    if (this.opts.scope && result) {
      if (!result.project_id || !this.opts.scope.projectIds.has(result.project_id)) return null
    }
    return result
  }

  async getProcessByName(name: string): Promise<ProcessRow | null> {
    const rows = await this.processesService.getByName(name)
    // Filter by scope if set
    const filtered = this.opts.scope
      ? rows.filter(r => r.project_id && this.opts.scope!.projectIds.has(r.project_id))
      : rows
    return filtered[0] ?? null  // Return latest (getByName returns newest-first)
  }

  async getProcessEpochs(processId: string, limit: number = 10): Promise<Array<{ epoch_number: number; status: string; completed_at: Date | null }>> {
    return this.processesService.getEpochs(processId, limit)
  }

  async sleepProcess(id: string, interval: string, resumeContext?: string | null): Promise<{ resume_at: Date; new_segment_id: string }> {
    return this.processesService.sleep(id, interval, resumeContext ?? undefined)
  }

  async resolveProcessId(nameOrId: string, isId: boolean): Promise<string> {
    if (isId) {
      const proc = await this.getProcessById(nameOrId)
      if (!proc) throw new Error(`Process not found: ID "${nameOrId}"`)
      return proc.id
    } else {
      const proc = await this.getProcessByName(nameOrId)
      if (!proc) throw new Error(`Process not found: name "${nameOrId}"`)
      return proc.id
    }
  }

  async upsertEpochResult(processId: string, epochNumber: number, data: Record<string, unknown>): Promise<void> {
    return this.processesService.upsertEpochResult(processId, epochNumber, data)
  }

  async updateProcessAggregate(processId: string, touchedEpochs?: number[]): Promise<void> {
    return this.processesService.updateAggregate(processId, touchedEpochs ?? [])
  }

  async activateProcess(id: string): Promise<void> {
    return this.processesService.activate(id)
  }

  async completeProcess(id: string): Promise<void> {
    return this.processesService.complete(id)
  }

  async failProcess(id: string, reason?: string): Promise<void> {
    return this.processesService.fail(id, reason)
  }

  async blockProcess(id: string, reason: string, worktreePath?: string | null): Promise<void> {
    const proc = await this.processesService.getById(id)
    if (!proc) throw new Error(`Process not found: ${id}`)
    const sql = this.sql
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await sql.begin(async (tx: any) => {
      await new ProcessesService(tx).block(id, reason, worktreePath)
      await new EventsService(tx).insertAgentEvent({
        processId: id,
        processName: proc.name,
        resourceId: proc.skill_resource_id ?? null,
        source: 'process_blocked',
        payload: { reason, worktree_path: worktreePath ?? null },
      })
    })
  }

  async resetProcess(id: string): Promise<void> {
    return this.processesService.reset(id)
  }

  async claimProcess(id: string): Promise<boolean> {
    return this.processesService.claim(id)
  }

  async resolveTrainingSetId(name: string): Promise<string> {
    return this.processesService.resolveTrainingSetId(name)
  }

  async updateProcessFields(opts: { id?: string; name?: string; channelId?: string; worktreePath?: string }): Promise<string> {
    return this.processesService.updateFields(opts)
  }

  async restartProcess(deadId: string): Promise<{ newId: string; originalProcess: ProcessRow }> {
    return this.processesService.restart(deadId)
  }

  async listEnabledCrons(): Promise<Resource[]> {
    const rows = await this.resourcesService.list({ type: 'cron', status: 'active' })
    return this.opts.scope ? this.opts.scope.filterResources(rows) : rows
  }

  async recordMetricSnapshot(skillId: string, metricKey: string, value: number, metadata?: Record<string, unknown>, measuredAt?: string): Promise<void> {
    return this.metricsService.record(skillId, metricKey, value, metadata, measuredAt)
  }

  async getLatestMetrics(skillId: string): Promise<MetricSnapshot[]> {
    return this.metricsService.getLatest(skillId)
  }

  async getMetricHistory(skillId: string, metricKey: string, days: number): Promise<MetricSnapshot[]> {
    return this.metricsService.getHistory(skillId, metricKey, days)
  }

  async metricsLatestByKey(key: string): Promise<MetricSnapshot[]> {
    return this.metricsService.latestByKey(key)
  }

  async metricsHistoryByKey(key: string, days: number): Promise<MetricSnapshot[]> {
    return this.metricsService.historyByKey(key, days)
  }

  async listCronsWithDetails(): Promise<CronDetail[]> {
    const rows = await this.resourcesService.listCronsWithDetails()
    const filtered = this.opts.scope ? rows.filter(r => this.opts.scope!.has(r.id)) : rows
    return filtered.map(r => ({
      id: r.id,
      name: r.name,
      schedule: r.schedule,
      enabled: r.enabled,
      prompt: r.prompt ?? '',
      skillId: r.skill_id,
      skillName: r.skill_name,
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    }))
  }
}
