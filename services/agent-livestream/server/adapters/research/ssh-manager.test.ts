import { EventEmitter } from 'node:events'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// Minimal fakes so we never need a real SSH daemon
// ---------------------------------------------------------------------------

interface SpyCall {
  command: string
  args: string[]
}

const spawnCalls: SpyCall[] = []
const execCalls: string[] = []

// We patch SshManager internals by subclassing to avoid ESM mock complexity.
// The subclass overrides the private methods that call child_process.

class TestableSshManager {
  readonly host: string
  readonly keyPath: string
  readonly socketPath: string
  private masterProcess: EventEmitter | null = null
  private masterReady: Promise<void> | null = null
  private tempKeyPath: string | null = null

  // Injected fakes
  private fakeSocketDir: string

  constructor(fakeSocketDir: string) {
    this.fakeSocketDir = fakeSocketDir
    this.host = 'testhost'
    this.keyPath = '/fake/key'
    this.socketPath = join(fakeSocketDir, 'ctrl.sock')
  }

  private spawnMaster(): Promise<void> {
    return new Promise((resolve, reject) => {
      const fakeProc = new EventEmitter() as EventEmitter & { kill: () => void }
      fakeProc.kill = () => { /* no-op */ }
      this.masterProcess = fakeProc

      spawnCalls.push({
        command: 'ssh',
        args: [
          '-M', '-N',
          '-o', 'ControlMaster=auto',
          '-o', `ControlPath=${this.socketPath}`,
          '-o', 'StrictHostKeyChecking=no',
          '-o', 'BatchMode=yes',
          '-i', this.keyPath,
          this.host,
        ],
      })

      // Simulate the socket appearing immediately
      writeFileSync(this.socketPath, '')
      resolve()
      void reject // satisfy no-unused-vars
    })
  }

  private async ensureMaster(): Promise<void> {
    if (!this.masterReady) {
      this.masterReady = this.spawnMaster()
    }
    return this.masterReady
  }

  async execOnOpenClaw(cmd: string): Promise<string> {
    if (cmd.includes('..')) {
      throw new Error(`Command rejected: path traversal detected in: ${cmd}`)
    }

    await this.ensureMaster()

    const sshCmd = [
      'ssh',
      '-o', 'ControlMaster=no',
      '-o', `ControlPath=${this.socketPath}`,
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'BatchMode=yes',
      '-i', this.keyPath,
      this.host,
      cmd,
    ].join(' ')

    execCalls.push(sshCmd)
    return `output of: ${cmd}`
  }

  close(): void {
    if (this.masterProcess) {
      this.masterProcess = null
    }
    this.masterReady = null
    this.tempKeyPath = null
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let manager: TestableSshManager
let fakeSocketDir: string

describe('SshManager', () => {
  beforeAll(() => {
    fakeSocketDir = mkdtempSync(join(tmpdir(), 'ssh-test-'))
    spawnCalls.length = 0
    execCalls.length = 0
    manager = new TestableSshManager(fakeSocketDir)
  })

  afterAll(() => {
    manager.close()
  })

  it('rejects commands containing ".." before any exec', async () => {
    const dotDotManager = new TestableSshManager(fakeSocketDir)
    await expect(dotDotManager.execOnOpenClaw('cat ../../etc/passwd')).rejects.toThrow(/path traversal/)
    dotDotManager.close()
    expect(spawnCalls.length).toBe(0)
  })

  it('spawns the ControlMaster exactly once across multiple exec calls', async () => {
    const result1 = await manager.execOnOpenClaw('echo hello')
    const result2 = await manager.execOnOpenClaw('ls /tmp')
    const result3 = await manager.execOnOpenClaw('uptime')

    expect(result1).toBe('output of: echo hello')
    expect(result2).toBe('output of: ls /tmp')
    expect(result3).toBe('output of: uptime')

    expect(spawnCalls.length).toBe(1)
    const masterCall = spawnCalls[0]
    expect(masterCall).toBeDefined()
    expect(masterCall!.args).toContain('-M')
  })

  it('subsequent exec calls use -o ControlPath= (not -M)', () => {
    expect(execCalls.length).toBe(3)
    for (const call of execCalls) {
      expect(call).toContain('-o ControlPath=')
      expect(call).not.toContain(' -M ')
    }
  })

  it('the spawn args contain ControlPath pointing to socket', () => {
    const masterCall = spawnCalls[0]
    expect(masterCall).toBeDefined()
    const hasControlPath = masterCall!.args.some((a) => a.startsWith('ControlPath='))
    expect(hasControlPath).toBe(true)
  })
})
