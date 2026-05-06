import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// Mock node:child_process so execFileSync (ssh, scp) doesn't actually run
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    execFileSync: vi.fn(),
  }
})

import { execFileSync } from 'node:child_process'
import { NpmCliInstaller, LocalCliInstaller } from '../lib/cli-installer.js'

const SSH_OPTS = ['-i', '/tmp/key', '-o', 'StrictHostKeyChecking=no']
const IP = '1.2.3.4'
const KEY_PATH = '/tmp/key'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-installer-test-'))
  vi.mocked(execFileSync).mockReset()
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  vi.resetAllMocks()
})

// ---------------------------------------------------------------------------
// NpmCliInstaller
// ---------------------------------------------------------------------------

describe('NpmCliInstaller', () => {
  it('calls ssh with npm install -g @duoidal/cli@<version>', async () => {
    const installer = new NpmCliInstaller()
    await installer.install(IP, KEY_PATH, SSH_OPTS, { version: '0.1.0' })

    const calls = vi.mocked(execFileSync).mock.calls
    // At minimum: npm install call + duoidal init call
    expect(calls.length).toBeGreaterThanOrEqual(2)
    const [cmd, args] = calls[0]!
    expect(cmd).toBe('ssh')
    // SSH opts forwarded
    expect(args).toEqual(expect.arrayContaining(SSH_OPTS))
    // Remote target
    expect(args).toContain(`root@${IP}`)
    // npm install command
    const remoteCmd = (args as string[]).find(a => a.includes('npm install'))
    expect(remoteCmd).toBeDefined()
    expect(remoteCmd).toContain('npm install -g @duoidal/cli@0.1.0')
  })

  it('calls duoidal init after install to provision bundled skills', async () => {
    const installer = new NpmCliInstaller()
    await installer.install(IP, KEY_PATH, SSH_OPTS, { version: '0.1.0' })

    const calls = vi.mocked(execFileSync).mock.calls
    const initCall = calls.find(([_cmd, args]) =>
      (args as string[]).some(a => typeof a === 'string' && a.includes('duoidal init'))
    )
    expect(initCall).toBeDefined()
    expect(initCall![0]).toBe('ssh')
    expect(initCall![1]).toEqual(expect.arrayContaining(SSH_OPTS))
    expect(initCall![1]).toContain(`root@${IP}`)
  })

  it('throws when version is not provided', async () => {
    const installer = new NpmCliInstaller()
    await expect(installer.install(IP, KEY_PATH, SSH_OPTS, {})).rejects.toThrow(
      'NpmCliInstaller requires options.version to be set'
    )
    expect(execFileSync).not.toHaveBeenCalled()
  })

  it('throws when version is not valid semver', async () => {
    const installer = new NpmCliInstaller()
    await expect(installer.install(IP, KEY_PATH, SSH_OPTS, { version: 'not-valid; rm -rf /' })).rejects.toThrow(
      'NpmCliInstaller: invalid version format'
    )
    expect(execFileSync).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// LocalCliInstaller
// ---------------------------------------------------------------------------

describe('LocalCliInstaller', () => {
  function makeCliPkgDir(): string {
    const pkgDir = path.join(tmpDir, 'duoidal-cli')
    const distDir = path.join(pkgDir, 'dist')
    fs.mkdirSync(distDir, { recursive: true })
    // Minimal package.json with a devDependency that should be stripped
    fs.writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({
        name: '@duoidal/cli',
        version: '0.1.0',
        dependencies: { commander: '^12.0.0' },
        devDependencies: { typescript: 'workspace:*' },
      })
    )
    // A dist file so scp has something to copy
    fs.writeFileSync(path.join(distDir, 'index.js'), '// cli dist')
    return pkgDir
  }

  it('runs ssh mkdir, scp dist, scp package.json, ssh npm install+link, ssh duoidal init', async () => {
    const pkgDir = makeCliPkgDir()
    const installer = new LocalCliInstaller()
    await installer.install(IP, KEY_PATH, SSH_OPTS, { cliPkgDir: pkgDir })

    const calls = vi.mocked(execFileSync).mock.calls
    expect(calls).toHaveLength(5)

    // 1. ssh mkdir -p /root/duoidal-cli
    const [mkdirCmd, mkdirArgs] = calls[0]!
    expect(mkdirCmd).toBe('ssh')
    expect((mkdirArgs as string[]).join(' ')).toContain('mkdir -p /root/duoidal-cli')

    // 2. scp -r <dist> root@<ip>:/root/duoidal-cli/
    const [scpDistCmd, scpDistArgs] = calls[1]!
    expect(scpDistCmd).toBe('scp')
    const scpDistStr = (scpDistArgs as string[]).join(' ')
    expect(scpDistStr).toContain('-r')
    expect(scpDistStr).toContain('dist')
    expect(scpDistStr).toContain(`root@${IP}:/root/duoidal-cli/`)

    // 3. scp <package.json> root@<ip>:/root/duoidal-cli/package.json
    const [scpPkgCmd, scpPkgArgs] = calls[2]!
    expect(scpPkgCmd).toBe('scp')
    const scpPkgStr = (scpPkgArgs as string[]).join(' ')
    expect(scpPkgStr).toContain(`root@${IP}:/root/duoidal-cli/package.json`)

    // 4. ssh cd /root/duoidal-cli && npm install --omit=dev && npm link
    const [npmCmd, npmArgs] = calls[3]!
    expect(npmCmd).toBe('ssh')
    const npmStr = (npmArgs as string[]).join(' ')
    expect(npmStr).toContain('npm install --omit=dev')
    expect(npmStr).toContain('npm link')

    // 5. ssh duoidal init (fetches skills from BFF using stored token)
    const [skillsCmd, skillsArgs] = calls[4]!
    expect(skillsCmd).toBe('ssh')
    const skillsStr = (skillsArgs as string[]).join(' ')
    expect(skillsStr).toContain('duoidal init')
  })

  it('strips devDependencies from the deployed package.json', async () => {
    const pkgDir = makeCliPkgDir()
    const installer = new LocalCliInstaller()
    await installer.install(IP, KEY_PATH, SSH_OPTS, { cliPkgDir: pkgDir })

    // The scp call for package.json copies a temp file — verify that file has no devDependencies
    const calls = vi.mocked(execFileSync).mock.calls
    const scpPkgArgs = calls[2]![1] as string[]
    // The source path is the temp file written by LocalCliInstaller (in a unique temp dir)
    const deployPkgPath = scpPkgArgs.find(a => a.includes('duoidal-cli-deploy-') && a.endsWith('package.json'))
    expect(deployPkgPath).toBeDefined()
    const deployPkg = JSON.parse(fs.readFileSync(deployPkgPath!, 'utf-8')) as Record<string, unknown>
    expect(deployPkg['devDependencies']).toBeUndefined()
    expect(deployPkg['dependencies']).toBeDefined()
  })

  it('throws when cliPkgDir is not provided', async () => {
    const installer = new LocalCliInstaller()
    await expect(installer.install(IP, KEY_PATH, SSH_OPTS, {})).rejects.toThrow(
      'LocalCliInstaller requires options.cliPkgDir to be set'
    )
    expect(execFileSync).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// NpmCliInstaller token stamping
// ---------------------------------------------------------------------------

import { StoredToken } from '../lib/config.js'

const SAMPLE_TOKEN: StoredToken = {
  access_token: 'eytest.eyJzdWIiOiJ1c2VyMSJ9.sig',
  refresh_token: 'refresh123',
}

describe('NpmCliInstaller token stamping', () => {
  it('when token provided, stamps token.json via SSH stdin pipe', async () => {
    const installer = new NpmCliInstaller()
    await (installer.install as any)(IP, KEY_PATH, SSH_OPTS, { version: '1.0.0' }, SAMPLE_TOKEN)

    const calls = vi.mocked(execFileSync).mock.calls
    // There must be at least 2 calls: the npm install call + the token stamp call
    expect(calls.length).toBeGreaterThanOrEqual(2)

    // Find the call that writes token.json
    const tokenCall = calls.find(([_cmd, args]) =>
      (args as string[]).some(a => typeof a === 'string' && a.includes('cat > ~/.config/duoidal/token.json'))
    )
    expect(tokenCall).toBeDefined()

    // The input option must contain the JSON-encoded token
    const tokenCallOpts = tokenCall![2] as Record<string, unknown> | undefined
    expect(tokenCallOpts).toBeDefined()
    expect(tokenCallOpts!['input']).toBe(JSON.stringify(SAMPLE_TOKEN))
  })

  it('token never appears in args (negative assertion)', async () => {
    const installer = new NpmCliInstaller()
    await (installer.install as any)(IP, KEY_PATH, SSH_OPTS, { version: '1.0.0' }, SAMPLE_TOKEN)

    const calls = vi.mocked(execFileSync).mock.calls
    for (const [_cmd, args] of calls) {
      for (const arg of args as string[]) {
        expect(arg).not.toContain(SAMPLE_TOKEN.access_token)
      }
    }
  })

  it('chmod 0600 is applied to token.json', async () => {
    const installer = new NpmCliInstaller()
    await (installer.install as any)(IP, KEY_PATH, SSH_OPTS, { version: '1.0.0' }, SAMPLE_TOKEN)

    const calls = vi.mocked(execFileSync).mock.calls
    const hasChmod = calls.some(([_cmd, args]) =>
      (args as string[]).some(a => typeof a === 'string' && a.includes('chmod') && a.includes('0600'))
    )
    expect(hasChmod).toBe(true)
  })

  it('when token not provided, no token.json write occurs', async () => {
    const installer = new NpmCliInstaller()
    await installer.install(IP, KEY_PATH, SSH_OPTS, { version: '1.0.0' })

    const calls = vi.mocked(execFileSync).mock.calls
    const hasTokenWrite = calls.some(([_cmd, args]) =>
      (args as string[]).some(
        a => typeof a === 'string' && a.includes('token.json')
      )
    )
    expect(hasTokenWrite).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// LocalCliInstaller token stamping
// ---------------------------------------------------------------------------

describe('LocalCliInstaller token stamping', () => {
  function makeCliPkgDir(): string {
    const pkgDir = path.join(tmpDir, 'duoidal-cli-token-test')
    const distDir = path.join(pkgDir, 'dist')
    fs.mkdirSync(distDir, { recursive: true })
    fs.writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({
        name: '@duoidal/cli',
        version: '1.0.0',
        dependencies: { commander: '^12.0.0' },
      })
    )
    fs.writeFileSync(path.join(distDir, 'index.js'), '// cli dist')
    return pkgDir
  }

  it('when token provided, stamps token.json via SSH stdin pipe', async () => {
    const pkgDir = makeCliPkgDir()
    const installer = new LocalCliInstaller()
    await (installer.install as any)(IP, KEY_PATH, SSH_OPTS, { cliPkgDir: pkgDir }, SAMPLE_TOKEN)

    const calls = vi.mocked(execFileSync).mock.calls
    // LocalCliInstaller normally does 4 calls; with token there must be at least 5
    expect(calls.length).toBeGreaterThanOrEqual(5)

    // Find the call that writes token.json
    const tokenCall = calls.find(([_cmd, args]) =>
      (args as string[]).some(a => typeof a === 'string' && a.includes('cat > ~/.config/duoidal/token.json'))
    )
    expect(tokenCall).toBeDefined()

    // The input option must contain the JSON-encoded token
    const tokenCallOpts = tokenCall![2] as Record<string, unknown> | undefined
    expect(tokenCallOpts).toBeDefined()
    expect(tokenCallOpts!['input']).toBe(JSON.stringify(SAMPLE_TOKEN))
  })

  it('token never appears in args (negative assertion)', async () => {
    const pkgDir = makeCliPkgDir()
    const installer = new LocalCliInstaller()
    await (installer.install as any)(IP, KEY_PATH, SSH_OPTS, { cliPkgDir: pkgDir }, SAMPLE_TOKEN)

    const calls = vi.mocked(execFileSync).mock.calls
    for (const [_cmd, args] of calls) {
      for (const arg of args as string[]) {
        expect(arg).not.toContain(SAMPLE_TOKEN.access_token)
      }
    }
  })

  it('chmod 0600 is applied to token.json', async () => {
    const pkgDir = makeCliPkgDir()
    const installer = new LocalCliInstaller()
    await (installer.install as any)(IP, KEY_PATH, SSH_OPTS, { cliPkgDir: pkgDir }, SAMPLE_TOKEN)

    const calls = vi.mocked(execFileSync).mock.calls
    const hasChmod = calls.some(([_cmd, args]) =>
      (args as string[]).some(a => typeof a === 'string' && a.includes('chmod') && a.includes('0600'))
    )
    expect(hasChmod).toBe(true)
  })

  it('when token not provided, no token.json write occurs', async () => {
    const pkgDir = makeCliPkgDir()
    const installer = new LocalCliInstaller()
    await installer.install(IP, KEY_PATH, SSH_OPTS, { cliPkgDir: pkgDir })

    const calls = vi.mocked(execFileSync).mock.calls
    const hasTokenWrite = calls.some(([_cmd, args]) =>
      (args as string[]).some(
        a => typeof a === 'string' && a.includes('token.json')
      )
    )
    expect(hasTokenWrite).toBe(false)
  })
})
