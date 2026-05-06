import * as fs from 'fs'
import * as path from 'path'
import { getCliBashPrefix } from '../cli-prefix.js'

export class ProvisionContext {
  // Set by worktree provisioner
  worktreePath?: string
  skillResourceId?: string
  processId?: string

  // Accumulated by all provisioners (replaces contextFragment return value)
  contextFragments: string[] = []

  // Generic env map — all env vars go through setEnv/getEnv
  private envMap: Map<string, string> = new Map()

  /**
   * Sets a generic env var that will be included in writeEnv() and toShellEnv().
   */
  setEnv(key: string, value: string): void {
    this.envMap.set(key, value)
  }

  /**
   * Reads a generic env var from the envMap.
   */
  getEnv(key: string): string | undefined {
    return this.envMap.get(key)
  }

  private static quote(v: string): string {
    // .env values are read by dotenv (not bash-sourced), so $ and ` do not need escaping.
    // Escaping $ as \$ causes dotenv to pass literal \$ to Node, corrupting passwords.
    return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`
  }

  private static shellQuote(v: string): string {
    // Shell-safe quoting for bash-sourced files (provision-output.env).
    // Escapes \, ", $, and ` — all special inside bash double-quoted strings.
    // Note: ! is not escaped because provision-output.env is sourced by non-interactive
    // scripts where history expansion is disabled by default.
    return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`').replace(/\n/g, '\\n')}"`
  }

  /**
   * Atomically writes all env vars to <worktreePath>/.env (mode 0o600).
   * Uses write-to-temp-then-rename for atomicity. Temp file is written to
   * the same directory as the target so rename stays on the same filesystem.
   */
  writeEnv(): void {
    if (!this.worktreePath) {
      throw new Error('[ProvisionContext] Cannot writeEnv: worktreePath is not set')
    }
    const envPath = path.join(this.worktreePath, '.env')
    const lines: string[] = []

    // Build entries from always-present fields, then all envMap entries
    const envEntries = new Map<string, string>()
    envEntries.set('WORKTREE_PATH', ProvisionContext.quote(this.worktreePath))
    const skillNetworksCli = getCliBashPrefix()
    envEntries.set('SKILL_NETWORKS_CLI', ProvisionContext.quote(skillNetworksCli))
    if (this.skillResourceId) envEntries.set('SKILL_RESOURCE_ID', ProvisionContext.quote(this.skillResourceId))
    if (this.processId) envEntries.set('EVAL_PROCESS_ID', ProvisionContext.quote(this.processId))
    // envMap entries (may override the above)
    for (const [k, v] of this.envMap) {
      envEntries.set(k, ProvisionContext.quote(v))
    }

    for (const [k, v] of envEntries) {
      lines.push(`${k}=${v}`)
    }

    const content = lines.join('\n') + '\n'

    // Write temp file in the same directory so rename is always same-filesystem
    const tmpPath = path.join(this.worktreePath, `.env.tmp.${globalThis.crypto.randomUUID()}`)
    fs.writeFileSync(tmpPath, content, { encoding: 'utf-8', mode: 0o600 })
    try {
      fs.renameSync(tmpPath, envPath)
    } catch (err) {
      fs.unlinkSync(tmpPath)
      throw new Error(`[ProvisionContext] Failed to write env file to ${envPath}: ${(err as Error).message}`)
    }
  }

  /**
   * Returns all provisioned env vars with shell-safe quoting ($ and ` escaped).
   * Used for provision-output.env, which is bash-sourced by dispatch scripts.
   * Distinct from .env (dotenv-safe, unescaped $) — the two consumers require different escaping.
   */
  toShellEnv(): string {
    // Returns '' (not throws) when worktreePath is unset — callers write the result
    // to disk only when non-empty. Unlike writeEnv() which fails loudly because it
    // performs a filesystem write, this method is a pure string builder.
    if (!this.worktreePath) return ''
    // Build entries from always-present fields, then all envMap entries
    const envEntries = new Map<string, string>()
    envEntries.set('WORKTREE_PATH', ProvisionContext.shellQuote(this.worktreePath))
    const skillNetworksCli = getCliBashPrefix()
    envEntries.set('SKILL_NETWORKS_CLI', ProvisionContext.shellQuote(skillNetworksCli))
    if (this.skillResourceId) envEntries.set('SKILL_RESOURCE_ID', ProvisionContext.shellQuote(this.skillResourceId))
    if (this.processId) envEntries.set('EVAL_PROCESS_ID', ProvisionContext.shellQuote(this.processId))
    // envMap entries (may override the above)
    for (const [k, v] of this.envMap) {
      envEntries.set(k, ProvisionContext.shellQuote(v))
    }
    const lines: string[] = []
    for (const [k, v] of envEntries) {
      lines.push(`${k}=${v}`)
    }
    return lines.join('\n') + '\n'
  }

}
