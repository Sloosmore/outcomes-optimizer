import { Ajv } from 'ajv'
// ajv-formats types declare a module namespace, not a callable default.
// At runtime the default export IS the plugin function. Cast via unknown.
import addFormats_ from 'ajv-formats'
const addFormats = addFormats_ as unknown as (ajv: InstanceType<typeof Ajv>) => void
import type { ValidateFunction } from 'ajv'
import { createClient } from '@supabase/supabase-js'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@skill-networks/logger'
import { getSupabaseServiceKey, getSupabaseUrl } from '../constants.js'

interface UniquenessRule {
  table: string
  where?: Record<string, string>
  field: string
  input_field: string
  error: string
  on_conflict: 'return_existing' | 'error'
  result_mapping?: Record<string, string>  // snake → camelCase, for return_existing
}

interface ValidationRules {
  uniqueness?: UniquenessRule[]
}

export interface ActionType {
  name: string
  rpc_function: string
  input_schema: Record<string, unknown>  // JSON Schema object
  output_schema: Record<string, unknown>
  param_mapping: Record<string, string>   // camelCase → p_snake_case
  result_mapping: Record<string, string>  // snake_case → camelCase
  description?: string
  schema_version: number
  sensitive_fields?: string[]
  validation_rules?: ValidationRules | null
  created_at: string
}

const cache = new Map<string, { data: ActionType; validator: ValidateFunction; expiresAt: number }>()
const CACHE_TTL_MS = 5 * 60 * 1000  // 5 minutes

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Extracts the primary target resource UUID from raw RPC output.
 * Looks for the first field ending in `_id` that has a UUID-shaped value.
 * Returns null if no UUID field is found (e.g. for link operations).
 */
function extractTargetResourceId(rawOutput: Record<string, unknown>): string | null {
  for (const [key, val] of Object.entries(rawOutput)) {
    if (key.endsWith('_id') && typeof val === 'string' && UUID_RE.test(val)) {
      return val
    }
  }
  return null
}

const logger = createLogger('execute-action')

// Lazy singleton service client — created once, reused for all audit writes
let _serviceClient: SupabaseClient | null = null
function getServiceClient(): SupabaseClient | null {
  if (_serviceClient) return _serviceClient
  const url = getSupabaseUrl()
  // Audit writes are best-effort — getSupabaseServiceKey() throws when unset,
  // so we catch and disable the audit client to preserve prior behavior.
  let key: string
  try {
    key = getSupabaseServiceKey()
  } catch {
    return null
  }
  _serviceClient = createClient(url, key)
  return _serviceClient
}

/**
 * Clears the action type cache AND resets the singleton service client.
 * Intended for testing only — call before each test to prevent cross-test state leakage.
 */
export function clearCache(): void {
  cache.clear()
  _serviceClient = null
}

async function fetchActionType(name: string, client: SupabaseClient): Promise<{ action: ActionType; validator: ValidateFunction }> {
  const now = Date.now()
  const cached = cache.get(name)
  if (cached && cached.expiresAt > now) {
    return { action: cached.data, validator: cached.validator }
  }

  const { data, error } = await client
    .from('action_types')
    .select('*')
    .eq('name', name)
    .single()

  if (error) {
    throw new Error(`Failed to fetch action type '${name}': ${error.message}`)
  }

  const action = data as ActionType
  // Create a fresh AJV instance per schema to avoid stale compiled schemas accumulating
  const ajv = new Ajv({ allErrors: true })
  addFormats(ajv)
  const validator = ajv.compile(action.input_schema)
  cache.set(name, { data: action, validator, expiresAt: now + CACHE_TTL_MS })
  return { action, validator }
}

