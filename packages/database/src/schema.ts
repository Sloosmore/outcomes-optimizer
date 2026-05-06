import { pgTable, text, uuid, timestamp, jsonb, numeric, integer, index, uniqueIndex, primaryKey, boolean, unique, doublePrecision, type AnyPgColumn } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

export const traces = pgTable('traces', {
  id: uuid('id').defaultRandom().primaryKey(),
  sessionId: text('session_id').notNull(),

  // Immediate (deterministic) - populated right after session
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  endedAt: timestamp('ended_at', { withTimezone: true }),
  filePath: text('file_path').notNull(),
  cost: numeric('cost'),
  durationMs: numeric('duration_ms'),
}, (table) => ({
  sessionIdKey: unique('traces_session_id_key').on(table.sessionId),
}))

export const tags = pgTable('tags', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  nameKey: unique('tags_name_key').on(table.name),
}))

export const tagEntities = pgTable('tag_entities', {
  entityId: uuid('entity_id').notNull(),
  entityType: text('entity_type').notNull(),
  tagId: uuid('tag_id').notNull().references(() => tags.id, { onDelete: 'cascade' }),
}, (table) => ({
  pk: primaryKey({ columns: [table.entityId, table.entityType, table.tagId] }),
  tagIdIdx: index('tag_entities_tag_id_idx').on(table.tagId),
}))

// Resources — registry of all assets agents operate on. Relationships expressed via resource_links junction table.
// app resources (e.g. Meta app, Google project) are linked to identity/credential resources via resource_links.
// Processes reference resources directly via a UUID array.
export const resources = pgTable('resources', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),  // No global unique — project name uniqueness enforced by action layer
  type: text('type').notNull(), // data | identity | url | credential | config | app | skill | proxy
  status: text('status').default('active').notNull(), // active | inactive | banned | expired | error

  // Type-specific payload — shape varies by type
  config: jsonb('config').$type<{
    // data: storagePath, storageBackend, contentType, sizeBytes
    // identity: platform, handle, profileUrl, authEnvVar, userId
    // url: url, method
    // credential: service, envVar, expiresAt
    // config: arbitrary
    // app: platform, appId, appIdEnvVar, appSecretEnvVar, clientIdEnvVar, clientSecretEnvVar
    [key: string]: unknown;
  }>().default({}),

  // Free-text guidance for the agent — how this resource should be used, its limits, quirks, etc.
  notes: text('notes'),

  // Checkout fields — set when a process/workflow claims exclusive use of this resource
  lockedBy: text('locked_by'), // workflow run ID or process ID holding the lock
  lockedAt: timestamp('locked_at', { withTimezone: true }),

  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  authUserId: uuid('auth_user_id'),  // nullable — only set for user resources

}, (table) => ({
  typeIdx: index('resources_type_idx').on(table.type),
  statusIdx: index('resources_status_idx').on(table.status),
  authUserIdIdx: index('resources_auth_user_id_idx').on(table.authUserId),
  nameUnique: unique('resources_name_unique').on(table.name),
  authUserIdProjectIdx: uniqueIndex('resources_auth_user_id_project_idx').on(table.authUserId).where(sql`((type = 'project'::text) AND (auth_user_id IS NOT NULL))`),
  authUserIdTypeIdx: uniqueIndex('resources_auth_user_id_type_idx').on(table.authUserId).where(sql`((type = 'user'::text) AND (auth_user_id IS NOT NULL))`),
  nameAccessCodeUniq: uniqueIndex('resources_name_access_code_uniq').on(table.name).where(sql`(type = 'access-code'::text)`),
}))

