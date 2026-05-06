/**
 * Helper utilities for the compose provisioner:
 *   - parseSharedEnv: reads .compose-shared/.env and returns a key/value map
 *   - discoverPorts:  queries `docker compose ps --format json` to find dynamically
 *                     assigned host ports and returns a DISCOVERED_PORT_* map
 */

import * as fs from 'fs'
import * as path from 'path'
import { spawnSync } from 'child_process'

/**
 * Reads `${sharedDir}/.env`, parses KEY=VALUE lines (skipping blanks and comments),
 * strips surrounding quotes from values, and returns the resulting map.
 * Returns an empty map when the file does not exist.
 */
export function parseSharedEnv(sharedDir: string): Map<string, string> {
  const envPath = path.join(sharedDir, '.env')
  if (!fs.existsSync(envPath)) return new Map()

  const text = fs.readFileSync(envPath, 'utf8')
  const result = new Map<string, string>()

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eqIdx = line.indexOf('=')
    if (eqIdx < 1) continue
    const key = line.slice(0, eqIdx).trim()
    let value = line.slice(eqIdx + 1).trim()
    // Strip surrounding "..." or '...'
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    result.set(key, value)
  }

  return result
}

/**
 * Queries `docker compose -p <projectName> ps --format json` to find all
 * published ports. For each port where PublishedPort > 0, adds an entry:
 *   DISCOVERED_PORT_<SERVICE_UPPER>_<TARGETPORT> → <hostPort>
 *
 * Returns an empty map on any error (e.g. no containers running yet).
 */
export function discoverPorts(projectName: string): Map<string, string> {
  const result = spawnSync(
    'docker',
    ['compose', '-p', projectName, 'ps', '--format', 'json'],
    { stdio: 'pipe', timeout: 10_000 },
  )
  if (result.status !== 0) return new Map()

  const ports = new Map<string, string>()
  const lines = result.stdout.toString().trim().split('\n').filter(Boolean)

  for (const line of lines) {
    let row: Record<string, unknown>
    try {
      row = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    const rawService = row['Service']
    if (typeof rawService !== 'string' || !rawService) continue
    const service = rawService.toUpperCase().replace(/-/g, '_')
    const publishers = (row['Publishers'] ?? []) as Array<{
      PublishedPort: number
      TargetPort: number
    }>
    for (const pub of publishers) {
      if (pub.PublishedPort > 0) {
        ports.set(`DISCOVERED_PORT_${service}_${pub.TargetPort}`, String(pub.PublishedPort))
      }
    }
  }

  return ports
}
