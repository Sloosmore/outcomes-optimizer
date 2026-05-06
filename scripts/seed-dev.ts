import { createClient } from '@supabase/supabase-js'
import { executeAction } from '@skill-networks/database/actions'

// Set PRODUCTION_HOST_FRAGMENT to your production Supabase project ref or any
// substring that uniquely identifies the prod connection string (e.g. the project
// ref). The seed script aborts if either DB connection variable contains it.
const PRODUCTION_HOST_FRAGMENT = process.env.PRODUCTION_HOST_FRAGMENT ?? ''

function guardProduction(): void {
  if (!PRODUCTION_HOST_FRAGMENT) return
  const dbUrl = process.env.SKILL_NETWORKS_DATABASE_URL ?? ''
  const supabaseUrl = process.env.SUPABASE_URL ?? ''
  if (dbUrl.includes(PRODUCTION_HOST_FRAGMENT) || supabaseUrl.includes(PRODUCTION_HOST_FRAGMENT)) {
    console.error('ERROR: Environment points to production. Aborting seed.')
    process.exit(1)
  }
}

async function main(): Promise<void> {
  guardProduction()

  const supabaseUrl = process.env.SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !serviceRoleKey) {
    console.error('ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.')
    process.exit(1)
  }

  const email = process.env.VITE_DEBUG_EMAIL
  const password = process.env.VITE_DEBUG_PASSWORD
  if (!email || !password) {
    console.error('ERROR: VITE_DEBUG_EMAIL and VITE_DEBUG_PASSWORD must be set.')
    process.exit(1)
  }

  const serviceClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  // Create or look up the auth user
  let authUserId: string

  const { data: createData, error: createError } = await serviceClient.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  })

  if (createError) {
    if (createError.message.toLowerCase().includes('already been registered') ||
        createError.message.toLowerCase().includes('already exists') ||
        createError.message.toLowerCase().includes('duplicate')) {
      // User already exists — sign in to get the ID (listUsers is unreliable on DB branches)
      const { data: signInData, error: signInErr } = await serviceClient.auth.signInWithPassword({ email, password })
      if (signInErr || !signInData.user) {
        console.error('ERROR: Failed to sign in as existing user:', signInErr?.message ?? 'no user returned')
        process.exit(1)
      }
      authUserId = signInData.user.id
      console.log(`Auth user already exists: ${authUserId}`)
    } else {
      console.error('ERROR: Failed to create auth user:', createError.message)
      process.exit(1)
    }
  } else {
    authUserId = createData.user.id
    console.log(`Auth user created: ${authUserId}`)
  }

  // Provision the user via executeAction
  const result = await executeAction('provision_user', { authUserId, email }, serviceClient)

  console.log('provision_user result:')
  console.log('  userResourceId:    ', result.userResourceId)
  console.log('  projectResourceId: ', result.projectResourceId)
}

main().catch((err) => {
  console.error('Unhandled error:', err)
  process.exit(1)
})
