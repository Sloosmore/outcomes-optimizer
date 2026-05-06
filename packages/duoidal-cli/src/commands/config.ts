import { Command } from 'commander'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { readConfig, writeConfig, type ServerEntry } from '@duoidal/config'

interface SandboxMeta {
  serverResourceId?: string
  serverName?: string
  provisionedAt?: string
  status?: string
  ip?: string
  port?: number
  keyPath?: string
  credentialResourceId?: string
  hetznerServerId?: number
}

export function configCommand(): Command {
  const config = new Command('config')
  config.description('Manage duoidal configuration')

  config.command('migrate')
    .description('Migrate sandbox metadata from ~/.config/duoidal/sandboxes/ to config.json')
    .action(async () => {
      const sandboxesDir = path.join(os.homedir(), '.config', 'duoidal', 'sandboxes')

      if (!fs.existsSync(sandboxesDir)) {
        console.log('No legacy sandbox directory found — nothing to migrate.')
        return
      }

      const entries = fs.readdirSync(sandboxesDir)
      let migrated = 0
      let skipped = 0

      const cfg = readConfig()
      cfg.servers ??= {}

      for (const entry of entries) {
        const metaPath = path.join(sandboxesDir, entry, 'meta.json')
        if (!fs.existsSync(metaPath)) continue

        let meta: SandboxMeta
        try {
          meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as SandboxMeta
        } catch {
          console.warn(`  Skipping ${entry}: invalid JSON`)
          skipped++
          continue
        }

        const name = meta.serverName ?? entry
        if (cfg.servers[name]) {
          console.log(`  Skipping '${name}': already in config.json`)
          skipped++
          continue
        }

        const serverEntry: ServerEntry = {
          host: meta.ip ?? '',
          user: 'root',
          key: meta.keyPath ?? `keys/${name}/id_ed25519`,
          resource_id: meta.serverResourceId ?? entry,
          provider: 'hetzner',
          status: (meta.status as ServerEntry['status']) ?? 'active',
          provisioned_at: meta.provisionedAt ?? new Date().toISOString(),
        }

        if (meta.hetznerServerId) serverEntry.hetzner_server_id = meta.hetznerServerId
        if (meta.credentialResourceId) serverEntry.credential_resource_id = meta.credentialResourceId

        cfg.servers[name] = serverEntry
        migrated++
        console.log(`  Migrated '${name}' (${meta.ip ?? 'no IP'})`)
      }

      writeConfig(cfg)
      console.log(`Migration complete: ${migrated} migrated, ${skipped} skipped.`)
    })

  return config
}
