import type { SupabaseClient } from '@supabase/supabase-js'
import type { ActionType } from './execute-action.js'

export * from './execute-action.js'

/**
 * Returns the names of all registered action types.
 */
export async function listActions(client: SupabaseClient): Promise<string[]> {
  const { data, error } = await client
    .from('action_types')
    .select('name')
    .order('name')
  if (error) throw new Error(`listActions failed: ${error.message}`)
  return (data ?? []).map((row: { name: string }) => row.name)
}

/**
 * Returns the full schema for a named action, or null if not found.
 */
export async function describeAction(name: string, client: SupabaseClient): Promise<ActionType | null> {
  const { data, error } = await client
    .from('action_types')
    .select('*')
    .eq('name', name)
    .maybeSingle()
  if (error) throw new Error(`describeAction failed: ${error.message}`)
  return data as ActionType | null
}
