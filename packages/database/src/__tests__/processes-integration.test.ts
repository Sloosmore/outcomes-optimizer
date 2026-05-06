import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'

// Gate: requires explicit opt-in regardless of database availability
const RUN_INTEGRATION = !!process.env.RUN_INTEGRATION

describe.skipIf(!RUN_INTEGRATION)('processes table - duplicate name inserts (L2)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- sql client typed loosely for test convenience
  let sql: any

  beforeAll(() => {
    const DATABASE_URL = process.env.DATABASE_URL
    if (!DATABASE_URL) {
      throw new Error('DATABASE_URL must be set for integration tests')
    }
    sql = postgres(DATABASE_URL)
  })

  afterAll(async () => {
    await sql.end()
  })

  beforeEach(async () => {
    // Clean up any test rows from previous runs
    await sql`DELETE FROM processes WHERE name LIKE 'test-idempotent-%'`
  })

  it('allows two inserts with the same name and returns distinct IDs', async () => {
    const testName = `test-idempotent-${Date.now()}`

    // First insert
    const [row1] = await sql`
      INSERT INTO processes (name, status)
      VALUES (${testName}, 'pending')
      RETURNING id
    `

    // Second insert with SAME name — must not throw (no unique constraint)
    const [row2] = await sql`
      INSERT INTO processes (name, status)
      VALUES (${testName}, 'pending')
      RETURNING id
    `

    expect(row1.id).toBeDefined()
    expect(row2.id).toBeDefined()
    expect(row1.id).not.toEqual(row2.id) // Two distinct UUIDs

    // Verify both rows exist
    const count = await sql`
      SELECT COUNT(*)::int as cnt FROM processes WHERE name = ${testName}
    `
    expect(count[0].cnt).toBe(2)
  })

  it('getByName returns array ordered newest-first', async () => {
    // Verifies the DB ordering that the service layer relies on
    const testName = `test-idempotent-order-${Date.now()}`

    await sql`INSERT INTO processes (name, status) VALUES (${testName}, 'pending')`
    // Ensure distinct updated_at by a small delay
    await new Promise(r => setTimeout(r, 10))
    await sql`INSERT INTO processes (name, status) VALUES (${testName}, 'completed')`

    const rows = await sql`
      SELECT id, name, status, updated_at FROM processes
      WHERE name = ${testName}
      ORDER BY updated_at DESC
    `

    expect(rows).toHaveLength(2)
    expect(rows[0].status).toBe('completed') // Newest first
    expect(rows[1].status).toBe('pending')
  })
})
