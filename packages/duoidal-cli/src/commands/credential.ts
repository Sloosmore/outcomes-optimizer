import { Command } from 'commander'
import fs from 'node:fs'
import { getSandboxKeyPathByName } from '../lib/config.js'
import { decodeJwt, getSubClaim } from '@duoidal/auth'
import { createAuthenticatedSupabaseClient } from '@duoidal/auth/adapters'
import { loadExecuteAction, getSupabaseAnonKey, getSupabaseUrl } from '../lib/helpers.js'
import { requireAuth } from '../lib/require-auth.js'
import { resolveProvider, UnknownProviderError } from '../providers/index.js'
import { SandboxUnreachableError } from '../providers/types.js'
import { readConfig } from '@duoidal/config'

// Minimal shape needed by link/unlink for sandbox access
export interface SandboxMeta {
  ip: string
  status: string
  serverResourceId?: string
  credentialResourceId?: string
}

type ExecuteActionFn = (name: string, input: Record<string, unknown>, client: unknown) => Promise<Record<string, unknown>>
type SupabaseClientFactory = (url: string, key: string) => unknown

export interface LinkCommandDeps {
  executeActionFactory?: ExecuteActionFn
  supabaseFactory?: SupabaseClientFactory
  findSandboxByNameFn?: (name: string) => string | null
  readSandboxMetaFn?: (id: string) => SandboxMeta | null
  getSandboxKeyPathFn?: (id: string) => string
}

// Default implementation: look up sandbox by name in config
function defaultFindSandboxByName(name: string): string | null {
  const cfg = readConfig()
  return cfg.servers?.[name] ? name : null
}

// Default implementation: read sandbox entry from config, mapping host → ip
function defaultReadSandboxMeta(name: string): SandboxMeta | null {
  const cfg = readConfig()
  const entry = cfg.servers?.[name]
  if (!entry) return null
  return {
    ip: entry.host,
    status: entry.status ?? 'unknown',
    serverResourceId: entry.resource_id,
    credentialResourceId: entry.credential_resource_id,
  }
}

// Default implementation: get key path by name
function defaultGetSandboxKeyPath(name: string): string {
  return getSandboxKeyPathByName(name)
}

export function linkCommand(deps?: LinkCommandDeps): Command {
  const cmd = new Command('link')
  cmd.description('Link a credential provider to a sandbox')
    .requiredOption('--provider <provider>', 'Provider name (e.g. anthropic, github)')
    .requiredOption('--sandbox <name>', 'Sandbox name')
    .requiredOption('--credential-file <path>', 'Path to file containing the credential value')
    .action(async (opts: { provider: string; sandbox: string; credentialFile: string }) => {
      const { provider: providerName, sandbox: sandboxName, credentialFile } = opts

      // 1. Read auth token
      const { accessToken } = await requireAuth()

      // 2. Resolve Supabase config
      const supabaseUrl = getSupabaseUrl()
      const supabaseAnonKey = getSupabaseAnonKey()

      // 3. Resolve adapter
      let adapter
      try {
        adapter = resolveProvider(providerName)
      } catch (err) {
        if (err instanceof UnknownProviderError) {
          console.error(err.message)
          process.exit(1)
        }
        throw err
      }

      // 4. Read credential from file
      let credential: string
      try {
        credential = fs.readFileSync(credentialFile, 'utf-8').trim()
      } catch {
        console.error(`Error: could not read credential file: ${credentialFile}`)
        process.exit(1)
      }

      // 5. Resolve sandbox by name
      const findFn = deps?.findSandboxByNameFn ?? defaultFindSandboxByName
      const readMetaFn = deps?.readSandboxMetaFn ?? defaultReadSandboxMeta
      const getKeyPathFn = deps?.getSandboxKeyPathFn ?? defaultGetSandboxKeyPath

      const resourceId = findFn(sandboxName)
      if (!resourceId) {
        console.error(`No local sandbox found with name '${sandboxName}'`)
        process.exit(1)
      }

      const meta = readMetaFn(resourceId)
      if (!meta?.ip) {
        console.error(`Sandbox '${sandboxName}' has no IP address. Is it active?`)
        process.exit(1)
      }

      const keyPath = getKeyPathFn(resourceId)
      const { ip } = meta

      // 6. Build Supabase client
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const client = createAuthenticatedSupabaseClient(supabaseUrl, supabaseAnonKey, accessToken, deps?.supabaseFactory as any) as any

      // 7. Decode JWT to get authUserId
      let authUserId: string
      try {
        authUserId = getSubClaim(accessToken)
      } catch {
        console.error('Error: could not extract user ID from token. Please log in again.')
        process.exit(1)
      }
      const email = decodeJwt(accessToken).email ?? ''

      // 8. Get userResourceId (idempotent)
      const executeAction = deps?.executeActionFactory ?? (await loadExecuteAction())
      const userResult = await executeAction('provision_user', { authUserId, email }, client) as { userResourceId: string }
      const { userResourceId } = userResult

      // 9. Route by category
      if (adapter.category === 'model') {
        // 9a. Store credential in vault
        try {
          await executeAction('store_user_credential', {
            userResourceId,
            sandboxName,
            provider: providerName,
            credentialValue: credential,
          }, client)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          // SQLSTATE P0001 or message containing "Already linked"
          if (msg.includes('Already linked') || msg.includes('P0001')) {
            console.error(`Provider ${providerName} is already linked to sandbox ${sandboxName}. Run: duoidal unlink --provider ${providerName} --sandbox ${sandboxName} first.`)
            process.exit(1)
          }
          throw err
        }

        // 9b. Call adapter.link
        await adapter.link({
          credential,
          sandbox: { ip, keyPath },
          userResourceId,
          sandboxName,
        })
      } else {
        // Tool provider (e.g. github)
        // 9a. Check if already linked (scoped to current user)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: existingCreds } = await (client as any)
          .from('resources')
          .select('id, config')
          .eq('type', 'credential')
          .eq('auth_user_id', authUserId)
          .eq('config->>provider', providerName)
          .eq('config->>sandboxName', sandboxName)

        if (existingCreds && existingCreds.length > 0) {
          console.error(`Provider ${providerName} is already linked to sandbox ${sandboxName}. Run: duoidal unlink --provider ${providerName} --sandbox ${sandboxName} first.`)
          process.exit(1)
        }

        // 9b. Call adapter.link
        await adapter.link({
          credential,
          userResourceId,
          executeAction,
          supabaseClient: client,
          sandboxName,
        })
      }

      // 10. Success
      console.log(`Linked ${providerName} to sandbox ${sandboxName}`)
    })

  return cmd
}

