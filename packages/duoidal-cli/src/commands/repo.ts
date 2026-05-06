import { Command } from 'commander'
import { createAuthenticatedSupabaseClient } from '@duoidal/auth/adapters'
import { loadExecuteAction, getSupabaseAnonKey, getSupabaseUrl } from '../lib/helpers.js'
import { requireAuth } from '../lib/require-auth.js'

// Re-export types for test injection
export type ExecuteActionFn = (name: string, input: Record<string, unknown>, client: unknown) => Promise<Record<string, unknown>>
export type SupabaseClientFactory = (url: string, key: string) => unknown

function parseOwnerName(arg: string | undefined, optOwner: string | undefined, optName: string | undefined): { owner: string; name: string } | null {
  if (arg) {
    const slash = arg.indexOf('/')
    if (slash === -1) return null
    return { owner: arg.slice(0, slash), name: arg.slice(slash + 1) }
  }
  if (optOwner && optName) {
    return { owner: optOwner, name: optName }
  }
  return null
}

export function repoCommand(executeActionFn?: ExecuteActionFn, supabaseFactory?: SupabaseClientFactory): Command {
  const repo = new Command('repo')
  repo.description('Manage repositories in user config')

  // repo add <owner/repo>
  repo.command('add [ownerRepo]')
    .description('Add a repository to user config')
    .option('--owner <owner>', 'Repository owner')
    .option('--name <name>', 'Repository name')
    .option('--default', 'Mark as default repository')
    .action(async (ownerRepo: string | undefined, opts: { owner?: string; name?: string; default?: boolean }) => {
      const { accessToken } = await requireAuth()

      const parsed = parseOwnerName(ownerRepo, opts.owner, opts.name)
      if (!parsed) {
        console.error('Error: provide <owner/repo> or --owner <owner> --name <name>')
        process.exit(1)
      }

      const supabaseUrl = getSupabaseUrl()
      const supabaseAnonKey = getSupabaseAnonKey()

      const executeAction = executeActionFn ?? (await loadExecuteAction())
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const client = createAuthenticatedSupabaseClient(supabaseUrl, supabaseAnonKey, accessToken, supabaseFactory as any) as any

      // The add_user_repo action derives the user from auth.uid() server-side.
      // The action's input schema is additionalProperties: false and only accepts
      // { owner, name, default } — sending userResourceId here will be rejected.
      const input: Record<string, unknown> = { owner: parsed.owner, name: parsed.name }
      if (opts.default) input['default'] = true

      await executeAction('add_user_repo', input, client)

      console.log(`Repo added: ${parsed.owner}/${parsed.name}`)
    })

  // repo list
  repo.command('list')
    .description('List repos in user config')
    .action(async () => {
      const { sub: authUserId, accessToken } = await requireAuth()

      const supabaseUrl = getSupabaseUrl()
      const supabaseAnonKey = getSupabaseAnonKey()

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const client = createAuthenticatedSupabaseClient(supabaseUrl, supabaseAnonKey, accessToken, supabaseFactory as any) as any

      // Mirror the write path: add_user_repo / remove_user_repo resolve the
      // user resource via app.current_user_resource_id(), which filters on
      // (auth_user_id, auth_provider, type='user') — NOT on name. The user's
      // resource `name` is not stable across the codebase's history (older
      // rows are 'user:<email_local>' from migration 20260407000018, newer
      // rows are 'user:<auth_user_id>' from 20260421000001), so a name-based
      // read drifts from the auth_user_id-based write. Read by auth_user_id
      // to match the canonical lookup used by every server-side RPC.
      const { data } = await client
        .from('resources')
        .select('config')
        .eq('type', 'user')
        .eq('auth_user_id', authUserId)
        .single()

      const repos = (data?.config?.repos ?? []) as Array<{ owner: string; name: string; default?: boolean }>

      if (repos.length === 0) {
        console.log('No repos configured.')
        return
      }

      for (const r of repos) {
        const label = r.default ? ` (default)` : ''
        console.log(`${r.owner}/${r.name}${label}`)
      }
    })

  // repo remove <owner/repo>
  repo.command('remove [ownerRepo]')
    .description('Remove a repository from user config')
    .option('--owner <owner>', 'Repository owner')
    .option('--name <name>', 'Repository name')
    .action(async (ownerRepo: string | undefined, opts: { owner?: string; name?: string }) => {
      const { accessToken } = await requireAuth()

      const parsed = parseOwnerName(ownerRepo, opts.owner, opts.name)
      if (!parsed) {
        console.error('Error: provide <owner/repo> or --owner <owner> --name <name>')
        process.exit(1)
      }

      const supabaseUrl = getSupabaseUrl()
      const supabaseAnonKey = getSupabaseAnonKey()

      const executeAction = executeActionFn ?? (await loadExecuteAction())
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const client = createAuthenticatedSupabaseClient(supabaseUrl, supabaseAnonKey, accessToken, supabaseFactory as any) as any

      // The remove_user_repo action derives the user from auth.uid() server-side.
      // The action's input schema is additionalProperties: false and only accepts
      // { owner, name } — sending userResourceId here will be rejected.
      await executeAction('remove_user_repo', { owner: parsed.owner, name: parsed.name }, client)

      console.log(`Repo removed: ${parsed.owner}/${parsed.name}`)
    })

  return repo
}
