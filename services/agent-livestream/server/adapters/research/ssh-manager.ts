import { spawn, execFile } from 'node:child_process'
import { writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'

const execFileAsync = promisify(execFile)

export class SshManager {
  private readonly host: string
  private readonly keyPath: string
  private readonly socketPath: string
  private masterProcess: ChildProcess | null = null
  private masterReady: Promise<void> | null = null
  private tempKeyPath: string | null = null

  constructor() {
    this.host = process.env['OPENCLAW_HOST'] ?? ''
    const rawKey = process.env['OPENCLAW_SSH_KEY'] ?? ''
    this.socketPath = `/tmp/ssh-ctrl-${randomUUID()}.sock`
    this.keyPath = this.resolveKeyPath(rawKey)
  }

  /** Returns true if SSH host is configured (OPENCLAW_HOST is set and non-empty). */
  isConfigured(): boolean {
    return this.host.trim().length > 0
  }

  private resolveKeyPath(rawKey: string): string {
    if (!rawKey) return ''
    // If it looks like a file path (no newlines, exists on disk), use it directly
    if (!rawKey.includes('\n') && existsSync(rawKey)) {
      return rawKey
    }
    // Otherwise treat as raw key contents — write to a temp file
    const tmpPath = join(tmpdir(), `ssh-key-${randomUUID()}.pem`)
    writeFileSync(tmpPath, rawKey, { mode: 0o600 })
    this.tempKeyPath = tmpPath
    return tmpPath
  }

  private spawnMaster(): Promise<void> {
    return new Promise((resolve, reject) => {
      const args = [
        '-M',
        '-N',
        '-o', 'ControlMaster=auto',
        '-o', `ControlPath=${this.socketPath}`,
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'BatchMode=yes',
      ]
      if (this.keyPath) {
        args.push('-i', this.keyPath)
      }
      args.push(this.host)

      this.masterProcess = spawn('ssh', args, { stdio: 'ignore' })

      this.masterProcess.on('error', reject)

      // Give the master a moment to establish the socket
      const checkReady = (attempts: number) => {
        if (attempts <= 0) {
          reject(new Error('SSH ControlMaster did not become ready in time'))
          return
        }
        setTimeout(() => {
          if (existsSync(this.socketPath)) {
            resolve()
          } else {
            checkReady(attempts - 1)
          }
        }, 200)
      }

      checkReady(25) // up to 5 seconds
    })
  }

  private async ensureMaster(): Promise<void> {
    if (!this.masterReady) {
      this.masterReady = this.spawnMaster().catch((err) => {
        // Clear so the next call retries rather than replaying the rejected promise.
        this.masterReady = null
        throw err
      })
    }
    return this.masterReady
  }

  async execOnOpenClaw(cmd: string, timeoutMs?: number): Promise<string> {
    if (cmd.includes('..')) {
      throw new Error(`Command rejected: path traversal detected in: ${cmd}`)
    }

    await this.ensureMaster()

    const args = [
      '-o', 'ControlMaster=no',
      '-o', `ControlPath=${this.socketPath}`,
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'BatchMode=yes',
    ]
    if (this.keyPath) {
      args.push('-i', this.keyPath)
    }
    args.push(this.host, cmd)

    // Use execFile (not exec) so the cmd is passed as a single argv element to SSH —
    // shell metacharacters in cmd are interpreted by the *remote* shell, not locally.
    const { stdout } = await execFileAsync('ssh', args, { timeout: timeoutMs ?? 30_000, maxBuffer: 10 * 1024 * 1024 })
    return stdout
  }

  close(): void {
    if (this.masterProcess) {
      this.masterProcess.kill()
      this.masterProcess = null
    }
    this.masterReady = null

    if (existsSync(this.socketPath)) {
      try {
        unlinkSync(this.socketPath)
      } catch {
        // best-effort cleanup
      }
    }

    if (this.tempKeyPath && existsSync(this.tempKeyPath)) {
      try {
        unlinkSync(this.tempKeyPath)
        this.tempKeyPath = null
      } catch {
        // best-effort cleanup
      }
    }
  }
}