export const resourceLinks = pgTable(
  'resource_links',
  {
    fromId:    uuid('from_id').notNull().references(() => resources.id, { onDelete: 'cascade' }),
    toId:      uuid('to_id').notNull().references(() => resources.id, { onDelete: 'cascade' }),
    linkType:  text('link_type').notNull().default('parent').references(() => linkTypes.name, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    validFrom: timestamp('valid_from', { withTimezone: true }).notNull().defaultNow(), // backfilled from created_at for pre-existing rows; NULL=still valid is not used here (valid_to covers that)
    validTo:   timestamp('valid_to',   { withTimezone: true }), // NULL = active; non-NULL = closed (soft-delete with timestamp, not full bitemporality)
  },
  (t) => ({
    pk: primaryKey({ columns: [t.fromId, t.toId, t.linkType] }),
    toIdIdx:    index('idx_resource_links_to_id').on(t.toId),
    linkTypeIdx: index('idx_resource_links_link_type').on(t.linkType),
    uqHostedOn: uniqueIndex('uq_resource_links_hostedon').on(t.fromId).where(sql`(link_type = 'hostedOn'::text)`),
    uqPartOf: uniqueIndex('uq_resource_links_partof').on(t.fromId).where(sql`(link_type = 'partOf'::text)`),
    uqRunsAs: uniqueIndex('uq_resource_links_runsas').on(t.fromId).where(sql`(link_type = 'runsAs'::text)`),
  })
)

export const linkTypes = pgTable('link_types', {
  name: text('name').primaryKey(),
  description: text('description').notNull(),
  cardinality: text('cardinality').notNull().default('many-to-many'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

export const linkTypeRules = pgTable(
  'link_type_rules',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    linkType: text('link_type').notNull().references(() => linkTypes.name, { onDelete: 'cascade' }),
    fromType: text('from_type').references(() => resourceTypes.name, { onDelete: 'cascade' }),
    toType: text('to_type').references(() => resourceTypes.name, { onDelete: 'cascade' }),
    minCount: integer('min_count').notNull().default(0),
    maxCount: integer('max_count'), // null = unlimited
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    uq: unique('uq_link_type_rules').on(t.linkType, t.fromType, t.toType),
  })
)

// Processes — long-running optimization runs that span many epochs.
export const processes = pgTable('processes', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),

  // Timing
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),

  // Lineage — what resource (data type) this process belongs to
  trainingResourceId: uuid('training_resource_id').references(() => resources.id),

  // The eval branch created for this process
  branch: text('branch'),

  // Resources the process can use (progressive disclosure — agent resolves as needed)
  resourceIds: uuid('resource_ids').array(),

  // Dispatch-time fields — populated at process creation
  skillResourceId: uuid('skill_resource_id').references(() => resources.id, { onDelete: 'restrict' }),
  runType: text('run_type'), // 'cloud' | 'local'
  prUrl: text('pr_url'),     // filled in at loop completion (nullable)

  // Scheduling
  // NOTE: A CHECK constraint 'processes_status_check' enforcing these values exists in the database
  // (managed via migration 0018, not drizzle-orm check()). Do not auto-generate migrations
  // without verifying the constraint is preserved.
  status: text('status').notNull().default('pending'), // pending | active | paused | waiting | completed | failed
  currentEpoch: integer('current_epoch').notNull().default(0),

  // Process-channel persistence — stable session identity across sleep/wake cycles
  channelId: uuid('channel_id'),
  resumeAt: timestamp('resume_at', { withTimezone: true }),
  resumeContext: text('resume_context'),
  worktreePath: text('worktree_path'),

  // Results (aggregate across all epochs)
  metrics: jsonb('metrics').$type<Record<string, unknown>>(),

  // Metrics schema — defines expected keys in epoch_results.metrics for this process.
  // Null = exploratory mode (agent writes free-form, no validation or plotting).
  // Set from GOAL.md at process creation; agent may update it at runtime.
  metricsSchema: jsonb('metrics_schema').$type<{
    fields: Array<{
      name: string;
      type: 'number' | 'string' | 'boolean';
      direction?: 'maximize' | 'minimize';
    }>;
    version?: string;
  }>(),

  progress: doublePrecision('progress'),

  // Lineage
  parentProcessId: uuid('parent_campaign_id').references((): AnyPgColumn => processes.id),

  // Goal resource — the resource that describes the goal for this process
  goalResourceId: uuid('goal_resource_id').references(() => resources.id, { onDelete: 'restrict' }),

  // Root process — the top-level process in the hierarchy (set by trigger, self-reference)
  rootProcessId: uuid('root_process_id').notNull(),

  // Project scoping — records which project this process ran under at dispatch time. Nullable.
  projectId: uuid('project_id').references(() => resources.id, { onDelete: 'set null' }),

  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  statusIdx: index('processes_status_idx').on(table.status),
  skillResourceIdx: index('processes_skill_resource_idx').on(table.skillResourceId),
  resumeAtIdx: index('processes_resume_at_idx').on(table.resumeAt),
  projectIdIdx: index('processes_project_id_idx').on(table.projectId),
  rootProcessIdIdx: index('processes_root_process_id_idx').on(table.rootProcessId),
  nameIdx: index('processes_name_idx').on(table.name), // non-unique — same name allowed for re-dispatch
  channelIdKey: unique('processes_channel_id_key').on(table.channelId),
}))

