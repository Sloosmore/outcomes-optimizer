import { Command } from 'commander'
import crypto from 'node:crypto'
import { createAuthenticatedSupabaseClient, createSupabaseClient } from '@duoidal/auth/adapters'
import { loadExecuteAction, getSupabaseAnonKey, getSupabaseServiceKey, getSupabaseUrl } from '../lib/helpers.js'
import { requireAuth } from '../lib/require-auth.js'

// Re-export types for test injection
export type ExecuteActionFn = (name: string, input: Record<string, unknown>, client: unknown) => Promise<Record<string, unknown>>
export type SupabaseClientFactory = (url: string, key: string) => unknown

const GITHUB_APP_SLUG = process.env['GITHUB_APP_SLUG'] ?? 'duoidal'
const BFF_BASE_URL = process.env['BFF_BASE_URL'] ?? 'https://example.com'
const POLL_INTERVAL_MS = 2000
const POLL_TIMEOUT_MS = 5 * 60 * 1000  // 5 minutes

/** Poll the BFF relay until the installation_id arrives or we time out */
async function pollForInstallationId(state: string): Promise<string> {
  const deadline = Date.now() + POLL_TIMEOUT_MS
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))
    const res = await fetch(`${BFF_BASE_URL}/github/poll?state=${encodeURIComponent(state)}`)
    if (!res.ok) continue
    const data = await res.json() as { installationId?: string; pending?: boolean }
    if (data.installationId) return data.installationId
  }
  throw new Error('Timed out waiting for GitHub App installation')
}