function validateInput(action: ActionType, validator: ValidateFunction, input: Record<string, unknown>): void {
  const valid = validator(input)
  if (!valid) {
    const fields = (validator.errors ?? [])
      .map(err => {
        // instancePath is like '/authUserId', or empty for missing properties
        if (err.keyword === 'required' && err.params && typeof err.params === 'object' && 'missingProperty' in err.params) {
          return String(err.params.missingProperty)
        }
        const path = err.instancePath.replace(/^\//, '')
        return path || err.message || 'unknown field'
      })
      .join(', ')
    throw new Error(`Invalid input for action '${action.name}': ${fields}`)
  }
}

function buildRpcParams(
  input: Record<string, unknown>,
  paramMapping: Record<string, string>
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [camelKey, snakeKey] of Object.entries(paramMapping)) {
    if (camelKey in input) {
      result[snakeKey] = input[camelKey]
    }
  }
  return result
}

function mapResult(
  rpcOutput: Record<string, unknown>,
  resultMapping: Record<string, string>
): Record<string, unknown> {
  if (Object.keys(resultMapping).length === 0) {
    return {}
  }
  const result: Record<string, unknown> = {}
  for (const [snakeKey, camelKey] of Object.entries(resultMapping)) {
    if (snakeKey in rpcOutput) {
      result[camelKey] = rpcOutput[snakeKey]
    }
  }
  return result
}

/**
 * Deep-copies input and replaces values of sensitive fields with "[REDACTED]".
 * Returns the redacted copy — original is unchanged.
 */
function redactInput(
  input: Record<string, unknown>,
  sensitiveFields: string[]
): Record<string, unknown> {
  if (sensitiveFields.length === 0) return input
  const copy = JSON.parse(JSON.stringify(input)) as Record<string, unknown>
  for (const field of sensitiveFields) {
    if (field in copy) {
      copy[field] = '[REDACTED]'
    }
  }
  return copy
}

type UniquenessOutcome =
  | { type: 'no_conflict' }
  | { type: 'return_existing'; result: Record<string, unknown> }
  | { type: 'error'; message: string }

/**
 * Checks validation_rules.uniqueness and returns an outcome descriptor.
 * Does not throw — the caller decides what to do with 'error' outcomes (e.g. write audit first).
 */
async function enforceUniquenessRules(
  action: ActionType,
  input: Record<string, unknown>,
  client: SupabaseClient
): Promise<UniquenessOutcome> {
  const rules = action.validation_rules?.uniqueness
  if (!rules || rules.length === 0) return { type: 'no_conflict' }

  for (const rule of rules) {
    const value = input[rule.input_field]
    if (value === undefined) continue

    let query = client
      .from(rule.table)
      .select('*')
      .eq(rule.field, value as string)

    if (rule.where) {
      for (const [col, val] of Object.entries(rule.where)) {
        query = query.eq(col, val)
      }
    }

    const { data, error } = await query.maybeSingle()

    if (error) {
      throw new Error(`Uniqueness check failed for '${action.name}': ${error.message}`)
    }

    if (data !== null) {
      if (rule.on_conflict === 'return_existing') {
        const row = data as Record<string, unknown>
        const mapped: Record<string, unknown> = {}
        if (rule.result_mapping) {
          for (const [snakeKey, camelKey] of Object.entries(rule.result_mapping)) {
            if (snakeKey in row) {
              mapped[camelKey] = row[snakeKey]
            }
          }
        }
        return { type: 'return_existing', result: mapped }
      } else {
        return { type: 'error', message: rule.error }
      }
    }
  }

  return { type: 'no_conflict' }
}

async function writeAuditEvent(
  action: ActionType,
  auditInput: Record<string, unknown>,  // renamed from input — this is the REDACTED copy
  output: Record<string, unknown> | null,
  status: 'success' | 'failed',
  errorMsg: string | null,
  actorId: string | null,
  targetResourceId: string | null = null
): Promise<void> {
  const serviceClient = getServiceClient()

  if (!serviceClient) {
    logger.error('audit write failed: SUPABASE_SERVICE_ROLE_KEY not set')
    return
  }

  try {
    const { error } = await serviceClient.from('action_events').insert({
      action_type: action.name,
      input: auditInput,
      output,
      status,
      error: errorMsg,
      actor_id: actorId,
      schema_version: action.schema_version,
      target_resource_id: targetResourceId,
    })
    if (error) {
      throw error
    }
  } catch (err) {
    logger.error('audit write failed', { error: err instanceof Error ? { message: err.message, stack: err.stack } : { message: String(err) } })
  }
}

