export interface SandboxConnection {
  ip: string
  keyPath: string
}

export interface ProviderAdapter {
  readonly provider: string
  readonly category: 'model' | 'tool'

  /**
   * Link a credential for this provider on the given sandbox.
   * - For 'model' providers: writes CLIProxyAPI auth file via SSH
   * - For 'tool' providers: stores via existing action (e.g. store_github_installation)
   */
  link(options: LinkOptions): Promise<void>

  /**
   * Unlink a credential for this provider.
   * - For 'model' providers: removes auth file + stops CLIProxyAPI via SSH (fail-fast on SSH)
   * - For 'tool' providers: removes credential resource from DB
   */
  unlink(options: UnlinkOptions): Promise<void>
}

export interface LinkOptions {
  credential: string           // plaintext credential value
  sandbox?: SandboxConnection  // required for 'model' providers
  userResourceId?: string      // required for 'tool' providers
  sandboxName?: string         // used for naming/dedup checks
  executeAction?: (name: string, input: Record<string, unknown>, client: unknown) => Promise<Record<string, unknown>>
  supabaseClient?: unknown
}

export interface UnlinkOptions {
  sandbox?: SandboxConnection   // required for 'model' providers
  credentialResourceId?: string // required for 'tool' providers
  executeAction?: (name: string, input: Record<string, unknown>, client: unknown) => Promise<Record<string, unknown>>
  supabaseClient?: unknown
}

export class UnknownProviderError extends Error {
  constructor(provider: string) {
    super(`Unknown provider: ${provider}. Supported providers: anthropic, github`)
    this.name = 'UnknownProviderError'
  }
}

export class AlreadyLinkedError extends Error {
  constructor(provider: string, sandboxName: string) {
    super(`Provider ${provider} is already linked to sandbox ${sandboxName}. Run: duoidal unlink --provider ${provider} --sandbox ${sandboxName} first.`)
    this.name = 'AlreadyLinkedError'
  }
}

export class SandboxUnreachableError extends Error {
  constructor(ip: string) {
    super(`Sandbox ${ip} is unreachable via SSH. Aborting unlink — credentials preserved.`)
    this.name = 'SandboxUnreachableError'
  }
}

export class CLIProxyAPINotFoundError extends Error {
  constructor(ip: string) {
    super(`CLIProxyAPI not found at ~/CLIProxyAPI/ on sandbox ${ip}. Link failed.`)
    this.name = 'CLIProxyAPINotFoundError'
  }
}
