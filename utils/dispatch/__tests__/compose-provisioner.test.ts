import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { spawnSync } from 'child_process'
import { composeProvisioner } from '../provisioners/compose.js'
import { parseSharedEnv, discoverPorts } from '../provisioners/compose-env.js'
import { ProvisionContext } from '../provision-context.js'

// Check both that docker compose CLI exists AND that the daemon is actually
// reachable. `docker compose version` only exercises the CLI binary and
// succeeds even when the current user cannot connect to /var/run/docker.sock,
// so it is not a sufficient guard on its own. `docker info` talks to the
// daemon and fails loudly with EACCES when the socket is inaccessible —
// which is the failure mode seen on self-hosted runners where the runner
// user is not in the docker group. Without the second check, the integration
// tier runs and fails with "permission denied while trying to connect to the
// docker API at unix:///var/run/docker.sock". See PR #819 (9b3727f3b) which
// accidentally reverted this check originally added in 9fc41bf1f.
const dockerAvailable =
  spawnSync('docker', ['compose', 'version'], { stdio: 'pipe', timeout: 10_000 }).status === 0 &&
  spawnSync('docker', ['info'], { stdio: 'pipe', timeout: 10_000 }).status === 0

describe('compose provisioner — no-op when no compose.yml', () => {
  it('silently returns when no compose.yml exists', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compose-test-'))
    const ctx = new ProvisionContext()
    ctx.worktreePath = tmpDir
    // Should resolve without error — no compose.yml present
    await expect(composeProvisioner.provision(ctx, 'test-slug')).resolves.toBeUndefined()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('no-op when worktreePath is not set', async () => {
    const ctx = new ProvisionContext()
    await expect(composeProvisioner.provision(ctx, 'test-slug')).resolves.toBeUndefined()
  })
})

describe('compose provisioner — teardown no-op when no .compose-shared', () => {
  it('teardown resolves without error when .compose-shared dir is absent', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compose-test-'))
    const ctx = new ProvisionContext()
    ctx.worktreePath = tmpDir
    await expect(composeProvisioner.teardown(ctx, 'test-slug')).resolves.toBeUndefined()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('teardown resolves when worktreePath is not set', async () => {
    const ctx = new ProvisionContext()
    await expect(composeProvisioner.teardown(ctx, 'test-slug')).resolves.toBeUndefined()
  })
})

describe.skipIf(!dockerAvailable)('compose provisioner — Docker integration (real Docker)', () => {
  it(
    'provisions and tears down a busybox service with healthcheck',
    async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compose-test-'))
      const slug = path.basename(tmpDir)
      const projectName = `wt-${slug.toLowerCase().replace(/[^a-z0-9_-]/g, '-')}`

      const composeYml = [
        'services:',
        '  busybox:',
        '    image: busybox:latest',
        '    command: ["sh", "-c", "while true; do sleep 1; done"]',
        '    healthcheck:',
        '      test: ["CMD", "echo", "ok"]',
        '      interval: 1s',
        '      timeout: 5s',
        '      retries: 3',
      ].join('\n')
      fs.writeFileSync(path.join(tmpDir, 'compose.yml'), composeYml)

      const ctx = new ProvisionContext()
      ctx.worktreePath = tmpDir

      try {
        // provision should resolve (services start healthy)
        await expect(composeProvisioner.provision(ctx, slug)).resolves.toBeUndefined()

        // verify service is healthy
        const psResult = spawnSync(
          'docker',
          ['compose', '-p', projectName, 'ps', '--format', 'json'],
          { stdio: 'pipe', timeout: 15_000 },
        )
        expect(psResult.status).toBe(0)
        const psOutput = psResult.stdout.toString()
        // Each line is a JSON object; health should be "healthy"
        const rows = psOutput
          .trim()
          .split('\n')
          .filter(Boolean)
          .map(l => JSON.parse(l))
        expect(rows.length).toBeGreaterThan(0)
        expect(rows.every((r: Record<string, string>) => r.Health === 'healthy')).toBe(true)

        // teardown should resolve
        await expect(composeProvisioner.teardown(ctx, slug)).resolves.toBeUndefined()

        // verify no containers remain
        const psAfter = spawnSync(
          'docker',
          ['compose', '-p', projectName, 'ps', '--format', 'json'],
          { stdio: 'pipe', timeout: 15_000 },
        )
        const afterRows = psAfter.stdout.toString().trim().split('\n').filter(Boolean)
        expect(afterRows.length).toBe(0)

        // verify volumes removed
        const volResult = spawnSync('docker', ['volume', 'ls', '--format', '{{.Name}}'], {
          stdio: 'pipe',
          timeout: 10_000,
        })
        expect(volResult.stdout.toString()).not.toContain(projectName)

        // verify networks removed
        const netResult = spawnSync('docker', ['network', 'ls', '--format', '{{.Name}}'], {
          stdio: 'pipe',
          timeout: 10_000,
        })
        expect(netResult.stdout.toString()).not.toContain(projectName)
      } finally {
        // best-effort cleanup in case test failed mid-way
        spawnSync('docker', ['compose', '-p', projectName, 'down', '-v', '--rmi', 'local'], {
          stdio: 'pipe',
          timeout: 60_000,
        })
        fs.rmSync(tmpDir, { recursive: true, force: true })
      }
    },
    60_000,
  )

  it(
    'waits for healthcheck with start_period > 5s (proves --wait is active)',
    async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compose-test-'))
      const slug = path.basename(tmpDir)
      const projectName = `wt-${slug.toLowerCase().replace(/[^a-z0-9_-]/g, '-')}`

      const composeYml = [
        'services:',
        '  busybox:',
        '    image: busybox:latest',
        '    command: ["sh", "-c", "while true; do sleep 1; done"]',
        '    healthcheck:',
        '      test: ["CMD", "echo", "ok"]',
        '      interval: 1s',
        '      timeout: 5s',
        '      retries: 3',
        '      start_period: 6s',
      ].join('\n')
      fs.writeFileSync(path.join(tmpDir, 'compose.yml'), composeYml)

      const ctx = new ProvisionContext()
      ctx.worktreePath = tmpDir

      try {
        const start = Date.now()
        await expect(composeProvisioner.provision(ctx, slug)).resolves.toBeUndefined()
        const elapsed = Date.now() - start

        // With start_period: 6s the container won't be healthy before ~6s
        expect(elapsed).toBeGreaterThan(5_000)
      } finally {
        spawnSync('docker', ['compose', '-p', projectName, 'down', '-v', '--rmi', 'local'], {
          stdio: 'pipe',
          timeout: 60_000,
        })
        fs.rmSync(tmpDir, { recursive: true, force: true })
      }
    },
    60_000,
  )

  it(
    'teardown removes locally-built images (--rmi local)',
    async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compose-rmi-test-'))
      const slug = path.basename(tmpDir)
      const projectName = `wt-${slug.toLowerCase().replace(/[^a-z0-9_-]/g, '-')}`

      // A minimal Dockerfile — builds fast, no custom image: tag so --rmi local covers it.
      fs.writeFileSync(path.join(tmpDir, 'Dockerfile'), 'FROM busybox:latest\nLABEL test=rmi-local\n')
      const composeYml = [
        'services:',
        '  app:',
        '    build: .',
        '    command: ["sh", "-c", "while true; do sleep 1; done"]',
        '    healthcheck:',
        '      test: ["CMD", "echo", "ok"]',
        '      interval: 1s',
        '      timeout: 5s',
        '      retries: 3',
      ].join('\n')
      fs.writeFileSync(path.join(tmpDir, 'compose.yml'), composeYml)

      const ctx = new ProvisionContext()
      ctx.worktreePath = tmpDir

      try {
        await expect(composeProvisioner.provision(ctx, slug)).resolves.toBeUndefined()

        // Confirm the image exists before teardown
        const imgBefore = spawnSync('docker', ['images', '--format', '{{.Repository}}', '--filter', `label=test=rmi-local`], {
          stdio: 'pipe',
          timeout: 10_000,
        })
        expect(imgBefore.stdout.toString().trim()).toBeTruthy()

        await expect(composeProvisioner.teardown(ctx, slug)).resolves.toBeUndefined()

        // Verify the built image was removed by --rmi local
        const imgAfter = spawnSync('docker', ['images', '--format', '{{.Repository}}', '--filter', `label=test=rmi-local`], {
          stdio: 'pipe',
          timeout: 10_000,
        })
        expect(imgAfter.stdout.toString().trim()).toBe('')
      } finally {
        spawnSync('docker', ['compose', '-p', projectName, 'down', '-v', '--rmi', 'local'], {
          stdio: 'pipe',
          timeout: 60_000,
        })
        fs.rmSync(tmpDir, { recursive: true, force: true })
      }
    },
    120_000,
  )
})