// Story 1: Base graph primitives
export type ResourceStatus = 'active' | 'inactive' | 'banned' | 'expired' | 'error'

export type DeleteResourceInput = { resourceId: string }
export type DeleteResourceResult = { deletedLinks: number }

export type DeleteLinkInput = { fromId: string; toId: string; linkType: string }
export type DeleteLinkResult = { deleted: boolean }

export type UpdateResourceStatusInput = { resourceId: string; newStatus: ResourceStatus; expectedStatus?: ResourceStatus }
export type UpdateResourceStatusResult = { resourceId: string; oldStatus: string }

export type ProvisionUserInput = { authUserId: string; email: string }
export type ProvisionSandboxInput = {
  userResourceId: string
  serverName: string
  sshKeyName: string
  publicKey: string
  /** JWT sub claim of the calling user. Required because auth.uid() is NULL for service-role callers. */
  authUid?: string
  hetznerServerId?: string
  cloudflareHostnameId?: string
}
export type UpdateSandboxStatusInput = { serverResourceId: string; status: string; ip: string; hetznerServerId: string; provisionedAt: string }

export type ProvisionUserResult = { userResourceId: string; projectResourceId: string }
export type ProvisionSandboxResult = { serverResourceId: string; credentialResourceId: string; isNew: boolean }
export type UpdateSandboxStatusResult = Record<string, never>

export type StoreUserCredentialInput = { userResourceId: string; sandboxName: string; provider: string; credentialValue: string }
export type DeleteUserCredentialInput = { credentialResourceId: string }

export type StoreUserCredentialResult = { credentialResourceId: string; vaultSecretId: string }
export type DeleteUserCredentialResult = { deleted: boolean }

export type CreateProjectInput = { name: string }
export type RenameProjectInput = { projectResourceId: string; newName: string }
export type CreateProjectResult = { projectResourceId: string }
export type RenameProjectResult = { projectResourceId: string }

// Story 8: assign_parent link
export type AssignParentInput = { fromId: string; toId: string }
export type AssignParentResult = { created: boolean }

// Story 5: Semantic link aliases
export type AssignCredentialInput = { resourceId: string; credentialId: string }
export type AssignCredentialResult = { created: boolean }
export type AssignProxyInput = { resourceId: string; proxyId: string }
export type AssignProxyResult = { created: boolean }
export type AddProjectMemberInput = { userId: string; projectId: string }
export type AddProjectMemberResult = { created: boolean }

// Story 4: Resource type creates
export type CreateIdentityInput = { name: string; projectId: string; handle: string; config?: Record<string, unknown> }
export type CreateIdentityResult = { identityResourceId: string }
export type CreateAppInput = { name: string; projectId: string; config?: Record<string, unknown> }
export type CreateAppResult = { appResourceId: string }
export type CreateCredentialInput = { name: string; projectId: string; dopplerProject: string; config?: Record<string, unknown> }
export type CreateCredentialResult = { credentialResourceId: string }
export type CreateServerInput = { name: string; projectId: string; config?: Record<string, unknown> }
export type CreateServerResult = { serverResourceId: string }

// Story 2 (db hardening): Agent resource creates
export type CreateAgentInput = { name: string; projectId: string; config?: Record<string, unknown> }
export type CreateAgentResult = { agentResourceId: string }
export type CreateProxyInput = { name: string; projectId: string; config?: Record<string, unknown> }
export type CreateProxyResult = { proxyResourceId: string }

