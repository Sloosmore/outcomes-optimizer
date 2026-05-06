import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export interface ServerEntry {
  host: string
  user: string
  key: string
  resource_id?: string
  provider?: string
  hetzner_server_id?: number
  status?: string
  provisioned_at?: string
  credential_resource_id?: string
  worktree_repo?: string
}

export interface DuoidalConfig {
  server: string
  default_link?: string
  servers?: Record<string, ServerEntry>
}

const DEFAULT_CONFIG: DuoidalConfig = { server: 'self' }

/**
 * Resolves the path to the config file using the local-first strategy:
 * 1. $DUOIDAL_CONFIG env var
 * 2. .duoidal/config.json relative to CWD
 * 3. ~/.duoidal/config.json (global fallback)
 */
export function resolveConfigPath(): string {
  // 1. Env var override
  const envPath = process.env['DUOIDAL_CONFIG']
  if (envPath) return envPath

  // 2. Local (CWD-relative)
  const localPath = path.join(process.cwd(), '.duoidal', 'config.json')
  if (fs.existsSync(localPath)) return localPath

  // 3. Global fallback
  const globalPath = path.join(os.homedir(), '.duoidal', 'config.json')
  return globalPath
}

/**
 * Reads the duoidal config using local-first resolution.
 * Auto-creates ~/.duoidal/config.json with { server: 'self' } if nothing exists.
 */
export function readConfig(): DuoidalConfig {
  const configPath = resolveConfigPath()

  try {
    const raw = fs.readFileSync(configPath, 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`Config at ${configPath} must be a JSON object`)
    }
    const obj = parsed as Record<string, unknown>
    if (typeof obj['server'] !== 'string') {
      throw new Error(`Config at ${configPath} missing required "server" field`)
    }
    return parsed as DuoidalConfig
  } catch (err) {
    // Rethrow parse errors and validation errors (non-ENOENT)
    if (err instanceof SyntaxError) throw err
    if (err instanceof Error && (err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    // File doesn't exist — auto-create at global path
    const globalPath = path.join(os.homedir(), '.duoidal', 'config.json')
    writeConfigToPath(DEFAULT_CONFIG, globalPath)
    return { ...DEFAULT_CONFIG }
  }
}

/**
 * Writes config atomically to the resolved config path.
 * If a local config exists, writes there. Otherwise writes to global.
 */
export function writeConfig(config: DuoidalConfig): void {
  const configPath = resolveConfigPath()
  writeConfigToPath(config, configPath)
}

function writeConfigToPath(config: DuoidalConfig, configPath: string): void {
  const dir = path.dirname(configPath)
  // 0o700: only owner can read/write/execute the config directory
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmpPath = configPath + '.tmp'
  // 0o600: only owner can read/write — config stores server IPs and key paths
  fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2), { encoding: 'utf-8', mode: 0o600 })
  fs.renameSync(tmpPath, configPath)
}

/**
 * Returns the named server entry from the resolved config, or null if not found.
 */
export function getServer(name: string): ServerEntry | null {
  const config = readConfig()
  return config.servers?.[name] ?? null
}
