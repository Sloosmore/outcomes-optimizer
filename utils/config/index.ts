import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import { parse } from 'yaml'
import { configSchema } from './schema.js'
import type { Config } from './types.js'
import { CONFIG_FILE } from '../types.js'

// Note: Sync file operations are intentional here - config loading happens at startup
// and must complete before any other operations. Async would add complexity without benefit.
export function loadConfig(configPath?: string): Config {
  const path = configPath ?? resolve(process.cwd(), CONFIG_FILE)

  if (!existsSync(path)) {
    throw new Error(`Config file not found: ${path}`)
  }

  const raw = readFileSync(path, 'utf-8')
  const parsed = parse(raw)
  const result = configSchema.safeParse(parsed)

  if (!result.success) {
    const errors = result.error.issues
      .map(e => `  ${e.path.join('.')}: ${e.message}`)
      .join('\n')
    throw new Error(`Invalid config:\n${errors}`)
  }

  return result.data
}

export { configSchema } from './schema.js'
export type { Config, DatabaseAdapter, CLIAdapter } from './types.js'
