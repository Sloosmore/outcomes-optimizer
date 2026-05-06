// Type declaration for @skill-networks/database/actions.
// Tsup bundles this module at build time (see tsup.config.ts noExternal).
// This declaration prevents tsc from following the import chain into the database package
// which has pre-existing issues (allowImportingTsExtensions, ajv-formats version).

declare module '@skill-networks/database/actions' {
  import type { SupabaseClient } from '@supabase/supabase-js'

  export type ProvisionUserInput = { authUserId: string; email: string }
  export type ProvisionSandboxInput = { userResourceId: string; serverName: string; sshKeyName: string; publicKey: string }
  export type UpdateSandboxStatusInput = { serverResourceId: string; status: string; ip: string; hetznerServerId: string; provisionedAt: string }
  export type DeprovisionSandboxInput = { serverResourceId: string }

  export type ProvisionUserResult = { userResourceId: string; projectResourceId: string }
  export type ProvisionSandboxResult = { serverResourceId: string; credentialResourceId: string; isNew: boolean }
  export type UpdateSandboxStatusResult = Record<string, never>
  export type DeprovisionSandboxResult = { deleted: boolean; serverName?: string }

  export function executeAction(name: 'provision_user', input: ProvisionUserInput, client: SupabaseClient): Promise<ProvisionUserResult>
  export function executeAction(name: 'provision_sandbox', input: ProvisionSandboxInput, client: SupabaseClient): Promise<ProvisionSandboxResult>
  export function executeAction(name: 'update_sandbox_status', input: UpdateSandboxStatusInput, client: SupabaseClient): Promise<UpdateSandboxStatusResult>
  export function executeAction(name: 'deprovision_sandbox', input: DeprovisionSandboxInput, client: SupabaseClient): Promise<DeprovisionSandboxResult>
  export function executeAction(name: string, input: Record<string, unknown>, client: SupabaseClient): Promise<Record<string, unknown>>
  export function clearCache(): void
}
