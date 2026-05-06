import { readConfig } from '@duoidal/config'

export interface ServerConfig {
  host: string
  user: string
  key: string
  worktree_repo?: string
  container?: string
}

export interface DispatchConfig {
  server: string
  servers?: Record<string, ServerConfig>
  default_link?: string
  /**
   * Optional override for where dispatch worktrees are created. Takes precedence
   * over the default `~/.duoidal/dispatch` (server: self) and `/root/dispatch`
   * (named server) paths. Use this in environments where the default path is
   * not bind-mounted from the outer host into compose service containers
   * (Docker-out-of-Docker setups), e.g. set to `/root/dispatch` inside a runtime
   * container whose `/root/dispatch` is the only bind-mounted path.
   */
  dispatch_base_dir?: string
}

/**
 * Reads the duoidal config using local-first resolution via @duoidal/config.
 * Resolution order: $DUOIDAL_CONFIG env var → .duoidal/config.json (CWD) → ~/.duoidal/config.json
 * Throws if the required 'server' field is missing or not a string.
 */
export function readDispatchConfig(): DispatchConfig {
  const config = readConfig()
  if (!config.server || typeof config.server !== 'string') {
    throw new Error('missing required field: server')
  }
  return config as DispatchConfig
}