export interface UnlinkCommandDeps {
  executeActionFactory?: ExecuteActionFn
  supabaseFactory?: SupabaseClientFactory
  findSandboxByNameFn?: (name: string) => string | null
  readSandboxMetaFn?: (id: string) => SandboxMeta | null
  getSandboxKeyPathFn?: (id: string) => string
}

export function unlinkCommand(deps?: UnlinkCommandDeps): Command {
  const cmd = new Command('unlink')
  cmd.description('Unlink a credential provider from a sandbox')
    .requiredOption('--provider <provider>', 'Provider name (e.g. anthropic, github)')
    .requiredOption('--sandbox <name>', 'Sandbox name')
    .action(async (opts: { provider: string; sandbox: string }) => {
      const { provider: providerName, sandbox: sandboxName } = opts

      // 1. Read auth token
      const { accessToken } = await requireAuth()

      // 2. Resolve Supabase config
      const supabaseUrl = getSupabaseUrl()
      const supabaseAnonKey = getSupabaseAnonKey()

      // 3. Resolve adapter
      let adapter
      try {
        adapter = resolveProvider(providerName)
      } catch (err) {
        if (err instanceof UnknownProviderError) {
          console.error(err.message)
          process.exit(1)
        }
        throw err
      }

      // 4. Resolve sandbox by name
      const findFn = deps?.findSandboxByNameFn ?? defaultFindSandboxByName
      const readMetaFn = deps?.readSandboxMetaFn ?? defaultReadSandboxMeta
      const getKeyPathFn = deps?.getSandboxKeyPathFn ?? defaultGetSandboxKeyPath

      const resourceId = findFn(sandboxName)
      if (!resourceId) {
        console.error(`No local sandbox found with name '${sandboxName}'`)
        process.exit(1)
      }

      // 5. Build Supabase client
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const client = createAuthenticatedSupabaseClient(supabaseUrl, supabaseAnonKey, accessToken, deps?.supabaseFactory as any) as any

      // 6. Decode JWT to get authUserId
      let authUserId: string
      try {
        authUserId = getSubClaim(accessToken)
      } catch {
        console.error('Error: could not extract user ID from token. Please log in again.')
        process.exit(1)
      }
      const email = decodeJwt(accessToken).email ?? ''

      // 7. Get userResourceId (provision_user is idempotent)
      const executeAction = deps?.executeActionFactory ?? (await loadExecuteAction())
      await executeAction('provision_user', { authUserId, email }, client)

      // 8. Find credentialResourceId (scoped to current user)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: credRows } = await (client as any)
        .from('resources')
        .select('id')
        .eq('type', 'credential')
        .eq('auth_user_id', authUserId)
        .eq('config->>provider', providerName)
        .eq('config->>sandboxName', sandboxName)

      if (!credRows || credRows.length === 0) {
        console.log(`${providerName}: not linked to sandbox ${sandboxName}`)
        return
      }

      const credentialResourceId = (credRows[0] as { id: string }).id

      // 9. Route by category
      if (adapter.category === 'model') {
        // 9a. Get sandbox IP and keyPath
        const meta = readMetaFn(resourceId)
        if (!meta?.ip) {
          console.error(`Sandbox '${sandboxName}' has no IP address. Is it active?`)
          process.exit(1)
        }

        const { ip } = meta
        const keyPath = getKeyPathFn(resourceId)

        // 9b. Call adapter.unlink — fail-fast on SSH error (SC-7)
        try {
          await adapter.unlink({ sandbox: { ip, keyPath } })
        } catch (err) {
          if (err instanceof SandboxUnreachableError) {
            console.error(err.message)
            process.exit(1)
          }
          throw err
        }

        // 9c. ONLY after adapter.unlink() succeeds, delete from DB/vault
        await executeAction('delete_user_credential', { credentialResourceId }, client)
      } else {
        // Tool provider (e.g. github)
        await adapter.unlink({ credentialResourceId, executeAction, supabaseClient: client })
      }

      // 10. Success
      console.log(`Unlinked ${providerName} from sandbox ${sandboxName}`)
    })

  return cmd
}
