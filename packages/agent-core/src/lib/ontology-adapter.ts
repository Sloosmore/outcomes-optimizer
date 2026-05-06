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
} from '@skill-networks/database'

export type { ResourceType, Resource, ResourceLink, ResourceLinkCount, LinkType, LinkTypeRule, LinkTypeRuleWithCardinality, ValueType, ResourceTypeProperty, MetricSnapshot }

export interface CronDetail {
  id: string
  name: string
  schedule: string
  enabled: boolean
  prompt: string
  skillId: string | null
  skillName: string | null
  createdAt: string
}

export interface ProcessRow {
  id: string
  name: string
  status: string
  current_epoch: number | null
  updated_at: Date | null
  created_at: Date | null
  started_at: Date | null
  completed_at: Date | null
  branch: string | null
  training_resource_id: string | null
  resume_at: Date | null
  worktree_path: string | null
  resume_context: string | null
  root_process_id: string | null
  channel_id: string | null
  skill_resource_id: string | null
}

export interface OntologyStorageAdapter {
  // Resource types
  getResourceTypes(): Promise<ResourceType[]>                                                       // (): Promise ✓

  // Resources
  addResource(name: string, type: string, config?: Record<string, unknown>, notes?: string, status?: string): Promise<Resource>
  listResources(): Promise<Resource[]>                                                               // (): Promise ✓
  listResources(opts: { type?: string; status?: string }): Promise<Resource[]>
  searchResources(): Promise<Resource[]>                                                             // (): Promise ✓
  searchResources(query: string, opts?: { type?: string }): Promise<Resource[]>
  getResource(name: string): Promise<Resource | null>
  getResourceById(id: string): Promise<Resource | null>
  getAvailableResources(type: string): Promise<Resource[]>
  updateResource(id: string, updates: { config?: Record<string, unknown> }): Promise<Resource>
  removeResource(name: string): Promise<void>
  removeResourceById(id: string): Promise<void>
  checkoutResource(name: string, lockerId: string): Promise<Resource>
  releaseResource(name: string, lockerId: string): Promise<Resource>
  listProjectsForUser(sub: string): Promise<Array<{ id: string; name: string; created_at: string }>>
  resolveDefaultProject(sub: string): Promise<{ id: string; name: string } | null>
  updateResourceContent(id: string, content: string): Promise<void>
  insertAgentEvent(args: { processId: string; processName: string; resourceId: string | null; source: string; payload: Record<string, unknown> }): Promise<void>

  // Links
  createResourceLink(fromName: string, toName: string, linkType: string): Promise<{ link: ResourceLink; created: boolean }>
  createResourceLinkById(fromId: string, toId: string, linkType: string): Promise<{ link: ResourceLink; created: boolean }>
  deleteResourceLink(fromName: string, toName: string, linkType: string): Promise<void>
  deleteResourceLinkById(fromId: string, toId: string, linkType: string): Promise<void>
  getResourceLinkCounts(resourceId: string): Promise<ResourceLinkCount[]>
  listAllResourceLinks(): Promise<ResourceLink[]>                                                    // (): Promise ✓
  // Link query helpers — used by dispatch.ts for runs-link check and parent resolution
  listLinksToId(opts: { toId: string; linkType: string }): Promise<Pick<ResourceLink, 'from_id'>[]>
  findLinkByFromAndType(fromId: string, linkType: string): Promise<Pick<ResourceLink, 'to_id'> | null>

  // Link types
  getLinkTypes(): Promise<LinkType[]>                                                                // (): Promise ✓
  getLinkType(name: string): Promise<LinkType | null>
  getLinkTypeRules(): Promise<LinkTypeRule[]>                                                        // (): Promise ✓
  getLinkTypeRules(opts: { linkType?: string }): Promise<LinkTypeRule[]>
  getLinkTypeRulesWithCardinality(): Promise<LinkTypeRuleWithCardinality[]>                          // (): Promise ✓
  getLinkTypeRulesWithCardinality(opts: { fromType?: string; toType?: string }): Promise<LinkTypeRuleWithCardinality[]>

  // Value types
  getValueTypes(): Promise<ValueType[]>                                                              // (): Promise ✓
  getValueTypeByName(name: string): Promise<ValueType | null>
  getResourceTypeProperties(resourceType: string): Promise<ResourceTypeProperty[]>

  // Process operations
  listProcesses(filter?: { status?: string }): Promise<ProcessRow[]>
  initProcess(name: string, opts?: {
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
  }): Promise<string>
  getProcessById(id: string): Promise<ProcessRow | null>
  getProcessByName(name: string): Promise<ProcessRow | null>
  getProcessEpochs(processId: string, limit?: number): Promise<Array<{ epoch_number: number; status: string; completed_at: Date | null }>>
  sleepProcess(id: string, interval: string, resumeContext?: string | null): Promise<{ resume_at: Date; new_segment_id: string }>
  resolveProcessId(nameOrId: string, isId: boolean): Promise<string>
  upsertEpochResult(processId: string, epochNumber: number, data: Record<string, unknown>): Promise<void>
  updateProcessAggregate(processId: string, touchedEpochs?: number[]): Promise<void>
  activateProcess(id: string): Promise<void>
  completeProcess(id: string): Promise<void>
  failProcess(id: string, reason?: string): Promise<void>
  blockProcess(id: string, reason: string, worktreePath?: string | null): Promise<void>
  resetProcess(id: string): Promise<void>
  claimProcess(id: string): Promise<boolean>
  resolveTrainingSetId(name: string): Promise<string>
  updateProcessFields(opts: { id?: string; name?: string; channelId?: string; worktreePath?: string }): Promise<string>
  restartProcess(deadId: string): Promise<{ newId: string; originalProcess: ProcessRow }>

  // Cron operations (for poller)
  listEnabledCrons(): Promise<Resource[]>                                                            // (): Promise ✓
  listCronsWithDetails(): Promise<CronDetail[]>                                                      // (): Promise ✓

  // Metric snapshots
  recordMetricSnapshot(skillId: string, metricKey: string, value: number, metadata?: Record<string, unknown>, measuredAt?: string): Promise<void>
  getLatestMetrics(skillId: string): Promise<MetricSnapshot[]>
  getMetricHistory(skillId: string, metricKey: string, days: number): Promise<MetricSnapshot[]>
  metricsLatestByKey(key: string): Promise<MetricSnapshot[]>
  metricsHistoryByKey(key: string, days: number): Promise<MetricSnapshot[]>
}
