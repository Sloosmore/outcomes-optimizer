import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// UUID pattern — used to prevent path traversal in sandbox meta reads
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Local sandbox meta storage
export const SANDBOX_META_DIR = path.join(os.homedir(), '.config', 'duoidal', 'sandboxes')

export interface SandboxMeta {
  serverResourceId: string
  credentialResourceId?: string
  serverName: string
  provisionedAt: string
  status: string
  ip?: string
  hetznerServerId?: string
}

export function readSandboxMeta(resourceId: string): SandboxMeta | null {
  if (!UUID_RE.test(resourceId)) return null
  try {
    const raw = fs.readFileSync(path.join(SANDBOX_META_DIR, resourceId, 'meta.json'), 'utf-8')
    return JSON.parse(raw) as SandboxMeta
  } catch {
    return null
  }
}

export function findSandboxResourceIdByName(name: string): string | null {
  try {
    const entries = fs.readdirSync(SANDBOX_META_DIR, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const meta = readSandboxMeta(entry.name)
      if (meta?.serverName === name) return entry.name
    }
    return null
  } catch { return null }
}
