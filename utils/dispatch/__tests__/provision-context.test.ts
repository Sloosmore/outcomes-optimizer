import * as os from 'os'
import * as path from 'path'
import * as fs from 'fs'
import { ProvisionContext } from '../provision-context.js'

// ---------------------------------------------------------------------------
// ProvisionContext.setEnv — generic env map with override semantics
// ---------------------------------------------------------------------------

describe('ProvisionContext.setEnv', () => {
  it('stores generic env vars in toShellEnv()', () => {
    const ctx = new ProvisionContext()
    ctx.worktreePath = '/tmp/wt'
    ctx.setEnv('CUSTOM_KEY', 'custom_value')
    const env = ctx.toShellEnv()
    expect(env).toContain('CUSTOM_KEY=')
    expect(env).toContain('custom_value')
  })

  it('generic map entries appear in writeEnv() — setEnv is the canonical writer', () => {
    const ctx = new ProvisionContext()
    ctx.worktreePath = '/tmp/wt'
    ctx.setEnv('DATABASE_URL', 'postgres://override')
    const env = ctx.toShellEnv()
    expect(env).toContain('postgres://override')
  })

  it('generic map entries appear in writeEnv() .env file', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-'))
    const ctx = new ProvisionContext()
    ctx.worktreePath = tmpDir
    ctx.setEnv('MY_VAR', 'my_value')
    ctx.writeEnv()
    const content = fs.readFileSync(path.join(tmpDir, '.env'), 'utf-8')
    expect(content).toContain('MY_VAR=')
    expect(content).toContain('my_value')
    fs.rmSync(tmpDir, { recursive: true })
  })
})

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// ---------------------------------------------------------------------------
// toShellEnv — dual-consumer architecture: shell-safe for bash-sourced files
// ---------------------------------------------------------------------------

describe('ProvisionContext.toShellEnv', () => {
  it('escapes $ in values — prevents bash variable expansion when sourced', () => {
    // provision-output.env is bash-sourced by dispatch scripts.
    // $ in values (e.g. passwords like "6$Af5B") must be escaped as \$ so bash
    // does not expand them. This is the inverse of .env (dotenv-safe, unescaped $).
    const ctx = new ProvisionContext()
    ctx.worktreePath = '/tmp/wt'
    ctx.setEnv('DATABASE_URL', 'postgres://user:6$Af5B@host/db')
    const env = ctx.toShellEnv()
    expect(env).toContain('DATABASE_URL="postgres://user:6\\$Af5B@host/db"')
  })

  it('escapes backticks in values — prevents command substitution when bash-sourced', () => {
    const ctx = new ProvisionContext()
    ctx.worktreePath = '/tmp/wt'
    ctx.setEnv('DATABASE_URL', 'value`with`backticks')
    const env = ctx.toShellEnv()
    expect(env).toContain('DATABASE_URL="value\\`with\\`backticks"')
  })

  it('escapes double-quotes in values', () => {
    const ctx = new ProvisionContext()
    ctx.worktreePath = '/tmp/wt'
    ctx.setEnv('DATABASE_URL', 'value"with"quotes')
    const env = ctx.toShellEnv()
    expect(env).toContain('DATABASE_URL="value\\"with\\"quotes"')
  })

  it('includes all provisioned vars — not just WORKTREE_PATH/SKILL_RESOURCE_ID', () => {
    const ctx = new ProvisionContext()
    ctx.worktreePath = '/tmp/wt'
    ctx.skillResourceId = 'aaaa-bbbb'
    ctx.setEnv('DATABASE_URL', 'postgres://host/db')
    ctx.setEnv('DIRECT_URL', 'postgres://host/db-direct')
    ctx.setEnv('CREDENTIAL_PROXY_URL', 'http://localhost:9000')
    ctx.setEnv('CREDENTIAL_PROXY_PORT', '9000')
    const env = ctx.toShellEnv()
    expect(env).toContain('WORKTREE_PATH=')
    expect(env).toContain('SKILL_RESOURCE_ID="aaaa-bbbb"')
    expect(env).toContain('DATABASE_URL="postgres://host/db"')
    expect(env).toContain('DIRECT_URL="postgres://host/db-direct"')
    expect(env).toContain('CREDENTIAL_PROXY_URL="http://localhost:9000"')
    expect(env).toContain('CREDENTIAL_PROXY_PORT="9000"')
  })

  it('returns empty string when worktreePath is not set', () => {
    const ctx = new ProvisionContext()
    ctx.setEnv('DATABASE_URL', 'postgres://host/db')
    expect(ctx.toShellEnv()).toBe('')
  })

  it('includes EVAL_PROCESS_ID when processId is set', () => {
    const ctx = new ProvisionContext()
    ctx.worktreePath = '/tmp/wt'
    ctx.processId = 'test-uuid-1234'
    const env = ctx.toShellEnv()
    expect(env).toContain('EVAL_PROCESS_ID="test-uuid-1234"')
  })

  it('excludes EVAL_PROCESS_ID when processId is not set', () => {
    const ctx = new ProvisionContext()
    ctx.worktreePath = '/tmp/wt'
    const env = ctx.toShellEnv()
    expect(env).not.toContain('EVAL_PROCESS_ID')
  })
})