// Process dependencies — junction table replacing campaigns.dependency_ids.
// process_id depends on dependency_id (dependency must complete first).
// FK constraints: CASCADE on process_id (deleting a process removes its deps),
//                 RESTRICT on dependency_id (cannot delete a depended-upon process).
// NOTE: Two DB-level constraints are enforced by migration 0021 but not expressible in Drizzle:
//   1. CHECK (process_id != dependency_id) — prevents self-loops at the DB level.
//   2. Trigger prevent_dependency_cycle (function check_dependency_cycle) — detects cycles
//      via recursive CTE before each INSERT/UPDATE. Do not auto-generate migrations without
//      verifying these constraints are preserved.
export const processDependencies = pgTable(
  'process_dependencies',
  {
    processId:    uuid('process_id').notNull().references(() => processes.id, { onDelete: 'cascade' }),
    dependencyId: uuid('dependency_id').notNull().references(() => processes.id, { onDelete: 'restrict' }),
    createdAt:    timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.processId, t.dependencyId] }),
    dependencyIdIdx: index('idx_process_dependencies_dependency_id').on(t.dependencyId),
  })
)

// Epoch results — one row per epoch execution within a process.
export const epochResults = pgTable('epoch_results', {
  id: uuid('id').defaultRandom().primaryKey(),
  processId: uuid('campaign_id').references(() => processes.id).notNull(),
  epochNumber: integer('epoch_number').notNull(),

  // Execution context
  workflowRunId: text('workflow_run_id'),
  sessionId: text('session_id'),
  startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  durationMs: numeric('duration_ms'),
  cost: numeric('cost'),

  // Outcome
  status: text('status').notNull().default('in_progress'), // in_progress | completed | failed | crashed

  // Aggregate metrics for this epoch
  metrics: jsonb('metrics').$type<Record<string, unknown>>(),

  // Debrief text written by agent at epoch completion
  epochDebrief: text('epoch_debrief'),
}, (table) => ({
  processEpochIdx: uniqueIndex('epoch_results_campaign_epoch_idx').on(table.processId, table.epochNumber),
  workflowRunIdx: index('epoch_results_workflow_run_idx').on(table.workflowRunId),
}))

export const resourceTypes = pgTable('resource_types', {
  id:           uuid('id').defaultRandom().primaryKey(),
  name:         text('name').notNull(),
  description:  text('description').notNull(),
  finite:       boolean('finite').notNull().default(false),
  configSchema: jsonb('config_schema').$type<Record<string, unknown>>(),
  createdAt:    timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  nameKey: unique('resource_types_name_key').on(table.name),
}))

export const valueTypes = pgTable('value_types', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
  baseType: text('base_type').notNull(),
  constraints: jsonb('constraints').notNull().default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  nameKey: unique('value_types_name_key').on(table.name),
}))

export const resourceTypeProperties = pgTable(
  'resource_type_properties',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    resourceType: text('resource_type').notNull().references(() => resourceTypes.name, { onDelete: 'cascade' }),
    fieldName: text('field_name').notNull(),
    valueTypeId: uuid('value_type_id').references(() => valueTypes.id, { onDelete: 'set null' }),
    required: boolean('required').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    defaultValue: jsonb('default_value'),
  },
  (t) => ({
    uq: unique('resource_type_properties_resource_type_field_name_key').on(t.resourceType, t.fieldName),
  })
)

// Logs — structured log entries emitted by services during execution.
export const logs = pgTable('logs', {
  id: uuid('id').defaultRandom().primaryKey(),
  level: text('level').notNull(), // debug | info | warn | error | fatal
  service: text('service').notNull(),
  message: text('message').notNull(),
  timestamp: timestamp('timestamp', { withTimezone: true }).defaultNow().notNull(),
  data: jsonb('data').$type<Record<string, unknown>>(),
  error: jsonb('error').$type<{ message: string; stack?: string; code?: string }>(),
}, (table) => ({
  levelIdx: index('logs_level_idx').on(table.level),
  serviceIdx: index('logs_service_idx').on(table.service),
  timestampIdx: index('logs_timestamp_idx').on(table.timestamp),
}))

// Chats + messages — agent-livestream chat persistence (voice and text sessions).
export const chats = pgTable('chats', {
  id: uuid('id').defaultRandom().primaryKey(),
  title: text('title').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  // Stage Manager rail: ordered array of `{ url: string }` entries. Index 0 is the
  // active tile; max 4. Replaces the legacy single artifact_url/artifact_port pair.
  artifactTiles: jsonb('artifact_tiles').$type<Array<{ url: string }>>().notNull().default([]),
  // Renderer toggle: false → single full-bleed iframe (legacy); true → Stage Manager.
  stageMode: boolean('stage_mode').notNull().default(false),
})

