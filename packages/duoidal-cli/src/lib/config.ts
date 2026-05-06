import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { resolveConfigPath } from '@duoidal/config'

// getSubClaim loaded dynamically to avoid rootDir violations
async function loadGetSubClaim(): Promise<(token: string) => string> {
  const specifier = '@duoidal/auth'
  const mod = await (new Function('s', 'return import(s)')(specifier) as Promise<{ getSubClaim: (token: string) => string }>)
  return mod.getSubClaim
}

export const CONFIG_DIR = path.join(os.homedir(), '.config', 'duoidal')
export const TOKEN_PATH = path.join(CONFIG_DIR, 'token.json')
export const PROJECT_PATH = path.join(CONFIG_DIR, 'project.json')
export const SKILLS_JSON_PATH = path.join(CONFIG_DIR, 'skills.json')
export const SKILLS_DIR = path.join(CONFIG_DIR, 'skills')

export interface StoredToken {
  access_token: string
  refresh_token: string
  expires_at?: number
}

export function readToken(): StoredToken | null {
  try {
    const raw = fs.readFileSync(TOKEN_PATH, 'utf-8')
    return JSON.parse(raw) as StoredToken
  } catch {
    return null
  }
}

export function writeToken(token: StoredToken): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 })
  const tmpPath = TOKEN_PATH + '.tmp'
  fs.writeFileSync(tmpPath, JSON.stringify(token, null, 2), { mode: 0o600 })
  fs.renameSync(tmpPath, TOKEN_PATH)
}

export interface StoredProject {
  name: string
  id: string
}

export function readProject(): StoredProject | null {
  try {
    const raw = fs.readFileSync(PROJECT_PATH, 'utf-8')
    const parsed = JSON.parse(raw)
    if (typeof parsed?.id === 'string' && typeof parsed?.name === 'string') {
      return { id: parsed.id, name: parsed.name }
    }
    return null
  } catch {
    return null
  }
}

export function writeProject(project: StoredProject): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 })
  const tmpPath = PROJECT_PATH + '.tmp'
  fs.writeFileSync(tmpPath, JSON.stringify(project, null, 2), { mode: 0o600 })
  fs.renameSync(tmpPath, PROJECT_PATH)
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Delay before retrying a 502/503/504 from provisionSandbox. */
export const PROVISION_RETRY_DELAY_MS = 3000

/** Maximum time to wait for a sandbox server to become active after provisioning. */
export const PROVISION_POLL_DEADLINE_MS = 300_000

// ---------------------------------------------------------------------------

const RESOURCE_ID_RE = /^[0-9a-z_-]{1,64}$/i

function validateResourceId(resourceId: string): void {
  if (!RESOURCE_ID_RE.test(resourceId)) {
    throw new Error(`Invalid resource ID: ${resourceId}`)
  }
}

export function getSandboxKeyDir(resourceId: string): string {
  validateResourceId(resourceId)
  return path.join(CONFIG_DIR, 'sandboxes', resourceId)
}

export function writeSandboxKey(resourceId: string, privateKeyPem: string): string {
  const dir = getSandboxKeyDir(resourceId)
  fs.mkdirSync(dir, { recursive: true })
  const keyPath = path.join(dir, 'id_ed25519')
  fs.writeFileSync(keyPath, privateKeyPem, { mode: 0o600 })
  return keyPath
}

export function getSandboxKeyPath(resourceId: string): string {
  return path.join(getSandboxKeyDir(resourceId), 'id_ed25519')
}

/**
 * Returns the SSH key path for a sandbox identified by its name.
 * Keys are stored at keys/<name>/id_ed25519 relative to the duoidal config directory.
 */
export function getSandboxKeyPathByName(name: string): string {
  const configDir = path.dirname(resolveConfigPath())
  return path.resolve(configDir, 'keys', name, 'id_ed25519')
}

/**
 * Writes the SSH private key for a named sandbox to the config-relative key path.
 * Returns the absolute path where the key was written.
 */
export function writeSandboxKeyByName(name: string, privateKeyPem: string): string {
  const keyPath = getSandboxKeyPathByName(name)
  fs.mkdirSync(path.dirname(keyPath), { recursive: true })
  fs.writeFileSync(keyPath, privateKeyPem, { mode: 0o600 })
  return keyPath
}

/**
 * Extract the actor ID (sub claim) from the stored JWT token.
 * Returns null if no token is stored or the sub claim is missing.
 */
export async function getActorId(): Promise<string | null> {
  const stored = readToken()
  if (!stored) return null
  try {
    const getSubClaim = await loadGetSubClaim()
    return getSubClaim(stored.access_token)
  } catch {
    return null
  }
}
