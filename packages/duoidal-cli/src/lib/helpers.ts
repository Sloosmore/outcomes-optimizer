// Re-export Supabase helpers from the canonical source (@skill-networks/database/constants).
// All Supabase URL/key access must go through these — never hardcode or inline.
// @ts-ignore — tsup bundles @skill-networks/database; TS rootDir prevents static resolution
import * as dbConstants from '@skill-networks/database/constants'

export const getSupabaseUrl: () => string = dbConstants.getSupabaseUrl
export const getSupabaseAnonKey: () => string = dbConstants.getSupabaseAnonKey
export const getSupabaseServiceKey: () => string = dbConstants.getSupabaseServiceKey

export type ExecuteActionFn = (name: string, input: Record<string, unknown>, client: unknown) => Promise<Record<string, unknown>>
export type SupabaseClientFactory = (url: string, key: string) => unknown

export async function loadExecuteAction(): Promise<ExecuteActionFn> {
  // @ts-ignore — module lives outside rootDir; bundled by tsup at build time
  const mod = await import('@skill-networks/database/actions') as { executeAction: ExecuteActionFn }
  return mod.executeAction
}

/** Reads the BFF API base URL from env. Throws if unset. */
export function getApiBaseUrl(): string {
  const url = process.env['DUOIDAL_API_URL']
  if (!url) throw new Error('DUOIDAL_API_URL must be set')
  return url
}
