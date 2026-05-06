import { Command } from 'commander'
import { getSupabaseServiceKey, getSupabaseUrl } from '../lib/helpers.js'

const FETCH_TIMEOUT_MS = 10_000

export function adminCommand(): Command {
  const admin = new Command('admin')
  admin.description('Admin operations (requires SUPABASE_SERVICE_KEY)')

  admin.command('approve-user')
    .description('Approve a user by email (sets config.status = "approved")')
    .requiredOption('--email <email>', 'Email address of the user to approve')
    .action(async (opts: { email: string }) => {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(opts.email)) {
        console.error('Error: --email must be a valid email address')
        process.exit(1)
      }

      let serviceKey: string
      try {
        serviceKey = getSupabaseServiceKey()
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : 'SUPABASE_SERVICE_KEY is required'}`)
        process.exit(1)
      }

      const supabaseUrl = getSupabaseUrl()

      const authHeaders = {
        'Authorization': `Bearer ${serviceKey}`,
        'apikey': serviceKey,
      }

      try {
        // Step 1: Look up the auth user by email using the admin API
        // per_page=1000 prevents silent misses when the default 50-user page doesn't include the target
        const listUsersRes = await fetch(
          `${supabaseUrl}/auth/v1/admin/users?email=${encodeURIComponent(opts.email)}&per_page=1000`,
          { headers: authHeaders, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }
        )

        if (!listUsersRes.ok) {
          console.error(`Error: Failed to look up user — HTTP ${listUsersRes.status}`)
          if (process.env['DEBUG']) console.error(await listUsersRes.text())
          process.exit(1)
        }

        const listData = await listUsersRes.json() as { users: Array<{ id: string; email: string }> }
        const normalizedEmail = opts.email.toLowerCase()
        const matches = (listData.users ?? []).filter((u) => u.email?.toLowerCase() === normalizedEmail)

        if (matches.length === 0) {
          const pageSize = (listData.users ?? []).length
          if (pageSize >= 1000) {
            console.error(`Error: Could not find user in first 1000 accounts — user base may be too large for single-page lookup`)
          } else {
            console.error(`Error: No auth user found with email: ${opts.email}`)
          }
          process.exit(1)
        }
        if (matches.length > 1) {
          console.error(`Error: Multiple auth users match ${opts.email} — refusing to act ambiguously`)
          process.exit(1)
        }
        const authUser = matches[0]
        const authUserId = authUser.id
        console.log(`Found auth user: ${authUserId}`)

        // Step 2: Find the user resource row by auth_user_id
        const resourceRes = await fetch(
          `${supabaseUrl}/rest/v1/resources?auth_user_id=eq.${authUserId}&type=eq.user&select=id,name,config`,
          { headers: { ...authHeaders, 'Accept': 'application/json' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }
        )

        if (!resourceRes.ok) {
          console.error(`Error: Failed to query resources — HTTP ${resourceRes.status}`)
          if (process.env['DEBUG']) console.error(await resourceRes.text())
          process.exit(1)
        }

        const resources = await resourceRes.json() as Array<{ id: string; name: string; config: Record<string, unknown> }>

        if (!resources || resources.length === 0) {
          console.error(`Error: No user resource found for auth user ${authUserId}`)
          console.error('The user may not have completed signup (no resource row created yet)')
          process.exit(1)
        }

        const userResource = resources[0]
        console.log(`Found user resource: ${userResource.id} (name: ${userResource.name})`)

        // Check current status
        const currentStatus = userResource.config?.['status']
        if (currentStatus === 'approved') {
          console.log(`User is already approved (status: ${currentStatus})`)
          return
        }

        // Step 3: Update config.status = 'approved' using service key
        const newConfig = { ...userResource.config, status: 'approved' }

        const updateParams = new URLSearchParams({ id: `eq.${userResource.id}`, type: 'eq.user', auth_user_id: `eq.${authUserId}` })
        const updateRes = await fetch(
          `${supabaseUrl}/rest/v1/resources?${updateParams}`,
          {
            method: 'PATCH',
            headers: { ...authHeaders, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
            body: JSON.stringify({ config: newConfig }),
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          }
        )

        if (!updateRes.ok) {
          console.error(`Error: Failed to update user resource — HTTP ${updateRes.status}`)
          if (process.env['DEBUG']) console.error(await updateRes.text())
          process.exit(1)
        }

        const updated = await updateRes.json() as Array<{ id: string; config: Record<string, unknown> }>

        const verifiedStatus = updated[0]?.config?.['status']
        if (verifiedStatus !== 'approved') {
          console.error(`Error: Update succeeded but status is "${verifiedStatus}", not "approved"`)
          process.exit(1)
        }

        console.log(`Success: User ${opts.email} approved`)
        console.log(`  Resource ID: ${userResource.id}`)
        console.log(`  config.status = "${verifiedStatus}"`)
      } catch (err) {
        if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
          console.error('Error: Request timed out — Supabase did not respond within 10s')
        } else {
          console.error(`Error: ${err instanceof Error ? err.message : String(err)}`)
        }
        process.exit(1)
      }
    })

  return admin
}
