/**
 * Apply Row Level Security policies to all application tables.
 *
 * Reads packages/database/rls.sql and executes it against the configured database.
 * Safe to run multiple times — all statements are idempotent.
 *
 * Usage:
 *   npx tsx packages/database/scripts/apply-rls.ts
 *
 * Requires DATABASE_URL in the environment (or .env file).
 */
import * as fs from 'fs'
import * as path from 'path'
import postgres from 'postgres'
import { dirname } from 'path'
import { fileURLToPath } from 'url'
const __dirname = dirname(fileURLToPath(import.meta.url))

async function main() {
  // Load .env if present (local dev convenience)
  try {
    const { config } = await import('dotenv')
    config()
  } catch {
    // dotenv is optional — env vars may already be set
  }

  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    console.error('Error: DATABASE_URL is not set')
    process.exit(1)
  }

  const sqlPath = path.join(__dirname, '..', 'rls.sql')
  if (!fs.existsSync(sqlPath)) {
    console.error(`Error: SQL file not found at ${sqlPath}`)
    process.exit(1)
  }

  const sqlContent = fs.readFileSync(sqlPath, 'utf-8')

  // Execute the entire file as a single unsafe() call. postgres.js supports
  // multiple statements in one unsafe() invocation, and rls.sql contains no
  // dynamic values — it is a static DDL file, so sql injection is not a concern.
  const sql = postgres(connectionString, { max: 1 })

  try {
    console.log(`Applying RLS policies from ${sqlPath}`)
    await sql.unsafe(sqlContent)
    console.log('RLS policies applied successfully.')
  } catch (error) {
    console.error('\nFailed to apply RLS policies:', error instanceof Error ? error.message : error)
    process.exit(1)
  } finally {
    await sql.end()
  }
}

main()