// ---------------------------------------------------------------------------
// writeEnv — skillResourceId field + quoting
// ---------------------------------------------------------------------------

describe('ProvisionContext.writeEnv', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'provision-ctx-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('includes SKILL_RESOURCE_ID when skillResourceId is set', () => {
    const ctx = new ProvisionContext()
    ctx.worktreePath = tmpDir
    ctx.skillResourceId = 'aaaabbbb-cccc-dddd-eeee-ffffgggghhh0'
    ctx.writeEnv()
    const content = fs.readFileSync(path.join(tmpDir, '.env'), 'utf-8')
    expect(content).toContain('SKILL_RESOURCE_ID="aaaabbbb-cccc-dddd-eeee-ffffgggghhh0"')
  })

  it('excludes SKILL_RESOURCE_ID when skillResourceId is not set', () => {
    const ctx = new ProvisionContext()
    ctx.worktreePath = tmpDir
    ctx.writeEnv()
    const content = fs.readFileSync(path.join(tmpDir, '.env'), 'utf-8')
    expect(content).not.toContain('SKILL_RESOURCE_ID')
  })

  it('does NOT escape $ in values — dotenv reads them literally, no interpolation', () => {
    // .env is loaded by dotenv (import 'dotenv/config'), not bash-sourced.
    // dotenv does not interpolate $ in double-quoted values, so escaping $ as \$
    // was causing dotenv to pass literal \$ to Node, corrupting passwords like "6$Af5B".
    // provision-output.env (bash-sourced) uses toShellEnv() which DOES escape $.
    const ctx = new ProvisionContext()
    ctx.worktreePath = tmpDir
    ctx.setEnv('DATABASE_URL', 'postgres://user:6$Af5B@host/db')
    ctx.writeEnv()
    const content = fs.readFileSync(path.join(tmpDir, '.env'), 'utf-8')
    expect(content).toContain('DATABASE_URL="postgres://user:6$Af5B@host/db"')
  })

  it('does NOT escape backticks in values — not special in dotenv double-quoted strings', () => {
    const ctx = new ProvisionContext()
    ctx.worktreePath = tmpDir
    ctx.setEnv('DATABASE_URL', 'value`with`backticks')
    ctx.writeEnv()
    const content = fs.readFileSync(path.join(tmpDir, '.env'), 'utf-8')
    expect(content).toContain('DATABASE_URL="value`with`backticks"')
  })

  it('escapes double-quotes in values', () => {
    const ctx = new ProvisionContext()
    ctx.worktreePath = tmpDir
    ctx.setEnv('DATABASE_URL', 'value"with"quotes')
    ctx.writeEnv()
    const content = fs.readFileSync(path.join(tmpDir, '.env'), 'utf-8')
    expect(content).toContain('DATABASE_URL="value\\"with\\"quotes"')
  })

  it('uses crypto.randomUUID() for temp filename (not pid+timestamp)', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../provision-context.ts'),
      'utf-8'
    )
    expect(src).toMatch(/randomUUID\(\)/)
    expect(src).not.toMatch(/process\.pid.*Date\.now|Date\.now.*process\.pid/)
  })

  it('concurrent writeEnv() calls produce unique UUID temp filenames', async () => {
    // Spy on globalThis.crypto.randomUUID to record UUIDs used for temp filenames.
    // crypto is a plain object (not an ESM module), so spying works normally.
    const generatedUUIDs: string[] = []
    const originalRandomUUID = globalThis.crypto.randomUUID.bind(globalThis.crypto)
    vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(() => {
      const uuid = originalRandomUUID()
      generatedUUIDs.push(uuid)
      return uuid
    })

    try {
      const worktreePaths = Array.from({ length: 10 }, (_, i) => {
        const p = path.join(tmpDir, `wt-${i}`)
        fs.mkdirSync(p)
        return p
      })

      await Promise.all(
        worktreePaths.map((worktreePath) => {
          const ctx = new ProvisionContext()
          ctx.worktreePath = worktreePath
          ctx.writeEnv()
        })
      )

      // All 10 .env files must exist (rename succeeded, no collision)
      for (const wt of worktreePaths) {
        expect(fs.existsSync(path.join(wt, '.env'))).toBe(true)
      }

      // Exactly 10 UUIDs generated (one per writeEnv call)
      expect(generatedUUIDs.length).toBe(10)

      // All UUIDs must be unique
      const unique = new Set(generatedUUIDs)
      expect(unique.size).toBe(10)

      // Each UUID must match the standard UUID format
      for (const uuid of generatedUUIDs) {
        expect(uuid).toMatch(UUID_RE)
      }
    } finally {
      vi.restoreAllMocks()
    }
  })
})