export const messages = pgTable('messages', {
  id: uuid('id').defaultRandom().primaryKey(),
  chatId: uuid('chat_id').notNull().references(() => chats.id, { onDelete: 'cascade' }),
  // NOTE: A CHECK constraint 'messages_role_check' enforcing ('user', 'assistant') exists in the
  // database (managed via migration 0047, not drizzle-orm check()). Do not auto-generate
  // migrations without verifying the constraint is preserved.
  role: text('role').notNull(),
  content: text('content').notNull().default(''),
  toolCalls: jsonb('tool_calls').$type<Array<{ id: string; name: string; arguments: string }>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  chatIdCreatedIdx: index('idx_messages_chat_id_created').on(table.chatId, table.createdAt),
}))

// Metric snapshots — point-in-time measurements for skills, enabling trend analysis across epochs.
export const metricSnapshots = pgTable('metric_snapshots', {
  id: uuid('id').defaultRandom().primaryKey(),
  skillId: uuid('skill_id').notNull().references(() => resources.id, { onDelete: 'cascade' }),
  metricKey: text('metric_key').notNull(),
  value: numeric('value').notNull(),
  measuredAt: timestamp('measured_at', { withTimezone: true }).defaultNow().notNull(),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
}, (table) => ({
  uqMetricSnapshots: unique('uq_metric_snapshots').on(table.skillId, table.metricKey, table.measuredAt),
  idxSkillKeyTs: index('idx_metric_snapshots_skill_key_ts').on(table.skillId, table.metricKey, table.measuredAt.desc()),
  idxMeasuredAt: index('idx_metric_snapshots_measured_at').on(table.measuredAt),
}))

// Action types — registry of all action types backed by Postgres RPCs.
export const actionTypes = pgTable('action_types', {
  name: text('name').primaryKey(),
  rpcFunction: text('rpc_function').notNull(),
  inputSchema: jsonb('input_schema').notNull(),
  outputSchema: jsonb('output_schema').notNull(),
  paramMapping: jsonb('param_mapping').notNull(),
  resultMapping: jsonb('result_mapping').notNull(),
  description: text('description'),
  schemaVersion: integer('schema_version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  sensitiveFields: text('sensitive_fields').array().default(['']),
  validationRules: jsonb('validation_rules'),
})

// Action events — audit log of all action executions.
export const actionEvents = pgTable('action_events', {
  id: uuid('id').defaultRandom().primaryKey(),
  actionType: text('action_type').notNull().references(() => actionTypes.name),
  input: jsonb('input').notNull(),
  output: jsonb('output'),
  status: text('status').notNull(),
  error: text('error'),
  actorId: uuid('actor_id').references(() => resources.id),
  schemaVersion: integer('schema_version'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  targetResourceId: uuid('target_resource_id').references(() => resources.id, { onDelete: 'set null' }),
}, (table) => ({
  actionTypeIdx: index('action_events_action_type_idx').on(table.actionType),
  actorIdIdx: index('action_events_actor_id_idx').on(table.actorId),
  createdAtIdx: index('action_events_created_at_idx').on(table.createdAt.desc()),
}))

// Agent events — realtime event stream for process activity.
export const agentEvents = pgTable('agent_events', {
  id: uuid('id').defaultRandom().primaryKey(),
  processId: uuid('process_id').notNull().references(() => processes.id),
  processName: text('process_name').notNull(),
  resourceId: uuid('resource_id').references(() => resources.id),
  source: text('source').notNull(),
  payload: jsonb('payload'),
  ts: timestamp('ts', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  processIdIdx: index('idx_agent_events_process_id').on(table.processId),
  tsIdx: index('idx_agent_events_ts').on(table.ts.desc()),
}))

// Sandbox writeback tokens — see migration 20260421000002_update_sandbox_credential_rpc.sql.
// Token hashes (sha256) for sandbox VMs to authenticate credential writebacks.
// All access is via SECURITY DEFINER RPCs (register_sandbox_token, validate_sandbox_token)
// so RLS denies direct authenticated access.
export const sandboxIdentityTokens = pgTable('sandbox_identity_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  sandboxId: uuid('sandbox_id').notNull(),
  userId: uuid('user_id').notNull(),
  tokenHash: text('token_hash').notNull(),
  scope: text('scope').notNull().default('writeback_own_credentials'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  tokenHashUnique: unique('uq_sandbox_identity_token_hash').on(table.tokenHash),
  userIdIdx: index('idx_sandbox_identity_tokens_user_id').on(table.userId),
  expiresAtIdx: index('idx_sandbox_identity_tokens_expires_at').on(table.expiresAt),
}))
