/**
 * SSH exec helper for running commands on remote sandbox servers.
 * The private key is held in memory only — never written to disk.
 */
import { Client } from 'ssh2'
import { createLogger } from '@skill-networks/logger'

const logger = createLogger('agent-livestream:ssh-exec')

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SshExecOptions = {
  host: string
  port?: number
  username?: string
  privateKey: string
  command: string
  timeoutMs?: number
}

export type SshExecResult = {
  stdout: string
  stderr: string
  exitCode: number
}

export interface SshExecutor {
  exec(opts: SshExecOptions): Promise<SshExecResult>
}

// ---------------------------------------------------------------------------
// HttpSshExecutor — real ssh2-based implementation
// ---------------------------------------------------------------------------

export class HttpSshExecutor implements SshExecutor {
  exec(opts: SshExecOptions): Promise<SshExecResult> {
    const { host, port = 22, username = 'root', privateKey, command, timeoutMs } = opts

    return new Promise<SshExecResult>((resolve, reject) => {
      const conn = new Client()
      let settled = false
      let timer: ReturnType<typeof setTimeout> | null = null

      function settle(result: SshExecResult | Error) {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        conn.end()
        if (result instanceof Error) {
          reject(result)
        } else {
          resolve(result)
        }
      }

      if (timeoutMs) {
        timer = setTimeout(() => {
          settle(new Error(`SSH exec timed out after ${timeoutMs}ms`))
        }, timeoutMs)
      }

      conn.on('error', (err: Error) => {
        logger.error('SSH connection error', { host, error: err.message })
        settle(err)
      })

      conn.on('ready', () => {
        conn.exec(command, (err, stream) => {
          if (err) {
            settle(err)
            return
          }

          const stdoutChunks: Buffer[] = []
          const stderrChunks: Buffer[] = []
          let exitCode = 0

          stream.on('close', (code: number) => {
            exitCode = code ?? 0
            settle({
              stdout: Buffer.concat(stdoutChunks).toString('utf8'),
              stderr: Buffer.concat(stderrChunks).toString('utf8'),
              exitCode,
            })
          })

          stream.on('data', (chunk: Buffer) => {
            stdoutChunks.push(chunk)
          })

          stream.stderr.on('data', (chunk: Buffer) => {
            stderrChunks.push(chunk)
          })
        })
      })

      // privateKey is passed in-memory via connect() options — NEVER written to disk
      conn.connect({
        host,
        port,
        username,
        privateKey,
      })
    })
  }
}

// ---------------------------------------------------------------------------
// MockSshExecutor — test implementation
// ---------------------------------------------------------------------------

export class MockSshExecutor implements SshExecutor {
  private readonly handler: (opts: SshExecOptions) => Promise<SshExecResult>

  constructor(handler?: (opts: SshExecOptions) => Promise<SshExecResult>) {
    this.handler = handler ?? (() => Promise.resolve({ stdout: 'mock output\n', stderr: '', exitCode: 0 }))
  }

  exec(opts: SshExecOptions): Promise<SshExecResult> {
    return this.handler(opts)
  }
}
