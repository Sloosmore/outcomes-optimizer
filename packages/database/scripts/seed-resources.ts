/**
 * One-time seed script: backfills tags, inserts app resources, links via resource_links.
 *
 * Run after migration 0021:
 *   doppler run -- npx tsx packages/database/scripts/seed-resources.ts
 *
 * Idempotent: uses ON CONFLICT (name) DO NOTHING for inserts.
 * All 4 Instagram accounts are confirmed on Meta App 1247792550623395.
 */

import 'dotenv/config'
import { eq, and } from 'drizzle-orm'
import { createClient } from '@supabase/supabase-js'
import { getDb, closeDb } from '../src/drizzle-client.js'
import { resources } from '../src/schema.js'
import { executeAction } from '../src/actions/execute-action.js'
import { getSupabaseUrl } from '../src/constants.js'

async function main() {
  const db = getDb()

  // Build a Supabase client for executeAction calls
  const supabaseUrl = getSupabaseUrl()
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_KEY ?? process.env.SUPABASE_ANON_KEY
  if (!supabaseKey) {
    throw new Error('Missing required env var: SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SERVICE_KEY / SUPABASE_ANON_KEY)')
  }
  const supabase = createClient(supabaseUrl, supabaseKey)

  // Look up the default project — required by create_app
  const [defaultProject] = await db.select({ id: resources.id }).from(resources).where(eq(resources.type, 'project')).limit(1)
  if (!defaultProject) throw new Error('No project found — seed requires at least one project resource')

  // ── 1. Tag backfill removed ────────────────────────────────────────────────
  // Tags text[] columns have been dropped from resources. Tag backfill is now
  // handled by the data migration in story 3 (utils/database/migrate.ts).
  console.log('Step 1 (tag backfill) superseded by story 3 migration — skipping.')

  // ── 2. Insert app resources (idempotent) ───────────────────────────────────
  console.log('\nInserting app resources...')

  // Check and create meta-app-instagram if it doesn't exist
  const existingMeta = await db.select({ id: resources.id }).from(resources).where(eq(resources.name, 'meta-app-instagram')).limit(1)
  if (existingMeta.length === 0) {
    await executeAction('create_app', {
      name: 'meta-app-instagram',
      projectId: defaultProject.id,
      config: {
        platform: 'meta',
        appId: '1247792550623395',
        appIdEnvVar: 'INSTAGRAM_APP_ID',
        appSecretEnvVar: 'INSTAGRAM_APP_SECRET',
        tokenTtlDays: 60,
        tokenRefreshUrl: 'https://graph.facebook.com/oauth/access_token',
        graphApiVersion: 'v19.0',
        notes: 'Meta developer app that parents all Instagram accounts. Used for token refresh via Graph API.',
      },
    }, supabase)
  }
  console.log('  meta-app-instagram (created or already existed)')

  // Check and create google-youtube-app if it doesn't exist
  const existingYt = await db.select({ id: resources.id }).from(resources).where(eq(resources.name, 'google-youtube-app')).limit(1)
  if (existingYt.length === 0) {
    await executeAction('create_app', {
      name: 'google-youtube-app',
      projectId: defaultProject.id,
      config: {
        platform: 'google',
        clientIdEnvVar: 'YOUTUBE_CLIENT_ID',
        clientSecretEnvVar: 'YOUTUBE_CLIENT_SECRET',
        notes: 'Google OAuth project that parents YouTube accounts. Client credentials used for token refresh.',
      },
    }, supabase)
  }
  console.log('  google-youtube-app (created or already existed)')

  // ── 3. Insert resource_links (parent relationships) ───────────────────────
  console.log('\nInserting resource links...')

  // Look up the app resource IDs inserted (or pre-existing) in step 2
  const [metaApp] = await db.select({ id: resources.id })
    .from(resources)
    .where(eq(resources.name, 'meta-app-instagram'))
  const [googleYtApp] = await db.select({ id: resources.id })
    .from(resources)
    .where(eq(resources.name, 'google-youtube-app'))

  // Find all Instagram identity resources (type='identity', config.platform='meta')
  const allIdentities = await db.select({ id: resources.id, name: resources.name, config: resources.config })
    .from(resources)
    .where(eq(resources.type, 'identity'))
  const instagramAccounts = allIdentities.filter(r => (r.config as Record<string, unknown>)?.['platform'] === 'meta')

  // Find youtube-hay-maker
  const ytHayMakerRows = await db.select({ id: resources.id })
    .from(resources)
    .where(and(eq(resources.name, 'youtube-hay-maker'), eq(resources.type, 'identity')))
  const ytHayMaker = ytHayMakerRows[0] ?? null

  let created = 0
  let skipped = 0

  // Link each Instagram account → meta-app-instagram
  if (!metaApp) {
    console.warn('  WARNING: meta-app-instagram not found — skipping Instagram account links')
  } else {
    for (const account of instagramAccounts) {
      const result = await executeAction('assign_parent', { fromId: account.id, toId: metaApp.id }, supabase)
      if (result.created) {
        console.log(`  linked ${account.name} → meta-app-instagram`)
        created++
      } else {
        skipped++
      }
    }
  }

  // Link youtube-hay-maker → google-youtube-app
  if (!googleYtApp) {
    console.warn('  WARNING: google-youtube-app not found — skipping youtube-hay-maker link')
  } else if (!ytHayMaker) {
    console.warn('  WARNING: youtube-hay-maker not found — skipping link')
  } else {
    const result = await executeAction('assign_parent', { fromId: ytHayMaker.id, toId: googleYtApp.id }, supabase)
    if (result.created) {
      console.log('  linked youtube-hay-maker → google-youtube-app')
      created++
    } else {
      skipped++
    }
  }

  console.log(`  resource_links: ${created} created, ${skipped} already existed`)

  // ── 4. Summary ─────────────────────────────────────────────────────────────
  console.log('\nFinal resource tree:')
  const all = await db.select({
    name: resources.name,
    type: resources.type,
    status: resources.status,
  }).from(resources).orderBy(resources.type, resources.name)

  for (const r of all) {
    console.log(`  ${r.type.padEnd(12)} ${r.name.padEnd(32)} [${r.status}]`)
  }
}

main()
  .catch(e => {
    console.error('Seed failed:', e instanceof Error ? e.message : e)
    process.exit(1)
  })
  .finally(() => closeDb())