export function githubCommand(executeActionFn?: ExecuteActionFn, supabaseFactory?: SupabaseClientFactory): Command {
  const github = new Command('github')
  github.description('Manage GitHub App integration')

  // github connect — local callback server captures installation_id from GitHub redirect
  // Requires: "Request user authorization (OAuth) during installation" checked in GitHub App settings
  github.command('connect')
    .description('Connect your GitHub account by installing the Duoidal GitHub App')
    .option('--install-id <id>', 'Skip browser flow and store this installation ID directly (for CI use)')
    .action(async (opts: { installId?: string }) => {
      const { sub: userResourceId, accessToken: authAccessToken } = await requireAuth()

      const supabaseUrl = getSupabaseUrl()
      const supabaseAnonKey = getSupabaseAnonKey()

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const client = createAuthenticatedSupabaseClient(supabaseUrl, supabaseAnonKey, authAccessToken, supabaseFactory as any) as any

      const { data: userResources } = await client
        .from('resources')
        .select('id')
        .eq('type', 'user')
        .eq('name', `user:${userResourceId}`)
        .limit(1)

      if (!userResources?.length) {
        console.error('Error: user resource not found. Has your account been provisioned?')
        process.exit(1)
      }

      const resolvedUserResourceId = userResources[0].id
      const executeAction = executeActionFn ?? (await loadExecuteAction())

      // --install-id bypass: skip browser flow entirely (CI/scripted use)
      if (opts.installId) {
        if (!/^\d+$/.test(opts.installId)) {
          console.error('Error: --install-id must be a numeric GitHub App installation ID')
          process.exit(1)
        }
        await executeAction('store_github_installation', { userResourceId: resolvedUserResourceId, installationId: opts.installId }, client)
        console.log(`GitHub connected. Installation ID: ${opts.installId}`)
        return
      }

      // Browser flow: relay via BFF — CLI polls BFF for installation_id after GitHub
      // redirects to Setup URL which stores it keyed by the opaque state token
      const state = crypto.randomBytes(16).toString('hex')
      const installUrl = `https://github.com/apps/${GITHUB_APP_SLUG}/installations/new?state=${state}`

      console.log('\nOpening browser to install the Duoidal GitHub App...')
      console.log(`If browser does not open automatically, visit:\n  ${installUrl}\n`)

      try {
        const { default: open } = await import('open')
        await open(installUrl)
      } catch { /* non-fatal — user can open manually */ }

      console.log('Waiting for GitHub callback...')
      const installationId = await pollForInstallationId(state)

      await executeAction('store_github_installation', { userResourceId: resolvedUserResourceId, installationId }, client)
      console.log(`GitHub connected. Installation ID: ${installationId}`)
    })

  // github status — Check connection status
  github.command('status')
    .description('Check GitHub App connection status')
    .action(async () => {
      const { sub: authUserId, accessToken } = await requireAuth()

      const supabaseUrl = getSupabaseUrl()
      const supabaseAnonKey = getSupabaseAnonKey()

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const client = createAuthenticatedSupabaseClient(supabaseUrl, supabaseAnonKey, accessToken, supabaseFactory as any) as any

      // Find user resource — name is 'user:<authUserId>'
      const { data: userResources } = await client
        .from('resources')
        .select('id')
        .eq('type', 'user')
        .eq('name', `user:${authUserId}`)
        .limit(1)

      if (!userResources?.length) {
        console.log('GitHub not connected.')
        process.exit(0)
      }

      const userResourceId = userResources[0].id

      // Query resource_links for github_app link type
      // store_github_installation creates: from_id=userResourceId, to_id=credentialId
      const { data: githubLinks } = await client
        .from('resource_links')
        .select('to_id')
        .eq('from_id', userResourceId)
        .eq('link_type', 'github_app')
        .limit(1)

      if (!githubLinks?.length) {
        console.log('GitHub not connected.')
        process.exit(0)
      }

      // Look up the credential resource to get installation_id from its config.
      // Credential resources have no auth_user_id so they are not visible under the anon key.
      // Use service key if available; otherwise fall back to the anon client (may return null).
      const credentialId = githubLinks[0].to_id
      // Service key is optional here — if unset we fall back to the anon client.
      // getSupabaseServiceKey() throws when unset, so catch to preserve that fallback.
      let supabaseServiceKey = ''
      try {
        supabaseServiceKey = getSupabaseServiceKey()
      } catch {
        supabaseServiceKey = ''
      }
      const lookupClient = supabaseServiceKey
        ? createSupabaseClient(supabaseUrl, supabaseServiceKey) as any // eslint-disable-line @typescript-eslint/no-explicit-any
        : client
      const { data: credentialResources } = await lookupClient
        .from('resources')
        .select('config')
        .eq('id', credentialId)
        .limit(1)

      const installationId: string =
        (credentialResources?.[0]?.config as Record<string, unknown> | undefined)?.['installation_id'] as string
        ?? 'unknown'

      console.log(`GitHub connected. Installation ID: ${installationId}`)
      process.exit(0)
    })

  // github disconnect — Remove GitHub App connection
  github.command('disconnect')
    .description('Disconnect GitHub App integration')
    .action(async () => {
      const { sub: authUserId, accessToken } = await requireAuth()

      const supabaseUrl = getSupabaseUrl()
      const supabaseAnonKey = getSupabaseAnonKey()

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const client = createAuthenticatedSupabaseClient(supabaseUrl, supabaseAnonKey, accessToken, supabaseFactory as any) as any

      // Find user resource
      const { data: userResources } = await client
        .from('resources')
        .select('id')
        .eq('type', 'user')
        .eq('name', `user:${authUserId}`)
        .limit(1)

      if (!userResources?.length) {
        console.log('GitHub not connected.')
        process.exit(0)
      }

      const userResourceId = userResources[0].id

      // Check if GitHub is connected
      const { data: githubLinks } = await client
        .from('resource_links')
        .select('to_id')
        .eq('from_id', userResourceId)
        .eq('link_type', 'github_app')
        .limit(1)

      if (!githubLinks?.length) {
        console.log('GitHub not connected.')
        process.exit(0)
      }

      // Disconnect
      const executeAction = executeActionFn ?? (await loadExecuteAction())
      await executeAction('remove_github_installation', { userResourceId }, client)

      console.log('GitHub disconnected.')
      console.log('To also remove the app from GitHub: https://github.com/settings/installations')
      process.exit(0)
    })

  return github
}
