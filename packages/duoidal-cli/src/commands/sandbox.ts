import { Command } from 'commander'
import crypto, { createPrivateKey, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { getSandboxKeyPath, getSandboxKeyPathByName, writeSandboxKeyByName, PROVISION_POLL_DEADLINE_MS } from '../lib/config.js'
import { NpmCliInstaller, LocalCliInstaller } from '../lib/cli-installer.js'
import { requireAuth } from '../lib/require-auth.js'
import { linkCommand, unlinkCommand } from './credential.js'
import {
  provisionSandbox,
  deprovisionSandbox,
  getSandboxStatus,
  getSshAccess,
  getRepoCloneUrl,
  BffNotApprovedError,
  BffSandboxLimitError,
  BffUnreachableError,
  BffSandboxNotFoundError,
} from '../lib/sandbox-bff-client.js'
import { readConfig, writeConfig, type ServerEntry } from '@duoidal/config'
import { createAuthenticatedSupabaseClient } from '@duoidal/auth/adapters'
import { getSupabaseAnonKey, getSupabaseServiceKey, getSupabaseUrl } from '../lib/helpers.js'

// Re-export types for test injection
export type ExecuteActionFn = (name: string, input: Record<string, unknown>, client: unknown) => Promise<Record<string, unknown>>
export type SupabaseClientFactory = (url: string, key: string) => unknown

// ---------------------------------------------------------------------------
// Helper: convert PKCS8 PEM ed25519 private key to OpenSSH private key format
// OpenSSH format is required by the `ssh` CLI; PKCS8 produces "invalid format" error.
// ---------------------------------------------------------------------------
export function pkcs8ToOpenSSH(pkcs8Pem: string): string {
  const keyObj = createPrivateKey(pkcs8Pem)
  const jwk = keyObj.export({ format: 'jwk' }) as { d: string; x: string }
  const privBytes = Buffer.from(jwk.d, 'base64url') // 32-byte private scalar
  const pubBytes = Buffer.from(jwk.x, 'base64url')  // 32-byte public key

  function encodeStr(s: string): Buffer {
    const b = Buffer.from(s)
    const len = Buffer.allocUnsafe(4)
    len.writeUInt32BE(b.length, 0)
    return Buffer.concat([len, b])
  }

  function encodeBytes(b: Buffer): Buffer {
    const len = Buffer.allocUnsafe(4)
    len.writeUInt32BE(b.length, 0)
    return Buffer.concat([len, b])
  }

  // Public key wire format: "ssh-ed25519" + pubkey
  const pubKeyEncoded = Buffer.concat([encodeStr('ssh-ed25519'), encodeBytes(pubBytes)])

  // Repeated check integer (random, must match — used to detect decryption errors)
  const checkInt = randomBytes(4)

  // Private key block: checkint×2, key type, pubkey, privkey+pubkey, empty comment
  const privKeyBlock = Buffer.concat([
    checkInt, checkInt,
    encodeStr('ssh-ed25519'),
    encodeBytes(pubBytes),
    encodeBytes(Buffer.concat([privBytes, pubBytes])), // 64 bytes: private scalar || public key
    encodeStr(''), // empty comment
  ])

  // Pad to 8-byte boundary with 0x01 0x02 0x03 ...
  const padLen = (8 - (privKeyBlock.length % 8)) % 8
  const padding = Buffer.from(Array.from({ length: padLen }, (_, i) => i + 1))
  const privKeyBlockPadded = Buffer.concat([privKeyBlock, padding])

  // Number of keys as big-endian uint32
  const numKeys = Buffer.allocUnsafe(4)
  numKeys.writeUInt32BE(1, 0)

  const body = Buffer.concat([
    encodeStr('none'),             // cipher name
    encodeStr('none'),             // kdf name
    encodeBytes(Buffer.alloc(0)), // kdf options (empty)
    numKeys,
    encodeBytes(pubKeyEncoded),
    encodeBytes(privKeyBlockPadded),
  ])

  const magic = Buffer.concat([Buffer.from('openssh-key-v1'), Buffer.from([0x00])])
  const full = Buffer.concat([magic, body])

  const b64 = full.toString('base64')
  const lines = (b64.match(/.{1,70}/g) ?? [b64]).join('\n')
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${lines}\n-----END OPENSSH PRIVATE KEY-----\n`
}

// Generate a short random ID for server names
function shortId(): string {
  return crypto.randomBytes(4).toString('hex')
}

export function sandboxCommand(executeActionFn?: ExecuteActionFn, supabaseFactory?: SupabaseClientFactory): Command {
  const sandbox = new Command('sandbox')
  sandbox.description('Manage cloud sandboxes')

  // sandbox provision
  sandbox.command('provision')
    .description('Provision a new cloud sandbox')
    .option('--name <name>', 'Sandbox server name (defaults to duoidal-<random>)')
    .option('--installer <type>', 'CLI installer type: npm (installs from registry) or local (SCP build)', 'local')
    .option('--force', 'Force reprovision even if a stale local entry exists')
    .option('--repo <name>', 'Repository name to clone into /root/repos/<name> after provisioning')
    .action(async (opts: { name?: string; installer?: string; force?: boolean; repo?: string }) => {
      const { accessToken: jwt, refreshToken } = await requireAuth()

      // Generate ed25519 keypair client-side
      console.log('Generating SSH keypair...')
      const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      })

      // Convert public key PEM to SSH format
      const pubKeyObj = crypto.createPublicKey(publicKey)
      const pubKeyDer = pubKeyObj.export({ type: 'spki', format: 'der' }) as Buffer
      // Extract the raw 32-byte ed25519 key from DER (skip 12-byte SPKI header)
      const rawPubKey = pubKeyDer.slice(12)

      // Build SSH wire format: length-prefixed "ssh-ed25519" + length-prefixed 32-byte key
      const keyTypeBuf = Buffer.from('ssh-ed25519')
      const wireFormat = Buffer.alloc(4 + keyTypeBuf.length + 4 + rawPubKey.length)
      let offset = 0
      wireFormat.writeUInt32BE(keyTypeBuf.length, offset); offset += 4
      keyTypeBuf.copy(wireFormat, offset); offset += keyTypeBuf.length
      wireFormat.writeUInt32BE(rawPubKey.length, offset); offset += 4
      rawPubKey.copy(wireFormat, offset)

      const sshPublicKey = `ssh-ed25519 ${wireFormat.toString('base64')} duoidal-cli`

      const serverName = opts.name ?? `duoidal-${shortId()}`

      // Idempotency guard: check config for an existing sandbox with this name
      const existingEntry = readConfig().servers?.[serverName]
      if (existingEntry) {
        const existingResourceId = existingEntry.resource_id ?? serverName
        console.log(`Sandbox '${serverName}' already exists locally (resource ID: ${existingResourceId}) — verifying with BFF...`)
        try {
          const statusResult = await getSandboxStatus(jwt)
          if (statusResult.status === 'active' || statusResult.status === 'provisioning') {
            console.log(`Sandbox ${existingResourceId} — already exists (isNew: false)`)
            console.log(`BFF reports sandbox is ${statusResult.status}`)
            if (existingEntry.host) {
              console.log(`Server IP: ${existingEntry.host}`)
            }
            console.log(`Private key stored at ${getSandboxKeyPathByName(serverName)}`)
            console.log(`Run 'duoidal sandbox ssh --name ${serverName} --dry-run' to get the SSH command`)
            return
          }
          // BFF reports a non-active, non-provisioning status — stale entry
          console.error(`Stale sandbox entry detected: local cache has '${serverName}' (resource ID: ${existingResourceId}) but BFF reports status '${statusResult.status}'.`)
        } catch (err) {
          if (err instanceof BffSandboxNotFoundError) {
            console.error(`Stale sandbox entry detected: local cache has '${serverName}' (resource ID: ${existingResourceId}) but resource was not found in BFF.`)
          } else if (err instanceof BffUnreachableError) {
            console.error(`Cannot reach provisioning service to verify sandbox '${serverName}' — try again when the service is available.`)
            process.exit(1)
          } else {
            console.error(`Stale sandbox entry detected: local cache has '${serverName}' (resource ID: ${existingResourceId}) but BFF status check failed.`)
          }
        }

        if (!opts.force) {
          console.error(`Stale entry resource ID: ${existingResourceId}`)
          console.error(`Run 'duoidal sandbox provision --name ${serverName} --force' to clear the stale entry and reprovision.`)
          console.error(`Or run 'duoidal config migrate' to clean up stale entries`)
          process.exit(1)
        }

        // --force: clean up stale config entry before reprovisioning
        console.log(`--force specified: removing stale local entry for resource ${existingResourceId}...`)
        const cfg = readConfig()
        if (cfg.servers) {
          delete cfg.servers[serverName]
          writeConfig(cfg)
        }
        console.log('Stale entry removed. Provisioning fresh sandbox...')
      }

      console.log('Provisioning sandbox...')
      let provisionResult: { status: string; resourceId: string }
      try {
        provisionResult = await provisionSandbox(jwt, sshPublicKey)
      } catch (err) {
        if (err instanceof BffNotApprovedError) {
          console.error('User not approved')
          process.exit(1)
        }
        if (err instanceof BffSandboxLimitError) {
          console.error('Sandbox limit reached')
          process.exit(1)
        }
        if (err instanceof BffUnreachableError) {
          console.error('Could not reach provisioning service')
          process.exit(1)
        }
        throw err
      }

      const serverResourceId = provisionResult.resourceId

      // Store OpenSSH format private key (not PKCS8 — ssh CLI requires OpenSSH format)
      const openSshKey = pkcs8ToOpenSSH(privateKey)
      // Write key by name so the config-relative path "keys/<name>/id_ed25519" resolves correctly
      writeSandboxKeyByName(serverName, openSshKey)

      // Write entry to config
      const keyRelPath = `keys/${serverName}/id_ed25519`
      const cfg = readConfig()
      cfg.servers ??= {}
      cfg.servers[serverName] = {
        host: '',
        user: 'root',
        key: keyRelPath,
        resource_id: serverResourceId,
        provider: 'hetzner',
        status: 'provisioning',
        provisioned_at: new Date().toISOString(),
      }
      // Set default server on first provision (if server is 'self' or not set)
      if (!cfg.server || cfg.server === 'self') cfg.server = serverName
      writeConfig(cfg)

      console.log(`Sandbox ${serverResourceId} — newly provisioned`)

      // Poll until server is active (max 300s, exponential backoff 2s→4s→...→30s)
      console.log('Waiting for server to become active...')
      const deadline = Date.now() + PROVISION_POLL_DEADLINE_MS
      let delay = 2000
      let serverIp: string | undefined

      while (Date.now() < deadline) {
        const statusResult = await getSandboxStatus(jwt)
        if (statusResult.status === 'active' && statusResult.ip) {
          serverIp = statusResult.ip
          break
        }
        console.log(`  Server status: ${statusResult.status} — retrying in ${delay / 1000}s...`)
        await new Promise(r => setTimeout(r, delay))
        delay = Math.min(delay * 2, 30_000)
      }

      if (!serverIp) {
        console.error(`Timeout: server did not become active within ${PROVISION_POLL_DEADLINE_MS / 1000}s`)
        console.log('Attempting to clean up orphaned server...')
        try {
          await deprovisionSandbox(jwt)
          console.log('Orphaned server cleaned up.')
        } catch (cleanupErr) {
          console.error(`Failed to clean up orphaned server ${serverResourceId}: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`)
          console.error('Please manually deprovision: duoidal sandbox deprovision')
        }
        // Remove the config entry on timeout
        const timeoutCfg = readConfig()
        if (timeoutCfg.servers) {
          delete timeoutCfg.servers[serverName]
          writeConfig(timeoutCfg)
        }
        process.exit(1)
      }

      // Update config with IP and active status
      const activeCfg = readConfig()
      if (activeCfg.servers?.[serverName]) {
        activeCfg.servers[serverName] = { ...activeCfg.servers[serverName], host: serverIp, status: 'active' }
        writeConfig(activeCfg)
      }

      console.log(`Server active at ${serverIp}`)

      // Install duoidal CLI on sandbox
      console.log('Installing duoidal CLI on sandbox...')
      const keyPath = getSandboxKeyPathByName(serverName)

      const sshOpts = ['-i', keyPath, '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=30']

      // Wait for SSH to be available AND for cloud-init (Node.js install) to finish (up to 600s)
      // NodeSource + apt-get install nodejs can take 3-5 minutes on first boot; SSH starts before cloud-init completes.
      // Phase 1: wait for SSH port (up to 300s — some Hetzner regions take >120s for sshd to start)
      let sshPortReady = false
      const sshPortDeadline = Date.now() + 300_000
      console.log('Waiting for SSH port to open...')
      while (Date.now() < sshPortDeadline) {
        try {
          execFileSync('ssh', [...sshOpts, `root@${serverIp}`, 'echo ssh-ready'], { stdio: 'pipe' })
          sshPortReady = true
          break
        } catch {
          await new Promise(r => setTimeout(r, 5000))
          process.stdout.write('.')
        }
      }
      process.stdout.write('\n')
      if (!sshPortReady) {
        console.error('SSH port not accessible after 300s — aborting CLI install')
        process.exit(1)
      }
      console.log('SSH port open. Installing Node.js v22 via SSH (avoiding apt lock conflicts with cloud-init)...')

      // Phase 2: install Node.js v22 via SSH (NodeSource). Runs after SSH is confirmed ready
      // so there are no apt lock conflicts with cloud-init.
      execFileSync('ssh', [...sshOpts, `root@${serverIp}`,
        'curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs'
      ], { stdio: 'inherit' })
      console.log('Node.js installed ✓')

      // Phase 3: install CLI via selected adapter
      const installerType = opts.installer ?? 'local'
      const installer = installerType === 'npm' ? new NpmCliInstaller() : new LocalCliInstaller()

      if (installerType === 'local') {
        const worktreeRepo = process.env['WORKTREE_REPO']
        if (!worktreeRepo) {
          console.error('Error: WORKTREE_REPO env var must be set to install CLI on sandbox')
          console.error('Example: export WORKTREE_REPO=/root/dispatch/cc27f85f')
          process.exit(1)
        }
        const cliPkgDir = path.join(worktreeRepo, 'packages', 'duoidal-cli')
        await installer.install(serverIp, keyPath, sshOpts, { cliPkgDir }, { access_token: jwt, refresh_token: refreshToken })
      } else {
        // npm installer: get published version from env var or npm registry
        let npmPublishedVersion = process.env['PUBLISHED_CLI_VERSION']
        if (!npmPublishedVersion) {
          const { execFileSync: execSync } = await import('node:child_process')
          npmPublishedVersion = execSync('npm', ['view', '@duoidal/cli', 'version'], { encoding: 'utf-8' }).trim()
        }
        await installer.install(serverIp, keyPath, sshOpts, { version: npmPublishedVersion }, { access_token: jwt, refresh_token: refreshToken })
      }

      console.log('duoidal CLI installed on sandbox ✓')

      // Optionally clone a repository into /root/repos/<opts.repo>
      if (opts.repo) {
        if (!/^[A-Za-z0-9._-]+$/.test(opts.repo)) {
          console.error('Error: --repo must match [A-Za-z0-9._-]+')
          process.exit(1)
        }

        let cloneUrl: string
        try {
          const result = await getRepoCloneUrl(jwt, opts.repo)
          cloneUrl = result.cloneUrl
        } catch (err) {
          if (err instanceof BffUnreachableError) {
            console.error('Cannot reach provisioning service to get repo clone URL')
            process.exit(1)
          }
          console.error(`Error getting GitHub clone URL: ${err instanceof Error ? err.message : String(err)}`)
          process.exit(1)
        }

        // Strip the access token from the URL for the git remote set-url command
        const tokenMatch = cloneUrl.match(/\/\/x-access-token:[^@]+@(.+)/)
        const cleanUrl = tokenMatch ? `https://${tokenMatch[1]}` : cloneUrl

        const commands = [
          'npm install -g pnpm',
          'mkdir -p /root/repos',
          `git clone ${JSON.stringify(cloneUrl)} /root/repos/${opts.repo}`,
          `git -C /root/repos/${opts.repo} remote set-url origin ${JSON.stringify(cleanUrl)}`,
          `cd /root/repos/${opts.repo} && pnpm install`,
        ]

        console.log(`Cloning ${opts.repo} into /root/repos/${opts.repo} on sandbox...`)
        execFileSync('ssh', [...sshOpts, `root@${serverIp}`, commands.join(' && ')], { stdio: 'inherit' })
        console.log(`Repository /root/repos/${opts.repo} cloned and pnpm install complete ✓`)

        // Store worktree_repo in config so waypoint-router can pass WORKTREE_REPO to remote duoidal execute
        const repoCfg = readConfig()
        if (repoCfg.servers?.[serverName]) {
          repoCfg.servers[serverName] = { ...repoCfg.servers[serverName], worktree_repo: `/root/repos/${opts.repo}` }
          writeConfig(repoCfg)
        }
        console.log(`Config updated: worktree_repo=/root/repos/${opts.repo} ✓`)
      }

      console.log(`Private key stored at ${getSandboxKeyPathByName(serverName)}`)
      console.log(`Run 'duoidal sandbox ssh --name ${serverName} --dry-run' to get the SSH command`)
    })

  // sandbox status
  sandbox.command('status')
    .description('Show the status of your provisioned sandbox')
    .option('--id <resourceId>', 'Sandbox resource ID (defaults to most recent)')
    .option('--name <name>', 'Sandbox server name (alternative lookup key)')
    .action(async (opts: { id?: string; name?: string }) => {
      const { accessToken: jwt } = await requireAuth()

      // Resolve server name: by name first, then scan by resource_id, then use default
      let serverName: string | null = null
      let entry: ServerEntry | null = null

      const cfg = readConfig()
      const servers = cfg.servers ?? {}

      if (opts.name) {
        if (servers[opts.name]) {
          serverName = opts.name
          entry = servers[opts.name]
        } else {
          console.error(`No local sandbox found with name '${opts.name}'`)
          process.exit(1)
        }
      } else if (opts.id) {
        // Scan servers for matching resource_id
        const found = Object.entries(servers).find(([, s]) => s.resource_id === opts.id)
        if (found) {
          serverName = found[0]
          entry = found[1]
        }
        // If not found in config, fall through to BFF-only path with null entry
      } else {
        // Default: use cfg.server name
        const defaultName = cfg.server
        if (defaultName && defaultName !== 'self' && servers[defaultName]) {
          serverName = defaultName
          entry = servers[defaultName]
        }
      }

      if (!serverName && !opts.id) {
        console.error('No sandbox found. Run: duoidal sandbox provision')
        process.exit(1)
      }

      // Try BFF for authoritative status; fall back to local config if unreachable
      let status: string = entry?.status ?? 'unknown'
      let ip: string | undefined = entry?.host || undefined

      try {
        const bffStatus = await getSandboxStatus(jwt)
        status = bffStatus.status
        if (bffStatus.ip) ip = bffStatus.ip
        // Update config with latest status from BFF
        if (serverName && cfg.servers?.[serverName]) {
          cfg.servers[serverName] = { ...cfg.servers[serverName], status, host: ip ?? cfg.servers[serverName].host }
          writeConfig(cfg)
        }
      } catch (err) {
        if (err instanceof BffUnreachableError) {
          if (!entry) {
            console.error('No sandbox found. Provisioning service unreachable.')
            process.exit(1)
          }
          console.log('(BFF unreachable — showing local config)')
        } else {
          throw err
        }
      }

      const displayName = serverName ?? opts.id ?? '(unknown)'
      const resourceId = entry?.resource_id ?? opts.id ?? '(unknown)'
      const keyPath = serverName ? getSandboxKeyPathByName(serverName) : getSandboxKeyPath(opts.id ?? '')
      console.log(`Sandbox: ${resourceId}`)
      console.log(`  Server name: ${displayName}`)
      console.log(`  Status:      ${status}`)
      console.log(`  IP:          ${ip ?? '(not yet assigned)'}`)
      console.log(`  Provisioned: ${entry?.provisioned_at ?? '(unknown)'}`)
      console.log(`  Key path:    ${keyPath}`)
    })

  // sandbox deprovision
  sandbox.command('deprovision')
    .description('Deprovision a cloud sandbox and clean up all linked resources')
    .requiredOption('--name <name>', 'Sandbox server name to deprovision')
    .action(async (opts: { name: string }) => {
      const { accessToken: jwt } = await requireAuth()

      const cfg = readConfig()
      const entry = cfg.servers?.[opts.name]
      if (!entry) {
        console.error(`No local sandbox found with name '${opts.name}'`)
        process.exit(1)
      }

      // Warn about linked credentials from config (best-effort, non-blocking)
      if (entry.credential_resource_id) {
        console.log(`Warning: sandbox '${opts.name}' may have linked credentials`)
        console.log(`Run 'duoidal unlink --provider <provider> --sandbox ${opts.name}' to clean up first.`)
      }

      console.log(`Deprovisioning sandbox '${opts.name}'...`)
      try {
        const result = await deprovisionSandbox(jwt)
        if (result.deleted) {
          console.log(`Sandbox '${opts.name}' successfully deprovisioned`)
          // Remove from config
          const updatedCfg = readConfig()
          if (updatedCfg.servers) {
            delete updatedCfg.servers[opts.name]
          }
          if (updatedCfg.server === opts.name) {
            updatedCfg.server = 'self'
          }
          writeConfig(updatedCfg)
        } else {
          console.error(`Sandbox '${opts.name}' not found or already deprovisioned`)
          process.exit(1)
        }
      } catch (err) {
        if (err instanceof BffUnreachableError) {
          console.error('Could not reach provisioning service')
          process.exit(1)
        }
        console.error(`Error deprovisioning sandbox: ${err instanceof Error ? err.message : String(err)}`)
        process.exit(1)
      }
    })

  // sandbox ssh
  sandbox.command('ssh')
    .description('SSH into your provisioned sandbox')
    .option('--dry-run', 'Print the SSH command without connecting')
    .option('--id <serverResourceId>', 'Sandbox server resource ID (defaults to lookup by user)')
    .option('--name <name>', 'Sandbox server name (alternative lookup key)')
    .action(async (opts: { dryRun?: boolean; id?: string; name?: string }) => {
      const { accessToken: jwt } = await requireAuth()

      // Resolve server name and entry from config
      const cfg = readConfig()
      const servers = cfg.servers ?? {}
      let localName: string | null = null
      let localEntry: ServerEntry | null = null

      if (opts.name) {
        if (servers[opts.name]) {
          localName = opts.name
          localEntry = servers[opts.name]
        } else {
          console.error(`No local sandbox found with name '${opts.name}'`)
          process.exit(1)
        }
      } else if (opts.id) {
        const found = Object.entries(servers).find(([, s]) => s.resource_id === opts.id)
        if (found) {
          localName = found[0]
          localEntry = found[1]
        }
      } else {
        const defaultName = cfg.server
        if (defaultName && defaultName !== 'self' && servers[defaultName]) {
          localName = defaultName
          localEntry = servers[defaultName]
        }
      }

      let ip: string
      let status: string
      let keyPath: string

      try {
        const access = await getSshAccess(jwt)
        if (!access.allowed) {
          console.error('SSH access denied by server')
          process.exit(1)
        }
        ip = access.ip
        status = 'active' // BFF only returns allowed:true if active
        // Derive keyPath locally — the key was written during provision
        if (localName) {
          keyPath = getSandboxKeyPathByName(localName)
        } else {
          // No local entry — try to use keyPath from BFF response as fallback
          keyPath = access.keyPath || ''
          if (!keyPath) {
            console.error('No local sandbox found and BFF did not return a key path')
            process.exit(1)
          }
        }
      } catch (err) {
        if (err instanceof BffUnreachableError || err instanceof BffSandboxNotFoundError) {
          // Fall back to local config when BFF is unreachable OR when BFF can't find the sandbox.
          if (!localEntry) {
            console.error('Could not reach provisioning service and no local sandbox found')
            process.exit(1)
          }
          if (!localEntry.host) {
            if (err instanceof BffSandboxNotFoundError) {
              console.error('Sandbox not found in provisioning service and no local IP on record')
            } else {
              console.error('Could not reach provisioning service')
            }
            process.exit(1)
          }
          ip = localEntry.host
          status = localEntry.status ?? 'unknown'
          keyPath = localName ? getSandboxKeyPathByName(localName) : getSandboxKeyPath(opts.id ?? '')
        } else {
          throw err
        }
      }

      if (status !== 'active') {
        console.log(`Sandbox status: ${status}`)
        console.log('Your sandbox is not yet active. Run: duoidal sandbox status')
        process.exit(0)
      }

      if (!fs.existsSync(keyPath)) {
        console.error(`SSH key not found at ${keyPath}. Run: duoidal sandbox provision`)
        process.exit(1)
      }

      const sshArgs = [
        '-i', keyPath,
        '-o', 'StrictHostKeyChecking=accept-new',
        '-o', 'ConnectTimeout=30',
        '-o', 'ConnectionAttempts=5',
        '-o', 'ServerAliveInterval=10',
        `root@${ip}`,
      ]
      const sshCommand = `ssh ${sshArgs.join(' ')}`

      if (opts.dryRun) {
        console.log(sshCommand)
        return
      }

      try {
        execFileSync('ssh', sshArgs, { stdio: 'inherit' })
      } catch (err) {
        const exitCode = (err as NodeJS.ErrnoException & { status?: number }).status ?? 1
        process.exit(exitCode)
      }
    })

  // sandbox link / sandbox unlink
  sandbox.addCommand(linkCommand())
  sandbox.addCommand(unlinkCommand())

  // sandbox repo-clone — Clone a registered private repo into the sandbox
  sandbox.command('repo-clone')
    .description('Clone a registered private repo into the sandbox using a short-lived installation token')
    .requiredOption('--repo <name>', 'Repository name to clone (from: duodal repo list)')
    .action(async (opts: { repo: string }) => {
      // Validate repo name against safe-path whitelist before interpolating into shell commands
      if (!/^[A-Za-z0-9._-]+$/.test(opts.repo)) {
        console.error('Error: --repo must match [A-Za-z0-9._-]+')
        process.exit(1)
      }

      const { accessToken } = await requireAuth()

      // Get clone URL from BFF (handles GitHub App token minting server-side)
      let cloneUrl: string
      try {
        const result = await getRepoCloneUrl(accessToken, opts.repo)
        cloneUrl = result.cloneUrl
      } catch (err) {
        if (err instanceof BffUnreachableError) {
          console.error('Cannot reach provisioning service')
          process.exit(1)
        }
        console.error(`Error getting GitHub clone URL: ${err instanceof Error ? err.message : String(err)}`)
        process.exit(1)
      }

      // Extract owner/name from clone URL for git remote set-url
      // cloneUrl format: https://x-access-token:<token>@github.com/<owner>/<name>.git
      const urlMatch = cloneUrl.match(/github\.com\/([^/]+)\/([^/.]+)/)
      const owner = urlMatch?.[1] ?? opts.repo
      const repoName = urlMatch?.[2] ?? opts.repo

      // Locate sandbox: get IP + key path using config
      const cfg = readConfig()
      const defaultServerName = cfg.server && cfg.server !== 'self' ? cfg.server : null
      const defaultEntry = defaultServerName ? cfg.servers?.[defaultServerName] : null

      let sandboxIp: string
      let keyPath: string

      try {
        const access = await getSshAccess(accessToken)
        sandboxIp = access.ip
        if (defaultServerName) {
          keyPath = getSandboxKeyPathByName(defaultServerName)
        } else {
          // Expand ~ in BFF-returned path
          keyPath = access.keyPath.replace(/^~/, os.homedir())
        }
      } catch (err) {
        if (err instanceof BffUnreachableError && defaultEntry?.host) {
          sandboxIp = defaultEntry.host
          keyPath = defaultServerName ? getSandboxKeyPathByName(defaultServerName) : getSandboxKeyPath('')
        } else {
          throw err
        }
      }

      if (!fs.existsSync(keyPath)) {
        console.error(`SSH key not found at ${keyPath}. Run: duodal sandbox provision`)
        process.exit(1)
      }

      // Clone the repo on the sandbox via SSH
      const sshOpts = ['-i', keyPath, '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=30', '-o', 'ConnectionAttempts=5']
      console.log(`Cloning ${owner}/${repoName} into /root/repos/${opts.repo} on sandbox...`)

      // Shell-quote the URL with JSON.stringify (double quotes, no shell-special chars in token)
      // After clone, rewrite the remote URL to strip the token from .git/config
      const remoteCmd = [
        `git clone ${JSON.stringify(cloneUrl)} /root/repos/${opts.repo}`,
        `git -C /root/repos/${opts.repo} remote set-url origin https://github.com/${owner}/${repoName}.git`,
      ].join(' && ')
      try {
        execFileSync('ssh', [...sshOpts, `root@${sandboxIp}`, remoteCmd], { stdio: 'inherit' })
        console.log(`Repository cloned to /root/repos/${opts.repo}`)
      } catch (err) {
        console.error(`Error cloning repo on sandbox: ${err instanceof Error ? err.message : String(err)}`)
        process.exit(1)
      }
    })

  // sandbox dispatch — Dispatch an agent worktree from a registered repo in the sandbox
  sandbox.command('dispatch')
    .description('Dispatch an agent from a registered repo inside the sandbox')
    .requiredOption('--goal <text>', 'Goal for the agent to accomplish')
    .option('--repo <name>', 'Repository name to dispatch from (from: duodal repo list)')
    .action(async (opts: { goal: string; repo?: string }) => {
      // Validate repo name against safe-path whitelist before interpolating into shell commands
      if (opts.repo && !/^[A-Za-z0-9._-]+$/.test(opts.repo)) {
        console.error('Error: --repo must match [A-Za-z0-9._-]+')
        process.exit(1)
      }

      const { sub: authUserId, accessToken } = await requireAuth()

      const supabaseUrl = getSupabaseUrl()
      const supabaseAnonKey = getSupabaseAnonKey()

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const client = createAuthenticatedSupabaseClient(supabaseUrl, supabaseAnonKey, accessToken, supabaseFactory as any) as any

      let userProjectId: string | undefined
      let repoEntry: { owner: string; name: string } | undefined

      // Find user resource, validate repo is registered, and look up project ID
      {
        const { data: userResources } = await client
          .from('resources')
          .select('id, config')
          .eq('type', 'user')
          .eq('name', `user:${authUserId}`)
          .limit(1)

        const userResourceId: string | undefined = userResources?.[0]?.id
        const userConfig = (userResources?.[0]?.config ?? {}) as Record<string, unknown>

        if (opts.repo) {
          const repos = (userConfig['repos'] ?? []) as Array<{ owner: string; name: string }>
          repoEntry = repos.find(r => r.name === opts.repo)

          if (!repoEntry) {
            console.error(`Error: repo '${opts.repo}' not found. Run: duodal repo add <owner>/${opts.repo}`)
            process.exit(1)
          }
          // Validate owner from DB against safe char set before shell interpolation (defense-in-depth)
          if (!/^[A-Za-z0-9._-]+$/.test(repoEntry.owner)) {
            console.error('Error: repo owner contains invalid characters')
            process.exit(1)
          }
        }

        // Look up the user's project so the process is created in their project
        if (userResourceId) {
          const { data: projectLinks } = await client
            .from('resource_links')
            .select('to_id')
            .eq('from_id', userResourceId)
            .eq('link_type', 'member_of')
            .limit(1)
          userProjectId = projectLinks?.[0]?.to_id as string | undefined
        }
      }

      // Locate sandbox using config
      const dispatchCfg = readConfig()
      const defaultServerName = dispatchCfg.server && dispatchCfg.server !== 'self' ? dispatchCfg.server : null
      const defaultEntry = defaultServerName ? dispatchCfg.servers?.[defaultServerName] : null

      let sandboxIp: string
      let keyPath: string

      try {
        const access = await getSshAccess(accessToken)
        sandboxIp = access.ip
        if (defaultServerName) {
          keyPath = getSandboxKeyPathByName(defaultServerName)
        } else {
          keyPath = access.keyPath.replace(/^~/, os.homedir())
        }
      } catch (err) {
        if (err instanceof BffUnreachableError && defaultEntry?.host) {
          sandboxIp = defaultEntry.host
          keyPath = defaultServerName ? getSandboxKeyPathByName(defaultServerName) : getSandboxKeyPath('')
        } else {
          throw err
        }
      }

      if (!fs.existsSync(keyPath)) {
        console.error(`SSH key not found at ${keyPath}. Run: duodal sandbox provision`)
        process.exit(1)
      }

      // Create a process record in the DB using agent-core CLI
      // Use --unlinked since we don't have a formal skill resource for this ad-hoc goal
      const repoName = opts.repo ?? 'sandbox'
      const slug = `sandbox-dispatch-${Date.now()}`
      const branchName = `boot/${slug}`

      let processId: string
      try {
        const processInitArgs = [
          'agent-core', 'process', 'init',
          '--name', slug,
          '--branch', branchName,
          '--run-type', 'cloud',
          '--unlinked',
          '--prompt', opts.goal,
          '--json',
          ...(userProjectId ? ['--project-id', userProjectId] : []),
        ]
        const initOutput = execFileSync('npx', processInitArgs, {
          cwd: path.join(import.meta.dirname, '../../..'),
          encoding: 'utf-8',
          env: { ...process.env },
        })
        const initData = JSON.parse(initOutput.trim()) as { id: string }
        processId = initData.id
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(processId)) {
          throw new Error(`Invalid process ID: ${processId}`)
        }
      } catch (err) {
        console.error(`Error creating process record: ${err instanceof Error ? err.message : String(err)}`)
        process.exit(1)
      }

      const sshOpts = ['-i', keyPath, '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=30', '-o', 'ConnectionAttempts=5']
      const repoPath = `/root/repos/${repoName}`

      // Set up git branch on the sandbox (run as root to avoid safe.directory issues)
      try {
        const gitSetupCmd = [
          `git config --global --add safe.directory ${repoPath} 2>/dev/null || true`,
          `cd ${repoPath}`,
          `git config user.email "agent@example.com"`,
          `git config user.name "Agent"`,
          `git checkout -b ${branchName} 2>/dev/null || git checkout ${branchName}`,
          // Add safe.directory to the system-level git config so agent user can access the repo
          // without needing to write to ~/.gitconfig (which may be read-only for agent user)
          `git config --system --add safe.directory ${repoPath} 2>/dev/null || true`,
        ].join(' && ')
        execFileSync('ssh', [...sshOpts, `root@${sandboxIp}`, gitSetupCmd], { stdio: 'inherit' })
      } catch (err) {
        console.error(`Error setting up git branch on sandbox: ${err instanceof Error ? err.message : String(err)}`)
        process.exit(1)
      }

      // Get ANTHROPIC_API_KEY from environment for the agent
      const anthropicKey = process.env['ANTHROPIC_API_KEY'] ?? ''
      if (!anthropicKey) {
        console.error('Error: ANTHROPIC_API_KEY must be set to dispatch an agent')
        process.exit(1)
      }

      // Set up SSH reverse tunnel: sandboxIp:PROXY_PORT -> local ANTHROPIC_BASE_URL
      // This lets claude on the sandbox reach the CLIProxyAPI on this machine.
      const localProxyUrl = process.env['ANTHROPIC_BASE_URL'] ?? 'http://172.18.0.1:8317'
      const proxyHost = localProxyUrl.replace(/^https?:\/\//, '').replace(/\/.*$/, '').split(':')[0]
      const proxyPort = parseInt(localProxyUrl.replace(/^https?:\/\//, '').replace(/\/.*$/, '').split(':')[1] ?? '8317', 10)
      const tunnelPort = 18317

      try {
        // Launch background SSH tunnel: remote port tunnelPort -> local proxyHost:proxyPort
        execFileSync('ssh', [
          ...sshOpts,
          '-R', `${tunnelPort}:${proxyHost}:${proxyPort}`,
          '-N', '-f',
          `root@${sandboxIp}`,
        ], { stdio: 'ignore' })
        console.log(`SSH proxy tunnel established (sandbox:${tunnelPort} -> ${proxyHost}:${proxyPort})`)
      } catch {
        console.log('Warning: could not establish proxy tunnel — claude may not be able to authenticate')
      }

      // Ensure non-root agent user exists on sandbox (claude refuses --dangerously-skip-permissions as root)
      try {
        execFileSync('ssh', [...sshOpts, `root@${sandboxIp}`,
          'id agent 2>/dev/null || useradd -m -s /bin/bash agent',
        ], { stdio: 'ignore' })
        // Grant agent user access to the repo directory
        execFileSync('ssh', [...sshOpts, `root@${sandboxIp}`,
          `chmod 755 /root && chmod -R 755 /root/repos && chown -R agent:agent ${repoPath} 2>/dev/null || true`,
        ], { stdio: 'ignore' })
      } catch {
        // best-effort: if agent user setup fails, the launch will fail with a clear error
      }

      // Attempt to get a GitHub token for authenticated push + PR creation.
      // Priority: (1) GitHub App installation token via BFF, (2) GITHUB_PAT env var fallback.
      let ghPushToken: string | undefined
      if (repoEntry) {
        // Try GitHub App installation token via BFF first
        try {
          const { cloneUrl } = await getRepoCloneUrl(accessToken, repoEntry.name)
          const tokenMatch = cloneUrl.match(/x-access-token:([^@]+)@/)
          if (tokenMatch) {
            ghPushToken = tokenMatch[1]
          }
        } catch {
          // Fall through to PAT fallback
        }
        // Fall back to GITHUB_PAT if GitHub App token not available
        if (!ghPushToken) {
          const pat = process.env['GITHUB_PAT'] ?? ''
          if (pat) {
            ghPushToken = pat
          }
        }
      }

      // Supabase REST API URL and service key for process lifecycle management from sandbox.
      // The service key is optional here — if unset, curl-based lifecycle pings are skipped
      // (see conditional branches below). getSupabaseServiceKey() throws when unset, so we
      // catch and fall back to empty string to preserve the existing opt-in behavior.
      const sbUrl = getSupabaseUrl()
      let sbServiceKey = ''
      try {
        sbServiceKey = getSupabaseServiceKey()
      } catch {
        sbServiceKey = ''
      }

      // Launch claude agent in a tmux session on the sandbox (as the agent user)
      // The goal is passed via -p (print mode), running non-interactively
      const sessionName = `dispatch-${processId}`

      // Shell-escape a string for use inside bash single quotes: ' → '\''
      const shEscSingleQuote = (s: string) => s.replace(/'/g, `'\\''`)

      // Pre-build all JSON payloads in Node.js (safe, no shell injection possible)
      // These are then shell-escaped for single-quoted bash context
      const activePatchPayload = JSON.stringify({ status: 'active' })
      const eventPayload = JSON.stringify([{
        process_id: processId,
        process_name: processId,
        source: 'claude-sandbox-dispatch',
        payload: { goal: opts.goal, branch: branchName, status: 'completed' },
      }])
      const completedPatchPayload = JSON.stringify({ status: 'completed', completed_at: 'now()' })
      // GitHub PR creation payload (built in Node.js — no injection)
      const prPayload = (ghPushToken && repoEntry)
        ? JSON.stringify({ title: `agent: ${slug}`, head: branchName, base: 'main', body: 'Automated PR from sandbox dispatch' })
        : null

      // Goal is single-quote-escaped for the `claude -p '...'` argument
      const goalEscaped = shEscSingleQuote(opts.goal)

      const claudeCmd = [
        `umask 077`,  // restrict all new files (including log) to owner-only
        `export ANTHROPIC_API_KEY='${shEscSingleQuote(anthropicKey)}'`,
        `export ANTHROPIC_BASE_URL='http://127.0.0.1:${tunnelPort}'`,
        `export EVAL_PROCESS_ID='${processId}'`,
        `cd ${repoPath}`,
        // Mark process active via Supabase REST API (JSON payload built in Node.js — no injection)
        ...(sbUrl && sbServiceKey ? [
          `curl -sf -X PATCH '${shEscSingleQuote(sbUrl)}/rest/v1/processes?id=eq.${processId}' -H 'Authorization: Bearer ${shEscSingleQuote(sbServiceKey)}' -H 'apikey: ${shEscSingleQuote(sbServiceKey)}' -H 'Content-Type: application/json' -d '${shEscSingleQuote(activePatchPayload)}' 2>/dev/null || true`,
        ] : []),
        `claude -p '${goalEscaped}' --dangerously-skip-permissions 2>&1 | tee /tmp/agent-${processId}.log`,
        `git add -A && git -c user.email=agent@example.com -c user.name='Agent' commit -m 'agent: dispatch goal completed' --allow-empty 2>/dev/null || true`,
        ...(ghPushToken && repoEntry && prPayload
          ? [
              `git push https://x-access-token:${shEscSingleQuote(ghPushToken)}@github.com/${repoEntry.owner}/${repoEntry.name}.git ${branchName} 2>/dev/null || true`,
              `curl -sf -X POST 'https://api.github.com/repos/${repoEntry.owner}/${repoEntry.name}/pulls' -H 'Authorization: Bearer ${shEscSingleQuote(ghPushToken)}' -H 'Accept: application/vnd.github+json' -H 'X-GitHub-Api-Version: 2022-11-28' -H 'Content-Type: application/json' -d '${shEscSingleQuote(prPayload)}' 2>/dev/null || true`,
            ]
          : [
              `git push origin ${branchName} 2>/dev/null || true`,
            ]),
        // Record agent event and mark process completed (JSON built in Node.js — no injection)
        ...(sbUrl && sbServiceKey ? [
          `curl -sf -X POST '${shEscSingleQuote(sbUrl)}/rest/v1/agent_events' -H 'Authorization: Bearer ${shEscSingleQuote(sbServiceKey)}' -H 'apikey: ${shEscSingleQuote(sbServiceKey)}' -H 'Content-Type: application/json' -d '${shEscSingleQuote(eventPayload)}' 2>/dev/null || true`,
          `curl -sf -X PATCH '${shEscSingleQuote(sbUrl)}/rest/v1/processes?id=eq.${processId}' -H 'Authorization: Bearer ${shEscSingleQuote(sbServiceKey)}' -H 'apikey: ${shEscSingleQuote(sbServiceKey)}' -H 'Content-Type: application/json' -d '${shEscSingleQuote(completedPatchPayload)}' 2>/dev/null || true`,
        ] : []),
      ].join(' && ')

      // Write the script to a temp file on the sandbox via stdin (keeps secrets out of SSH argv)
      // chmod 700 (owner-only) before chown so no other user can read credentials
      const scriptPath = `/tmp/dispatch-script-${processId}.sh`
      try {
        execFileSync('ssh', [...sshOpts, `root@${sandboxIp}`,
          `cat > ${scriptPath} && chmod 700 ${scriptPath} && chown agent:agent ${scriptPath} 2>/dev/null || true`,
        ], { input: claudeCmd, stdio: ['pipe', 'ignore', 'pipe'] })
      } catch (err) {
        const details = (err as NodeJS.ErrnoException & { stderr?: Buffer }).stderr?.toString().trim()
        console.error(`Error writing dispatch script: ${err instanceof Error ? err.message : String(err)}${details ? `\n${details}` : ''}`)
        process.exit(1)
      }

      try {
        execFileSync('ssh', [...sshOpts, `root@${sandboxIp}`,
          `tmux new-session -d -s ${sessionName} -c ${repoPath} 'su - agent -c "bash ${scriptPath}"'`,
        ], { stdio: 'inherit' })
      } catch (err) {
        console.error(`Error launching tmux session on sandbox: ${err instanceof Error ? err.message : String(err)}`)
        process.exit(1)
      }

      console.log(processId)
      console.log(`Agent dispatched in sandbox tmux session: ${sessionName}`)
      console.log(`Branch: ${branchName}`)
      console.log(`Log: /tmp/agent-${processId}.log (on sandbox)`)
    })

  return sandbox
}