// ---------------------------------------------------------------------------
// writeEnv — processId field
// ---------------------------------------------------------------------------

describe('ProvisionContext.writeEnv — processId', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'provision-ctx-pid-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('includes EVAL_PROCESS_ID when processId is set', () => {
    const ctx = new ProvisionContext()
    ctx.worktreePath = tmpDir
    ctx.processId = 'test-uuid-5678'
    ctx.writeEnv()
    const content = fs.readFileSync(path.join(tmpDir, '.env'), 'utf-8')
    expect(content).toContain('EVAL_PROCESS_ID="test-uuid-5678"')
  })

  it('excludes EVAL_PROCESS_ID when processId is not set', () => {
    const ctx = new ProvisionContext()
    ctx.worktreePath = tmpDir
    ctx.writeEnv()
    const content = fs.readFileSync(path.join(tmpDir, '.env'), 'utf-8')
    expect(content).not.toContain('EVAL_PROCESS_ID')
  })
})

// ---------------------------------------------------------------------------
// writeEnv — env values via setEnv
// ---------------------------------------------------------------------------

describe('ProvisionContext.writeEnv — env values via setEnv', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'provision-ctx-port-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('CREDENTIAL_PROXY_PORT written via setEnv appears in .env', () => {
    const ctx = new ProvisionContext()
    ctx.worktreePath = tmpDir
    ctx.setEnv('CREDENTIAL_PROXY_PORT', '8765')
    ctx.writeEnv()
    const content = fs.readFileSync(path.join(tmpDir, '.env'), 'utf-8')
    expect(content).toContain('CREDENTIAL_PROXY_PORT="8765"')
  })

  it('port omitted: CREDENTIAL_PROXY_PORT absent when not set via setEnv', () => {
    const ctx = new ProvisionContext()
    ctx.worktreePath = tmpDir
    ctx.writeEnv()
    const content = fs.readFileSync(path.join(tmpDir, '.env'), 'utf-8')
    expect(content).not.toContain('CREDENTIAL_PROXY_PORT')
  })

  it('distinct fields: CREDENTIAL_PROXY_PORT and CREDENTIAL_PROXY_URL independent', () => {
    const ctx = new ProvisionContext()
    ctx.worktreePath = tmpDir
    ctx.setEnv('CREDENTIAL_PROXY_URL', 'http://localhost:9000')
    ctx.setEnv('CREDENTIAL_PROXY_PORT', '9000')
    ctx.writeEnv()
    const content = fs.readFileSync(path.join(tmpDir, '.env'), 'utf-8')
    expect(content).toContain('CREDENTIAL_PROXY_URL="http://localhost:9000"')
    expect(content).toContain('CREDENTIAL_PROXY_PORT="9000"')
  })
})
