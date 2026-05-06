#!/usr/bin/env npx tsx
/**
 * Mint a sandbox identity token for credential writeback.
 *
 * Generates a cryptographically random 32-byte hex token, registers its sha256
 * hash in sandbox_identity_tokens via register_sandbox_token RPC, and prints the
 * plain token to stdout so it can be written to /root/.sandbox/token in the sandbox.
 *
 * Usage:
 *   npx tsx scripts/mint-sandbox-token.ts \
 *     --sandbox-id <server_resource_uuid> \
 *     --user-id <user_resource_uuid> \
 *     [--expires-in-days 30]
 *
 * Required env vars:
 *   DATABASE_URL or SKILL_NETWORKS_DATABASE_URL — direct Postgres connection
 *
 * Output (stdout): the plain token (64-char hex string)
 * The caller is responsible for writing this to the sandbox's token file.
 */

import { randomBytes } from 'crypto'
import postgres from 'postgres'

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(): { sandboxId: string; userId: string; expiresInDays: number } {
  const args = process.argv.slice(2)

  function getArg(flag: string): string | undefined {
    const idx = args.indexOf(flag)
    return idx !== -1 ? args[idx + 1] : undefined
  }

  const sandboxId = getArg('--sandbox-id')
  const userId = getArg('--user-id')
  const expiresInDaysStr = getArg('--expires-in-days')

  if (!sandboxId || !userId) {
    console.error(
      'Usage: npx tsx scripts/mint-sandbox-token.ts --sandbox-id <uuid> --user-id <uuid> [--expires-in-days 30]',
    )
    process.exit(1)
  }

  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (!uuidRegex.test(sandboxId)) {
    console.error(`ERROR: --sandbox-id must be a valid UUID, got: ${sandboxId}`)
    process.exit(1)
  }
  if (!uuidRegex.test(userId)) {
    console.error(`ERROR: --user-id must be a valid UUID, got: ${userId}`)
    process.exit(1)
  }

  const expiresInDays = expiresInDaysStr ? parseInt(expiresInDaysStr, 10) : 30
  if (isNaN(expiresInDays) || expiresInDays <= 0) {
    console.error(`ERROR: --expires-in-days must be a positive integer, got: ${expiresInDaysStr}`)
    process.exit(1)
  }

  return { sandboxId, userId, expiresInDays }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { sandboxId, userId, expiresInDays } = parseArgs()

  const databaseUrl = process.env['DATABASE_URL'] ?? process.env['SKILL_NETWORKS_DATABASE_URL']
  if (!databaseUrl) {
    console.error('ERROR: DATABASE_URL or SKILL_NETWORKS_DATABASE_URL must be set')
    process.exit(1)
  }

  // Generate cryptographically random 32-byte (64-char hex) token
  const plainToken = randomBytes(32).toString('hex')

  // Compute expiry timestamp
  const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000)

  const sql = postgres(databaseUrl)

  try {
    // Register the token hash via the SECURITY DEFINER RPC
    const [row] = await sql<[{ register_sandbox_token: string }]>`
      SELECT public.register_sandbox_token(
        ${sandboxId}::uuid,
        ${userId}::uuid,
        ${plainToken},
        ${expiresAt.toISOString()}::timestamptz
      ) AS register_sandbox_token
    `

    const tokenRecordId = row.register_sandbox_token
    console.error(`Token registered. Record ID: ${tokenRecordId}`)
    console.error(`Sandbox ID: ${sandboxId}`)
    console.error(`User ID:    ${userId}`)
    console.error(`Expires:    ${expiresAt.toISOString()}`)
    console.error(`Scope:      writeback_own_credentials`)
    console.error('')
    console.error('Write the token below to /root/.sandbox/token in the sandbox:')

    // Print the plain token to stdout (separate from diagnostic stderr output)
    process.stdout.write(plainToken + '\n')
  } finally {
    await sql.end()
  }
}

main().catch((err) => {
  console.error('Unhandled error:', err)
  process.exit(1)
})
