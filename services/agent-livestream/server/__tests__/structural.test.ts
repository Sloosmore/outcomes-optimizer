// note: tests that invoke `tsc --noEmit` against packages/duoidal-cli or
// packages/sandbox, and the `node packages/duoidal-cli/dist/index.js --help`
// test, require those packages to be built first. CI handles this via the
// repo-root `pretest` script (`turbo build --filter=@duoidal/cli ...`).
// Running `pnpm exec vitest run` from this service directly skips that step,
// so locally either run `pnpm test` from the repo root or run
// `pnpm exec turbo run build --filter='@duoidal/cli' --filter='@duoidal/sandbox'` first.
import { describe, it, expect } from 'vitest'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const REPO_ROOT = resolve(__dirname, '../../../..')

describe('L0 structural checks', () => {
  it('app.ts mounts /sandbox route BEFORE the JWT wall', () => {
    const appTs = readFileSync(resolve(REPO_ROOT, 'services/agent-livestream/server/app.ts'), 'utf-8')

    // Find positions of key lines
    const sandboxReadyPos = appTs.indexOf("app.route('/sandbox', readyRouter)")
    const jwtWallPos = appTs.indexOf("app.use('/api/*', jwtMiddleware)")
    const sandboxApiPos = appTs.indexOf("app.route('/api/sandbox', sandboxRouter)")

    expect(sandboxReadyPos).toBeGreaterThan(-1)
    expect(jwtWallPos).toBeGreaterThan(-1)
    expect(sandboxApiPos).toBeGreaterThan(-1)

    // /sandbox must be registered BEFORE the JWT wall
    expect(sandboxReadyPos).toBeLessThan(jwtWallPos)
    // /api/sandbox must be registered AFTER the JWT wall
    expect(sandboxApiPos).toBeGreaterThan(jwtWallPos)
  })

  it('vercel.json contains /sandbox/:path* rewrite', () => {
    const vercelJson = JSON.parse(
      readFileSync(resolve(REPO_ROOT, 'services/agent-livestream/vercel.json'), 'utf-8')
    ) as { rewrites?: Array<{ source: string; destination: string }> }

    const sandboxRewrite = vercelJson.rewrites?.find(r => r.source === '/sandbox/:path*')
    expect(sandboxRewrite).toBeDefined()
    expect(sandboxRewrite?.destination).toBe('/api/index')
  })

  // tsc --noEmit assertions removed: the dedicated `Typecheck and lint` CI job in
  // .github/workflows/unit-tests.yml iterates over every services/* and packages/*
  // dir running `pnpm run typecheck`, which already covers packages/sandbox and
  // packages/duoidal-cli. Spawning tsc inside vitest duplicated that work and
  // caused intermittent 5s timeout flakes.

it('CLI --help shows auth, sandbox, process subcommands', () => {
    const output = execSync('node packages/duoidal-cli/dist/index.js --help', {
      cwd: REPO_ROOT,
      stdio: 'pipe',
    }).toString()

    expect(output).toContain('auth')
    expect(output).toContain('sandbox')
    expect(output).toContain('process')
  })

  it('SandboxProvider interface is defined with required methods', () => {
    const providerTs = readFileSync(
      resolve(REPO_ROOT, 'packages/sandbox/src/provider.ts'),
      'utf-8'
    )

    expect(providerTs).toContain('SandboxProvider')
    expect(providerTs).toContain('provision')
    expect(providerTs).toContain('getStatus')
    expect(providerTs).toContain('deprovision')
  })

  it('HetznerProvider and MockSandboxProvider both implement SandboxProvider', () => {
    const hetznerTs = readFileSync(resolve(REPO_ROOT, 'packages/sandbox/src/hetzner.ts'), 'utf-8')
    const mockTs = readFileSync(resolve(REPO_ROOT, 'packages/sandbox/src/mock.ts'), 'utf-8')

    expect(hetznerTs).toMatch(/implements\s+SandboxProvider/)
    expect(mockTs).toMatch(/implements\s+SandboxProvider/)
  })
})