// Story 3: Cron lifecycle
export type CreateCronInput = {
  name: string
  projectId: string
  skillResourceId: string
  schedule: string
  enabled: boolean
  prompt?: string
  dependsOn?: string[]
}
export type CreateCronResult = { cronResourceId: string }
export type UpdateCronScheduleInput = {
  resourceId: string
  schedule?: string
  enabled?: boolean
  prompt?: string
}
export type UpdateCronScheduleResult = { resourceId: string }

// Story 2: Skill lifecycle
export type CreateSkillConfig = {
  content: string
}
export type CreateSkillInput = { name: string; projectId: string; config: CreateSkillConfig }
export type CreateSkillResult = { skillResourceId: string }
export type UpdateSkillConfigInput = { resourceId: string; config: Partial<CreateSkillConfig> }
export type UpdateSkillConfigResult = { resourceId: string }
export type UpdateSkillContentInput = { resourceId: string; content: string }
export type UpdateSkillContentResult = { resourceId: string }
export type CreateAccessCodeInput = { code?: string; config?: Record<string, unknown> }
export type CreateAccessCodeResult = { accessCodeId: string; code: string }
export type RedeemAccessCodeInput = { code: string; userId: string }
export type RedeemAccessCodeResult = { accessCodeId: string; redeemed: boolean }
export type RenameResourceInput = { resourceId: string; newName: string }
export type RenameResourceResult = { resourceId: string; oldName: string }

