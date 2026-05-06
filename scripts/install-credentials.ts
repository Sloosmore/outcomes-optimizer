#!/usr/bin/env npx tsx
/**
 * Idempotent credential installer.
 *
 * Stores CLOUDFLARE_API_TOKEN, ANTHROPIC_API_KEY, and codex_chatgpt_pro_auth
 * in Supabase Vault, linked to the target user resource via 'parent' link.
 *
 * Running this script twice produces exactly 3 credential rows — no duplicates.
 * Existing credentials are detected by resource name and skipped.
 *
 * Usage:
 *   npx tsx scripts/install-credentials.ts --user-id <user_resource_uuid>
 *
 * Required env vars:
 *   DATABASE_URL or SKILL_NETWORKS_DATABASE_URL — direct Postgres connection
 *   CLOUDFLARE_API_TOKEN_VALUE                  — Cloudflare API token to store
 *   ANTHROPIC_API_KEY_VALUE                     — Anthropic API key to store
 *   CODEX_AUTH_JSON                             — Codex ChatGPT Pro auth JSON to store
 */

import postgres from 'postgres'

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(): { userId: string } {
  const args = process.argv.slice(2)
  const idx = args.indexOf('--user-id')
  if (idx === -1 || !args[idx + 1]) {
    console.error('Usage: npx tsx scripts/install-credentials.ts --user-id <user_resource_uuid>')
    process.exit(1)
  }
  const userId = args[idx + 1]
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) {
    console.error(`ERROR: --user-id must be a valid UUID, got: ${userId}`)
    process.exit(1)
  }
  return { userId }
}

// ---------------------------------------------------------------------------
// Credential definitions
// ---------------------------------------------------------------------------

interface CredentialSpec {
  /** Stable resource name (used for idempotency check) */
  name: string
  /** Provider identifier stored in config.provider */
  provider: string
  /** Sandbox context for grouping */
  sandboxName: string
  /** The secret value to store */
  value: string
}

function buildCredentialSpecs(userId: string): CredentialSpec[] {
  const cfToken = process.env['CLOUDFLARE_API_TOKEN_VALUE']
  const anthropicKey = process.env['ANTHROPIC_API_KEY_VALUE']
  const codexAuth = process.env['CODEX_AUTH_JSON']

  const missing: string[] = []
  if (!cfToken) missing.push('CLOUDFLARE_API_TOKEN_VALUE')
  if (!anthropicKey) missing.push('ANTHROPIC_API_KEY_VALUE')
  if (!codexAuth) missing.push('CODEX_AUTH_JSON')

  if (missing.length > 0) {
    console.error(`ERROR: Missing required env vars: ${missing.join(', ')}`)
    process.exit(1)
  }

  return [
    {
      name: 'CLOUDFLARE_API_TOKEN',
      provider: 'cloudflare',
      sandboxName: userId,
      value: cfToken!,
    },
    {
      name: 'ANTHROPIC_API_KEY',
      provider: 'anthropic',
      sandboxName: userId,
      value: anthropicKey!,
    },
    {
      name: 'codex_chatgpt_pro_auth',
      provider: 'codex',
      sandboxName: userId,
      value: codexAuth!,
    },
  ]
}

// ---------------------------------------------------------------------------
// Install logic
// ---------------------------------------------------------------------------

async function installCredential(
  sql: postgres.Sql,
  spec: CredentialSpec,
  userResourceId: string,
): Promise<{ installed: boolean; resourceId: string }> {
  // Idempotency check: does this credential resource already exist?
  const existing = await sql<[{ id: string }?]>`
    SELECT r.id
    FROM public.resources r
    JOIN public.resource_links rl ON rl.from_id = r.id AND rl.link_type = 'parent'
    WHERE r.name = ${spec.name}
      AND r.type = 'credential'
      AND rl.to_id = ${userResourceId}
    LIMIT 1
  `

  if (existing.length > 0) {
    console.log(`  [SKIP] ${spec.name} — already exists (id: ${existing[0]!.id})`)
    return { installed: false, resourceId: existing[0]!.id }
  }

  // Store secret in vault
  const vaultName = `credential-${userResourceId}-${spec.sandboxName}-${spec.provider}`
  const [vaultRow] = await sql<[{ id: string }]>`
    SELECT vault.create_secret(${spec.value}, ${vaultName}) AS id
  `
  const vaultSecretId = vaultRow.id

  // Create credential resource
  const [credRow] = await sql<[{ id: string }]>`
    INSERT INTO public.resources (name, type, status, config)
    VALUES (
      ${spec.name},
      'credential',
      'active',
      ${sql.json({ vaultSecretId, provider: spec.provider, sandboxName: spec.sandboxName })}
    )
    RETURNING id
  `
  const credResourceId = credRow.id

  // Link to user resource via 'parent'
  await sql`
    INSERT INTO public.resource_links (from_id, to_id, link_type)
    VALUES (${credResourceId}, ${userResourceId}, 'parent')
  `

  console.log(`  [OK]   ${spec.name} — installed (id: ${credResourceId}, vaultId: ${vaultSecretId})`)
  return { installed: true, resourceId: credResourceId }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { userId } = parseArgs()

  const databaseUrl = process.env['DATABASE_URL'] ?? process.env['SKILL_NETWORKS_DATABASE_URL']
  if (!databaseUrl) {
    console.error('ERROR: DATABASE_URL or SKILL_NETWORKS_DATABASE_URL must be set')
    process.exit(1)
  }

  const sql = postgres(databaseUrl)

  try {
    // Verify the user resource exists
    const [userResource] = await sql<[{ id: string; name: string }?]>`
      SELECT id, name FROM public.resources WHERE id = ${userId} AND type = 'user' LIMIT 1
    `
    if (!userResource) {
      console.error(`ERROR: User resource not found: ${userId}`)
      process.exit(1)
    }

    console.log(`Installing credentials for user resource: ${userResource.name} (${userId})`)

    const specs = buildCredentialSpecs(userId)
    let installedCount = 0

    for (const spec of specs) {
      const result = await installCredential(sql, spec, userId)
      if (result.installed) installedCount++
    }

    // Verify final count
    const [countRow] = await sql<[{ count: string }]>`
      SELECT COUNT(*) AS count
      FROM public.resources r
      JOIN public.resource_links rl ON rl.from_id = r.id AND rl.link_type = 'parent'
      WHERE r.type = 'credential'
        AND r.name IN ('CLOUDFLARE_API_TOKEN', 'ANTHROPIC_API_KEY', 'codex_chatgpt_pro_auth')
        AND rl.to_id = ${userId}
    `

    const finalCount = parseInt(countRow.count, 10)
    console.log(`\nCredential rows linked to user (expected 3): ${finalCount}`)

    if (finalCount !== 3) {
      console.error(`ERROR: Expected exactly 3 credential rows, found ${finalCount}`)
      process.exit(1)
    }

    console.log(`Done. Installed ${installedCount} new, ${3 - installedCount} already existed.`)
  } finally {
    await sql.end()
  }
}

main().catch((err) => {
  console.error('Unhandled error:', err)
  process.exit(1)
})
