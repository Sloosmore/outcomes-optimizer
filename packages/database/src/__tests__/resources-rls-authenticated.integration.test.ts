/**
 * Regression test for the RLS bug where SELECT on public.resources as the
 * `authenticated` role failed with:
 *   42883: operator does not exist: text = uuid
 *
 * Root cause: a policy on public.resources compared auth.uid() (uuid) against
 * auth_user_id (text, widened in 20260421000001) without a ::text cast.
 *
 * Fix migration: 20260505000001_fix_resources_rls_type_cast.sql — drops drifted
 * policies and re-creates `authenticated_select_own` with the correct cast.
 *
 * This test:
 *   - Inserts an auth.users row + a matching resources row (type='user',
 *     auth_user_id = that user's id).
 *   - Sets the request as that authenticated user (role=authenticated +
 *     request.jwt.claims.sub).
 *   - SELECTs the user's own row from public.resources.
 *
 * Before the fix: the SELECT raises 42883 (text = uuid).
 * After  the fix: the SELECT returns exactly one row.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { randomUUID } from 'node:crypto'

const RUN_INTEGRATION = !!process.env.RUN_INTEGRATION

describe.skipIf(!RUN_INTEGRATION)('resources RLS — authenticated SELECT own row', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- sql client typed loosely for test convenience
  let sql: any
  const authUid = randomUUID()
  const email = `rls-test-${authUid.slice(0, 8)}@rls-regression.test`
  let resourceId: string | null = null

  beforeAll(async () => {
    const DATABASE_URL = process.env.DATABASE_URL
    if (!DATABASE_URL) {
      throw new Error('DATABASE_URL must be set for integration tests')
    }
    sql = postgres(DATABASE_URL)

    // Insert auth.users row (admin / superuser context).
    await sql`
      INSERT INTO auth.users (
        id, email, aud, role,
        email_confirmed_at, created_at, updated_at,
        raw_app_meta_data, raw_user_meta_data,
        is_sso_user, is_anonymous
      ) VALUES (
        ${authUid}, ${email}, 'authenticated', 'authenticated',
        now(), now(), now(),
        '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
        false, false
      )
    `

    // Insert a matching user resource row keyed on auth_user_id (text since
    // 20260421000001).
    const rows = await sql`
      INSERT INTO public.resources (name, type, status, auth_user_id, auth_provider, config)
      VALUES (
        ${`user:${authUid}`}, 'user', 'active', ${authUid}, 'supabase', '{}'::jsonb
      )
      RETURNING id
    `
    resourceId = rows[0]?.id ?? null
    if (!resourceId) {
      throw new Error('Failed to insert test resource row')
    }
  })

  afterAll(async () => {
    if (resourceId) {
      await sql`DELETE FROM public.resources WHERE id = ${resourceId}`
    }
    await sql`DELETE FROM auth.users WHERE id = ${authUid}`
    await sql.end()
  })

  it('an authenticated user can SELECT their own user resource by auth_user_id = auth.uid()::text', async () => {
    // Simulate PostgREST: SET ROLE authenticated and the JWT-claim sub used by
    // auth.uid(). Wrap in a transaction so SET LOCAL is scoped to this call.
    const result = await sql.begin(async (tx: typeof sql) => {
      await tx`SET LOCAL role TO authenticated`
      await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ sub: authUid, role: 'authenticated' })}, true)`

      // The exact shape that triggered 42883 in production:
      //   GET /rest/v1/resources?type=eq.user
      // Plus the canonical ownership filter the policy relies on.
      const rows = await tx`
        SELECT id, auth_user_id
        FROM public.resources
        WHERE type = 'user' AND auth_user_id = auth.uid()::text
      `
      return rows
    })

    expect(result.length).toBeGreaterThanOrEqual(1)
    const row = result.find((r: { id: string }) => r.id === resourceId)
    expect(row).toBeDefined()
    expect(row.auth_user_id).toBe(authUid)
  })

  it('a plain SELECT with no filter (authenticated) does not raise 42883', async () => {
    // Pre-fix repro: the policy's USING clause was evaluated for every row
    // and failed at planning time, regardless of the WHERE clause the client
    // attached. Post-fix, a bare SELECT must complete without a type error
    // (it may return 0..N rows depending on which user resources match).
    await expect(
      sql.begin(async (tx: typeof sql) => {
        await tx`SET LOCAL role TO authenticated`
        await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ sub: authUid, role: 'authenticated' })}, true)`
        return tx`SELECT id FROM public.resources WHERE type = 'user'`
      })
    ).resolves.toBeDefined()
  })
})