export async function executeAction(name: 'provision_user', input: ProvisionUserInput, client: SupabaseClient): Promise<ProvisionUserResult>
export async function executeAction(name: 'provision_sandbox', input: ProvisionSandboxInput, client: SupabaseClient): Promise<ProvisionSandboxResult>
export async function executeAction(name: 'update_sandbox_status', input: UpdateSandboxStatusInput, client: SupabaseClient): Promise<UpdateSandboxStatusResult>
export async function executeAction(name: 'store_user_credential', input: StoreUserCredentialInput, client: SupabaseClient): Promise<StoreUserCredentialResult>
export async function executeAction(name: 'delete_user_credential', input: DeleteUserCredentialInput, client: SupabaseClient): Promise<DeleteUserCredentialResult>
export async function executeAction(name: 'create_project', input: CreateProjectInput, client: SupabaseClient): Promise<CreateProjectResult>
export async function executeAction(name: 'rename_project', input: RenameProjectInput, client: SupabaseClient): Promise<RenameProjectResult>
export async function executeAction(name: 'create_skill', input: CreateSkillInput, client: SupabaseClient): Promise<CreateSkillResult>
export async function executeAction(name: 'update_skill_config', input: UpdateSkillConfigInput, client: SupabaseClient): Promise<UpdateSkillConfigResult>
export async function executeAction(name: 'update_skill_content', input: UpdateSkillContentInput, client: SupabaseClient): Promise<UpdateSkillContentResult>
export async function executeAction(name: 'create_cron', input: CreateCronInput, client: SupabaseClient): Promise<CreateCronResult>
export async function executeAction(name: 'update_cron_schedule', input: UpdateCronScheduleInput, client: SupabaseClient): Promise<UpdateCronScheduleResult>
export async function executeAction(name: 'create_identity', input: CreateIdentityInput, client: SupabaseClient): Promise<CreateIdentityResult>
export async function executeAction(name: 'create_app', input: CreateAppInput, client: SupabaseClient): Promise<CreateAppResult>
export async function executeAction(name: 'create_credential', input: CreateCredentialInput, client: SupabaseClient): Promise<CreateCredentialResult>
export async function executeAction(name: 'create_server', input: CreateServerInput, client: SupabaseClient): Promise<CreateServerResult>
export async function executeAction(name: 'create_agent', input: CreateAgentInput, client: SupabaseClient): Promise<CreateAgentResult>
export async function executeAction(name: 'create_proxy', input: CreateProxyInput, client: SupabaseClient): Promise<CreateProxyResult>
export async function executeAction(name: 'assign_parent', input: AssignParentInput, client: SupabaseClient): Promise<AssignParentResult>
export async function executeAction(name: 'assign_credential', input: AssignCredentialInput, client: SupabaseClient): Promise<AssignCredentialResult>
export async function executeAction(name: 'assign_proxy', input: AssignProxyInput, client: SupabaseClient): Promise<AssignProxyResult>
export async function executeAction(name: 'add_project_member', input: AddProjectMemberInput, client: SupabaseClient): Promise<AddProjectMemberResult>
export async function executeAction(name: 'create_access_code', input: CreateAccessCodeInput, client: SupabaseClient): Promise<CreateAccessCodeResult>
export async function executeAction(name: 'redeem_access_code', input: RedeemAccessCodeInput, client: SupabaseClient): Promise<RedeemAccessCodeResult>
export async function executeAction(name: 'delete_resource', input: DeleteResourceInput, client: SupabaseClient): Promise<DeleteResourceResult>
export async function executeAction(name: 'delete_link', input: DeleteLinkInput, client: SupabaseClient): Promise<DeleteLinkResult>
export async function executeAction(name: 'update_resource_status', input: UpdateResourceStatusInput, client: SupabaseClient): Promise<UpdateResourceStatusResult>
export async function executeAction(name: 'rename_resource', input: RenameResourceInput, client: SupabaseClient): Promise<RenameResourceResult>
export async function executeAction(name: string, input: Record<string, unknown>, client: SupabaseClient): Promise<Record<string, unknown>>
export async function executeAction(
  name: string,
  input: Record<string, unknown>,
  client: SupabaseClient
): Promise<Record<string, unknown>> {
  const { action, validator } = await fetchActionType(name, client)

  validateInput(action, validator, input)

  const sensitiveFields = action.sensitive_fields ?? []
  const auditInput = redactInput(input, sensitiveFields)

  const { data: userData } = await client.auth.getUser()
  const actorId = userData?.user?.id ?? null

  // Enforce validation_rules.uniqueness before calling the RPC
  const uniquenessOutcome = await enforceUniquenessRules(action, input, client)
  if (uniquenessOutcome.type === 'return_existing') {
    // Idempotent path: conflict exists, return the existing record without calling the RPC
    await writeAuditEvent(action, auditInput, uniquenessOutcome.result, 'success', null, actorId, null)
    return uniquenessOutcome.result
  }
  if (uniquenessOutcome.type === 'error') {
    // Conflict blocked by validation — write audit event then throw
    await writeAuditEvent(action, auditInput, null, 'failed', uniquenessOutcome.message, actorId, null)
    throw new Error(uniquenessOutcome.message)
  }

  const rpcParams = buildRpcParams(input, action.param_mapping)

  const { data: rpcData, error: rpcError } = await client.rpc(action.rpc_function, rpcParams)

  if (rpcError) {
    const errorMsg = `${name} RPC failed: ${rpcError.message}`
    await writeAuditEvent(action, auditInput, null, 'failed', errorMsg, actorId, null)
    throw new Error(errorMsg)
  }

  const rawOutput: Record<string, unknown> = (Array.isArray(rpcData) && rpcData.length > 0)
    ? (rpcData[0] as Record<string, unknown>)
    : (rpcData !== null && typeof rpcData === 'object' ? rpcData as Record<string, unknown> : {})

  const mappedResult = mapResult(rawOutput, action.result_mapping)

  // Warn if the RPC output is missing required fields declared in output_schema
  const requiredOutputFields = (action.output_schema as { required?: string[] }).required ?? []
  const missingFields = requiredOutputFields.filter(f => !(f in mappedResult))
  if (missingFields.length > 0) {
    logger.warn(`${name} RPC output missing required fields`, { data: { missingFields } })
  }

  const targetResourceId = extractTargetResourceId(rawOutput)
  await writeAuditEvent(action, auditInput, mappedResult, 'success', null, actorId, targetResourceId)

  return mappedResult
}
