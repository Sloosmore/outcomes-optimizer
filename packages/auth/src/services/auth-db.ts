import { randomBytes } from 'node:crypto'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sql = any

/**
 * @remarks Queries auth.users which is Supabase-managed. This table is part of
 * Supabase's auth schema and not managed by our migrations.
 */
export class AuthDbService {
  constructor(private sql: Sql) {}

  /**
   * Find a user by exact email match in auth.users.
   * Returns the user's UUID or null if not found.
   */
  async findUserByEmail(email: string): Promise<{ id: string } | null> {
    const rows = await this.sql`
      SELECT id FROM auth.users WHERE email = ${email} LIMIT 1
    ` as { id: string }[]
    return rows[0] ?? null
  }

  /**
   * Upsert a user into auth.users.
   * If a user with the given email already exists, updates updated_at.
   * If userId is provided, uses it as the UUID; otherwise generates a new one via gen_random_uuid().
   * Returns the user's UUID.
   */
  async upsertUser(email: string, userId?: string): Promise<{ id: string }> {
    const sql = this.sql
    const tempPassword = randomBytes(32).toString('hex')
    let rows: { id: string }[]
    if (userId) {
      rows = await sql`
        INSERT INTO auth.users (
          id, instance_id, email, encrypted_password, confirmed_at,
          created_at, updated_at, aud, role, raw_app_meta_data, raw_user_meta_data
        )
        VALUES (
          ${userId}::uuid,
          '00000000-0000-0000-0000-000000000000'::uuid,
          ${email},
          crypt(${tempPassword}, gen_salt('bf')),
          now(), now(), now(),
          'authenticated', 'authenticated',
          '{"provider":"email","providers":["email"]}'::jsonb,
          '{}'::jsonb
        )
        ON CONFLICT (email) DO UPDATE SET updated_at = now()
        RETURNING id
      ` as { id: string }[]
    } else {
      rows = await sql`
        INSERT INTO auth.users (
          id, instance_id, email, encrypted_password, confirmed_at,
          created_at, updated_at, aud, role, raw_app_meta_data, raw_user_meta_data
        )
        VALUES (
          gen_random_uuid(),
          '00000000-0000-0000-0000-000000000000'::uuid,
          ${email},
          crypt(${tempPassword}, gen_salt('bf')),
          now(), now(), now(),
          'authenticated', 'authenticated',
          '{"provider":"email","providers":["email"]}'::jsonb,
          '{}'::jsonb
        )
        ON CONFLICT (email) DO UPDATE SET updated_at = now()
        RETURNING id
      ` as { id: string }[]
    }
    return rows[0]
  }
}