describe('compose-env helpers — unit tests', () => {
  it('parseSharedEnv returns empty map when .env file is absent', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compose-env-test-'))
    try {
      expect(parseSharedEnv(tmpDir).size).toBe(0)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('parseSharedEnv parses KEY=VALUE lines, skips blanks and comments', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compose-env-test-'))
    try {
      fs.writeFileSync(
        path.join(tmpDir, '.env'),
        [
          '# comment',
          '',
          'PLAIN=hello',
          'QUOTED="world"',
          "SINGLE='value'",
          'URL=postgres://user:pass@host/db',
        ].join('\n'),
      )
      const m = parseSharedEnv(tmpDir)
      expect(m.get('PLAIN')).toBe('hello')
      expect(m.get('QUOTED')).toBe('world')
      expect(m.get('SINGLE')).toBe('value')
      expect(m.get('URL')).toBe('postgres://user:pass@host/db')
      expect(m.has('# comment')).toBe(false)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('discoverPorts returns empty map when project does not exist', () => {
    const ports = discoverPorts('wt-nonexistent-project-xyz')
    expect(ports.size).toBe(0)
  })
})

describe.skipIf(!dockerAvailable)('compose provisioner — env contract tier (real Docker)', () => {
  it(
    'propagates .env from shared volume and discovers dynamic ports',
    async () => {
      // Use an all-lowercase path so Docker can validate the bind mount source.
      const suffix = Math.random().toString(36).slice(2, 10)
      const tmpDir = path.join(os.tmpdir(), `compose-env-int-${suffix}`)
      fs.mkdirSync(tmpDir, { recursive: true })
      const slug = path.basename(tmpDir)
      const projectName = `wt-${slug.toLowerCase().replace(/[^a-z0-9_-]/g, '-')}`
      const sharedDir = path.join(tmpDir, '.compose-shared')

      // Pre-create sharedDir and write .env BEFORE provision() runs.
      // The provisioner will call mkdirSync(sharedDir, {recursive:true}) which
      // is a no-op if the directory already exists, then read the .env file after
      // docker compose up. This simulates a compose service that writes to the
      // shared volume (bind mount writes back to the host are not reliable on
      // all Docker configurations).
      fs.mkdirSync(sharedDir, { recursive: true })
      fs.writeFileSync(path.join(sharedDir, '.env'), 'TEST_DB_URL=postgres://test\n')

      const composeYml = `services:
  app:
    image: busybox:latest
    command: ["sh", "-c", "while true; do sleep 1; done"]
    ports:
      - "0:9999"
    healthcheck:
      test: ["CMD", "echo", "ok"]
      interval: 1s
      timeout: 5s
      retries: 3`

      fs.writeFileSync(path.join(tmpDir, 'compose.yml'), composeYml)

      const ctx = new ProvisionContext()
      ctx.worktreePath = tmpDir

      try {
        await expect(composeProvisioner.provision(ctx, slug)).resolves.toBeUndefined()

        // Check env propagation via toShellEnv()
        const shellEnv = ctx.toShellEnv()
        expect(shellEnv).toContain('TEST_DB_URL=')
        expect(shellEnv).toContain('postgres://test')

        // Check port discovery — DISCOVERED_PORT_APP_9999 must be set
        expect(shellEnv).toMatch(/DISCOVERED_PORT_APP_9999="\d+"/)

        // Verify the port value is a valid port number
        const match = shellEnv.match(/DISCOVERED_PORT_APP_9999="(\d+)"/)
        expect(match).not.toBeNull()
        expect(Number(match![1])).toBeGreaterThan(0)
      } finally {
        spawnSync('docker', ['compose', '-p', projectName, 'down', '-v', '--rmi', 'local'], {
          stdio: 'pipe',
          timeout: 60_000,
        })
        fs.rmSync(tmpDir, { recursive: true, force: true })
      }
    },
    120_000,
  )

  it(
    'concurrent: two worktrees get distinct ports for the same container port',
    async () => {
      const makeSetup = () => {
        // Use all-lowercase paths to avoid Docker bind-mount validation failures
        const suffix = Math.random().toString(36).slice(2, 10)
        const tmpDir = path.join(os.tmpdir(), `compose-conc-${suffix}`)
        fs.mkdirSync(tmpDir, { recursive: true })
        const slug = path.basename(tmpDir)
        const projectName = `wt-${slug.toLowerCase().replace(/[^a-z0-9_-]/g, '-')}`
        const sharedDir = path.join(tmpDir, '.compose-shared')
        const composeYml = `services:
  app:
    image: busybox:latest
    command: ["sh", "-c", "while true; do sleep 1; done"]
    ports:
      - "0:9999"
    healthcheck:
      test: ["CMD", "echo", "ok"]
      interval: 1s
      timeout: 5s
      retries: 3`
        fs.writeFileSync(path.join(tmpDir, 'compose.yml'), composeYml)
        const ctx = new ProvisionContext()
        ctx.worktreePath = tmpDir
        return { tmpDir, slug, projectName, sharedDir, ctx }
      }

      const a = makeSetup()
      const b = makeSetup()

      try {
        await Promise.all([
          composeProvisioner.provision(a.ctx, a.slug),
          composeProvisioner.provision(b.ctx, b.slug),
        ])

        const envA = a.ctx.toShellEnv()
        const envB = b.ctx.toShellEnv()

        const matchA = envA.match(/DISCOVERED_PORT_APP_9999="(\d+)"/)
        const matchB = envB.match(/DISCOVERED_PORT_APP_9999="(\d+)"/)

        expect(matchA).not.toBeNull()
        expect(matchB).not.toBeNull()

        const portA = Number(matchA![1])
        const portB = Number(matchB![1])

        expect(portA).toBeGreaterThan(0)
        expect(portB).toBeGreaterThan(0)
        // Two separate worktrees must get different dynamically assigned ports
        expect(portA).not.toBe(portB)
      } finally {
        for (const setup of [a, b]) {
          spawnSync('docker', ['compose', '-p', setup.projectName, 'down', '-v', '--rmi', 'local'], {
            stdio: 'pipe',
            timeout: 60_000,
          })
          fs.rmSync(setup.tmpDir, { recursive: true, force: true })
        }
      }
    },
    180_000,
  )
})
